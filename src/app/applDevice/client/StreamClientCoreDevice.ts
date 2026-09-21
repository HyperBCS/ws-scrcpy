import { BaseClient } from '../../client/BaseClient';
import { ACTION } from '../../../common/Action';
import { ParamsStreamCoreDevice } from '../../../types/ParamsStreamCoreDevice';
import { CoreDeviceButton, CoreDeviceSessionState, clampHid } from '../../../common/CoreDeviceProtocol';
import { CoreDeviceReceiver } from './CoreDeviceReceiver';
import { WebCodecsHevcPlayer } from '../../player/WebCodecsHevcPlayer';
import { MseHevcPlayer } from '../../player/MseHevcPlayer';
import { BasePlayer } from '../../player/BasePlayer';
import { CoreDeviceInteractionHandler } from '../CoreDeviceInteractionHandler';
import { ApplToolBox } from '../toolbox/ApplToolBox';
import { hidUsageForCode, keyboardReportsForText } from '../hidKeyboard';
import { isLocalKeyboardTarget } from '../../googDevice/localKeyboardTarget';
import { computeMaxSize } from '../../ControlBarLayout';
import { deviceClipboard, deviceClipboardError, lastFrameAt, streamConnected, streamNotice } from '../../state/stream';
import { AudioSession, createAudioSession } from '../../state/audio';
import Size from '../../Size';
import Util from '../../Util';

const TAG = '[StreamClientCoreDevice]';

export interface CoreDeviceClientEvents {
    session: { state: CoreDeviceSessionState; message?: string };
    result: { id: number; ok: boolean; error?: string; data?: unknown };
    decoder: { kind: DecoderKind };
}

export type DecoderKind = 'hevc' | 'mse';

/** What the stream client needs from either decoder. */
export interface CoreDevicePlayer extends BasePlayer {
    configure(codec: string, description: Uint8Array): void;
    pushFrame(frame: Uint8Array): void;
}

/**
 * The iOS counterpart of `StreamClientScrcpy`: owns the DOM under its container, the HEVC
 * player, the touch/keyboard handlers and the WebSocket to `CoreDeviceProxy`. The shared stream
 * chrome (`FloatingToolbar`, sheets) only needs `getControlButtonsElement()`, `getDeviceName()`
 * and `stop()` from it.
 */
export class StreamClientCoreDevice extends BaseClient<ParamsStreamCoreDevice, CoreDeviceClientEvents> {
    public static ACTION = ACTION.STREAM_COREDEVICE;

    public static start(
        query: URLSearchParams | ParamsStreamCoreDevice,
        container?: HTMLElement,
    ): StreamClientCoreDevice {
        const params = query instanceof URLSearchParams ? StreamClientCoreDevice.parseParameters(query) : query;
        return new StreamClientCoreDevice(params, container);
    }

    public static parseParameters(params: URLSearchParams): ParamsStreamCoreDevice {
        const typed = super.parseParameters(params);
        if (typed.action !== ACTION.STREAM_COREDEVICE) {
            throw Error('Incorrect action');
        }
        return {
            ...typed,
            action: ACTION.STREAM_COREDEVICE,
            udid: Util.parseString(params, 'udid', true),
            captureKeyboard: params.has('captureKeyboard') ? Util.parseBoolean(params, 'captureKeyboard') : true,
            player: params.get('player') === 'mse' ? 'mse' : params.get('player') === 'hevc' ? 'hevc' : undefined,
        };
    }

    private readonly receiver: CoreDeviceReceiver;
    private readonly container: HTMLElement;
    private readonly deviceView: HTMLElement;
    private readonly videoWrapper: HTMLElement;
    private player?: CoreDevicePlayer;
    private decoderKind?: DecoderKind;
    private readonly forcedDecoder?: DecoderKind;
    private readonly toolBox: ApplToolBox;
    private readonly audioSession?: AudioSession;
    private touchHandler?: CoreDeviceInteractionHandler;
    private keyboardAttached = false;
    private readonly pressedUsages = new Set<number>();
    private deviceName: string;
    private sessionState: CoreDeviceSessionState = 'starting';
    private nextRequestId = 1;
    private stopped = false;
    private typing = Promise.resolve();
    private resizeTimer?: ReturnType<typeof setTimeout>;

