import { ComponentChildren } from 'preact';
import { AnimatedDetails } from '../ui/AnimatedDetails';
import { useEffect, useRef, useState } from 'preact/hooks';
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
import { buildLinkHref, deviceHref, followLink, isLocalLink } from '../state/links';
import { parseRoute } from '../state/routes';
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
import { deviceTools } from './ToolView';
import { StreamServiceStatus } from '../ui/StreamServiceStatus';
import { hasRunningStreamService } from '../state/streamService';
import { notificationSummary } from '../state/notifications';
import { isNotificationSource } from '../state/notificationsTarget';
import { notificationRoute } from '../state/notificationPage';
import { rememberCardOpen, wasCardOpen } from '../state/deviceListView';
import { DeviceIcon } from '../ui/DeviceIcon';
import { ConfirmPrompt, useArmedAction } from '../ui/ConfirmAction';
import { Badge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Button, ButtonVariant } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { Icon } from '../ui/Icon';
import { IconButton, iconButtonClass } from '../ui/IconButton';
import { InlineStatus, StatusTone } from '../ui/InlineStatus';

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
    /** Names what the link opens, for the long-press rule in `app.css` and the browser checks. */
    className?: string;
    variant?: ButtonVariant;
}

/** A link to a page of the phone, drawn as a kit button. */
function NavLink({ entry, params, className, variant }: NavLinkProps) {
    const query = { action: entry.action, ...entry.params };
    // A link to a phone names the phone and the view. What else the entry carries stays: the
    // folder Files opens in, or the player of an "Open with" link.
    const page = parseRoute(new URLSearchParams(query));
    const extra = { ...entry.params };
    delete extra.udid;
    const href =
        page.page === 'device' ? deviceHref(page.udid, page.view, params, extra) : buildLinkHref(query, params);
    const local = isLocalLink(params) && page.page === 'device';
    const onClick = (event: MouseEvent) => {
        if (!local || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
        }
        event.preventDefault();
        // From the list to a phone: a new history entry, so Back returns to the list.
        followLink(href, 'open');
    };
    return (
        <Button
            href={href}
            variant={variant}
            class={className}
            onClick={onClick}
            attributes={{ target: local ? undefined : '_blank', rel: local ? undefined : 'noopener noreferrer' }}
        >
            {entry.title}
        </Button>
    );
}

