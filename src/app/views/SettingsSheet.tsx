import { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Disclosure } from '../ui/AnimatedDetails';
import { Button } from '../ui/Button';
import { SelectField, SelectOption } from '../ui/Field';
import { InlineStatus, StatusTone } from '../ui/InlineStatus';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Sheet } from '../ui/Sheet';
import { SheetGroup, SheetMessageRow, SheetRow, SheetStatus, SheetToggleRow, VolumeSlider } from '../ui/SheetControls';
import { closeSettingsSheet, settingsSheetTarget } from '../state/settingsSheet';
import { activeStream } from '../state/stream';
import { deviceName } from '../state/devices';
import { findDeviceForSettings } from '../state/streamDevice';
import { activeAudioSession, audioAvailability, AudioSession, isAudioAvailable } from '../state/audio';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import { ScrcpyServerConfig } from '../../common/Constants';
import { EncoderInfo } from '../../types/EncoderInfo';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { route, switchRoute } from '../state/router';
import { normalized, StreamConfig, StreamConfigPatch, useStreamConfig } from '../state/streamConfig';
import '../../style/views/SettingsSheet.css';

// Both browser players currently parse AVC/H.264. The server supports other codecs, but
// offering them here would restart a healthy stream into a permanently black screen.
const CODEC_OPTIONS = [{ value: 'h264', label: 'H.264 · browser compatible' }];
const BITRATE_OPTIONS = [1_000_000, 2_000_000, 3_500_000, 5_000_000, 8_000_000, 12_000_000];
const MAX_SIZE_OPTIONS = [0, 720, 960, 1280, 1600, 1920];
const MAX_FPS_OPTIONS = [0, 15, 24, 30, 45, 60];
const IFRAME_INTERVAL_OPTIONS = [1, 2, 5, 10];
const QUALITY_PRESETS = [
    { name: 'Data saver', bitrate: 1_000_000, maxFps: 30, maxSize: 720 },
    { name: 'Balanced', bitrate: 3_500_000, maxFps: 60, maxSize: 1280 },
    { name: 'Sharper', bitrate: 8_000_000, maxFps: 60, maxSize: 1920 },
];
function formatBitrate(value: number): string {
    return `${value / 1_000_000} Mbps`;
}
function formatMaxSize(value: number): string {
    return value === 0 ? 'Original resolution' : `${value}px long edge`;
}
function formatMaxFps(value: number): string {
    return value === 0 ? 'Unlimited' : `${value} fps`;
}
/** The fixed choices of a number setting, plus the phone's own value when it is not one of them. */
function numberOptions(options: number[], current: number, label: (value: number) => string): SelectOption[] {
    const values = options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
    return values.map((value) => ({ value: String(value), label: label(value) }));
}

interface SelectRowProps {
    /** Names the row for tests and for the stylesheet (`data-setting`). */
    name: string;
    title: string;
    description: string;
    value: string;
    options: ReadonlyArray<SelectOption>;
    disabled?: boolean;
    /** `stack` keeps the select under the text at every width, for long option names. */
    layout?: 'pair' | 'stack';
    onChange: (value: string) => void;
}

/** A setting chosen from a list: the select beside its text, and under it on a phone. */
function SelectRow({ name, title, description, value, options, disabled, layout = 'pair', onChange }: SelectRowProps) {
    return (
        <SheetRow kit title={title} description={description} layout={layout} attributes={{ 'data-setting': name }}>
            <SelectField
                label={title}
                labelHidden
                value={value}
                options={options}
                disabled={disabled}
                onChange={(event) => onChange(event.currentTarget.value)}
            />
        </SheetRow>
    );
}

interface SectionProps {
    /** The phone's settings with the unapplied changes over them. */
    shown: ScrcpyServerConfig;
    /** No setting can be changed now: loading, applying, or the phone is not there. */
    locked: boolean;
    setFields: (fields: StreamConfigPatch) => void;
}

interface QualitySectionProps extends SectionProps {
    config: StreamConfig;
    hasTracker: boolean;
    onReload: () => void;
}

