import { BasePlayer } from './BasePlayer';
import VideoSettings from '../VideoSettings';
import Size from '../Size';
import Rect from '../Rect';
import ScreenInfo from '../ScreenInfo';
import { DisplayInfo } from '../DisplayInfo';
import {
    COREDEVICE_FRAME_DELTA,
    COREDEVICE_FRAME_KEY,
    COREDEVICE_FRAME_RESET_KEY,
} from '../../common/CoreDeviceProtocol';
import { buildHevcInitSegment, buildHevcMediaSegment, concat, hevcMimeCandidates, parseHevcSpsSize } from './hevcFmp4';

/**
 * Media Source Extensions fallback for the iOS HEVC stream: the same access units WebCodecs
 * would decode, remuxed into fragmented MP4 and fed to a `<video>` element.
 *
 * Why it exists: Chrome and Edge expose WebCodecs on secure origins only, while `MediaSource`
 * is available over plain http. The bitstream is untouched, so the browser still needs its own
 * HEVC decoder (`MediaSource.isTypeSupported` says whether it has one). Latency is a frame or two
 * behind WebCodecs; `chaseLiveEdge` keeps the element within ~100 ms of the newest sample.
 *
 * Timing: the phone gives no timestamps, so the buffer runs in 'sequence' mode and each sample
 * carries the wall-clock gap since the previous one -- the sum tracks real time, which is all
 * live-edge chasing needs.
 */
