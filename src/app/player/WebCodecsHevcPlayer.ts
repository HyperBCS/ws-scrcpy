import { BaseCanvasBasedPlayer } from './BaseCanvasBasedPlayer';
import VideoSettings from '../VideoSettings';
import Size from '../Size';
import { DisplayInfo } from '../DisplayInfo';
import ScreenInfo from '../ScreenInfo';
import Rect from '../Rect';
import {
    COREDEVICE_FRAME_DELTA,
    COREDEVICE_FRAME_KEY,
    COREDEVICE_FRAME_RESET_KEY,
} from '../../common/CoreDeviceProtocol';

/**
 * HEVC decoder for the iOS CoreDevice screen stream. Frames arrive pre-framed as
 * `[type][4-byte-length-prefixed NALUs]` (see `CoreDeviceProtocol`), the parameter sets come out
 * of band as an hvcC `description`, and the picture size is whatever the first decoded frame
 * says it is -- there is no scrcpy-style initial packet to announce it.
 *
 * Kept separate from `WebCodecsPlayer` on purpose: that class is an Annex-B H.264 parser with a
 * scrcpy-shaped frame flow, and the two share almost nothing beyond the canvas.
 */
export class WebCodecsHevcPlayer extends BaseCanvasBasedPlayer {
    public static readonly storageKeyPrefix = 'WebCodecsHevcPlayer';
    public static readonly playerFullName = 'WebCodecs HEVC';
    public static readonly playerCodeName = 'hevc';
    public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        lockedVideoOrientation: -1,
        bitrate: 6000000,
        maxFps: 60,
        iFrameInterval: 0,
        bounds: new Size(0, 0),
        sendFrameMeta: false,
    });

    public static isSupported(): boolean {
        return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function';
    }

    /** Whether this browser can decode the negotiated stream; the caller shows the reason if not. */
    public static async supportsConfig(codec: string, description: Uint8Array): Promise<boolean> {
        if (!this.isSupported()) {
            return false;
        }
        try {
            const result = await VideoDecoder.isConfigSupported({ codec, description });
            return !!result.supported;
        } catch {
            return false;
        }
    }

    public readonly supportsScreenshot = true;
    private readonly context: CanvasRenderingContext2D;
    private decoder?: VideoDecoder;
    private config?: VideoDecoderConfig;
    private gotKey = false;
    private needsResync = false;
    private timestamp = 0;
    private frameSize?: Size;

    constructor(udid: string, displayInfo?: DisplayInfo, name = WebCodecsHevcPlayer.playerFullName) {
        super(udid, displayInfo, name, WebCodecsHevcPlayer.storageKeyPrefix);
        const context = this.tag.getContext('2d');
        if (!context) {
            throw Error('Failed to get 2d context from canvas');
        }
        this.context = context;
    }

    public getPreferredVideoSetting(): VideoSettings {
        return WebCodecsHevcPlayer.preferredVideoSettings;
    }

    public getFitToScreenStatus(): boolean {
        return true;
    }

    public loadVideoSettings(): VideoSettings {
        return WebCodecsHevcPlayer.preferredVideoSettings;
    }

    /** Playback needs the decoder configured, not a screen size: the size comes from the picture. */
    protected needScreenInfoBeforePlay(): boolean {
        return false;
    }

    public configure(codec: string, description: Uint8Array): void {
        this.config = { codec, description, optimizeForLatency: true };
        this.rebuildDecoder();
    }

    private createDecoder(): VideoDecoder {
        return new VideoDecoder({
            output: (frame) => this.onOutput(frame),
            error: (error: DOMException) => {
                console.error(`[${this.name}]`, error);
                // Wait for the next keyframe and rebuild there; deltas after an error only
                // produce more errors.
                this.needsResync = true;
                this.emit('decoder-error' as never, error as never);
            },
        });
    }

    private rebuildDecoder(): void {
        if (this.decoder && this.decoder.state !== 'closed') {
            try {
                this.decoder.close();
            } catch {
                // Already closed by a fatal error.
            }
        }
        this.decoder = this.createDecoder();
        if (this.config) {
            this.decoder.configure(this.config);
        }
        this.gotKey = false;
        this.needsResync = false;
    }

    private onOutput(frame: VideoFrame): void {
        const width = frame.displayWidth || frame.codedWidth;
        const height = frame.displayHeight || frame.codedHeight;
        if (!this.frameSize || this.frameSize.width !== width || this.frameSize.height !== height) {
            this.frameSize = new Size(width, height);
            this.applyFrameSize(width, height);
        }
        this.receivedFirstFrame = true;
        this.onFrameDecoded(width, height, frame);
    }

    /**
     * Rotation or a resolution collapse under motion changes the picture size mid-stream. The
     * canvas follows the picture; the touch layer follows the canvas through ScreenInfo.
     */
    private applyFrameSize(width: number, height: number): void {
        const screenInfo = new ScreenInfo(new Rect(0, 0, width, height), new Size(width, height), 0);
        this.emit('input-video-resize', screenInfo);
        super.setScreenInfo(screenInfo);
        this.initCanvas(width, height);
    }

    public setScreenInfo(screenInfo: ScreenInfo): void {
        // The base class clears queued frames on every ScreenInfo; ours only changes when the
        // picture does, which `applyFrameSize` already handles without dropping the queue.
        super.setScreenInfo(screenInfo);
    }

    /** `frame` is `[type][AU]` as delivered by the server. */
    public pushFrame(frame: Uint8Array): void {
        if (this.getState() === BaseCanvasBasedPlayer.STATE.PAUSED) {
            this.play();
        }
        this.inputBytes.push({ bytes: frame.byteLength, timestamp: Date.now() });
        this.decode(frame);
    }

    protected decode(frame: Uint8Array): void {
        if (!this.decoder || !this.config || frame.length < 2) {
            return;
        }
        const type = frame[0];
        const isKey = type === COREDEVICE_FRAME_KEY || type === COREDEVICE_FRAME_RESET_KEY;
        if (type === COREDEVICE_FRAME_RESET_KEY || (isKey && this.needsResync)) {
            this.rebuildDecoder();
        }
        if (isKey) {
            this.gotKey = true;
        } else if (type !== COREDEVICE_FRAME_DELTA || !this.gotKey || this.needsResync) {
            return;
        }
        if (this.decoder.state !== 'configured') {
            this.rebuildDecoder();
            if (!isKey) {
                this.needsResync = true;
                return;
            }
        }
        try {
            this.decoder.decode(
                new EncodedVideoChunk({
                    type: isKey ? 'key' : 'delta',
                    timestamp: this.timestamp,
                    data: frame.subarray(1),
                }),
            );
            this.timestamp += 16666;
        } catch (error) {
            console.error(`[${this.name}]`, error);
            this.needsResync = true;
        }
    }

    protected drawDecoded = (): void => {
        const data = this.decodedFrames.shift();
        if (data) {
            const frame: VideoFrame = data.frame;
            try {
                this.context.drawImage(frame, 0, 0, this.tag.width, this.tag.height);
            } finally {
                frame.close();
            }
        }
        if (this.decodedFrames.length) {
            this.animationFrameId = requestAnimationFrame(this.drawDecoded);
        } else {
            this.animationFrameId = undefined;
        }
    };

    protected dropFrame(frame: VideoFrame): void {
        frame.close();
    }

    public stop(): void {
        super.stop();
        if (this.decoder && this.decoder.state !== 'closed') {
            try {
                this.decoder.close();
            } catch {
                // Already closed.
            }
        }
        this.decoder = undefined;
        let data = this.decodedFrames.shift();
        while (data) {
            this.dropFrame(data.frame);
            data = this.decodedFrames.shift();
        }
    }
}
