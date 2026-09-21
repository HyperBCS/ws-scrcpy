import { useEffect, useMemo, useState } from 'preact/hooks';
import { DeviceEntry, deviceName } from '../state/devices';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import { DeviceState } from '../../common/DeviceState';
import { ACTION } from '../../common/Action';
import { ControlCenterCommand } from '../../common/ControlCenterCommand';
import { Tool, ToolEntry } from '../client/Tool';
import { DeviceTracker as GoogDeviceTracker } from '../googDevice/client/DeviceTracker';
import { DeviceTracker as ApplDeviceTracker } from '../applDevice/client/DeviceTracker';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import {
    buildInterfaceOptions,
    pickDefaultInterfaceName,
    rememberSelectedInterface,
} from '../googDevice/client/deviceInterfaces';
import Util from '../Util';
import { buildLinkHref, isLocalLink } from '../state/links';
import { NavigateParams } from '../state/router';
import { DeviceStatusInfo, getDeviceStatusInfo, isDeviceStarting, markStarting } from '../state/deviceStatus';
import { sendWakeKey } from '../googDevice/client/wake';
import { openSettingsSheet } from '../state/settingsSheet';
import { isToolAction } from './ToolView';
import { StreamServiceStatus } from '../ui/StreamServiceStatus';
import { hasRunningStreamService } from '../state/streamService';
import { DeviceIcon } from '../ui/DeviceIcon';

function collectTools(tools: Set<Tool>, descriptor: GoogDeviceDescriptor | ApplDeviceDescriptor): ToolEntry[] {
    const result: ToolEntry[] = [];
    tools.forEach((tool) => {
        const entry = tool.createEntryForDeviceList(descriptor);
        if (entry) {
            result.push(...(Array.isArray(entry) ? entry : [entry]));
        }
    });
    return result;
}

interface NavLinkProps {
    entry: ToolEntry;
    params: ParamsDeviceTracker;
    className?: string;
}

function NavLink({ entry, params, className }: NavLinkProps) {
    const query: NavigateParams = { action: entry.action, ...entry.params };
    const href = buildLinkHref(query, params);
    const local =
        isLocalLink(params) &&
        (entry.action === ACTION.STREAM_SCRCPY ||
            entry.action === ACTION.STREAM_COREDEVICE ||
            isToolAction(entry.action));
    const onClick = (event: MouseEvent) => {
        if (!local || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
        }
        event.preventDefault();
        // Use the complete link so proxied remote-host details survive SPA navigation too.
        location.hash = new URL(href).hash;
    };
    return (
        <a
            class={className}
            href={href}
            onClick={onClick}
            target={local ? undefined : '_blank'}
            rel={local ? undefined : 'noopener noreferrer'}
        >
            {entry.title}
        </a>
    );
}

function StatusBadge({ info }: { info: DeviceStatusInfo }) {
    return (
        <span class="device-status" style={{ color: info.color }} title={`Status: ${info.label}`}>
            <span class="device-status-icon" aria-hidden="true">
                {info.icon}
            </span>
            <span class="device-status-label">{info.label}</span>
        </span>
    );
}

function UnavailableHint({ info }: { info: DeviceStatusInfo }) {
    return (
        <p class="device-unavailable-hint">
            {info.status === 'unauthorized'
                ? 'Unlock this device and approve the USB debugging or trust prompt to connect.'
                : 'Check the device connection and keep it connected to the server.'}
        </p>
    );
}

