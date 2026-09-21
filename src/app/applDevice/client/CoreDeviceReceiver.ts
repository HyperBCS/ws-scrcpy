import { ManagerClient } from '../../client/ManagerClient';
import { ACTION } from '../../../common/Action';
import { ParamsBase } from '../../../types/ParamsBase';
import {
    COREDEVICE_FRAME_AUDIO,
    CoreDeviceClientMessage,
    CoreDeviceServerMessage,
    CoreDeviceSessionState,
} from '../../../common/CoreDeviceProtocol';
import { AudioMetadata } from '../../../common/AudioProtocol';
import { AudioFrame, audioErrorMetadata, parseAudioPacket } from '../../client/audioPacket';

export interface CoreDeviceReceiverEvents {
    connected: void;
    disconnected: void;
    status: { state: CoreDeviceSessionState; message?: string };
    codec: { codec: string; description: Uint8Array };
    video: Uint8Array;
    clipboard: { text: string | null; error?: string };
    result: { id: number; ok: boolean; error?: string; data?: unknown };
    // Device audio in the shared browser envelope; see `state/audio.ts` (`AudioSource`).
    audio: AudioFrame;
    audioMetadata: AudioMetadata;
}

export type ParamsCoreDeviceReceiver = ParamsBase & { udid: string };

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;

function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * The browser end of `CoreDeviceProxy`. Binary messages are video access units, text messages
 * are JSON; see `CoreDeviceProtocol`. Reconnects with backoff after any close, as the Android
 * `StreamReceiver` does, so a server-side session restart is a short freeze rather than a dead
 * page. `stop()` is final.
 */
export class CoreDeviceReceiver extends ManagerClient<ParamsCoreDeviceReceiver, CoreDeviceReceiverEvents> {
    public static readonly ACTION = ACTION.PROXY_COREDEVICE;
    private stopped = false;
    private attempts = 0;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private ready = false;
    private audioMetadata?: AudioMetadata;
    private audioConfig?: AudioFrame;

    constructor(params: ParamsCoreDeviceReceiver) {
        super({ ...params, action: ACTION.PROXY_COREDEVICE });
        this.openNewConnection();
        this.prepareSocket();
    }

    private prepareSocket(): void {
        if (this.ws instanceof WebSocket) {
            this.ws.binaryType = 'arraybuffer';
        }
    }

    protected buildDirectWebSocketUrl(): URL {
        const url = super.buildDirectWebSocketUrl();
        url.searchParams.set('action', ACTION.PROXY_COREDEVICE);
        url.searchParams.set('udid', this.params.udid);
        return url;
    }

    public isReady(): boolean {
        return this.ready && this.hasConnection();
    }

    public getAudioMetadata(): AudioMetadata | undefined {
        return this.audioMetadata;
    }

    public getAudioConfig(): AudioFrame | undefined {
        return this.audioConfig;
    }

    /**
     * Audio reaches the browser in bursts of roughly 80 ms (measured at the proxy: packets
     * arrive 1 ms apart, then an 80 ms pause), so the player must hold more than one burst
     * period or it runs dry on every burst -- heard as static, not silence.
     */
    public getAudioBufferProfile(): { targetSeconds: number; maxSeconds: number } {
        return { targetSeconds: 0.16, maxSeconds: 0.5 };
    }

    public send(message: CoreDeviceClientMessage): boolean {
        if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
            return false;
        }
        this.ws.send(JSON.stringify(message));
        return true;
    }

    protected onSocketOpen(): void {
        this.attempts = 0;
        this.emit('connected', undefined as never);
    }

    protected onSocketMessage(event: MessageEvent): void {
        if (this.stopped) {
            return;
        }
        if (typeof event.data === 'string') {
            let message: CoreDeviceServerMessage;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }
            switch (message.type) {
                case 'status':
                    this.ready = message.state === 'ready';
                    this.emit('status', { state: message.state, message: message.message });
                    return;
                case 'codec':
                    this.ready = true;
                    this.emit('codec', { codec: message.codec, description: decodeBase64(message.description) });
                    return;
                case 'clipboard':
                    this.emit('clipboard', { text: message.text, error: message.error });
                    return;
                case 'result':
                    this.emit('result', message);
                    return;
                default:
                    return;
            }
        }
        if (event.data instanceof ArrayBuffer) {
            if (new Uint8Array(event.data, 0, 1)[0] === COREDEVICE_FRAME_AUDIO) {
                this.handleAudioPacket(event.data);
                return;
            }
            this.emit('video', new Uint8Array(event.data));
        }
    }

    private handleAudioPacket(message: ArrayBuffer): void {
        try {
            const parsed = parseAudioPacket(message, 1);
            if (parsed.kind === 'metadata') {
                if (parsed.metadata.status !== 'ready' || parsed.metadata.codec !== this.audioMetadata?.codec) {
                    this.audioConfig = undefined;
                }
                this.audioMetadata = parsed.metadata;
                this.emit('audioMetadata', parsed.metadata);
            } else {
                if (parsed.frame.config) {
                    this.audioConfig = parsed.frame;
                }
                this.emit('audio', parsed.frame);
            }
        } catch (error) {
            // A bad audio packet only ever changes the audio status; video and input carry on.
            this.audioConfig = undefined;
            this.audioMetadata = audioErrorMetadata(error);
            this.emit('audioMetadata', this.audioMetadata);
        }
    }

    protected onSocketClose(): void {
        this.ready = false;
        // The next session may run a different helper process; its audio state starts over.
        this.audioMetadata = undefined;
        this.audioConfig = undefined;
        this.emit('disconnected', undefined as never);
        if (this.stopped) {
            return;
        }
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.attempts, 4));
        this.attempts++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (!this.stopped) {
                this.openNewConnection();
                this.prepareSocket();
            }
        }, delay);
    }

    public stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.ws && (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING)) {
            this.ws.close();
        }
        if (!this.destroyed) {
            super.destroy();
        }
    }

    public destroy(): void {
        this.stop();
    }
}