/** The phone's status in words, as a chip. */
function StatusBadge({ info }: { info: DeviceStatusInfo }) {
    return (
        <Chip
            tone={info.tone}
            class="device-status"
            attributes={{ 'data-status': info.status, title: `Status: ${info.label}` }}
        >
            {info.label}
        </Chip>
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

/** Why the phone cannot be used, at the top of its card. */
function UnavailableHint({ info }: { info: DeviceStatusInfo }) {
    return (
        <Banner>
            {info.status === 'unauthorized'
                ? 'Unlock this device and approve the USB debugging or trust prompt to connect.'
                : 'Check the device connection and keep it connected to the server.'}
        </Banner>
    );
}

/**
 * A banner on the card whose action is a button of the card's own, in the kit's banner markup
 * (`style/kit/Banner.css`). `ui/Banner.tsx` takes its action as a label and a function. The
 * actions here also need the pressed button, which a confirm prompt returns focus to, and a
 * name that says which phone, so the card passes the button in.
 */
function CardBanner({
    tone,
    problem,
    action,
    children,
}: {
    tone: 'warning' | 'error';
    /** What is wrong, for the browser checks: the `kind` of a `DeviceProblem`. */
    problem: string;
    action: ComponentChildren;
    children: ComponentChildren;
}) {
    return (
        <div
            class={`kit-banner ${tone === 'error' ? 'kit-banner-error ' : ''}device-problem`}
            role="status"
            data-problem={problem}
        >
            <Icon name="warning" size={16} />
            <span class="kit-banner-text">{children}</span>
            {action}
        </div>
    );
}

/** Settings is an icon on every card, so the action row is the same width on both platforms. */
function SettingsButton({ name, onClick }: { name: string; onClick: () => void }) {
    return (
        <IconButton icon="sliders" label={`Settings for ${name}`} class="stream-settings-button" onClick={onClick} />
    );
}

/** The card's disclosure. It reopens on return to the list if it was open when the page was left. */
function CardDetails({ deviceKey, children }: { deviceKey: string; children: ComponentChildren }) {
    const [initiallyOpen] = useState(() => wasCardOpen(deviceKey));
    return (
        <AnimatedDetails
            class="kit-disclosure device-details"
            open={initiallyOpen}
            onToggle={(event) => rememberCardOpen(deviceKey, (event.currentTarget as HTMLDetailsElement).open)}
        >
            <summary>
                <span class="kit-disclosure-title">Details</span>
            </summary>
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
    const players = StreamClientScrcpy.getPlayers();
    const primaryPlayer = players.find((player) => player.playerCodeName === 'webcodecs') ?? players[0];
    // Files, then Shell: the order of the tabs on the tool page.
    const toolOrder = (tool: ToolEntry) => deviceTools.findIndex((item) => item.action === tool.action);
    const tools = collectTools(GoogDeviceTracker.tools, descriptor).sort((a, b) => toolOrder(a) - toolOrder(b));
    // The screen link names the phone only: the page picks the player and the socket when it
    // opens. An "Open with" link names its player, which the page then uses instead.
    const streamEntry = (title: string, player?: typeof primaryPlayer): ToolEntry => ({
        title,
        action: ACTION.STREAM_SCRCPY,
        params: { udid: descriptor.udid, ...(player ? { player: player.playerCodeName } : {}) },
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
                        variant="primary"
                        params={params}
                        entry={streamEntry('Open screen')}
                    />
                ) : (
                    <Button class="desc-block stream unavailable" disabled>
                        {isActive ? 'Browser cannot play this stream' : 'Device unavailable'}
                    </Button>
                )}
                {isActive && (
                    <SettingsButton
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
                                        entry={streamEntry(`Open with ${player.playerFullName}`, player)}
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
                                <Button
                                    size="compact"
                                    variant={hasPid ? 'danger' : 'secondary'}
                                    attributes={{
                                        'aria-label': hasPid ? 'Stop stream service' : 'Start stream service',
                                    }}
                                    disabled={isStarting}
                                    onClick={(event) =>
                                        hasPid ? confirm.arm('stop', event.currentTarget) : onAction()
                                    }
                                >
                                    {hasPid ? 'Stop' : isStarting ? 'Starting…' : 'Start'}
                                </Button>
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

/** The control of an iPhone card that sent a command. The outcome shows under it. */
type FeedbackPlace = 'developer-mode' | 'restart-problem' | 'refresh' | 'restart' | 'remount';

function ApplDeviceCard({ entry, descriptor }: { entry: DeviceEntry; descriptor: ApplDeviceDescriptor }) {
    const isActive = descriptor.state === DeviceState.CONNECTED;
    const tools = collectTools(ApplDeviceTracker.tools, descriptor);
    const statusInfo = getDeviceStatusInfo(entry);
    const [enabling, setEnabling] = useState(false);
    // The outcome of a command, shown under the control that sent it.
    const [feedback, setFeedback] = useState<{ place: FeedbackPlace; tone: StatusTone; text: string }>();
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
    const runCommand = (place: FeedbackPlace, command: string, label: string, done: string) => {
        setBusy(label);
        setFeedback({ place, tone: 'neutral', text: `${label}…` });
        sendServiceCommand(entry.tracker, command, descriptor.udid, leaving.current?.signal).then(
            (result) => {
                setBusy('');
                setFeedback({ place, tone: 'success', text: replyText(result, done) });
            },
            (error: Error) => {
                if (!(error instanceof TrackerCommandAborted)) {
                    setBusy('');
                    setFeedback({ place, tone: 'error', text: error.message });
                }
            },
        );
    };
    const feedbackAt = (place: FeedbackPlace) =>
        feedback?.place === place && <InlineStatus tone={feedback.tone}>{feedback.text}</InlineStatus>;

    const enableDeveloperMode = () => {
        const place = 'developer-mode';
        setEnabling(true);
        setFeedback({
            place,
            tone: 'neutral',
            text: 'Enabling Developer Mode… the phone will restart and ask you to confirm.',
        });
        sendServiceCommand(
            entry.tracker,
            ControlCenterCommand.ENABLE_DEVELOPER_MODE,
            descriptor.udid,
            leaving.current?.signal,
        ).then(
            () => {
                setEnabling(false);
                setFeedback({ place, tone: 'success', text: 'Developer Mode is on.' });
            },
            (error: Error) => {
                if (!(error instanceof TrackerCommandAborted)) {
                    setEnabling(false);
                    setFeedback({ place, tone: 'error', text: error.message });
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
                    restartFromError ? 'restart-problem' : 'restart',
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
                        class={`device-unlock-schedule ${unlockLine.problem ? 'problem' : ''}`.trim()}
                        title={unlockLine.title}
                    >
                        {unlockLine.problem && <Icon name="warning" size={16} />}
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
            {isAsleep && <Banner tone="info">Screen is asleep.</Banner>}
            {isActive && developerMode === false && (
                <CardBanner
                    tone="warning"
                    problem="developer-mode"
                    action={
                        <Button
                            size="compact"
                            disabled={enabling}
                            onClick={(event) => confirm.arm('developer-mode', event.currentTarget)}
                        >
                            {enabling ? 'Enabling…' : 'Enable and restart'}
                        </Button>
                    }
                >
                    Enable Developer Mode to open the screen.
                </CardBanner>
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
            {feedbackAt('developer-mode')}
            {sessionProblem && (
                <CardBanner
                    tone="error"
                    problem="session"
                    action={
                        <Button
                            size="compact"
                            disabled={!canRecover}
                            onClick={(event) => {
                                setRestartFromError(true);
                                confirm.arm('restart', event.currentTarget);
                            }}
                        >
                            Restart services
                        </Button>
                    }
                >
                    {sessionProblem.message}
                </CardBanner>
            )}
            {confirm.armed === 'restart' && restartFromError && canRecover && restartPrompt}
            {feedbackAt('restart-problem')}
            {isActive && unlockLine?.problem && (
                <CardBanner
                    tone="warning"
                    problem="unlock"
                    action={
                        <Button
                            size="compact"
                            attributes={{ 'aria-label': `Open settings for ${name}` }}
                            onClick={() => openApplSettingsSheet(descriptor.udid, entry.key)}
                        >
                            Open settings
                        </Button>
                    }
                >
                    <span class="device-unlock-schedule problem" title={unlockLine.title}>
                        {unlockLine.text}
                    </span>
                </CardBanner>
            )}
            <div class="services device-primary-actions">
                {canOpenScreen(entry) ? (
                    tools.map((tool, index) => (
                        <NavLink
                            key={`${tool.action}_${index}`}
                            className={index === 0 ? 'desc-block stream primary' : 'desc-block'}
                            variant={index === 0 ? 'primary' : undefined}
                            params={entry.params}
                            entry={{ ...tool, title: index === 0 ? 'Open screen' : tool.title }}
                        />
                    ))
                ) : (
                    <Button class="desc-block stream unavailable" disabled>
                        {isActive
                            ? 'Open screen'
                            : descriptor.state === 'unauthorized'
                              ? 'Waiting for trust'
                              : 'Device unavailable'}
                    </Button>
                )}
                {/* Only for an iPhone that sends its notifications here. Any other iPhone has no
                    inbox to open; setup is reached from Notifications in the page header. */}
                {hasInbox && (
                    <a
                        class={`${iconButtonClass()} device-notification-history`}
                        href={`#!${notificationRoute({ source: descriptor.udid })}`}
                        title="Notifications"
                        aria-label={
                            unread ? `Notifications for ${name}, ${unread} unread` : `Notifications for ${name}`
                        }
                    >
                        <Icon name="bell" />
                        <Badge count={unread} />
                    </a>
                )}
                {/* Shown for a disconnected phone too: the schedule is kept on the server, and its
                    last run matters most when the phone has dropped off. */}
                <SettingsButton name={name} onClick={() => openApplSettingsSheet(descriptor.udid, entry.key)} />
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
                        <Button
                            size="compact"
                            disabled={!!busy}
                            onClick={() =>
                                runCommand(
                                    'refresh',
                                    ControlCenterCommand.REFRESH_DEVICE,
                                    'Refreshing',
                                    'Phone info refreshed.',
                                )
                            }
                        >
                            Refresh info
                        </Button>
                    </div>
                    {feedbackAt('refresh')}
                    <div class="device-trouble" role="group" aria-label="Troubleshooting">
                        <h4 class="device-trouble-heading">Troubleshooting</h4>
                        {canStop && (
                            <TroubleRow
                                title="Stop stream service"
                                description="Ends the screen stream for every viewer."
                            >
                                <Button
                                    size="compact"
                                    variant="danger"
                                    attributes={{ 'aria-label': 'Stop stream service' }}
                                    onClick={(event) => confirm.arm('stop', event.currentTarget)}
                                >
                                    Stop
                                </Button>
                            </TroubleRow>
                        )}
                        <TroubleRow
                            title="Restart services"
                            description="Use if controls stop responding. Ends the phone session for every viewer."
                        >
                            <Button
                                size="compact"
                                variant="danger"
                                attributes={{ 'aria-label': 'Restart services' }}
                                disabled={!canRecover}
                                onClick={(event) => {
                                    setRestartFromError(false);
                                    confirm.arm('restart', event.currentTarget);
                                }}
                            >
                                Restart
                            </Button>
                        </TroubleRow>
                        {feedbackAt('restart')}
                        <TroubleRow
                            title="Remount developer image"
                            description="Use if the screen will not start. Ends the phone session first."
                        >
                            <Button
                                size="compact"
                                variant="danger"
                                attributes={{ 'aria-label': 'Remount developer image' }}
                                disabled={!canRecover}
                                onClick={(event) => confirm.arm('remount', event.currentTarget)}
                            >
                                Remount
                            </Button>
                        </TroubleRow>
                        {feedbackAt('remount')}
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
                                        'remount',
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
