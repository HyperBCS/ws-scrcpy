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
    public static readonly playerFullName = 'WebCodecs';
    public static readonly playerCodeName = 'webcodecs';

    private static readonly MAX_DECODER_ERRORS = 3;
    private static readonly DECODER_ERROR_WINDOW_MS = 5000;
    /** How long a new decoder waits for the stream's own next keyframe before asking for one. */
    private static readonly KEYFRAME_WAIT_MS = 2000;

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
    /**
     * The last parameter sets seen. scrcpy sends them once per encoder session, so a decoder
     * that is rebuilt mid-session has to be configured from this copy.
     */
    private lastConfig?: { codec: string; sps: Uint8Array; pps?: Uint8Array };
    /** Set while a decoder that kept failing is left alone; nothing is decoded meanwhile. */
    private suspended = false;
    private recoveryTimer?: ReturnType<typeof setTimeout>;

    constructor(udid: string, displayInfo?: DisplayInfo, name = WebCodecsPlayer.playerFullName) {
        super(udid, displayInfo, name);
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
        if (this.getState() === WebCodecsPlayer.STATE.STOPPED) {
            return;
        }
        const now = Date.now();
        this.decoderErrors.push(now);
        while (this.decoderErrors.length && this.decoderErrors[0] < now - WebCodecsPlayer.DECODER_ERROR_WINDOW_MS) {
            this.decoderErrors.shift();
        }
        if (this.decoderErrors.length > WebCodecsPlayer.MAX_DECODER_ERRORS) {
            console.error(
                `[${this.name}]`,
                `Decoder failed ${this.decoderErrors.length} times in ` +
                    `${WebCodecsPlayer.DECODER_ERROR_WINDOW_MS}ms, pausing decoding`,
                error,
            );
            // Rebuilding at once would only fail again. Leave the decoder alone for a while,
            // tell the client so it can say why the picture stopped, then start over.
            this.suspended = true;
            this.discardDecoderState();
            this.emit('decoder-error', { message: error.message, recovering: false });
            this.clearRecoveryTimer();
            this.recoveryTimer = setTimeout(() => {
                this.recoveryTimer = undefined;
                this.suspended = false;
                this.decoderErrors = [];
                this.resetDecoder(0);
            }, WebCodecsPlayer.DECODER_ERROR_WINDOW_MS);
            return;
        }
        this.emit('decoder-error', { message: error.message, recovering: true });
        this.resetDecoder(WebCodecsPlayer.KEYFRAME_WAIT_MS);
    }

    private discardDecoderState(): void {
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
    }

    /**
     * Replaces a failed decoder. The stream does not repeat its parameter sets, so the new
     * decoder is configured from the cached ones and decoding resumes at the next keyframe. The
     * canvas keeps the last picture until then. If no keyframe comes within `keyframeWaitMs`
     * the client is asked to get one from the device.
     */
    private resetDecoder(keyframeWaitMs: number): void {
        this.discardDecoderState();
        this.decoder = this.createDecoder();
        const config = this.lastConfig;
        if (config) {
            this.decoder.configure({ codec: config.codec, optimizeForLatency: true } as VideoDecoderConfig);
            this.addToBuffer(config.sps);
            this.bufferedSPS = true;
            if (config.pps) {
                this.addToBuffer(config.pps);
                this.bufferedPPS = true;
            }
            this.waitingForSPS = false;
        } else {
            this.waitingForSPS = true;
        }
        this.clearRecoveryTimer();
        this.recoveryTimer = setTimeout(this.onKeyframeOverdue, keyframeWaitMs);
    }

    private onKeyframeOverdue = (): void => {
        this.recoveryTimer = undefined;
        // A paused player has lost its connection. The next one starts with parameter sets and a
        // keyframe, and a decoder notice would give the wrong reason for the missing picture.
        if (this.hadIDR || this.getState() !== WebCodecsPlayer.STATE.PLAYING) {
            return;
        }
        this.emit('keyframe-request', undefined);
        // One request only: it restarts the encoder for every viewer. If that brings no
        // keyframe either, report it instead of leaving a frozen picture unexplained.
        this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = undefined;
            if (!this.hadIDR && this.getState() === WebCodecsPlayer.STATE.PLAYING) {
                this.emit('decoder-error', { message: 'No keyframe after a decoder reset', recovering: false });
            }
        }, WebCodecsPlayer.KEYFRAME_WAIT_MS * 2);
    };

    private clearRecoveryTimer(): void {
        if (this.recoveryTimer !== undefined) {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = undefined;
        }
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

    /** The canvas takes the picture's own size; CSS scales it to fit the stream area. */
    protected scaleCanvas(width: number, height: number): void {
        const screenInfo = new ScreenInfo(new Rect(0, 0, width, height), new Size(width, height), 0);
        this.emit('input-video-resize', screenInfo);
        this.setScreenInfo(screenInfo);
        this.initCanvas(width, height);
    }

    protected decode(data: Uint8Array): void {
        if (!data || data.length < 4) {
            return;
        }
        const type = data[4] & 31;
        const isIDR = type === NALU.IDR;

        // Copies, because `addToBuffer` hands the array's whole backing buffer to the decoder.
        let sps: ParametersSubSet | undefined;
        if (type === NALU.SPS) {
            sps = WebCodecsPlayer.parseSPS(data.subarray(4));
            this.lastConfig = { codec: sps.codec, sps: data.slice() };
        } else if (type === NALU.PPS && this.lastConfig) {
            this.lastConfig.pps = data.slice();
        }
        if (this.suspended) {
            return;
        }

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

        if (sps) {
            const { codec, width, height } = sps;
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
        } else if (type === NALU.NDR && !this.hadIDR) {
            // Nothing can decode a picture that depends on a keyframe the decoder never had.
            // Buffering it would put stale slices in front of the keyframe that follows a reset.
            return;
        }
        const array = this.addToBuffer(data);
        if (isIDR && !this.hadIDR) {
            this.clearRecoveryTimer();
        }
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

    public getPreferredVideoSetting(): VideoSettings {
        return WebCodecsPlayer.preferredVideoSettings;
    }

    protected needScreenInfoBeforePlay(): boolean {
        return false;
    }

    public stop(): void {
        super.stop();
        this.clearRecoveryTimer();
        if (this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.releaseDecodedFrames();
    }
}
