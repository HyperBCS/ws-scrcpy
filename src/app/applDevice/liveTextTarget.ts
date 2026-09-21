import { StreamClientCoreDevice } from './client/StreamClientCoreDevice';
import { HID_USAGE } from './hidKeyboard';
import type { LiveTextKey, LiveTextTarget } from '../views/LiveTextOverlay';

const USAGES: Record<LiveTextKey, number> = {
    enter: HID_USAGE.ENTER,
    backspace: HID_USAGE.BACKSPACE,
    delete: HID_USAGE.DELETE_FORWARD,
    left: HID_USAGE.ARROW_LEFT,
    right: HID_USAGE.ARROW_RIGHT,
};

/**
 * The Type text overlay on iOS. There is no "inject text" call on this path: every character is
 * a press and release on the virtual HID keyboard, queued in order with the editing keys, and
 * characters that have no US-layout key are reported back to the overlay.
 */
export function coreDeviceLiveTextTarget(client: StreamClientCoreDevice): LiveTextTarget {
    return {
        hint: 'Tap a text field on the phone first. Each character is typed on the phone as you enter it.',
        sendText(text) {
            return client.typeText(text);
        },
        sendKey(key) {
            void client.pressKey(USAGES[key]);
        },
    };
}
