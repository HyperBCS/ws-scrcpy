import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { NotificationSource } from '../../common/Notification';
import {
    notificationRequest as api,
    closeReadNotifications,
    PHONE_ACTION_TIMEOUT_MS,
    BULK_PHONE_ACTION_TIMEOUT_MS,
} from '../state/notifications';
import { route, pushRoute, navigate } from '../state/router';
import { findDeviceByUdid, isDeviceAvailable } from '../state/devices';
import { Toast } from '../ui/Toast';
import { ConfirmPrompt, useArmedAction } from '../ui/ConfirmAction';
import { animate, reducedMotion } from '../ui/motion';
import { NotificationCard } from './NotificationCard';
import { NotificationActionSheet } from './NotificationActionSheet';
import { isDismissActionLabel } from '../../common/NotificationActions';

export type { NotificationHistoryItem as HistoryItem } from '../../common/Notification';
import type { NotificationHistoryItem as HistoryItem } from '../../common/Notification';

export function UnreadBadge({ count }: { count: number }) {
    return count > 0 ? (
        <span class="notification-unread-count" aria-label={`${count} unread notifications`}>
            {count > 99 ? '99+' : count}
        </span>
    ) : null;
}

/** How the Bluetooth link to one iPhone stands, read from the collector's status text. */
export type FeedState = 'connected' | 'reconnecting' | 'attention';
export function feedState(status: string | undefined): FeedState {
    if (status === 'Receiving notifications') return 'connected';
    // Sharing has to be allowed on the iPhone; nothing on this side can fix it.
    if (status && /allow|permission/i.test(status)) return 'attention';
    return 'reconnecting';
}
const FEED_LABELS: Record<FeedState, string> = {
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    attention: 'Action needed',
};
export function FeedBadge({ state }: { state: FeedState }) {
    return <span class={`notification-badge ${state === 'connected' ? 'ready' : state}`}>{FEED_LABELS[state]}</span>;
}

/** Where an iPhone's screen opens, and why it cannot be opened now. */
function screenLink(source: NotificationSource): { params: Record<string, string>; unavailable?: string } {
    const entry = findDeviceByUdid(source.id);
    return {
        params: { action: 'stream-coredevice', udid: source.id },
        unavailable:
            entry && isDeviceAvailable(entry) ? undefined : `${source.name} is not connected to the NUC by USB.`,
    };
}

function sentence(text: string): string {
    return /[.!?]$/.test(text) ? text : `${text}.`;
}

function count(n: number): string {
    return `${n} notification${n === 1 ? '' : 's'}`;
}

