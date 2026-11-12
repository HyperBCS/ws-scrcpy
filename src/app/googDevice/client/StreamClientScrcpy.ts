import { BaseClient } from '../../client/BaseClient';
import { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { createAndroidControls } from '../../controls/androidControls';
import type { PhoneControls } from '../../controls/definition';
import VideoSettings from '../../VideoSettings';
import { ControlMessage } from '../../controlMessage/ControlMessage';
import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import { ClientsStats, DisplayCombinedInfo } from '../../client/StreamReceiver';
import Util from '../../Util';
import { KeyEventListener, KeyInputHandler } from '../KeyInputHandler';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { BasePlayer, DecoderErrorEvent, PlayerClass } from '../../player/BasePlayer';
import {
    FeaturedInteractionHandler,
    InteractionHandlerListener,
} from '../../interactionHandler/FeaturedInteractionHandler';
import DeviceMessage from '../DeviceMessage';
import { DisplayInfo } from '../../DisplayInfo';
import { ACTION } from '../../../common/Action';
import { StreamReceiverScrcpy } from './StreamReceiverScrcpy';
import { UhidKeyboard } from '../UhidKeyboard';
import { deviceClipboard, streamConnected, streamNotice, streamServiceStopped } from '../../state/stream';
import { STREAM_SERVICE_STOPPED } from '../../../common/StreamCloseCode';
import { AudioSession, createAudioSession } from '../../state/audio';
import { isLocalKeyboardTarget } from '../localKeyboardTarget';

type StartParams = {
    udid: string;
    playerName?: string;
    player?: BasePlayer;
    videoSettings?: VideoSettings;
};

const TAG = '[StreamClientScrcpy]';

export class StreamClientScrcpy
    extends BaseClient<ParamsStreamScrcpy, never>
    implements KeyEventListener, InteractionHandlerListener
{
    public static ACTION = 'stream';
    private static players: Map<string, PlayerClass> = new Map<string, PlayerClass>();
    /** At most this many encoder restarts are requested for decoder recovery per window. */
    private static readonly MAX_VIDEO_RESETS = 3;
    private static readonly VIDEO_RESET_WINDOW_MS = 5 * 60 * 1000;
    private videoResets: number[] = [];

    private controls?: PhoneControls;
    private uhidKeyboard?: UhidKeyboard;
    private keyboardAttached = false;
    private deviceName = '';
    private clientId = -1;
    private clientsCount = -1;
    private touchHandler?: FeaturedInteractionHandler;
    private player?: BasePlayer;
    private audioSession?: AudioSession;
    private readonly streamReceiver: StreamReceiverScrcpy;
    private readonly container: HTMLElement;
    private deviceView?: HTMLElement;

    public static registerPlayer(playerClass: PlayerClass): void {
        if (playerClass.isSupported()) {
            this.players.set(playerClass.playerFullName, playerClass);
        }
    }

    public static getPlayers(): PlayerClass[] {
        return Array.from(this.players.values());
    }

    private static getPlayerClass(playerName: string): PlayerClass | undefined {
        let playerClass: PlayerClass | undefined;
        for (const value of StreamClientScrcpy.players.values()) {
            if (value.playerFullName === playerName || value.playerCodeName === playerName) {
                playerClass = value;
            }
        }
        return playerClass;
    }

    public static createPlayer(playerName: string, udid: string, displayInfo?: DisplayInfo): BasePlayer | undefined {
        const playerClass = this.getPlayerClass(playerName);
        if (!playerClass) {
            return;
        }
        return new playerClass(udid, displayInfo);
    }

    public static start(
        query: URLSearchParams | ParamsStreamScrcpy,
        streamReceiver?: StreamReceiverScrcpy,
        player?: BasePlayer,
        videoSettings?: VideoSettings,
        container?: HTMLElement,
    ): StreamClientScrcpy {
        if (query instanceof URLSearchParams) {
            const params = StreamClientScrcpy.parseParameters(query);
            return new StreamClientScrcpy(params, streamReceiver, player, videoSettings, container);
        } else {
            return new StreamClientScrcpy(query, streamReceiver, player, videoSettings, container);
        }
    }

    protected constructor(
        params: ParamsStreamScrcpy,
        streamReceiver?: StreamReceiverScrcpy,
        player?: BasePlayer,
        videoSettings?: VideoSettings,
        // A view hosting this client can pass its own container to mount into (see
        // `views/screen/android.tsx`); direct/legacy callers keep working against `document.body`.
        container: HTMLElement = document.body,
    ) {
        super(params);
        this.container = container;
        // Validate before opening a socket, so a stale bookmarked player cannot leave an
        // unowned receiver reconnecting after the view reports its startup error.
        if (!player && !StreamClientScrcpy.getPlayerClass(params.player)) {
            throw Error(`This browser does not support the selected player: ${params.player}`);
        }
        if (streamReceiver) {
            this.streamReceiver = streamReceiver;
        } else {
            this.streamReceiver = new StreamReceiverScrcpy(this.params);
        }

        BasePlayer.removeStoredVideoSettings();
        const { udid, player: playerName } = this.params;
        this.startStream({ udid, player, playerName, videoSettings });
        this.setBodyClass('stream');
    }

    public static parseParameters(params: URLSearchParams): ParamsStreamScrcpy {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.STREAM_SCRCPY) {
            throw Error('Incorrect action');
        }
        return {
            ...typedParams,
            action,
            player: Util.parseString(params, 'player', true),
            udid: Util.parseString(params, 'udid', true),
            ws: Util.parseString(params, 'ws', true),
            // Capture defaults on, but UHID attaches only for an actual physical key press.
            // Touch viewing keeps Android's software keyboard available. `captureKeyboard=0`
            // opts out of physical keyboard capture.
            //
            // NB `Util.parseBoolean`'s third argument is `required`, NOT a default -- passing
            // `true` there makes every stream deep link throw "Missing required parameter".
            captureKeyboard: params.has('captureKeyboard') ? Util.parseBoolean(params, 'captureKeyboard') : true,
        };
    }

    public OnDeviceMessage = (message: DeviceMessage): void => {
        if (message.type === DeviceMessage.TYPE_CLIPBOARD) {
            deviceClipboard.value = message.getText();
        }
    };

    public onVideo = (data: Uint8Array): void => {
        if (!this.player) {
            return;
        }
        const STATE = BasePlayer.STATE;
        if (this.player.getState() === STATE.PAUSED) {
            this.player.play();
        }
        if (this.player.getState() === STATE.PLAYING) {
            this.player.pushFrame(data);
        }
    };

    public onClientsStats = (stats: ClientsStats): void => {
        this.deviceName = stats.deviceName;
        this.clientId = stats.clientId;
        // Remember this viewer's namespace without registering an unused hardware keyboard.
        // A supported physical keydown creates it lazily after these stats arrive.
        this.uhidKeyboard?.setId(this.clientId);
        this.setTitle(`Stream ${this.deviceName}`);
    };

    public onDisplayInfo = (infoArray: DisplayCombinedInfo[]): void => {
        if (!this.player) {
            return;
        }
        const displayId = this.player.getVideoSettings().displayId;
        const info = infoArray.find((value) => {
            return value.displayInfo.displayId === displayId;
        });
        if (!info) {
            return;
        }
        if (this.player.getState() === BasePlayer.STATE.PAUSED) {
            this.player.play();
        }
        const { videoSettings, screenInfo } = info;
        this.player.setDisplayInfo(info.displayInfo);
        if (!videoSettings || !screenInfo) {
            return;
        }

        this.clientsCount = info.connectionCount;
        // Sent again when the device rotates: the picture size changes mid-stream.
        if (!screenInfo.equals(this.player.getScreenInfo())) {
            this.player.setScreenInfo(screenInfo);
        }
        if (!videoSettings.equals(this.player.getVideoSettings())) {
            this.player.setVideoSettings(videoSettings);
        }
    };

    // `StreamReceiver` retries with backoff after *every* close (see its `scheduleReconnect`),
    // including the deliberate ones a stream-quality restart triggers (`Device.updateStreamConfig`
    // -> `WebsocketProxy`'s `controlSocketCloseListener`) -- so `disconnected` fires on transient
    // blips too, not just a final teardown. This used to unsubscribe every listener below, which
    // meant the fresh `scrcpy_initial` packet the *next* connection sends (re-triggering
    // `video`/`displayInfo`/`clientsStats`) had nobody left listening: the picture would never
    // come back after a restart even though the socket-level reconnect worked perfectly. Only
    // pause playback here; real teardown (unsubscribing, releasing handlers) belongs in `stop()`,
    // which runs once, for good.
    public onDisconnected = (event?: CloseEvent): void => {
        streamConnected.value = false;
        streamServiceStopped.value = event?.code === STREAM_SERVICE_STOPPED;
        this.clientId = -1;
        // A replacement scrcpy process has no virtual keyboard, even if capture remains on.
        this.uhidKeyboard?.reset();
        // Nor can a held control be released any more: the server lifts it on the device.
        this.controls?.forgetHeldButtons();
        // The same for a touch or a drag: an up sent now would be replayed on the next connection.
        this.touchHandler?.forgetActiveTouch();
        this.player?.pause();
    };

    public onConnected = (): void => {
        streamConnected.value = true;
        streamServiceStopped.value = false;
    };

    // The socket stays up through a decoder failure, so nothing else on screen says that the
    // picture stopped. Brief failures the player recovers from are not announced.
    private onDecoderError = ({ recovering }: DecoderErrorEvent): void => {
        if (!recovering) {
            streamNotice.value =
                'The video decoder in this browser stopped. If the picture does not come back, reopen the stream or choose another video player in Settings.';
        }
    };

    /**
     * A rebuilt decoder needs a keyframe, and on a still screen the device may not send one for
     * a long time. RESET_VIDEO restarts the device's encoder, which then sends its parameter sets
     * and a keyframe to every viewer. It is rationed because it interrupts the other viewers too.
     */
    private onKeyframeRequest = (): void => {
        const now = Date.now();
        const { VIDEO_RESET_WINDOW_MS, MAX_VIDEO_RESETS } = StreamClientScrcpy;
        this.videoResets = this.videoResets.filter((time) => now - time < VIDEO_RESET_WINDOW_MS);
        if (this.videoResets.length >= MAX_VIDEO_RESETS) {
            return;
        }
        this.videoResets.push(now);
        this.sendMessage(new CommandControlMessage(ControlMessage.TYPE_RESET_VIDEO));
    };

    // Tears down the DOM this client owns and stops the receiver and player. The host view calls
    // it on unmount (see `views/screen/android.tsx`). Safe to call more than once.
    public stop = (ev?: string | Event): void => {
        if (ev && ev instanceof Event && ev.type === 'error') {
            console.error(TAG, ev);
        }
        this.streamReceiver.off('deviceMessage', this.OnDeviceMessage);
        this.streamReceiver.off('video', this.onVideo);
        this.streamReceiver.off('clientsStats', this.onClientsStats);
        this.streamReceiver.off('displayInfo', this.onDisplayInfo);
        this.streamReceiver.off('disconnected', this.onDisconnected);
        this.streamReceiver.off('connected', this.onConnected);
        this.player?.off('decoder-error', this.onDecoderError);
        this.player?.off('keyframe-request', this.onKeyframeRequest);

        this.container.removeEventListener('dragover', this.onFileDragOver);
        this.container.removeEventListener('drop', this.onFileDrop);
        this.touchHandler?.release();
        this.touchHandler = undefined;
        this.detachKeyboard();
        this.controls?.release();
        this.controls = undefined;
        this.audioSession?.stop();
        if (this.deviceView) {
            const parent = this.deviceView.parentElement;
            if (parent) {
                parent.removeChild(this.deviceView);
            }
            this.deviceView = undefined;
        }
        this.streamReceiver.stop();
        if (this.player) {
            this.player.stop();
        }
    };

    public startStream({ udid, player, playerName, videoSettings }: StartParams): void {
        if (!udid) {
            throw Error(`Invalid udid value: "${udid}"`);
        }

        streamConnected.value = this.streamReceiver.isReady();
        deviceClipboard.value = undefined;
        if (!player) {
            if (typeof playerName !== 'string') {
                throw Error('Must provide BasePlayer instance or playerName');
            }
            let displayInfo: DisplayInfo | undefined;
            if (this.streamReceiver && videoSettings) {
                displayInfo = this.streamReceiver.getDisplayInfo(videoSettings.displayId);
            }
            const p = StreamClientScrcpy.createPlayer(playerName, udid, displayInfo);
            if (!p) {
                throw Error(`Unsupported player: "${playerName}"`);
            }
            player = p;
        }
        this.player = player;
        this.setTouchListeners(player);

        if (!videoSettings) {
            videoSettings = player.getVideoSettings();
        }

        const deviceView = (this.deviceView = document.createElement('div'));
        deviceView.className = 'device-view';

        // A no-op (`undefined`) unless `index.tsx` registered a factory behind `/// #if
        // USE_AUDIO` -- see `state/audio.ts`. Created once per stream so the toolbar mute button
        // and this session share the same `AudioPlayer`/gain node.
        this.audioSession = createAudioSession(this.streamReceiver);

        // The actions of the controls. `views/FloatingToolbar.tsx` draws them (`controls/`).
        this.controls = createAndroidControls(udid, player, this, this.audioSession);
        // Keyboard capture is on by default (see `parseParameters`); `?captureKeyboard=0` opts
        // out. The toggle that changes it while streaming is in `SettingsSheet`.
        if (this.params.captureKeyboard !== false) {
            this.setHandleKeyboardEvents(true);
        }

        const video = document.createElement('div');
        video.className = 'video';
        deviceView.appendChild(video);
        player.setParent(video);
        player.pause();

        this.container.appendChild(deviceView);
        player.setVideoSettings(videoSettings);
        const element = player.getTouchableElement();
        element.tabIndex = 0;
        element.setAttribute('aria-label', 'Remote phone screen');
        element.addEventListener('pointerdown', () => {
            this.releaseVirtualKeyboard();
            // Touch handlers prevent the browser's default focus action, so explicitly focusing
            // this canvas can still match :focus-visible on phones. Keep keyboard routing while
            // marking pointer focus separately from keyboard navigation onto the screen.
            element.dataset.pointerFocused = 'true';
            element.focus({ preventScroll: true });
        });
        element.addEventListener('blur', () => delete element.dataset.pointerFocused);
        // Stock scrcpy cannot read the fork's type-102 uploads: they corrupt its control socket.
        // The device list's Files tool uploads safely over adb.
        this.container.addEventListener('dragover', this.onFileDragOver);
        this.container.addEventListener('drop', this.onFileDrop);

        const streamReceiver = this.streamReceiver;
        streamReceiver.on('deviceMessage', this.OnDeviceMessage);
        streamReceiver.on('video', this.onVideo);
        streamReceiver.on('clientsStats', this.onClientsStats);
        streamReceiver.on('displayInfo', this.onDisplayInfo);
        streamReceiver.on('disconnected', this.onDisconnected);
        streamReceiver.on('connected', this.onConnected);
        player.on('decoder-error', this.onDecoderError);
        player.on('keyframe-request', this.onKeyframeRequest);
        console.log(TAG, player.getName(), udid);
    }

    private onFileDragOver = (event: DragEvent): void => {
        if (event.dataTransfer?.types.includes('Files')) {
            event.preventDefault();
        }
    };

    private onFileDrop = (event: DragEvent): void => {
        if (event.dataTransfer?.files.length) {
            event.preventDefault();
            streamNotice.value = 'To upload files, open the Files tab.';
        }
    };

    public sendMessage(message: ControlMessage): void {
        this.streamReceiver.sendEvent(message);
    }

    public isControlReady(): boolean {
        return this.streamReceiver.isReady();
    }

    public sendImmediateMessages(messages: readonly ControlMessage[]): boolean {
        return this.streamReceiver.sendImmediateEvents(messages);
    }

    public getDeviceName(): string {
        return this.deviceName;
    }

    /**
     * Routes host key events to the device. Default path is UHID: the device registers a real
     * virtual keyboard on the first physical keydown, so its own layout applies. Returning to
     * touch/local controls unregisters it. `useUhid: false` injects Android keycodes, which is what
     * older devices (pre-Android 11, where the server cannot open /dev/uhid) need.
     */
    public setHandleKeyboardEvents(enabled: boolean, useUhid = true): void {
        if (enabled === this.keyboardAttached && (!enabled || useUhid === !!this.uhidKeyboard)) {
            return;
        }
        this.detachKeyboard();
        if (!enabled) {
            return;
        }
        this.keyboardAttached = true;
        if (useUhid) {
            this.uhidKeyboard = new UhidKeyboard(this);
            if (this.clientId > 0 && this.streamReceiver.isReady()) {
                this.uhidKeyboard.setId(this.clientId);
            }
            window.addEventListener('keydown', this.onUhidKeyDown, true);
            window.addEventListener('keyup', this.onUhidKeyUp, true);
            window.addEventListener('blur', this.onUhidBlur);
            window.addEventListener('pagehide', this.onUhidBlur);
            document.addEventListener('visibilitychange', this.onUhidVisibilityChange);
            document.addEventListener('focusin', this.onLocalFocus);
        } else {
            KeyInputHandler.addEventListener(this);
        }
    }

    public isKeyboardCaptured(): boolean {
        return this.keyboardAttached;
    }

    public isUsingUhidKeyboard(): boolean {
        return !!this.uhidKeyboard;
    }

    private detachKeyboard(): void {
        if (this.uhidKeyboard) {
            window.removeEventListener('keydown', this.onUhidKeyDown, true);
            window.removeEventListener('keyup', this.onUhidKeyUp, true);
            window.removeEventListener('blur', this.onUhidBlur);
            window.removeEventListener('pagehide', this.onUhidBlur);
            document.removeEventListener('visibilitychange', this.onUhidVisibilityChange);
            document.removeEventListener('focusin', this.onLocalFocus);
            this.uhidKeyboard.destroy();
            this.uhidKeyboard = undefined;
        } else if (this.keyboardAttached) {
            KeyInputHandler.removeEventListener(this);
        }
        this.keyboardAttached = false;
    }

    private onUhidKeyDown = (event: KeyboardEvent): void => {
        // Leave typing in our own UI (the Live Text overlay, settings inputs) alone.
        if (isLocalKeyboardTarget(event.target) || event.isComposing) {
            this.releaseVirtualKeyboard();
            return;
        }
        if (!this.streamReceiver.isReady()) {
            if (UhidKeyboard.isSupportedCode(event.code)) event.preventDefault();
            return;
        }
        if (this.uhidKeyboard?.handleKey(event.code, true)) {
            event.preventDefault();
        }
    };

    private onUhidKeyUp = (event: KeyboardEvent): void => {
        if (isLocalKeyboardTarget(event.target) || event.isComposing) {
            this.releaseVirtualKeyboard();
            return;
        }
        if (!this.streamReceiver.isReady()) {
            if (UhidKeyboard.isSupportedCode(event.code)) event.preventDefault();
            return;
        }
        if (this.uhidKeyboard?.handleKey(event.code, false)) {
            event.preventDefault();
        }
    };

    /** Release this viewer's HID device without changing its physical-key capture preference. */
    public releaseVirtualKeyboard(): void {
        this.uhidKeyboard?.destroy();
    }

    // Removing the HID device clears held keys and restores Android's software keyboard.
    private onUhidBlur = (): void => {
        this.releaseVirtualKeyboard();
    };

    private onUhidVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') this.releaseVirtualKeyboard();
    };

    private onLocalFocus = (event: FocusEvent): void => {
        if (isLocalKeyboardTarget(event.target)) this.releaseVirtualKeyboard();
    };

    /** The actions of the controls, for `FloatingToolbar` (see `startStream`). */
    public getControls(): PhoneControls | undefined {
        return this.controls;
    }

    public onKeyEvent(event: KeyCodeControlMessage): void {
        this.sendMessage(event);
    }

    public getClientId(): number {
        return this.clientId;
    }

    public getClientsCount(): number {
        return this.clientsCount;
    }

    // Exposed for `SettingsSheet`'s "Playback" group -- player choice goes through `navigate()`
    // (it remounts the whole screen view), but the quality-stats overlay is client-side-only and
    // acts on the already-running player instance in place.
    public getPlayer(): BasePlayer | undefined {
        return this.player;
    }

    private setTouchListeners(player: BasePlayer): void {
        if (this.touchHandler) {
            return;
        }
        this.touchHandler = new FeaturedInteractionHandler(player, this);
    }
}
