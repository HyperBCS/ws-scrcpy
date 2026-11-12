import { observeViewport } from '../../client/observeViewport';
import { BaseClient } from '../../client/BaseClient';
import { ACTION } from '../../../common/Action';
import { ParamsStreamCoreDevice } from '../../../types/ParamsStreamCoreDevice';
import { CoreDeviceButton, CoreDeviceSessionState, clampHid } from '../../../common/CoreDeviceProtocol';
import { CoreDeviceReceiver } from './CoreDeviceReceiver';
import { WebCodecsHevcPlayer } from '../../player/WebCodecsHevcPlayer';
import { MseHevcPlayer } from '../../player/MseHevcPlayer';
import { BasePlayer } from '../../player/BasePlayer';
import { CoreDeviceInteractionHandler } from '../CoreDeviceInteractionHandler';
import { createIphoneControls } from '../../controls/iphoneControls';
import type { PhoneControls } from '../../controls/definition';
import { hidUsageForCode, keyboardReportsForText } from '../hidKeyboard';
import { KeyboardCapture } from '../../state/keyboardCapture';
import { isLocalKeyboardTarget } from '../../googDevice/localKeyboardTarget';
import { getVideoBounds } from '../../ControlBarLayout';
import { deviceClipboard, deviceClipboardError, streamConnected, streamNotice } from '../../state/stream';
import { AudioSession, createAudioSession } from '../../state/audio';
import Size from '../../Size';
import Util from '../../Util';

const TAG = '[StreamClientCoreDevice]';

