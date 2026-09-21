/**
 * Browser keyboard events -> HID Keyboard usages (usage page 0x07) for the CoreDevice virtual
 * keyboard. `KeyboardEvent.code` names the physical key, which is exactly what the HID table
 * enumerates, so the mapping is layout independent. Every report carries the full set of held
 * usages; releasing a key means resending the set without it.
 */
const CODE_TO_HID: Record<string, number> = {
    Enter: 0x28,
    Escape: 0x29,
    Backspace: 0x2a,
    Tab: 0x2b,
    Space: 0x2c,
    Minus: 0x2d,
    Equal: 0x2e,
    BracketLeft: 0x2f,
    BracketRight: 0x30,
    Backslash: 0x31,
    Semicolon: 0x33,
    Quote: 0x34,
    Backquote: 0x35,
    Comma: 0x36,
    Period: 0x37,
    Slash: 0x38,
    CapsLock: 0x39,
    Insert: 0x49,
    Home: 0x4a,
    PageUp: 0x4b,
    Delete: 0x4c,
    End: 0x4d,
    PageDown: 0x4e,
    ArrowRight: 0x4f,
    ArrowLeft: 0x50,
    ArrowDown: 0x51,
    ArrowUp: 0x52,
    NumpadEnter: 0x58,
    ShiftLeft: 0xe1,
    ShiftRight: 0xe5,
    ControlLeft: 0xe0,
    ControlRight: 0xe4,
    AltLeft: 0xe2,
    AltRight: 0xe6,
    MetaLeft: 0xe3,
    MetaRight: 0xe7,
};
for (let i = 0; i < 26; i++) {
    CODE_TO_HID[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
}
for (let i = 1; i <= 9; i++) {
    CODE_TO_HID[`Digit${i}`] = 0x1d + i;
}
CODE_TO_HID.Digit0 = 0x27;
for (let i = 1; i <= 12; i++) {
    CODE_TO_HID[`F${i}`] = 0x39 + i;
}

export function hidUsageForCode(code: string): number | undefined {
    return CODE_TO_HID[code];
}

/** The handful of usages the UI presses by name (editing keys on the Type text sheet). */
export const HID_USAGE = {
    ENTER: 0x28,
    BACKSPACE: 0x2a,
    TAB: 0x2b,
    DELETE_FORWARD: 0x4c,
    ARROW_RIGHT: 0x4f,
    ARROW_LEFT: 0x50,
    SHIFT: 0xe1,
} as const;

const SHIFT = HID_USAGE.SHIFT;

// Printable ASCII -> (usage, needs shift) on a US layout, for typing text that never came
// through a physical key press (the Type text overlay, paste-as-keys).
const ASCII_TO_HID = new Map<string, [number, boolean]>();
for (let i = 0; i < 26; i++) {
    ASCII_TO_HID.set(String.fromCharCode(97 + i), [0x04 + i, false]);
    ASCII_TO_HID.set(String.fromCharCode(65 + i), [0x04 + i, true]);
}
'1234567890'.split('').forEach((digit, index) => ASCII_TO_HID.set(digit, [0x1e + index, false]));
'!@#$%^&*()'.split('').forEach((symbol, index) => ASCII_TO_HID.set(symbol, [0x1e + index, true]));
const PAIRS: [string, string, number][] = [
    [' ', ' ', 0x2c],
    ['\t', '\t', 0x2b],
    ['\n', '\n', 0x28],
    ['-', '_', 0x2d],
    ['=', '+', 0x2e],
    ['[', '{', 0x2f],
    [']', '}', 0x30],
    ['\\', '|', 0x31],
    [';', ':', 0x33],
    ["'", '"', 0x34],
    ['`', '~', 0x35],
    [',', '<', 0x36],
    ['.', '>', 0x37],
    ['/', '?', 0x38],
];
PAIRS.forEach(([plain, shifted, usage]) => {
    ASCII_TO_HID.set(plain, [usage, false]);
    if (shifted !== plain) {
        ASCII_TO_HID.set(shifted, [usage, true]);
    }
});

/**
 * Typographic characters a phone keyboard substitutes on its own -- iOS "Smart Punctuation"
 * turns ' into ’, " into “ ”, -- into — and ... into … as you type -- mapped back to the plain
 * key that produces them. Without this, typing an apostrophe from an iPhone browser silently
 * dropped it. Accented letters are deliberately not folded: "cafe" for "café" would look like
 * success while changing the text.
 */
const ASCII_FALLBACK: Record<string, string> = {
    '‘': "'",
    '’': "'",
    '‚': "'",
    '‛': "'",
    '′': "'",
    '“': '"',
    '”': '"',
    '„': '"',
    '‟': '"',
    '″': '"',
    '‐': '-',
    '‑': '-',
    '‒': '-',
    '–': '-',
    '—': '-',
    '―': '-',
    '−': '-',
    '…': '...',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    '　': ' ',
    '•': '*',
    '×': 'x',
    '\r': '\n',
};

/** Replaces typographic substitutions with the ASCII the user actually pressed. */
export function asciiEquivalent(text: string): string {
    let result = '';
    for (const char of text) {
        result += ASCII_FALLBACK[char] ?? char;
    }
    return result;
}

/**
 * Expands text into the sequence of HID reports that types it: for every character a press
 * (with Shift where needed) followed by a release. Characters outside US-ASCII are skipped and
 * returned so the caller can tell the user.
 */
export function keyboardReportsForText(text: string): { reports: number[][]; skipped: string[] } {
    const reports: number[][] = [];
    const skipped: string[] = [];
    for (const char of asciiEquivalent(text)) {
        const entry = ASCII_TO_HID.get(char);
        if (!entry) {
            skipped.push(char);
            continue;
        }
        const [usage, shift] = entry;
        if (shift) {
            // Verified on iOS 27: Shift and the key in one report types the key unshifted and then
            // leaves Shift latched for the following keys ("hELLO"). The modifier must arrive in
            // its own report first and be released after the key, like a real keyboard.
            reports.push([SHIFT], [SHIFT, usage], [SHIFT], []);
        } else {
            reports.push([usage], []);
        }
    }
    return { reports, skipped };
}
