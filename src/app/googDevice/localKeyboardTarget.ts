/**
 * Browser controls must keep their native keyboard behavior while remote capture is enabled.
 * While any sheet is open no key goes to the phone, wherever focus is: both sheet containers
 * are named, the kit's dialog and the older one that step 4d removes.
 */
export function isLocalKeyboardTarget(target: EventTarget | null): boolean {
    return (
        !!document.querySelector('dialog.kit-sheet[open], .bottom-sheet-root.open') ||
        (target instanceof Element &&
            !!target.closest(
                'input, textarea, select, button, a[href], [role="dialog"], [contenteditable]:not([contenteditable="false"])',
            ))
    );
}
