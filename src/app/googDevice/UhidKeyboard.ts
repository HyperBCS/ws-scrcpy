import { ControlMessage } from '../controlMessage/ControlMessage';
import {
    UhidCreateControlMessage,
    UhidDestroyControlMessage,
    UhidInputControlMessage,
} from '../controlMessage/UhidControlMessage';

export interface UhidKeyboardSender {
    sendMessage(message: ControlMessage): void;
}

/** Google's vendor id + an arbitrary product id, purely cosmetic in `dumpsys input`. */
const VENDOR_ID = 0x18d1;
const PRODUCT_ID = 0x0001;

/**
 * Standard HID boot-keyboard report descriptor: 1 modifier byte, 1 reserved byte, then 6 key
 * slots. Anything that speaks USB HID understands this, which is the point -- the device treats
 * it as an ordinary external keyboard.
 */
// prettier-ignore
const REPORT_DESCRIPTOR = new Uint8Array([
    0x05, 0x01,       // Usage Page (Generic Desktop)
    0x09, 0x06,       // Usage (Keyboard)
    0xa1, 0x01,       // Collection (Application)
    0x05, 0x07,       //   Usage Page (Keyboard/Keypad)
    0x19, 0xe0,       //   Usage Minimum (Left Control)
    0x29, 0xe7,       //   Usage Maximum (Right GUI)
    0x15, 0x00,       //   Logical Minimum (0)
    0x25, 0x01,       //   Logical Maximum (1)
    0x75, 0x01,       //   Report Size (1)
    0x95, 0x08,       //   Report Count (8)
    0x81, 0x02,       //   Input (Data, Variable, Absolute) -- modifier bits
    0x95, 0x01,       //   Report Count (1)
    0x75, 0x08,       //   Report Size (8)
    0x81, 0x01,       //   Input (Constant) -- reserved byte
    0x95, 0x06,       //   Report Count (6)
    0x75, 0x08,       //   Report Size (8)
    0x15, 0x00,       //   Logical Minimum (0)
    0x25, 0x65,       //   Logical Maximum (101)
    0x05, 0x07,       //   Usage Page (Keyboard/Keypad)
    0x19, 0x00,       //   Usage Minimum (0)
    0x29, 0x65,       //   Usage Maximum (101)
    0x81, 0x00,       //   Input (Data, Array) -- pressed keys
    0xc0,             // End Collection
]);

// `KeyboardEvent.code` -> HID usage id. Keyed on physical position (`code`, not `key`) because
// that is what a real keyboard reports; the *device's* layout then decides which character that
// position produces, which is the whole reason for using UHID over injecting key events.
const CODE_TO_HID: Record<string, number> = {
    KeyA: 0x04,
    KeyB: 0x05,
    KeyC: 0x06,
    KeyD: 0x07,
    KeyE: 0x08,
    KeyF: 0x09,
    KeyG: 0x0a,
    KeyH: 0x0b,
    KeyI: 0x0c,
    KeyJ: 0x0d,
    KeyK: 0x0e,
    KeyL: 0x0f,
    KeyM: 0x10,
    KeyN: 0x11,
    KeyO: 0x12,
    KeyP: 0x13,
    KeyQ: 0x14,
    KeyR: 0x15,
    KeyS: 0x16,
    KeyT: 0x17,
    KeyU: 0x18,
    KeyV: 0x19,
    KeyW: 0x1a,
    KeyX: 0x1b,
    KeyY: 0x1c,
    KeyZ: 0x1d,
    Digit1: 0x1e,
    Digit2: 0x1f,
    Digit3: 0x20,
    Digit4: 0x21,
    Digit5: 0x22,
    Digit6: 0x23,
    Digit7: 0x24,
    Digit8: 0x25,
    Digit9: 0x26,
    Digit0: 0x27,
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
    F1: 0x3a,
    F2: 0x3b,
    F3: 0x3c,
    F4: 0x3d,
    F5: 0x3e,
    F6: 0x3f,
    F7: 0x40,
    F8: 0x41,
    F9: 0x42,
    F10: 0x43,
    F11: 0x44,
    F12: 0x45,
    PrintScreen: 0x46,
    ScrollLock: 0x47,
    Pause: 0x48,
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
    NumLock: 0x53,
    NumpadDivide: 0x54,
    NumpadMultiply: 0x55,
    NumpadSubtract: 0x56,
    NumpadAdd: 0x57,
    NumpadEnter: 0x58,
    Numpad1: 0x59,
    Numpad2: 0x5a,
    Numpad3: 0x5b,
    Numpad4: 0x5c,
    Numpad5: 0x5d,
    Numpad6: 0x5e,
    Numpad7: 0x5f,
    Numpad8: 0x60,
    Numpad9: 0x61,
    Numpad0: 0x62,
    NumpadDecimal: 0x63,
    ContextMenu: 0x65,
};

