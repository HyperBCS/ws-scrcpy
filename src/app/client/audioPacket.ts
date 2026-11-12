import {
    AUDIO_CHANNELS,
    AUDIO_MAGIC,
    AUDIO_PACKET_HEADER_SIZE,
    AUDIO_SAMPLE_RATE,
    AudioMetadata,
    AudioPacketKind,
} from '../../common/AudioProtocol';

/**
 * One decoded-audio-ready chunk. `config` marks the (at most one, but possibly repeated after a
 * server restart) packet that carries the Opus decoder's `description` bytes rather than audio
 * samples - see Broadcast.emitAudioFrame() on the server and AudioPlayer.pushFrame() on the client.
 */
export type AudioFrame = {
    config: boolean;
    data: Uint8Array;
    // Presentation timestamp in microseconds; absent on legacy v1 gateways.
    timestamp?: number;
};

export type ParsedAudioPacket = { kind: 'metadata'; metadata: AudioMetadata } | { kind: 'frame'; frame: AudioFrame };

export const AUDIO_MAGIC_BYTES = new TextEncoder().encode(AUDIO_MAGIC);
// The envelope of gateways older than `scrcpy_audio_2`: magic(14) flag(1, 1 = config) payload,
// with no timestamp and no metadata. Only the Android stream can carry it. Like every magic on
// that socket it is 14 bytes long; `StreamReceiver` tells them apart by that.
export const LEGACY_AUDIO_MAGIC_BYTES = new TextEncoder().encode('scrcpy_audio_1');

/** Metadata that an invalid packet degrades to, so a bad audio frame can never take video down. */
export function audioErrorMetadata(error: unknown): AudioMetadata {
    return {
        status: 'error',
        sampleRate: AUDIO_SAMPLE_RATE,
        channels: AUDIO_CHANNELS,
        message: error instanceof Error ? error.message : 'Invalid audio packet.',
    };
}

/**
 * Decodes one `scrcpy_audio_2` envelope (`magic(14) kind(1) timestampUs(8 BE) payload`) starting
 * at `offset`. Shared by the Android stream receiver and the iOS CoreDevice receiver, which
 * carries the same envelope behind its own frame-type byte. Throws on malformed input.
 */
export function parseAudioPacket(packet: ArrayBuffer, offset = 0): ParsedAudioPacket {
    if (packet.byteLength - offset < AUDIO_PACKET_HEADER_SIZE) {
        throw Error('Truncated audio packet.');
    }
    const view = new DataView(packet, offset);
    const kind = view.getUint8(AUDIO_MAGIC_BYTES.length);
    const timestampOffset = AUDIO_MAGIC_BYTES.length + 1;
    const timestamp = view.getUint32(timestampOffset) * 0x100000000 + view.getUint32(timestampOffset + 4);
    if (!Number.isSafeInteger(timestamp)) {
        throw Error('Invalid audio timestamp.');
    }
    const data = new Uint8Array(packet, offset + AUDIO_PACKET_HEADER_SIZE);
    if (kind === AudioPacketKind.METADATA) {
        const metadata = JSON.parse(new TextDecoder().decode(data)) as AudioMetadata;
        if (
            !metadata ||
            !['pending', 'ready', 'disabled', 'error'].includes(metadata.status) ||
            !Number.isFinite(metadata.sampleRate) ||
            !Number.isFinite(metadata.channels) ||
            (metadata.codec !== undefined && metadata.codec !== 'raw' && metadata.codec !== 'opus') ||
            (metadata.status === 'ready' && !metadata.codec) ||
            (metadata.message !== undefined && typeof metadata.message !== 'string')
        ) {
            throw Error('Invalid audio stream metadata.');
        }
        return { kind: 'metadata', metadata };
    }
    if (kind === AudioPacketKind.SAMPLE || kind === AudioPacketKind.CONFIG) {
        return { kind: 'frame', frame: { config: kind === AudioPacketKind.CONFIG, timestamp, data } };
    }
    throw Error('Unknown audio packet type.');
}

/** Where `AudioEnvelopeReader` delivers what it read: the receiver's `audio` and `audioMetadata` events. */
export interface AudioEnvelopeSink {
    audio(frame: AudioFrame): void;
    metadata(metadata: AudioMetadata): void;
}

/**
 * The audio half of a stream socket, one for each receiver, Android and iPhone alike. Each
 * WebSocket message holds one whole envelope; nothing is joined across messages. It keeps the
 * latest metadata and decoder config for a player that starts later (`state/audio.ts`). A bad
 * packet becomes an error status with the decoder config dropped, so it never reaches the video
 * decoder or the controls.
 */
export class AudioEnvelopeReader {
    private metadata?: AudioMetadata;
    private config?: AudioFrame;

    constructor(private readonly sink: AudioEnvelopeSink) {}

    /** One `scrcpy_audio_2` envelope at `offset`: 0 on Android, 1 behind the iPhone's frame-type byte. */
    public read(packet: ArrayBuffer, offset = 0): void {
        try {
            const parsed = parseAudioPacket(packet, offset);
            if (parsed.kind === 'metadata') {
                const { metadata } = parsed;
                // A config belongs to one codec of a running capture.
                if (metadata.status !== 'ready' || metadata.codec !== this.metadata?.codec) {
                    this.config = undefined;
                }
                this.metadata = metadata;
                this.sink.metadata(metadata);
            } else {
                this.frame(parsed.frame);
            }
        } catch (error) {
            this.config = undefined;
            this.metadata = audioErrorMetadata(error);
            this.sink.metadata(this.metadata);
        }
    }

    /** One `scrcpy_audio_1` packet. A packet with no flag byte is reported as truncated. */
    public readLegacy(packet: ArrayBuffer): void {
        const flagOffset = LEGACY_AUDIO_MAGIC_BYTES.length;
        if (packet.byteLength <= flagOffset) {
            this.read(packet);
            return;
        }
        const config = new Uint8Array(packet, flagOffset, 1)[0] === 1;
        this.frame({ config, data: new Uint8Array(packet, flagOffset + 1) });
    }

    /** The socket closed: the next session may run another capture, so its audio state starts over. */
    public reset(): void {
        this.metadata = undefined;
        this.config = undefined;
    }

    public getMetadata(): AudioMetadata | undefined {
        return this.metadata;
    }

    public getConfig(): AudioFrame | undefined {
        return this.config;
    }

    private frame(frame: AudioFrame): void {
        if (frame.config) {
            this.config = frame;
        }
        this.sink.audio(frame);
    }
}
