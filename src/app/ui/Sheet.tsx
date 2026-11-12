import { signal } from '@preact/signals';
import { ComponentChildren, render } from 'preact';
import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import '../../style/kit/Sheet.css';
import { cancelConfirmPrompt } from './ConfirmAction';
import { rememberDialogFocus, returnDialogFocus, stopRemoteInteraction, trapDialogTab } from './dialogFocus';
import { IconButton } from './IconButton';
import { closeMenusIn, menuButtonOf } from './Menu';
import { useOverlayHistory } from './overlayHistory';
import { usePresence } from './Presence';
import { bindSheetDrag } from './sheetDrag';

/**
 * From this width a sheet is a centred dialog; below it, a bottom sheet, whatever the pointer.
 * `kit/Sheet.css` has the same number. The side panel of phase 6 is one more presentation: a
 * block in that stylesheet, and a query here if it should move differently.
 */
export const SHEET_DIALOG = '(min-width: 600px)';

// The modal sheets on screen, oldest first, including one that is still animating out.
const shown: HTMLDialogElement[] = [];

// What takes a modal sheet that is animating out off the screen at once, by its dialog.
const endExit = new WeakMap<HTMLDialogElement, () => void>();

/**
 * The modal sheet on top. A modal dialog covers the page and makes it inert, so what has to
 * show and be pressed while a sheet is open is rendered inside this element (see `AboveSheet`).
 * A sheet that is not modal is never this one.
 */
export const topSheet = signal<HTMLDialogElement | null>(null);

interface SheetProps {
    open: boolean;
    onClose: () => void;
    /** False while the sheet may not close (work in progress). Every way of closing then waits. */
    dismissible?: boolean;
    bodyClassName?: string;
    title: string;
    /** The phone the sheet acts on, shown under the title. */
    subtitle?: string;
    children: ComponentChildren;
    /** The sheet's actions, kept in view under the scrolling body. */
    footer?: ComponentChildren;
    /**
     * False for a sheet that leaves the page in use (Type text): the dialog is shown with
     * `show()`, so there is no backdrop, the page is not inert and a press beside the sheet goes
     * to the page. It closes by its close control, Escape and Back only, and is not dragged.
     */
    modal?: boolean;
}

/**
 * The one sheet, on the native `<dialog>`: a bottom sheet below 600px and a centred dialog
 * 560px wide from there. The dialog element covers the window and holds the backdrop and the
 * panel. The panel is what moves, so the backdrop can be pressed in every browser and a toast
 * inside the dialog stays where it is. A modal sheet is the default; see `modal`.
 *
 * The children stay mounted while the sheet is closed, so they keep their state.
 */
