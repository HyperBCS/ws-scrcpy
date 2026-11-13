import { useEffect, useState } from 'preact/hooks';
import { Disclosure } from '../../ui/AnimatedDetails';
import { SelectOption } from '../../ui/Field';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { SheetMessageRow, SheetRow, SheetStatus, SheetToggleRow } from '../../ui/SheetControls';
import { StreamClientScrcpy } from '../../googDevice/client/StreamClientScrcpy';
import { normalized } from '../../state/streamConfig';
import { EncoderInfo } from '../../../types/EncoderInfo';
import { SettingsGroup, SettingsSection } from './Section';
import { SelectRow } from './SelectRow';
import { NOT_CONNECTED, StreamChanges } from './streamChanges';

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
const OPEN_THE_SCREEN = 'Open the screen to change this.';

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

interface PlaybackProps {
    client?: StreamClientScrcpy;
    /** One opening of the sheet. Each reads the switches from the screen again. */
    opening?: object;
    /** The player of the open screen. */
    player?: string;
    disabled: boolean;
    /** Opens the same page with another player. */
    onPlayerChange: (player: string) => void;
}

/** What this browser does with the picture. These apply at once and are not sent to the phone. */
function Playback({ client, opening, player, disabled, onPlayerChange }: PlaybackProps) {
    const [showStats, setShowStats] = useState(false);
    useEffect(() => {
        setShowStats(client?.getPlayer()?.getShowQualityStats() ?? false);
    }, [client, opening]);
    return (
        <Disclosure class="settings-playback" title="Playback" note="This browser only">
            <SelectRow
                name="player"
                title="Video player"
                description={
                    client ? 'The decoder this browser uses. Changing it reloads the stream.' : OPEN_THE_SCREEN
                }
                value={player ?? ''}
                options={StreamClientScrcpy.getPlayers().map((candidate) => ({
                    value: candidate.playerCodeName,
                    label: candidate.playerFullName,
                }))}
                disabled={disabled || !client}
                onChange={onPlayerChange}
            />
            <SheetToggleRow
                title="Show quality stats"
                description={client ? 'Overlays bitrate, frame rate and decode timing on the video' : OPEN_THE_SCREEN}
                checked={showStats}
                disabled={!client}
                onChange={(checked) => {
                    setShowStats(checked);
                    client?.getPlayer()?.setShowQualityStats(checked);
                }}
            />
        </Disclosure>
    );
}

interface StreamSectionProps extends PlaybackProps {
    changes: StreamChanges;
}

/** The Stream section of an Android phone: the quality presets, the values behind them, and playback. */
export function StreamSection({ changes, ...playback }: StreamSectionProps) {
    const { config, shown, locked, connected } = changes;
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
            changes.change(
                {
                    bitrate: preset.bitrate,
                    maxFps: preset.maxFps,
                    maxSize: preset.maxSize,
                    videoCodec: 'h264',
                    videoEncoder: '',
                },
                'stream',
            );
        }
    };
    const set = (fields: Parameters<StreamChanges['change']>[0]) => changes.change(fields, 'stream');
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
    const loaded = connected && !loading;
    return (
        <SettingsSection name="stream">
            <SettingsGroup
                class="settings-quality"
                hint="A change restarts the stream. Use arrow keys to browse; press Enter or Space to apply."
                status={
                    changes.status('stream') ||
                    (loaded && !configKnown && !loadError && (
                        <SheetStatus>Current settings unavailable. Only values you change will be applied.</SheetStatus>
                    ))
                }
            >
                {connected && loading && <SheetMessageRow tone="info">Loading settings…</SheetMessageRow>}
                {connected && loadError && (
                    <SheetMessageRow action={{ label: 'Try again', run: config.reload, disabled: applying }}>
                        {loadError}
                    </SheetMessageRow>
                )}
                {loaded && codec !== 'h264' && (
                    <SheetMessageRow>
                        This phone is using {codec?.toUpperCase()}, which this app cannot play. Choose a quality preset
                        or H.264 below to restore video.
                    </SheetMessageRow>
                )}
                <SheetRow
                    title="Quality"
                    description={
                        !connected
                            ? NOT_CONNECTED
                            : !loading &&
                              `${selectedPreset || 'Custom quality'} · ${formatBitrate(shown.bitrate)} · ${formatMaxFps(shown.maxFps)}`
                    }
                    layout="stack"
                    attributes={{ 'data-setting': 'quality' }}
                >
                    <SegmentedControl
                        label="Quality presets"
                        activation="manual"
                        full
                        value={selectedPreset ?? ''}
                        options={QUALITY_PRESETS.map((preset) => ({ value: preset.name, label: preset.name }))}
                        disabled={locked}
                        onChange={choosePreset}
                    />
                </SheetRow>
            </SettingsGroup>
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
                    onChange={(value) => set({ videoCodec: value, videoEncoder: '' })}
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
                    onChange={(value) => set({ videoEncoder: value })}
                />
                <SelectRow
                    name="bitrate"
                    title="Bitrate"
                    description="Higher uses more data"
                    value={String(shown.bitrate)}
                    options={numberOptions(BITRATE_OPTIONS, shown.bitrate, formatBitrate)}
                    disabled={locked}
                    onChange={(value) => set({ bitrate: Number(value) })}
                />
                <SelectRow
                    name="fps"
                    title="Frame rate"
                    description="Higher feels smoother"
                    value={String(shown.maxFps)}
                    options={numberOptions(MAX_FPS_OPTIONS, shown.maxFps, formatMaxFps)}
                    disabled={locked}
                    onChange={(value) => set({ maxFps: Number(value) })}
                />
                <SelectRow
                    name="size"
                    title="Resolution"
                    description="Maximum long edge"
                    value={String(shown.maxSize)}
                    options={numberOptions(MAX_SIZE_OPTIONS, shown.maxSize, formatMaxSize)}
                    disabled={locked}
                    onChange={(value) => set({ maxSize: Number(value) })}
                />
                <SelectRow
                    name="keyframes"
                    title="Keyframe interval"
                    description="Shorter recovers faster after a glitch. Longer saves data."
                    value={String(shown.iFrameInterval)}
                    options={numberOptions(IFRAME_INTERVAL_OPTIONS, shown.iFrameInterval, (value) => `${value}s`)}
                    disabled={locked}
                    onChange={(value) => set({ iFrameInterval: Number(value) })}
                />
            </Disclosure>
            <Playback {...playback} />
        </SettingsSection>
    );
}
