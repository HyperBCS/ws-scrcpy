import { notificationsLinked, notificationSummary } from '../state/notifications';
import { UnreadBadge } from './NotificationHistory';
import '../../style/views/StreamNotificationsLink.css';

/** The way from an iPhone's screen to its notifications, with the unread count. Shown once it is linked. */
export function StreamNotificationsLink({ udid }: { udid: string }) {
    if (!notificationsLinked(udid)) return null;
    const unread = notificationSummary.value.unreadBySource[udid] || 0;
    return (
        <a
            class="stream-header-notifications"
            href={`#!${new URLSearchParams({ action: 'notifications', source: udid })}`}
            aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
            title="Notifications"
        >
            <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
            >
                <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 0 0 4 0" />
            </svg>
            <span aria-hidden="true">
                <UnreadBadge count={unread} />
            </span>
        </a>
    );
}
