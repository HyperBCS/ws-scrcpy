import { ManagerClient } from './ManagerClient';
import { ControlMessage } from '../controlMessage/ControlMessage';
import DeviceMessage from '../googDevice/DeviceMessage';
import VideoSettings from '../VideoSettings';
import ScreenInfo from '../ScreenInfo';
import Util from '../Util';
import { DisplayInfo } from '../DisplayInfo';
import { ParamsStream } from '../../types/ParamsStream';
import { AUDIO_MAGIC, AudioMetadata } from '../../common/AudioProtocol';
import { audioErrorMetadata, parseAudioPacket } from './audioPacket';
import type { AudioFrame } from './audioPacket';

const DEVICE_NAME_FIELD_LENGTH = 64;
const MAGIC_BYTES_INITIAL = Util.stringToUtf8ByteArray('scrcpy_initial');
// Mirrors Broadcast.ts's own MAGIC_BYTES_AUDIO constant (kept as independent literals in both
// files, same as MAGIC_BYTES_INITIAL already is). Must stay 14 bytes: see the comment on
// StreamReceiver.onSocketMessage's EqualArrays check below.
const MAGIC_BYTES_AUDIO = Util.stringToUtf8ByteArray('scrcpy_audio_1');
const MAGIC_BYTES_AUDIO_V2 = Util.stringToUtf8ByteArray(AUDIO_MAGIC);

export type ClientsStats = {
    deviceName: string;
    clientId: number;
};

// The `audio` event payload; the type lives with the shared packet parser.
export type { AudioFrame } from './audioPacket';

export type DisplayCombinedInfo = {
    displayInfo: DisplayInfo;
    videoSettings?: VideoSettings;
    screenInfo?: ScreenInfo;
    connectionCount: number;
};

interface StreamReceiverEvents {
    video: Uint8Array;
    audio: AudioFrame;
    audioMetadata: AudioMetadata;
    deviceMessage: DeviceMessage;
    displayInfo: DisplayCombinedInfo[];
    clientsStats: ClientsStats;
    encoders: string[];
    connected: void;
    disconnected: CloseEvent;
}

const TAG = '[StreamReceiver]';

export class StreamReceiver<P extends ParamsStream> extends ManagerClient<ParamsStream, StreamReceiverEvents> {
    private static readonly RECONNECT_BASE_DELAY_MS = 1000;
    private static readonly RECONNECT_MAX_DELAY_MS = 8000;
    private events: ControlMessage[] = [];
    private encodersSet: Set<string> = new Set<string>();
    private clientId = -1;
    private deviceName = '';
    private readonly displayInfoMap: Map<number, DisplayInfo> = new Map();
    private readonly connectionCountMap: Map<number, number> = new Map();
    private readonly screenInfoMap: Map<number, ScreenInfo> = new Map();
    private readonly videoSettingsMap: Map<number, VideoSettings> = new Map();
    private hasInitialInfo = false;
    private stopped = false;
    private reconnectAttempts = 0;
    private reconnectTimeoutId?: ReturnType<typeof setTimeout>;
    private audioMetadata?: AudioMetadata;
    private audioConfig?: AudioFrame;

    constructor(params: P) {
        super(params);
        this.openNewConnection();
        if (this.ws) {
            this.ws.binaryType = 'arraybuffer';
        }
    }

