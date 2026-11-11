import { ComponentChildren } from 'preact';
import { AnimatedDetails } from '../ui/AnimatedDetails';
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
import { streamSocketUrl } from '../googDevice/client/deviceInterfaces';
import { buildLinkHref, isLocalLink } from '../state/links';
import { NavigateParams } from '../state/router';
import { DeviceStatusInfo, getDeviceStatusInfo, isDeviceStarting, markStarting } from '../state/deviceStatus';
import { sendWakeKey } from '../googDevice/client/wake';
import { openApplSettingsSheet, openSettingsSheet } from '../state/settingsSheet';
import { unlockCardLine } from '../state/unlockSchedule';
import { isToolAction } from './ToolView';
import { StreamServiceStatus } from '../ui/StreamServiceStatus';
import { hasRunningStreamService } from '../state/streamService';
import { notificationSummary } from '../state/notifications';
import { UnreadBadge } from './NotificationHistory';
import { DeviceIcon } from '../ui/DeviceIcon';
import { ConfirmPrompt, useArmedAction } from '../ui/ConfirmAction';

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
            class={`ui-button ${className || ''}`}
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

function DeviceHeader({
    entry,
    platform,
    children,
}: {
    entry: DeviceEntry;
    platform: string;
    children?: ComponentChildren;
}) {
    return (
        <div class="device-header">
            <DeviceIcon className="device-avatar" />
            <div class="device-heading">
                <div class="device-name">{deviceName(entry)}</div>
                <div class="device-meta">
                    <span>{platform}</span>
                    {children}
                </div>
            </div>
            <StatusBadge info={getDeviceStatusInfo(entry)} />
        </div>
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

/** A recovery action: what it costs is written beside the button, not in a tooltip. */
function TroubleRow({
    title,
    description,
    children,
}: {
    title: string;
    description: string;
    children: ComponentChildren;
}) {
    return (
        <div class="device-trouble-row">
            <div class="device-trouble-text">
                <span class="device-trouble-title">{title}</span>
                <span class="device-trouble-desc">{description}</span>
            </div>
            {children}
        </div>
    );
}

function GoogDeviceCard({ entry, descriptor }: { entry: DeviceEntry; descriptor: GoogDeviceDescriptor }) {
    const { params, tracker } = entry;
    const isActive = descriptor.state === DeviceState.DEVICE;
    const hasPid = hasRunningStreamService(descriptor.pid);
    const isStarting = !hasPid && isDeviceStarting(entry.key);
    const statusInfo = getDeviceStatusInfo(entry);
    const isAsleep = statusInfo.status === 'asleep';
    // Every Android stream goes through the server, which reaches the phone over adb.
    const socketUrl = useMemo(() => streamSocketUrl(descriptor.udid, params), [descriptor.udid, params]);
    const players = StreamClientScrcpy.getPlayers();
    const primaryPlayer = players.find((player) => player.playerCodeName === 'webcodecs') ?? players[0];
    const tools = collectTools(GoogDeviceTracker.tools, descriptor);
    const streamEntry = (player: typeof primaryPlayer, title: string): ToolEntry => ({
        title,
        action: ACTION.STREAM_SCRCPY,
        params: { udid: descriptor.udid, player: player.playerCodeName, ws: socketUrl, fitToScreen: 'true' },
    });
    const confirm = useArmedAction<'stop'>();
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
            <DeviceHeader entry={entry} platform={`Android ${descriptor['ro.build.version.release'] || ''}`}>
                {descriptor['battery.level'] >= 0 && (
                    <span class="device-battery" title={descriptor['battery.charging'] ? 'Charging' : 'On battery'}>
                        {descriptor['battery.level']}%{descriptor['battery.charging'] ? ' · Charging' : ''}
                    </span>
                )}
            </DeviceHeader>
            <StreamServiceStatus descriptor={descriptor} deviceKey={entry.key} />
            {isAsleep && (
                <div class="device-asleep-banner">
                    <span aria-hidden="true">☾</span>
                    <span>Screen is asleep.</span>
                    {hasPid && (
                        <button class="wake-button" onClick={() => sendWakeKey(descriptor.udid, socketUrl)}>
                            Wake
                        </button>
                    )}
                </div>
            )}
            {!isActive && <UnavailableHint info={statusInfo} />}
            <div class="services device-primary-actions">
                {isActive && primaryPlayer ? (
                    <NavLink
                        className="desc-block stream primary"
                        params={params}
                        entry={streamEntry(primaryPlayer, 'Open screen')}
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
                <AnimatedDetails class="device-details">
                    <summary>Connection &amp; tools</summary>
                    <div class="device-details-content">
                        <p class="device-serial" title="Device serial">
                            {descriptor.udid}
                        </p>
                        <div class="device-interface">
                            <span>Connection</span>
                            <span class="device-connection-value">Automatic · via server</span>
                        </div>
                        <div class="services device-secondary-actions">
                            {players
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
                        <div class="device-trouble" role="group" aria-label="Troubleshooting">
                            <h4 class="device-trouble-heading">Troubleshooting</h4>
                            <TroubleRow
                                title="Stream service"
                                description={
                                    hasPid
                                        ? 'Running. Stopping it ends the stream for every viewer.'
                                        : isStarting
                                          ? 'Starting.'
                                          : 'Stopped. Start it to open the screen.'
                                }
                            >
                                <button
                                    class={`action-button kill-server-button ${hasPid ? 'danger' : ''}`}
                                    aria-label={hasPid ? 'Stop stream service' : 'Start stream service'}
                                    disabled={isStarting}
                                    onClick={(event) =>
                                        hasPid ? confirm.arm('stop', event.currentTarget) : onAction()
                                    }
                                >
                                    {hasPid ? 'Stop' : isStarting ? 'Starting…' : 'Start'}
                                </button>
                            </TroubleRow>
                            {confirm.armed && hasPid && (
                                <ConfirmPrompt
                                    action={confirm}
                                    question={`Stop the stream service on ${deviceName(entry)}?`}
                                    consequence="The stream ends for every viewer until the service is started again."
                                    confirmLabel="Stop stream service"
                                    danger
                                    onConfirm={onAction}
                                />
                            )}
                        </div>
                    </div>
                </AnimatedDetails>
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
    const [busy, setBusy] = useState('');
    const confirm = useArmedAction<'developer-mode' | 'stop' | 'restart' | 'remount'>();
    const name = deviceName(entry);
    const developerMode = descriptor.developerMode;
    const session = descriptor.session ?? 'stopped';
    // A prompt shows only while its button can be used, so a session that stops or a phone that
    // disconnects in the meantime does not leave a confirm for an action that no longer applies.
    const canStop = isActive && (session === 'ready' || session === 'starting');
    const canRecover = isActive && !busy;

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
    const unlockLine = descriptor.unlockSchedule && unlockCardLine(descriptor.unlockSchedule);

    return (
        <article
            class={`device ${isActive ? 'active' : 'not-active'} ${isAsleep ? 'asleep' : ''}`}
            data-device-key={entry.key}
        >
            <DeviceHeader entry={entry} platform={`iOS ${descriptor.version}`}>
                {unlockLine && (
                    <span
                        class={`device-unlock-schedule ${unlockLine.problem ? 'problem' : ''}`}
                        title={unlockLine.title}
                    >
                        {unlockLine.text}
                    </span>
                )}
            </DeviceHeader>
            <StreamServiceStatus
                descriptor={{
                    state: isActive ? DeviceState.DEVICE : descriptor.state,
                    pid: session === 'ready' ? 1 : -1,
                }}
                session={session}
            />
            {!isActive && <UnavailableHint info={statusInfo} />}
            {isAsleep && (
                <div class="device-asleep-banner" role="status">
                    <span aria-hidden="true">☾</span>
                    <span>Screen is asleep.</span>
                </div>
            )}
            {isActive && developerMode === false && (
                <div class="device-asleep-banner" role="status">
                    <span aria-hidden="true">⚠</span>
                    <span>Enable Developer Mode to open the screen.</span>
                    <button
                        class="wake-button"
                        onClick={(event) => confirm.arm('developer-mode', event.currentTarget)}
                        disabled={enabling}
                    >
                        {enabling ? 'Enabling…' : 'Enable and restart'}
                    </button>
                </div>
            )}
            {confirm.armed === 'developer-mode' && isActive && developerMode === false && (
                <ConfirmPrompt
                    action={confirm}
                    question={`Enable Developer Mode on ${name}?`}
                    consequence="The phone restarts, then asks you to confirm on its screen."
                    confirmLabel="Enable and restart"
                    danger
                    onConfirm={enableDeveloperMode}
                />
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
                            entry={{ ...tool, title: index === 0 ? 'Open screen' : tool.title }}
                        />
                    ))
                ) : (
                    <button class="desc-block stream unavailable" disabled>
                        {descriptor.state === 'unauthorized' ? 'Waiting for trust' : 'Device unavailable'}
                    </button>
                )}
                {isActive && (
                    <button
                        class="action-button stream-settings-button"
                        title="iPhone settings"
                        aria-label={`Settings for ${deviceName(entry)}`}
                        onClick={() => openApplSettingsSheet(descriptor.udid, entry.key)}
                    >
                        Settings
                    </button>
                )}
                <a
                    class="ui-button device-notification-history"
                    href={`#!${new URLSearchParams({ action: 'notifications', source: descriptor.udid })}`}
                >
                    Notifications <UnreadBadge count={notificationSummary.value.unreadBySource[descriptor.udid] || 0} />
                </a>
            </div>
            <AnimatedDetails class="device-details">
                <summary>Connection &amp; tools</summary>
                <div class="device-details-content device-debug-body">
                    <div class="device-interface">
                        <span>Connection</span>
                        <span class="device-connection-value">Automatic · via server</span>
                    </div>
                    <dl class="device-debug-facts">
                        <dt>Device</dt>
                        <dd>{descriptor.model}</dd>
                        <dt>Serial</dt>
                        <dd class="device-serial">{descriptor.udid}</dd>
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
                    <div class="device-debug-actions">
                        <button
                            type="button"
                            class="action-button"
                            disabled={!!busy}
                            onClick={() =>
                                runCommand(ControlCenterCommand.REFRESH_DEVICE, 'Refreshing', 'Device info refreshed.')
                            }
                        >
                            Refresh info
                        </button>
                    </div>
                    <div class="device-trouble" role="group" aria-label="Troubleshooting">
                        <h4 class="device-trouble-heading">Troubleshooting</h4>
                        {canStop && (
                            <TroubleRow
                                title="Stop stream service"
                                description="Ends the screen stream for every viewer."
                            >
                                <button
                                    type="button"
                                    class="action-button danger"
                                    aria-label="Stop stream service"
                                    onClick={(event) => confirm.arm('stop', event.currentTarget)}
                                >
                                    Stop
                                </button>
                            </TroubleRow>
                        )}
                        <TroubleRow
                            title="Restart services"
                            description="Use if controls stop responding. Ends the phone session for every viewer."
                        >
                            <button
                                type="button"
                                class="action-button danger"
                                aria-label="Restart services"
                                disabled={!canRecover}
                                onClick={(event) => confirm.arm('restart', event.currentTarget)}
                            >
                                Restart
                            </button>
                        </TroubleRow>
                        <TroubleRow
                            title="Remount developer image"
                            description="Use if the screen will not start. Ends the phone session first."
                        >
                            <button
                                type="button"
                                class="action-button danger"
                                aria-label="Remount developer image"
                                disabled={!canRecover}
                                onClick={(event) => confirm.arm('remount', event.currentTarget)}
                            >
                                Remount
                            </button>
                        </TroubleRow>
                        {confirm.armed === 'stop' && canStop && (
                            <ConfirmPrompt
                                action={confirm}
                                question={`Stop the stream service on ${name}?`}
                                consequence="The screen stream ends for every viewer. Open the screen to start it again."
                                confirmLabel="Stop stream service"
                                danger
                                onConfirm={() =>
                                    entry.tracker.sendCommand(ControlCenterCommand.KILL_SERVER, {
                                        udid: descriptor.udid,
                                        pid: 1,
                                    })
                                }
                            />
                        )}
                        {confirm.armed === 'restart' && canRecover && (
                            <ConfirmPrompt
                                action={confirm}
                                question={`Restart services on ${name}?`}
                                consequence="The phone session ends for every viewer. The next viewer gets a new one."
                                confirmLabel="Restart services"
                                danger
                                onConfirm={() =>
                                    runCommand(
                                        ControlCenterCommand.RESTART_SESSION,
                                        'Restarting services',
                                        'Services restarted. Open the screen again.',
                                    )
                                }
                            />
                        )}
                        {confirm.armed === 'remount' && canRecover && (
                            <ConfirmPrompt
                                action={confirm}
                                question={`Remount the developer image on ${name}?`}
                                consequence="The phone session ends for every viewer while the image is reloaded."
                                confirmLabel="Remount"
                                danger
                                onConfirm={() =>
                                    runCommand(
                                        ControlCenterCommand.REMOUNT_DDI,
                                        'Remounting the developer image',
                                        'Developer image mounted.',
                                    )
                                }
                            />
                        )}
                    </div>
                </div>
            </AnimatedDetails>
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
