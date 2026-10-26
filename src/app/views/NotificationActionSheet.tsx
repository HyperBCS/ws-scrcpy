import { trapDialogTab, restoreDialogFocus } from '../ui/dialogFocus';
import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import '../../style/views/NotificationActionSheet.css';
import { usePresence } from '../ui/Presence';
import { bindSheetDrag } from '../ui/sheetDrag';

interface NotificationActionSheetProps {
    open: boolean;
    title: string;
    description?: string;
    onClose: () => void;
    children: ComponentChildren;
}

/** The native modal keeps keyboard focus and background interaction inside the sheet. */
export function NotificationActionSheet({ open, title, description, onClose, children }: NotificationActionSheetProps) {
    const { ref: dialog, present } = usePresence<HTMLDialogElement>(open, 'sheet');
    const content = useRef({ title, description, children });
    if (open) content.current = { title, description, children };
    const shown = content.current;
    const callback = useRef(onClose);
    const closing = useRef(false);
    if (open) closing.current = false;
    const backdropStart = useRef(false);
    const titleId = useId();
    const descriptionId = useId();
    callback.current = onClose;

    const close = () => {
        if (closing.current) return;
        closing.current = true;
        callback.current();
    };

    useLayoutEffect(() => {
        const node = dialog.current;
        if (!node || !present) return;
        const previous = document.activeElement;
        node.showModal();
        const header = node.querySelector<HTMLElement>('.notification-action-sheet-drag')!;
        const release = bindSheetDrag(header, node, node, () => !closing.current, close);
        return () => {
            release();
            closing.current = true;
            if (node.open) node.close();
            restoreDialogFocus(
                previous,
                document.querySelector<HTMLElement>('.notification-history-tools .notification-menu-button'),
            );
        };
    }, [present]);

    const outside = (node: HTMLDialogElement, x: number, y: number) => {
        const rect = node.getBoundingClientRect();
        return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
    };

    if (!present) return null;
    return (
        <dialog
            ref={dialog}
            class="notification-action-sheet"
            data-exiting={!open || undefined}
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={shown.description ? descriptionId : undefined}
            onClose={close}
            onCancel={(event) => {
                event.preventDefault();
                close();
            }}
            onKeyDown={(event) => trapDialogTab(event, event.currentTarget)}
            onPointerDown={(event) => {
                backdropStart.current =
                    event.target === event.currentTarget && outside(event.currentTarget, event.clientX, event.clientY);
            }}
            onPointerCancel={() => (backdropStart.current = false)}
            onClick={(event) => {
                if (
                    backdropStart.current &&
                    event.target === event.currentTarget &&
                    outside(event.currentTarget, event.clientX, event.clientY)
                ) {
                    close();
                }
                backdropStart.current = false;
            }}
        >
            <div class="notification-action-sheet-drag">
                <div class="notification-action-sheet-handle" aria-hidden="true" />
                <header class="notification-action-sheet-header">
                    <div>
                        <h2 id={titleId}>{shown.title}</h2>
                        {shown.description && <p id={descriptionId}>{shown.description}</p>}
                    </div>
                    <button
                        class="notification-action-sheet-close"
                        type="button"
                        aria-label="Close actions"
                        onClick={close}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path
                                d="m6 6 12 12M18 6 6 18"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                            />
                        </svg>
                    </button>
                </header>
            </div>
            <div class="notification-action-sheet-actions">{shown.children}</div>
        </dialog>
    );
}