    protected constructor(params: ParamsStreamCoreDevice, container: HTMLElement = document.body) {
        super(params);
        this.container = container;
        this.deviceName = params.udid;
        this.forcedDecoder = params.player;
        if (!WebCodecsHevcPlayer.isSupported() && !MseHevcPlayer.isSupported()) {
            throw Error(
                'This browser has neither WebCodecs nor Media Source Extensions. Use a current Chrome, Edge, Firefox or Safari.',
            );
        }
        this.deviceView = document.createElement('div');
        this.deviceView.className = 'device-view';
        this.videoWrapper = document.createElement('div');
        this.videoWrapper.className = 'video';
        this.deviceView.appendChild(this.videoWrapper);
        this.container.appendChild(this.deviceView);

        this.receiver = new CoreDeviceReceiver({ ...params, action: ACTION.PROXY_COREDEVICE });
        // The phone's audio arrives on the same socket as `[3][scrcpy_audio_2 packet]` and is
        // played by the Android audio player; `undefined` unless the build includes audio.
        this.audioSession = createAudioSession(this.receiver);
        // The decoder is chosen when the server announces the codec (`onCodec`): WebCodecs where
        // the browser offers it for this stream, otherwise MSE.
        this.toolBox = ApplToolBox.createToolBox(this, { audioSession: this.audioSession });
        this.receiver.on('connected', this.onConnected);
        this.receiver.on('disconnected', this.onDisconnected);
        this.receiver.on('status', this.onStatus);
        this.receiver.on('codec', this.onCodec);
        this.receiver.on('video', this.onVideo);
        this.receiver.on('clipboard', this.onClipboard);
        this.receiver.on('result', (result) => this.emit('result', result));
        window.addEventListener('resize', this.onWindowResize);
        if (params.captureKeyboard !== false) {
            this.setHandleKeyboardEvents(true);
        }
        this.setBodyClass('stream');
        this.setTitle(`Stream ${this.deviceName}`);
    }

    // ------------------------------------------------------------------ shared-chrome surface

    public getControlButtonsElement(): HTMLElement | undefined {
        return this.toolBox.getHolderElement();
    }

    public getDeviceName(): string {
        return this.deviceName;
    }

    public getDeviceUdid(): string {
        return this.params.udid;
    }

    public setDeviceName(name: string): void {
        this.deviceName = name;
        this.setTitle(`Stream ${name}`);
    }

    public getPlayer(): BasePlayer | undefined {
        return this.player;
    }

    public getDecoderKind(): DecoderKind | undefined {
        return this.decoderKind;
    }

    public getSessionState(): CoreDeviceSessionState {
        return this.sessionState;
    }

    public isConnected(): boolean {
        return this.receiver.isReady();
    }

    // ------------------------------------------------------------------ input

    /** `x`/`y` in video pixels; the wire wants the 0..65535 screen-normalised form. */
    public sendTouch(op: 'contact' | 'release' | 'tap', x: number, y: number, videoSize: Size): void {
        if (!videoSize.width || !videoSize.height) {
            return;
        }
        this.receiver.send({
            type: 'touch',
            op,
            x: clampHid((x / videoSize.width) * 0xffff),
            y: clampHid((y / videoSize.height) * 0xffff),
        });
    }

    public pressButton(name: CoreDeviceButton, state: 'press' | 'down' | 'up' = 'press'): void {
        this.receiver.send({ type: 'button', name, state });
    }

