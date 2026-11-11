import { useEffect, useRef } from 'preact/hooks';
import { OverlayEntry, pushOverlay } from '../state/router';

/**
 * Gives an open sheet, dialog or menu a history entry, so the browser's Back (the Back gesture
 * on a phone) closes it and leaves the page under it alone.
 *
 * While `open` is true the overlay has an entry under the page's own address. Back leaves that
 * entry and `onClose` runs. When the overlay closes any other way (its close button, the
 * backdrop, Escape, a finished action) the entry is stepped back over, which is what
 * `history.back()` does. A change of route closes every overlay first.
 *
 * A link or button inside the overlay that leads to another page must go through the router
 * (`openRoute`, `switchRoute`, `goUp`, or `followLink`). The router waits for the overlay's
 * entry to be left before it writes the new address. A plain `href` or an assigned
 * `location.hash` does not wait, and the step back would then undo it.
 */
export function useOverlayHistory(open: boolean, onClose: () => void): void {
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        if (!open) {
            return;
        }
        const entry = pushOverlay(() => close.current());
        return () => entry.release();
    }, [open]);
}

/**
 * The same for code that is not a Preact component (the Files dialogs and menus). Call
 * `release()` on the result when the overlay closes by itself.
 */
export function openOverlay(onClose: () => void): OverlayEntry {
    return pushOverlay(onClose);
}
