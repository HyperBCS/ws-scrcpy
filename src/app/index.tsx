import { registerNotificationWorker } from './state/notifications';
import '../style/tokens.css';
import '../style/app.css';
import { render } from 'preact';
import { StreamClientScrcpy } from './googDevice/client/StreamClientScrcpy';
import { App } from './views/App';
import { ScreenFailed } from './ui/ErrorBoundary';
// Type-only -- erased at compile time, so importing it unconditionally does not pull `AudioPlayer`
// (or anything else) into a `USE_AUDIO=false` build.
import type { AudioFrame } from './client/audioPacket';
import type { AudioMetadata } from '../common/AudioProtocol';

// A chunk that fails to download (a network blip, an update between two requests) rejects its
// import. Without this the page stays empty; the installed app has no reload button of its own.
window.onload = function (): void {
    start().catch((error) => {
        console.error('[App] Could not start', error);
        render(<ScreenFailed title="The app could not start" />, document.getElementById('root') as HTMLElement);
    });
};

async function start(): Promise<void> {
    if (window.isSecureContext && 'serviceWorker' in navigator)
        void registerNotificationWorker().catch(() => undefined);
    /// #if USE_H264_CONVERTER
    const { MsePlayer } = await import('./player/MsePlayer');
    StreamClientScrcpy.registerPlayer(MsePlayer);
    /// #endif

    /// #if USE_WEBCODECS
    const { WebCodecsPlayer } = await import('./player/WebCodecsPlayer');
    StreamClientScrcpy.registerPlayer(WebCodecsPlayer);
    /// #endif

    /// #if USE_AUDIO
    // PCM needs only Web Audio, including on HTTP. The optional audio chunk may fail to load
    // after an update; keep video usable and show a recovery action instead of aborting render.
    {
        const { registerAudioSessionFactory, audioAvailability } = await import('./state/audio');
        audioAvailability.value = { state: 'loading', message: 'Loading browser sound support…' };
        try {
            const { AudioPlayer } = await import('./player/AudioPlayer');
            if (!AudioPlayer.isSupported()) {
                audioAvailability.value = {
                    state: 'unsupported',
                    message:
                        'This browser does not provide Web Audio. Open this page in a current Chrome, Edge, Firefox, or Safari browser.',
                };
            } else {
                registerAudioSessionFactory((receiver) => {
                    const player = new AudioPlayer(receiver.getAudioBufferProfile?.());
                    const onAudio = (frame: AudioFrame) => player.pushFrame(frame);
                    const onMetadata = (metadata: AudioMetadata) => player.setMetadata(metadata);
                    const onConnected = () => player.setConnected(true);
                    const onDisconnected = () => player.setConnected(false);
                    receiver.on('audio', onAudio);
                    receiver.on('audioMetadata', onMetadata);
                    receiver.on('connected', onConnected);
                    receiver.on('disconnected', onDisconnected);
                    player.setConnected(receiver.isReady());
                    const metadata = receiver.getAudioMetadata();
                    if (metadata) {
                        player.setMetadata(metadata);
                    }
                    const config = receiver.getAudioConfig();
                    if (config) {
                        player.pushFrame(config);
                    }
                    let stopped = false;
                    return {
                        status: player.status,
                        isSupported: () => player.isSupported(),
                        isMuted: () => player.isMuted(),
                        getStats: () => player.getStats(),
                        unmute: () => player.play(),
                        mute: () => player.mute(),
                        getVolume: () => player.getVolume(),
                        setVolume: (volume: number) => player.setVolume(volume),
                        stop: () => {
                            if (stopped) {
                                return;
                            }
                            stopped = true;
                            receiver.off('audio', onAudio);
                            receiver.off('audioMetadata', onMetadata);
                            receiver.off('connected', onConnected);
                            receiver.off('disconnected', onDisconnected);
                            player.stop();
                        },
                    };
                });
            }
        } catch (error) {
            console.warn('Could not load browser audio', error);
            audioAvailability.value = {
                state: 'error',
                message: 'Sound could not load. Reload the page to download the current app version.',
            };
        }
    }
    /// #endif

    render(<App />, document.getElementById('root') as HTMLElement);
}
