/**
 * Copies text to the viewer's clipboard, returning whether it worked.
 *
 * `navigator.clipboard` exists only on secure origins, so on a plain-http LAN address (which is
 * how the Android and iOS streams are usually opened) it is `undefined` and the async API cannot
 * be used at all. The hidden-textarea + `execCommand('copy')` path still works there, so it is
 * the fallback rather than an error message.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
    if (!text) {
        return false;
    }
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Blocked (no permission, no transient activation, or not focused): try the legacy path.
    }
    return copyWithTextarea(text);
}

function copyWithTextarea(text: string): boolean {
    const area = document.createElement('textarea');
    area.value = text;
    // Off-screen but focusable: `execCommand` copies the *selection*, so the node must be in the
    // document and selectable. `readOnly` keeps the mobile keyboard from appearing.
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    const selection = document.getSelection();
    const previous = selection && selection.rangeCount ? selection.getRangeAt(0) : undefined;
    const focused = document.activeElement;
    try {
        area.focus({ preventScroll: true });
        area.setSelectionRange(0, text.length);
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        area.remove();
        // The text area took focus; hand it back to the button that was pressed.
        if (focused instanceof HTMLElement && focused.isConnected) {
            focused.focus({ preventScroll: true });
        }
        if (previous && selection) {
            selection.removeAllRanges();
            selection.addRange(previous);
        }
    }
}

/**
 * "Copy here" in both Actions sheets: copies the text read from the phone into this browser's
 * clipboard and returns the line to show under the clipboard group.
 */
export async function copyPhoneClipboardHere(received: string | undefined): Promise<string> {
    if (!received) {
        return received === undefined ? 'Read the phone clipboard first.' : 'The phone clipboard is empty.';
    }
    return (await copyTextToClipboard(received))
        ? 'Copied to this browser.'
        : 'This browser blocked copying. Select the text above and copy it.';
}
