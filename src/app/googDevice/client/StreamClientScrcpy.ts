import { BaseClient } from '../../client/BaseClient';
import { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { GoogToolBox } from '../toolbox/GoogToolBox';
import VideoSettings from '../../VideoSettings';
import Size from '../../Size';
import { ControlMessage } from '../../controlMessage/ControlMessage';
import { ClientsStats, DisplayCombinedInfo } from '../../client/StreamReceiver';
import Util from '../../Util';
import { KeyEventListener, KeyInputHandler } from '../KeyInputHandler';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { BasePlayer, PlayerClass } from '../../player/BasePlayer';
import {
    FeaturedInteractionHandler,
    InteractionHandlerListener,
} from '../../interactionHandler/FeaturedInteractionHandler';
import DeviceMessage from '../DeviceMessage';
import { DisplayInfo } from '../../DisplayInfo';
import { ACTION } from '../../../common/Action';
import { StreamReceiverScrcpy } from './StreamReceiverScrcpy';
import { computeMaxSize } from '../../ControlBarLayout';
import { UhidKeyboard } from '../UhidKeyboard';
import { deviceClipboard, lastFrameAt, streamConnected, streamNotice } from '../../state/stream';
import { AudioSession, createAudioSession } from '../../state/audio';
import { isLocalKeyboardTarget } from '../localKeyboardTarget';

type StartParams = {
    udid: string;
    playerName?: string;
    player?: BasePlayer;
    fitToScreen?: boolean;
    videoSettings?: VideoSettings;
};

const TAG = '[StreamClientScrcpy]';

export class StreamClientScrcpy
    extends BaseClient<ParamsStreamScrcpy, never>
    implements KeyEventListener, InteractionHandlerListener
{
    public static ACTION = 'stream';
    private static players: Map<string, PlayerClass> = new Map<string, PlayerClass>();

    private controlButtons?: HTMLElement;
    private toolBox?: GoogToolBox;
    private uhidKeyboard?: UhidKeyboard;
    private keyboardAttached = false;
    private deviceName = '';
    private clientId = -1;
    private clientsCount = -1;
    private joinedStream = false;
    private requestedVideoSettings?: VideoSettings;
    private touchHandler?: FeaturedInteractionHandler;
    private player?: BasePlayer;
    private fitToScreen?: boolean;
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

    public static getFitToScreen(playerName: string, udid: string, displayInfo?: DisplayInfo): boolean {
        const playerClass = this.getPlayerClass(playerName);
        if (!playerClass) {
            return false;
        }
        return playerClass.getFitToScreenStatus(udid, displayInfo);
    }

    public static start(
        query: URLSearchParams | ParamsStreamScrcpy,
        streamReceiver?: StreamReceiverScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
        container?: HTMLElement,
    ): StreamClientScrcpy {
        if (query instanceof URLSearchParams) {
            const params = StreamClientScrcpy.parseParameters(query);
            return new StreamClientScrcpy(params, streamReceiver, player, fitToScreen, videoSettings, container);
        } else {
            return new StreamClientScrcpy(query, streamReceiver, player, fitToScreen, videoSettings, container);
        }
    }

    private static createVideoSettingsWithBounds(old: VideoSettings, newBounds: Size): VideoSettings {
        return new VideoSettings({
            crop: old.crop,
            bitrate: old.bitrate,
            bounds: newBounds,
            maxFps: old.maxFps,
            iFrameInterval: old.iFrameInterval,
            sendFrameMeta: old.sendFrameMeta,
            lockedVideoOrientation: old.lockedVideoOrientation,
            displayId: old.displayId,
            codecOptions: old.codecOptions,
            encoderName: old.encoderName,
        });
    }

    protected constructor(
        params: ParamsStreamScrcpy,
        streamReceiver?: StreamReceiverScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
        // A view hosting this client can pass its own container to mount into (see
        // `views/StreamView.tsx`); direct/legacy callers keep working against `document.body`.
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

        const { udid, player: playerName } = this.params;
        // Allow the stream deep link to start already fit to screen
        // (?fitToScreen=1), so an embedded/auto-started stream can request it
        // without going through the Configure screen.
        if (typeof fitToScreen !== 'boolean') {
            fitToScreen = this.params.fitToScreen;
        }
        this.startStream({ udid, player, playerName, fitToScreen, videoSettings });
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
            // Defaults ON: with UHID the device sees a real keyboard, so this costs nothing when
            // no physical keyboard is attached and means one less thing to switch on when there
            // is. `?captureKeyboard=0` opts out.
            //
            // NB `Util.parseBoolean`'s third argument is `required`, NOT a default -- passing
            // `true` there makes every stream deep link throw "Missing required parameter".
            captureKeyboard: params.has('captureKeyboard') ? Util.parseBoolean(params, 'captureKeyboard') : true,
            fitToScreen: params.has('fitToScreen') ? Util.parseBoolean(params, 'fitToScreen') : undefined,
        };
    }

    public OnDeviceMessage = (message: DeviceMessage): void => {
        if (message.type === DeviceMessage.TYPE_CLIPBOARD) {
            deviceClipboard.value = message.getText();
        }
    };

    public onVideo = (data: Uint8Array): void => {
        // Fed to `lastFrameAt` unconditionally (even before the player starts playing) so the
        // frame clock reflects "is data still arriving", not "is this tab currently rendering it".
        lastFrameAt.value = Date.now();
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
        // `connected` precedes these stats. Wait for this viewer's assigned id before
        // registering its keyboard on the shared scrcpy control socket.
        this.uhidKeyboard?.setId(this.clientId);
        if (this.streamReceiver.isReady()) {
            this.uhidKeyboard?.create();
        }
        this.setTitle(`Stream ${this.deviceName}`);
    };

    public onDisplayInfo = (infoArray: DisplayCombinedInfo[]): void => {
        if (!this.player) {
            return;
        }
        let currentSettings = this.player.getVideoSettings();
        const displayId = currentSettings.displayId;
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
        if (typeof this.fitToScreen !== 'boolean') {
            this.fitToScreen = this.player.getFitToScreenStatus();
        }
        if (this.fitToScreen) {
            const newBounds = this.getMaxSize();
            if (newBounds) {
                currentSettings = StreamClientScrcpy.createVideoSettingsWithBounds(currentSettings, newBounds);
                this.player.setVideoSettings(currentSettings, this.fitToScreen, false);
            }
        }
        if (!videoSettings || !screenInfo) {
            this.joinedStream = true;
            // this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(currentSettings));
            return;
        }

        this.clientsCount = info.connectionCount;
        let min = VideoSettings.copy(videoSettings);
        const oldInfo = this.player.getScreenInfo();
        if (!screenInfo.equals(oldInfo)) {
            this.player.setScreenInfo(screenInfo);
        }

        if (!videoSettings.equals(currentSettings)) {
            const bounds = this.fitToScreen ? this.getMaxSize() : undefined;
            const localSettings = bounds
                ? StreamClientScrcpy.createVideoSettingsWithBounds(videoSettings, bounds)
                : videoSettings;
            this.applyNewVideoSettings(localSettings, videoSettings.equals(this.requestedVideoSettings));
        }
        if (!oldInfo) {
            const bounds = currentSettings.bounds;
            const videoSize: Size = screenInfo.videoSize;
            const onlyOneClient = this.clientsCount === 0;
            const smallerThenCurrent = bounds && (bounds.width < videoSize.width || bounds.height < videoSize.height);
            if (onlyOneClient || smallerThenCurrent) {
                min = currentSettings;
            }
            const minBounds = currentSettings.bounds?.intersect(min.bounds);
            if (minBounds && !minBounds.equals(min.bounds)) {
                min = StreamClientScrcpy.createVideoSettingsWithBounds(min, minBounds);
            }
        }
        if (!min.equals(videoSettings) || !this.joinedStream) {
            this.joinedStream = true;
            // this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(min));
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
    public onDisconnected = (): void => {
        streamConnected.value = false;
        this.clientId = -1;
        // A replacement scrcpy process has no virtual keyboard, even if capture remains on.
        this.uhidKeyboard?.reset();
        this.player?.pause();
    };

    public onConnected = (): void => {
        streamConnected.value = true;
    };

    // Tears down the DOM this client owns and stops the underlying receiver/player. Wired up as
    // the more-box "Stop" action, and also the right thing for a host view to call from its own
    // unmount (see `views/StreamView.tsx`) -- safe to call more than once.
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

        this.container.removeEventListener('dragover', this.onFileDragOver);
        this.container.removeEventListener('drop', this.onFileDrop);
        this.touchHandler?.release();
        this.touchHandler = undefined;
        window.removeEventListener('resize', this.onWindowResize);
        if (this.resizeTimeoutId !== undefined) {
            clearTimeout(this.resizeTimeoutId);
            this.resizeTimeoutId = undefined;
        }
        this.detachKeyboard();
        this.toolBox?.release();
        this.toolBox = undefined;
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

    public startStream({ udid, player, playerName, videoSettings, fitToScreen }: StartParams): void {
        if (!udid) {
            throw Error(`Invalid udid value: "${udid}"`);
        }

        // Fresh frame clock for this session -- see `lastFrameAt`/`SleepOverlay`.
        lastFrameAt.value = undefined;
        streamConnected.value = this.streamReceiver.isReady();
        deviceClipboard.value = undefined;
        this.fitToScreen = fitToScreen;
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
            if (typeof fitToScreen !== 'boolean') {
                fitToScreen = StreamClientScrcpy.getFitToScreen(playerName, udid, displayInfo);
            }
            player = p;
        }
        this.player = player;
        this.fitToScreen = fitToScreen;
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

        const googToolBox = GoogToolBox.createToolBox(udid, player, this, {
            captureKeyboard: this.params.captureKeyboard,
            audioSession: this.audioSession,
        });
        // Built but deliberately NOT appended to the device view: `views/FloatingToolbar.tsx`
        // reparents it into a draggable floating panel. The docked bar ate a fixed slice of a
        // phone screen and, in portrait, wrapped to a second row that ran under the home
        // indicator -- half of it was clipped and untappable.
        this.toolBox = googToolBox;
        this.controlButtons = googToolBox.getHolderElement();

        const video = document.createElement('div');
        video.className = 'video';
        deviceView.appendChild(video);
        player.setParent(video);
        player.pause();

        this.container.appendChild(deviceView);
        if (fitToScreen) {
            const newBounds = this.getMaxSize();
            if (newBounds) {
                videoSettings = StreamClientScrcpy.createVideoSettingsWithBounds(videoSettings, newBounds);
            }
        }
        this.applyNewVideoSettings(videoSettings, false);
        const element = player.getTouchableElement();
        element.tabIndex = 0;
        element.setAttribute('aria-label', 'Remote device screen');
        element.addEventListener('pointerdown', () => {
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
        console.log(TAG, player.getName(), udid);

        // Fit changes browser playback bounds; encoder changes require a server restart.
        window.addEventListener('resize', this.onWindowResize);
    }

    private onFileDragOver = (event: DragEvent): void => {
        if (event.dataTransfer?.types.includes('Files')) {
            event.preventDefault();
        }
    };

    private onFileDrop = (event: DragEvent): void => {
        if (event.dataTransfer?.files.length) {
            event.preventDefault();
            streamNotice.value = 'To upload files, open Files from the device list.';
        }
    };

    private resizeTimeoutId?: ReturnType<typeof setTimeout>;

    private onWindowResize = (): void => {
        if (this.resizeTimeoutId !== undefined) {
            clearTimeout(this.resizeTimeoutId);
        }
        this.resizeTimeoutId = setTimeout(this.applyFitToScreenBounds, 300);
    };

    private applyFitToScreenBounds = (): void => {
        this.resizeTimeoutId = undefined;
        if (!this.player || !this.fitToScreen) {
            return;
        }
        const newBounds = this.getMaxSize();
        if (!newBounds) {
            return;
        }
        const current = this.player.getVideoSettings();
        if (current.bounds && current.bounds.equals(newBounds)) {
            return;
        }
        const updated = StreamClientScrcpy.createVideoSettingsWithBounds(current, newBounds);
        this.player.setVideoSettings(updated, true, false);
        this.sendNewVideoSetting(updated);
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
     * virtual keyboard, so its own layout applies and it stops raising the on-screen keyboard
     * over the content. `useUhid: false` falls back to injecting Android keycodes, which is what
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
                this.uhidKeyboard.create();
            }
            window.addEventListener('keydown', this.onUhidKeyDown, true);
            window.addEventListener('keyup', this.onUhidKeyUp, true);
            window.addEventListener('blur', this.onUhidBlur);
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
            this.uhidKeyboard?.releaseAll();
            return;
        }
        if (this.uhidKeyboard?.handleKey(event.code, true)) {
            event.preventDefault();
        }
    };

    private onUhidKeyUp = (event: KeyboardEvent): void => {
        if (isLocalKeyboardTarget(event.target) || event.isComposing) {
            this.uhidKeyboard?.releaseAll();
            return;
        }
        if (this.uhidKeyboard?.handleKey(event.code, false)) {
            event.preventDefault();
        }
    };

    // A key released while the tab is unfocused is never delivered, and a stuck modifier would
    // corrupt every keystroke afterwards.
    private onUhidBlur = (): void => {
        this.uhidKeyboard?.releaseAll();
    };

    /** The control buttons, for `FloatingToolbar` to adopt (see `startStream`). */
    public getControlButtonsElement(): HTMLElement | undefined {
        return this.controlButtons;
    }

    public onKeyEvent(event: KeyCodeControlMessage): void {
        this.sendMessage(event);
    }

    public sendNewVideoSetting(videoSettings: VideoSettings): void {
        this.requestedVideoSettings = videoSettings;
        // this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(videoSettings));
    }

    public getClientId(): number {
        return this.clientId;
    }

    public getClientsCount(): number {
        return this.clientsCount;
    }

    public getMaxSize(): Size | undefined {
        // The toolbar floats over the video now, so nothing is subtracted from the container.
        return computeMaxSize(this.container.clientWidth, this.container.clientHeight);
    }

    // Exposed for `SettingsSheet`'s "Playback" group -- player choice goes through `navigate()`
    // (it remounts the whole `StreamView`), but fit-to-screen and the quality-stats overlay are
    // client-side-only and act on the already-running player instance in place.
    public getPlayer(): BasePlayer | undefined {
        return this.player;
    }

    // Keep the live value across viewport changes; saved preferences are keyed by viewport
    // size, so reading them after rotation can accidentally undo an explicit session choice.
    public isFitToScreen(): boolean {
        return this.fitToScreen ?? false;
    }

    // Toggles fit-to-screen for the *current* player/session instantly, with no reconnect. Stock
    // scrcpy has no live video-settings channel (see `sendNewVideoSetting` below), so this only
    // resizes the local canvas/bounds the player already uses to fit the container, exactly like
    // `applyFitToScreenBounds` does on resize. `saveToStorage: true` persists the choice so it
    // sticks across reloads and future resizes.
    public setFitToScreen(enabled: boolean): void {
        if (!this.player) {
            return;
        }
        this.fitToScreen = enabled;
        if (enabled) {
            const newBounds = this.getMaxSize();
            if (newBounds) {
                const updated = StreamClientScrcpy.createVideoSettingsWithBounds(
                    this.player.getVideoSettings(),
                    newBounds,
                );
                this.player.setVideoSettings(updated, true, true);
                this.sendNewVideoSetting(updated);
                return;
            }
        }
        const nativeSize = this.player.getScreenInfo()?.videoSize;
        const settings = this.player.getVideoSettings();
        this.player.setVideoSettings(
            nativeSize ? StreamClientScrcpy.createVideoSettingsWithBounds(settings, nativeSize) : settings,
            false,
            true,
        );
    }

    private setTouchListeners(player: BasePlayer): void {
        if (this.touchHandler) {
            return;
        }
        this.touchHandler = new FeaturedInteractionHandler(player, this);
    }

    private applyNewVideoSettings(videoSettings: VideoSettings, saveToStorage: boolean): void {
        const fitToScreen = this.fitToScreen ?? false;
        if (this.player) {
            this.player.setVideoSettings(videoSettings, fitToScreen, saveToStorage);
        }
    }
}