/** Quality presets, with the single settings behind them in a disclosure. */
function QualitySection({ config, shown, locked, hasTracker, setFields, onReload }: QualitySectionProps) {
    const { configKnown, encoders, loading, loadError, applying } = config;
    const codec = normalized(shown, 'videoCodec');
    const encoder = normalized(shown, 'videoEncoder');
    const hasChanges = Object.keys(config.patch).length > 0;
    const filteredEncoders = encoders
        .filter((candidate) => candidate.videoCodec === codec)
        .slice()
        .sort((a, b) => {
            const rank = (candidate: EncoderInfo) =>
                (candidate.aliasFor ? 2 : 0) + (candidate.hardware === 'hw' ? 0 : 1);
            return rank(a) - rank(b) || a.encoderName.localeCompare(b.encoderName);
        });
    const selectedPreset =
        configKnown || hasChanges
            ? QUALITY_PRESETS.find(
                  (preset) =>
                      preset.bitrate === shown.bitrate &&
                      preset.maxFps === shown.maxFps &&
                      preset.maxSize === shown.maxSize &&
                      codec === 'h264' &&
                      !encoder,
              )?.name
            : undefined;
    const choosePreset = (name: string) => {
        const preset = QUALITY_PRESETS.find((candidate) => candidate.name === name);
        if (preset) {
            setFields({
                bitrate: preset.bitrate,
                maxFps: preset.maxFps,
                maxSize: preset.maxSize,
                videoCodec: 'h264',
                videoEncoder: '',
            });
        }
    };
    const encoderOptions: SelectOption[] = [
        { value: '', label: 'Automatic · phone default' },
        ...(encoder && !filteredEncoders.some((candidate) => candidate.encoderName === encoder)
            ? [{ value: encoder, label: encoder }]
            : []),
        ...filteredEncoders.map((candidate) => ({
            value: candidate.encoderName,
            label: `${candidate.encoderName}${
                candidate.hardware === 'hw' ? ' · hardware' : candidate.hardware === 'sw' ? ' · software' : ''
            }${candidate.aliasFor ? ' (alias)' : ''}`,
        })),
    ];
    return (
        <>
            <SheetGroup
                kit
                title="Stream quality"
                status={
                    !loading &&
                    !configKnown &&
                    hasTracker && (
                        <SheetStatus kit>
                            Current settings unavailable. Only values you change will be applied.
                        </SheetStatus>
                    )
                }
            >
                {loading && <SheetMessageRow tone="info">Loading settings…</SheetMessageRow>}
                {loadError && (
                    <SheetMessageRow
                        action={hasTracker ? { label: 'Try again', run: onReload, disabled: applying } : undefined}
                    >
                        {loadError}
                    </SheetMessageRow>
                )}
                {!loading && codec !== 'h264' && (
                    <SheetMessageRow>
                        This phone is using {codec?.toUpperCase()}, which this app cannot play. Choose a quality preset
                        or H.264 below, then apply the change to restore video.
                    </SheetMessageRow>
                )}
                <SheetRow
                    kit
                    title="Quality"
                    description={
                        !loading &&
                        `${selectedPreset || 'Custom quality'} · ${formatBitrate(shown.bitrate)} · ${formatMaxFps(shown.maxFps)}`
                    }
                    layout="stack"
                    attributes={{ 'data-setting': 'quality' }}
                >
                    <SegmentedControl
                        label="Quality presets"
                        full
                        value={selectedPreset ?? ''}
                        options={QUALITY_PRESETS.map((preset) => ({ value: preset.name, label: preset.name }))}
                        disabled={locked}
                        onChange={choosePreset}
                    />
                </SheetRow>
            </SheetGroup>
            <Disclosure class="settings-advanced" title="Advanced quality settings">
                <SelectRow
                    name="codec"
                    title="Video codec"
                    description="H.264 is the format this app can play"
                    value={codec ?? ''}
                    options={[
                        ...(codec !== 'h264'
                            ? [
                                  {
                                      value: codec ?? '',
                                      label: `${codec?.toUpperCase()} · unsupported here`,
                                      disabled: true,
                                  },
                              ]
                            : []),
                        ...CODEC_OPTIONS,
                    ]}
                    disabled={locked}
                    onChange={(value) => setFields({ videoCodec: value, videoEncoder: '' })}
                />
                <SelectRow
                    name="encoder"
                    title="Video encoder"
                    description={
                        loading || encoders.length
                            ? 'Automatic lets the phone choose. Hardware encoders are listed first.'
                            : "No encoders were listed. Automatic uses the phone's default encoder."
                    }
                    layout="stack"
                    value={encoder ?? ''}
                    options={encoderOptions}
                    disabled={locked}
                    onChange={(value) => setFields({ videoEncoder: value })}
                />
                <SelectRow
                    name="bitrate"
                    title="Bitrate"
                    description="Higher uses more data"
                    value={String(shown.bitrate)}
                    options={numberOptions(BITRATE_OPTIONS, shown.bitrate, formatBitrate)}
                    disabled={locked}
                    onChange={(value) => setFields({ bitrate: Number(value) })}
                />
                <SelectRow
                    name="fps"
                    title="Frame rate"
                    description="Higher feels smoother"
                    value={String(shown.maxFps)}
                    options={numberOptions(MAX_FPS_OPTIONS, shown.maxFps, formatMaxFps)}
                    disabled={locked}
                    onChange={(value) => setFields({ maxFps: Number(value) })}
                />
                <SelectRow
                    name="size"
                    title="Resolution"
                    description="Maximum long edge"
                    value={String(shown.maxSize)}
                    options={numberOptions(MAX_SIZE_OPTIONS, shown.maxSize, formatMaxSize)}
                    disabled={locked}
                    onChange={(value) => setFields({ maxSize: Number(value) })}
                />
                <SelectRow
                    name="keyframes"
                    title="Keyframe interval"
                    description="Shorter recovers faster after a glitch. Longer saves data."
                    value={String(shown.iFrameInterval)}
                    options={numberOptions(IFRAME_INTERVAL_OPTIONS, shown.iFrameInterval, (value) => `${value}s`)}
                    disabled={locked}
                    onChange={(value) => setFields({ iFrameInterval: Number(value) })}
                />
            </Disclosure>
        </>
    );
}

