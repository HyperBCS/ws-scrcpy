import WS from 'ws';
import { Mw, RequestParameters, SocketMessageEvent } from '../../mw/Mw';
import { ACTION } from '../../../common/Action';
import {
    COREDEVICE_FRAME_AUDIO,
    CoreDeviceContact,
    CoreDeviceClientMessage,
    CoreDeviceServerMessage,
    clampHid,
    isCoreDeviceButton,
    isCoreDeviceClientMessage,
    COREDEVICE_FRAME_DELTA,
    COREDEVICE_FRAME_RESET_KEY,
    splitStreamFrames,
} from '../../../common/CoreDeviceProtocol';
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, AudioPacketKind } from '../../../common/AudioProtocol';
import { CoreDeviceRunner, HttpReply } from '../services/CoreDeviceRunner';
import { CoreDeviceAudioRelay } from '../services/CoreDeviceAudio';
import { DeviceStateMonitor } from '../services/DeviceStateMonitor';

const TAG = 'CoreDeviceProxy';
// 120 ms is ignored by the connected iPhone; 300 ms locks/wakes it without invoking Siri.
const LOCK_TAP_MS = 300;
// serve-web's own `press` holds a button for 50 ms, and iOS 27 discards that as debounce noise for
// both of these: a 50 ms Home does nothing at all on a Face ID phone, and a 500 ms Lock reads as a
// long press and starts Siri. The proxy therefore sends its own down/up pair for each. Measured on
// an iPhone 13 Pro Max: Home fails at 50 ms and works at 100 ms, so 250 ms sits well clear of the
// threshold while still feeling instant (4/4 from inside an app).
const HOME_PRESS_MS = 250;
// A warm phone answers a pasteboard request in 20-100 ms, but the first one after `dtpasteboardd`
// has to be launched was measured at 3.9 s on an iPhone 13 Pro Max over USB. The bound stays well
// clear of that: past it the daemon is wedged and will never answer, but under it a merely slow
// phone must not have its daemon killed out from under a request that was going to succeed.
const CLIPBOARD_TIMEOUT_MS = 8000;
const CLIPBOARD_RETRY_TIMEOUT_MS = 8000;
// launchd needs a moment to have a new daemon accepting connections; asking immediately after the
// kill fails the same way the original request did (seen on hardware), while a read 1 s later took
// 61 ms.
const PASTEBOARD_SETTLE_MS = 1200;
const CLIPBOARD_DEAD_HINT =
    'The phone stopped answering the clipboard, and restarting its clipboard service did not help. Reboot the phone and try again.';
// serve-web keeps a bounded queue per subscriber and PLI-recovers when it overflows; the same
// idea here, so one slow browser tab cannot make Node buffer a whole GOP.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
// A healthy HID post answers in milliseconds; anything longer is a wedged channel, and a queue of
// typed characters must not sit behind the default 15 s for each of them.
const INPUT_TIMEOUT_MS = 4000;
// Button edges and keyboard detach wait for native completion, bounded at 8 s by serve-web.
const INPUT_COMPLETION_TIMEOUT_MS = 10000;
// Typing bursts are a few hundred reports; a backlog beyond this means the phone stopped
// answering, and stale input aimed at an old picture is worse than dropped input.
const MAX_QUEUED_INPUT = 512;

/**
 * One browser viewer of one iOS device: `?action=proxy-coredevice&udid=…`.
 *
 * Video flows serve-web `/stream.bin` -> this proxy -> WebSocket binary frames, one access unit
 * per message with its type byte in front. Input flows the other way as JSON and becomes the
 * corresponding loopback POST (`/touch`, `/key`, `/button`, ...). serve-web already primes every
 * new `/stream.bin` subscriber with a decodable start and re-keys it after drops, so this class
 * deliberately does no caching of its own.
 */
export class CoreDeviceProxy extends Mw {
    public static readonly TAG = TAG;
    private static touchOwners = new Map<string, CoreDeviceProxy>();
    private static keyboardOwners = new Map<string, CoreDeviceProxy>();
    private contacts: CoreDeviceContact[] = [];
    private keyboardPressed = false;
    private keyboardBusy = false;
    private readonly runner = CoreDeviceRunner.getInstance();
    private readonly udid: string;
    private stream?: NodeJS.ReadableStream & { destroy?: () => void };
    private unsubscribeAudio?: () => void;
    private released = false;
    private acquired = false;
    private onStatus?: (event: { udid: string; state: string; message?: string }) => void;

