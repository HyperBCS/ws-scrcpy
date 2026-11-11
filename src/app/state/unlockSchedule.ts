import { ControlCenterCommand } from '../../common/ControlCenterCommand';
import {
    isUnlockProblem,
    secondUnlockTime,
    unlockOutcomeText,
    UNLOCK_BY_HAND_MESSAGE,
    UNLOCK_RUN_TIMEOUT_MS,
    UnlockRunOptions,
    UnlockRunResult,
    UnlockSchedulePatch,
    UnlockScheduleStatus,
} from '../../common/IosUnlockSchedule';
import { CommandTracker, sendTrackerCommand } from '../client/trackerCommand';

type UnlockTracker = CommandTracker;

/** Wait for a settings reply. A run (`RUN_UNLOCK_NOW`) gets `UNLOCK_RUN_TIMEOUT_MS` instead. */
export const UNLOCK_SETTINGS_TIMEOUT_MS = 15000;

/**
 * One scheduled-unlock command over the tracker socket (`sendTrackerCommand`), resolved with the
 * parsed `result` of the matching reply. It rejects at once when the socket is closed, and when
 * the socket closes while the reply is awaited: a run goes on without the browser, and its
 * result arrives with the device update. `data` is sent as given and neither kept nor logged.
 */
export function sendUnlockCommand<T>(
    tracker: UnlockTracker,
    type: string,
    udid: string,
    data: Record<string, unknown>,
    timeoutMs: number,
): Promise<T> {
    return sendTrackerCommand(tracker, type, udid, data, timeoutMs).then((result) => {
        try {
            return (typeof result === 'string' ? JSON.parse(result) : result) as T;
        } catch {
            throw new Error('The server sent an unreadable reply.');
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

/**
 * Resolves when the run has ended; a cold screen session can take most of a minute. Rejects when
 * the server refuses the run (too soon after the last one), with its message. `keepUnlocked` is
 * the stream page's Unlock: the server types the stored passcode and does not press Lock after.
 */
export function runUnlockNow(
    tracker: UnlockTracker,
    udid: string,
    options: UnlockRunOptions = {},
): Promise<UnlockRunResult> {
    return sendUnlockCommand(
        tracker,
        ControlCenterCommand.RUN_UNLOCK_NOW,
        udid,
        options.keepUnlocked ? { keepUnlocked: true } : {},
        UNLOCK_RUN_TIMEOUT_MS,
    );
}

/**
 * The zone the schedule's times are shown in: the one stored with the schedule, or the server's
 * for a schedule saved before zones were stored. `undefined` falls back to this browser's zone.
 */
export function unlockDisplayZone(
    status: Pick<UnlockScheduleStatus, 'timeZone' | 'serverTimeZone'>,
): string | undefined {
    return status.timeZone ?? status.serverTimeZone;
}

/** A moment short enough for a row description, "Wed, Nov 4, 03:00", in `timeZone` or this browser's zone. */
export function formatUnlockMoment(at: number, timeZone?: string): string {
    const options: Intl.DateTimeFormatOptions = {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    };
    try {
        return new Date(at).toLocaleString([], { ...options, timeZone });
    } catch {
        // A zone this browser does not know.
        return new Date(at).toLocaleString([], options);
    }
}

/** The clock time of a moment, written like the stored `time` ("15:00"), in `timeZone` or this browser's zone. */
function formatUnlockClock(at: number, timeZone?: string): string {
    const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    try {
        return new Date(at).toLocaleTimeString('en-GB', { ...options, timeZone });
    } catch {
        // A zone this browser does not know.
        return new Date(at).toLocaleTimeString('en-GB', options);
    }
}

/**
 * The scheduled-unlock line of the iPhone card, or `undefined` while the schedule is off. A
 * schedule that is on but cannot run, or whose last run failed, is a problem and says why.
 * The text names the next run, which is the next of the two daily times or a retry before it;
 * the title names both times.
 */
export function unlockCardLine(
    status: UnlockScheduleStatus,
    now = Date.now(),
): { text: string; title: string; problem: boolean } | undefined {
    if (!status.enabled) {
        return undefined;
    }
    const zone = status.timeZone ?? (status.serverTimeZone ? `server time (${status.serverTimeZone})` : 'server time');
    const times = `${status.time} and ${secondUnlockTime(status.time)}`;
    const title = `Scheduled unlock at ${times}, ${zone}`;
    if (status.needsManualUnlock) {
        // Nothing remote works until the passcode is entered on the phone, so this comes first.
        return { text: UNLOCK_BY_HAND_MESSAGE, title, problem: true };
    }
    if (status.passcodeRejected) {
        return { text: 'Scheduled unlock paused: passcode rejected', title, problem: true };
    }
    if (!status.hasPasscode) {
        return { text: 'Scheduled unlock cannot run: no passcode', title, problem: true };
    }
    const next = status.nextRunAt ? `next ${formatUnlockClock(status.nextRunAt, unlockDisplayZone(status))}` : '';
    // Without a next run from the server, the two times stand in for it.
    const line = (...parts: string[]) =>
        [next ? 'Scheduled unlock' : `Scheduled unlock ${times}`, ...parts].filter(Boolean).join(' · ');
    if (status.lastRun && isUnlockProblem(status.lastRun.outcome)) {
        return { text: line(unlockOutcomeText(status.lastRun.outcome), next), title, problem: true };
    }
    if (status.waitingForLock) {
        return { text: line('runs when the phone is locked'), title, problem: false };
    }
    const last = status.lastUnlockedAt ? `last ${relativeUnlockTime(status.lastUnlockedAt, now)}` : '';
    return { text: line(next, last), title, problem: false };
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