function receivedAt(time: number): string {
    const date = new Date(time);
    return date.toDateString() === new Date().toDateString()
        ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** A highlighted notification (opened from a push) keeps its outline this long. */
export const HIGHLIGHT_MS = 4000;

// Undo puts back what one action changed. `source` keeps it from being offered for another iPhone.
type UndoAction = { source: string; label: string; revert: () => Promise<unknown> };
// `retry` is offered only for actions that need no confirmation.
type Failure = { message: string; retry?: () => void };
type Filter = 'inbox' | 'unread' | 'archive';
const FILTER_LABELS: Record<Filter, string> = { inbox: 'All', unread: 'Unread', archive: 'Archive' };

function searchText(value: string): string {
    return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();
}

function matchesSearch(item: HistoryItem, tokens: string[]): boolean {
    const text = searchText([item.appName, item.app, item.title, item.subtitle, item.body].filter(Boolean).join(' '));
    return tokens.every((token) => text.includes(token));
}

type PhoneClear = {
    sourceId: string;
    name: string;
    snapshot: Array<{ key: string; expectedLabel?: string }>;
};

type BulkReply = {
    accepted: string[];
    skipped: string[];
    failed: Array<{ key: string; error: string }>;
    unprocessed: string[];
};

export function NotificationHistory({
    sources,
    items,
    unreadBySource,
    statuses,
    feedError,
    connectionError,
    busy,
    run,
    refresh,
}: {
    sources: NotificationSource[];
    items: HistoryItem[];
    unreadBySource: Record<string, number>;
    // The collector's status text for each iPhone, and its own error.
    statuses: Record<string, string>;
    feedError: string;
    connectionError: string;
    busy: boolean;
    run: (fn: () => Promise<void>, onError?: (message: string) => void) => Promise<void>;
    refresh: () => Promise<unknown>;
}) {
    const requestedSource = route.value.get('source') || '';
    // An iPhone that is not linked has no inbox of its own: the first linked one is shown.
    const source = sources.find((s) => s.id === requestedSource) || sources[0];
    const currentSource = useRef(source?.id);
    currentSource.current = source?.id;
    const highlighted = route.value.get('notification') || '';
    const [highlightOn, setHighlightOn] = useState(false);
    const [filter, setFilter] = useState<Filter>('inbox');
    const [limit, setLimit] = useState(25);
    const [query, setQuery] = useState('');
    const [appFilter, setAppFilter] = useState('');
    const [menu, setMenu] = useState<'filters' | 'bulk' | null>(null);
    const [menuKey, setMenuKey] = useState('');
    const [undo, setUndo] = useState<UndoAction | null>(null);
    const [failure, setFailure] = useState<Failure | null>(null);
    const pending = useRef(new Set<string>());
    const [pendingKeys, setPendingKeys] = useState(new Set<string>());
    const [accepted, setAccepted] = useState<string[]>([]);
    const [bulkBusy, setBulkBusy] = useState<'' | 'archive' | 'phone'>('');
    const [confirmation, setConfirmation] = useState<PhoneClear | null>(null);
    // Clearing on the iPhone is confirmed in the bulk sheet itself. Closing that sheet disarms it.
    const bulkConfirm = useArmedAction<'phone'>(menu === 'bulk');
    const clicked = useRef('');
    const scrolled = useRef('');
    const list = useRef<HTMLElement>(null);
    const positions = useRef(new Map<string, number>());
    const reasonId = useId();
    useLayoutEffect(() => {
        const next = new Map<string, number>();
        const reduced = reducedMotion();
        const collapsing = !!list.current?.querySelector('.committing');
        list.current?.querySelectorAll<HTMLElement>('[data-notification-key]').forEach((node) => {
            const key = node.dataset.notificationKey!;
            const top = node.offsetTop;
            const previous = positions.current.get(key);
            next.set(key, top);
            if (!reduced && !collapsing && previous !== undefined && previous !== top) {
                animate(node, [{ transform: `translateY(${previous - top}px)` }, { transform: 'translateY(0)' }], {
                    duration: 240,
                    easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
                });
            }
        });
        positions.current = next;
    });
    useEffect(() => {
        const node = list.current;
        if (!node) return;
        // Expanded previews and viewport changes can move rows without a history update.
        const observer = new ResizeObserver(() => {
            node.querySelectorAll<HTMLElement>('[data-notification-key]').forEach((row) => {
                positions.current.set(row.dataset.notificationKey!, row.offsetTop);
            });
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    const phoneItems = items.filter((n) => n.source === source?.id);
    const apps = [...new Map(phoneItems.filter((n) => n.app).map((n) => [n.app!, n.appName || n.app!])).entries()].sort(
        (a, b) => a[1].localeCompare(b[1]),
    );
    const tokens = searchText(query.trim()).split(/\s+/).filter(Boolean);
    const filtered = phoneItems.filter(
        (n) =>
            (filter === 'archive' ? n.dismissed : !n.dismissed) &&
            (filter !== 'unread' || !n.read) &&
            (!appFilter || n.app === appFilter) &&
            (!tokens.length || matchesSearch(n, tokens)),
    );
    const localDismissals = filtered.filter((n) => !n.dismissed);
    const phoneDismissals = filtered.filter(
        (n) => n.active && n.canDismiss && isDismissActionLabel(n.negativeActionLabel) && !accepted.includes(n.key),
    );
    const selectedMenuItem = phoneItems.find((n) => n.key === menuKey);
    const previousMenuItem = useRef<HistoryItem>();
    if (selectedMenuItem) previousMenuItem.current = selectedMenuItem;
    const menuItem = selectedMenuItem || previousMenuItem.current;
    // A phone action other than a plain dismissal (Decline, Delete) needs a confirming press.
    // Closing the card's sheet disarms it.
    const phoneConfirm = useArmedAction<string>(!!selectedMenuItem);
    const [phoneResult, setPhoneResult] = useState('');
    const matchingUnread = filtered.filter((n) => !n.read && !n.dismissed);
    const narrowed = !!query.trim() || !!appFilter;
    const screen = source ? screenLink(source) : undefined;
    const state = feedState(source ? statuses[source.id] : undefined);
    const statusText = sentence(
        (source && statuses[source.id]) || 'Waiting for Bluetooth. Keep the iPhone near the NUC.',
    );

    // Every inbox action reports a failure at the bottom of the screen, where it stays visible
    // however far the list is scrolled, until it is closed or the next action starts.
    const act = (fn: () => Promise<void>, retry?: () => void) =>
        run(
            async () => {
                setFailure(null);
                await fn();
            },
            (message) => {
                setUndo(null);
                setPhoneResult('');
                setFailure({ message, retry });
            },
        );
    /** Runs an action that needs no confirmation and offers Retry if it fails. */
    const attempt = (fn: () => Promise<void>) => {
        const go = () => void act(fn, go);
        go();
    };
    const offerUndo = (action: UndoAction) => {
        if (currentSource.current !== action.source) return;
        setFailure(null);
        setPhoneResult('');
        setUndo(action);
    };
    const openScreen = () => {
        if (!screen) return;
        if (screen.unavailable) {
            setUndo(null);
            setPhoneResult('');
            setFailure({ message: screen.unavailable });
        } else navigate(screen.params);
    };
    const markRead = async (keys: string[], read = true) => {
        await api('history/read', 'POST', { keys, read });
        if (read) closeReadNotifications(keys);
        await refresh();
    };
    useEffect(() => {
        setLimit(25);
    }, [filter, source?.id, query, appFilter]);
    useEffect(() => {
        setQuery('');
        setAppFilter('');
        setFilter('inbox');
        setMenu(null);
        setMenuKey('');
        setUndo(null);
        setFailure(null);
        setConfirmation(null);
        setPhoneResult('');
    }, [source?.id]);
    useEffect(() => {
        if (!highlighted || clicked.current === highlighted) return;
        const item = phoneItems.find((n) => n.key === highlighted);
        if (!item) return;
        clicked.current = highlighted;
        setQuery('');
        setAppFilter('');
        setFilter(item.dismissed ? 'archive' : 'inbox');
        if (!item.read) attempt(() => markRead([item.key]));
    }, [highlighted, items, source?.id]);
    useEffect(() => {
        if (highlighted && !query && !appFilter) {
            const index = filtered.findIndex((n) => n.key === highlighted);
            if (index >= 0) setLimit((current) => Math.max(current, index + 1));
        }
    }, [highlighted, items, filter, query, appFilter]);
    // An opened notification is brought to the middle of the screen once, then its outline fades.
    useEffect(() => {
        if (!highlighted || scrolled.current === highlighted) return;
        const node = list.current?.querySelector<HTMLElement>(`[data-notification-key="${CSS.escape(highlighted)}"]`);
        if (!node) return;
        scrolled.current = highlighted;
        node.scrollIntoView({ block: 'center' });
        setHighlightOn(true);
    });
    useEffect(() => {
        if (!highlightOn) return;
        const timer = setTimeout(() => setHighlightOn(false), HIGHLIGHT_MS);
        return () => clearTimeout(timer);
    }, [highlightOn, highlighted]);
    const localAction = async (item: HistoryItem, kind: 'read' | 'dismiss') => {
        if ((busy && !pending.current.size) || pending.current.has(item.key)) return;
        pending.current.add(item.key);
        setPendingKeys(new Set(pending.current));
        setMenuKey('');
        setPhoneResult('');
        try {
            await act(
                async () => {
                    if (kind === 'read') await api('history/read', 'POST', { keys: [item.key], read: !item.read });
                    else await api(`history/${encodeURIComponent(item.key)}/dismiss`, 'POST');
                    if (kind === 'dismiss' || !item.read) closeReadNotifications([item.key]);
                    offerUndo({
                        source: item.source,
                        label: kind === 'dismiss' ? 'Archived' : item.read ? 'Marked unread' : 'Marked read',
                        revert: () =>
                            kind === 'dismiss'
                                ? api(`history/${encodeURIComponent(item.key)}/restore`, 'POST', { read: item.read })
                                : api('history/read', 'POST', { keys: [item.key], read: item.read }),
                    });
                    await refresh();
                },
                () => void localAction(item, kind),
            );
        } finally {
            pending.current.delete(item.key);
            setPendingKeys(new Set(pending.current));
        }
    };
    const undoLast = () => {
        if (!undo || busy || undo.source !== source?.id) return;
        const action = undo;
        attempt(async () => {
            await action.revert();
            setUndo(null);
            await refresh();
        });
    };
    const moveToInbox = (item: HistoryItem) => {
        setMenuKey('');
        setUndo(null);
        attempt(async () => {
            await api(`history/${encodeURIComponent(item.key)}/restore`, 'POST', { read: true });
            await refresh();
        });
    };
    const phoneAction = (item: HistoryItem) => {
        const label = item.negativeActionLabel;
        const name = sources.find((s) => s.id === item.source)?.name || 'the iPhone';
        setMenuKey('');
        setUndo(null);
        setPhoneResult('');
        // A confirmed action is confirmed again from the card, never repeated from the notice.
        const go = () =>
            void act(
                async () => {
                    await api(
                        `history/${encodeURIComponent(item.key)}/action`,
                        'POST',
                        { expectedLabel: label },
                        undefined,
                        PHONE_ACTION_TIMEOUT_MS,
                    );
                    closeReadNotifications([item.key]);
                    setAccepted((keys) => [...keys, item.key]);
                    // The phone accepted the request; it does not report that the notification is gone.
                    setPhoneResult(`${label} sent to ${name}.`);
                    await refresh();
                },
                isDismissActionLabel(label) ? go : undefined,
            );
        go();
    };
    const markAllRead = () => {
        if (!source) return;
        const sourceId = source.id;
        const keys = matchingUnread.map((n) => n.key);
        setMenu(null);
        setUndo(null);
        attempt(async () => {
            await markRead(keys);
            offerUndo({
                source: sourceId,
                label: `Marked ${count(keys.length)} read`,
                revert: () => api('history/read', 'POST', { keys, read: false }),
            });
        });
    };
    const archiveAll = () => {
        if (!source || busy || bulkBusy) return;
        // This exact set, taken now: a notification that arrives in the meantime stays in the inbox.
        const sourceId = source.id;
        const name = source.name;
        const snapshot = localDismissals.map((n) => ({ key: n.key, read: n.read }));
        if (!snapshot.length) return;
        setMenu(null);
        setUndo(null);
        setPhoneResult('');
        attempt(async () => {
            setBulkBusy('archive');
            try {
                const reply = await api<{ dismissed: string[] }>('history/dismiss', 'POST', {
                    source: sourceId,
                    keys: snapshot.map((n) => n.key),
                });
                closeReadNotifications(reply.dismissed);
                const archived = snapshot.filter((n) => reply.dismissed.includes(n.key));
                if (archived.length)
                    offerUndo({
                        source: sourceId,
                        label: `Archived ${count(archived.length)} from ${name}`,
                        revert: () => api('history/restore', 'POST', { source: sourceId, items: archived }),
                    });
                await refresh();
            } finally {
                setBulkBusy('');
            }
        });
    };
    const clearAllOnPhone = (trigger: EventTarget | null) => {
        if (!source || busy || bulkBusy) return;
        // Freeze this exact device and notification set before confirmation. New arrivals
        // and a subsequently selected device must never join the confirmed batch.
        const snapshot = phoneDismissals.map((n) => ({ key: n.key, expectedLabel: n.negativeActionLabel }));
        if (!snapshot.length) return;
        setConfirmation({ sourceId: source.id, name: source.name, snapshot });
        bulkConfirm.arm('phone', trigger);
    };
    const confirmClearAll = () => {
        if (!confirmation || busy || bulkBusy) return;
        const { sourceId, name, snapshot } = confirmation;
        setMenu(null);
        setConfirmation(null);
        setUndo(null);
        setPhoneResult('');
        void act(async () => {
            setBulkBusy('phone');
            try {
                const reply = await api<BulkReply>(
                    'history/actions',
                    'POST',
                    { source: sourceId, items: snapshot },
                    undefined,
                    BULK_PHONE_ACTION_TIMEOUT_MS,
                );
                setAccepted((keys) => [...keys, ...reply.accepted]);
                closeReadNotifications(reply.accepted);
                const remaining = reply.skipped.length + reply.failed.length + reply.unprocessed.length;
                const message = `Clear sent to ${name} for ${count(reply.accepted.length)}.${remaining ? ` ${remaining} not sent or not confirmed.` : ''}`;
                if (reply.failed.length || reply.unprocessed.length)
                    setFailure({ message: `${message}${reply.failed[0] ? ` ${reply.failed[0].error}` : ''}` });
                else setPhoneResult(message);
                await refresh();
            } finally {
                setBulkBusy('');
            }
        });
    };
    return (
        <section
            class="notification-card notification-history"
            aria-labelledby="notification-history-heading"
            aria-busy={!!bulkBusy}
        >
            <h2 id="notification-history-heading" class="visually-hidden">
                {filter === 'archive' ? 'Archive' : filter === 'unread' ? 'Unread' : 'Inbox'}
            </h2>
            {source && (
                <div class="notification-history-source">
                    <div class="notification-history-device-row">
                        {sources.length > 1 ? (
                            <label class="notification-history-device">
                                <span class="visually-hidden">Device</span>
                                <select
                                    disabled={busy}
                                    value={source.id}
                                    onChange={(event) => {
                                        const params = new URLSearchParams(route.value);
                                        params.set('source', event.currentTarget.value);
                                        params.delete('notification');
                                        pushRoute(params);
                                    }}
                                >
                                    {sources.map((s) => (
                                        <option key={s.id} value={s.id}>
                                            {s.name}
                                            {unreadBySource[s.id] ? ` · ${unreadBySource[s.id]} unread` : ''}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        ) : (
                            <strong class="notification-history-device-name">{source.name}</strong>
                        )}
                        {screen?.unavailable ? (
                            <button class="notification-open-screen" disabled aria-describedby={reasonId}>
                                Open screen
                            </button>
                        ) : (
                            <a
                                class="ui-button notification-open-screen"
                                href={`#!${new URLSearchParams(screen?.params)}`}
                            >
                                Open screen
                            </a>
                        )}
                    </div>
                    <p class="notification-feed-state">
                        <FeedBadge state={state} />
                        <span>
                            {phoneItems.length
                                ? `Last notification ${receivedAt(phoneItems[0].received)}`
                                : 'No notifications yet'}
                        </span>
                    </p>
                    {screen?.unavailable && (
                        <p id={reasonId} class="notification-help notification-screen-reason">
                            {screen.unavailable}
                        </p>
                    )}
                    {feedError ? (
                        <p role="alert" class="notification-notice notification-error">
                            Notifications are not being received. {sentence(feedError)}
                        </p>
                    ) : state === 'attention' ? (
                        <p role="alert" class="notification-notice notification-error">
                            {source.name}: {statusText}
                        </p>
                    ) : state === 'reconnecting' ? (
                        <p role="status" class="notification-notice">
                            New notifications from {source.name} appear when it reconnects. {statusText}
                        </p>
                    ) : null}
                </div>
            )}
            <div class="notification-history-tools">
                {connectionError && (
                    <p role="alert" class="notification-notice notification-error notification-connection">
                        Connection interrupted. {connectionError}
                    </p>
                )}
                <div class="notification-search-row">
                    <input
                        type="search"
                        aria-label="Search notifications"
                        placeholder="Search notifications"
                        value={query}
                        onInput={(event) => setQuery(event.currentTarget.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') event.currentTarget.blur();
                        }}
                        enterKeyHint="search"
                        autoComplete="off"
                    />
                    <button
                        class="notification-filter-button"
                        aria-haspopup="dialog"
                        aria-label={appFilter ? 'Filters, app filter active' : 'Filters'}
                        onClick={() => setMenu('filters')}
                    >
                        Filters{appFilter ? ' · 1' : ''}
                    </button>
                </div>
                <div class="notification-history-toolbar">
                    <div
                        class="notification-segments"
                        style={{ '--segment-index': ['inbox', 'unread', 'archive'].indexOf(filter) }}
                        role="group"
                        aria-label="Notification view"
                    >
                        {(['inbox', 'unread', 'archive'] as const).map((value) => (
                            <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                                {FILTER_LABELS[value]}
                            </button>
                        ))}
                    </div>
                    <button
                        class="notification-menu-button"
                        aria-label="Notification actions"
                        aria-haspopup="dialog"
                        disabled={busy}
                        onClick={() => setMenu('bulk')}
                    >
                        <span aria-hidden="true">⋯</span>
                    </button>
                </div>
                {narrowed ? (
                    <div class="notification-search-summary" role="status">
                        <span>
                            {filtered.length} result{filtered.length === 1 ? '' : 's'}
                            {appFilter ? ` · ${apps.find(([id]) => id === appFilter)?.[1] || appFilter}` : ''}
                        </span>
                        <button
                            onClick={() => {
                                setQuery('');
                                setAppFilter('');
                            }}
                        >
                            Clear filters
                        </button>
                    </div>
                ) : null}
                {bulkBusy && (
                    <p role="status" class="notification-help notification-bulk-busy">
                        {bulkBusy === 'phone' ? `Clearing on ${source?.name || 'the iPhone'}…` : 'Archiving…'}
                    </p>
                )}
            </div>
            {!filtered.length && (
                <div class="notification-empty">
                    <strong>
                        {narrowed
                            ? 'No matching notifications'
                            : filter === 'unread'
                              ? 'No unread notifications'
                              : filter === 'archive'
                                ? 'No archived notifications'
                                : phoneItems.length
                                  ? 'Inbox clear'
                                  : 'No notifications yet'}
                    </strong>
                    {narrowed ? (
                        <p>Try another search or filter.</p>
                    ) : filter === 'inbox' && phoneItems.length ? (
                        <p>Archived notifications are in Archive.</p>
                    ) : filter === 'archive' ? (
                        <p>Swipe a notification left to archive it.</p>
                    ) : null}
                </div>
            )}
            {source && (
                <section
                    ref={list}
                    class="notification-history-group"
                    aria-label={`${source.name} notification history`}
                >
                    {filtered.slice(0, limit).map((n) => (
                        <NotificationCard
                            key={n.key}
                            item={n}
                            source={source}
                            busy={pendingKeys.has(n.key) || (busy && !pendingKeys.size)}
                            removeOnRead={filter === 'unread' && !n.read}
                            highlighted={highlightOn && highlighted === n.key}
                            markRead={() => localAction(n, 'read')}
                            dismiss={() => localAction(n, 'dismiss')}
                            openMenu={() => setMenuKey(n.key)}
                            openScreen={openScreen}
                        />
                    ))}
                </section>
            )}
            {filtered.length > limit && (
                <button class="notification-show-more" onClick={() => setLimit(limit + 25)}>
                    Show older notifications ({filtered.length - limit})
                </button>
            )}
            {filter === 'archive' && !!filtered.length && (
                <p class="notification-history-note">Notifications are kept for 30 days, up to 500 per iPhone.</p>
            )}
            <Toast
                className="notification-undo"
                dismissLabel="Dismiss undo notice"
                message={undo?.source === source?.id ? undo?.label || '' : ''}
                identity={undo}
                duration={12000}
                onDismiss={() => setUndo(null)}
                action={{ label: 'Undo', run: undoLast, disabled: busy }}
            />
            <Toast
                className="notification-phone-result"
                message={phoneResult}
                identity={phoneResult}
                onDismiss={() => setPhoneResult('')}
            />
            <Toast
                className="notification-failure"
                tone="error"
                dismissLabel="Dismiss error"
                message={failure?.message || ''}
                identity={failure}
                duration={0}
                onDismiss={() => setFailure(null)}
                action={failure?.retry ? { label: 'Retry', run: failure.retry, disabled: busy } : undefined}
            />
            <NotificationActionSheet
                open={menu === 'filters'}
                title="Filter notifications"
                onClose={() => setMenu(null)}
            >
                <label>
                    App
                    <select
                        aria-label="App"
                        value={appFilter}
                        onChange={(event) => setAppFilter(event.currentTarget.value)}
                    >
                        <option value="">All apps</option>
                        {appFilter && !apps.some(([id]) => id === appFilter) && (
                            <option value={appFilter}>{appFilter}</option>
                        )}
                        {apps.map(([id, name]) => (
                            <option key={id} value={id}>
                                {name}
                            </option>
                        ))}
                    </select>
                </label>
                <button
                    disabled={!narrowed}
                    onClick={() => {
                        setAppFilter('');
                        setQuery('');
                    }}
                >
                    Clear filters
                </button>
                <button onClick={() => setMenu(null)}>Done</button>
            </NotificationActionSheet>
            <NotificationActionSheet
                open={menu === 'bulk'}
                title={`${source?.name || 'iPhone'} notifications`}
                description={`${count(filtered.length)} in this view.`}
                onClose={() => setMenu(null)}
            >
                <button disabled={busy || !matchingUnread.length} onClick={markAllRead}>
                    Mark all read
                </button>
                <button disabled={busy || !localDismissals.length} onClick={archiveAll}>
                    Archive all
                </button>
                <button
                    disabled={busy || !phoneDismissals.length}
                    onClick={(event) => clearAllOnPhone(event.currentTarget)}
                >
                    Clear all on iPhone
                </button>
                {bulkConfirm.armed && confirmation && (
                    <ConfirmPrompt
                        action={bulkConfirm}
                        question={`Clear ${count(confirmation.snapshot.length)} on ${confirmation.name}?`}
                        consequence="They are removed from the iPhone and cannot be brought back there. They stay here, marked as read."
                        confirmLabel="Clear on iPhone"
                        danger
                        layout="stack"
                        onConfirm={confirmClearAll}
                    />
                )}
            </NotificationActionSheet>
            {menuItem && (
                <NotificationActionSheet
                    open={!!selectedMenuItem}
                    title={menuItem.appName || menuItem.app || 'Notification'}
                    description={menuItem.title}
                    onClose={() => setMenuKey('')}
                >
                    {screen?.unavailable ? (
                        <button disabled>
                            Open iPhone screen
                            <small class="notification-action-reason">{screen.unavailable}</small>
                        </button>
                    ) : (
                        <a href={`#!${new URLSearchParams(screen?.params)}`}>Open iPhone screen</a>
                    )}
                    {!menuItem.dismissed && (
                        <button disabled={busy} onClick={() => localAction(menuItem, 'read')}>
                            {menuItem.read ? 'Mark unread' : 'Mark read'}
                        </button>
                    )}
                    {!menuItem.dismissed && (
                        <button disabled={busy} onClick={() => localAction(menuItem, 'dismiss')}>
                            Archive
                        </button>
                    )}
                    {menuItem.dismissed && (
                        <button disabled={busy} onClick={() => moveToInbox(menuItem)}>
                            Move to inbox
                        </button>
                    )}
                    {menuItem.active && menuItem.canDismiss && menuItem.negativeActionLabel && (
                        <>
                            <h3 class="notification-action-sheet-group">On {source?.name || 'the iPhone'}</h3>
                            <button
                                disabled={busy || accepted.includes(menuItem.key)}
                                onClick={(event) => {
                                    if (isDismissActionLabel(menuItem.negativeActionLabel)) phoneAction(menuItem);
                                    else phoneConfirm.arm(menuItem.key, event.currentTarget);
                                }}
                            >
                                {accepted.includes(menuItem.key)
                                    ? 'Action sent'
                                    : `${menuItem.negativeActionLabel} on iPhone`}
                            </button>
                            {phoneConfirm.armed === menuItem.key && (
                                <ConfirmPrompt
                                    action={phoneConfirm}
                                    question={`${menuItem.negativeActionLabel} on ${source?.name || 'the iPhone'}?`}
                                    consequence={`This runs on the iPhone for “${menuItem.title || menuItem.appName || 'this notification'}” and cannot be undone from here.`}
                                    confirmLabel={menuItem.negativeActionLabel}
                                    danger
                                    layout="stack"
                                    onConfirm={() => phoneAction(menuItem)}
                                />
                            )}
                        </>
                    )}
                </NotificationActionSheet>
            )}
        </section>
    );
}
