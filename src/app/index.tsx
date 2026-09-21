import '../style/tokens.css';
import '../style/app.css';
import { render } from 'preact';
import { StreamClientScrcpy } from './googDevice/client/StreamClientScrcpy';
import { Tool } from './client/Tool';
import { App } from './views/App';
import { shellTool, fileListingTool } from './googDevice/client/deviceTools';
// Type-only -- erased at compile time, so importing it unconditionally does not pull `AudioPlayer`
// (or anything else) into a `USE_AUDIO=false` build.
import type { AudioFrame } from './client/audioPacket';
import type { AudioMetadata } from '../common/AudioProtocol';

window.onload = async function (): Promise<void> {
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

    /// #if INCLUDE_APPL
    {
        const { DeviceTracker } = await import('./applDevice/client/DeviceTracker');
        const { coreDeviceStreamTool } = await import('./applDevice/client/coreDeviceTool');
        DeviceTracker.registerTool(coreDeviceStreamTool);
    }
    /// #endif

    const tools: Tool[] = [];

    /// #if INCLUDE_ADB_SHELL
    tools.push(shellTool);
    /// #endif

    /// #if INCLUDE_FILE_LISTING
    tools.push(fileListingTool);
    /// #endif

    if (tools.length) {
        const { DeviceTracker } = await import('./googDevice/client/DeviceTracker');
        tools.forEach((tool) => {
            DeviceTracker.registerTool(tool);
        });
    }

    render(<App />, document.getElementById('root') as HTMLElement);
};
