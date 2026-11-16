import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { NotificationSource, NotificationStatus } from '../../common/Notification';
import {
    notificationRequest as api,
    closeReadNotifications,
    PHONE_ACTION_TIMEOUT_MS,
    BULK_PHONE_ACTION_TIMEOUT_MS,
} from '../state/notifications';
import { route } from '../state/router';
import { setAppMuted, isAppMuted } from '../state/notificationSources';
import { Menu, MenuItem } from '../ui/Menu';
import { notificationDay, notificationDayLabel, notificationStacks } from './notifications/inbox';
import { deviceHref } from '../state/links';
import { NotificationFilter, readNotificationPage } from '../state/notificationPage';
import { changeNotificationPage, openScreenFromNotifications, takeNotificationScroll } from '../state/notificationNav';
import { findDeviceByUdid, isDeviceAvailable } from '../state/devices';
import { Toast } from '../ui/Toast';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { SelectField, TextField } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { InlineStatus } from '../ui/InlineStatus';
import { badgeText } from '../ui/Badge';
import { Chip, ChipTone } from '../ui/Chip';
import { SegmentedControl } from '../ui/SegmentedControl';
import { topSheet } from '../ui/Sheet';
import { ConfirmPrompt, useArmedAction } from '../ui/ConfirmAction';
import { animate, reducedMotion } from '../ui/motion';
import { NotificationCard } from './NotificationCard';
import { NotificationActionSheet } from './NotificationActionSheet';
import { isDismissActionLabel } from '../../common/NotificationActions';
import '../../style/views/NotificationsInbox.css';

export type { NotificationHistoryItem as HistoryItem } from '../../common/Notification';
import type { NotificationHistoryItem as HistoryItem } from '../../common/Notification';

/**
 * The unread count in the bar of Notifications: words after the status line, on the same line
 * (`notification-bar-status`). Nothing for zero. The status line keeps its own text. Where the
 * line has no room for both, the words are not shown (`NotificationsPage.css`); the filter row
 * has the count too.
 */