function GoogDeviceCard({ entry, descriptor }: { entry: DeviceEntry; descriptor: GoogDeviceDescriptor }) {
    const { params, tracker } = entry;
    const isActive = descriptor.state === DeviceState.DEVICE;
    const hasPid = hasRunningStreamService(descriptor.pid);
    const isStarting = !hasPid && isDeviceStarting(entry.key);
    const fullName = `${entry.trackerId}_${Util.escapeUdid(descriptor.udid)}`;
    const statusInfo = getDeviceStatusInfo(entry);
    const isAsleep = statusInfo.status === 'asleep';
    const options = useMemo(() => buildInterfaceOptions(descriptor, params), [descriptor, params]);
    const [selectedName, setSelectedName] = useState(() => pickDefaultInterfaceName(descriptor, fullName));
    const selected = options.find((option) => option.name === selectedName) ?? options[options.length - 1];
    const players = StreamClientScrcpy.getPlayers();
    const primaryPlayer = players.find((player) => player.playerCodeName === 'webcodecs') ?? players[0];
    const tools = collectTools(GoogDeviceTracker.tools, descriptor);
    const streamEntry = (player: typeof primaryPlayer, title: string): ToolEntry => ({
        title,
        action: ACTION.STREAM_SCRCPY,
        params: { udid: descriptor.udid, player: player.playerCodeName, ws: selected?.url, fitToScreen: 'true' },
    });
    const onAction = () => {
        if (!isActive || isStarting) {
            return;
        }
        if (!hasPid) {
            markStarting(entry.key);
        }
        tracker.sendCommand(hasPid ? ControlCenterCommand.KILL_SERVER : ControlCenterCommand.START_SERVER, {
            udid: descriptor.udid,
            pid: hasPid ? descriptor.pid : undefined,
        });
    };

    return (
        <article
            class={`device ${isActive ? 'active' : 'not-active'} ${isAsleep ? 'asleep' : ''}`}
            data-device-key={entry.key}
        >
            <div class="device-header">
                <DeviceIcon className="device-avatar" />
                <div class="device-heading">
                    <div class="device-name">{deviceName(entry)}</div>
                    <div class="device-meta">
                        <span>Android {descriptor['ro.build.version.release'] || 'device'}</span>
                        {descriptor['battery.level'] >= 0 && (
                            <span
                                class="device-battery"
                                title={descriptor['battery.charging'] ? 'Charging' : 'On battery'}
                            >
                                {descriptor['battery.level']}%{descriptor['battery.charging'] ? ' · Charging' : ''}
                            </span>
                        )}
                        <span class="device-serial" title="Device serial">
                            {descriptor.udid}
                        </span>
                    </div>
                </div>
                <StatusBadge info={statusInfo} />
            </div>
            <StreamServiceStatus descriptor={descriptor} deviceKey={entry.key} />
            {isAsleep && (
                <div class="device-asleep-banner">
                    <span aria-hidden="true">☾</span>
                    <span>Screen is asleep.</span>
                    {hasPid && selected && (
                        <button class="wake-button" onClick={() => sendWakeKey(descriptor.udid, selected.url)}>
                            Wake
                        </button>
                    )}
                </div>
            )}
            {!isActive && <UnavailableHint info={statusInfo} />}
            <div class="services device-primary-actions">
                {isActive && selected && primaryPlayer ? (
                    <NavLink
                        className="desc-block stream primary"
                        params={params}
                        entry={streamEntry(primaryPlayer, 'Open screen →')}
                    />
                ) : (
                    <button class="desc-block stream unavailable" disabled>
                        {isActive ? 'Browser cannot play this stream' : 'Device unavailable'}
                    </button>
                )}
                {isActive && (
                    <button
                        class="action-button stream-settings-button"
                        title="Stream settings"
                        aria-label={`Settings for ${deviceName(entry)}`}
                        onClick={() => openSettingsSheet(descriptor.udid, entry.key)}
                    >
                        Settings
                    </button>
                )}
            </div>
            {isActive && (
                <details class="device-details">
                    <summary>Connection &amp; tools</summary>
                    <div class="device-details-content">
                        <label class="device-interface">
                            <span>Connection</span>
                            <select
                                aria-label={`Connection for ${deviceName(entry)}`}
                                value={selected?.name}
                                onChange={(event) => {
                                    const name = event.currentTarget.value;
                                    setSelectedName(name);
                                    rememberSelectedInterface(fullName, name);
                                }}
                            >
                                {options.map((option) => (
                                    <option key={option.name} value={option.name}>
                                        {option.name === 'proxy' ? 'Automatic · via server' : option.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <div class="services device-secondary-actions">
                            <button
                                class="action-button update-interfaces-button"
                                onClick={() =>
                                    tracker.sendCommand(ControlCenterCommand.UPDATE_INTERFACES, {
                                        udid: descriptor.udid,
                                    })
                                }
                            >
                                Refresh connection
                            </button>
                            <button
                                class="action-button kill-server-button"
                                onClick={onAction}
                                disabled={isStarting}
                                title={hasPid ? 'Stops the stream for every viewer' : 'Start the streaming service'}
                            >
                                {hasPid ? 'Stop stream service' : isStarting ? 'Starting…' : 'Start stream service'}
                            </button>
                            {selected &&
                                players
                                    .filter((player) => player !== primaryPlayer)
                                    .map((player) => (
                                        <NavLink
                                            key={player.playerCodeName}
                                            className="desc-block stream alternative"
                                            params={params}
                                            entry={streamEntry(player, `Open with ${player.playerFullName}`)}
                                        />
                                    ))}
                            {tools.map((tool, index) => (
                                <NavLink
                                    key={`${tool.action}_${index}`}
                                    className="desc-block"
                                    params={params}
                                    entry={tool}
                                />
                            ))}
                        </div>
                    </div>
                </details>
            )}
        </article>
    );
}

function ApplDeviceCard({ entry, descriptor }: { entry: DeviceEntry; descriptor: ApplDeviceDescriptor }) {
    const isActive = descriptor.state === DeviceState.CONNECTED;
    const tools = collectTools(ApplDeviceTracker.tools, descriptor);
    const statusInfo = getDeviceStatusInfo(entry);
    const [enabling, setEnabling] = useState(false);
    const [feedback, setFeedback] = useState('');
    const [debugOpen, setDebugOpen] = useState(false);
    const [busy, setBusy] = useState('');
    const developerMode = descriptor.developerMode;
    const session = descriptor.session ?? 'stopped';

    /**
     * Debug actions live here as well as in the stream page's Actions sheet, because the failures
     * they recover from (a wedged session, an unmounted developer image) are exactly the ones that
     * leave no working stream page to open.
     */
    const runCommand = (command: string, label: string, done: string) => {
        setBusy(label);
        setFeedback(`${label}…`);
        const tracker = entry.tracker;
        const onReply = (data: { udid?: string; error?: string; result?: unknown }) => {
            if (data.udid !== descriptor.udid) {
                return;
            }
            tracker.off(command as never, onReply as never);
            setBusy('');
            setFeedback(data.error || (typeof data.result === 'string' && data.result) || done);
        };
        tracker.on(command as never, onReply as never);
        tracker.sendCommand(command, { udid: descriptor.udid });
    };

    useEffect(() => {
        if (!enabling) {
            return;
        }
        const tracker = entry.tracker;
        const onReply = (data: { udid?: string; error?: string; result?: unknown }) => {
            if (data.udid !== descriptor.udid) {
                return;
            }
            setEnabling(false);
            setFeedback(data.error ? data.error : 'Developer Mode is on.');
        };
        tracker.on(ControlCenterCommand.ENABLE_DEVELOPER_MODE as never, onReply as never);
        return () => tracker.off(ControlCenterCommand.ENABLE_DEVELOPER_MODE as never, onReply as never);
    }, [enabling, entry.tracker, descriptor.udid]);

    const enableDeveloperMode = () => {
        setEnabling(true);
        setFeedback('Enabling Developer Mode… the phone will restart and ask you to confirm.');
        entry.tracker.sendCommand(ControlCenterCommand.ENABLE_DEVELOPER_MODE, { udid: descriptor.udid });
    };

    const isAsleep = statusInfo.status === 'asleep';

    return (
        <article
            class={`device ${isActive ? 'active' : 'not-active'} ${isAsleep ? 'asleep' : ''}`}
            data-device-key={entry.key}
        >
            <div class="device-header">
                <DeviceIcon className="device-avatar" />
                <div class="device-heading">
                    <div class="device-name">{deviceName(entry)}</div>
                    <div class="device-meta">
                        <span>iOS {descriptor.version}</span>
                        <span>{descriptor.model}</span>
                        <span class="device-serial" title="Device serial">
                            {descriptor.udid}
                        </span>
                    </div>
                </div>
                <StatusBadge info={statusInfo} />
            </div>
            {!isActive && (
                <p class="device-unavailable-hint">
                    {descriptor.state === 'unauthorized'
                        ? 'Unlock the phone and tap "Trust" on the "Trust This Computer?" prompt.'
                        : 'Check the USB connection and keep the phone connected to the server.'}
                </p>
            )}
            {isAsleep && (
                <div class="device-asleep-banner" role="status">
                    <span aria-hidden="true">☾</span>
                    <span>Screen is asleep. Open the screen and tap it to wake the phone.</span>
                </div>
            )}
            {isActive && developerMode === false && (
                <div class="device-asleep-banner" role="status">
                    <span aria-hidden="true">⚠</span>
                    <span>Developer Mode is off. The screen and touch services need it.</span>
                    <button class="wake-button" onClick={enableDeveloperMode} disabled={enabling}>
                        {enabling ? 'Enabling…' : 'Enable'}
                    </button>
                </div>
            )}
            {isActive && session === 'error' && descriptor.sessionMessage && (
                <p class="device-unavailable-hint">{descriptor.sessionMessage}</p>
            )}
            {feedback && <p class="device-unavailable-hint">{feedback}</p>}
            <div class="services device-primary-actions">
                {isActive ? (
                    tools.map((tool, index) => (
                        <NavLink
                            key={`${tool.action}_${index}`}
                            className={`desc-block ${index === 0 ? 'stream primary' : ''}`}
                            params={entry.params}
                            entry={tool}
                        />
                    ))
                ) : (
                    <button class="desc-block stream unavailable" disabled>
                        {descriptor.state === 'unauthorized' ? 'Waiting for trust' : 'Device unavailable'}
                    </button>
                )}
                {isActive && (session === 'ready' || session === 'starting') && (
                    <button
                        class="action-button"
                        title="Stops the screen stream for every viewer"
                        onClick={() =>
                            entry.tracker.sendCommand(ControlCenterCommand.KILL_SERVER, {
                                udid: descriptor.udid,
                                pid: 1,
                            })
                        }
                    >
                        Stop stream
                    </button>
                )}
            </div>
            <div class="device-debug">
                <button
                    type="button"
                    class="device-debug-toggle"
                    aria-expanded={debugOpen}
                    onClick={() => setDebugOpen(!debugOpen)}
                >
                    {debugOpen ? '▾' : '▸'} Debug
                </button>
                {debugOpen && (
                    <div class="device-debug-body">
                        <dl class="device-debug-facts">
                            <dt>Session</dt>
                            <dd>{session}</dd>
                            <dt>Paired</dt>
                            <dd>{descriptor.paired === false ? 'no' : 'yes'}</dd>
                            <dt>Developer Mode</dt>
                            <dd>
                                {developerMode === 'unknown' || developerMode === undefined
                                    ? 'unknown'
                                    : developerMode
                                      ? 'on'
                                      : 'off'}
                            </dd>
                        </dl>
                        <p class="device-unavailable-hint">
                            Restart services when the picture works but touch, the keyboard or the clipboard do not.
                            Remount when the phone has rebooted or the screen will not start at all.
                        </p>
                        <div class="device-debug-actions">
                            <button
                                type="button"
                                class="action-button"
                                disabled={!!busy || !isActive}
                                title="Ends the phone session so the next viewer gets a fresh one"
                                onClick={() =>
                                    runCommand(
                                        ControlCenterCommand.RESTART_SESSION,
                                        'Restarting services',
                                        'Services restarted. Open the screen again.',
                                    )
                                }
                            >
                                Restart services
                            </button>
                            <button
                                type="button"
                                class="action-button"
                                disabled={!!busy || !isActive}
                                onClick={() =>
                                    runCommand(
                                        ControlCenterCommand.REMOUNT_DDI,
                                        'Remounting the developer image',
                                        'Developer image mounted.',
                                    )
                                }
                            >
                                Remount developer image
                            </button>
                            <button
                                type="button"
                                class="action-button"
                                disabled={!!busy}
                                onClick={() =>
                                    runCommand(
                                        ControlCenterCommand.REFRESH_DEVICE,
                                        'Refreshing',
                                        'Device info refreshed.',
                                    )
                                }
                            >
                                Refresh info
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </article>
    );
}

export function DeviceCard({ entry }: { entry: DeviceEntry }) {
    return entry.params.type === 'android' ? (
        <GoogDeviceCard entry={entry} descriptor={entry.descriptor as GoogDeviceDescriptor} />
    ) : (
        <ApplDeviceCard entry={entry} descriptor={entry.descriptor as ApplDeviceDescriptor} />
    );
}
