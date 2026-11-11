import type { NotificationSummary } from '../../common/Notification';
import { notificationRoute } from './notificationPage';

/** True when this iPhone sends its notifications to the server, so it has an inbox of its own. */
export function isNotificationSource(summary: NotificationSummary, udid: string): boolean {
    return summary.sources.some((source) => source.id === udid);
}

/**
 * Where a Notifications control leads and the count it shows. On the screen of an iPhone that
 * sends notifications it is that phone's inbox and that phone's unread count; everywhere else
 * it is the inbox with the total.
 */
export function notificationsTarget(summary: NotificationSummary, udid?: string): { href: string; unread: number } {
    if (udid && isNotificationSource(summary, udid)) {
        return {
            href: `#!${notificationRoute({ source: udid })}`,
            unread: summary.unreadBySource[udid] || 0,
        };
    }
    return { href: `#!${notificationRoute()}`, unread: summary.unread || 0 };
}
