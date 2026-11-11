import '../../style/kit/Badge.css';

/** The words of a count: nothing for zero, and "99+" past 99. */
export function badgeText(count: number): string {
    return count > 0 ? (count > 99 ? '99+' : String(count)) : '';
}

/**
 * A count on the corner of an icon button, such as unread notifications. It draws nothing for
 * zero. The count is hidden from assistive technology here: the button it sits on says it in
 * its name ("Notifications, 5 unread"), because a button's name replaces what is inside it.
 */
export function Badge({ count }: { count: number }) {
    const text = badgeText(count);
    if (!text) {
        return null;
    }
    return (
        <span class="kit-badge" aria-hidden="true">
            {text}
        </span>
    );
}
