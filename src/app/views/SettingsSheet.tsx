import { useEffect, useRef, useState } from 'preact/hooks';
import { BottomSheet } from '../ui/BottomSheet';
import { VolumeSlider } from '../ui/SheetControls';
import { closeSettingsSheet, settingsSheetTarget } from '../state/settingsSheet';
import { activeStream } from '../state/stream';
import { devices, deviceName, findDeviceByUdid } from '../state/devices';
import { activeAudioSession, audioAvailability, isAudioAvailable } from '../state/audio';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import { ControlCenterCommand } from '../../common/ControlCenterCommand';
import { DEFAULT_SCRCPY_SERVER_CONFIG, ScrcpyServerConfig } from '../../common/Constants';
import { EncoderInfo } from '../../types/EncoderInfo';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { ACTION } from '../../common/Action';
import { navigate, route } from '../state/router';
import '../../style/views/SettingsSheet.css';

// Both browser players currently parse AVC/H.264. The server supports other codecs, but
// offering them here would restart a healthy stream into a permanently black screen.
const CODEC_OPTIONS = [{ value: 'h264', label: 'H.264 · browser compatible' }];
const BITRATE_OPTIONS = [1_000_000, 2_000_000, 3_500_000, 5_000_000, 8_000_000, 12_000_000];
const MAX_SIZE_OPTIONS = [0, 720, 960, 1280, 1600, 1920];
const MAX_FPS_OPTIONS = [0, 15, 24, 30, 45, 60];
const IFRAME_INTERVAL_OPTIONS = [1, 2, 5, 10];
const QUALITY_PRESETS = [
    { name: 'Data saver', hint: 'For mobile networks', bitrate: 1_000_000, maxFps: 30, maxSize: 720 },
    { name: 'Balanced', hint: 'Smooth everyday use', bitrate: 3_500_000, maxFps: 60, maxSize: 1280 },
    { name: 'Sharper', hint: 'For a fast connection', bitrate: 8_000_000, maxFps: 60, maxSize: 1920 },
];
const APPLY_TIMEOUT_MS = 20000;
const LOAD_TIMEOUT_MS = 15000;

interface ListEncodersReply {
    udid: string;
    requestId: number;
    encoders?: EncoderInfo[];
    config?: ScrcpyServerConfig;
    error?: string;
}
interface UpdateStreamConfigReply {
    udid: string;
    requestId: number;
    config?: ScrcpyServerConfig;
    error?: string;
}

function formatBitrate(value: number): string {
    return `${value / 1_000_000} Mbps`;
}
function formatMaxSize(value: number): string {
    return value === 0 ? 'Original resolution' : `${value}px long edge`;
}
function formatMaxFps(value: number): string {
    return value === 0 ? 'Unlimited' : `${value} fps`;
}
function normalized<K extends keyof ScrcpyServerConfig>(
    config: Partial<ScrcpyServerConfig>,
    key: K,
): ScrcpyServerConfig[K] {
    return (config[key] ??
        (key === 'videoCodec'
            ? 'h264'
            : key === 'videoEncoder'
              ? ''
              : DEFAULT_SCRCPY_SERVER_CONFIG[key])) as ScrcpyServerConfig[K];
}
function numberOptions(options: number[], current: number): number[] {
    return options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
}