    private handleInitialInfo(data: ArrayBuffer): void {
        let offset = MAGIC_BYTES_INITIAL.length;
        let nameBytes: Uint8Array = new Uint8Array(data, offset, DEVICE_NAME_FIELD_LENGTH);
        offset += DEVICE_NAME_FIELD_LENGTH;
        let rest: Buffer = Buffer.from(new Uint8Array(data, offset));
        const displaysCount = rest.readInt32BE(0);
        this.displayInfoMap.clear();
        this.connectionCountMap.clear();
        this.screenInfoMap.clear();
        this.videoSettingsMap.clear();
        rest = rest.slice(4);
        for (let i = 0; i < displaysCount; i++) {
            const displayInfoBuffer = rest.slice(0, DisplayInfo.BUFFER_LENGTH);
            const displayInfo = DisplayInfo.fromBuffer(displayInfoBuffer);
            const { displayId } = displayInfo;
            this.displayInfoMap.set(displayId, displayInfo);
            rest = rest.slice(DisplayInfo.BUFFER_LENGTH);
            this.connectionCountMap.set(displayId, rest.readInt32BE(0));
            rest = rest.slice(4);
            const screenInfoBytesCount = rest.readInt32BE(0);
            rest = rest.slice(4);
            if (screenInfoBytesCount) {
                this.screenInfoMap.set(displayId, ScreenInfo.fromBuffer(rest.slice(0, screenInfoBytesCount)));
                rest = rest.slice(screenInfoBytesCount);
            }
            const videoSettingsBytesCount = rest.readInt32BE(0);
            rest = rest.slice(4);
            if (videoSettingsBytesCount) {
                this.videoSettingsMap.set(displayId, VideoSettings.fromBuffer(rest.slice(0, videoSettingsBytesCount)));
                rest = rest.slice(videoSettingsBytesCount);
            }
        }
        this.encodersSet.clear();
        const encodersCount = rest.readInt32BE(0);
        rest = rest.slice(4);
        for (let i = 0; i < encodersCount; i++) {
            const nameLength = rest.readInt32BE(0);
            rest = rest.slice(4);
            const nameBytes = rest.slice(0, nameLength);
            rest = rest.slice(nameLength);
            const name = Util.utf8ByteArrayToString(nameBytes);
            this.encodersSet.add(name);
        }
        this.clientId = rest.readInt32BE(0);
        nameBytes = Util.filterTrailingZeroes(nameBytes);
        this.deviceName = Util.utf8ByteArrayToString(nameBytes);
        this.hasInitialInfo = true;
        this.reconnectAttempts = 0;
        // The WebSocket opens before adb startup completes. Control sent before scrcpy_initial
        // is discarded by the proxy, including the virtual keyboard's initial registration.
        this.emit('connected', void 0);
        const pendingEvents = this.events.splice(0);
        pendingEvents.forEach((event) => this.sendEvent(event));
        this.triggerInitialInfoEvents();
    }

