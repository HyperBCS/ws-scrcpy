import { KeyCodeControlMessage } from '../controlMessage/KeyCodeControlMessage';
import KeyEvent from './android/KeyEvent';
import { KeyToCodeMap } from './KeyToCodeMap';
import { isLocalKeyboardTarget } from './localKeyboardTarget';

export interface KeyEventListener {
    onKeyEvent: (event: KeyCodeControlMessage) => void;
}

export class KeyInputHandler {
    private static readonly repeatCounter: Map<number, number> = new Map();
    private static readonly listeners: Set<KeyEventListener> = new Set();
    private static readonly pressed = new Set<number>();
    private static releaseKeys = (): void => {
        this.pressed.forEach((code) => {
            const message = new KeyCodeControlMessage(KeyEvent.ACTION_UP, code, 0, 0);
            this.listeners.forEach((listener) => listener.onKeyEvent(message));
        });
        this.pressed.clear();
        this.repeatCounter.clear();
    };
    private static onFocus = (event: FocusEvent): void => {
        if (isLocalKeyboardTarget(event.target)) {
            this.releaseKeys();
        }
    };
    private static handler = (event: Event): void => {
        const keyboardEvent = event as KeyboardEvent;
        if (isLocalKeyboardTarget(keyboardEvent.target) || keyboardEvent.isComposing) {
            this.releaseKeys();
            return;
        }
        const keyCode = KeyToCodeMap.get(keyboardEvent.code);
        if (!keyCode) {
            return;
        }
        let action: typeof KeyEvent.ACTION_DOWN | typeof KeyEvent.ACTION_UP;
        let repeatCount = 0;
        if (keyboardEvent.type === 'keydown') {
            KeyInputHandler.pressed.add(keyCode);
            action = KeyEvent.ACTION_DOWN;
            if (keyboardEvent.repeat) {
                let count = KeyInputHandler.repeatCounter.get(keyCode);
                if (typeof count !== 'number') {
                    count = 1;
                } else {
                    count++;
                }
                repeatCount = count;
                KeyInputHandler.repeatCounter.set(keyCode, count);
            }
        } else if (keyboardEvent.type === 'keyup') {
            KeyInputHandler.pressed.delete(keyCode);
            action = KeyEvent.ACTION_UP;
            KeyInputHandler.repeatCounter.delete(keyCode);
        } else {
            return;
        }
        const metaState =
            (keyboardEvent.getModifierState('Alt') ? KeyEvent.META_ALT_ON : 0) |
            (keyboardEvent.getModifierState('Shift') ? KeyEvent.META_SHIFT_ON : 0) |
            (keyboardEvent.getModifierState('Control') ? KeyEvent.META_CTRL_ON : 0) |
            (keyboardEvent.getModifierState('Meta') ? KeyEvent.META_META_ON : 0) |
            (keyboardEvent.getModifierState('CapsLock') ? KeyEvent.META_CAPS_LOCK_ON : 0) |
            (keyboardEvent.getModifierState('ScrollLock') ? KeyEvent.META_SCROLL_LOCK_ON : 0) |
            (keyboardEvent.getModifierState('NumLock') ? KeyEvent.META_NUM_LOCK_ON : 0);

        const controlMessage: KeyCodeControlMessage = new KeyCodeControlMessage(
            action,
            keyCode,
            repeatCount,
            metaState,
        );
        KeyInputHandler.listeners.forEach((listener) => {
            listener.onKeyEvent(controlMessage);
        });
        event.preventDefault();
    };
    private static attachListeners(): void {
        document.body.addEventListener('keydown', this.handler);
        document.body.addEventListener('keyup', this.handler);
        document.body.addEventListener('focusin', this.onFocus);
        window.addEventListener('blur', this.releaseKeys);
    }
    private static detachListeners(): void {
        this.releaseKeys();
        document.body.removeEventListener('keydown', this.handler);
        document.body.removeEventListener('keyup', this.handler);
        document.body.removeEventListener('focusin', this.onFocus);
        window.removeEventListener('blur', this.releaseKeys);
    }
    public static addEventListener(listener: KeyEventListener): void {
        if (!this.listeners.size) {
            this.attachListeners();
        }
        this.listeners.add(listener);
    }
    public static removeEventListener(listener: KeyEventListener): void {
        this.releaseKeys();
        this.listeners.delete(listener);
        if (!this.listeners.size) {
            this.detachListeners();
        }
    }
}
