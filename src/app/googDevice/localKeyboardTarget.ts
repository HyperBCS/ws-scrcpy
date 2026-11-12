/**
 * Browser controls must keep their native keyboard behavior while remote capture is enabled.
 * While any sheet is open no key goes to the phone, wherever focus is. Every sheet, the Files
 * dialog among them, is the kit's dialog.
 */
export function isLocalKeyboardTarget(target: EventTarget | null): boolean {
    return (
        !!document.querySelector('dialog.kit-sheet[open]') ||
        (target instanceof Element &&
            !!target.closest(
                'input, textarea, select, button, a[href], [role="dialog"], [contenteditable]:not([contenteditable="false"])',
            ))
    );
}