export function SettingsSheet() {
    const target = settingsSheetTarget.value;
    const session = activeStream.value;
    const previousTarget = useRef(target);
    if (target) {
        previousTarget.current = target;
    }
    // Retain content through the closing animation. Each opening gets a fresh request below.
    const renderTarget = target ?? previousTarget.current;
    const entry = renderTarget?.deviceKey
        ? devices.value.get(renderTarget.deviceKey)
        : renderTarget
          ? findDeviceByUdid(renderTarget.udid)
          : undefined;
    const tracker = target ? entry?.tracker : undefined;
    const client: StreamClientScrcpy | undefined =
        renderTarget && session?.params.udid === renderTarget.udid ? session.client : undefined;
    const [baseline, setBaseline] = useState<ScrcpyServerConfig>(DEFAULT_SCRCPY_SERVER_CONFIG);
    const [configKnown, setConfigKnown] = useState(false);
    const [patch, setPatch] = useState<Partial<ScrcpyServerConfig>>({});
    const [encoders, setEncoders] = useState<EncoderInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string>();
    const [applying, setApplying] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [applyError, setApplyError] = useState<string>();
    const [appliedNote, setAppliedNote] = useState<string>();
    const [fitToScreen, setFitToScreenState] = useState(false);
    const [captureKeyboard, setCaptureKeyboard] = useState(true);
    const [useUhid, setUseUhid] = useState(true);
    const [showStats, setShowStats] = useState(false);
    const [reload, setReload] = useState(0);
    const applyTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
    const pendingPatch = useRef<Partial<ScrcpyServerConfig>>();
    const pendingRequestId = useRef<number>();

    useEffect(() => {
        if (!target) {
            return;
        }
        setPatch({});
        setBaseline(DEFAULT_SCRCPY_SERVER_CONFIG);
        setConfigKnown(false);
        setEncoders([]);
        setApplying(false);
        setConfirming(false);
        setApplyError(undefined);
        setAppliedNote(undefined);
        setLoadError(undefined);
        setLoading(true);
        pendingPatch.current = undefined;
        pendingRequestId.current = undefined;
        if (!tracker) {
            setLoading(false);
            setLoadError('Waiting for this device to connect. Settings will load automatically.');
            return;
        }
        const udid = target.udid;
        let loadRequestId: number | undefined;
        const loadTimeout = setTimeout(() => {
            loadRequestId = undefined;
            setLoading(false);
            setLoadError('Device settings took too long to load. Check the connection and try again.');
        }, LOAD_TIMEOUT_MS);
        const onEncoders = (data: ListEncodersReply) => {
            if (!data || data.udid !== udid || data.requestId !== loadRequestId) {
                return;
            }
            clearTimeout(loadTimeout);
            loadRequestId = undefined;
            setLoading(false);
            if (data.error) {
                setLoadError(`Could not load device settings: ${data.error}`);
                return;
            }
            setLoadError(undefined);
            setEncoders(Array.isArray(data.encoders) ? data.encoders : []);
            if (data.config) {
                setBaseline(data.config);
                setConfigKnown(true);
            }
        };
        const onUpdated = (data: UpdateStreamConfigReply) => {
            // A delayed or unsolicited reply must not clear a new edit or claim we applied it.
            if (!data || data.udid !== udid || !pendingPatch.current || data.requestId !== pendingRequestId.current) {
                return;
            }
            if (applyTimeoutRef.current !== undefined) {
                clearTimeout(applyTimeoutRef.current);
                applyTimeoutRef.current = undefined;
            }
            const submitted = pendingPatch.current;
            pendingPatch.current = undefined;
            pendingRequestId.current = undefined;
            setApplying(false);
            if (data.error) {
                setApplyError(`Could not apply changes: ${data.error}`);
                return;
            }
            setBaseline((current) => data.config ?? { ...current, ...submitted });
            setConfigKnown(true);
            setApplyError(undefined);
            setPatch({});
            setAppliedNote('Saved. Active screens will reconnect automatically.');
        };
        tracker.on('list_encoders', onEncoders);
        tracker.on('update_stream_config', onUpdated);
        loadRequestId = tracker.sendCommand(ControlCenterCommand.LIST_ENCODERS, { udid });
        return () => {
            clearTimeout(loadTimeout);
            tracker.off('list_encoders', onEncoders);
            tracker.off('update_stream_config', onUpdated);
            if (applyTimeoutRef.current !== undefined) {
                clearTimeout(applyTimeoutRef.current);
                applyTimeoutRef.current = undefined;
            }
            pendingPatch.current = undefined;
            pendingRequestId.current = undefined;
        };
    }, [target, tracker, reload]);

    useEffect(() => {
        setFitToScreenState(client?.isFitToScreen() ?? false);
        setShowStats(client?.getPlayer()?.getShowQualityStats() ?? false);
        setCaptureKeyboard(client?.isKeyboardCaptured() ?? true);
        setUseUhid(client?.isUsingUhidKeyboard() ?? true);
    }, [client, target]);

    if (!renderTarget) {
        return (
            <BottomSheet open={false} onClose={closeSettingsSheet} title="Settings">
                {null}
            </BottomSheet>
        );
    }
    const descriptor = entry?.params.type === 'android' ? (entry.descriptor as GoogDeviceDescriptor) : undefined;
    const sdkInt = descriptor ? parseInt(descriptor['ro.build.version.sdk'], 10) : NaN;
    const audioSession = client ? activeAudioSession.value : undefined;
    const audioStatus = audioSession?.status.value;
    const audioUnavailableReason = !isAudioAvailable()
        ? audioAvailability.value.message
        : !isNaN(sdkInt) && sdkInt < 30
          ? `This device runs Android API ${sdkInt}. Capturing sound requires Android 11 or later.`
          : undefined;
    // Missing tracker properties are not proof of an unsupported device. Let the capture
    // handshake report actual support instead of permanently greying out newer Android phones.
    const audioCapable = !audioUnavailableReason;
    const shown = { ...baseline, ...patch };
    const codec = normalized(shown, 'videoCodec');
    const encoder = normalized(shown, 'videoEncoder');
    const locked = applying || loading || !tracker;
    const hasChanges = Object.keys(patch).length > 0;
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
    const otherViewers = client?.getClientsCount() ?? 0;
    const viewerWarning =
        otherViewers > 0
            ? `${otherViewers} other viewer${otherViewers === 1 ? '' : 's'} will also reconnect.`
            : 'Any other viewers will also reconnect.';

    function setFields(fields: Partial<ScrcpyServerConfig>): void {
        setPatch((previous) => {
            const next = { ...previous, ...fields };
            if (configKnown) {
                (Object.keys(next) as (keyof ScrcpyServerConfig)[]).forEach((key) => {
                    if (normalized(next, key) === normalized(baseline, key)) {
                        delete next[key];
                    }
                });
            }
            return next;
        });
        setConfirming(false);
        setAppliedNote(undefined);
        setApplyError(undefined);
    }
    const applyConfig = (config: Partial<ScrcpyServerConfig>) => {
        if (!tracker || !Object.keys(config).length || pendingPatch.current) {
            return;
        }
        setConfirming(false);
        setApplying(true);
        setApplyError(undefined);
        setAppliedNote(undefined);
        pendingPatch.current = { ...config };
        // Set the timeout before sending: a synchronous reply must be able to clear it.
        applyTimeoutRef.current = setTimeout(() => {
            applyTimeoutRef.current = undefined;
            pendingPatch.current = undefined;
            pendingRequestId.current = undefined;
            setApplying(false);
            setApplyError(
                'The device has not confirmed the change. Reopen settings to check its current values, or try again.',
            );
        }, APPLY_TIMEOUT_MS);
        pendingRequestId.current = tracker.sendCommand(ControlCenterCommand.UPDATE_STREAM_CONFIG, {
            udid: renderTarget.udid,
            config,
        });
    };
    const onConfirmApply = () => applyConfig(patch);
    const onPlayerChange = (event: Event) => {
        if (!session) {
            return;
        }
        const params: Record<string, string | boolean> = {};
        route.value.forEach((value, key) => {
            params[key] = value;
        });
        closeSettingsSheet();
        navigate({
            ...params,
            action: ACTION.STREAM_SCRCPY,
            udid: session.params.udid,
            player: (event.currentTarget as HTMLSelectElement).value,
            ws: session.params.ws,
            fitToScreen: client?.isFitToScreen(),
            captureKeyboard: captureKeyboard,
        });
    };

    return (
        <BottomSheet
            open={!!target}
            dismissible={!applying}
            onClose={() => {
                if (!applying) {
                    closeSettingsSheet();
                }
            }}
            title="Settings"
        >
            <div class="settings-sheet-content">
                <div class="settings-device-context">
                    <span class="settings-device-dot" aria-hidden="true" />
                    <div>
                        <strong>{entry ? deviceName(entry) : 'Device settings'}</strong>
                        <span>{renderTarget.udid}</span>
                    </div>
                </div>
                <section class="settings-sheet-section">
                    <h2 class="settings-sheet-section-title">Stream quality</h2>
                    <p class="settings-sheet-section-hint">Choose a balance of detail, smoothness, and data use.</p>
                    {loading && (
                        <p class="settings-sheet-banner progress" role="status">
                            Loading current device settings…
                        </p>
                    )}
                    {loadError && (
                        <div class="settings-sheet-banner warning" role="status">
                            <span>{loadError}</span>
                            {tracker && (
                                <button
                                    class="settings-sheet-button"
                                    disabled={applying}
                                    onClick={() => setReload((value) => value + 1)}
                                >
                                    Try again
                                </button>
                            )}
                        </div>
                    )}
                    {!loading && !configKnown && tracker && (
                        <p class="settings-sheet-hint">
                            Current values are unavailable. The values below are suggestions; only your changes will be
                            applied.
                        </p>
                    )}
                    {!loading && codec !== 'h264' && (
                        <div class="settings-sheet-banner warning" role="status">
                            This device is using {codec?.toUpperCase()}, which this app cannot play. Choose a quality
                            preset or H.264 below, then apply the change to restore video.
                        </div>
                    )}
                    <div class="settings-quality-presets" aria-label="Quality presets">
                        {QUALITY_PRESETS.map((preset) => (
                            <button
                                key={preset.name}
                                class="settings-quality-preset"
                                aria-pressed={selectedPreset === preset.name}
                                disabled={locked}
                                onClick={() =>
                                    setFields({
                                        bitrate: preset.bitrate,
                                        maxFps: preset.maxFps,
                                        maxSize: preset.maxSize,
                                        videoCodec: 'h264',
                                        videoEncoder: '',
                                    })
                                }
                            >
                                <span class="settings-preset-mark" aria-hidden="true">
                                    {selectedPreset === preset.name ? '●' : '○'}
                                </span>
                                <strong>{preset.name}</strong>
                                <span>{preset.hint}</span>
                                <small>
                                    {preset.maxSize}px · {preset.maxFps} fps
                                </small>
                            </button>
                        ))}
                    </div>
                    {!loading && (
                        <div class="settings-quality-summary">
                            {selectedPreset || 'Custom quality'} · {formatBitrate(shown.bitrate)} ·{' '}
                            <span>{formatMaxFps(shown.maxFps)}</span>
                        </div>
                    )}
                    <details class="settings-advanced">
                        <summary>Advanced quality settings</summary>
                        <div class="settings-advanced-body">
                            <label class="settings-sheet-row">
                                <span>
                                    Video codec<small>H.264 is the format this app can play</small>
                                </span>
                                <select
                                    value={codec}
                                    onChange={(event) =>
                                        setFields({ videoCodec: event.currentTarget.value, videoEncoder: '' })
                                    }
                                    disabled={locked}
                                >
                                    {codec !== 'h264' && (
                                        <option value={codec} disabled>
                                            {codec?.toUpperCase()} · unsupported here
                                        </option>
                                    )}
                                    {CODEC_OPTIONS.map((option) => (
                                        <option key={option.value} value={option.value}>
                                            {option.label}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label class="settings-sheet-row settings-encoder-row">
                                <span>
                                    Video encoder
                                    <small>Automatic lets the device choose. Hardware encoders are listed first.</small>
                                </span>
                                <select
                                    value={encoder}
                                    onChange={(event) => setFields({ videoEncoder: event.currentTarget.value })}
                                    disabled={locked}
                                >
                                    <option value="">Automatic · device default</option>
                                    {encoder &&
                                        !filteredEncoders.some((candidate) => candidate.encoderName === encoder) && (
                                            <option value={encoder}>{encoder}</option>
                                        )}
                                    {filteredEncoders.map((candidate) => (
                                        <option key={candidate.encoderName} value={candidate.encoderName}>
                                            {candidate.encoderName}
                                            {candidate.hardware === 'hw'
                                                ? ' · hardware'
                                                : candidate.hardware === 'sw'
                                                  ? ' · software'
                                                  : ''}
                                            {candidate.aliasFor ? ' (alias)' : ''}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {!loading && !encoders.length && (
                                <p class="settings-sheet-hint">
                                    No encoders were listed. Automatic uses the device's default encoder.
                                </p>
                            )}
                            <label class="settings-sheet-row">
                                <span>
                                    Bitrate<small>Higher uses more data</small>
                                </span>
                                <select
                                    value={shown.bitrate}
                                    onChange={(event) => setFields({ bitrate: Number(event.currentTarget.value) })}
                                    disabled={locked}
                                >
                                    {numberOptions(BITRATE_OPTIONS, shown.bitrate).map((value) => (
                                        <option key={value} value={value}>
                                            {formatBitrate(value)}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label class="settings-sheet-row">
                                <span>
                                    Frame rate<small>Higher feels smoother</small>
                                </span>
                                <select
                                    value={shown.maxFps}
                                    onChange={(event) => setFields({ maxFps: Number(event.currentTarget.value) })}
                                    disabled={locked}
                                >
                                    {numberOptions(MAX_FPS_OPTIONS, shown.maxFps).map((value) => (
                                        <option key={value} value={value}>
                                            {formatMaxFps(value)}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label class="settings-sheet-row">
                                <span>
                                    Resolution<small>Maximum long edge</small>
                                </span>
                                <select
                                    value={shown.maxSize}
                                    onChange={(event) => setFields({ maxSize: Number(event.currentTarget.value) })}
                                    disabled={locked}
                                >
                                    {numberOptions(MAX_SIZE_OPTIONS, shown.maxSize).map((value) => (
                                        <option key={value} value={value}>
                                            {formatMaxSize(value)}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label class="settings-sheet-row">
                                <span>
                                    Keyframe interval
                                    <small>Shorter recovers faster after a glitch. Longer saves data.</small>
                                </span>
                                <select
                                    value={shown.iFrameInterval}
                                    onChange={(event) =>
                                        setFields({ iFrameInterval: Number(event.currentTarget.value) })
                                    }
                                    disabled={locked}
                                >
                                    {numberOptions(IFRAME_INTERVAL_OPTIONS, shown.iFrameInterval).map((value) => (
                                        <option key={value} value={value}>
                                            {value}s
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </div>
                    </details>
                </section>
                <section class="settings-sheet-section settings-audio">
                    <h2 class="settings-sheet-section-title">Sound</h2>
                    <div class="settings-sheet-card">
                        <label class="settings-sheet-row settings-toggle-row">
                            <span>
                                Capture audio
                                <small>
                                    {audioUnavailableReason ||
                                        (shown.audio
                                            ? 'Capture is on. Tap Listen or Sound to hear it in this browser.'
                                            : 'Enable capture, then apply the change to listen in this browser.')}
                                </small>
                            </span>
                            <input
                                type="checkbox"
                                checked={!!shown.audio}
                                onChange={(event) => setFields({ audio: event.currentTarget.checked })}
                                disabled={locked || (!audioCapable && !shown.audio)}
                            />
                        </label>
                        {!isAudioAvailable() && (
                            <div
                                class="settings-sheet-button-row"
                                data-audio-availability={audioAvailability.value.state}
                            >
                                <button class="settings-sheet-button" onClick={() => location.reload()}>
                                    Reload page
                                </button>
                            </div>
                        )}
                        <label class="settings-sheet-row">
                            <span>
                                Audio source
                                <small>
                                    Device media is what the device plays. Call audio is the far side of a phone call.
                                </small>
                            </span>
                            <select
                                value={shown.audioSource || 'output'}
                                disabled={locked || !shown.audio || !audioCapable}
                                onChange={(event) =>
                                    setFields({
                                        audioSource: event.currentTarget.value as ScrcpyServerConfig['audioSource'],
                                    })
                                }
                            >
                                <option value="output">Device media</option>
                                <option value="voice-call-downlink">Call audio</option>
                            </select>
                        </label>
                        {audioSession && audioStatus && (
                            <>
                                <div
                                    class="settings-sheet-row settings-listen-row"
                                    data-audio-state={audioStatus.state}
                                >
                                    <span>
                                        Listen in this browser<small role="status">{audioStatus.message}</small>
                                    </span>
                                    <div class="settings-sheet-button-row">
                                        {(audioStatus.state === 'error' || audioStatus.state === 'disabled') &&
                                            baseline.audio &&
                                            !hasChanges && (
                                                <button
                                                    class="settings-sheet-button"
                                                    disabled={locked}
                                                    onClick={() => applyConfig({ audio: true })}
                                                >
                                                    Retry audio &amp; restart
                                                </button>
                                            )}
                                        <button
                                            class={`settings-sheet-button ${audioSession.isMuted() || audioStatus.state === 'blocked' ? 'primary' : ''}`}
                                            disabled={
                                                !baseline.audio ||
                                                audioStatus.state === 'disabled' ||
                                                audioStatus.state === 'unsupported' ||
                                                audioStatus.state === 'error'
                                            }
                                            onClick={() =>
                                                audioSession.isMuted() || audioStatus.state === 'blocked'
                                                    ? audioSession.unmute()
                                                    : audioSession.mute()
                                            }
                                        >
                                            {audioSession.isMuted() || audioStatus.state === 'blocked'
                                                ? 'Listen'
                                                : 'Mute sound'}
                                        </button>
                                    </div>
                                </div>
                                <label class="settings-sheet-row settings-volume-row">
                                    <span>
                                        Volume
                                        <small>For this browser only. The device's own volume is not changed.</small>
                                    </span>
                                    <VolumeSlider session={audioSession} />
                                </label>
                            </>
                        )}
                    </div>
                    <details class="settings-advanced">
                        <summary>Audio format</summary>
                        <div class="settings-advanced-body">
                            <label class="settings-sheet-row">
                                <span>
                                    Format
                                    <small>
                                        PCM plays in every browser and uses about 1.5 Mbps. Opus uses less data and
                                        needs HTTPS.
                                    </small>
                                </span>
                                <select
                                    value={shown.audioCodec || 'raw'}
                                    disabled={locked || !shown.audio || !audioCapable}
                                    onChange={(event) =>
                                        setFields({
                                            audioCodec: event.currentTarget.value as ScrcpyServerConfig['audioCodec'],
                                        })
                                    }
                                >
                                    <option value="raw">Compatible · PCM</option>
                                    <option value="opus">Lower data use · Opus</option>
                                </select>
                            </label>
                        </div>
                    </details>
                    {!client && (
                        <p class="settings-sheet-hint">After applying, open the screen and tap Sound to listen.</p>
                    )}
                </section>
                {client ? (
                    <details class="settings-playback">
                        <summary>
                            Playback &amp; keyboard<span>This browser only</span>
                        </summary>
                        <div class="settings-advanced-body">
                            <p class="settings-sheet-section-hint">Changes here apply instantly.</p>
                            <label class="settings-sheet-row">
                                <span>
                                    Video player
                                    <small>The decoder this browser uses. Changing it reloads the stream.</small>
                                </span>
                                <select value={session?.params.player} onChange={onPlayerChange} disabled={applying}>
                                    {StreamClientScrcpy.getPlayers().map((player) => (
                                        <option key={player.playerCodeName} value={player.playerCodeName}>
                                            {player.playerFullName}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label class="settings-sheet-row settings-toggle-row">
                                <span>
                                    Fit screen<small>Keep the full device visible</small>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={fitToScreen}
                                    onChange={(event) => {
                                        setFitToScreenState(event.currentTarget.checked);
                                        client.setFitToScreen(event.currentTarget.checked);
                                    }}
                                />
                            </label>
                            <label class="settings-sheet-row settings-toggle-row">
                                <span>
                                    Show quality stats
                                    <small>Overlays bitrate, frame rate and decode timing on the video</small>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={showStats}
                                    onChange={(event) => {
                                        setShowStats(event.currentTarget.checked);
                                        client.getPlayer()?.setShowQualityStats(event.currentTarget.checked);
                                    }}
                                />
                            </label>
                            <label class="settings-sheet-row settings-toggle-row">
                                <span>
                                    Physical keyboard<small>Send hardware keystrokes to the device</small>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={captureKeyboard}
                                    onChange={(event) => {
                                        setCaptureKeyboard(event.currentTarget.checked);
                                        client.setHandleKeyboardEvents(event.currentTarget.checked, useUhid);
                                    }}
                                />
                            </label>
                            <label class="settings-sheet-row settings-toggle-row">
                                <span>
                                    Native keyboard (UHID)<small>Use the device's keyboard layout · Android 11+</small>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={useUhid}
                                    disabled={!captureKeyboard}
                                    onChange={(event) => {
                                        setUseUhid(event.currentTarget.checked);
                                        if (captureKeyboard) {
                                            client.setHandleKeyboardEvents(true, event.currentTarget.checked);
                                        }
                                    }}
                                />
                            </label>
                        </div>
                    </details>
                ) : (
                    <p class="settings-sheet-hint">
                        Open this device's screen to adjust playback and keyboard options.
                    </p>
                )}
                <div class="settings-sheet-apply-bar">
                    {applyError && (
                        <div class="settings-sheet-banner error" role="alert">
                            {applyError}
                        </div>
                    )}
                    {appliedNote && !hasChanges && !applying && (
                        <div class="settings-sheet-banner success" role="status">
                            {appliedNote}
                        </div>
                    )}
                    {applying ? (
                        <div class="settings-sheet-banner progress" role="status">
                            Saving settings… The screen will reconnect automatically.
                        </div>
                    ) : confirming ? (
                        <div class="settings-sheet-banner warning">
                            <strong>Restart this device's stream?</strong>
                            <p>The screen will pause for a few seconds. {viewerWarning}</p>
                            <div class="settings-sheet-button-row">
                                <button class="settings-sheet-button" onClick={() => setConfirming(false)}>
                                    Keep editing
                                </button>
                                <button class="settings-sheet-button primary" onClick={onConfirmApply}>
                                    Apply &amp; restart
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <p class="settings-apply-note">
                                {hasChanges
                                    ? 'Capture changes restart the stream for every viewer.'
                                    : 'Capture settings apply to every viewer of this device.'}
                            </p>
                            <div class="settings-sheet-button-row">
                                <button
                                    class="settings-sheet-button"
                                    onClick={() => {
                                        setPatch({});
                                        setConfirming(false);
                                        setApplyError(undefined);
                                    }}
                                    disabled={!hasChanges || locked}
                                >
                                    Discard
                                </button>
                                <button
                                    class="settings-sheet-button primary"
                                    onClick={() => setConfirming(true)}
                                    disabled={!hasChanges || locked}
                                >
                                    Apply changes
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </BottomSheet>
    );
}
