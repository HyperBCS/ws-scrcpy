import { ComponentChildren } from 'preact';
import { AnimatedDetails } from '../ui/AnimatedDetails';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { canOpenScreen, DeviceEntry, deviceName } from '../state/devices';
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
import {
    DeviceStatusInfo,
    getDeviceProblems,
    getDeviceStatusInfo,
    isDeviceStarting,
    markStarting,
} from '../state/deviceStatus';
import { AsleepBanner } from '../ui/AsleepBanner';
import { openApplSettingsSheet, openSettingsSheet } from '../state/settingsSheet';
import { unlockCardLine } from '../state/unlockSchedule';
import { replyText, sendServiceCommand, TrackerCommandAborted } from '../client/trackerCommand';
import { deviceTools, isToolAction } from './ToolView';
import { StreamServiceStatus } from '../ui/StreamServiceStatus';
import { hasRunningStreamService } from '../state/streamService';
import { notificationSummary } from '../state/notifications';
import { isNotificationSource } from '../state/notificationsTarget';
import { rememberCardOpen, wasCardOpen } from '../state/deviceListView';
import { UnreadBadge } from './NotificationHistory';
import { DeviceIcon } from '../ui/DeviceIcon';
import { BellIcon } from '../ui/NotificationsLink';
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
        <span
            class="device-status"
            data-status={info.status}
            style={{ '--status-color': info.color }}
            title={`Status: ${info.label}`}
        >
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

/** Settings is an icon on every card, so the action row is the same width on both platforms. */
function SettingsButton({ title, name, onClick }: { title: string; name: string; onClick: () => void }) {
    return (
        <button
            type="button"
            class="action-button stream-settings-button"
            title={title}
            aria-label={`Settings for ${name}`}
            onClick={onClick}
        >
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
            >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
        </button>
    );
}

