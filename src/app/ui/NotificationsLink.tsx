import { followLink } from '../state/links';
import { notificationSummary } from '../state/notifications';
import { notificationsTarget } from '../state/notificationsTarget';
import { Badge } from './Badge';
import { Icon } from './Icon';
import { iconButtonClass } from './IconButton';
import '../../style/ui/NotificationsLink.css';

interface NotificationsLinkProps {
    /** The iPhone on screen, if any. Its inbox opens when it sends notifications to this server. */
    udid?: string;
    /** For the header of a phone's page: no outline, like the other controls of that bar. */
    compact?: boolean;
}

/**
 * The way into Notifications from every page: the kit's icon button as a link, with the unread
 * count of the shared summary as its badge. The inbox is fed over Bluetooth, so it must not
 * depend on an iPhone card being listed.
 */
export function NotificationsLink({ udid, compact = false }: NotificationsLinkProps) {
    const { href, unread } = notificationsTarget(notificationSummary.value, udid);
    const onClick = (event: MouseEvent) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
        }
        // Through the router. A Files menu closes on the same tap and steps back over its history
        // entry; a plain link would be written first, and that step would undo it.
        event.preventDefault();
        followLink(href, 'open');
    };
    return (
        <a
            class={`${iconButtonClass({ variant: compact ? 'bare' : 'outlined' })} notifications-link ${
                compact ? 'compact' : ''
            }`.trim()}
            href={href}
            onClick={onClick}
            title="Notifications"
            aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        >
            <Icon name="bell" />
            <Badge count={unread} />
        </a>
    );
}
