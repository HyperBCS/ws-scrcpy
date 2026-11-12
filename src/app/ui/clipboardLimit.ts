/**
 * The most clipboard text either client sends, in UTF-8 bytes, and the one limit of the Actions
 * sheet's clipboard group (`views/actions/ClipboardGroup.tsx`). This is scrcpy's own limit: its
 * 256 KiB control message less the 14-byte header. It also keeps the iPhone's JSON message, with
 * every character escaped, far below the 4 MiB frame limit the server enforces on WebSockets.
 */
export const CLIPBOARD_MAX_BYTES = (1 << 18) - 14;

export const CLIPBOARD_TOO_LONG_NOTE = 'This text is too long to send. The limit is 256 KB.';

export function clipboardTextTooLong(text: string): boolean {
    // One UTF-16 unit is at most three UTF-8 bytes and at least one, so most text needs no encoding.
    if (text.length * 3 <= CLIPBOARD_MAX_BYTES) {
        return false;
    }
    if (text.length > CLIPBOARD_MAX_BYTES) {
        return true;
    }
    return new TextEncoder().encode(text).length > CLIPBOARD_MAX_BYTES;
}
