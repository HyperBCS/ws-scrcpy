import { signal } from '@preact/signals';
import type { AudioFrame } from '../client/StreamReceiver';
import type { AudioPlaybackStats, AudioPlaybackStatus } from '../state/audio';
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, AudioMetadata } from '../../common/AudioProtocol';
import { acquirePlaybackAudioSession } from './PlaybackAudioSession';

const TARGET_BUFFER_SECONDS = 0.04;
const MAX_BUFFER_SECONDS = 0.2;
const MAX_DECODE_QUEUE = 8;
const VOLUME_STORAGE_KEY = 'ws_scrcpy_audio_volume';

/**
 * How much sound to hold before playing it. The default suits stock scrcpy, which delivers
 * packets evenly; a source that arrives in bursts (the iOS path hands over ~80 ms at a time)
 * needs a target above its burst period or it underruns on every burst, which is heard as
 * static.
 */
export interface AudioBufferProfile {
    targetSeconds: number;
    maxSeconds: number;
}

function loadVolume(): number {
    try {
        const raw = globalThis.localStorage?.getItem(VOLUME_STORAGE_KEY);
        // `Number(null)` is 0: an unset key must not start a new browser silent.
        const stored = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
        if (Number.isFinite(stored) && stored >= 0 && stored <= 1) {
            return stored;
        }
    } catch {
        // Blocked storage: full volume, like before the slider existed.
    }
    return 1;
}
const OPUS_HEAD = new TextEncoder().encode('OpusHead');

