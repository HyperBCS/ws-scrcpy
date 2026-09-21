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