interface SoundSectionProps extends SectionProps {
    /** What the phone runs with: Listen plays only what is already captured. */
    baseline: ScrcpyServerConfig;
    hasChanges: boolean;
    /** The phone's Android API level, or NaN when it is not known. */
    sdkInt: number;
    /** Playback in this browser, while this phone's screen is open. */
    audioSession?: AudioSession;
    screenOpen: boolean;
    onRetry: () => void;
}

/** Sound capture on the phone, and playback in this browser while the screen is open. */
function SoundSection({
    shown,
    baseline,
    locked,
    hasChanges,
    sdkInt,
    audioSession,
    screenOpen,
    setFields,
    onRetry,
}: SoundSectionProps) {
    const audioStatus = audioSession?.status.value;
    const audioUnavailableReason = !isAudioAvailable()
        ? audioAvailability.value.message
        : !isNaN(sdkInt) && sdkInt < 30
          ? `This phone runs Android API ${sdkInt}. Capturing sound requires Android 11 or later.`
          : undefined;
    // Missing tracker properties are not proof of an unsupported device. Let the capture
    // handshake report actual support instead of permanently greying out newer Android phones.
    const audioCapable = !audioUnavailableReason;
    const muted = !!audioSession && (audioSession.isMuted() || audioStatus?.state === 'blocked');
    const showRetry =
        (audioStatus?.state === 'error' || audioStatus?.state === 'disabled') && baseline.audio && !hasChanges;
    return (
        <>
            <SheetGroup kit title="Sound" class="settings-audio">
                <SheetToggleRow
                    kit
                    title="Capture audio"
                    description={
                        audioUnavailableReason ||
                        (shown.audio
                            ? 'Capture is on. Tap Listen to hear it in this browser.'
                            : 'Enable capture, then apply the change to listen in this browser.')
                    }
                    checked={!!shown.audio}
                    disabled={locked || (!audioCapable && !shown.audio)}
                    onChange={(checked) => setFields({ audio: checked })}
                />
                {!isAudioAvailable() && (
                    <div class="kit-row kit-row-stack" data-audio-availability={audioAvailability.value.state}>
                        <Button onClick={() => location.reload()}>Reload page</Button>
                    </div>
                )}
                <SelectRow
                    name="audio-source"
                    title="Audio source"
                    description="Device media is what the phone plays; the phone itself goes quiet unless you choose the option that keeps it playing. Call audio is the far side of a phone call."
                    value={shown.audioSource || 'output'}
                    options={[
                        { value: 'output', label: 'Device media' },
                        // Needs Android 13. An unknown version is offered it; the server falls
                        // back to plain device media where it cannot be used.
                        ...(isNaN(sdkInt) || sdkInt >= 33 || shown.audioSource === 'playback'
                            ? [{ value: 'playback', label: 'Device media, phone keeps playing' }]
                            : []),
                        { value: 'voice-call-downlink', label: 'Call audio' },
                    ]}
                    disabled={locked || !shown.audio || !audioCapable}
                    onChange={(value) => setFields({ audioSource: value as ScrcpyServerConfig['audioSource'] })}
                />
                {audioSession && audioStatus && (
                    <>
                        <SheetRow
                            kit
                            title="Listen in this browser"
                            description={<span role="status">{audioStatus.message}</span>}
                            // One button sits beside the text, as in the Actions sheet; two go
                            // under it on a phone.
                            layout={showRetry ? 'pair' : undefined}
                            attributes={{ 'data-audio-state': audioStatus.state }}
                        >
                            {showRetry && (
                                <Button size="compact" disabled={locked} onClick={onRetry}>
                                    Retry audio &amp; restart
                                </Button>
                            )}
                            <Button
                                size="compact"
                                variant={muted ? 'primary' : 'secondary'}
                                disabled={
                                    !baseline.audio ||
                                    audioStatus.state === 'disabled' ||
                                    audioStatus.state === 'unsupported' ||
                                    audioStatus.state === 'error'
                                }
                                onClick={() => (muted ? audioSession.unmute() : audioSession.mute())}
                            >
                                {muted ? 'Listen' : 'Stop listening'}
                            </Button>
                        </SheetRow>
                        <SheetRow kit title="Volume" description="Browser volume only." layout="stack">
                            <VolumeSlider kit session={audioSession} />
                        </SheetRow>
                    </>
                )}
            </SheetGroup>
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
                    onChange={(value) => setFields({ audioCodec: value as ScrcpyServerConfig['audioCodec'] })}
                />
            </Disclosure>
            {!screenOpen && <p class="settings-note">After applying, open the screen and tap Listen.</p>}
        </>
    );
}

