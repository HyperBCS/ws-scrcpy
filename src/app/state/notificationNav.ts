import { followLink } from './links';
import { NotificationPage, notificationRoute, readNotificationPage } from './notificationPage';
import { onPageChange, route, switchRoute } from './router';
import { parseRoute } from './routes';

/**
 * Changes the Notifications view and returns its address. Every change is written into the
 * current history entry: Back leaves the page, it does not step through earlier choices.
 * Nothing is written, and nothing returned, when another page is shown: a change that arrives
 * late must not put Notifications back.
 */
export function changeNotificationPage(change: Partial<NotificationPage>): string | undefined {
    const current = route.peek();
    if (parseRoute(current).page !== 'notifications') {
        return undefined;
    }
    const next = notificationRoute({ ...readNotificationPage(current), ...change });
    if (next.toString() !== current.toString()) {
        switchRoute(next);
    }
    return next.toString();
}

/** Where the inbox was when a phone's screen was opened from it. */
export interface NotificationScroll {
    top: number;
    /** How many notifications were listed ("Show older notifications" adds to it). */
    limit: number;
}

let kept: ({ address: string } & NotificationScroll) | undefined;

// A return with Back does not pass the list. An inbox opened from the list starts at the top.
onPageChange(() => {
    if (parseRoute(route.peek()).page === 'list') {
        kept = undefined;
    }
});

/**
 * Opens a phone's screen from the inbox as a new history entry. The search text is written to
 * the address first, in case it was typed a moment ago, and the place in the list is kept for
 * the return.
 */
export function openScreenFromNotifications(href: string, q: string, scroll: NotificationScroll): void {
    const address = changeNotificationPage({ q });
    if (address !== undefined) {
        kept = { address, ...scroll };
    }
    followLink(href, 'open');
}

/** The place kept for the view that is shown now, once. */
export function takeNotificationScroll(): NotificationScroll | undefined {
    if (!kept || kept.address !== route.peek().toString()) {
        return undefined;
    }
    const { top, limit } = kept;
    kept = undefined;
    return { top, limit };
}
