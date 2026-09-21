import { BaseCanvasBasedPlayer } from './BaseCanvasBasedPlayer';
import VideoSettings from '../VideoSettings';
import Size from '../Size';
import { DisplayInfo } from '../DisplayInfo';
import H264Parser from 'h264-converter/dist/h264-parser';
import NALU from 'h264-converter/dist/util/NALU';
import ScreenInfo from '../ScreenInfo';
import Rect from '../Rect';

type ParametersSubSet = {
    codec: string;
    width: number;
    height: number;
};

function toHex(value: number) {
    return value.toString(16).padStart(2, '0').toUpperCase();
}

export class WebCodecsPlayer extends BaseCanvasBasedPlayer {
    public static readonly storageKeyPrefix = 'WebCodecsPlayer';
    public static readonly playerFullName = 'WebCodecs';
    public static readonly playerCodeName = 'webcodecs';

    private static readonly MAX_DECODER_ERRORS = 3;
    private static readonly DECODER_ERROR_WINDOW_MS = 5000;

    public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        lockedVideoOrientation: -1,
        bitrate: 524288,
        maxFps: 24,
        iFrameInterval: 5,
        bounds: new Size(480, 480),
        sendFrameMeta: false,
    });

    public static isSupported(): boolean {
        if (typeof VideoDecoder !== 'function' || typeof VideoDecoder.isConfigSupported !== 'function') {
            return false;
        }

        // FIXME: verify support
        // const result = await VideoDecoder.isConfigSupported();
        return true;
    }

    private static parseSPS(data: Uint8Array): ParametersSubSet {
        const {
            profile_idc,
            constraint_set_flags,
            level_idc,
            pic_width_in_mbs_minus1,
            frame_crop_left_offset,
            frame_crop_right_offset,
            frame_mbs_only_flag,
            pic_height_in_map_units_minus1,
            frame_crop_top_offset,
            frame_crop_bottom_offset,
            sar,
        } = H264Parser.parseSPS(data);

        const sarScale = sar[0] / sar[1];
        const codec = `avc1.${[profile_idc, constraint_set_flags, level_idc].map(toHex).join('')}`;
        const width = Math.ceil(
            ((pic_width_in_mbs_minus1 + 1) * 16 - frame_crop_left_offset * 2 - frame_crop_right_offset * 2) * sarScale,
        );
        const height =
            (2 - frame_mbs_only_flag) * (pic_height_in_map_units_minus1 + 1) * 16 -
            (frame_mbs_only_flag ? 2 : 4) * (frame_crop_top_offset + frame_crop_bottom_offset);
        return { codec, width, height };
    }

    public readonly supportsScreenshot = true;
    private context: CanvasRenderingContext2D;
    private decoder: VideoDecoder;
    private buffer: ArrayBufferLike | undefined;
    private hadIDR = false;
    /** Set after a decoder reset: drop NALUs until the stream resynchronises on an SPS. */
    private waitingForSPS = false;
    private bufferedSPS = false;
    private bufferedPPS = false;
    private decoderErrors: number[] = [];

    constructor(udid: string, displayInfo?: DisplayInfo, name = WebCodecsPlayer.playerFullName) {
        super(udid, displayInfo, name, WebCodecsPlayer.storageKeyPrefix);
        const context = this.tag.getContext('2d');
        if (!context) {
            throw Error('Failed to get 2d context from canvas');
        }
        this.context = context;
        this.decoder = this.createDecoder();
    }

    private createDecoder(): VideoDecoder {
        return new VideoDecoder({
            output: (frame) => {
                if (!this.receivedFirstFrame) {
                    // `onFrameDecoded()` discards frames decoded with previous video settings.
                    // A `VideoFrame` holds a media resource, so it must be released explicitly.
                    frame.close();
                    return;
                }
                this.onFrameDecoded(0, 0, frame);
            },
            error: (error: DOMException) => {
                console.error(`[${this.name}]`, error, `code: ${error.code}`);
                this.onDecoderError(error);
            },
        });
    }

    private onDecoderError(error: DOMException): void {
        const now = Date.now();
        this.decoderErrors.push(now);
        while (this.decoderErrors.length && this.decoderErrors[0] < now - WebCodecsPlayer.DECODER_ERROR_WINDOW_MS) {
            this.decoderErrors.shift();
        }
        if (this.decoderErrors.length > WebCodecsPlayer.MAX_DECODER_ERRORS) {
            console.error(
                `[${this.name}]`,
                `Decoder failed ${this.decoderErrors.length} times in ` +
                    `${WebCodecsPlayer.DECODER_ERROR_WINDOW_MS}ms, giving up`,
                error,
            );
            this.stop();
            return;
        }
        this.resetDecoder();
    }

    private resetDecoder(): void {
        // A fatal error usually closes the decoder before the error callback fires.
        if (this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.releaseDecodedFrames();
        this.clearState();
        this.buffer = undefined;
        this.hadIDR = false;
        this.bufferedSPS = false;
        this.bufferedPPS = false;
        this.waitingForSPS = true;
        this.decoder = this.createDecoder();
        // Rest in PAUSED: `StreamClientScrcpy.onVideo()` calls `play()` on the next incoming
        // frame, and the next SPS + IDR re-configure the fresh decoder.
        this.pause();
    }

    private releaseDecodedFrames(): void {
        let data = this.decodedFrames.shift();
        while (data) {
            this.dropFrame(data.frame);
            data = this.decodedFrames.shift();
        }
    }

    protected addToBuffer(data: Uint8Array): Uint8Array {
        let array: Uint8Array;
        if (this.buffer) {
            array = new Uint8Array(this.buffer.byteLength + data.byteLength);
            array.set(new Uint8Array(this.buffer));
            array.set(new Uint8Array(data), this.buffer.byteLength);
        } else {
            array = data;
        }
        this.buffer = array.buffer;
        return array;
    }

    protected scaleCanvas(width: number, height: number): void {
        const videoSize = new Size(width, height);
        let scale = 1;
        if (this.bounds && !this.bounds.intersect(videoSize).equals(videoSize)) {
            scale = Math.min(this.bounds.w / width, this.bounds.h / height);
        }
        const w = width * scale;
        const h = height * scale;
        const screenInfo = new ScreenInfo(new Rect(0, 0, width, height), new Size(w, h), 0);
        this.emit('input-video-resize', screenInfo);
        this.setScreenInfo(screenInfo);

        // FIXME: canvas was initialized from `.setScreenInfo()` call above, but with wrong values
        this.initCanvas(width, height);
        if (scale !== 1) {
            this.tag.style.transform = `scale(${scale.toFixed(4)})`;
        } else {
            this.tag.style.transform = ``;
        }
        this.tag.style.transformOrigin = 'top left';
    }

    protected decode(data: Uint8Array): void {
        if (!data || data.length < 4) {
            return;
        }
        const type = data[4] & 31;
        const isIDR = type === NALU.IDR;

        if (this.waitingForSPS) {
            // After a decoder reset the stream must restart at an SPS. Anything before it is
            // undecodable without the lost parameter sets, and buffering it would both grow
            // unboundedly and prepend stale NALUs to the recovery keyframe.
            if (type !== NALU.SPS) {
                return;
            }
            this.buffer = undefined;
            this.waitingForSPS = false;
        }

        if (type === NALU.SPS) {
            const { codec, width, height } = WebCodecsPlayer.parseSPS(data.subarray(4));
            this.scaleCanvas(width, height);
            const config: VideoDecoderConfig = {
                codec,
                optimizeForLatency: true,
            } as VideoDecoderConfig;
            this.decoder.configure(config);
            this.bufferedSPS = true;
            this.addToBuffer(data);
            this.hadIDR = false;
            return;
        } else if (type === NALU.PPS) {
            this.bufferedPPS = true;
            this.addToBuffer(data);
            return;
        } else if (type === NALU.SEI) {
            // Drop a lone SEI that arrives before its SPS/PPS — it carries no decodable
            // picture data and would otherwise be flushed into the decoder unpaired.
            if (!this.bufferedSPS || !this.bufferedPPS) {
                return;
            }
        }
        const array = this.addToBuffer(data);
        this.hadIDR = this.hadIDR || isIDR;
        if (array && this.decoder.state === 'configured' && this.hadIDR) {
            this.buffer = undefined;
            this.bufferedPPS = false;
            this.bufferedSPS = false;
            this.decoder.decode(
                new EncodedVideoChunk({
                    type: 'key',
                    timestamp: 0,
                    data: array.buffer,
                }),
            );
            return;
        }
    }

    protected drawDecoded = (): void => {
        if (this.receivedFirstFrame) {
            const data = this.decodedFrames.shift();
            if (data) {
                const frame: VideoFrame = data.frame;
                try {
                    this.context.drawImage(frame, 0, 0);
                } finally {
                    frame.close();
                }
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

    public getFitToScreenStatus(): boolean {
        return false;
    }

    public getPreferredVideoSetting(): VideoSettings {
        return WebCodecsPlayer.preferredVideoSettings;
    }

    public loadVideoSettings(): VideoSettings {
        return WebCodecsPlayer.loadVideoSettings(this.udid, this.displayInfo);
    }

    protected needScreenInfoBeforePlay(): boolean {
        return false;
    }

    public stop(): void {
        super.stop();
        if (this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.releaseDecodedFrames();
    }
}
