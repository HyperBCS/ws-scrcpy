import { trapDialogTab, restoreDialogFocus } from './dialogFocus';
import { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import '../../style/ui/BottomSheet.css';
import { usePresence } from './Presence';
import { bindSheetDrag } from './sheetDrag';

interface BottomSheetProps {
    open: boolean;
    onClose: () => void;
    dismissible?: boolean;
    bodyClassName?: string;
    title: string;
    children: ComponentChildren;
}

export function BottomSheet({ open, onClose, dismissible = true, bodyClassName, title, children }: BottomSheetProps) {
    const rootRef = useRef<HTMLDivElement>(null);
    const { ref: panelRef, present } = usePresence<HTMLDivElement>(open, 'sheet');
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const dismissibleRef = useRef(dismissible);
    dismissibleRef.current = dismissible;
    const requestClose = () => {
        if (dismissibleRef.current) {
            closeRef.current();
        }
    };

    useLayoutEffect(() => {
        const root = rootRef.current;
        const panel = panelRef.current;
        const header = panel?.querySelector<HTMLElement>('.bottom-sheet-drag-region');
        if (!open || !root || !panel || !header) {
            return;
        }
        root.style.removeProperty('--sheet-backdrop-opacity');
        return bindSheetDrag(header, panel, root, () => dismissibleRef.current, requestClose);
    }, [open, dismissible]);

    useLayoutEffect(() => {
        const root = rootRef.current;
        const panel = panelRef.current;
        if (!present || !root || !panel) {
            return;
        }
        const previousFocus = document.activeElement;
        // Keep the device list at its exact position while the sheet itself remains scrollable.
        // Lock the actual list scroller, not only body (the PWA shell never scrolls).
        const list = document.getElementById('devices');
        const listScrollTop = list?.scrollTop ?? 0;
        document.body.classList.add('sheet-open');
        // Remote interaction listeners live on document.body. Sheet gestures must end here,
        // including the final touchend after a header drag; native body scrolling still works.
        const stopRemoteInteraction = (event: Event) => event.stopPropagation();
        const interactionEvents = [
            'touchstart',
            'touchmove',
            'touchend',
            'touchcancel',
            'mousedown',
            'mousemove',
            'mouseup',
            'wheel',
        ];
        interactionEvents.forEach((name) => root.addEventListener(name, stopRemoteInteraction));
        const preventBackdropScroll = (event: Event) => event.preventDefault();
        const backdrop = root.querySelector('.bottom-sheet-backdrop');
        backdrop?.addEventListener('touchmove', preventBackdropScroll, { passive: false });
        backdrop?.addEventListener('wheel', preventBackdropScroll, { passive: false });
        const viewport = window.visualViewport;
        // Mobile keyboards resize the visual viewport without necessarily resizing the page.
        const updateViewport = () => {
            root.style.setProperty('--sheet-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
            root.style.setProperty('--sheet-viewport-top', `${viewport?.offsetTop ?? 0}px`);
        };
        updateViewport();
        viewport?.addEventListener('resize', updateViewport);
        viewport?.addEventListener('scroll', updateViewport);
        window.addEventListener('resize', updateViewport);
        // Focus the dialog itself: opening settings must not raise the phone keyboard.
        const focusFrame = requestAnimationFrame(() => panel.focus({ preventScroll: true }));

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !event.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                requestClose();
            } else trapDialogTab(event, panel);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            interactionEvents.forEach((name) => root.removeEventListener(name, stopRemoteInteraction));
            backdrop?.removeEventListener('touchmove', preventBackdropScroll);
            backdrop?.removeEventListener('wheel', preventBackdropScroll);
            document.body.classList.remove('sheet-open');
            if (list?.isConnected) {
                list.scrollTop = listScrollTop;
            }
            cancelAnimationFrame(focusFrame);
            viewport?.removeEventListener('resize', updateViewport);
            viewport?.removeEventListener('scroll', updateViewport);
            window.removeEventListener('resize', updateViewport);
            window.removeEventListener('keydown', onKeyDown, true);
            restoreDialogFocus(previousFocus, document.querySelector<HTMLElement>('.floating-toolbar-fab'));
        };
    }, [present]);

    return (
        <div
            ref={rootRef}
            class={`bottom-sheet-root ${present ? 'open' : ''}`}
            hidden={!present}
            data-exiting={!open || undefined}
            aria-hidden={!present}
            data-dismissible={dismissible}
        >
            <div class="bottom-sheet-backdrop" onClick={requestClose} />
            <div
                ref={panelRef}
                class="bottom-sheet"
                role="dialog"
                aria-modal={open ? true : undefined}
                aria-label={title}
                tabIndex={-1}
            >
                <div class="bottom-sheet-drag-region">
                    <div class="bottom-sheet-handle" aria-hidden="true" />
                    <div class="bottom-sheet-header">
                        <h2 class="bottom-sheet-title">{title}</h2>
                        <button
                            type="button"
                            class="bottom-sheet-close"
                            onClick={requestClose}
                            disabled={!dismissible}
                            title="Close"
                            aria-label={`Close ${title}`}
                        >
                            <svg
                                aria-hidden="true"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                            >
                                <path d="m4 4 16 16M20 4 4 20" />
                            </svg>
                        </button>
                    </div>
                </div>
                <div class={`bottom-sheet-body ${bodyClassName || ''}`}>{children}</div>
            </div>
        </div>
    );
}
