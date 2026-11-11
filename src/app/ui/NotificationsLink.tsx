import { notificationSummary } from '../state/notifications';
import { notificationsTarget } from '../state/notificationsTarget';
import '../../style/ui/NotificationsLink.css';

interface NotificationsLinkProps {
    /** The iPhone on screen, if any. Its inbox opens when it sends notifications to this server. */
    udid?: string;
    /** Icon only, for the stream and tool header. The Devices header shows the word as well. */
    compact?: boolean;
}

export function BellIcon() {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
            <path d="M10 21h4" />
        </svg>
    );
}

/**
 * The way into Notifications from every page. The inbox is fed over Bluetooth, so it must not
 * depend on an iPhone card being listed. Shows the unread count from the shared summary.
 */
export function NotificationsLink({ udid, compact = false }: NotificationsLinkProps) {
    const { href, unread } = notificationsTarget(notificationSummary.value, udid);
    return (
        <a
            class={`notifications-link ${compact ? 'compact' : ''}`}
            href={href}
            title="Notifications"
            aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        >
            <BellIcon />
            {!compact && <span class="notifications-link-label">Notifications</span>}
            {unread > 0 && (
                <span class="notification-unread-count" aria-hidden="true">
                    {unread > 99 ? '99+' : unread}
                </span>
            )}
        </a>
    );
}
