import { ControlCenterCommand } from '../../common/ControlCenterCommand';
import {
    UNLOCK_RUN_TIMEOUT_MS,
    UnlockRunResult,
    UnlockSchedulePatch,
    UnlockScheduleStatus,
} from '../../common/IosUnlockSchedule';
import type { DeviceEntry } from './devices';

type UnlockTracker = DeviceEntry['tracker'];
type UnlockReply = { udid?: string; requestId?: number; result?: unknown; error?: string };

/** Wait for a settings reply. A run (`RUN_UNLOCK_NOW`) gets `UNLOCK_RUN_TIMEOUT_MS` instead. */
export const UNLOCK_SETTINGS_TIMEOUT_MS = 15000;

/**
 * One scheduled-unlock command over the tracker socket, resolved with the parsed `result` of the
 * matching reply. Same shape as `requestLockState` in `unlockDevice.ts`: match `udid` and
 * `requestId`, reject on `error`, clean up the listener and the timer on every exit. `data` is
 * sent as given and neither kept nor logged here; `SET_UNLOCK_PASSCODE` relies on that.
 */
export function sendUnlockCommand<T>(
    tracker: UnlockTracker,
    type: string,
    udid: string,
    data: Record<string, unknown>,
    timeoutMs: number,
): Promise<T> {
    return new Promise((resolve, reject) => {
        let requestId: number | undefined;
        const cleanup = () => {
            clearTimeout(timeout);
            tracker.off(type, onReply);
        };
        const onReply = (reply: UnlockReply) => {
            if (reply?.udid !== udid || reply.requestId !== requestId) {
                return;
            }
            cleanup();
            if (reply.error) {
                reject(new Error(reply.error));
                return;
            }
            try {
                resolve((typeof reply.result === 'string' ? JSON.parse(reply.result) : reply.result) as T);
            } catch {
                reject(new Error('The server sent an unreadable reply.'));
            }
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('No answer from the server. Check the connection and try again.'));
        }, timeoutMs);
        tracker.on(type, onReply);
        try {
            requestId = tracker.sendCommand(type, { udid, ...data });
        } catch {
            cleanup();
            reject(new Error('Could not reach the server. Reconnect and try again.'));
        }
    });
}

export function updateUnlockSchedule(
    tracker: UnlockTracker,
    udid: string,
    schedule: UnlockSchedulePatch,
): Promise<UnlockScheduleStatus> {
    return sendUnlockCommand(
        tracker,
        ControlCenterCommand.UPDATE_UNLOCK_SCHEDULE,
        udid,
        { schedule },
        UNLOCK_SETTINGS_TIMEOUT_MS,
    );
}

/** The one path a passcode takes to the server. The caller clears its copy once this settles. */
export function setUnlockPasscode(
    tracker: UnlockTracker,
    udid: string,
    passcode: string,
): Promise<UnlockScheduleStatus> {
    return sendUnlockCommand(
        tracker,
        ControlCenterCommand.SET_UNLOCK_PASSCODE,
        udid,
        { passcode },
        UNLOCK_SETTINGS_TIMEOUT_MS,
    );
}

export function clearUnlockPasscode(tracker: UnlockTracker, udid: string): Promise<UnlockScheduleStatus> {
    return sendUnlockCommand(tracker, ControlCenterCommand.CLEAR_UNLOCK_PASSCODE, udid, {}, UNLOCK_SETTINGS_TIMEOUT_MS);
}

/** Resolves when the run has ended; a cold screen session can take most of a minute. */
export function runUnlockNow(tracker: UnlockTracker, udid: string): Promise<UnlockRunResult> {
    return sendUnlockCommand(tracker, ControlCenterCommand.RUN_UNLOCK_NOW, udid, {}, UNLOCK_RUN_TIMEOUT_MS);
}

/** A moment in this browser's local time, short enough for a row description: "Wed, Nov 4, 03:00". */
export function formatUnlockMoment(at: number): string {
    return new Date(at).toLocaleString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

/** "just now", "12 min ago", "3 h ago", "2 days ago"; for the card line. */
export function relativeUnlockTime(at: number, now = Date.now()): string {
    const minutes = Math.max(0, Math.round((now - at) / 60000));
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours} h ago`;
    }
    const days = Math.round(hours / 24);
    return days === 1 ? '1 day ago' : `${days} days ago`;
}
