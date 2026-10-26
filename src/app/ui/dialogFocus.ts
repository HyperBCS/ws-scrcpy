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
