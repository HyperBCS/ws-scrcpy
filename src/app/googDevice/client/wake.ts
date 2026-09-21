import { StreamReceiverScrcpy } from './StreamReceiverScrcpy';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import KeyEvent from '../android/KeyEvent';
import { ACTION } from '../../../common/Action';

// How long to keep the ephemeral control connection open after sending the key: `sendEvent`
// queues until the socket is OPEN and flushes immediately after, but the flush itself is
// asynchronous (a WebSocket send), so closing on the same tick could drop it.
const WAKE_CONNECTION_LIFETIME_MS = 1500;

/**
 * Sends `KEYCODE_WAKEUP` to a device that has no active stream open in this tab, by opening a
 * throwaway control-only connection instead of a full `StreamClientScrcpy` (no player, no video
 * rendering, nothing appended to the DOM).
 *
 * This only works when the device's scrcpy server is already running (there is a `ws` endpoint to
 * connect to at all -- see `DeviceCard`, which only renders the Wake action when `hasPid` is
 * true). It is deliberately NOT wired up to auto-start the server first: starting a server is a
 * heavier action (spins up an encoder) than this button should trigger silently, and doing so
 * would race the tracker's own pid update. When the server isn't running the card asks the user to
 * start it explicitly instead of pretending Wake can help.
 *
 * Unverified against a real device (none attached in this environment) -- reasoning: the control
 * channel a `KeyCodeControlMessage` travels over is independent of the video channel (see
 * `StreamReceiver`'s `sendEvent`/`onSocketMessage` split), so it should not require a player or an
 * initial-info handshake to accept input.
 */
export function sendWakeKey(udid: string, wsUrl: string): void {
    const receiver = new StreamReceiverScrcpy({
        action: ACTION.STREAM_SCRCPY,
        udid,
        ws: wsUrl,
        player: 'wake-helper',
    });
    receiver.sendEvent(new KeyCodeControlMessage(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_WAKEUP, 0, 0));
    receiver.sendEvent(new KeyCodeControlMessage(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_WAKEUP, 0, 0));
    setTimeout(() => receiver.stop(), WAKE_CONNECTION_LIFETIME_MS);
}