interface PlaybackSectionProps {
    client: StreamClientScrcpy;
    /** One opening of the sheet. Each reads the switches from the screen again. */
    opening?: object;
    /** The player of the open screen. */
    player?: string;
    disabled: boolean;
    /** Opens the same page with another player. `captureKeyboard` is carried into its address. */
    onPlayerChange: (player: string, captureKeyboard: boolean) => void;
}

/** What this browser does with the stream. These apply at once and are not sent to the phone. */
function PlaybackSection({ client, opening, player, disabled, onPlayerChange }: PlaybackSectionProps) {
    const [captureKeyboard, setCaptureKeyboard] = useState(true);
    const [useUhid, setUseUhid] = useState(true);
    const [showStats, setShowStats] = useState(false);

    useEffect(() => {
        setShowStats(client.getPlayer()?.getShowQualityStats() ?? false);
        setCaptureKeyboard(client.isKeyboardCaptured());
        setUseUhid(client.isUsingUhidKeyboard());
    }, [client, opening]);

    return (
        <Disclosure class="settings-playback" title="Playback & keyboard" note="This browser only">
            <p class="settings-note">Applies immediately.</p>
            <SelectRow
                name="player"
                title="Video player"
                description="The decoder this browser uses. Changing it reloads the stream."
                value={player ?? ''}
                options={StreamClientScrcpy.getPlayers().map((candidate) => ({
                    value: candidate.playerCodeName,
                    label: candidate.playerFullName,
                }))}
                disabled={disabled}
                onChange={(value) => onPlayerChange(value, captureKeyboard)}
            />
            <SheetToggleRow
                kit
                title="Show quality stats"
                description="Overlays bitrate, frame rate and decode timing on the video"
                checked={showStats}
                onChange={(checked) => {
                    setShowStats(checked);
                    client.getPlayer()?.setShowQualityStats(checked);
                }}
            />
            <SheetToggleRow
                kit
                title="Physical keyboard"
                description="Send hardware keystrokes to the phone"
                checked={captureKeyboard}
                onChange={(checked) => {
                    setCaptureKeyboard(checked);
                    client.setHandleKeyboardEvents(checked, useUhid);
                }}
            />
            <SheetToggleRow
                kit
                title="Native keyboard (UHID)"
                description="Use the phone's keyboard layout · Android 11+"
                checked={useUhid}
                disabled={!captureKeyboard}
                onChange={(checked) => {
                    setUseUhid(checked);
                    if (captureKeyboard) {
                        client.setHandleKeyboardEvents(true, checked);
                    }
                }}
            />
        </Disclosure>
    );
}