// Modifier bit positions in byte 0 of the report.
const CODE_TO_MODIFIER: Record<string, number> = {
    ControlLeft: 1 << 0,
    ShiftLeft: 1 << 1,
    AltLeft: 1 << 2,
    MetaLeft: 1 << 3,
    ControlRight: 1 << 4,
    ShiftRight: 1 << 5,
    AltRight: 1 << 6,
    MetaRight: 1 << 7,
};

const MAX_KEYS = 6;

/**
 * Presents the browser's keyboard to the device as a real USB keyboard, over scrcpy's UHID
 * control messages.
 *
 * Preferred over injecting Android keycodes: the device applies its own layout, dead keys and
 * auto-repeat work, and -- because the device believes a hardware keyboard is attached -- it stops
 * popping its on-screen keyboard over the content you are trying to see.
 */
export class UhidKeyboard {
    private readonly pressed: number[] = [];
    private modifiers = 0;
    private created = false;
    private id?: number;

    constructor(
        private readonly sender: UhidKeyboardSender,
        id?: number,
    ) {
        if (id !== undefined) {
            this.setId(id);
        }
    }

    /** The server assigns a distinct UHID namespace slot to every active viewer. */
    public setId(id: number): void {
        if (!Number.isInteger(id) || id < 1 || id > 0xffff) {
            throw new Error(`Invalid UHID keyboard id: ${id}`);
        }
        if (this.id !== id) {
            this.destroy();
            this.id = id;
        }
    }

    public static isSupportedCode(code: string): boolean {
        return code in CODE_TO_HID || code in CODE_TO_MODIFIER;
    }

    public create(): void {
        if (this.created || this.id === undefined) {
            return;
        }
        this.created = true;
        this.sender.sendMessage(
            new UhidCreateControlMessage(this.id, VENDOR_ID, PRODUCT_ID, 'scrcpy', REPORT_DESCRIPTOR),
        );
    }

    public destroy(): void {
        if (!this.created || this.id === undefined) {
            return;
        }
        this.created = false;
        this.pressed.length = 0;
        this.modifiers = 0;
        this.sender.sendMessage(new UhidDestroyControlMessage(this.id));
    }

    /** Forget the old server's keyboard without queuing messages for the replacement session. */
    public reset(): void {
        this.created = false;
        this.id = undefined;
        this.pressed.length = 0;
        this.modifiers = 0;
    }

    /**
     * @returns true when the event was consumed (so the caller can `preventDefault()`), false for
     *     a key this descriptor has no usage id for -- those fall through to the caller's own
     *     handling rather than being swallowed.
     */
    public handleKey(code: string, down: boolean): boolean {
        if (!this.created) {
            // Keep browser shortcuts suppressed during reconnect without carrying offline
            // key presses into the new device's first input report.
            return UhidKeyboard.isSupportedCode(code);
        }
        const modifier = CODE_TO_MODIFIER[code];
        if (modifier !== undefined) {
            this.modifiers = down ? this.modifiers | modifier : this.modifiers & ~modifier;
            this.sendReport();
            return true;
        }
        const usage = CODE_TO_HID[code];
        if (usage === undefined) {
            return false;
        }
        const index = this.pressed.indexOf(usage);
        if (down) {
            // Re-press of a held key is auto-repeat; the device generates that itself from the
            // held report, so re-sending would double up.
            if (index !== -1) {
                return true;
            }
            if (this.pressed.length >= MAX_KEYS) {
                this.pressed.shift();
            }
            this.pressed.push(usage);
        } else if (index !== -1) {
            this.pressed.splice(index, 1);
        }
        this.sendReport();
        return true;
    }

    /** Releases everything. Needed on blur: keys released while unfocused are never seen here, and
     *  a stuck modifier would silently corrupt every later keystroke. */
    public releaseAll(): void {
        if (!this.pressed.length && !this.modifiers) {
            return;
        }
        this.pressed.length = 0;
        this.modifiers = 0;
        this.sendReport();
    }

    private sendReport(): void {
        if (!this.created || this.id === undefined) {
            return;
        }
        const report = new Uint8Array(2 + MAX_KEYS);
        report[0] = this.modifiers;
        for (let i = 0; i < this.pressed.length && i < MAX_KEYS; i++) {
            report[2 + i] = this.pressed[i];
        }
        this.sender.sendMessage(new UhidInputControlMessage(this.id, report));
    }
}
