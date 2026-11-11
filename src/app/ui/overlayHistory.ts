import { useLayoutEffect, useRef } from 'preact/hooks';
import { onHistoryStep, OverlayEntry, OverlayOptions, pushOverlay } from '../state/router';

export type { OverlayOptions };

// Chrome skips a history entry that a page added without a press when the owner goes back, and
// with it the page the entry was added on: Back from such a sheet would leave the app instead of
// closing the sheet. Chrome does not count a press made before the last Back or Forward either.
// So an overlay gets an entry only if the owner has pressed something since the page loaded and
// since the last step through history. The router's own steps count as steps here, which is
// stricter than Chrome is known to be; the cost is a sheet without an entry, which closes with
// its page as every sheet did before.
let pressed = false;

const PRESS_EVENTS = ['keydown', 'mousedown', 'pointerup', 'touchend'];

PRESS_EVENTS.forEach((type) =>
    window.addEventListener(
        type,
        (event: Event) => {
            // Escape is not a press to a browser, and a script's own event is not one either.
            if (event.isTrusted && (event as KeyboardEvent).key !== 'Escape') {
                pressed = true;
            }
        },
        true,
    ),
);
onHistoryStep(() => {
    pressed = false;
});

function withEntry(options: OverlayOptions = {}): OverlayOptions {
    return { ...options, entry: options.entry ?? pressed };
}

/**
 * Gives an open sheet, dialog or menu a history entry, so the browser's Back (the Back gesture
 * on a phone) closes it and leaves the page under it alone.
 *
 * While `open` is true the overlay has an entry under the page's own address. Back leaves that
 * entry and `onClose` runs. When the overlay closes any other way (its close button, the
 * backdrop, Escape, a finished action) the entry is stepped back over, which is what
 * `history.back()` does. Another page closes every overlay first; a change within the page (a
 * corrected path, a filter) leaves them open.
 *
 * An overlay that opens without a press gets no entry (see above): Back then leaves the page,
 * and the overlay closes with it. `options.entry` says so for a caller that knows better.
 * `options.stays` is asked when Back would close the overlay; true keeps it open.
 *
 * A link or button inside the overlay that leads to another page must go through the router
 * (`openRoute`, `switchRoute`, `goUp`, or `followLink`). The router waits for the overlay's
 * entry to be left before it writes the new address. A plain `href` or an assigned
 * `location.hash` does not wait, and the step back would then undo it.
 */
export function useOverlayHistory(open: boolean, onClose: () => void, options?: OverlayOptions): void {
    const latest = useRef({ onClose, options });
    latest.current = { onClose, options };
    // A layout effect, so that a sheet that opens and the one it takes the place of tell the
    // router in the same pass. The router then hands the entry over; told a frame apart, it
    // would add an entry and step back over one.
    useLayoutEffect(() => {
        if (!open) {
            return;
        }
        const entry = pushOverlay(
            () => latest.current.onClose(),
            withEntry({ entry: latest.current.options?.entry, stays: () => !!latest.current.options?.stays?.() }),
        );
        return () => entry.release();
    }, [open]);
}

/**
 * The same for code that is not a Preact component (the Files dialogs and menus). Call
 * `release()` on the result when the overlay closes by itself.
 */
export function openOverlay(onClose: () => void, options?: OverlayOptions): OverlayEntry {
    return pushOverlay(onClose, withEntry(options));
}
