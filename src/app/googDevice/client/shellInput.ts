import { readStorage, writeStorage } from '../../ui/storage';

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

/** The keys of the row under the terminal that a phone keyboard lacks (`views/shell/ShellKeys.tsx`). */
export type ShellKey = 'escape' | 'tab' | 'left' | 'up' | 'down' | 'right';

const ARROW_CODES: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/**
 * What a key of the row sends, as a hardware keyboard would. A program that turns on application
 * cursor keys (vi, less, top) expects the arrows as `ESC O x` instead of `ESC [ x`.
 */
export function keyInput(key: ShellKey, applicationCursor = false): string {
    if (key === 'escape') {
        return '\x1b';
    }
    if (key === 'tab') {
        return '\t';
    }
    return (applicationCursor ? '\x1bO' : '\x1b[') + ARROW_CODES[key];
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Text pasted from the browser clipboard, as xterm sends a paste: line ends become Enter, and
 * the text is put between the bracketed paste markers only when the program asked for them. An
 * end marker inside the text would end the paste early and run the rest as typed keys, so it is
 * removed.
 */
export function pasteInput(text: string, bracketed: boolean): string {
    const lines = text.replace(/\r?\n/g, '\r');
    return bracketed ? PASTE_START + lines.split(PASTE_END).join('') + PASTE_END : lines;
}

/**
 * The text of the terminal's screen, from its rows top to bottom. A wrapped row continues the
 * row above it, so a long line comes back as one line. Trailing spaces and blank rows at the
 * end are left out.
 */
export function screenText(rows: ReadonlyArray<{ text: string; wrapped: boolean }>): string {
    const lines: string[] = [];
    for (const row of rows) {
        if (row.wrapped && lines.length) {
            lines[lines.length - 1] += row.text;
        } else {
            lines.push(row.text);
        }
    }
    const trimmed = lines.map((line) => line.trimEnd());
    while (trimmed.length && !trimmed[trimmed.length - 1]) {
        trimmed.pop();
    }
    return trimmed.join('\n');
}

/**
 * The text sizes of the terminal, in px. They are not the type scale of the rest of the page:
 * the size sets how many columns and rows the terminal has, and the phone is told those.
 */
export const TEXT_SIZES: readonly number[] = [12, 14, 16, 18];
export const DEFAULT_TEXT_SIZE = 14;
const TEXT_SIZE_KEY = 'ws-scrcpy.shell.text-size';

/** The text size kept in this browser, or the default when none is kept or it is not one of `TEXT_SIZES`. */
export function storedTextSize(): number {
    const stored = Number(readStorage(TEXT_SIZE_KEY));
    return TEXT_SIZES.includes(stored) ? stored : DEFAULT_TEXT_SIZE;
}

export function storeTextSize(size: number): void {
    writeStorage(TEXT_SIZE_KEY, String(size));
}

/** The next text size up (1) or down (-1) from `size`, or `size` itself at either end. */
export function stepTextSize(size: number, step: 1 | -1): number {
    const index = TEXT_SIZES.indexOf(size);
    if (index < 0) {
        return DEFAULT_TEXT_SIZE;
    }
    return TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, index + step))];
}