export class MseHevcPlayer extends BasePlayer {
    public static readonly storageKeyPrefix = 'MseHevcPlayer';
    public static readonly playerFullName = 'MSE HEVC';
    public static readonly playerCodeName = 'mse';
    public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        lockedVideoOrientation: -1,
        bitrate: 6000000,
        maxFps: 60,
        iFrameInterval: 0,
        bounds: new Size(0, 0),
        sendFrameMeta: false,
    });
    /** Seek back to this far behind the newest sample when the element falls further behind. */
    private static readonly MAX_BEHIND_S = 0.25;
    private static readonly TARGET_BEHIND_S = 0.06;
    /** Keep this much history in the SourceBuffer; older ranges are removed. */
    private static readonly KEEP_S = 8;
    private static readonly MIN_DURATION_US = 1_000;
    private static readonly MAX_DURATION_US = 500_000;
    private static readonly DEFAULT_DURATION_US = 50_000;

    public static isSupported(): boolean {
        return typeof MediaSource === 'function' && typeof MediaSource.isTypeSupported === 'function';
    }

    /** The mime type this browser will accept for the announced codec, or `undefined`. */
    public static mimeFor(codec: string): { mime: string; sampleEntry: 'hev1' | 'hvc1' } | undefined {
        if (!this.isSupported()) {
            return undefined;
        }
        return hevcMimeCandidates(codec).find((candidate) => {
            try {
                return MediaSource.isTypeSupported(candidate.mime);
            } catch {
                return false;
            }
        });
    }

    public static createElement(): HTMLVideoElement {
        const tag = document.createElement('video');
        tag.muted = true;
        tag.autoplay = true;
        tag.playsInline = true;
        tag.setAttribute('muted', 'muted');
        tag.setAttribute('autoplay', 'autoplay');
        tag.setAttribute('playsinline', '');
        tag.className = 'video-layer';
        return tag;
    }

    public readonly supportsScreenshot = true;
    declare protected readonly tag: HTMLVideoElement;
    private mediaSource?: MediaSource;
    private sourceBuffer?: SourceBuffer;
    private objectUrl?: string;
    private mime?: { mime: string; sampleEntry: 'hev1' | 'hvc1' };
    private initSegment?: Uint8Array;
    private pending: Uint8Array[] = [];
    private gotKey = false;
    private needsResync = false;
    private sequenceNumber = 1;
    private decodeTime = 0;
    private lastArrival?: number;
    private frameSize?: Size;
    private chaseTimer?: ReturnType<typeof setInterval>;
    private decodedFrames = 0;

    constructor(udid: string, displayInfo?: DisplayInfo, name = MseHevcPlayer.playerFullName) {
        super(udid, displayInfo, name, MseHevcPlayer.storageKeyPrefix, MseHevcPlayer.createElement());
        this.tag.addEventListener('resize', this.onVideoResize);
        this.tag.addEventListener('loadedmetadata', this.onVideoResize);
        this.tag.addEventListener('error', this.onVideoError);
    }

    public getPreferredVideoSetting(): VideoSettings {
        return MseHevcPlayer.preferredVideoSettings;
    }

    public getFitToScreenStatus(): boolean {
        return true;
    }

    public loadVideoSettings(): VideoSettings {
        return MseHevcPlayer.preferredVideoSettings;
    }

    protected needScreenInfoBeforePlay(): boolean {
        return false;
    }

    protected calculateMomentumStats(): void {
        // Frame statistics are not tracked for the MSE fallback.
    }

    /** (Re)creates the MediaSource for a codec; safe to call again after a reconnect. */
    public configure(codec: string, description: Uint8Array): void {
        const mime = MseHevcPlayer.mimeFor(codec);
        if (!mime) {
            throw new Error(`MediaSource cannot play ${codec}`);
        }
        this.mime = mime;
        const size = parseHevcSpsSize(description);
        this.initSegment = buildHevcInitSegment({
            sampleEntry: mime.sampleEntry,
            hvcC: description,
            width: size?.width ?? 0,
            height: size?.height ?? 0,
        });
        this.resetSource();
    }

    private resetSource(): void {
        this.teardownSource();
        this.gotKey = false;
        this.needsResync = false;
        this.pending = [];
        this.sequenceNumber = 1;
        this.decodeTime = 0;
        this.lastArrival = undefined;
        const mediaSource = new MediaSource();
        this.mediaSource = mediaSource;
        mediaSource.addEventListener('sourceopen', this.onSourceOpen);
        this.objectUrl = URL.createObjectURL(mediaSource);
        this.tag.src = this.objectUrl;
    }

    private onSourceOpen = (): void => {
        const mediaSource = this.mediaSource;
        if (!mediaSource || mediaSource.readyState !== 'open' || !this.mime || !this.initSegment) {
            return;
        }
        if (this.sourceBuffer) {
            return;
        }
        try {
            const sourceBuffer = mediaSource.addSourceBuffer(this.mime.mime);
            sourceBuffer.mode = 'sequence';
            sourceBuffer.addEventListener('updateend', this.onUpdateEnd);
            sourceBuffer.addEventListener('error', this.onVideoError);
            this.sourceBuffer = sourceBuffer;
            this.enqueue(this.initSegment);
            this.startChasing();
        } catch (error) {
            this.emit('decoder-error' as never, error as never);
        }
    };

    private onUpdateEnd = (): void => {
        this.flush();
        this.trimHistory();
    };

    private enqueue(segment: Uint8Array): void {
        this.pending.push(segment);
        this.flush();
    }

    private flush(): void {
        const sourceBuffer = this.sourceBuffer;
        if (!sourceBuffer || sourceBuffer.updating || !this.pending.length) {
            return;
        }
        if (this.mediaSource?.readyState !== 'open') {
            return;
        }
        const batch = this.pending.length === 1 ? this.pending[0] : concat(this.pending);
        this.pending = [];
        try {
            sourceBuffer.appendBuffer(batch as unknown as ArrayBufferView<ArrayBuffer>);
        } catch (error) {
            if ((error as DOMException).name === 'QuotaExceededError') {
                // Drop history and retry on the next update; the live edge is what matters.
                this.pending.unshift(batch);
                this.trimHistory(true);
                return;
            }
            console.error(`[${this.name}]`, error);
            this.emit('decoder-error' as never, error as never);
        }
    }

    /** `frame` is `[type][AU]` as delivered by the server. */
    public pushFrame(frame: Uint8Array): void {
        if (this.getState() === BasePlayer.STATE.PAUSED) {
            this.play();
        }
        super.pushFrame(frame);
        if (!this.initSegment || frame.length < 2) {
            return;
        }
        const type = frame[0];
        const accessUnit = frame.subarray(1);
        const isKey = type === COREDEVICE_FRAME_KEY || type === COREDEVICE_FRAME_RESET_KEY;
        if (type === COREDEVICE_FRAME_RESET_KEY || (this.needsResync && isKey)) {
            // Reference state upstream is gone: start a fresh decoder by re-sending the init
            // segment (allowed mid-stream in 'sequence' mode) before this key frame.
            this.needsResync = false;
            this.gotKey = false;
            this.enqueue(this.initSegment);
        }
        if (!this.gotKey) {
            if (!isKey) {
                return; // a delta without its key frame only produces garbage
            }
            this.gotKey = true;
        } else if (type !== COREDEVICE_FRAME_DELTA && !isKey) {
            return;
        }
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        let duration = MseHevcPlayer.DEFAULT_DURATION_US;
        if (this.lastArrival !== undefined) {
            duration = Math.round((now - this.lastArrival) * 1000);
            duration = Math.min(MseHevcPlayer.MAX_DURATION_US, Math.max(MseHevcPlayer.MIN_DURATION_US, duration));
        }
        this.lastArrival = now;
        const segment = buildHevcMediaSegment({
            accessUnit,
            sequenceNumber: this.sequenceNumber++,
            decodeTime: this.decodeTime,
            duration,
            isKeyFrame: isKey,
        });
        this.decodeTime += duration;
        this.enqueue(segment);
    }

    // ------------------------------------------------------------------ playback upkeep

    private startChasing(): void {
        if (this.chaseTimer) {
            return;
        }
        this.chaseTimer = setInterval(this.chaseLiveEdge, 250);
    }

    private chaseLiveEdge = (): void => {
        const video = this.tag;
        if (!this.sourceBuffer || !video.buffered.length) {
            return;
        }
        const end = video.buffered.end(video.buffered.length - 1);
        const behind = end - video.currentTime;
        if (video.paused && this.getState() === BasePlayer.STATE.PLAYING) {
            video.play().catch(() => undefined);
        }
        if (behind > MseHevcPlayer.MAX_BEHIND_S && !video.seeking) {
            video.currentTime = Math.max(0, end - MseHevcPlayer.TARGET_BEHIND_S);
        }
    };

    private trimHistory(aggressive = false): void {
        const sourceBuffer = this.sourceBuffer;
        const video = this.tag;
        if (!sourceBuffer || sourceBuffer.updating || !video.buffered.length) {
            return;
        }
        const start = video.buffered.start(0);
        const keep = aggressive ? 1 : MseHevcPlayer.KEEP_S;
        const cutoff = video.currentTime - keep;
        if (cutoff > start + 1) {
            try {
                sourceBuffer.remove(start, cutoff);
            } catch {
                // The buffer went away underneath us (source closed); nothing to trim.
            }
        }
    }

    private onVideoResize = (): void => {
        const width = this.tag.videoWidth;
        const height = this.tag.videoHeight;
        if (!width || !height) {
            return;
        }
        this.decodedFrames++;
        if (!this.frameSize || this.frameSize.width !== width || this.frameSize.height !== height) {
            this.frameSize = new Size(width, height);
            const screenInfo = new ScreenInfo(new Rect(0, 0, width, height), new Size(width, height), 0);
            this.emit('input-video-resize', screenInfo);
            super.setScreenInfo(screenInfo);
        }
    };

    private onVideoError = (): void => {
        const error = this.tag.error;
        console.error(`[${this.name}]`, error?.code, error?.message);
        this.emit('decoder-error' as never, (error || new Error('MediaSource error')) as never);
        // The element is dead after a MEDIA_ERR_DECODE; rebuild on the next key frame.
        this.needsResync = true;
        this.resetSource();
    };

    public setScreenInfo(screenInfo: ScreenInfo): void {
        super.setScreenInfo(screenInfo);
    }

    public getImageDataURL(): string {
        const canvas = document.createElement('canvas');
        canvas.width = this.tag.videoWidth || this.tag.clientWidth;
        canvas.height = this.tag.videoHeight || this.tag.clientHeight;
        const context = canvas.getContext('2d');
        if (context) {
            context.drawImage(this.tag, 0, 0, canvas.width, canvas.height);
        }
        return canvas.toDataURL();
    }

    public getDecodedFrameCount(): number {
        return this.decodedFrames;
    }

    // ------------------------------------------------------------------ lifecycle

    public play(): void {
        super.play();
        this.tag.play().catch(() => undefined);
    }

    public pause(): void {
        super.pause();
    }

    private teardownSource(): void {
        if (this.chaseTimer) {
            clearInterval(this.chaseTimer);
            this.chaseTimer = undefined;
        }
        if (this.sourceBuffer) {
            this.sourceBuffer.removeEventListener('updateend', this.onUpdateEnd);
            this.sourceBuffer.removeEventListener('error', this.onVideoError);
            this.sourceBuffer = undefined;
        }
        if (this.mediaSource) {
            this.mediaSource.removeEventListener('sourceopen', this.onSourceOpen);
            if (this.mediaSource.readyState === 'open') {
                try {
                    this.mediaSource.endOfStream();
                } catch {
                    // Already closed.
                }
            }
            this.mediaSource = undefined;
        }
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = undefined;
        }
    }

    public stop(): void {
        super.stop();
        this.teardownSource();
        this.tag.removeEventListener('resize', this.onVideoResize);
        this.tag.removeEventListener('loadedmetadata', this.onVideoResize);
        this.tag.removeEventListener('error', this.onVideoError);
        this.tag.removeAttribute('src');
        this.tag.remove();
        this.touchableCanvas.remove();
    }
}