    public sendKeyboardReport(usages: Iterable<number>): void {
        this.receiver.send({ type: 'key', usages: Array.from(usages) });
    }

    /** Types text as key presses; characters without a US-layout key are reported, not sent. */
    public typeText(text: string): Promise<string[]> {
        const { reports, skipped } = keyboardReportsForText(text);
        return this.enqueueReports(reports).then(() => skipped);
    }

    /**
     * One press-and-release of a key by HID usage, in order with any text still being typed.
     * The Type text sheet's Enter/Delete/arrow buttons go through here so a tap on Enter cannot
     * overtake the characters that were committed just before it.
     */
    public pressKey(usage: number, modifiers: number[] = []): Promise<void> {
        const reports = modifiers.length ? [modifiers, [...modifiers, usage], modifiers, []] : [[usage], []];
        return this.enqueueReports(reports);
    }

    /**
     * Every report from the UI joins one queue, so key order is exactly the order the user
     * produced it. The proxy serialises the loopback POSTs behind it as well; the short gap is
     * for the device, which coalesces a press and release that arrive in the same instant.
     */
    private enqueueReports(reports: number[][]): Promise<void> {
        const run = this.typing.then(async () => {
            for (const report of reports) {
                if (this.stopped) {
                    return;
                }
                this.sendKeyboardReport(report);
                await new Promise((resolve) => setTimeout(resolve, 8));
            }
        });
        // A rejected step must not poison the queue for everything typed afterwards.
        this.typing = run.catch(() => undefined);
        return run;
    }

    /**
     * Unlocks a phone that has been unlocked at least once since boot: wakes it, swipes up to open
     * the passcode field, then types the passcode with the virtual keyboard.
     *
     * Verified on iOS 27. Two details the hardware taught us. The screen must be awake, and the
     * passcode field must already be open before the digits go out: typing exactly six digits at
     * the clock-face lock screen leaves **five** dots filled, because the first keypress is
     * consumed opening the field. The swipe does that opening instead of a priming keypress, so
     * nothing can be mistaken for a digit -- a priming digit would submit a wrong passcode on a
     * four-digit device if it ever stopped being swallowed.
     *
     * A freshly rebooted phone cannot be unlocked this way at all: until the passcode is entered
     * on the device, iOS keeps the USB data connection shut, so there is no tunnel to carry HID.
     */
    public unlockWithPasscode(passcode: string): Promise<boolean> {
        const digits = passcode.trim();
        if (!/^\d{4,10}$/.test(digits)) {
            return Promise.resolve(false);
        }
        const usages = Array.from(digits, (digit) => hidUsageForCode(`Digit${digit}`));
        if (usages.some((usage) => usage === undefined)) {
            return Promise.resolve(false);
        }
        const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        this.typing = this.typing.then(async () => {
            if (this.stopped) {
                return;
            }
            this.pressButton('home');
            await pause(1200);
            // Swipe up from the bottom. Coordinates are screen-normalised (0..65535), so this
            // needs no video size and works before the first frame has been decoded.
            const x = 0x8000;
            let y = 0xf800;
            this.receiver.send({ type: 'touch', op: 'contact', x, y });
            for (let step = 0; step < 12 && !this.stopped; step++) {
                await pause(25);
                y = clampHid(y - 0x0ccc);
                this.receiver.send({ type: 'touch', op: 'contact', x, y });
            }
            this.receiver.send({ type: 'touch', op: 'release', x, y });
            await pause(1200);
            for (const usage of usages as number[]) {
                if (this.stopped) {
                    return;
                }
                this.sendKeyboardReport([usage]);
                await pause(120);
                this.sendKeyboardReport([]);
                await pause(180);
            }
        });
        return this.typing.then(() => true);
    }

    public requestClipboard(): void {
        deviceClipboard.value = undefined;
        deviceClipboardError.value = '';
        this.receiver.send({ type: 'clipboard', op: 'get' });
    }

