import { ControlCenterCommand } from '../../common/ControlCenterCommand';

/** What a command needs from a device tracker; `BaseDeviceTracker` and the tests' fakes both fit. */
export interface CommandTracker {
    on(type: string, listener: (reply: TrackerReply) => void): void;
    off(type: string, listener: (reply: TrackerReply) => void): void;
    sendCommand(type: string, data?: Record<string, unknown>): number;
    // Absent on a fake that is always connected.
    isOpen?(): boolean;
    onceClosed?(listener: () => void): () => void;
}

export interface TrackerReply {
    udid?: string;
    requestId?: number;
    result?: unknown;
    error?: string;
}

export const TRACKER_UNREACHABLE = 'Could not reach the server. Reconnect and try again.';
export const TRACKER_NO_ANSWER = 'No answer from the server. Check the connection and try again.';
export const TRACKER_CONNECTION_LOST =
    'The connection to the server dropped before it answered. Check the result once it is back.';

/** Thrown into the caller when its `signal` aborts; the caller has gone and wants no message. */
export class TrackerCommandAborted extends Error {
    constructor() {
        super('Canceled');
        this.name = 'TrackerCommandAborted';
    }
}

/**
 * One command over a tracker socket, resolved with the `result` of the matching reply.
 *
 * A reply matches on `udid` and on the request id, so the answer to another device's command, or
 * to an earlier one of the same type, is never taken for this one. The promise always settles:
 * with the reply, with its `error`, at once when the socket is not open (nothing was sent, so no
 * reply can come), when the socket closes while waiting, after `timeoutMs`, or when `signal`
 * aborts (the view that asked has gone). The listener and the timer are removed on every exit.
 * `data` is sent as given and neither kept nor logged here; `SET_UNLOCK_PASSCODE` relies on that.
 */
export function sendTrackerCommand(
    tracker: CommandTracker,
    type: string,
    udid: string,
    data: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new TrackerCommandAborted());
            return;
        }
        if (tracker.isOpen && !tracker.isOpen()) {
            reject(new Error(TRACKER_UNREACHABLE));
            return;
        }
        let requestId: number | undefined;
        const cleanup = () => {
            clearTimeout(timeout);
            tracker.off(type, onReply);
            signal?.removeEventListener('abort', onAbort);
            stopWatchingClose?.();
        };
        const onReply = (reply: TrackerReply) => {
            if (reply?.udid !== udid || reply.requestId !== requestId) {
                return;
            }
            cleanup();
            if (reply.error) {
                reject(new Error(reply.error));
            } else {
                resolve(reply.result);
            }
        };
        const onAbort = () => {
            cleanup();
            reject(new TrackerCommandAborted());
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(TRACKER_NO_ANSWER));
        }, timeoutMs);
        tracker.on(type, onReply);
        signal?.addEventListener('abort', onAbort, { once: true });
        // The server answers on the socket the command arrived on. Once that has closed the
        // answer has nowhere to go, even if the tracker reconnects a moment later.
        const stopWatchingClose = tracker.onceClosed?.(() => {
            cleanup();
            reject(new Error(TRACKER_CONNECTION_LOST));
        });
        try {
            requestId = tracker.sendCommand(type, { udid, ...data });
        } catch {
            cleanup();
            reject(new Error(TRACKER_UNREACHABLE));
        }
    });
}

/** The text a service command answers with (`'Developer image mounted.'`), or `fallback`. */
export function replyText(result: unknown, fallback: string): string {
    return typeof result === 'string' && result ? result : fallback;
}

// How long each iPhone service command may take on the server, with room for the reply.
const SERVICE_COMMAND_TIMEOUT_MS: Record<string, number> = {
    // Reads the device list again; the details follow as a normal device update.
    [ControlCenterCommand.REFRESH_DEVICE]: 30000,
    // Stops the session and answers at once.
    [ControlCenterCommand.RESTART_SESSION]: 15000,
    // Waits for the old serve-web to close (up to 70 s), then mounts (up to 180 s).
    [ControlCenterCommand.REMOUNT_DDI]: 270000,
    // `diagnostics restart` and `shutdown` are given 60 s.
    [ControlCenterCommand.REBOOT_DEVICE]: 75000,
    [ControlCenterCommand.SHUTDOWN_DEVICE]: 75000,
    // The phone restarts and pymobiledevice3 waits for it to come back: 240 s on the server.
    [ControlCenterCommand.ENABLE_DEVELOPER_MODE]: 270000,
};
const DEFAULT_SERVICE_COMMAND_TIMEOUT_MS = 30000;

export function serviceCommandTimeoutMs(command: string): number {
    return SERVICE_COMMAND_TIMEOUT_MS[command] ?? DEFAULT_SERVICE_COMMAND_TIMEOUT_MS;
}

/** A command that takes only the device, such as Remount developer image, with its own time limit. */
export function sendServiceCommand(
    tracker: CommandTracker,
    command: string,
    udid: string,
    signal?: AbortSignal,
): Promise<unknown> {
    return sendTrackerCommand(tracker, command, udid, {}, serviceCommandTimeoutMs(command), signal);
}