    public static processRequest(ws: WS, params: RequestParameters): CoreDeviceProxy | undefined {
        if (params.action !== ACTION.PROXY_COREDEVICE) {
            return;
        }
        const udid = params.url.searchParams.get('udid');
        if (!udid) {
            ws.close(4003, `[${TAG}] Missing "udid"`);
            return;
        }
        const proxy = new CoreDeviceProxy(ws, udid);
        proxy.init().catch((error: Error) => proxy.failSession(error.message));
        return proxy;
    }

    constructor(ws: WS, udid: string) {
        super(ws);
        this.udid = udid;
        this.name = `[${TAG}][${udid}]`;
    }

    private lastStatus?: string;
    private clipboardPending = 0;
    private clipboardChain: Promise<void> = Promise.resolve();
    // HID reports leave in the order they arrived. `request()` uses a keep-alive agent with
    // several sockets, so concurrent POSTs could reach serve-web out of order: a key's release
    // overtaking its press types nothing, a modifier's release overtaking the key latches Shift
    // ("hELLO"), and a touch release overtaking its last move leaves the finger down.
    private inputPending = 0;
    private inputChain: Promise<void> = Promise.resolve();

    private send(message: CoreDeviceServerMessage): void {
        if (this.ws.readyState !== this.ws.OPEN) {
            return;
        }
        const encoded = JSON.stringify(message);
        if (message.type === 'status') {
            // A failed start reaches here twice: once as the runner's status event and once as
            // the rejection of acquire(). The browser only needs one.
            if (encoded === this.lastStatus) {
                return;
            }
            this.lastStatus = encoded;
        }
        this.ws.send(encoded);
    }

    /**
     * Reports a start failure and closes the socket. The close matters: `CoreDeviceReceiver`
     * retries on close, so leaving the socket open after a failed `init()` strands the viewer on
     * the error with no reconnect -- and a proxy that stays registered keeps forwarding another
     * viewer's session events to it. Seen while the phone rebooted: the session recovered but the
     * stranded client never came back.
     */
    private failSession(message: string): void {
        this.send({ type: 'status', state: 'error', message });
        if (this.ws.readyState === this.ws.OPEN) {
            // `close()` flushes the status frame before completing the handshake.
            this.ws.close(4009, 'Stream unavailable');
        }
        this.release();
    }

    private async init(): Promise<void> {
        this.onStatus = (event) => {
            if (event.udid === this.udid) {
                this.send({ type: 'status', state: event.state as never, message: event.message });
            }
        };
        this.runner.on('status', this.onStatus);
        const current = this.runner.getStatus(this.udid);
        // A fresh viewer is always starting: `acquire()` below replaces a stopped or failed
        // session with a new attempt, so reporting the previous attempt's error here made every
        // retry look like an immediate fresh failure before the real attempt even began.
        const stale = current.state === 'stopped' || current.state === 'error';
        this.send({
            type: 'status',
            state: stale ? 'starting' : current.state,
            message: stale ? undefined : current.message,
        });
        await this.runner.acquire(this.udid);
        this.acquired = true;
        if (this.released) {
            return;
        }
        const codec = await this.runner.request(this.udid, 'GET', '/codec');
        if (codec.status !== 200) {
            throw new Error('The screen stream has no codec information yet. Try again in a moment.');
        }
        const parsed = JSON.parse(codec.body) as { codec: string; description: string };
        this.send({ type: 'codec', codec: parsed.codec, description: parsed.description });
        await this.attachStream();
        this.attachAudio();
    }

