const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex]';

/** Match native tab order, including closed disclosures and animated exit content. */
export function trapDialogTab(event: KeyboardEvent, panel: HTMLElement): void {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const controls = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
        if (
            element.tabIndex < 0 ||
            element.matches(':disabled') ||
            element.closest('[inert], [hidden]') ||
            !element.getClientRects().length
        )
            return false;
        let ancestor = element.parentElement;
        while (ancestor && ancestor !== panel) {
            if (ancestor.matches('details:not([open])') && !ancestor.querySelector('summary')?.contains(element))
                return false;
            ancestor = ancestor.parentElement;
        }
        return true;
    });
    const first = controls[0],
        last = controls[controls.length - 1],
        active = document.activeElement;
    if (!first) {
        event.preventDefault();
        panel.focus();
    } else if (event.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (active === last || active === panel || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
    }
}

export function restoreDialogFocus(previous: Element | null, fallback?: HTMLElement | null): void {
    const target =
        previous instanceof HTMLElement && previous.isConnected && previous.getClientRects().length
            ? previous
            : fallback;
    target?.focus({ preventScroll: true });
}

const isShown = (element: Element | null | undefined): element is HTMLElement =>
    element instanceof HTMLElement && element.isConnected && element.getClientRects().length > 0;

// Sheets that are on screen, oldest first, including one that is still animating out.
const shownDialogs: HTMLElement[] = [];
// Where focus goes back to when each of them closes, nearest opener first.
const returnTargets = new WeakMap<HTMLElement, HTMLElement[]>();

/**
 * Call when a sheet appears, before it takes focus. A sheet opened from inside another one
 * (Actions > Stream settings) inherits that sheet's return targets, because the control that
 * opened it is hidden by the time it closes.
 */
export function rememberDialogFocus(panel: HTMLElement): void {
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && active !== document.body ? active : undefined;
    // The outgoing sheet turns inert as it closes, which can drop focus to the body first.
    const opener = focused
        ? shownDialogs.find((dialog) => dialog.contains(focused))
        : shownDialogs[shownDialogs.length - 1];
    const inherited = (opener && opener !== panel && returnTargets.get(opener)) || [];
    returnTargets.set(panel, focused ? [focused, ...inherited] : inherited);
    shownDialogs.push(panel);
}

/**
 * Call when a sheet has gone. Only the last sheet to go hands focus back to the page: one that
 * finishes closing after the next one opened must not pull focus out of it.
 */
export function returnDialogFocus(panel: HTMLElement, fallback?: HTMLElement | null): void {
    const targets = returnTargets.get(panel) || [];
    returnTargets.delete(panel);
    const index = shownDialogs.indexOf(panel);
    if (index >= 0) {
        shownDialogs.splice(index, 1);
    }
    const target = targets.find(isShown);
    if (shownDialogs.some(isShown)) {
        // Closed on top of a sheet that stays open: go back into that sheet, nowhere else.
        if (target && shownDialogs.some((dialog) => dialog.contains(target))) {
            target.focus({ preventScroll: true });
        }
        return;
    }
    (target ?? fallback)?.focus({ preventScroll: true });
}

const REMOTE_EVENTS = [
    'touchstart',
    'touchmove',
    'touchend',
    'touchcancel',
    'mousedown',
    'mousemove',
    'mouseup',
    'wheel',
];

/**
 * The listeners that drive the phone are on `document.body`. A gesture in a sheet or a menu
 * ends at `root`, the last touchend of a drag included; scrolling inside it still works.
 * Returns what removes the stop.
 */
export function stopRemoteInteraction(root: HTMLElement): () => void {
    const stop = (event: Event) => event.stopPropagation();
    REMOTE_EVENTS.forEach((name) => root.addEventListener(name, stop));
    return () => REMOTE_EVENTS.forEach((name) => root.removeEventListener(name, stop));
}
