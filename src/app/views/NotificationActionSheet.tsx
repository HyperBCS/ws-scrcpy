import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { Sheet } from '../ui/Sheet';

// A component keeps Preact's parent links current when the Sheet renders itself.
function ActionSheetContent({ children }: { children: ComponentChildren }) {
    return <>{children}</>;
}

interface NotificationActionSheetProps {
    open: boolean;
    title: string;
    description?: string;
    onClose: () => void;
    children: ComponentChildren;
}

/**
 * The sheets of the inbox (the actions of one notification, the actions of the list, the
 * filters) on the shared sheet. It adds one thing. The sheet hands focus back to the control
 * that opened it. Archive removes that control with its notification, and focus would be left
 * at the top of the page; it goes to the actions button of the list instead.
 */
export function NotificationActionSheet({ open, title, description, onClose, children }: NotificationActionSheetProps) {
    const holder = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const node = holder.current;
        if (!node) return;
        // A dialog's `close` event does not bubble, so it is caught on the way down. It comes
        // after the sheet has handed focus back. With nothing to hand it to, focus is still on
        // the closed dialog, or on the page.
        const closed = (event: Event) => {
            const dialog = event.target as HTMLDialogElement;
            const active = document.activeElement;
            if (dialog.open || (active && active !== document.body && !dialog.contains(active))) return;
            document
                .querySelector<HTMLElement>('.notification-history-tools .notification-menu-button')
                ?.focus({ preventScroll: true });
        };
        node.addEventListener('close', closed, true);
        return () => node.removeEventListener('close', closed, true);
    }, []);
    return (
        <div ref={holder}>
            <Sheet
                open={open}
                title={title}
                subtitle={description}
                onClose={onClose}
                bodyClassName="notification-action-sheet-actions"
            >
                <ActionSheetContent>{children}</ActionSheetContent>
            </Sheet>
        </div>
    );
}
