/** Browser controls must keep their native keyboard behavior while remote capture is enabled. */
export function isLocalKeyboardTarget(target: EventTarget | null): boolean {
    return (
        !!document.querySelector('.bottom-sheet-root.open, .live-text-overlay') ||
        (target instanceof Element &&
            !!target.closest(
                'input, textarea, select, button, a[href], [role="dialog"], [contenteditable]:not([contenteditable="false"])',
            ))
    );
}
