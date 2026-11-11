/** The largest column or row count the server accepts (RemoteShell refuses anything outside 1 to 500). */
export const MAX_TERMINAL_SIZE = 500;

/**
 * The size to report to the device for a terminal of `cols` by `rows`. A very tall or zoomed-out
 * window can fit more than the server accepts, and an out-of-range start message would be
 * refused, so each value is kept within 1 to MAX_TERMINAL_SIZE.
 */
export function terminalSize(cols: number, rows: number): { cols: number; rows: number } {
    const limit = (value: number) => Math.min(MAX_TERMINAL_SIZE, Math.max(1, Math.floor(value) || 1));
    return { cols: limit(cols), rows: limit(rows) };
}

const CONTROL_PUNCTUATION: Record<string, string> = {
    '@': '\x00',
    ' ': '\x00',
    '[': '\x1b',
    '\\': '\x1c',
    ']': '\x1d',
    '^': '\x1e',
    _: '\x1f',
    '?': '\x7f',
};

/**
 * Maps one typed character to the control character a physical Ctrl key would produce: a letter
 * becomes its control code (c -> ^C, d -> ^D, l -> ^L...) and the punctuation that has a control
 * code follows the same rule. Anything else is returned unchanged.
 */
export function withControl(char: string): string {
    if (/^[a-z]$/i.test(char)) {
        return String.fromCharCode(char.toUpperCase().charCodeAt(0) - 64);
    }
    return CONTROL_PUNCTUATION[char] ?? char;
}

/**
 * Applies the toolbar Ctrl key to one chunk of terminal input. Phone keyboards have no Ctrl, so
 * the toolbar offers one. It is one-shot: it changes the next single character and is then
 * released, so a forgotten Ctrl cannot turn a whole command into control codes. A longer chunk
 * is an escape sequence (an arrow key) or a paste. It is sent as it is and leaves Ctrl waiting.
 */
export function applyControl(data: string, armed: boolean): { data: string; armed: boolean } {
    if (!armed || Array.from(data).length !== 1) {
        return { data, armed };
    }
    return { data: withControl(data), armed: false };
}