    /**
     * Device audio rides the same socket as `[3][scrcpy_audio_2 packet]`, after the video is
     * attached: the audio session on the phone is paired with the video session, and a viewer
     * that never gets video has no use for sound. One relay per phone decodes for everyone.
     */
    private attachAudio(): void {
        if (this.released || this.unsubscribeAudio) {
            return;
        }
        const relay = this.runner.audio(this.udid);
        const prefix = Buffer.from([COREDEVICE_FRAME_AUDIO]);
        const forward = (packet: Buffer) => {
            const socket = this.ws as WS;
            if (socket.readyState !== socket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) {
                return;
            }
            socket.send(Buffer.concat([prefix, packet]));
        };
        if (!relay) {
            forward(
                CoreDeviceAudioRelay.packet(
                    AudioPacketKind.METADATA,
                    0n,
                    Buffer.from(
                        JSON.stringify({
                            status: 'disabled',
                            sampleRate: AUDIO_SAMPLE_RATE,
                            channels: AUDIO_CHANNELS,
                            message: 'Device audio is turned off on this server (IOS_AUDIO=0).',
                        }),
                    ),
                ),
            );
            return;
        }
        this.unsubscribeAudio = relay.subscribe(forward);
    }

    private async attachStream(): Promise<void> {
        const response = await this.runner.openStream(this.udid);
        if (response.statusCode !== 200) {
            response.resume();
            throw new Error(`The screen stream is not available (HTTP ${response.statusCode})`);
        }
        if (this.released) {
            response.destroy();
            return;
        }
        this.stream = response;
        let rest: Uint8Array = new Uint8Array(0);
        let waitingForKeyframe = false;
        response.on('data', (chunk: Buffer) => {
            if (this.ws.readyState !== this.ws.OPEN) {
                // A final HID release may still be in flight. Teardown owns the media
                // lifetime so incoming video cannot detach it before that release finishes.
                this.release();
                return;
            }
            const merged = new Uint8Array(rest.length + chunk.length);
            merged.set(rest);
            merged.set(chunk, rest.length);
            const { frames, rest: tail } = splitStreamFrames(merged);
            rest = tail.slice();
            const socket = this.ws as WS;
            for (const frame of frames) {
                if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
                    waitingForKeyframe = true;
                    this.requestKeyframe();
                    continue;
                }
                if (waitingForKeyframe) {
                    if (frame[0] === COREDEVICE_FRAME_DELTA) {
                        this.requestKeyframe();
                        continue;
                    }
                    // Rebuild the browser decoder after dropping any reference picture.
                    frame[0] = COREDEVICE_FRAME_RESET_KEY;
                    waitingForKeyframe = false;
                }
                socket.send(frame);
            }
        });
        response.on('end', () => {
            if (!this.released) {
                this.send({ type: 'status', state: 'error', message: 'The screen stream ended.' });
                this.ws.close(4007, 'Stream ended');
            }
        });
        response.on('error', (error: Error) => {
            if (this.released) {
                return;
            }
            // When the session was stopped on purpose (Restart session, a reboot, an unplug) the
            // read aborts as a *consequence*, and reporting the raw "aborted" replaced the reason
            // the viewer had just been given. Keep the runner's account of it instead.
            const current = this.runner.getStatus(this.udid);
            if (current.state === 'stopped' || current.state === 'error') {
                this.ws.close(4007, current.message || 'Session stopped');
                return;
            }
            this.send({ type: 'status', state: 'error', message: error.message });
            this.ws.close(4007, 'Stream failed');
        });
    }

    /** GET/POST `/clipboard`. Callers go through the single-flight guard in `handle()`. */
    private async handleClipboard(message: Extract<CoreDeviceClientMessage, { type: 'clipboard' }>): Promise<void> {
        if (message.op === 'get') {
            const reply = await this.clipboardRequest('GET');
            if (reply.status !== 200) {
                this.send({ type: 'clipboard', text: null, error: reply.body || `HTTP ${reply.status}` });
                return;
            }
            const parsed = JSON.parse(reply.body) as { text: string | null };
            this.send({ type: 'clipboard', text: parsed.text ?? null });
        } else {
            const reply = await this.clipboardRequest('POST', JSON.stringify({ text: String(message.text ?? '') }));
            if (message.id !== undefined) {
                this.send({
                    type: 'result',
                    id: message.id,
                    ok: reply.status === 200,
                    error: reply.status === 200 ? undefined : reply.body,
                });
            }
        }
    }

    /**
     * One `/clipboard` request, with the only recovery that works behind it.
     *
     * Every clipboard read and write goes through the phone's `dtpasteboardd`, and that daemon
     * fails in two ways, both seen on hardware. Wedged: it takes the request and simply never
     * replies, for the rest of its life, so this request times out. Gone or not answering its
     * socket: serve-web's own attempt fails and it answers `500 clipboard error: ...` (often with
     * nothing after the colon, because the underlying timeout has an empty message).
     *
     * Restarting serve-web or the whole session cures neither -- the new process reaches the same
     * daemon, and that advice used to live in this file until hardware disproved it. Killing the
     * daemon does cure both: launchd starts a fresh one, which answers in ~40 ms with the
     * clipboard contents intact. So that happens here and the request is tried once more; from the
     * viewer's side the read just works, a few seconds later.
     */
    private async clipboardRequest(method: 'GET' | 'POST', body?: string): Promise<HttpReply> {
        const attempt = (timeoutMs: number) => this.runner.request(this.udid, method, '/clipboard', body, timeoutMs);
        let refused: HttpReply | undefined;
        try {
            const reply = await attempt(CoreDeviceProxy.clipboardTimeoutMs(CLIPBOARD_TIMEOUT_MS));
            if (reply.status < 500) {
                return reply;
            }
            // Kept in case there is nothing to restart: serve-web's own words beat a guess.
            refused = reply;
        } catch (error) {
            if (!CoreDeviceProxy.isStuck(error as Error)) {
                throw error;
            }
        }
        if (!(await this.runner.restartPasteboardDaemon(this.udid))) {
            // Nothing was running to restart, or the phone could not be reached at all.
            if (refused) {
                return refused;
            }
            throw new Error(CLIPBOARD_DEAD_HINT);
        }
        await new Promise((resolve) => setTimeout(resolve, CoreDeviceProxy.settleMs()));
        try {
            const reply = await attempt(CoreDeviceProxy.clipboardTimeoutMs(CLIPBOARD_RETRY_TIMEOUT_MS));
            if (reply.status < 500) {
                return reply;
            }
        } catch (retryError) {
            if (!CoreDeviceProxy.isStuck(retryError as Error)) {
                throw retryError;
            }
        }
        throw new Error(CLIPBOARD_DEAD_HINT);
    }

    /** A request the phone took and never answered, as opposed to one it refused. */
    private static isStuck(error: Error): boolean {
        return /timed out|timeout|socket hang up|ECONNRESET/i.test(error.message);
    }

    // Overridable so the tests do not have to sit out two real clipboard timeouts.
    private static clipboardTimeoutMs(fallback: number): number {
        const override = Number(process.env.IOS_CLIPBOARD_TIMEOUT_MS);
        return Number.isFinite(override) && override > 0 ? override : fallback;
    }

    /** The wait for a restarted daemon, shortened with the timeouts so tests stay quick. */
    private static settleMs(): number {
        return Math.min(PASTEBOARD_SETTLE_MS, CoreDeviceProxy.clipboardTimeoutMs(PASTEBOARD_SETTLE_MS));
    }

    private pendingKeyframe = false;
    private requestKeyframe(): void {
        if (this.pendingKeyframe) {
            return;
        }
        this.pendingKeyframe = true;
        setTimeout(() => (this.pendingKeyframe = false), 1000);
        this.runner.request(this.udid, 'POST', '/pli').catch(() => undefined);
    }

    protected onSocketMessage(event: SocketMessageEvent): void {
        if (typeof event.data !== 'string') {
            return;
        }
        let message: unknown;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        if (!isCoreDeviceClientMessage(message)) return;
        if (
            message.type === 'touch' ||
            message.type === 'touch-frame' ||
            message.type === 'rotate' ||
            message.type === 'key' ||
            message.type === 'keyboard-detach' ||
            message.type === 'button'
        ) {
            this.queueInput(message);
            return;
        }
        this.run(message);
    }

    private queueInput(message: CoreDeviceClientMessage): void {
        // serve-web opens the device's HID surfaces lazily, on the first `/touch`, `/key` or
        // `/button`. `dtuhidd` only publishes them as `authenticated: YES` while a media stream is
        // running; opened without one they stay unauthenticated for the life of that serve-web
        // process and backboardd silently drops every event -- video keeps flowing while nothing
        // responds to input, which is exactly the "I can't control it anymore" report. So input is
        // withheld until our `/stream.bin` is actually attached. Dropped rather than queued: input
        // the viewer aimed at an older frame is worse than no input.
        if (!this.stream || this.inputPending >= MAX_QUEUED_INPUT) {
            return;
        }
        this.inputPending++;
        this.inputChain = this.inputChain.then(async () => {
            this.inputPending--;
            if (this.released) {
                return;
            }
            await this.run(message);
        });
    }

    /** Dispatches one message and turns its failure into a reply where the browser can use one. */
    private run(message: CoreDeviceClientMessage): Promise<void> {
        return this.handle(message).catch((error: Error) => {
            if (message.type === 'touch' || message.type === 'touch-frame') {
                // The failed request may already have reached the phone. Close this
                // viewer and use its normal teardown to lift every finger before
                // another viewer can claim control, instead of retaining a dead owner.
                this.failSession(`Touch input failed: ${error.message}`);
            } else if (message.type === 'key' || message.type === 'keyboard-detach') {
                // A failed report may have reached the phone with a modifier still held.
                // Teardown retains keyboard ownership until the native keyboard is removed.
                this.failSession(`Keyboard input failed: ${error.message}`);
            } else if (message.type === 'button') {
                this.failSession(`Button input failed: ${error.message}`);
            } else if ('id' in message && typeof message.id === 'number') {
                this.send({ type: 'result', id: message.id, ok: false, error: error.message });
            } else if (message.type === 'clipboard') {
                // A `clipboard get` carries no id, so without this the viewer waits for ever on a
                // reply that never comes -- the reported "copy from clipboard does nothing".
                this.send({ type: 'clipboard', text: null, error: error.message });
            } else {
                console.error(`${this.name} ${message.type}: ${error.message}`);
            }
        });
    }

    private async handle(message: CoreDeviceClientMessage): Promise<void> {
        switch (message.type) {
            case 'touch-frame': {
                if (!Array.isArray(message.contacts) || message.contacts.length < 1 || message.contacts.length > 5)
                    return;
                const ids = new Set<number>();
                for (const c of message.contacts) {
                    if (
                        !c ||
                        !Number.isInteger(c.id) ||
                        c.id < 0 ||
                        c.id > 4 ||
                        ids.has(c.id) ||
                        typeof c.touching !== 'boolean' ||
                        !Number.isFinite(c.x) ||
                        !Number.isFinite(c.y)
                    )
                        return;
                    ids.add(c.id);
                }
                if (!this.claimTouch()) return;
                const frame = message.contacts.map((c) => ({ ...c, x: clampHid(c.x), y: clampHid(c.y) }));
                frame.push(...this.contacts.filter((c) => !ids.has(c.id)).map((c) => ({ ...c, touching: false })));
                const reply = await this.runner.request(
                    this.udid,
                    'POST',
                    '/touch',
                    JSON.stringify({ type: 'frame', contacts: frame }),
                    INPUT_TIMEOUT_MS,
                );
                if (reply.status !== 200) throw Error('The phone rejected the touch frame');
                this.contacts = frame.filter((c) => c.touching);
                if (!this.contacts.length) {
                    // Once teardown starts it keeps ownership until its all-fingers-up
                    // report completes, even if a normal release was already in flight.
                    if (!this.released) CoreDeviceProxy.touchOwners.delete(this.udid);
                    DeviceStateMonitor.getInstance().pokeInput(this.udid);
                }
                return;
            }
            case 'touch': {
                if (!['contact', 'release', 'tap'].includes(message.op)) {
                    return;
                }
                if (!this.claimTouch()) return;
                this.contacts =
                    message.op === 'contact'
                        ? [{ id: 2, touching: true, x: clampHid(message.x), y: clampHid(message.y) }]
                        : [];
                const reply = await this.runner.request(
                    this.udid,
                    'POST',
                    '/touch',
                    JSON.stringify({ type: message.op, x: clampHid(message.x), y: clampHid(message.y) }),
                    INPUT_TIMEOUT_MS,
                );
                if (reply.status !== 200) throw Error('The phone rejected the touch report');
                if (message.op !== 'contact') {
                    if (!this.released) CoreDeviceProxy.touchOwners.delete(this.udid);
                    // A finger lifting on the lock screen is a swipe that may have unlocked it.
                    DeviceStateMonitor.getInstance().pokeInput(this.udid);
                }
                return;
            }
            case 'key': {
                const usages = Array.isArray(message.usages)
                    ? message.usages.filter((usage) => Number.isInteger(usage) && usage >= 0 && usage < 240)
                    : [];
                if (usages.length) {
                    if (!this.claimKeyboard()) return;
                } else if (CoreDeviceProxy.keyboardOwners.get(this.udid) !== this || !this.keyboardPressed) {
                    // A viewer which never typed must not attach a keyboard just to release it,
                    // or clear another viewer's held keys when its own text field loses focus.
                    return;
                }
                this.keyboardBusy = true;
                try {
                    const reply = await this.runner.request(
                        this.udid,
                        'POST',
                        '/key',
                        JSON.stringify({ usages }),
                        INPUT_TIMEOUT_MS,
                    );
                    if (reply.status !== 200) throw Error('The phone rejected the keyboard report');
                    this.keyboardPressed = usages.length > 0;
                } catch (error) {
                    // An uncertain release still belongs to this viewer until cleanup finishes.
                    this.keyboardPressed = true;
                    throw error;
                } finally {
                    this.keyboardBusy = false;
                }
                if (usages.length === 0) {
                    // A release ends a keystroke; on a locked phone that may have been a passcode digit.
                    DeviceStateMonitor.getInstance().pokeInput(this.udid);
                }
                return;
            }
            case 'keyboard-detach':
                await this.detachKeyboard();
                return;
            case 'button': {
                if (!isCoreDeviceButton(message.name)) {
                    return;
                }
                const state = message.state === 'down' || message.state === 'up' ? message.state : 'press';
                if (state === 'press' && (message.name === 'lock' || message.name === 'home')) {
                    // Both need a hold serve-web's `press` will not give them (see the constants).
                    const holdMs = message.name === 'lock' ? LOCK_TAP_MS : HOME_PRESS_MS;
                    const send = async (edge: 'down' | 'up') => {
                        const reply = await this.runner.request(
                            this.udid,
                            'POST',
                            '/button',
                            JSON.stringify({ name: message.name, state: edge }),
                            INPUT_COMPLETION_TIMEOUT_MS,
                        );
                        if (reply.status !== 200) throw Error('The phone rejected the button press');
                    };
                    try {
                        await send('down');
                        await new Promise((resolve) => setTimeout(resolve, holdMs));
                    } finally {
                        // Always release: a button left down is a stuck Home or a phone that
                        // eventually answers the long press with Siri.
                        await send('up');
                    }
                    DeviceStateMonitor.getInstance().pokeButton(this.udid);
                    return;
                }
                const reply = await this.runner.request(
                    this.udid,
                    'POST',
                    '/button',
                    JSON.stringify({ name: message.name, state }),
                    INPUT_COMPLETION_TIMEOUT_MS,
                );
                if (reply.status !== 200) throw Error('The phone rejected the button press');
                if (state !== 'down') {
                    // Lock sleeps or wakes the phone, Home leaves the lock screen once unlocked.
                    DeviceStateMonitor.getInstance().pokeButton(this.udid);
                }
                return;
            }
            case 'clipboard': {
                // Clipboard work runs one at a time. A wedged pasteboard channel never answers, so
                // firing concurrent requests at it only multiplies abandoned channels; serialising
                // keeps a legitimate read-then-write pair working while capping the damage. One
                // waiting turn is allowed, anything beyond that is refused rather than queued.
                if (this.clipboardPending >= 2) {
                    const busy = 'A clipboard request is still waiting for the phone.';
                    if (message.id !== undefined) {
                        this.send({ type: 'result', id: message.id, ok: false, error: busy });
                    } else {
                        this.send({ type: 'clipboard', text: null, error: busy });
                    }
                    return;
                }
                this.clipboardPending++;
                const ahead = this.clipboardChain;
                let done: () => void = () => undefined;
                this.clipboardChain = new Promise<void>((resolve) => (done = resolve));
                try {
                    await ahead;
                    return await this.handleClipboard(message);
                } finally {
                    this.clipboardPending--;
                    done();
                }
            }
            case 'rotate': {
                const direction = message.direction === 'left' ? 'left' : 'right';
                const reply = await this.runner.request(this.udid, 'POST', '/rotate', JSON.stringify({ direction }));
                if (message.id !== undefined) {
                    this.send({
                        type: 'result',
                        id: message.id,
                        ok: reply.status === 200,
                        error: reply.status === 200 ? undefined : reply.body,
                        data: reply.status === 200 ? JSON.parse(reply.body) : undefined,
                    });
                }
                return;
            }
            case 'pli':
                this.requestKeyframe();
                return;
            case 'restart':
                await this.runner.request(this.udid, 'POST', '/restart');
                return;
            case 'restart-session':
                // Kills the process; our own stream dies with it and the viewer reconnects.
                this.runner.stopSession(this.udid, 'Restarting the phone session');
                return;
            default:
                return;
        }
    }

    private claimTouch(): boolean {
        const owner = CoreDeviceProxy.touchOwners.get(this.udid);
        if (owner && owner !== this) return false;
        CoreDeviceProxy.touchOwners.set(this.udid, this);
        return true;
    }

    private claimKeyboard(): boolean {
        const owner = CoreDeviceProxy.keyboardOwners.get(this.udid);
        // Keep full reports from different viewers from overwriting held modifiers. Once all
        // keys are released, another viewer may take over responsibility for eventual detach.
        if (owner && owner !== this && (owner.keyboardPressed || owner.keyboardBusy || owner.released)) return false;
        CoreDeviceProxy.keyboardOwners.set(this.udid, this);
        return true;
    }

    private async detachKeyboard(): Promise<void> {
        if (CoreDeviceProxy.keyboardOwners.get(this.udid) !== this) return;
        this.keyboardBusy = true;
        try {
            const reply = await this.runner.request(
                this.udid,
                'POST',
                '/keyboard/detach',
                undefined,
                INPUT_COMPLETION_TIMEOUT_MS,
            );
            if (reply.status !== 200) throw Error('The phone could not disconnect the keyboard');
            this.keyboardPressed = false;
            // A closing viewer keeps ownership until every teardown request has completed.
            if (!this.released) CoreDeviceProxy.keyboardOwners.delete(this.udid);
        } catch (error) {
            this.keyboardPressed = true;
            throw error;
        } finally {
            this.keyboardBusy = false;
        }
    }

    public release(): void {
        if (this.released) {
            return;
        }
        this.released = true;
        if (this.onStatus) {
            this.runner.off('status', this.onStatus);
            this.onStatus = undefined;
        }
        this.unsubscribeAudio?.();
        this.unsubscribeAudio = undefined;
        const finish = () => {
            this.stream?.destroy?.();
            this.stream = undefined;
            if (this.acquired) {
                this.acquired = false;
                this.runner.release(this.udid);
            }
        };
        if (
            CoreDeviceProxy.touchOwners.get(this.udid) === this ||
            CoreDeviceProxy.keyboardOwners.get(this.udid) === this
        ) {
            void this.inputChain
                .then(async () => {
                    if (CoreDeviceProxy.touchOwners.get(this.udid) === this) {
                        await this.runner
                            .request(
                                this.udid,
                                'POST',
                                '/touch',
                                JSON.stringify({
                                    type: 'frame',
                                    contacts: [0, 1, 2, 3, 4].map((id) => ({ id, touching: false, x: 0, y: 0 })),
                                }),
                                INPUT_TIMEOUT_MS,
                            )
                            .catch(() => undefined);
                    }
                    try {
                        await this.detachKeyboard();
                    } catch {
                        // A timeout gives no ordering guarantee: a late detach could remove the
                        // next viewer's keyboard. End this native session before freeing ownership.
                        this.runner.stopSession(this.udid, 'Restarting after keyboard disconnect failed');
                    }
                })
                .finally(() => {
                    if (CoreDeviceProxy.touchOwners.get(this.udid) === this)
                        CoreDeviceProxy.touchOwners.delete(this.udid);
                    if (CoreDeviceProxy.keyboardOwners.get(this.udid) === this)
                        CoreDeviceProxy.keyboardOwners.delete(this.udid);
                    finish();
                });
        } else finish();
        super.release();
    }
}
