import { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DeviceEntry, isDeviceAvailable, phoneName } from '../state/devices';
import type ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import type { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import { ControlCenterCommand } from '../../common/ControlCenterCommand';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import { DEFAULT_FILES_PATH } from '../googDevice/client/deviceTools';
import { deviceHref, followLink, isLocalLink } from '../state/links';
import type { DeviceView } from '../state/routes';
import { capabilities } from '../state/capabilities';
import { CardLineKind, phoneCard } from '../state/phoneCard';
import { clearStarting, markStarting } from '../state/phoneStatus';
import { STREAM_SERVICE } from '../copy';
import { openSettings } from '../state/settingsSheet';
import { unlockCardLine } from '../state/unlockSchedule';
import { replyText, sendServiceCommand, TrackerCommandAborted } from '../client/trackerCommand';
import { deviceTools } from './ToolView';
import { notificationSummary } from '../state/notifications';
import { isNotificationSource } from '../state/notificationsTarget';
import { notificationRoute } from '../state/notificationPage';
import { ConfirmPrompt, useArmedAction } from '../ui/ConfirmAction';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { IconButton, iconButtonClass } from '../ui/IconButton';
import type { IconName } from '../ui/icons';
import { InlineStatus, StatusTone } from '../ui/InlineStatus';
import { PhoneRow } from '../ui/PhoneRow';
import { useWake, WakeButton, WakeOutcome } from '../ui/WakeButton';

const TOOL_ICON: Record<DeviceView, IconName> = { screen: 'phone', files: 'folder', shell: 'terminal' };

/**
 * A link to a page of the phone. One in this app opens the page in a new history entry, so Back
 * returns to the list; one to another server opens in a new tab.
 */
function pageLink(udid: string, view: DeviceView, params: ParamsDeviceTracker, extra: Record<string, string> = {}) {
    const href = deviceHref(udid, view, params, extra);
    const local = isLocalLink(params);
    const onClick = (event: MouseEvent) => {
        if (!local || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
        }
        event.preventDefault();
        followLink(href, 'open');
    };
    const attributes = { target: local ? undefined : '_blank', rel: local ? undefined : 'noopener noreferrer' };
    return { href, onClick, attributes };
}

/**
 * The one line under the head of a card: what is wrong, or what to do. A problem or a hint is a
 * banner in the kit's markup (`style/kit/Banner.css`), with the card's own button as its action,
 * so a confirm prompt can return focus to it. A note is a muted line.
 */
function CardLine({
    kind,
    look,
    action,
    attributes,
    children,
}: {
    kind: CardLineKind;
    look: 'warning' | 'error' | 'note';
    action?: ComponentChildren;
    /** `data-*` attributes. */
    attributes?: Record<string, string | undefined>;
    children: ComponentChildren;
}) {
    if (look === 'note') {
        return (
            <div {...attributes} class="device-line device-note" data-line={kind} role="status">
                <span class="device-note-text">{children}</span>
                {action}
            </div>
        );
    }
    const problem = kind === 'developer-mode' || kind === 'session' || kind === 'unlock';
    return (
        <div
            {...attributes}
            class={`kit-banner ${look === 'error' ? 'kit-banner-error ' : ''}device-line${problem ? ' device-problem' : ''}`}
            role="status"
            data-line={kind}
            data-problem={problem ? kind : undefined}
        >
            <Icon name="warning" size={16} />
            <span class="kit-banner-text">{children}</span>
            {action}
        </div>
    );
}

/** The command a card sent from its line. Its outcome shows under the line. */
type FeedbackPlace = 'developer-mode' | 'restart';

/**
 * The card of a phone on the list (rules in `state/phoneCard.ts`). The head is the phone's row
 * with its one status; under it at most one line says what is wrong or what to do, with the one
 * action for it; then Open screen and the icon buttons.
 */
export function DeviceCard({ entry }: { entry: DeviceEntry }) {
    const { descriptor, params, tracker } = entry;
    const udid = descriptor.udid;
    const name = phoneName(udid, entry);
    const model = phoneCard(entry, StreamClientScrcpy.getPlayers().length > 0);
    const { facts, status, line } = model;
    const isActive = isDeviceAvailable(entry);
    const schedule = capabilities(entry).scheduledUnlock
        ? (descriptor as ApplDeviceDescriptor).unlockSchedule
        : undefined;
    const unlockLine = schedule && unlockCardLine(schedule);
    const hasInbox = isNotificationSource(notificationSummary.value, udid);
    const unread = notificationSummary.value.unreadBySource[udid] || 0;
    const wake = useWake(tracker, udid, model.wake);
    const settings = () => openSettings(udid, { deviceKey: entry.key });

    const [enabling, setEnabling] = useState(false);
    const [feedback, setFeedback] = useState<{ place: FeedbackPlace; tone: StatusTone; text: string }>();
    const [busy, setBusy] = useState(false);
    const confirm = useArmedAction<FeedbackPlace>();
    const canRecover = isActive && !busy;

    // Each command ends with its reply, an error, a closed socket or a time limit
    // (`sendServiceCommand`), so a button cannot stay disabled. Leaving the list withdraws them.
    const leaving = useRef<AbortController>();
    useEffect(() => {
        const controller = new AbortController();
        leaving.current = controller;
        return () => controller.abort();
    }, []);

    // The Start flag is only a guess until the phone reports a pid. A running service, or a
    // phone that is gone, ends it at once instead of after its timeout.
    useEffect(() => {
        if (!facts.trusted || !facts.connected || facts.session === 'running') {
            clearStarting(entry.key);
        }
    }, [entry.key, facts.trusted, facts.connected, facts.session]);

    // The outcome of the last command, under the line whose button sent it. A reply to an earlier
    // command does not take the place of a later one's.
    const settle = (place: FeedbackPlace, tone: StatusTone, text: string) =>
        setFeedback((current) => (current?.place === place ? { place, tone, text } : current));

    const restartServices = () => {
        setBusy(true);
        setFeedback({ place: 'restart', tone: 'neutral', text: 'Restarting services…' });
        sendServiceCommand(tracker, ControlCenterCommand.RESTART_SESSION, udid, leaving.current?.signal).then(
            (result) => {
                setBusy(false);
                settle('restart', 'success', replyText(result, 'Services restarted. Open the screen again.'));
            },
            (error: Error) => {
                if (!(error instanceof TrackerCommandAborted)) {
                    setBusy(false);
                    settle('restart', 'error', error.message);
                }
            },
        );
    };

    const enableDeveloperMode = () => {
        setEnabling(true);
        setFeedback({
            place: 'developer-mode',
            tone: 'neutral',
            text: 'Enabling Developer Mode… the phone will restart and ask you to confirm.',
        });
        sendServiceCommand(tracker, ControlCenterCommand.ENABLE_DEVELOPER_MODE, udid, leaving.current?.signal).then(
            () => {
                setEnabling(false);
                settle('developer-mode', 'success', 'Developer Mode is on.');
            },
            (error: Error) => {
                if (!(error instanceof TrackerCommandAborted)) {
                    setEnabling(false);
                    settle('developer-mode', 'error', error.message);
                }
            },
        );
    };

    // Kept on the card: the stream service of an Android phone can be started before the screen
    // is opened. The status says Starting… until the phone reports the service.
    const startStreamService = () => {
        if (!isActive || facts.session === 'starting') {
            return;
        }
        markStarting(entry.key);
        tracker.sendCommand(ControlCenterCommand.START_SERVER, { udid });
    };

    let lineView: ComponentChildren = null;
    switch (line?.kind) {
        case 'unauthorized':
            lineView = (
                <CardLine kind={line.kind} look="warning">
                    Unlock this phone and approve the USB debugging or trust prompt to connect.
                </CardLine>
            );
            break;
        case 'offline':
            lineView = (
                <CardLine kind={line.kind} look="warning">
                    Not connected. Check the phone's cable or network connection.
                </CardLine>
            );
            break;
        case 'developer-mode':
            lineView = (
                <CardLine
                    kind={line.kind}
                    look="warning"
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
                    {line.problem?.message}
                </CardLine>
            );
            break;
        case 'session':
            lineView = (
                <CardLine
                    kind={line.kind}
                    look="error"
                    action={
                        <Button
                            size="compact"
                            disabled={!canRecover}
                            onClick={(event) => confirm.arm('restart', event.currentTarget)}
                        >
                            Restart services
                        </Button>
                    }
                >
                    {line.problem?.message}
                </CardLine>
            );
            break;
        case 'unlock':
            lineView = (
                <CardLine
                    kind={line.kind}
                    look="warning"
                    action={
                        <Button
                            size="compact"
                            attributes={{ 'aria-label': `Open settings for ${name}` }}
                            onClick={() => openSettings(udid, { deviceKey: entry.key, section: 'unlock' })}
                        >
                            Open settings
                        </Button>
                    }
                >
                    <span class="device-unlock-schedule problem" title={unlockLine ? unlockLine.title : undefined}>
                        {line.problem?.message}
                    </span>
                </CardLine>
            );
            break;
        case 'player':
            lineView = (
                <CardLine kind={line.kind} look="warning">
                    This browser cannot play the stream of this phone.
                </CardLine>
            );
            break;
        case 'stream-service':
            lineView = (
                <CardLine
                    kind={line.kind}
                    look="note"
                    attributes={{ 'data-stream-service': facts.session }}
                    action={
                        <Button
                            size="compact"
                            attributes={{ 'aria-label': 'Start stream service' }}
                            onClick={startStreamService}
                        >
                            Start
                        </Button>
                    }
                >
                    {(facts.session === 'stopped' ? STREAM_SERVICE.stopped : STREAM_SERVICE.unknown).description}
                </CardLine>
            );
            break;
    }

    const screen = pageLink(udid, 'screen', params);
    // The build may leave Files or Shell out (`deviceTools`).
    const tools = deviceTools.filter((tool) => model.tools.some((view) => view === tool.view));

    return (
        <article
            class={`device ${isActive ? 'active' : 'not-active'}${status.screen === 'asleep' ? ' asleep' : ''}`}
            data-device-key={entry.key}
        >
            <PhoneRow
                entry={entry}
                info={status}
                class="device-header"
                action={model.wake && <WakeButton control={wake} />}
            />
            {/* The schedule is kept on the server, so its line stays while the phone is away. */}
            {unlockLine && line?.kind !== 'unlock' && (
                <div class="device-schedule">
                    <span
                        class={`device-unlock-schedule ${unlockLine.problem ? 'problem' : ''}`.trim()}
                        title={unlockLine.title}
                    >
                        {unlockLine.problem && <Icon name="warning" size={16} />}
                        {unlockLine.text}
                    </span>
                </div>
            )}
            {lineView}
            {confirm.armed === 'developer-mode' && line?.kind === 'developer-mode' && (
                <ConfirmPrompt
                    action={confirm}
                    question={`Enable Developer Mode on ${name}?`}
                    consequence="The phone restarts, then asks you to confirm on its screen."
                    confirmLabel="Enable and restart"
                    danger
                    onConfirm={enableDeveloperMode}
                />
            )}
            {confirm.armed === 'restart' && line?.kind === 'session' && canRecover && (
                <ConfirmPrompt
                    action={confirm}
                    question={`Restart services on ${name}?`}
                    consequence="The phone session ends for every viewer. The next viewer gets a new one."
                    confirmLabel="Restart services"
                    danger
                    onConfirm={restartServices}
                />
            )}
            {feedback && <InlineStatus tone={feedback.tone}>{feedback.text}</InlineStatus>}
            {model.wake && <WakeOutcome control={wake} />}
            <div class="services device-primary-actions">
                {model.openScreen ? (
                    <Button
                        href={screen.href}
                        variant="primary"
                        class="desc-block stream primary"
                        onClick={screen.onClick}
                        attributes={screen.attributes}
                    >
                        Open screen
                    </Button>
                ) : (
                    <Button class="desc-block stream unavailable" disabled>
                        Open screen
                    </Button>
                )}
                {tools.map((tool) => {
                    const link = pageLink(
                        udid,
                        tool.view,
                        params,
                        tool.view === 'files' ? { path: DEFAULT_FILES_PATH } : {},
                    );
                    return (
                        <IconButton
                            key={tool.view}
                            href={link.href}
                            icon={TOOL_ICON[tool.view]}
                            label={tool.title}
                            class={`device-tool device-tool-${tool.view}`}
                            onClick={link.onClick}
                            attributes={link.attributes}
                        />
                    );
                })}
                {/* Only for a phone that sends its notifications here. Setup for any other is
                    reached from Notifications in the page header. */}
                {hasInbox && (
                    <a
                        class={`${iconButtonClass()} device-notification-history`}
                        href={`#!${notificationRoute({ source: udid })}`}
                        title="Notifications"
                        aria-label={
                            unread ? `Notifications for ${name}, ${unread} unread` : `Notifications for ${name}`
                        }
                    >
                        <Icon name="bell" />
                        <Badge count={unread} />
                    </a>
                )}
                {/* On every card, in every state: the phone's facts and recovery actions are in
                    its Settings, and a scheduled unlock is kept while the phone is away. */}
                <IconButton
                    icon="sliders"
                    label={`Settings for ${name}`}
                    class="stream-settings-button"
                    onClick={settings}
                />
            </div>
        </article>
    );
}
