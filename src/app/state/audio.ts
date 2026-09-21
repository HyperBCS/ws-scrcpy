import { signal } from '@preact/signals';
import type { ReadonlySignal } from '@preact/signals';
import type { AudioFrame } from '../client/audioPacket';
import type { AudioMetadata } from '../../common/AudioProtocol';

export type AudioPlaybackState =
    'muted' | 'waiting' | 'playing' | 'blocked' | 'disabled' | 'error' | 'unsupported' | 'disconnected';

export interface AudioPlaybackStatus {
    state: AudioPlaybackState;
    message: string;
    codec?: 'raw' | 'opus';
}

export interface AudioPlaybackStats {
    receivedPackets: number;
    scheduledFrames: number;
    droppedPackets: number;
    // Times playback ran dry and restarted near live; each one is an audible gap.
    underruns: number;
    bufferedMs: number;
    lastPeak: number;
}

// The audio implementation stays in its own optional chunk; views read this small handle.
export interface AudioSession {
    readonly status: ReadonlySignal<AudioPlaybackStatus>;
    isSupported(): boolean;
    isMuted(): boolean;
    getStats(): AudioPlaybackStats;
    // Call directly from a tap/click so the browser can unlock AudioContext playback.
    unmute(): void;
    mute(): void;
    // 0..1, remembered per browser, independent of mute.
    getVolume(): number;
    setVolume(volume: number): void;
    stop(): void;
}

export interface AudioSourceEvents {
    audio: AudioFrame;
    audioMetadata: AudioMetadata;
    connected: unknown;
    disconnected: unknown;
}

/**
 * What the player needs from a stream transport: the Android `StreamReceiver` and the iOS
 * `CoreDeviceReceiver` both provide it, so one factory serves both platforms.
 */
export interface AudioSource {
    on<K extends keyof AudioSourceEvents & string>(event: K, listener: (params: AudioSourceEvents[K]) => void): void;
    off<K extends keyof AudioSourceEvents & string>(event: K, listener: (params: AudioSourceEvents[K]) => void): void;
    isReady(): boolean;
    getAudioMetadata(): AudioMetadata | undefined;
    getAudioConfig(): AudioFrame | undefined;
    // Buffering the transport needs (see `AudioBufferProfile`); the player default otherwise.
    getAudioBufferProfile?(): { targetSeconds: number; maxSeconds: number };
}

type AudioSessionFactory = (source: AudioSource) => AudioSession | undefined;
let factory: AudioSessionFactory | undefined;
export const activeAudioSession = signal<AudioSession | undefined>(undefined);
export const audioAvailability = signal<{
    state: 'unavailable' | 'loading' | 'ready' | 'error' | 'unsupported';
    message: string;
}>({
    state: 'unavailable',
    message:
        'Sound is not included in this app version. Reload the page; if this persists, ask the server owner to enable audio.',
});

export function isAudioAvailable(): boolean {
    return audioAvailability.value.state === 'ready';
}

export function registerAudioSessionFactory(f: AudioSessionFactory): void {
    factory = f;
    audioAvailability.value = { state: 'ready', message: 'Sound is available in this browser.' };
}

export function createAudioSession(source: AudioSource): AudioSession | undefined {
    let session: AudioSession | undefined;
    try {
        session = factory?.(source);
    } catch (error) {
        console.warn('Could not start browser audio', error);
    }
    if (!session) {
        if (factory) {
            audioAvailability.value = {
                state: 'error',
                message: 'Sound could not start in this browser. Reload the page and try again.',
            };
        }
        return;
    }
    audioAvailability.value = { state: 'ready', message: 'Sound is available in this browser.' };
    const stop = session.stop.bind(session);
    session.stop = () => {
        stop();
        if (activeAudioSession.value === session) {
            activeAudioSession.value = undefined;
        }
    };
    activeAudioSession.value = session;
    return session;
}
