import { StreamClientScrcpy } from './client/StreamClientScrcpy';
import { TextControlMessage } from '../controlMessage/TextControlMessage';
import { KeyCodeControlMessage } from '../controlMessage/KeyCodeControlMessage';
import KeyEvent from './android/KeyEvent';
import type { LiveTextKey, LiveTextTarget } from '../views/LiveTextOverlay';

const KEYCODES: Record<LiveTextKey, number> = {
    enter: KeyEvent.KEYCODE_ENTER,
    backspace: KeyEvent.KEYCODE_DEL,
    delete: KeyEvent.KEYCODE_FORWARD_DEL,
    left: KeyEvent.KEYCODE_DPAD_LEFT,
    right: KeyEvent.KEYCODE_DPAD_RIGHT,
};

/** The Type text overlay on Android: text is injected whole, editing keys as key events. */
export function scrcpyLiveTextTarget(client: StreamClientScrcpy): LiveTextTarget {
    return {
        hint: 'Tap a text field on the device first. Text is sent as you type.',
        sendText(text) {
            client.sendMessage(new TextControlMessage(text));
        },
        sendKey(key) {
            const keycode = KEYCODES[key];
            client.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_DOWN, keycode, 0, 0));
            client.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_UP, keycode, 0, 0));
        },
    };
}