    private static EqualArrays(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0, l = a.length; i < l; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    protected buildDirectWebSocketUrl(): URL {
        const localUrl = super.buildDirectWebSocketUrl();
        if (this.supportMultiplexing()) {
            return localUrl;
        }
        localUrl.searchParams.set('udid', this.params.udid);
        return localUrl;
    }

    protected onSocketClose(ev: CloseEvent): void {
        this.events.length = 0;
        this.hasInitialInfo = false;
        this.audioMetadata = undefined;
        this.audioConfig = undefined;
        console.log(`${TAG}. WS closed: ${ev.reason}`);
        this.emit('disconnected', ev);
        this.scheduleReconnect();
    }

    /**
     * Stock scrcpy has no live "change settings" control message, so applying new video settings
     * means the server kills and relaunches its process (see Device.updateStreamConfig on the
     * server), which drops every viewer's socket. Without this, onSocketClose above only ever
     * emitted 'disconnected' and left the viewer stuck. Modelled on
     * BaseDeviceTracker.onSocketClose's fixed 2s retry, but with backoff: a restart is a
     * multi-second on-device relaunch (kill, push jar if needed, wait for pid, reconnect the
     * forwarded socket), not a flaky network blip, so retrying immediately would mostly just fail
     * once before the next attempt anyway.
     */
    private scheduleReconnect(): void {
        if (this.stopped || this.destroyed || this.reconnectTimeoutId !== undefined) {
            return;
        }
        const delay = Math.min(
            StreamReceiver.RECONNECT_BASE_DELAY_MS * Math.pow(1.5, this.reconnectAttempts),
            StreamReceiver.RECONNECT_MAX_DELAY_MS,
        );
        this.reconnectAttempts++;
        this.reconnectTimeoutId = setTimeout(() => {
            this.reconnectTimeoutId = undefined;
            if (this.stopped || this.destroyed) {
                return;
            }
            this.openNewConnection();
            if (this.ws) {
                this.ws.binaryType = 'arraybuffer';
            }
        }, delay);
    }

    protected onSocketMessage(event: MessageEvent): void {
        if (this.stopped) {
            return;
        }
        if (event.data instanceof ArrayBuffer) {
            // works only because MAGIC_BYTES_INITIAL, MAGIC_BYTES_MESSAGE and MAGIC_BYTES_AUDIO
            // all have the same length (14)
            if (event.data.byteLength >= MAGIC_BYTES_INITIAL.length) {
                const magicBytes = new Uint8Array(event.data, 0, MAGIC_BYTES_INITIAL.length);
                if (StreamReceiver.EqualArrays(magicBytes, MAGIC_BYTES_INITIAL)) {
                    this.handleInitialInfo(event.data);
                    return;
                }
                if (StreamReceiver.EqualArrays(magicBytes, DeviceMessage.MAGIC_BYTES_MESSAGE)) {
                    const message = DeviceMessage.fromBuffer(event.data);
                    this.emit('deviceMessage', message);
                    return;
                }
                if (StreamReceiver.EqualArrays(magicBytes, MAGIC_BYTES_AUDIO)) {
                    if (event.data.byteLength === MAGIC_BYTES_AUDIO.length) {
                        this.handleAudioPacket(event.data);
                        return;
                    }
                    // Layout after the magic: 1 flag byte (bit0 = config packet), then the raw
                    // encoded audio payload - see Broadcast.emitAudioFrame() on the server.
                    const flagOffset = MAGIC_BYTES_AUDIO.length;
                    const config = new Uint8Array(event.data, flagOffset, 1)[0] === 1;
                    const data = new Uint8Array(event.data, flagOffset + 1);
                    const frame = { config, data };
                    if (config) {
                        this.audioConfig = frame;
                    }
                    this.emit('audio', frame);
                    return;
                }
                if (StreamReceiver.EqualArrays(magicBytes, MAGIC_BYTES_AUDIO_V2)) {
                    this.handleAudioPacket(event.data);
                    return;
                }
            }

            this.emit('video', new Uint8Array(event.data));
        }
    }

    private handleAudioPacket(packet: ArrayBuffer): void {
        try {
            const parsed = parseAudioPacket(packet);
            if (parsed.kind === 'metadata') {
                const { metadata } = parsed;
                if (metadata.status !== 'ready' || metadata.codec !== this.audioMetadata?.codec) {
                    this.audioConfig = undefined;
                }
                this.audioMetadata = metadata;
                this.emit('audioMetadata', metadata);
            } else {
                if (parsed.frame.config) {
                    this.audioConfig = parsed.frame;
                }
                this.emit('audio', parsed.frame);
            }
        } catch (error) {
            // Audio failures must never leak into the video decoder or disconnect controls.
            this.audioConfig = undefined;
            this.audioMetadata = audioErrorMetadata(error);
            this.emit('audioMetadata', this.audioMetadata);
        }
    }

    public getAudioMetadata(): AudioMetadata | undefined {
        return this.audioMetadata;
    }
    public getAudioConfig(): AudioFrame | undefined {
        return this.audioConfig;
    }

    protected onSocketOpen(): void {
        if (this.stopped) {
            this.ws?.close();
            return;
        }
        console.log('OPEN');
    }

    public sendEvent(event: ControlMessage): void {
        if (this.stopped) {
            return;
        }
        if (this.hasInitialInfo && this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(event.toBuffer());
        } else if (this.reconnectAttempts === 0) {
            // Only queue initial setup. Replaying touches or power presses after an outage can
            // control an entirely different screen from the one the user was looking at.
            this.events.push(event);
        }
    }

    /** Sensitive, single-use input must never wait for a handshake or replay after reconnect. */
    public sendImmediateEvents(events: readonly ControlMessage[]): boolean {
        if (!this.isReady() || !this.ws) {
            return false;
        }
        try {
            // One WebSocket message keeps the sequence together on the shared control socket.
            // This path is for stock key/text events, not UHID registration (tracked per frame).
            this.ws.send(Buffer.concat(events.map((event) => event.toBuffer())));
            return true;
        } catch {
            return false;
        }
    }

    public stop(): void {
        this.stopped = true;
        if (this.reconnectTimeoutId !== undefined) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = undefined;
        }
        if (this.ws && this.ws.readyState < this.ws.CLOSING) {
            this.ws.close();
        }
        this.events.length = 0;
    }

    public getEncoders(): string[] {
        return Array.from(this.encodersSet.values());
    }

    public isReady(): boolean {
        return !this.stopped && this.hasInitialInfo && this.hasConnection();
    }

    public getDeviceName(): string {
        return this.deviceName;
    }

    public triggerInitialInfoEvents(): void {
        if (this.hasInitialInfo) {
            const encoders = this.getEncoders();
            this.emit('encoders', encoders);
            const { clientId, deviceName } = this;
            this.emit('clientsStats', { clientId, deviceName });
            const infoArray: DisplayCombinedInfo[] = [];
            this.displayInfoMap.forEach((displayInfo: DisplayInfo, displayId: number) => {
                const connectionCount = this.connectionCountMap.get(displayId) || 0;
                infoArray.push({
                    displayInfo,
                    videoSettings: this.videoSettingsMap.get(displayId),
                    screenInfo: this.screenInfoMap.get(displayId),
                    connectionCount,
                });
            });
            this.emit('displayInfo', infoArray);
        }
    }

    public getDisplayInfo(displayId: number): DisplayInfo | undefined {
        return this.displayInfoMap.get(displayId);
    }
}
