/** Versioned browser envelope; stock scrcpy's device-side audio protocol is unchanged. */
export const AUDIO_MAGIC = 'scrcpy_audio_2';
export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;
// magic (14) + packet kind (1) + unsigned big-endian timestamp in microseconds (8).
export const AUDIO_PACKET_HEADER_SIZE = 23;

export enum AudioPacketKind {
    SAMPLE = 0,
    CONFIG = 1,
    METADATA = 2,
}

export type AudioCodec = 'raw' | 'opus';
export type AudioSource = 'output' | 'voice-call-downlink';

export interface AudioMetadata {
    status: 'pending' | 'ready' | 'disabled' | 'error';
    codec?: AudioCodec;
    sampleRate: number;
    channels: number;
    message?: string;
}