    public setClipboard(text: string): number {
        const id = this.nextRequestId++;
        this.receiver.send({ type: 'clipboard', op: 'set', text, id });
        return id;
    }

    public rotate(direction: 'left' | 'right'): number {
        const id = this.nextRequestId++;
        this.receiver.send({ type: 'rotate', direction, id });
        return id;
    }

    public requestKeyframe(): void {
        this.receiver.send({ type: 'pli' });
    }

    /** Restarts the device's video inside the running serve-web process (picture recovery). */
    public restartStream(): void {
        this.receiver.send({ type: 'restart' });
    }

    /**
     * Throws away the whole phone session so the next connection gets a fresh serve-web process.
     * That is the only recovery for its per-process HID and pasteboard channels, which wedge
     * independently of video -- `restart` above cannot fix them, it only restarts the video inside
     * the same process. The socket closes and `CoreDeviceReceiver` reconnects on its own.
     */
    public restartSession(): void {
        this.receiver.send({ type: 'restart-session' });
    }

    public setHandleKeyboardEvents(enabled: boolean): void {
        if (enabled === this.keyboardAttached) {
            return;
        }
        this.keyboardAttached = enabled;
        if (enabled) {
            window.addEventListener('keydown', this.onKey, true);
            window.addEventListener('keyup', this.onKey, true);
            window.addEventListener('blur', this.releaseAllKeys);
        } else {
            window.removeEventListener('keydown', this.onKey, true);
            window.removeEventListener('keyup', this.onKey, true);
            window.removeEventListener('blur', this.releaseAllKeys);
            this.releaseAllKeys();
        }
    }

    public isHandlingKeyboardEvents(): boolean {
        return this.keyboardAttached;
    }

    private onKey = (event: KeyboardEvent): void => {
        if (isLocalKeyboardTarget(event.target)) {
            return;
        }
        const usage = hidUsageForCode(event.code);
        if (usage === undefined) {
            return;
        }
        // Browser shortcuts (Cmd/Ctrl+L, Ctrl+W...) must not fire while the phone has the keys.
        event.preventDefault();
        if (event.type === 'keydown') {
            if (this.pressedUsages.has(usage)) {
                return; // auto-repeat
            }
            this.pressedUsages.add(usage);
        } else {
            this.pressedUsages.delete(usage);
        }
        this.sendKeyboardReport(this.pressedUsages);
    };

    private releaseAllKeys = (): void => {
        if (this.pressedUsages.size) {
            this.pressedUsages.clear();
            this.sendKeyboardReport([]);
        }
    };

    // ------------------------------------------------------------------ receiver events

    private onConnected = (): void => {
        streamConnected.value = true;
    };

    private onDisconnected = (): void => {
        streamConnected.value = false;
        this.player?.pause();
        this.touchHandler?.releaseActiveTouch();
        this.releaseAllKeys();
    };

    private onStatus = (status: { state: CoreDeviceSessionState; message?: string }): void => {
        this.sessionState = status.state;
        this.emit('session', status);
        if (status.state === 'error' && status.message) {
            streamNotice.value = status.message;
        }
    };

    private onCodec = async ({ codec, description }: { codec: string; description: Uint8Array }): Promise<void> => {
        if (this.stopped) {
            return;
        }
        const kind = await StreamClientCoreDevice.chooseDecoder(codec, description, this.forcedDecoder);
        if (this.stopped) {
            return;
        }
        if (!kind) {
            streamNotice.value = StreamClientCoreDevice.explainNoDecoder(codec);
            return;
        }
        if (this.player && this.decoderKind !== kind) {
            this.detachPlayer();
        }
        if (!this.player) {
            this.attachPlayer(kind);
        }
        try {
            this.player?.configure(codec, description);
        } catch (error) {
            streamNotice.value = (error as Error).message;
            return;
        }
        this.player?.play();
    };