export interface CoreDeviceClientEvents {
    // `retrying: false` marks an error the receiver will not retry by itself; see `retry()`.
    session: { state: CoreDeviceSessionState; message?: string; retrying?: boolean };
    result: { id: number; ok: boolean; error?: string; data?: unknown };
    decoder: { kind: DecoderKind };
    // The stream socket opened or closed. The session's own state arrives as `session`.
    link: { open: boolean };
    // Why this browser cannot show the phone's video, or '' once it can. The view shows it in
    // place of the picture; the socket stays up.
    decoderError: { message: string };
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
 * chrome (`FloatingToolbar`, sheets) only needs `getControls()`, `getDeviceName()`
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
    private readonly controls: PhoneControls;
    private readonly audioSession?: AudioSession;
    private touchHandler?: CoreDeviceInteractionHandler;
    private readonly keyboardCapture: KeyboardCapture;
    private inputGeneration = 0;
    private readonly pressedUsages = new Set<number>();
    private deviceName: string;
    private sessionState: CoreDeviceSessionState = 'starting';
    private socketOpen = false;
    private decoderProblem = '';
    private nextRequestId = 1;
    private stopped = false;
    private typing = Promise.resolve();
    private typingGeneration = 0;
    private resizeTimer?: ReturnType<typeof setTimeout>;
    private stopObservingViewport?: () => void;

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
        this.controls = createIphoneControls(this, this.audioSession);
        this.keyboardCapture = new KeyboardCapture({
            container: this.container,
            enabled: params.captureKeyboard !== false,
            connected: () => this.isConnected(),
            key: this.onKey,
            release: () => this.releaseAllKeys(),
            controls: () => this.controls,
            paste: (text, current) => this.pasteText(text, current),
            requestClipboard: () => this.requestClipboard(),
        });
        this.receiver.on('connected', this.onConnected);
        this.receiver.on('disconnected', this.onDisconnected);
        this.receiver.on('status', this.onStatus);
        this.receiver.on('codec', this.onCodec);
        this.receiver.on('video', this.onVideo);
        this.receiver.on('clipboard', this.onClipboard);
        this.receiver.on('result', (result) => this.emit('result', result));
        this.stopObservingViewport = observeViewport(this.videoWrapper, this.onWindowResize);
        window.addEventListener('blur', this.onKeyboardBlur);
        window.addEventListener('pagehide', this.onKeyboardBlur);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        if (params.captureKeyboard !== false) {
            this.setHandleKeyboardEvents(true);
        }
        this.setBodyClass('stream');
        this.setTitle(`Stream ${this.deviceName}`);
    }

    // ------------------------------------------------------------------ shared-chrome surface

    public getControls(): PhoneControls {
        return this.controls;
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

    /** Why this browser cannot show the phone's video, or '' when it can. */
    public getDecoderProblem(): string {
        return this.decoderProblem;
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
        if (this.decoderProblem || !videoSize.width || !videoSize.height) {
            return;
        }
        this.receiver.send({
            type: 'touch',
            op,
            x: clampHid((x / videoSize.width) * 0xffff),
            y: clampHid((y / videoSize.height) * 0xffff),
        });
    }

    public sendContacts(
        contacts: import('../../../common/CoreDeviceProtocol').CoreDeviceContact[],
        videoSize: Size,
    ): void {
        if (this.decoderProblem || !videoSize.width || !videoSize.height) return;
        this.receiver.send({
            type: 'touch-frame',
            contacts: contacts.map((c) => ({
                ...c,
                x: clampHid((c.x / videoSize.width) * 65535),
                y: clampHid((c.y / videoSize.height) * 65535),
            })),
        });
    }

    public pressButton(name: CoreDeviceButton, state: 'press' | 'down' | 'up' = 'press'): void {
        this.receiver.send({ type: 'button', name, state });
    }

    public sendKeyboardReport(usages: Iterable<number>): void {
        this.receiver.send({ type: 'key', usages: Array.from(usages) });
    }

    /** Reopening typing invalidates a close request that is still waiting for earlier keys. */
    public beginTyping(): void {
        this.typingGeneration++;
    }

    /** Finish earlier reports before unregistering HID, unless a newer typing session began. */
    public endTyping(): Promise<void> {
        const generation = ++this.typingGeneration;
        const run = this.typing.then(() => {
            if (!this.stopped && generation === this.typingGeneration) {
                this.receiver.send({ type: 'keyboard-detach' });
            }
        });
        this.typing = run.catch(() => undefined);
        return this.typing;
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
        this.beginTyping();
        const generation = this.inputGeneration;
        const run = this.typing.then(async () => {
            for (const report of reports) {
                if (this.stopped || generation !== this.inputGeneration) {
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

    public requestClipboard(): void {
        deviceClipboard.value = undefined;
        deviceClipboardError.value = '';
        this.receiver.send({ type: 'clipboard', op: 'get' });
    }

    // These three are answered with a `result` event carrying the returned id. `undefined` means
    // the socket was closed and nothing was sent, so no result will come.
    public setClipboard(text: string): number | undefined {
        const id = this.nextRequestId++;
        return this.receiver.send({ type: 'clipboard', op: 'set', text, id }) ? id : undefined;
    }

    public rotate(direction: 'left' | 'right'): number | undefined {
        this.touchHandler?.releaseActiveTouch();
        const id = this.nextRequestId++;
        return this.receiver.send({ type: 'rotate', direction, id }) ? id : undefined;
    }

    public requestKeyframe(): void {
        this.receiver.send({ type: 'pli' });
    }

    /**
     * Restarts the device's video inside the running serve-web process (picture recovery). The
     * server allows one every 30 s per phone and says how long to wait when it refuses.
     */
    public restartStream(): number | undefined {
        const id = this.nextRequestId++;
        return this.receiver.send({ type: 'restart', id }) ? id : undefined;
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

    /** Connects again after a failed start, also once the receiver has stopped retrying by itself. */
    public retry(): void {
        this.receiver.retry();
    }

    public setHandleKeyboardEvents(enabled: boolean): void {
        this.keyboardCapture.setEnabled(enabled);
        if (!enabled) void this.endTyping();
    }

    public isHandlingKeyboardEvents(): boolean {
        return this.keyboardCapture.isEnabled();
    }

    /** Set the clipboard once and paste only after the phone confirms the write. */
    public async pasteText(text: string, current: () => boolean): Promise<void> {
        const generation = this.inputGeneration;
        await new Promise<void>((resolve, reject) => {
            const id = this.nextRequestId++;
            const done = (error?: string) => {
                clearTimeout(timer);
                this.off('result', onResult);
                this.off('link', onLink);
                if (error) reject(Error(error));
                else resolve();
            };
            const onResult = (result: CoreDeviceClientEvents['result']) => {
                if (result.id === id)
                    done(result.ok ? undefined : result.error || 'The phone clipboard could not be changed.');
            };
            const onLink = ({ open }: { open: boolean }) => {
                if (!open) done('The phone disconnected before the paste finished.');
            };
            const timer = setTimeout(() => done('No answer from the phone clipboard.'), 25000);
            this.on('result', onResult);
            this.on('link', onLink);
            if (!this.receiver.send({ type: 'clipboard', op: 'set', text, id })) done('The phone is not connected.');
        });
        if (current() && generation === this.inputGeneration) await this.pressKey(0x19, [0xe3]);
    }

    private onKey = (event: KeyboardEvent): void => {
        if (isLocalKeyboardTarget(event.target)) {
            // Typing moved into our own UI (the Type text sheet, a settings field). The keyup
            // of a key held on the phone now lands here, so let go of everything instead.
            this.releaseAllKeys();
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
            this.beginTyping();
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

    private onKeyboardBlur = (): void => {
        this.releaseAllKeys();
        void this.endTyping();
    };

    private onVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') this.onKeyboardBlur();
    };

    // ------------------------------------------------------------------ receiver events

    /**
     * `streamConnected` is what enables the controls and the header's "Connected". An open socket
     * is not enough for either: the server accepts the socket before the session starts, and
     * keeps it open for a moment after the session stopped or failed. It is true while the
     * session is ready. Decoder failure affects the picture, not phone commands or Type text.
     */
    private updateConnected(): void {
        streamConnected.value = this.socketOpen && this.sessionState === 'ready';
        this.keyboardCapture.refresh();
    }

    private setDecoderProblem(message: string): void {
        if (this.decoderProblem === message) {
            return;
        }
        this.decoderProblem = message;
        this.updateConnected();
        this.emit('decoderError', { message });
    }

    private onConnected = (): void => {
        this.socketOpen = true;
        this.updateConnected();
        this.emit('link', { open: true });
    };

    private onDisconnected = (): void => {
        this.socketOpen = false;
        this.inputGeneration++;
        this.keyboardCapture.invalidate();
        this.updateConnected();
        this.emit('link', { open: false });
        this.player?.pause();
        this.touchHandler?.releaseActiveTouch();
        this.releaseAllKeys();
        this.controls.forgetHeldButtons();
    };

    private onStatus = (status: { state: CoreDeviceSessionState; message?: string; retrying?: boolean }): void => {
        this.sessionState = status.state;
        this.updateConnected();
        // The view shows a session error in its own card, with Retry. It is not copied to the
        // dismissible notice as well: that one sat in the same place and covered the button.
        this.emit('session', status);
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
            // Shown where the picture would be, not as a dismissible notice over a black stage.
            this.setDecoderProblem(StreamClientCoreDevice.explainNoDecoder(codec));
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
            this.setDecoderProblem((error as Error).message);
            return;
        }
        this.setDecoderProblem('');
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
        // Both players start again at the next key frame after a decoder error. Ask for one,
        // or the picture stays frozen until the phone happens to send it. The proxy passes on
        // at most one request a second.
        player.on('decoder-error', () => this.requestKeyframe());
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
        if (this.stopped) {
            return;
        }
        if (this.resizeTimer !== undefined) {
            clearTimeout(this.resizeTimer);
        }
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = undefined;
            this.applyBounds();
        }, 150);
    };

    private applyBounds(): void {
        const bounds = getVideoBounds(this.videoWrapper);
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
        this.emit('link', { open: false });
        this.keyboardCapture.stop();
        this.inputGeneration++;
        this.touchHandler?.release();
        this.touchHandler = undefined;
        this.stopObservingViewport?.();
        this.stopObservingViewport = undefined;
        window.removeEventListener('blur', this.onKeyboardBlur);
        window.removeEventListener('pagehide', this.onKeyboardBlur);
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        if (this.resizeTimer !== undefined) {
            clearTimeout(this.resizeTimer);
            this.resizeTimer = undefined;
        }
        this.controls.release();
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
        this.socketOpen = false;
        streamConnected.value = false;
        console.log(TAG, 'stopped');
    };
}
