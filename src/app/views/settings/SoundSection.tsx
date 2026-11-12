import { Disclosure } from '../../ui/AnimatedDetails';
import { Button } from '../../ui/Button';
import { SheetRow, SheetToggleRow, SoundRows } from '../../ui/SheetControls';
import { audioAvailability, AudioSession, isAudioAvailable } from '../../state/audio';
import { ScrcpyServerConfig } from '../../../common/Constants';
import { SettingsGroup, SettingsSection } from './Section';
import { SelectRow } from './SelectRow';
import { NOT_CONNECTED, StreamChanges } from './streamChanges';

const OPEN_TO_LISTEN = 'Open the screen to listen.';

interface SoundSectionProps {
    /** Sound capture on an Android phone, a stream value. An iPhone has none to set. */
    changes?: StreamChanges;
    /** The phone's Android API level, or NaN when it is not known. */
    sdkInt?: number;
    /** Playback in this browser, while this phone's screen is open here. */
    audioSession?: AudioSession;
    screenOpen: boolean;
}

/** Listen in this browser when the screen is open, else the reason it cannot be used. */
function Listen({ audioSession, screenOpen }: { audioSession?: AudioSession; screenOpen: boolean }) {
    if (screenOpen && audioSession) {
        return <SoundRows session={audioSession} />;
    }
    return (
        <SheetRow
            title="Listen in this browser"
            description={screenOpen ? audioAvailability.value.message : OPEN_TO_LISTEN}
        >
            <Button size="compact" disabled>
                Listen
            </Button>
        </SheetRow>
    );
}

/**
 * Sound: the same Listen and Volume rows on both kinds of phone. An Android phone also has sound
 * capture, its source and its format, which are stream values and restart the stream.
 */
export function SoundSection({ changes, sdkInt = NaN, audioSession, screenOpen }: SoundSectionProps) {
    if (!changes) {
        return (
            <SettingsSection name="sound">
                <SettingsGroup class="settings-audio">
                    <Listen audioSession={audioSession} screenOpen={screenOpen} />
                </SettingsGroup>
            </SettingsSection>
        );
    }
    const { shown, locked, connected, config } = changes;
    const audioStatus = audioSession?.status.value;
    const audioUnavailableReason = !isAudioAvailable()
        ? audioAvailability.value.message
        : !isNaN(sdkInt) && sdkInt < 30
          ? `This phone runs Android API ${sdkInt}. Capturing sound requires Android 11 or later.`
          : undefined;
    // Missing tracker properties are not proof of an unsupported phone. Let the capture
    // handshake report actual support instead of permanently greying out newer Android phones.
    const audioCapable = !audioUnavailableReason;
    const showRetry =
        screenOpen &&
        (audioStatus?.state === 'error' || audioStatus?.state === 'disabled') &&
        config.baseline.audio &&
        !config.applying;
    const set = (fields: Partial<ScrcpyServerConfig>) => changes.change(fields, 'sound');
    return (
        <SettingsSection name="sound">
            <SettingsGroup class="settings-audio" status={changes.status('sound')}>
                <SheetToggleRow
                    title="Capture audio"
                    description={
                        !connected
                            ? NOT_CONNECTED
                            : audioUnavailableReason || 'Sound from the phone. A change restarts the stream.'
                    }
                    checked={!!shown.audio}
                    disabled={locked || (!audioCapable && !shown.audio)}
                    onChange={(checked) => set({ audio: checked })}
                />
                {!isAudioAvailable() && (
                    <div class="kit-row kit-row-stack" data-audio-availability={audioAvailability.value.state}>
                        <Button onClick={() => location.reload()}>Reload page</Button>
                    </div>
                )}
                <SelectRow
                    name="audio-source"
                    title="Audio source"
                    description="Phone media is what the phone plays; the phone itself goes quiet unless you choose the option that keeps it playing. Call audio is the far side of a phone call."
                    value={shown.audioSource || 'output'}
                    options={[
                        { value: 'output', label: 'Phone media' },
                        // Needs Android 13. An unknown version is offered it; the server falls
                        // back to plain phone media where it cannot be used.
                        ...(isNaN(sdkInt) || sdkInt >= 33 || shown.audioSource === 'playback'
                            ? [{ value: 'playback', label: 'Phone media, phone keeps playing' }]
                            : []),
                        { value: 'voice-call-downlink', label: 'Call audio' },
                    ]}
                    disabled={locked || !shown.audio || !audioCapable}
                    onChange={(value) => set({ audioSource: value as ScrcpyServerConfig['audioSource'] })}
                />
                <Listen audioSession={audioSession} screenOpen={screenOpen} />
                {showRetry && (
                    <SheetRow title="Retry sound" description="Restarts the stream with sound capture on.">
                        <Button
                            size="compact"
                            disabled={locked}
                            onClick={() => changes.change({ audio: true }, 'sound', true)}
                        >
                            Retry
                        </Button>
                    </SheetRow>
                )}
            </SettingsGroup>
            <Disclosure class="settings-advanced" title="Audio format">
                <SelectRow
                    name="audio-codec"
                    title="Format"
                    description="PCM plays in every browser and uses about 1.5 Mbps. Opus uses less data and needs HTTPS."
                    value={shown.audioCodec || 'raw'}
                    options={[
                        { value: 'raw', label: 'Compatible · PCM' },
                        { value: 'opus', label: 'Lower data use · Opus' },
                    ]}
                    disabled={locked || !shown.audio || !audioCapable}
                    onChange={(value) => set({ audioCodec: value as ScrcpyServerConfig['audioCodec'] })}
                />
            </Disclosure>
        </SettingsSection>
    );
}
