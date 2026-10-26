import { AnimatedDetails } from '../ui/AnimatedDetails';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { NotificationEvent, NotificationSource } from '../../server/notifications/NotificationService';
import { notificationRequest as api, closeReadNotifications } from '../state/notifications';
import { route, pushRoute } from '../state/router';
import { Toast } from '../ui/Toast';
import { animate, reducedMotion } from '../ui/motion';
import { NotificationCard } from './NotificationCard';
import { NotificationActionSheet } from './NotificationActionSheet';
import { isDismissActionLabel } from '../../common/NotificationActions';

export type HistoryItem = NotificationEvent & {
    key: string;
    received: number;
    read: boolean;
    dismissed: boolean;
    active: boolean;
    canDismiss?: boolean;
    negativeActionLabel?: string;
};

export function UnreadBadge({ count }: { count: number }) {
    return count > 0 ? (
        <span class="notification-unread-count" aria-label={`${count} unread notifications`}>
            {count > 99 ? '99+' : count}
        </span>
    ) : null;
}

type UndoAction = { key: string; source: string; kind: 'read' | 'dismiss'; read: boolean; label: string };
function searchText(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase();
}

function matchesSearch(item: HistoryItem, tokens: string[]): boolean {
    const text = searchText([item.appName, item.app, item.title, item.subtitle, item.body].filter(Boolean).join(' '));
    return tokens.every((token) => text.includes(token));
}