function getAudioContextClass(): typeof AudioContext | undefined {
    return (
        globalThis.AudioContext ??
        (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    );
}

// WebCodecs expects the Opus identification header, not Android's AOPUSHDR/CSD wrapper.
// Stock scrcpy strips that wrapper; tolerate it from older gateways without passing junk on.
export function extractOpusHead(data: Uint8Array): Uint8Array | undefined {
    for (let offset = 0; offset <= Math.min(64, data.length - 19); offset++) {
        if (!OPUS_HEAD.every((value, index) => data[offset + index] === value)) {
            continue;
        }
        const channels = data[offset + 9];
        const length = data[offset + 18] === 0 ? 19 : 21 + channels;
        if (channels < 1 || channels > 8 || offset + length > data.length) {
            return;
        }
        return new Uint8Array(data.subarray(offset, offset + length));
    }
    return;
}

/**
 * Raw scrcpy PCM uses Web Audio directly, including on HTTP phone browsers without WebCodecs.
 * Opus is an optional bandwidth-saving path. No samples are decoded or retained until Listen
 * unlocks the AudioContext, and mute/background/disconnect always discard queued sound.
 */
export class AudioPlayer {
    public readonly status = signal<AudioPlaybackStatus>({
        state: 'muted',
        message: 'Tap Listen to hear this device.',
    });
    private context?: AudioContext;
    private gainNode?: GainNode;
    private decoder?: AudioDecoder;
    private decoderGeneration = 0;
    private description?: Uint8Array;
    private metadata?: AudioMetadata;
    private sources = new Set<AudioBufferSourceNode>();
    private nextStartTime = 0;
    private nextTimestamp?: number;
    private previousTimestamp?: number;
    private syntheticTimestamp = 0;
    private useDeviceTimestamps = false;
    private muted = true;
    private connected = true;
    private stopped = false;
    private played = false;
    private playbackError?: string;
    private playbackBlocked = false;
    private codecUnsupported = false;
    private receivedPackets = 0;
    private scheduledFrames = 0;
    private droppedPackets = 0;
    private underruns = 0;
    private lastPeak = 0;
    private releasePlaybackCategory?: () => void;
    private playAttempt = 0;
    private volume = loadVolume();
    private readonly targetBufferSeconds: number;
    private readonly maxBufferSeconds: number;

    public static isSupported(): boolean {
        return typeof getAudioContextClass() === 'function';
    }

    constructor(profile: Partial<AudioBufferProfile> = {}) {
        this.targetBufferSeconds = profile.targetSeconds ?? TARGET_BUFFER_SECONDS;
        this.maxBufferSeconds = Math.max(profile.maxSeconds ?? MAX_BUFFER_SECONDS, this.targetBufferSeconds * 2);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this.onVisibilityChange);
        }
        this.refreshStatus();
    }

    public getVolume(): number {
        return this.volume;
    }

    /** 0..1, remembered per browser; applied on top of mute, which stays a separate state. */
    public setVolume(volume: number): void {
        const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
        this.volume = clamped;
        try {
            globalThis.localStorage?.setItem(VOLUME_STORAGE_KEY, String(clamped));
        } catch {
            // Still applies for this session.
        }
        if (!this.muted) {
            this.applyGain(clamped);
        }
    }

    private applyGain(value: number): void {
        const gain = this.gainNode?.gain;
        if (!gain || !this.context) {
            return;
        }
        // A short ramp instead of a step: a jump in gain mid-sample is audible as a click.
        if (typeof gain.setTargetAtTime === 'function' && typeof gain.cancelScheduledValues === 'function') {
            gain.cancelScheduledValues(this.context.currentTime);
            gain.setTargetAtTime(value, this.context.currentTime, 0.015);
        } else {
            gain.value = value;
        }
    }

    public isSupported(): boolean {
        return AudioPlayer.isSupported();
    }
    public isMuted(): boolean {
        return this.muted;
    }
    public getStats(): AudioPlaybackStats {
        return {
            receivedPackets: this.receivedPackets,
            scheduledFrames: this.scheduledFrames,
            droppedPackets: this.droppedPackets,
            underruns: this.underruns,
            bufferedMs: this.context ? Math.max(0, this.nextStartTime - this.context.currentTime) * 1000 : 0,
            lastPeak: this.lastPeak,
        };
    }

    public setConnected(connected: boolean): void {
        if (this.stopped) {
            return;
        }
        this.connected = connected;
        if (!connected) {
            this.clearPipeline();
            this.metadata = undefined;
            this.description = undefined;
            this.playbackError = undefined;
            this.codecUnsupported = false;
        }
        this.refreshStatus();
    }

    public setMetadata(metadata: AudioMetadata): void {
        if (this.stopped) {
            return;
        }
        if (metadata.sampleRate !== AUDIO_SAMPLE_RATE || metadata.channels !== AUDIO_CHANNELS) {
            this.fail('This device sent an unsupported audio format. Reconnect the stream.');
            return;
        }
        const changed = metadata.codec !== this.metadata?.codec || metadata.status !== this.metadata?.status;
        if (changed) {
            this.clearPipeline();
            this.description = undefined;
            this.playbackError = undefined;
        }
        this.metadata = metadata;
        this.codecUnsupported =
            metadata.codec === 'opus' &&
            (typeof AudioDecoder !== 'function' || typeof EncodedAudioChunk !== 'function');
        this.refreshStatus();
    }

    public pushFrame(frame: AudioFrame): void {
        if (this.stopped) {
            return;
        }
        if (!this.connected && !frame.config) {
            this.receivedPackets++;
            this.droppedPackets++;
            return;
        }
        // Legacy scrcpy_audio_1 gateways sent Opus without metadata.
        if (!this.metadata) {
            this.setMetadata({
                status: 'ready',
                codec: 'opus',
                sampleRate: AUDIO_SAMPLE_RATE,
                channels: AUDIO_CHANNELS,
            });
        }
        if (frame.config) {
            this.clearPipeline();
            this.description = extractOpusHead(frame.data);
            this.playbackError = undefined;
            this.refreshStatus();
            return;
        }
        this.receivedPackets++;
        if (!this.canPlay() || this.metadata?.status !== 'ready' || this.playbackError || this.codecUnsupported) {
            this.droppedPackets++;
            return;
        }
        if (this.metadata.codec === 'raw') {
            this.playPcm(frame);
        } else if (this.metadata.codec === 'opus') {
            this.decodeOpus(frame);
        }
    }

    private canPlay(): boolean {
        return (
            !this.stopped &&
            this.connected &&
            !this.muted &&
            this.context?.state === 'running' &&
            !(typeof document !== 'undefined' && document.hidden)
        );
    }

    private playPcm(frame: AudioFrame): void {
        if (!this.context) {
            return;
        }
        const bytesPerFrame = AUDIO_CHANNELS * 2;
        const frames = frame.data.byteLength / bytesPerFrame;
        if (!Number.isInteger(frames) || frames <= 0 || frames > AUDIO_SAMPLE_RATE * this.maxBufferSeconds) {
            this.droppedPackets++;
            this.fail('Received malformed PCM audio. Reconnect the stream.');
            return;
        }
        try {
            const buffer = this.context.createBuffer(AUDIO_CHANNELS, frames, AUDIO_SAMPLE_RATE);
            // DataView handles both byte order and views that start at an odd byte offset.
            const view = new DataView(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
            let peak = 0;
            for (let channel = 0; channel < AUDIO_CHANNELS; channel++) {
                const samples = buffer.getChannelData(channel);
                for (let index = 0; index < frames; index++) {
                    const sample = view.getInt16((index * AUDIO_CHANNELS + channel) * 2, true) / 32768;
                    samples[index] = sample;
                    peak = Math.max(peak, Math.abs(sample));
                }
            }
            this.schedule(buffer, frame.timestamp, peak);
        } catch (error) {
            this.fail(`Could not play device audio: ${this.errorMessage(error)}`);
        }
    }

    private decodeOpus(frame: AudioFrame): void {
        if (this.decoder && this.decoder.decodeQueueSize >= MAX_DECODE_QUEUE) {
            // Drop decoder work already queued, then continue from the newest independent packet.
            this.droppedPackets += this.decoder.decodeQueueSize;
            this.closeDecoder();
            this.clearScheduled();
        }
        if (!this.decoder || this.decoder.state !== 'configured') {
            if (!this.configureDecoder()) {
                return;
            }
        }
        try {
            this.useDeviceTimestamps = frame.timestamp !== undefined;
            this.decoder?.decode(
                new EncodedAudioChunk({
                    type: 'key',
                    timestamp: frame.timestamp ?? this.syntheticTimestamp++,
                    data: frame.data,
                }),
            );
        } catch (error) {
            this.fail(`Could not decode audio. Try PCM audio in Settings. ${this.errorMessage(error)}`);
        }
    }

    private configureDecoder(): boolean {
        if (typeof AudioDecoder !== 'function') {
            this.codecUnsupported = true;
            this.refreshStatus();
            return false;
        }
        this.closeDecoder();
        const generation = this.decoderGeneration;
        try {
            const decoder = new AudioDecoder({
                output: (data) => {
                    try {
                        if (generation === this.decoderGeneration && this.canPlay()) {
                            this.playDecoded(data);
                        }
                    } finally {
                        data.close();
                    }
                },
                error: (error) => {
                    if (generation === this.decoderGeneration) {
                        this.fail(`Could not decode audio. Try PCM audio in Settings. ${this.errorMessage(error)}`);
                    }
                },
            });
            this.decoder = decoder;
            const config: AudioDecoderConfig = {
                codec: 'opus',
                sampleRate: AUDIO_SAMPLE_RATE,
                numberOfChannels: AUDIO_CHANNELS,
            };
            if (this.description) {
                config.description = this.description;
            }
            decoder.configure(config);
            return true;
        } catch (error) {
            this.fail(`Compressed audio is unavailable. Choose PCM audio in Settings. ${this.errorMessage(error)}`);
            return false;
        }
    }

    private playDecoded(data: AudioData): void {
        if (
            !this.context ||
            data.numberOfFrames < 1 ||
            data.numberOfChannels < 1 ||
            data.numberOfChannels > 8 ||
            data.numberOfFrames / data.sampleRate > this.maxBufferSeconds
        ) {
            return;
        }
        try {
            const buffer = this.context.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
            let peak = 0;
            for (let channel = 0; channel < data.numberOfChannels; channel++) {
                const samples = new Float32Array(data.numberOfFrames);
                data.copyTo(samples, { planeIndex: channel, format: 'f32-planar' });
                buffer.copyToChannel(samples, channel);
                for (const sample of samples) {
                    peak = Math.max(peak, Math.abs(sample));
                }
            }
            this.schedule(buffer, this.useDeviceTimestamps ? data.timestamp : undefined, peak);
        } catch (error) {
            this.fail(`Could not play decoded audio: ${this.errorMessage(error)}`);
        }
    }

    private schedule(buffer: AudioBuffer, timestamp: number | undefined, peak: number): void {
        if (!this.context || !this.gainNode || !this.canPlay()) {
            return;
        }
        const now = this.context.currentTime;
        if (timestamp !== undefined && this.previousTimestamp !== undefined && timestamp <= this.previousTimestamp) {
            this.droppedPackets++;
            return;
        }
        // Consecutive PCM/decoded chunks form one sample sequence. Capture timestamps wobble
        // slightly: using each timestamp as a source start creates gaps or overlapping sound
        // at every packet boundary, audible as static. Schedule by sample count instead, using
        // timestamps only to recognize a substantial capture discontinuity.
        let startAt = this.nextStartTime;
        const captureGap =
            timestamp !== undefined &&
            this.nextTimestamp !== undefined &&
            Math.abs(timestamp - this.nextTimestamp) > this.maxBufferSeconds * 1_000_000;
        if (captureGap || startAt <= now || startAt + buffer.duration > now + this.maxBufferSeconds) {
            // Restart near live after a real underrun/discontinuity or an excessive delivery
            // burst. Ordinary network/capture jitter leaves the uninterrupted queue intact.
            if (startAt <= now && this.played) {
                this.underruns++;
            }
            this.clearScheduled();
            startAt = now + Math.min(this.targetBufferSeconds, this.maxBufferSeconds - buffer.duration);
        }
        this.previousTimestamp = timestamp;
        this.nextTimestamp = timestamp === undefined ? undefined : timestamp + buffer.duration * 1_000_000;
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gainNode);
        source.onended = () => {
            this.sources.delete(source);
            source.disconnect();
        };
        this.sources.add(source);
        source.start(startAt);
        this.nextStartTime = startAt + buffer.duration;
        this.scheduledFrames += buffer.length;
        this.lastPeak = peak;
        this.played = true;
        this.refreshStatus();
    }

    public play(): void {
        if (this.stopped) {
            return;
        }
        const attempt = ++this.playAttempt;
        this.muted = false;
        this.playbackError = undefined;
        this.playbackBlocked = false;
        this.clearPipeline();
        // Set Safari's media category in the Listen gesture, before creating/resuming Web Audio.
        this.releasePlaybackCategory ??= acquirePlaybackAudioSession();
        if (!this.ensureContext()) {
            this.restorePlaybackCategory();
            this.refreshStatus();
            return;
        }
        if (this.gainNode) {
            this.gainNode.gain.value = this.volume;
        }
        // Call resume synchronously within the gesture, before awaiting anything else.
        this.context
            ?.resume()
            .then(() => {
                if (!this.stopped && attempt === this.playAttempt) {
                    this.refreshStatus();
                }
            })
            .catch((error) => {
                if (!this.stopped && !this.muted && attempt === this.playAttempt) {
                    this.restorePlaybackCategory();
                    this.playbackBlocked = true;
                    this.playbackError = `The browser could not start audio. Tap Listen to try again. ${this.errorMessage(error)}`;
                    this.refreshStatus();
                }
            });
        this.refreshStatus();
    }

    public unmute(): void {
        this.play();
    }

    public mute(): void {
        this.playAttempt++;
        this.muted = true;
        if (this.gainNode) {
            this.gainNode.gain.value = 0;
        }
        this.clearPipeline();
        this.context?.suspend().catch(() => undefined);
        this.restorePlaybackCategory();
        this.refreshStatus();
    }

    private ensureContext(): boolean {
        if (this.context && this.context.state !== 'closed') {
            return true;
        }
        const Context = getAudioContextClass();
        if (!Context) {
            return false;
        }
        try {
            // Let the browser use its hardware sample rate; AudioBuffer handles resampling.
            this.context = new Context({ latencyHint: 'interactive' });
            this.gainNode = this.context.createGain();
            this.gainNode.gain.value = 0;
            this.gainNode.connect(this.context.destination);
            this.context.addEventListener('statechange', this.onContextStateChange);
            return true;
        } catch (error) {
            this.playbackError = `Could not start audio: ${this.errorMessage(error)}`;
            return false;
        }
    }

    private restorePlaybackCategory(): void {
        this.releasePlaybackCategory?.();
        this.releasePlaybackCategory = undefined;
    }

    private onContextStateChange = (): void => {
        if (this.stopped) {
            return;
        }
        if (this.context?.state !== 'running') {
            this.clearPipeline();
        }
        this.refreshStatus();
    };

    private onVisibilityChange = (): void => {
        if (document.hidden) {
            this.clearPipeline();
        }
        this.refreshStatus();
    };

    private closeDecoder(): void {
        this.decoderGeneration++;
        if (this.decoder && this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.decoder = undefined;
    }

    private clearScheduled(): void {
        this.sources.forEach((source) => {
            source.onended = null;
            try {
                source.stop();
            } catch {
                /* An ended source needs only disconnecting. */
            }
            source.disconnect();
        });
        this.sources.clear();
        this.nextStartTime = 0;
        this.nextTimestamp = undefined;
        this.previousTimestamp = undefined;
        this.played = false;
        this.lastPeak = 0;
    }

    private clearPipeline(): void {
        this.closeDecoder();
        this.clearScheduled();
        this.syntheticTimestamp = 0;
    }

    private fail(message: string): void {
        this.clearPipeline();
        this.playbackBlocked = false;
        this.playbackError = message;
        this.refreshStatus();
    }
    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private refreshStatus(): void {
        if (this.stopped) {
            return;
        }
        let state: AudioPlaybackStatus['state'];
        let message: string;
        if (!this.isSupported()) {
            state = 'unsupported';
            message = 'This browser does not support audio playback.';
        } else if (this.metadata?.status === 'error') {
            state = 'error';
            message =
                this.metadata.message || 'The device could not capture audio. Try another audio source in Settings.';
        } else if (this.metadata?.status === 'disabled') {
            state = 'disabled';
            message = this.metadata.message || 'Audio forwarding is off. Enable it in Settings.';
        } else if (this.codecUnsupported) {
            state = 'unsupported';
            message = 'Compressed audio is unavailable in this browser. Choose PCM audio in Settings.';
        } else if (this.playbackError) {
            state = this.playbackBlocked ? 'blocked' : 'error';
            message = this.playbackError;
        } else if (!this.connected) {
            state = 'disconnected';
            message = 'Audio will resume when the screen reconnects.';
        } else if (this.muted) {
            state = 'muted';
            message = 'Tap Listen to hear this device.';
        } else if (this.context?.state !== 'running') {
            state = 'blocked';
            message = 'Tap Listen to allow audio playback in this browser.';
        } else if (typeof document !== 'undefined' && document.hidden) {
            state = 'waiting';
            message = 'Audio pauses while this tab is hidden.';
        } else if (this.played) {
            state = 'playing';
            message = 'Listening to device audio.';
        } else {
            state = 'waiting';
            message =
                this.metadata?.status === 'pending'
                    ? 'Audio is starting on the device…'
                    : 'Waiting for device audio. Start playback on the device.';
        }
        const current = this.status.peek();
        const codec = this.metadata?.codec;
        if (current.state !== state || current.message !== message || current.codec !== codec) {
            this.status.value = { state, message, codec };
        }
    }

    public stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.playAttempt++;
        this.clearPipeline();
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.onVisibilityChange);
        }
        if (this.context) {
            this.context.removeEventListener('statechange', this.onContextStateChange);
            this.context.close().catch(() => undefined);
        }
        this.context = undefined;
        this.gainNode = undefined;
        this.restorePlaybackCategory();
    }
}
