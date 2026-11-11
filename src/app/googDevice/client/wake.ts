import { ControlCenterCommand } from '../../../common/ControlCenterCommand';

// The server answers as soon as adb has delivered the key. Longer than this, something is stuck.
const WAKE_TIMEOUT_MS = 8000;

interface WakeReply {
    udid?: string;
    requestId?: number;
    error?: string;
}

/** The part of a device tracker this needs: its command channel and the replies on it. */
export interface WakeTracker {
    sendCommand(type: string, data?: Record<string, unknown>): number;
    on(event: string, listener: (reply: WakeReply) => void): void;
    off(event: string, listener: (reply: WakeReply) => void): void;
}

/**
 * Wakes an Android device's screen from its card. The request goes over the device list's own
 * connection and the server sends the wake key through adb, so no stream is opened and it works
 * while the stream service is stopped.
 *
 * Resolves when the server reports that the device took the key. Rejects with a message for the
 * card when the device refuses it or nothing answers.
 */
export function wakeDevice(tracker: WakeTracker, udid: string, timeoutMs = WAKE_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timeout);
            tracker.off(ControlCenterCommand.WAKE_DEVICE, onReply);
        };
        const onReply = (reply: WakeReply) => {
            if (reply?.udid !== udid || reply.requestId !== requestId) {
                return;
            }
            cleanup();
            if (reply.error) {
                reject(new Error(reply.error));
            } else {
                resolve();
            }
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('The server did not answer. Check the connection and try again.'));
        }, timeoutMs);
        // Listen first: the reply is matched to this request by the id that sending returns.
        tracker.on(ControlCenterCommand.WAKE_DEVICE, onReply);
        const requestId = tracker.sendCommand(ControlCenterCommand.WAKE_DEVICE, { udid });
    });
}
