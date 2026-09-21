import { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import '../../style/ui/BottomSheet.css';

interface BottomSheetProps {
    open: boolean;
    onClose: () => void;
    dismissible?: boolean;
    bodyClassName?: string;
    title: string;
    children: ComponentChildren;
}

const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
const DESKTOP_DIALOG = '(min-width: 760px) and (min-height: 540px) and (hover: hover) and (pointer: fine)';

export function BottomSheet({ open, onClose, dismissible = true, bodyClassName, title, children }: BottomSheetProps) {
    const rootRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
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
        const desktop = window.matchMedia(DESKTOP_DIALOG);
        let drag: { id: number; x: number; y: number; distance: number; horizontal: boolean } | undefined;
        const resetDrag = () => {
            const pointerId = drag?.id;
            drag = undefined;
            root.classList.remove('dragging');
            panel.style.removeProperty('--sheet-drag-y');
            if (pointerId !== undefined && header.hasPointerCapture(pointerId)) {
                header.releasePointerCapture(pointerId);
            }
        };
        const onPointerDown = (event: PointerEvent) => {
            if (
                !dismissibleRef.current ||
                desktop.matches ||
                drag ||
                !event.isPrimary ||
                event.button !== 0 ||
                (event.target instanceof Element && event.target.closest('button, a, input, select, textarea'))
            ) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            drag = { id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0, horizontal: false };
            header.setPointerCapture(event.pointerId);
            root.classList.add('dragging');
        };
        const onPointerMove = (event: PointerEvent) => {
            if (!drag || drag.id !== event.pointerId) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const dx = Math.abs(event.clientX - drag.x);
            const dy = event.clientY - drag.y;
            if (dx > 12 && dx > Math.abs(dy) * 1.2) {
                drag.horizontal = true;
            }
            drag.distance = drag.horizontal ? 0 : Math.max(0, dy);
            panel.style.setProperty('--sheet-drag-y', `${drag.distance}px`);
        };
        const onPointerUp = (event: PointerEvent) => {
            if (!drag || drag.id !== event.pointerId) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const shouldClose = drag.distance >= Math.min(96, panel.clientHeight * 0.25);
            resetDrag();
            if (shouldClose) {
                requestClose();
            }
        };
        const onPointerCancel = (event: PointerEvent) => {
            if (drag?.id === event.pointerId) {
                resetDrag();
            }
        };
        header.addEventListener('pointerdown', onPointerDown);
        header.addEventListener('pointermove', onPointerMove);
        header.addEventListener('pointerup', onPointerUp);
        header.addEventListener('pointercancel', onPointerCancel);
        header.addEventListener('lostpointercapture', onPointerCancel);
        desktop.addEventListener('change', resetDrag);
        window.addEventListener('resize', resetDrag);
        return () => {
            resetDrag();
            header.removeEventListener('pointerdown', onPointerDown);
            header.removeEventListener('pointermove', onPointerMove);
            header.removeEventListener('pointerup', onPointerUp);
            header.removeEventListener('pointercancel', onPointerCancel);
            header.removeEventListener('lostpointercapture', onPointerCancel);
            desktop.removeEventListener('change', resetDrag);
            window.removeEventListener('resize', resetDrag);
        };
    }, [open, dismissible]);

    useLayoutEffect(() => {
        const root = rootRef.current;
        const panel = panelRef.current;
        if (!open || !root || !panel) {
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
            } else if (event.key === 'Tab') {
                const controls = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
                    if (el.matches(':disabled, [hidden]') || !el.getClientRects().length) {
                        return false;
                    }
                    // Closed <details> descendants may retain layout boxes in Chromium.
                    // Only the summary is reachable by native Tab navigation.
                    let ancestor = el.parentElement;
                    while (ancestor && ancestor !== panel) {
                        if (
                            ancestor.matches('details:not([open])') &&
                            !ancestor.querySelector('summary')?.contains(el)
                        ) {
                            return false;
                        }
                        ancestor = ancestor.parentElement;
                    }
                    return true;
                });
                const first = controls[0];
                const last = controls[controls.length - 1];
                const active = document.activeElement;
                if (!first) {
                    event.preventDefault();
                    panel.focus();
                } else if (event.shiftKey && (active === first || !panel.contains(active) || active === panel)) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && (active === last || !panel.contains(active) || active === panel)) {
                    event.preventDefault();
                    first.focus();
                }
            }
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
            if (
                previousFocus instanceof HTMLElement &&
                previousFocus.isConnected &&
                previousFocus.getClientRects().length
            ) {
                previousFocus.focus({ preventScroll: true });
            } else {
                document.querySelector<HTMLButtonElement>('.floating-toolbar-fab')?.focus({ preventScroll: true });
            }
        };
    }, [open]);

    return (
        <div
            ref={rootRef}
            class={`bottom-sheet-root ${open ? 'open' : ''}`}
            aria-hidden={!open}
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
                            <span>Close</span>
                        </button>
                    </div>
                </div>
                <div class={`bottom-sheet-body ${bodyClassName || ''}`}>{children}</div>
            </div>
        </div>
    );
}