type DismissalConfirmation = {
    sourceId: string;
    name: string;
    onPhone: boolean;
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
    busy,
    run,
    refresh,
}: {
    sources: NotificationSource[];
    items: HistoryItem[];
    unreadBySource: Record<string, number>;
    busy: boolean;
    run: (fn: () => Promise<void>) => Promise<void>;
    refresh: () => Promise<unknown>;
}) {
    const requestedSource = route.value.get('source') || '';
    const source = requestedSource ? sources.find((s) => s.id === requestedSource) : sources[0];
    const currentSource = useRef(source?.id);
    currentSource.current = source?.id;
    const highlighted = route.value.get('notification') || '';
    const [filter, setFilter] = useState<'inbox' | 'unread' | 'history'>('inbox');
    const [limit, setLimit] = useState(25);
    const [query, setQuery] = useState('');
    const [appFilter, setAppFilter] = useState('');
    const [menu, setMenu] = useState<'filters' | 'bulk' | null>(null);
    const [menuKey, setMenuKey] = useState('');
    const [undo, setUndo] = useState<UndoAction | null>(null);
    const pending = useRef(new Set<string>());
    const [pendingKeys, setPendingKeys] = useState(new Set<string>());
    const [accepted, setAccepted] = useState<string[]>([]);
    const [bulkMessage, setBulkMessage] = useState('');
    const [bulkError, setBulkError] = useState(false);
    const [bulkBusy, setBulkBusy] = useState('');
    const [confirmation, setConfirmation] = useState<DismissalConfirmation | null>(null);
    const lastConfirmation = useRef<DismissalConfirmation>();
    if (confirmation) lastConfirmation.current = confirmation;
    const prompt = lastConfirmation.current;
    const clicked = useRef('');
    const list = useRef<HTMLElement>(null);
    const positions = useRef(new Map<string, number>());
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
            (filter === 'history' || !n.dismissed) &&
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
    const matchingUnread = filtered.filter((n) => !n.read && !n.dismissed);
    const narrowed = !!query.trim() || !!appFilter;
    const markRead = async (keys: string[], read = true) => {
        await api('history/read', 'POST', { keys, read });
        if (read) closeReadNotifications(keys);
        await refresh();
    };
    useEffect(() => {
        setLimit(25);
        setBulkMessage('');
    }, [filter, source?.id, query, appFilter]);
    useEffect(() => {
        setQuery('');
        setAppFilter('');
        setFilter('inbox');
        setMenu(null);
        setMenuKey('');
        setUndo(null);
        setConfirmation(null);
    }, [source?.id]);
    useEffect(() => {
        if (!highlighted || clicked.current === highlighted) return;
        const item = phoneItems.find((n) => n.key === highlighted);
        if (!item) return;
        clicked.current = highlighted;
        setQuery('');
        setAppFilter('');
        setFilter(item.dismissed ? 'history' : 'inbox');
        if (!item.read) void run(() => markRead([item.key]));
    }, [highlighted, items, source?.id]);
    useEffect(() => {
        if (highlighted && !query && !appFilter) {
            const index = filtered.findIndex((n) => n.key === highlighted);
            if (index >= 0) setLimit((current) => Math.max(current, index + 1));
        }
    }, [highlighted, items, filter, query, appFilter]);
    const localAction = async (item: HistoryItem, kind: 'read' | 'dismiss') => {
        if ((busy && !pending.current.size) || pending.current.has(item.key)) return;
        pending.current.add(item.key);
        setPendingKeys(new Set(pending.current));
        setMenuKey('');
        setBulkMessage('');
        try {
            await run(async () => {
                if (kind === 'read') await api('history/read', 'POST', { keys: [item.key], read: !item.read });
                else await api(`history/${encodeURIComponent(item.key)}/dismiss`, 'POST');
                if (kind === 'dismiss' || !item.read) closeReadNotifications([item.key]);
                if (currentSource.current === item.source)
                    setUndo({
                        key: item.key,
                        source: item.source,
                        kind,
                        read: item.read,
                        label: kind === 'dismiss' ? 'Dismissed here' : item.read ? 'Marked unread' : 'Marked read',
                    });
                await refresh();
            });
        } finally {
            pending.current.delete(item.key);
            setPendingKeys(new Set(pending.current));
        }
    };
    const undoLast = () => {
        if (!undo || busy || undo.source !== source?.id) return;
        const action = undo;
        void run(async () => {
            if (action.kind === 'dismiss')
                await api(`history/${encodeURIComponent(action.key)}/restore`, 'POST', { read: action.read });
            else await api('history/read', 'POST', { keys: [action.key], read: action.read });
            setUndo(null);
            await refresh();
        });
    };
    const dismissAll = (onPhone: boolean) => {
        if (!source || busy || bulkBusy) return;
        // Freeze this exact device and alert set before confirmation. New arrivals
        // and a subsequently selected device must never join the confirmed batch.
        setMenu(null);
        const sourceId = source.id;
        const name = source.name;
        const snapshot = (onPhone ? phoneDismissals : localDismissals).map((n) => ({
            key: n.key,
            expectedLabel: n.negativeActionLabel,
        }));
        if (!snapshot.length) return;
        setConfirmation({ sourceId, name, onPhone, snapshot });
    };
    const confirmDismissAll = () => {
        if (!confirmation || busy || bulkBusy) return;
        const { sourceId, name, onPhone, snapshot } = confirmation;
        setConfirmation(null);
        setBulkMessage('');
        setUndo(null);
        setBulkError(false);
        setBulkBusy(onPhone ? 'phone' : 'here');
        void run(async () => {
            try {
                if (onPhone) {
                    const reply = await api<BulkReply>('history/actions', 'POST', {
                        source: sourceId,
                        items: snapshot,
                    });
                    setAccepted((keys) => [...keys, ...reply.accepted]);
                    closeReadNotifications(reply.accepted);
                    const remaining = reply.skipped.length + reply.failed.length + reply.unprocessed.length;
                    setBulkError(reply.failed.length > 0 || reply.unprocessed.length > 0);
                    setBulkMessage(
                        `${reply.accepted.length} dismissal request${reply.accepted.length === 1 ? '' : 's'} sent to ${name}.${remaining ? ` ${remaining} not sent or not confirmed.` : ''}${reply.failed[0] ? ` ${reply.failed[0].error}` : ''}`,
                    );
                } else {
                    const reply = await api<{ dismissed: string[] }>('history/dismiss', 'POST', {
                        source: sourceId,
                        keys: snapshot.map((n) => n.key),
                    });
                    closeReadNotifications(reply.dismissed);
                    setBulkMessage(
                        `${reply.dismissed.length} notification${reply.dismissed.length === 1 ? '' : 's'} from ${name} dismissed here. Saved in All history.`,
                    );
                }
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
            <div class="notification-source-heading">
                <h2 id="notification-history-heading" class="visually-hidden">
                    {filter === 'history' ? 'All history' : filter === 'unread' ? 'Unread' : 'Inbox'}
                </h2>
                {sources.length > 1 && (
                    <label class="notification-history-device">
                        <span class="visually-hidden">Device</span>
                        <select
                            disabled={busy}
                            value={source?.id || ''}
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
                )}
                {source && (
                    <a
                        class="notification-open-screen"
                        href={`#!${new URLSearchParams({ action: 'stream-coredevice', udid: source.id })}`}
                    >
                        Open screen →
                    </a>
                )}
            </div>
            <div class="notification-history-tools">
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
                        style={{ '--segment-index': ['inbox', 'unread', 'history'].indexOf(filter) }}
                        role="group"
                        aria-label="Filter notification history"
                    >
                        {(['inbox', 'unread', 'history'] as const).map((value) => (
                            <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                                {{ inbox: 'Inbox', unread: 'Unread', history: 'All history' }[value]}
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
            </div>
            {bulkBusy && (
                <p role="status" class="notification-help">
                    {bulkBusy === 'phone' ? 'Sending dismissals to the iPhone…' : 'Dismissing notifications…'}
                </p>
            )}
            {bulkMessage && (
                <p
                    role={bulkError ? 'alert' : 'status'}
                    class={
                        bulkError
                            ? 'notification-error notification-bulk-result'
                            : 'notification-success notification-bulk-result'
                    }
                >
                    {bulkMessage}
                </p>
            )}
            {!filtered.length && (
                <div class="notification-empty">
                    <strong>
                        {narrowed
                            ? 'No matching notifications'
                            : filter === 'unread'
                              ? 'No unread notifications'
                              : filter === 'inbox' && phoneItems.length
                                ? 'Inbox clear'
                                : 'No notifications yet'}
                    </strong>
                    {narrowed ? (
                        <p>Try another search or filter.</p>
                    ) : filter === 'inbox' && phoneItems.length ? (
                        <p>Dismissed alerts stay in All history.</p>
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
                            highlighted={highlighted === n.key}
                            markRead={() => localAction(n, 'read')}
                            dismiss={() => localAction(n, 'dismiss')}
                            openMenu={() => setMenuKey(n.key)}
                        />
                    ))}
                </section>
            )}
            {filtered.length > limit && (
                <button class="notification-show-more" onClick={() => setLimit(limit + 25)}>
                    Show older notifications ({filtered.length - limit})
                </button>
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
                    onClick={() => {
                        setAppFilter('');
                        setQuery('');
                        setFilter('inbox');
                    }}
                >
                    Reset filters
                </button>
                <button onClick={() => setMenu(null)}>Done</button>
            </NotificationActionSheet>
            <NotificationActionSheet
                open={menu === 'bulk'}
                title={`${source?.name || 'Device'} notifications`}
                description={`${filtered.length} matching notifications.`}
                onClose={() => setMenu(null)}
            >
                <button
                    disabled={busy || !matchingUnread.length}
                    onClick={() => {
                        setMenu(null);
                        setUndo(null);
                        void run(() => markRead(matchingUnread.map((n) => n.key)));
                    }}
                >
                    Mark all read
                </button>
                <button disabled={busy || !localDismissals.length} onClick={() => dismissAll(false)}>
                    Dismiss all here
                </button>
                <button disabled={busy || !phoneDismissals.length} onClick={() => dismissAll(true)}>
                    Dismiss all on phone
                </button>
            </NotificationActionSheet>
            <NotificationActionSheet
                open={!!confirmation}
                title={
                    prompt
                        ? `Dismiss ${prompt.snapshot.length} notification${prompt.snapshot.length === 1 ? '' : 's'}?`
                        : 'Dismiss notifications'
                }
                description={
                    prompt
                        ? `${prompt.onPhone ? 'On' : 'Here for'} ${prompt.name}. Only matching alerts are included. History is kept.${prompt.onPhone ? '' : ' The iPhone is unchanged.'}`
                        : undefined
                }
                onClose={() => setConfirmation(null)}
            >
                <button class="notification-confirm-dismiss" disabled={busy} onClick={confirmDismissAll}>
                    {prompt?.onPhone ? 'Dismiss on phone' : 'Dismiss here'}
                </button>
                <button onClick={() => setConfirmation(null)}>Cancel</button>
            </NotificationActionSheet>
            {menuItem && (
                <NotificationActionSheet
                    open={!!selectedMenuItem}
                    title={menuItem.appName || menuItem.app || 'Notification'}
                    description={menuItem.title}
                    onClose={() => setMenuKey('')}
                >
                    {!menuItem.dismissed && (
                        <button disabled={busy} onClick={() => localAction(menuItem, 'read')}>
                            {menuItem.read ? 'Mark unread' : 'Mark read'}
                        </button>
                    )}
                    {!menuItem.dismissed && (
                        <button disabled={busy} onClick={() => localAction(menuItem, 'dismiss')}>
                            Dismiss here
                        </button>
                    )}
                    {menuItem.dismissed && (
                        <button
                            disabled={busy}
                            onClick={() => {
                                const key = menuItem.key;
                                setMenuKey('');
                                setUndo(null);
                                void run(async () => {
                                    await api(`history/${encodeURIComponent(key)}/restore`, 'POST', { read: true });
                                    await refresh();
                                });
                            }}
                        >
                            Move to inbox
                        </button>
                    )}
                    {menuItem.active && menuItem.canDismiss && menuItem.negativeActionLabel && (
                        <button
                            disabled={busy || accepted.includes(menuItem.key)}
                            onClick={() => {
                                const item = menuItem;
                                setMenuKey('');
                                setUndo(null);
                                void run(async () => {
                                    await api(`history/${encodeURIComponent(item.key)}/action`, 'POST', {
                                        expectedLabel: item.negativeActionLabel,
                                    });
                                    closeReadNotifications([item.key]);
                                    setAccepted((keys) => [...keys, item.key]);
                                    await refresh();
                                });
                            }}
                        >
                            {accepted.includes(menuItem.key)
                                ? 'Action sent'
                                : `${menuItem.negativeActionLabel} on iPhone`}
                        </button>
                    )}
                </NotificationActionSheet>
            )}
            <AnimatedDetails class="notification-details notification-history-help">
                <summary>About history &amp; dismissal</summary>
                <p class="notification-history-note">
                    Swipe right to mark read or unread; left to dismiss here. Dismissed alerts stay in All history.
                    Phone actions also clear the alert on the iPhone.
                </p>
                <p class="notification-history-note">
                    Read status only applies here. History is kept for 30 days, up to 500 alerts per phone.
                </p>
            </AnimatedDetails>
        </section>
    );
}