    /**
     * WebCodecs first (lowest latency), MSE where the browser has an HEVC decoder but no WebCodecs
     * -- Chrome and Edge only expose WebCodecs on secure origins, MediaSource works over http.
     */
    public static async chooseDecoder(
        codec: string,
        description: Uint8Array,
        forced?: DecoderKind,
    ): Promise<DecoderKind | undefined> {
        if (forced === 'mse') {
            return MseHevcPlayer.mimeFor(codec) ? 'mse' : undefined;
        }
        if (forced === 'hevc') {
            return (await WebCodecsHevcPlayer.supportsConfig(codec, description)) ? 'hevc' : undefined;
        }
        if (await WebCodecsHevcPlayer.supportsConfig(codec, description)) {
            return 'hevc';
        }
        if (MseHevcPlayer.mimeFor(codec)) {
            return 'mse';
        }
        return undefined;
    }

    public static explainNoDecoder(codec: string): string {
        const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
        const base = `This browser cannot decode the phone's HEVC stream (${codec}). Chrome and Edge need hardware HEVC decoding; Safari works.`;
        return insecure && !WebCodecsHevcPlayer.isSupported()
            ? `${base} Over plain http only the MSE decoder is available; the server's https:// address (README: HTTPS) also enables WebCodecs.`
            : base;
    }

    private attachPlayer(kind: DecoderKind): void {
        const player: CoreDevicePlayer =
            kind === 'mse' ? new MseHevcPlayer(this.params.udid) : new WebCodecsHevcPlayer(this.params.udid);
        player.setParent(this.videoWrapper);
        player.on('input-video-resize', () => this.applyBounds());
        this.player = player;
        this.decoderKind = kind;
        this.touchHandler = new CoreDeviceInteractionHandler(player, this);
        this.emit('decoder', { kind });
        console.log(TAG, `decoder: ${kind}`);
    }

    private detachPlayer(): void {
        this.touchHandler?.release();
        this.touchHandler = undefined;
        this.player?.stop();
        this.player = undefined;
        this.decoderKind = undefined;
    }

    private onVideo = (frame: Uint8Array): void => {
        lastFrameAt.value = Date.now();
        this.player?.pushFrame(frame);
    };

    private onClipboard = ({ text, error }: { text: string | null; error?: string }): void => {
        if (error) {
            streamNotice.value = `Clipboard: ${error}`;
            deviceClipboardError.value = error;
            return;
        }
        deviceClipboardError.value = '';
        deviceClipboard.value = text ?? '';
    };

    // ------------------------------------------------------------------ layout

    private onWindowResize = (): void => {
        if (this.resizeTimer) {
            clearTimeout(this.resizeTimer);
        }
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = undefined;
            this.applyBounds();
        }, 150);
    };

    private applyBounds(): void {
        const bounds = computeMaxSize(
            document.body.clientWidth,
            document.body.clientHeight,
            this.toolBox.getHolderElement(),
        );
        if (bounds) {
            this.player?.setBounds(bounds);
        }
    }

    // ------------------------------------------------------------------ lifecycle

    public stop = (): void => {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.setHandleKeyboardEvents(false);
        this.touchHandler?.release();
        this.touchHandler = undefined;
        window.removeEventListener('resize', this.onWindowResize);
        if (this.resizeTimer) {
            clearTimeout(this.resizeTimer);
        }
        this.toolBox.release();
        this.audioSession?.stop();
        this.receiver.off('connected', this.onConnected);
        this.receiver.off('disconnected', this.onDisconnected);
        this.receiver.off('status', this.onStatus);
        this.receiver.off('codec', this.onCodec);
        this.receiver.off('video', this.onVideo);
        this.receiver.off('clipboard', this.onClipboard);
        this.receiver.stop();
        this.player?.stop();
        this.player = undefined;
        this.deviceView.remove();
        streamConnected.value = false;
        console.log(TAG, 'stopped');
    };
}
