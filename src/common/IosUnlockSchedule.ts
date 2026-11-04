/**
 * Shared contract for the scheduled iPhone unlock: the schedule status the server keeps on
 * `ApplDeviceDescriptor.unlockSchedule`, the patch the settings panel sends, the outcomes a run
 * can end with, and the validators both sides apply.
 *
 * The status never carries the passcode. It travels to every browser with the normal `device`
 * broadcast, so the panel needs no read command; the passcode travels once, browser to server,
 * as `SET_UNLOCK_PASSCODE`, and is only ever decrypted on the server right before a run.
 */

/** Default daily unlock time, `HH:MM` in server local time. */
export const DEFAULT_UNLOCK_TIME = '03:00';
/**
 * A phone unlocked within this window is left alone: iOS restarts after 72 h without an unlock.
 * The scheduler takes `UNLOCK_SLOT_WINDOW_MS` off it (22 h), so its own unlock the night before
 * does not skip tonight's run; `unlockOutcomeText('skipped-recent')` names the 22 hours.
 */
export const UNLOCK_RECENT_MS = 24 * 3600 * 1000;
/** A slot that passed more than this long ago is skipped, so a server down overnight does not unlock at 09:00. */
export const UNLOCK_SLOT_WINDOW_MS = 2 * 3600 * 1000;
/** One retry after a failed scheduled run, this long later. Manual runs never retry. */
export const UNLOCK_RETRY_MS = 10 * 60 * 1000;
/** How long a browser waits for the `RUN_UNLOCK_NOW` reply; a cold session can take ~45 s. */
export const UNLOCK_RUN_TIMEOUT_MS = 180000;

export type UnlockRunTrigger = 'schedule' | 'manual';

export type UnlockRunOutcome =
    | 'unlocked'
    | 'already-unlocked'
    | 'skipped-recent'
    | 'skipped-disabled'
    | 'skipped-no-passcode'
    | 'skipped-disconnected'
    | 'failed-wake'
    | 'failed-session'
    | 'failed-still-locked'
    | 'unverified';

export interface UnlockRunResult {
    at: number;
    trigger: UnlockRunTrigger;
    outcome: UnlockRunOutcome;
    // Plain text for the panel and the push body. Never contains the passcode or HID usages.
    message?: string;
}

export interface UnlockScheduleStatus {
    enabled: boolean;
    // `HH:MM`, server local time.
    time: string;
    hasPasscode: boolean;
    // Last time the phone was seen going from locked to unlocked, by any means.
    lastUnlockedAt?: number;
    // Set while `enabled && hasPasscode`: the next slot, or a pending retry if one is earlier.
    nextRunAt?: number;
    lastRun?: UnlockRunResult;
    // A run is in progress (scheduled or manual); the panel disables "Run now" meanwhile.
    running?: boolean;
}

export interface UnlockSchedulePatch {
    enabled?: boolean;
    time?: string;
}

const UNLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// Same rule as `StreamClientCoreDevice.unlockWithPasscode`: the HID path types digits only.
const UNLOCK_PASSCODE = /^\d{4,10}$/;

export function isValidUnlockTime(value: unknown): value is string {
    return typeof value === 'string' && UNLOCK_TIME.test(value);
}

export function isValidUnlockPasscode(value: unknown): value is string {
    return typeof value === 'string' && UNLOCK_PASSCODE.test(value);
}

export function isValidUnlockSchedulePatch(value: unknown): value is UnlockSchedulePatch {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const patch = value as Record<string, unknown>;
    if ('enabled' in patch && typeof patch.enabled !== 'boolean') {
        return false;
    }
    if ('time' in patch && !isValidUnlockTime(patch.time)) {
        return false;
    }
    return 'enabled' in patch || 'time' in patch;
}

/** `[hours, minutes]` of a validated `HH:MM`. */
export function parseUnlockTime(time: string): [number, number] {
    const [hours, minutes] = time.split(':');
    return [Number(hours), Number(minutes)];
}

/**
 * The next occurrence of `time` in server local time, strictly after `now`. Day arithmetic goes
 * through `setDate`, so a DST change makes one interval 23 or 25 hours instead of skipping a day.
 */
export function nextUnlockRunAt(time: string, now: number): number {
    const [hours, minutes] = parseUnlockTime(time);
    const next = new Date(now);
    next.setHours(hours, minutes, 0, 0);
    if (next.getTime() <= now) {
        next.setDate(next.getDate() + 1);
        next.setHours(hours, minutes, 0, 0);
    }
    return next.getTime();
}

/** Start of the most recent slot at or before `now` (today's `time`, or yesterday's if today's is still ahead). */
export function lastUnlockSlotAt(time: string, now: number): number {
    const [hours, minutes] = parseUnlockTime(time);
    const slot = new Date(now);
    slot.setHours(hours, minutes, 0, 0);
    if (slot.getTime() > now) {
        slot.setDate(slot.getDate() - 1);
        slot.setHours(hours, minutes, 0, 0);
    }
    return slot.getTime();
}

/** Plain words for an outcome, shared by the panel, the card line and the push body. */
export function unlockOutcomeText(outcome: UnlockRunOutcome): string {
    switch (outcome) {
        case 'unlocked':
            // The message says whether it locked again: "Locked again" or "Lock not confirmed".
            return 'Unlocked';
        case 'already-unlocked':
            return 'Already unlocked';
        case 'skipped-recent':
            return 'Skipped: unlocked in the last 22 hours';
        case 'skipped-disabled':
            return 'Skipped: scheduled unlock is off';
        case 'skipped-no-passcode':
            return 'Skipped: no passcode stored';
        case 'skipped-disconnected':
            return 'Phone not reachable';
        case 'failed-wake':
            return 'Failed: the screen did not wake';
        case 'failed-session':
            return 'Failed: the screen session did not start';
        case 'failed-still-locked':
            return 'Failed: the phone is still locked';
        case 'unverified':
            return 'Passcode entered, lock state not confirmed';
    }
}