/** The card's disclosure. It reopens on return to Devices if it was open when the page was left. */
function CardDetails({ deviceKey, children }: { deviceKey: string; children: ComponentChildren }) {
    const [initiallyOpen] = useState(() => wasCardOpen(deviceKey));
    return (
        <AnimatedDetails
            class="device-details"
            open={initiallyOpen}
            onToggle={(event) => rememberCardOpen(deviceKey, (event.currentTarget as HTMLDetailsElement).open)}
        >
            <summary>Details</summary>
            {children}
        </AnimatedDetails>
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
    // Files, then Shell: the order of the tabs on the tool page.
    const toolOrder = (tool: ToolEntry) => deviceTools.findIndex((item) => item.action === tool.action);
    const tools = collectTools(GoogDeviceTracker.tools, descriptor).sort((a, b) => toolOrder(a) - toolOrder(b));
    const streamEntry = (player: typeof primaryPlayer, title: string): ToolEntry => ({
        title,
        action: ACTION.STREAM_SCRCPY,
        params: { udid: descriptor.udid, player: player.playerCodeName, ws: socketUrl },
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
            {isAsleep && <AsleepBanner tracker={tracker} udid={descriptor.udid} />}
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
                    <SettingsButton
                        title="Stream settings"
                        name={deviceName(entry)}
                        onClick={() => openSettingsSheet(descriptor.udid, entry.key)}
                    />
                )}
            </div>
            {isActive && tools.length > 0 && (
                <div class="services device-tool-actions">
                    {tools.map((tool, index) => (
                        <NavLink key={`${tool.action}_${index}`} className="desc-block" params={params} entry={tool} />
                    ))}
                </div>
            )}
            {isActive && (
                <CardDetails deviceKey={entry.key}>
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
                                          : 'Stopped. It starts when the screen is opened.'
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
                </CardDetails>
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
    // Restart services can be pressed on the error line or under Troubleshooting. Its prompt
    // shows beside the button that was pressed.
    const [restartFromError, setRestartFromError] = useState(false);
    const name = deviceName(entry);
    const developerMode = descriptor.developerMode;
    const session = descriptor.session ?? 'stopped';
    // A prompt shows only while its button can be used, so a session that stops or a phone that
    // disconnects in the meantime does not leave a confirm for an action that no longer applies.
    const canStop = isActive && (session === 'ready' || session === 'starting');
    const canRecover = isActive && !busy;

    // Each command ends with its reply, an error, a closed socket or a time limit
    // (`sendServiceCommand`), so a button cannot stay disabled. Leaving the list withdraws them.
    const leaving = useRef<AbortController>();
    useEffect(() => {
        const controller = new AbortController();
        leaving.current = controller;
        return () => controller.abort();
    }, []);

    /**
     * Debug actions live here as well as in the stream page's Actions sheet, because the failures
     * they recover from (a wedged session, an unmounted developer image) are exactly the ones that
     * leave no working stream page to open.
     */
    const runCommand = (command: string, label: string, done: string) => {
        setBusy(label);
        setFeedback(`${label}…`);
        sendServiceCommand(entry.tracker, command, descriptor.udid, leaving.current?.signal).then(
            (result) => {
                setBusy('');
                setFeedback(replyText(result, done));
            },
            (error: Error) => {
                if (!(error instanceof TrackerCommandAborted)) {
                    setBusy('');
                    setFeedback(error.message);
                }
            },
        );
    };

    const enableDeveloperMode = () => {
        setEnabling(true);
        setFeedback('Enabling Developer Mode… the phone will restart and ask you to confirm.');
        sendServiceCommand(
            entry.tracker,
            ControlCenterCommand.ENABLE_DEVELOPER_MODE,
            descriptor.udid,
            leaving.current?.signal,
        ).then(
            () => {
                setEnabling(false);
                setFeedback('Developer Mode is on.');
            },
            (error: Error) => {
                if (!(error instanceof TrackerCommandAborted)) {
                    setEnabling(false);
                    setFeedback(error.message);
                }
            },
        );
    };

    const problems = getDeviceProblems(entry);
    const sessionProblem = problems.find((problem) => problem.kind === 'session');
    // A phone that needs attention can be asleep as well; the banner still says so.
    const isAsleep =
        statusInfo.status === 'asleep' ||
        ((statusInfo.status === 'attention' || statusInfo.status === 'error') && descriptor['screen.power'] === 'off');
    const unlockLine = descriptor.unlockSchedule && unlockCardLine(descriptor.unlockSchedule);
    const hasInbox = isNotificationSource(notificationSummary.value, descriptor.udid);
    const unread = notificationSummary.value.unreadBySource[descriptor.udid] || 0;
    const restartPrompt = (
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
    );

    return (
        <article
            class={`device ${isActive ? 'active' : 'not-active'} ${isAsleep ? 'asleep' : ''}`}
            data-device-key={entry.key}
        >
            <DeviceHeader entry={entry} platform={`iOS ${descriptor.version}`}>
                {/* A connected phone shows an unlock problem as its own line, with an action. An
                    unplugged one has no action to offer, so the problem stays here. */}
                {unlockLine && (!unlockLine.problem || !isActive) && (
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
                <div class="device-asleep-banner attention" role="status">
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
            {sessionProblem && (
                <div class="device-problem" role="status" data-problem="session">
                    <span class="device-problem-text">{sessionProblem.message}</span>
                    <button
                        type="button"
                        class="device-problem-action"
                        disabled={!canRecover}
                        onClick={(event) => {
                            setRestartFromError(true);
                            confirm.arm('restart', event.currentTarget);
                        }}
                    >
                        Restart services
                    </button>
                </div>
            )}
            {confirm.armed === 'restart' && restartFromError && canRecover && restartPrompt}
            {isActive && unlockLine?.problem && (
                <div class="device-problem" role="status" data-problem="unlock">
                    <span class="device-unlock-schedule problem" title={unlockLine.title}>
                        {unlockLine.text}
                    </span>
                    <button
                        type="button"
                        class="device-problem-action"
                        aria-label={`Open settings for ${name}`}
                        onClick={() => openApplSettingsSheet(descriptor.udid, entry.key)}
                    >
                        Open settings
                    </button>
                </div>
            )}
            {feedback && <p class="device-unavailable-hint">{feedback}</p>}
            <div class="services device-primary-actions">
                {canOpenScreen(entry) ? (
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
                        {isActive
                            ? 'Open screen'
                            : descriptor.state === 'unauthorized'
                              ? 'Waiting for trust'
                              : 'Device unavailable'}
                    </button>
                )}
                {/* Only for an iPhone that sends its notifications here. Any other iPhone has no
                    inbox to open; setup is reached from Notifications in the page header. */}
                {hasInbox && (
                    <a
                        class="action-button device-notification-history"
                        href={`#!${new URLSearchParams({ action: 'notifications', source: descriptor.udid })}`}
                        title="Notifications"
                        aria-label={
                            unread ? `Notifications for ${name}, ${unread} unread` : `Notifications for ${name}`
                        }
                    >
                        <BellIcon />
                        <UnreadBadge count={unread} />
                    </a>
                )}
                {/* Shown for a disconnected phone too: the schedule is kept on the server, and its
                    last run matters most when the phone has dropped off. */}
                <SettingsButton
                    title="iPhone settings"
                    name={name}
                    onClick={() => openApplSettingsSheet(descriptor.udid, entry.key)}
                />
            </div>
            <CardDetails deviceKey={entry.key}>
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
                                onClick={(event) => {
                                    setRestartFromError(false);
                                    confirm.arm('restart', event.currentTarget);
                                }}
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
                        {confirm.armed === 'restart' && !restartFromError && canRecover && restartPrompt}
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
            </CardDetails>
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