export function Sheet({
    open,
    onClose,
    dismissible = true,
    bodyClassName,
    title,
    subtitle,
    children,
    footer,
    modal = true,
}: SheetProps) {
    const rootRef = useRef<HTMLDialogElement>(null);
    const headerRef = useRef<HTMLElement>(null);
    const { ref: panelRef, present } = usePresence<HTMLDivElement>(open, 'sheet', SHEET_DIALOG);
    const titleId = useId();
    const subtitleId = useId();
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const dismissibleRef = useRef(dismissible);
    dismissibleRef.current = dismissible;
    const openRef = useRef(open);
    openRef.current = open;
    // True when this modal sheet was taken off the screen before its exit had played (see
    // `endExit`). Its dialog is closed, and it is shown again if it opens before the exit ends.
    const exitEnded = useRef(false);

    /** The close button, the backdrop and a drag. */
    const dismiss = () => {
        if (openRef.current && dismissibleRef.current) {
            closeRef.current();
        }
    };
    /**
     * Whether a request to close ends inside the sheet: a confirm prompt is cancelled first,
     * then a menu is closed, and a sheet that may not close now stays.
     */
    const stays = () => {
        const root = rootRef.current;
        return (!!root && (cancelConfirmPrompt(root) || closeMenusIn(root))) || !dismissibleRef.current;
    };
    /** Escape and the browser's own request to close. */
    const closeRequest = () => {
        if (openRef.current && !stays()) {
            closeRef.current();
        }
    };
    // The browser's Back does what Escape does. Another page closes the sheet.
    useOverlayHistory(open, () => closeRef.current(), { stays });

    useLayoutEffect(() => {
        const root = rootRef.current;
        const panel = panelRef.current;
        const header = headerRef.current;
        // Opened again before the exit that was ended had finished: shown again.
        if (open && root && exitEnded.current) {
            exitEnded.current = false;
            root.showModal();
            root.focus({ preventScroll: true });
        }
        if (!open || !root || !panel || !header || !modal) {
            return;
        }
        root.style.removeProperty('--sheet-backdrop-opacity');
        return bindSheetDrag(header, panel, root, () => dismissibleRef.current, dismiss, SHEET_DIALOG);
    }, [open, modal]);

    useLayoutEffect(() => {
        const root = rootRef.current;
        if (!present || !root) {
            return;
        }
        // Opened from a menu item: the item goes with its menu, so focus goes back to the
        // menu's button.
        rememberDialogFocus(root, menuButtonOf(document.activeElement) ?? document.activeElement);
        // Keep the phone list where it is while the sheet is open.
        const list = document.getElementById('devices');
        const listScrollTop = list?.scrollTop ?? 0;
        if (modal) {
            document.body.classList.add('sheet-open');
        } else {
            // It takes the place of a modal sheet (Actions, then Type text), which is still
            // animating out. Until that one has gone nothing outside it takes focus, this sheet
            // included, and the field would miss the press that raises the phone keyboard. It
            // goes at once.
            shown.filter((other) => other.hasAttribute('data-exiting')).forEach((other) => endExit.get(other)?.());
        }
        exitEnded.current = false;
        const show = () => {
            if (!root.open) {
                if (modal) {
                    root.showModal();
                } else {
                    root.show();
                }
            }
            // Showing a dialog focuses its first control. The dialog itself takes focus instead,
            // so that opening a sheet with a field does not raise the phone keyboard.
            root.focus({ preventScroll: true });
        };
        show();
        // A sheet that is not modal does not cover the page, so what floats over the page (a
        // toast) stays where it is.
        if (modal) {
            shown.push(root);
            topSheet.value = root;
            endExit.set(root, () => {
                exitEnded.current = true;
                root.close();
            });
        }
        // A dialog, in the top layer or not, is still inside `document.body`, where the
        // listeners that drive the phone are.
        const allowRemote = stopRemoteInteraction(root);
        const preventBackdropScroll = (event: Event) => event.preventDefault();
        const backdrop = root.querySelector(':scope > .kit-sheet-backdrop');
        backdrop?.addEventListener('touchmove', preventBackdropScroll, { passive: false });
        backdrop?.addEventListener('wheel', preventBackdropScroll, { passive: false });
        const viewport = window.visualViewport;
        // An on-screen keyboard resizes the visual viewport and may leave the page as it was.
        const updateViewport = () => {
            root.style.setProperty('--sheet-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
            root.style.setProperty('--sheet-viewport-top', `${viewport?.offsetTop ?? 0}px`);
        };
        updateViewport();
        viewport?.addEventListener('resize', updateViewport);
        viewport?.addEventListener('scroll', updateViewport);
        window.addEventListener('resize', updateViewport);

        const onKeyDown = (event: KeyboardEvent) => {
            // A sheet opened from this one may be inside it; it answers its own keys. One that
            // is animating out leaves the keyboard alone.
            if (!openRef.current || !(event.target instanceof Element) || event.target.closest('dialog') !== root) {
                return;
            }
            if (event.key === 'Escape' && !event.isComposing) {
                // Answered here, so the browser raises no close request of its own.
                event.preventDefault();
                event.stopPropagation();
                closeRequest();
            } else {
                trapDialogTab(event, root);
            }
        };
        // The browser's close request: Escape that the handler above did not see, and Back in
        // Chrome on Android, which sends Back to an open modal dialog instead of to history.
        const onCancel = (event: Event) => {
            event.preventDefault();
            closeRequest();
        };
        // The browser may close the dialog without asking: a second close request with no
        // press between is not cancellable. `open` decides, so the dialog is shown again, and
        // a sheet that was closing plays its exit, unless its exit was ended.
        const onNativeClose = () => {
            if (!exitEnded.current) {
                show();
            }
        };
        root.addEventListener('keydown', onKeyDown);
        root.addEventListener('cancel', onCancel);
        root.addEventListener('close', onNativeClose);
        // A control that is removed or disabled while it has focus (a button replaced by its
        // result) would leave focus on the page behind the sheet. Keep it in the sheet.
        const keepFocus = new MutationObserver(() => {
            const active = document.activeElement;
            const lost = !active || active === document.body || (root.contains(active) && active.matches(':disabled'));
            if (openRef.current && lost) {
                root.focus({ preventScroll: true });
            }
        });
        keepFocus.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
        return () => {
            keepFocus.disconnect();
            root.removeEventListener('keydown', onKeyDown);
            root.removeEventListener('cancel', onCancel);
            root.removeEventListener('close', onNativeClose);
            allowRemote();
            backdrop?.removeEventListener('touchmove', preventBackdropScroll);
            backdrop?.removeEventListener('wheel', preventBackdropScroll);
            viewport?.removeEventListener('resize', updateViewport);
            viewport?.removeEventListener('scroll', updateViewport);
            window.removeEventListener('resize', updateViewport);
            exitEnded.current = false;
            if (modal) {
                endExit.delete(root);
                shown.splice(shown.indexOf(root), 1);
                topSheet.value = shown[shown.length - 1] ?? null;
                if (!shown.length) {
                    document.body.classList.remove('sheet-open');
                }
            }
            if (list?.isConnected) {
                list.scrollTop = listScrollTop;
            }
            if (root.open) {
                root.close();
            }
            returnDialogFocus(root, document.querySelector<HTMLElement>('.floating-toolbar-fab'));
        };
    }, [present, modal]);

    return (
        <dialog
            ref={rootRef}
            class={modal ? 'kit-sheet' : 'kit-sheet kit-sheet-modeless'}
            // Written out although a dialog has the role already: the keyboard capture of the
            // stream leaves keys alone when they are pressed inside `[role="dialog"]`.
            role="dialog"
            tabIndex={-1}
            aria-labelledby={titleId}
            aria-describedby={subtitle ? subtitleId : undefined}
            data-exiting={(present && !open) || undefined}
            data-dismissible={dismissible}
        >
            {modal && <div class="kit-sheet-backdrop" onClick={dismiss} />}
            <div ref={panelRef} class="kit-sheet-panel">
                <header ref={headerRef} class="kit-sheet-header">
                    <div class="kit-sheet-handle" aria-hidden="true" />
                    <div class="kit-sheet-heading">
                        <h2 id={titleId} class="kit-sheet-title">
                            {title}
                        </h2>
                        {subtitle && (
                            <p id={subtitleId} class="kit-sheet-subtitle">
                                {subtitle}
                            </p>
                        )}
                    </div>
                    <IconButton
                        icon="close"
                        variant="bare"
                        class="kit-sheet-close"
                        label={`Close ${title}`}
                        onClick={dismiss}
                        disabled={!dismissible}
                    />
                </header>
                <div class={`kit-sheet-body ${bodyClassName || ''}`}>{children}</div>
                {footer && <footer class="kit-sheet-footer">{footer}</footer>}
            </div>
        </dialog>
    );
}

/**
 * Shows its children where they are, or inside the sheet on top while one is open. For what
 * floats over the page and must stay in view and in use over a sheet: a toast.
 *
 * Inside a sheet the children are a tree of their own: they keep their props and lose context
 * from above. They mount again when a sheet opens or closes under them.
 */
export function AboveSheet({ children }: { children: ComponentChildren }) {
    const host = topSheet.value;
    const holder = useRef<HTMLElement>();
    useLayoutEffect(() => {
        if (!host) {
            return;
        }
        const node = document.createElement('div');
        node.className = 'kit-sheet-above';
        host.appendChild(node);
        holder.current = node;
        return () => {
            render(null, node);
            node.remove();
            holder.current = undefined;
        };
    }, [host]);
    useLayoutEffect(() => {
        if (holder.current) {
            render(<>{children}</>, holder.current);
        }
    });
    return host ? null : <>{children}</>;
}