export function UnreadCount({ count }: { count: number }) {
    const text = badgeText(count);
    return text ? (
        <span class="notification-unread-line">
            {' · '}
            <span class="notification-unread-count">{text}</span> unread
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
export const FEED_LABELS: Record<FeedState, string> = {
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    attention: 'Action needed',
};
export const FEED_TONES: Record<FeedState, ChipTone> = {
    connected: 'success',
    reconnecting: 'warning',
    attention: 'error',
};
export function FeedBadge({ state }: { state: FeedState }) {
    return (
        <Chip tone={FEED_TONES[state]} class="notification-badge">
            {FEED_LABELS[state]}
        </Chip>
    );
}

/** The link to an iPhone's screen, or why it cannot be opened now. */
function screenLink(source: NotificationSource): { href?: string; unavailable?: string } {
    const entry = findDeviceByUdid(source.id);
    return entry && isDeviceAvailable(entry)
        ? { href: deviceHref(source.id, 'screen', entry.params) }
        : { unavailable: `${source.name} is not connected to the NUC by USB.` };
}

function sentence(text: string): string {
    return /[.!?]$/.test(text) ? text : `${text}.`;
}

function count(n: number): string {
    return `${n} notification${n === 1 ? '' : 's'}`;
}

/** A highlighted notification (opened from a push) keeps its outline this long. */
export const HIGHLIGHT_MS = 4000;

/**
 * The search text goes into the address after this pause in typing. Safari refuses more than
 * 100 history writes in 30 seconds, which a write for every key can reach.
 */
const QUERY_WRITE_MS = 400;

// Undo belongs to the viewed scope: one source, or all iPhones when `source` is empty.
type UndoAction = { source: string; label: string; revert: () => Promise<unknown> };
// `retry` is offered only for actions that need no confirmation.
type Failure = { message: string; retry?: () => void; undo?: boolean };
const FILTERS: ReadonlyArray<{ value: NotificationFilter; label: string }> = [
    { value: 'inbox', label: 'Inbox' },
    { value: 'unread', label: 'Unread' },
    { value: 'archive', label: 'Archive' },
];

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
    statuses,
    feedError,
    connectionError,
    busy,
    run,
    refresh,
    searchOpen,
    setSearchOpen,
}: {
    sources: NotificationSource[];
    items: HistoryItem[];
    // The collector's status text for each iPhone, and its own error.
    statuses: Record<string, string>;
    feedError: string;
    connectionError: string;
    busy: boolean;
    run: (fn: () => Promise<void>, onError?: (message: string) => void) => Promise<unknown>;
    refresh: () => Promise<unknown>;
    /** The search row, opened and closed from the page's bar. */
    searchOpen: boolean;
    setSearchOpen: (open: boolean) => void;
}) {
    // The iPhone, the filter, the app and the search text are in the address, so a reload, a
    // link and a return with Back show the same inbox; see `state/notificationPage.ts`.
    const alive = useRef(true);
    useLayoutEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);
    const page = readNotificationPage(route.value);
    const { filter, app: appFilter } = page;
    // An explicit source stays scoped. With several linked iPhones, no source shows them together.
    const source = sources.find((s) => s.id === page.source) || (sources.length === 1 ? sources[0] : undefined);
    const scope = source?.id || '';
    const currentSource = useRef(scope);
    currentSource.current = scope;
    // The notification a push banner opened. The address names it only until it is found.
    const [highlighted, setHighlighted] = useState('');
    const [highlightOn, setHighlightOn] = useState(false);
    const expandedHighlight = useRef('');
    // Where the list was when a screen was opened from it, on the return with Back.
    const [kept] = useState(takeNotificationScroll);
    const [limit, setLimit] = useState(kept?.limit ?? 25);
    // The field shows what is typed at once; the address follows after a pause.
    const [query, setQuery] = useState(page.q);
    const typed = useRef(page.q);
    const queryInAddress = useRef(page.q);
    const queryTimer = useRef<number>();
    /** Changes the view. Search text that is still waiting for its pause is written with it. */
    const show = (change: Parameters<typeof changeNotificationPage>[0] = {}) => {
        clearTimeout(queryTimer.current);
        queryTimer.current = undefined;
        const q = change.q ?? typed.current;
        typed.current = q;
        queryInAddress.current = q;
        setQuery(q);
        changeNotificationPage({ ...change, q });
    };
    const typeQuery = (value: string) => {
        typed.current = value;
        setQuery(value);
        clearTimeout(queryTimer.current);
        queryTimer.current = window.setTimeout(show, QUERY_WRITE_MS);
    };
    /** Shows the search text of the address. Text typed and not yet written is dropped. */
    const adoptQuery = () => {
        clearTimeout(queryTimer.current);
        queryTimer.current = undefined;
        typed.current = page.q;
        queryInAddress.current = page.q;
        setQuery(page.q);
    };
    // Search text the address got some other way: a link, or a filter reset.
    useEffect(() => {
        if (page.q !== queryInAddress.current) adoptQuery();
    }, [page.q]);
    // Leaving for Setup keeps text typed a moment ago. After another page is shown this writes nothing.
    useEffect(
        () => () => {
            if (queryTimer.current === undefined) return;
            clearTimeout(queryTimer.current);
            changeNotificationPage({ q: typed.current });
        },
        [],
    );
    const searchRow = useRef<HTMLDivElement>(null);
    const searchWasOpen = useRef(searchOpen);
    const [menu, setMenu] = useState<'filters' | 'bulk' | null>(null);
    const [menuKey, setMenuKey] = useState('');
    const menuAnchor = useRef<HTMLElement>(null);
    const [mouseMenu, setMouseMenu] = useState(() => matchMedia('(pointer: fine)').matches);
    const [cardSheet, setCardSheet] = useState(false);
    const cardSheetRef = useRef(false);
    const [openStacks, setOpenStacks] = useState(new Set<string>());
    const [expandedNotifications, setExpandedNotifications] = useState(new Set<string>());
    const focusAfterAction = useRef('');
    useEffect(() => {
        const media = matchMedia('(pointer: fine)');
        const change = () => {
            setMouseMenu(media.matches);
            setMenuKey('');
        };
        media.addEventListener('change', change);
        return () => media.removeEventListener('change', change);
    }, []);
    const closeCardMenu = () => {
        if (!cardSheetRef.current) setMenuKey('');
    };
    const closeCardSheet = () => {
        cardSheetRef.current = false;
        setCardSheet(false);
        setMenuKey('');
    };
    const openCardMenu = (key: string, anchor?: HTMLElement) => {
        menuAnchor.current = anchor || null;
        cardSheetRef.current = false;
        setCardSheet(false);
        setMenuKey(key);
    };
    const [undo, setUndo] = useState<UndoAction | null>(null);
    const [failure, setFailure] = useState<Failure | null>(null);
    const pending = useRef(new Set<string>());
    const [pendingKeys, setPendingKeys] = useState(new Set<string>());
    const [accepted, setAccepted] = useState<string[]>([]);
    const [bulkBusy, setBulkBusy] = useState<'' | 'archive' | 'phone'>('');
    const [confirmation, setConfirmation] = useState<PhoneClear | null>(null);
    // Clearing on the iPhone is confirmed in the bulk sheet itself. Closing that sheet disarms it.
    const bulkConfirm = useArmedAction<'phone'>(menu === 'bulk');
    const scrolled = useRef('');
    const list = useRef<HTMLElement>(null);
    const scroller = () => list.current?.closest<HTMLElement>('.notifications-page');
    const positions = useRef(new Map<string, number>());
    const reasonId = useId();
    const sheetReasonId = useId();
    // A sheet lies where the notices are, at the bottom of a phone's screen, and a notice drawn
    // over it would cover its last action. The notices wait until the sheet has gone.
    const noticesHeld = topSheet.value !== null;
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
    const phoneItems = items.filter((n) =>
        source ? n.source === source.id : sources.some((phone) => phone.id === n.source),
    );
    const apps = [...new Map(phoneItems.filter((n) => n.app).map((n) => [n.app!, n.appName || n.app!])).entries()].sort(
        (a, b) => a[1].localeCompare(b[1]),
    );
    const tokens = searchText(query.trim()).split(/\s+/).filter(Boolean);
    const filtered = phoneItems.filter(
        (n) =>
            (filter === 'archive' ? n.dismissed : !n.dismissed) &&
            (filter !== 'unread' || !n.read || expandedNotifications.has(n.key)) &&
            (!appFilter || n.app === appFilter) &&
            (!tokens.length || matchesSearch(n, tokens)),
    );
    const localDismissals = filtered.filter((n) => !n.dismissed);
    const phoneDismissals = filtered.filter(
        (n) => n.active && n.canDismiss && isDismissActionLabel(n.negativeActionLabel) && !accepted.includes(n.key),
    );
    const selectedMenuItem = phoneItems.find((n) => n.key === menuKey);
    const menuSource = sources.find((s) => s.id === selectedMenuItem?.source);
    const menuScreen = menuSource ? screenLink(menuSource) : undefined;
    const previousMenuItem = useRef<HistoryItem>();
    if (selectedMenuItem) previousMenuItem.current = selectedMenuItem;
    const menuItem = selectedMenuItem || previousMenuItem.current;
    // A phone action other than a plain dismissal (Decline, Delete) needs a confirming press.
    // Closing the card's sheet disarms it.
    const phoneConfirm = useArmedAction<string>(!!selectedMenuItem);
    const [phoneResult, setPhoneResult] = useState('');
    // The Sheet first takes focus itself. Arm after it opens so that focus move does not
    // withdraw the prompt the menu requested. No command is sent until confirmation.
    useEffect(() => {
        if (cardSheet && selectedMenuItem) phoneConfirm.arm(selectedMenuItem.key, menuAnchor.current);
    }, [cardSheet]);
    const matchingUnread = filtered.filter((n) => !n.read && !n.dismissed);
    const narrowed = !!query.trim() || !!appFilter;
    // Text or an app filter keeps the search row open, also when it came with a link.
    useEffect(() => {
        if (narrowed && !searchOpen) setSearchOpen(true);
    }, [narrowed]);
    // Opened from the bar: the field takes focus. Closed from the bar: the search is cleared.
    useEffect(() => {
        if (searchOpen === searchWasOpen.current) return;
        searchWasOpen.current = searchOpen;
        if (searchOpen) searchRow.current?.querySelector('input')?.focus();
        else if (narrowed || typed.current) show({ app: '', q: '' });
    }, [searchOpen]);
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
    const openScreen = (item?: HistoryItem) => {
        const phone = item ? sources.find((s) => s.id === item.source) : source;
        const link = phone ? screenLink(phone) : undefined;
        if (!link) return;
        if (link.unavailable) {
            setUndo(null);
            setPhoneResult('');
            setFailure({ message: link.unavailable });
        } else if (link.href) {
            // Flush a pending search before the read request, so its debounce cannot cancel
            // this open by changing the address while the request is waiting.
            show();
            const openedFrom = route.peek().toString();
            const navigate = () => {
                if (!alive.current || route.peek().toString() !== openedFrom) return;
                clearTimeout(queryTimer.current);
                queryTimer.current = undefined;
                queryInAddress.current = typed.current;
                openScreenFromNotifications(link.href!, typed.current, {
                    top: scroller()?.scrollTop ?? 0,
                    limit,
                });
            };
            if (item && !item.read)
                attempt(async () => {
                    await markRead([item.key]);
                    navigate();
                });
            else navigate();
        }
    };
    const followScreenLink = (event: MouseEvent, item?: HistoryItem) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            if (item && !item.read) attempt(() => markRead([item.key]));
            return;
        }
        event.preventDefault();
        openScreen(item);
    };
    const markRead = async (keys: string[], read = true) => {
        await api('history/read', 'POST', { keys, read });
        if (read) closeReadNotifications(keys);
        await refresh();
    };
    const shownBefore = useRef(false);
    useEffect(() => {
        // Not on the first run: a return with Back lists as many as were listed before.
        if (shownBefore.current) setLimit(25);
    }, [filter, scope, query, appFilter]);
    useEffect(() => {
        // The filters of another iPhone are the ones the address has: the iPhone select clears
        // them when it changes the iPhone. Text typed for the first one does not follow.
        adoptQuery();
        shownBefore.current = true;
        setMenu(null);
        setMenuKey('');
        setUndo(null);
        setFailure(null);
        setConfirmation(null);
        setPhoneResult('');
        setOpenStacks(new Set());
        setExpandedNotifications(new Set());
        focusAfterAction.current = '';
    }, [scope]);
    useEffect(() => {
        if (!page.notification) return;
        const item = phoneItems.find((n) => n.key === page.notification);
        if (!item) return;
        // Opened once: the name leaves the address here, so a reload, a return with Back or a
        // later filter does not open it again. The same banner tapped again does.
        scrolled.current = '';
        setHighlighted(item.key);
        show({ notification: '', filter: item.dismissed ? 'archive' : 'inbox', app: '', q: '' });
        if (!item.read) attempt(() => markRead([item.key]));
    }, [page.notification, items, scope]);
    useEffect(() => {
        if (highlighted && !query && !appFilter) {
            const index = filtered.findIndex((n) => n.key === highlighted);
            if (index >= 0) {
                setLimit((current) => Math.max(current, index + 1));
                if (expandedHighlight.current !== highlighted) {
                    const stack = notificationStacks(filtered).find((group) =>
                        group.some((n) => n.key === highlighted),
                    );
                    if (stack) {
                        expandedHighlight.current = highlighted;
                        setOpenStacks((current) => new Set([...current, stack[0].key]));
                    }
                }
            }
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
    // The stored notifications arrive with the status, so the list is complete on the first run.
    useLayoutEffect(() => {
        const node = scroller();
        if (kept && node) node.scrollTop = kept.top;
    }, []);
    useEffect(() => {
        if (!highlightOn) return;
        const timer = setTimeout(() => setHighlightOn(false), HIGHLIGHT_MS);
        return () => clearTimeout(timer);
    }, [highlightOn, highlighted]);
    const planFocus = (key: string) => {
        const cards = Array.from(
            list.current?.querySelectorAll<HTMLElement>('article.notification-history-item') || [],
        );
        const index = cards.findIndex(
            (card) => card.closest<HTMLElement>('[data-notification-key]')?.dataset.notificationKey === key,
        );
        const next = cards[index + 1] || cards[index - 1];
        return next?.closest<HTMLElement>('[data-notification-key]')?.dataset.notificationKey || '';
    };
    const restoreCardFocus = () => {
        if (!focusAfterAction.current) return;
        const node = list.current?.querySelector<HTMLElement>(
            `[data-notification-key="${CSS.escape(focusAfterAction.current)}"] article`,
        );
        if (node) {
            node.focus({ preventScroll: true });
            focusAfterAction.current = '';
        }
    };
    useLayoutEffect(() => {
        if (!topSheet.peek()) restoreCardFocus();
    }, [items]);
    useEffect(() => {
        const closed = () => requestAnimationFrame(restoreCardFocus);
        document.addEventListener('close', closed, true);
        return () => document.removeEventListener('close', closed, true);
    }, []);
    const localAction = async (item: HistoryItem, kind: 'read' | 'dismiss', moveFocus = true) => {
        if ((busy && !pending.current.size) || pending.current.has(item.key)) return;
        const nextFocus = moveFocus ? planFocus(item.key) : '';
        const actionScope = scope;
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
                    if (currentSource.current === actionScope) focusAfterAction.current = nextFocus;
                    if (moveFocus)
                        offerUndo({
                            source: actionScope,
                            label: kind === 'dismiss' ? 'Archived' : item.read ? 'Marked unread' : 'Marked read',
                            revert: () =>
                                kind === 'dismiss'
                                    ? api(`history/${encodeURIComponent(item.key)}/restore`, 'POST', {
                                          read: item.read,
                                      })
                                    : api('history/read', 'POST', { keys: [item.key], read: item.read }),
                        });
                    await refresh();
                },
                () => void localAction(item, kind, moveFocus),
            );
        } finally {
            pending.current.delete(item.key);
            setPendingKeys(new Set(pending.current));
        }
    };
    const undoLast = () => {
        if (!undo || busy || undo.source !== scope) return;
        const action = undo;
        attempt(async () => {
            await action.revert();
            setUndo(null);
            await refresh();
        });
    };
    const moveToInbox = (item: HistoryItem) => {
        const nextFocus = planFocus(item.key);
        const actionScope = scope;
        setMenuKey('');
        setUndo(null);
        attempt(async () => {
            await api(`history/${encodeURIComponent(item.key)}/restore`, 'POST', { read: true });
            if (currentSource.current === actionScope) focusAfterAction.current = nextFocus;
            await refresh();
        });
    };
    const phoneAction = (item: HistoryItem) => {
        const nextFocus = planFocus(item.key);
        const actionScope = scope;
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
                    if (currentSource.current === actionScope) focusAfterAction.current = nextFocus;
                    await refresh();
                    requestAnimationFrame(() => {
                        if (!topSheet.peek()) restoreCardFocus();
                    });
                },
                isDismissActionLabel(label) ? go : undefined,
            );
        go();
    };
    const markAllRead = () => {
        const sourceId = scope;
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
        if (busy || bulkBusy || !localDismissals.length) return;
        const actionScope = scope;
        const snapshot = localDismissals.map((n) => ({ source: n.source, key: n.key, read: n.read }));
        setMenu(null);
        setUndo(null);
        setPhoneResult('');
        attempt(async () => {
            setBulkBusy('archive');
            const archived: typeof snapshot = [];
            let problem: unknown;
            try {
                for (const sourceId of new Set(snapshot.map((n) => n.source))) {
                    const selected = snapshot.filter((n) => n.source === sourceId);
                    const reply = await api<{ dismissed: string[] }>('history/dismiss', 'POST', {
                        source: sourceId,
                        keys: selected.map((n) => n.key),
                    });
                    closeReadNotifications(reply.dismissed);
                    archived.push(...selected.filter((n) => reply.dismissed.includes(n.key)));
                }
            } catch (error) {
                problem = error;
            } finally {
                if (archived.length)
                    offerUndo({
                        source: actionScope,
                        label: `Archived ${count(archived.length)}${source ? ` from ${source.name}` : ''}`,
                        revert: async () => {
                            for (const sourceId of new Set(archived.map((n) => n.source))) {
                                await api('history/restore', 'POST', {
                                    source: sourceId,
                                    items: archived
                                        .filter((n) => n.source === sourceId)
                                        .map(({ key, read }) => ({ key, read })),
                                });
                            }
                        },
                    });
                try {
                    await refresh();
                } catch (error) {
                    problem = problem || error;
                }
                setBulkBusy('');
            }
            if (problem && currentSource.current === actionScope)
                setFailure({ message: (problem as Error).message, undo: !!archived.length });
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
    // Sources are saved as whole records. Read again before each save, including Undo,
    // so another browser's changes since our last poll are kept.
    const freshSource = async (id: string) => {
        const current = await api<Pick<NotificationStatus, 'sources'>>('status');
        if (!alive.current) throw Error('The inbox is closed.');
        const phone = current.sources.find((s) => s.id === id);
        if (!phone) throw Error('This iPhone is no longer linked.');
        return phone;
    };
    const muteApp = (item: HistoryItem) => {
        if (!item.app || busy) return;
        const actionScope = scope;
        const nextFocus = planFocus(item.key);
        setMenuKey('');
        attempt(async () => {
            const phone = await freshSource(item.source);
            const wasMuted = isAppMuted(phone, item.app!);
            await setAppMuted(phone, item.app!, item.appName || item.app!, true);
            if (currentSource.current === actionScope) focusAfterAction.current = nextFocus;
            await refresh();
            requestAnimationFrame(() => {
                if (!topSheet.peek()) restoreCardFocus();
            });
            offerUndo({
                source: actionScope,
                label: `${item.appName || item.app} muted`,
                revert: async () => {
                    const current = await freshSource(item.source);
                    await setAppMuted(current, item.app!, item.appName || item.app!, wasMuted);
                },
            });
        });
    };
    const keys = useRef<(event: KeyboardEvent) => void>();
    keys.current = (event) => {
        if (
            event.defaultPrevented ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            event.isComposing ||
            document.querySelector('dialog.kit-sheet[open], .kit-menu[role="menu"]') ||
            (event.target instanceof Element &&
                event.target.closest(
                    'input, textarea, select, video, audio, [contenteditable]:not([contenteditable="false"])',
                ))
        )
            return;
        const key = event.key.toLowerCase();
        const cards = Array.from(
            list.current?.querySelectorAll<HTMLElement>('article.notification-history-item') || [],
        );
        const current = cards.findIndex(
            (card) => card === document.activeElement || card.contains(document.activeElement),
        );
        const item =
            current >= 0
                ? phoneItems.find(
                      (n) =>
                          n.key ===
                          cards[current].closest<HTMLElement>('[data-notification-key]')?.dataset.notificationKey,
                  )
                : undefined;
        if (key === '/') {
            event.preventDefault();
            setSearchOpen(true);
            requestAnimationFrame(() => searchRow.current?.querySelector('input')?.focus());
        } else if (key === 'j' || key === 'arrowdown' || key === 'k' || key === 'arrowup') {
            event.preventDefault();
            const step = key === 'j' || key === 'arrowdown' ? 1 : -1;
            cards[
                current < 0
                    ? step > 0
                        ? 0
                        : cards.length - 1
                    : Math.max(0, Math.min(cards.length - 1, current + step))
            ]?.focus();
        } else if (key === 'z' && undo) {
            event.preventDefault();
            undoLast();
        } else if (item && !busy && (key === 'u' || (key === 'e' && !item.dismissed))) {
            event.preventDefault();
            void localAction(item, key === 'e' ? 'dismiss' : 'read');
        }
    };
    useEffect(() => {
        const listener = (event: KeyboardEvent) => keys.current?.(event);
        document.addEventListener('keydown', listener);
        return () => document.removeEventListener('keydown', listener);
    }, []);
    const stacks = notificationStacks(filtered.slice(0, limit));
    let previousDay = '';
    return (
        <section class="notification-history" aria-labelledby="notification-history-heading" aria-busy={!!bulkBusy}>
            <h2 id="notification-history-heading" class="visually-hidden">
                {filter === 'archive' ? 'Archive' : filter === 'unread' ? 'Unread' : 'Inbox'}
            </h2>
            {/* The bar of the page names the iPhone and its link state. A link that is not live
                is explained here. */}
            {source && (feedError || state !== 'connected') && (
                <div class="notification-history-source">
                    {feedError ? (
                        <Banner tone="error">Notifications are not being received. {sentence(feedError)}</Banner>
                    ) : state === 'attention' ? (
                        <Banner tone="error">
                            {source.name}: {statusText}
                        </Banner>
                    ) : state === 'reconnecting' ? (
                        <Banner tone="info">
                            New notifications from {source.name} appear when it reconnects. {statusText}
                        </Banner>
                    ) : null}
                </div>
            )}
            {!source && feedError && (
                <Banner tone="error">Notifications are not being received. {sentence(feedError)}</Banner>
            )}
            <div class="notification-history-tools">
                {connectionError && <Banner tone="error">Connection interrupted. {connectionError}</Banner>}
                {searchOpen && (
                    <div class="notification-search" ref={searchRow}>
                        <TextField
                            type="search"
                            label="Search notifications"
                            labelHidden
                            placeholder="Search notifications"
                            value={query}
                            onInput={(event) => typeQuery(event.currentTarget.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') event.currentTarget.blur();
                            }}
                            enterKeyHint="search"
                            autoComplete="off"
                        />
                        <Button
                            attributes={{
                                'aria-haspopup': 'dialog',
                                'aria-label': appFilter ? 'Filters, app filter active' : 'Filters',
                            }}
                            onClick={() => setMenu('filters')}
                        >
                            Filters{appFilter ? ' · 1' : ''}
                        </Button>
                    </div>
                )}
                <div class="notification-history-toolbar">
                    <SegmentedControl
                        label="Notification view"
                        options={FILTERS.map((option) => ({
                            ...option,
                            label:
                                option.value === 'archive'
                                    ? option.label
                                    : `${option.label} ${phoneItems.filter((n) => !n.dismissed && (option.value !== 'unread' || !n.read)).length}`,
                        }))}
                        value={filter}
                        onChange={(value) => show({ filter: value })}
                        full
                    />
                    <IconButton
                        icon="check"
                        variant="bare"
                        label="Mark all read"
                        disabled={busy || !matchingUnread.length}
                        onClick={markAllRead}
                    />
                    <IconButton
                        icon="more"
                        variant="bare"
                        class="notification-menu-button"
                        label="Notification actions"
                        attributes={{ 'aria-haspopup': 'dialog' }}
                        disabled={busy}
                        onClick={() => setMenu('bulk')}
                    />
                </div>
                {narrowed ? (
                    <div class="notification-search-summary" role="status">
                        <span>
                            {filtered.length} result{filtered.length === 1 ? '' : 's'}
                            {appFilter ? ` · ${apps.find(([id]) => id === appFilter)?.[1] || appFilter}` : ''}
                        </span>
                        <Button variant="quiet" size="compact" onClick={() => show({ app: '', q: '' })}>
                            Clear filters
                        </Button>
                    </div>
                ) : null}
                {bulkBusy && (
                    <InlineStatus>
                        {bulkBusy === 'phone' ? `Clearing on ${source?.name || 'the iPhone'}…` : 'Archiving…'}
                    </InlineStatus>
                )}
            </div>
            {!filtered.length && (
                <div class="notification-empty">
                    <strong class="notification-empty-title">
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
                        <p class="notification-empty-note">Try another search or filter.</p>
                    ) : filter === 'inbox' && phoneItems.length ? (
                        <p class="notification-empty-note">Archived notifications are in Archive.</p>
                    ) : filter === 'archive' ? (
                        <p class="notification-empty-note">Swipe a notification left to archive it.</p>
                    ) : null}
                </div>
            )}
            {!!sources.length && (
                <section
                    ref={list}
                    class="notification-history-group"
                    aria-label={`${source?.name || 'All iPhones'} notification history`}
                >
                    {stacks.map((stack) => {
                        const head = stack[0];
                        const day = notificationDay(head.received);
                        const heading = day !== previousDay;
                        previousDay = day;
                        const expanded = openStacks.has(head.key);
                        return (
                            <div class="notification-stack" key={head.key}>
                                {heading && <h3 class="notification-day">{notificationDayLabel(head.received)}</h3>}
                                {(expanded ? stack : stack.slice(0, 1)).map((n) => {
                                    const phone = sources.find((s) => s.id === n.source)!;
                                    return (
                                        <NotificationCard
                                            key={n.key}
                                            item={n}
                                            source={phone}
                                            busy={pendingKeys.has(n.key) || (busy && !pendingKeys.size)}
                                            removeOnRead={filter === 'unread' && !n.read}
                                            highlighted={highlightOn && highlighted === n.key}
                                            markRead={() => localAction(n, 'read')}
                                            dismiss={() => localAction(n, 'dismiss')}
                                            onExpand={(expanded) => {
                                                setExpandedNotifications((current) => {
                                                    const next = new Set(current);
                                                    if (expanded) next.add(n.key);
                                                    else next.delete(n.key);
                                                    return next;
                                                });
                                                if (expanded && !n.read) void localAction(n, 'read', false);
                                            }}
                                            showSource={!source && sources.length > 1}
                                            menuIsPopover={mouseMenu}
                                            openMenu={(anchor) => openCardMenu(n.key, anchor)}
                                            openScreen={() => openScreen(n)}
                                        />
                                    );
                                })}
                                {stack.length > 1 && (
                                    <Button
                                        variant="quiet"
                                        class="notification-stack-toggle"
                                        attributes={{ 'aria-expanded': String(expanded) }}
                                        onClick={() =>
                                            setOpenStacks((current) => {
                                                const next = new Set(current);
                                                if (expanded) next.delete(head.key);
                                                else next.add(head.key);
                                                return next;
                                            })
                                        }
                                    >
                                        {expanded
                                            ? 'Collapse stack'
                                            : `Show ${stack.length - 1} older notification${stack.length === 2 ? '' : 's'}`}
                                    </Button>
                                )}
                            </div>
                        );
                    })}
                </section>
            )}
            {filtered.length > limit && (
                <Button full class="notification-show-more" onClick={() => setLimit(limit + 25)}>
                    Show older notifications ({filtered.length - limit})
                </Button>
            )}
            {filter === 'archive' && !!filtered.length && (
                <p class="notification-history-note">Notifications are kept for 30 days, up to 500 per iPhone.</p>
            )}
            <Toast
                className="notification-undo"
                dismissLabel="Dismiss undo notice"
                message={!noticesHeld && !failure && undo?.source === scope ? undo?.label || '' : ''}
                identity={undo}
                duration={12000}
                onDismiss={() => setUndo(null)}
                action={{ label: 'Undo', run: undoLast, disabled: busy }}
            />
            <Toast
                className="notification-phone-result"
                message={noticesHeld ? '' : phoneResult}
                identity={phoneResult}
                onDismiss={() => setPhoneResult('')}
            />
            <Toast
                className="notification-failure"
                tone="error"
                dismissLabel="Dismiss error"
                message={(!noticesHeld && failure?.message) || ''}
                identity={failure}
                duration={0}
                onDismiss={() => setFailure(null)}
                action={
                    failure?.undo && undo
                        ? { label: 'Undo', run: undoLast, disabled: busy }
                        : failure?.retry
                          ? { label: 'Retry', run: failure.retry, disabled: busy }
                          : undefined
                }
            />
            <NotificationActionSheet
                open={menu === 'filters'}
                title="Filter notifications"
                onClose={() => setMenu(null)}
            >
                <SelectField
                    label="App"
                    value={appFilter}
                    options={[
                        { value: '', label: 'All apps' },
                        // An app named in the address that this iPhone has no notification from.
                        ...(appFilter && !apps.some(([id]) => id === appFilter)
                            ? [{ value: appFilter, label: appFilter }]
                            : []),
                        ...apps.map(([id, name]) => ({ value: id, label: name })),
                    ]}
                    onChange={(event) => show({ app: event.currentTarget.value })}
                />
                <Button full disabled={!narrowed} onClick={() => show({ app: '', q: '' })}>
                    Clear filters
                </Button>
                <Button full variant="primary" onClick={() => setMenu(null)}>
                    Done
                </Button>
            </NotificationActionSheet>
            <NotificationActionSheet
                open={menu === 'bulk'}
                title={`${source?.name || 'All iPhones'} notifications`}
                description={`${count(filtered.length)} in this view.`}
                onClose={() => setMenu(null)}
            >
                {source &&
                    (screen?.unavailable ? (
                        <>
                            <Button full disabled attributes={{ 'aria-describedby': reasonId }}>
                                Open iPhone screen
                            </Button>
                            <p id={reasonId} class="notification-help">
                                {screen.unavailable}
                            </p>
                        </>
                    ) : (
                        <Button full href={screen?.href} onClick={(event) => followScreenLink(event)}>
                            Open iPhone screen
                        </Button>
                    ))}

                <Button full disabled={busy || !localDismissals.length} onClick={archiveAll}>
                    Archive all
                </Button>
                <Button
                    full
                    disabled={busy || !source || !phoneDismissals.length}
                    onClick={(event) => clearAllOnPhone(event.currentTarget)}
                >
                    Clear all on iPhone
                </Button>
                {!source && <p class="notification-help">Choose an iPhone to clear notifications on it.</p>}
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
            {selectedMenuItem && mouseMenu && (
                <Menu open={!cardSheet} anchor={menuAnchor} label="Notification actions" onClose={closeCardMenu}>
                    <MenuItem disabled={!menuScreen?.href || busy} onSelect={() => openScreen(selectedMenuItem)}>
                        Open iPhone screen
                    </MenuItem>
                    {!selectedMenuItem.dismissed && (
                        <MenuItem disabled={busy} onSelect={() => void localAction(selectedMenuItem, 'read')}>
                            {selectedMenuItem.read ? 'Mark unread' : 'Mark read'}
                        </MenuItem>
                    )}
                    {!selectedMenuItem.dismissed && (
                        <MenuItem disabled={busy} onSelect={() => void localAction(selectedMenuItem, 'dismiss')}>
                            Archive
                        </MenuItem>
                    )}
                    {selectedMenuItem.dismissed && (
                        <MenuItem disabled={busy} onSelect={() => moveToInbox(selectedMenuItem)}>
                            Move to inbox
                        </MenuItem>
                    )}
                    {selectedMenuItem.app && (
                        <MenuItem
                            disabled={busy || !!(menuSource && isAppMuted(menuSource, selectedMenuItem.app))}
                            onSelect={() => muteApp(selectedMenuItem)}
                        >
                            Mute this app
                        </MenuItem>
                    )}
                    {selectedMenuItem.active && selectedMenuItem.canDismiss && selectedMenuItem.negativeActionLabel && (
                        <MenuItem
                            disabled={busy || accepted.includes(selectedMenuItem.key)}
                            onSelect={() => {
                                if (isDismissActionLabel(selectedMenuItem.negativeActionLabel))
                                    phoneAction(selectedMenuItem);
                                else {
                                    cardSheetRef.current = true;
                                    setCardSheet(true);
                                }
                            }}
                        >
                            {accepted.includes(selectedMenuItem.key)
                                ? 'Action sent'
                                : `${selectedMenuItem.negativeActionLabel} on iPhone`}
                        </MenuItem>
                    )}
                </Menu>
            )}
            {menuItem && (
                <NotificationActionSheet
                    open={!!selectedMenuItem && (!mouseMenu || cardSheet)}
                    title={menuItem.appName || menuItem.app || 'Notification'}
                    description={menuItem.title}
                    onClose={closeCardSheet}
                >
                    {menuScreen?.unavailable ? (
                        <>
                            <Button full disabled attributes={{ 'aria-describedby': sheetReasonId }}>
                                Open iPhone screen
                            </Button>
                            <p id={sheetReasonId} class="notification-help">
                                {menuScreen!.unavailable}
                            </p>
                        </>
                    ) : (
                        <Button full href={menuScreen?.href} onClick={(event) => followScreenLink(event, menuItem)}>
                            Open iPhone screen
                        </Button>
                    )}
                    {!menuItem.dismissed && (
                        <Button full disabled={busy} onClick={() => localAction(menuItem, 'read')}>
                            {menuItem.read ? 'Mark unread' : 'Mark read'}
                        </Button>
                    )}
                    {!menuItem.dismissed && (
                        <Button full disabled={busy} onClick={() => localAction(menuItem, 'dismiss')}>
                            Archive
                        </Button>
                    )}
                    {menuItem.dismissed && (
                        <Button full disabled={busy} onClick={() => moveToInbox(menuItem)}>
                            Move to inbox
                        </Button>
                    )}
                    {menuItem.app && (
                        <Button
                            full
                            disabled={busy || !!(menuSource && isAppMuted(menuSource, menuItem.app))}
                            onClick={() => muteApp(menuItem)}
                        >
                            Mute this app
                        </Button>
                    )}
                    {menuItem.active && menuItem.canDismiss && menuItem.negativeActionLabel && (
                        <>
                            <h3 class="notification-action-sheet-group">On {menuSource?.name || 'the iPhone'}</h3>
                            <Button
                                full
                                disabled={busy || accepted.includes(menuItem.key)}
                                onClick={(event) => {
                                    if (isDismissActionLabel(menuItem.negativeActionLabel)) phoneAction(menuItem);
                                    else phoneConfirm.arm(menuItem.key, event.currentTarget);
                                }}
                            >
                                {accepted.includes(menuItem.key)
                                    ? 'Action sent'
                                    : `${menuItem.negativeActionLabel} on iPhone`}
                            </Button>
                            {phoneConfirm.armed === menuItem.key && (
                                <ConfirmPrompt
                                    action={phoneConfirm}
                                    question={`${menuItem.negativeActionLabel} on ${menuSource?.name || 'the iPhone'}?`}
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