/** One line of the apply footer. It can take focus, so focus follows what replaced a pressed button. */
function ApplyMessage({ tone, children }: { tone?: StatusTone; children: ComponentChildren }) {
    return (
        <div class="settings-apply-message" tabIndex={-1}>
            <InlineStatus tone={tone}>{children}</InlineStatus>
        </div>
    );
}

/**
 * Stream settings of an Android phone. The settings and the requests that load and apply them
 * are in `state/streamConfig.ts`; this draws them as three sections, and the footer holds the
 * step that applies a change: Apply changes, then the question, then the outcome.
 */
export function SettingsSheet() {
    const target = settingsSheetTarget.value;
    const session = activeStream.value;
    const previousTarget = useRef(target);
    if (target) {
        previousTarget.current = target;
    }
    // Retain content through the closing animation. Each opening gets a fresh request.
    const renderTarget = target ?? previousTarget.current;
    // The stream opens this sheet with a serial alone, and two hosts can each have that serial.
    const entry = renderTarget ? findDeviceForSettings(renderTarget, session?.params) : undefined;
    const tracker = target ? entry?.tracker : undefined;
    const client: StreamClientScrcpy | undefined =
        renderTarget && session?.params.udid === renderTarget.udid ? session.client : undefined;
    const config = useStreamConfig(target, tracker, target?.udid);
    const { baseline, patch, loading, applying, applyError, appliedNote } = config;
    const [confirming, setConfirming] = useState(false);

    // Each opening starts without a question waiting.
    useEffect(() => {
        if (target) {
            setConfirming(false);
        }
    }, [target, tracker]);

    // The pressed button often leaves the footer (Apply changes, Apply & restart, Discard).
    // Focus would then fall to the page behind the sheet, so it moves to what took the button's
    // place: the error, else the next button, else the status line, else the sheet itself.
    const applyRef = useRef<HTMLDivElement>(null);
    const applyHadFocus = !!applyRef.current?.contains(document.activeElement);
    useLayoutEffect(() => {
        const bar = applyRef.current;
        const active = document.activeElement;
        if (!applyHadFocus || !bar || !target || (bar.contains(active) && !active?.matches(':disabled'))) {
            return;
        }
        const next =
            bar.querySelector<HTMLElement>('[role="alert"]')?.parentElement ??
            bar.querySelector<HTMLElement>('button:not(:disabled)') ??
            bar.querySelector<HTMLElement>('.settings-apply-message') ??
            bar.closest<HTMLElement>('[role="dialog"]');
        next?.focus({ preventScroll: true });
    });

    if (!renderTarget) {
        return (
            <Sheet open={false} onClose={closeSettingsSheet} title="Stream settings">
                {null}
            </Sheet>
        );
    }
    const descriptor = entry?.params.type === 'android' ? (entry.descriptor as GoogDeviceDescriptor) : undefined;
    const sdkInt = descriptor ? parseInt(descriptor['ro.build.version.sdk'], 10) : NaN;
    const shown = { ...baseline, ...patch };
    const locked = applying || loading || !tracker;
    const hasChanges = Object.keys(patch).length > 0;
    const otherViewers = client?.getClientsCount() ?? 0;
    const viewerWarning =
        otherViewers > 0
            ? `${otherViewers} other open screen${otherViewers === 1 ? '' : 's'} will also reconnect.`
            : '';

    const setFields = (fields: StreamConfigPatch) => {
        config.setFields(fields);
        setConfirming(false);
    };
    const applyConfig = (changes: StreamConfigPatch) => {
        if (config.apply(changes)) {
            setConfirming(false);
        }
    };
    const savedShown = !!appliedNote && !hasChanges && !applying;
    const nothingToApply = !applyError && !savedShown && !applying && !confirming && !hasChanges;
    const onPlayerChange = (player: string, captureKeyboard: boolean) => {
        if (!session) {
            return;
        }
        // The same page with another player: the entry is replaced, so Back does not lead to
        // the stream under the player before.
        const next = new URLSearchParams(route.value);
        next.set('player', player);
        next.set('captureKeyboard', String(captureKeyboard));
        closeSettingsSheet();
        switchRoute(next);
    };

    // Nothing to apply and nothing to report: the sheet has no footer.
    const footer = nothingToApply ? undefined : (
        <div class="settings-apply" ref={applyRef}>
            {applyError && <ApplyMessage tone="error">{applyError}</ApplyMessage>}
            {savedShown && <ApplyMessage tone="success">{appliedNote}</ApplyMessage>}
            {applying ? (
                <ApplyMessage>Saving and reconnecting…</ApplyMessage>
            ) : confirming ? (
                <>
                    <p class="settings-apply-question">Restart this phone's stream?</p>
                    <p class="settings-apply-note">The screen will pause for a few seconds. {viewerWarning}</p>
                    {/* Keyed apart from the two buttons of the step before. Without the keys
                        the pressed Apply changes button would become Apply & restart and keep
                        focus, and a second press of Enter would restart the stream. */}
                    <div class="settings-apply-buttons" key="confirm">
                        <Button onClick={() => setConfirming(false)}>Keep editing</Button>
                        <Button variant="primary" onClick={() => applyConfig(patch)}>
                            Apply &amp; restart
                        </Button>
                    </div>
                </>
            ) : (
                hasChanges && (
                    <>
                        <p class="settings-apply-note">Applying restarts the stream.</p>
                        <div class="settings-apply-buttons" key="edit">
                            <Button
                                disabled={locked}
                                onClick={() => {
                                    config.discard();
                                    setConfirming(false);
                                }}
                            >
                                Discard
                            </Button>
                            <Button variant="primary" disabled={locked} onClick={() => setConfirming(true)}>
                                Apply changes
                            </Button>
                        </div>
                    </>
                )
            )}
        </div>
    );

    return (
        <Sheet
            open={!!target}
            dismissible={!applying}
            onClose={() => {
                if (!applying) {
                    closeSettingsSheet();
                }
            }}
            title="Stream settings"
            subtitle={entry ? deviceName(entry) : undefined}
            footer={footer}
        >
            <div class="stream-settings">
                <QualitySection
                    config={config}
                    shown={shown}
                    locked={locked}
                    hasTracker={!!tracker}
                    setFields={setFields}
                    onReload={() => {
                        setConfirming(false);
                        config.reload();
                    }}
                />
                <SoundSection
                    shown={shown}
                    baseline={baseline}
                    locked={locked}
                    hasChanges={hasChanges}
                    sdkInt={sdkInt}
                    audioSession={client ? activeAudioSession.value : undefined}
                    screenOpen={!!client}
                    setFields={setFields}
                    onRetry={() => applyConfig({ audio: true })}
                />
                {client ? (
                    <PlaybackSection
                        client={client}
                        opening={target}
                        player={session?.params.player}
                        disabled={applying}
                        onPlayerChange={onPlayerChange}
                    />
                ) : (
                    <p class="settings-note">Open the screen for playback and keyboard settings.</p>
                )}
            </div>
        </Sheet>
    );
}
