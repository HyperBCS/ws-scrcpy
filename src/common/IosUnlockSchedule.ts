/**
 * Shared contract for the scheduled iPhone unlock: the schedule status the server keeps on
 * `ApplDeviceDescriptor.unlockSchedule`, the patch the settings panel sends, the outcomes a run
 * can end with, and the validators both sides apply.
 *
 * The status never carries the passcode. It travels to every browser with the normal `device`
 * broadcast, so the panel needs no read command; the passcode travels once, browser to server,
 * as `SET_UNLOCK_PASSCODE`, and is only ever decrypted on the server right before a run.
 */

/** Default daily unlock time, `HH:MM` in the schedule's time zone. */
export const DEFAULT_UNLOCK_TIME = '03:00';
/**
 * A phone unlocked within this window is left alone: iOS restarts after 72 h without an unlock.
 * The scheduler takes `UNLOCK_SLOT_WINDOW_MS` off it (22 h), so its own unlock the night before
 * does not skip tonight's run; `unlockOutcomeText('skipped-recent')` names the 22 hours.
 */
export const UNLOCK_RECENT_MS = 24 * 3600 * 1000;
/** A slot that passed more than this long ago is skipped, so a server down overnight does not unlock at 09:00. */
export const UNLOCK_SLOT_WINDOW_MS = 2 * 3600 * 1000;
/** One retry after a failed scheduled run that typed nothing, this long later. Manual runs never retry. */
export const UNLOCK_RETRY_MS = 10 * 60 * 1000;
/** How long a browser waits for the `RUN_UNLOCK_NOW` reply; a cold session can take ~45 s. */
export const UNLOCK_RUN_TIMEOUT_MS = 180000;
/** A manual run is refused this long after the last run that opened a display session. */
export const UNLOCK_MANUAL_COOLDOWN_MS = 2 * 60 * 1000;
/** At most this many session-opening runs per phone in `UNLOCK_SESSION_CAP_WINDOW_MS`. */
export const UNLOCK_SESSION_CAP = 3;
export const UNLOCK_SESSION_CAP_WINDOW_MS = 5 * 60 * 1000;
/** iOS restarts a phone that has not been unlocked for this long; after that only the phone itself can unlock it. */
export const UNLOCK_DEADLINE_MS = 72 * 3600 * 1000;
/** With the schedule on, one push is sent when the last unlock is this old. */
export const UNLOCK_DEADLINE_WARN_MS = 36 * 3600 * 1000;
/** Past this, a run starts outside the slot window, at most once per `UNLOCK_URGENT_INTERVAL_MS`. */
export const UNLOCK_DEADLINE_URGENT_MS = 48 * 3600 * 1000;
export const UNLOCK_URGENT_INTERVAL_MS = 2 * 3600 * 1000;
/**
 * Runs that typed the whole passcode without a confirmed unlock (lock state unreadable, or the
 * session failed after the digits). This many in a row stop the schedule like a rejected passcode.
 */
export const UNLOCK_UNCONFIRMED_LIMIT = 2;

/** Start of the message of a `failed-still-locked` run, the only kind that typed nothing. */
export const UNLOCK_NOT_TYPED_MESSAGE = 'Passcode not entered';

export type UnlockRunTrigger = 'schedule' | 'manual';

export type UnlockRunOutcome =
    | 'unlocked'
    | 'already-unlocked'
    | 'skipped-recent'
    | 'skipped-disabled'
    | 'skipped-no-passcode'
    | 'skipped-disconnected'
    // The stored passcode was rejected earlier; nothing is typed until it is saved again.
    | 'skipped-rejected'
    // A viewer was still typing or touching after the wait.
    | 'skipped-viewer'
    | 'failed-wake'
    | 'failed-session'
    // The passcode could not be read, so nothing was typed.
    | 'failed-still-locked'
    // The digits were typed and the phone stayed locked.
    | 'failed-rejected'
    | 'unverified'
    // The phone was unlocked and did not read as locked after Lock was pressed.
    | 'left-unlocked';

export interface UnlockRunResult {
    at: number;
    trigger: UnlockRunTrigger;
    outcome: UnlockRunOutcome;
    // Plain text for the panel and the push body. Never contains the passcode or HID usages.
    message?: string;
}

export interface UnlockScheduleStatus {
    enabled: boolean;
    // `HH:MM` in `timeZone`.
    time: string;
    // IANA zone the browser sent when the schedule was last saved. Absent on a schedule saved
    // before zones were stored: `time` is then server local time, named by `serverTimeZone`.
    timeZone?: string;
    serverTimeZone?: string;
    hasPasscode: boolean;
    // A run typed the stored passcode and the phone stayed locked (or two runs in a row could
    // not confirm an unlock). No run types it again until it is saved again.
    passcodeRejected?: boolean;
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
    // The browser's IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
    timeZone?: string;
}

/** Options of `RUN_UNLOCK_NOW`. */
export interface UnlockRunOptions {
    // The Unlock sheet of the stream page: unlock for a viewer and do not press Lock afterwards.
    keepUnlocked?: boolean;
}

const UNLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// The HID path types digits only.
const UNLOCK_PASSCODE = /^\d{4,10}$/;

export function isValidUnlockTime(value: unknown): value is string {
    return typeof value === 'string' && UNLOCK_TIME.test(value);
}

export function isValidUnlockPasscode(value: unknown): value is string {
    return typeof value === 'string' && UNLOCK_PASSCODE.test(value);
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** The formatter for a zone, or `undefined` when the runtime does not know the zone. */
function zoneFormat(timeZone: string): Intl.DateTimeFormat | undefined {
    let format = zoneFormats.get(timeZone);
    if (!format) {
        try {
            format = new Intl.DateTimeFormat('en-US', {
                timeZone,
                hourCycle: 'h23',
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric',
            });
        } catch {
            return undefined;
        }
        zoneFormats.set(timeZone, format);
    }
    return format;
}

/** An IANA zone name this runtime can compute with. */
export function isValidUnlockTimeZone(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 64 && !!zoneFormat(value);
}

/** The zone of this process or browser, or `undefined` when it cannot be named. */
export function localTimeZone(): string | undefined {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return isValidUnlockTimeZone(zone) ? zone : undefined;
    } catch {
        return undefined;
    }
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
    if ('timeZone' in patch && !isValidUnlockTimeZone(patch.timeZone)) {
        return false;
    }
    return 'enabled' in patch || 'time' in patch;
}

/** `[hours, minutes]` of a validated `HH:MM`. */
export function parseUnlockTime(time: string): [number, number] {
    const [hours, minutes] = time.split(':');
    return [Number(hours), Number(minutes)];
}

/** Wall-clock fields of `at` in the formatter's zone, as the UTC instant that shows the same fields. */
function wallClock(at: number, format: Intl.DateTimeFormat): number {
    const fields: Record<string, number> = {};
    for (const part of format.formatToParts(new Date(at))) {
        if (part.type !== 'literal') {
            fields[part.type] = Number(part.value);
        }
    }
    return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
}

/**
 * The instant at which the zone shows the wall-clock time `wall` (given as the UTC instant with
 * the same fields). A time skipped by a daylight-saving change resolves to the instant one hour
 * earlier on the clock; a time that occurs twice resolves to the first.
 */
function zonedInstant(wall: number, format: Intl.DateTimeFormat): number {
    const first = wall - (wallClock(wall, format) - wall);
    return wall - (wallClock(first, format) - first);
}

/** `time` on the zone's calendar day of `now`, shifted by `dayOffset` days. */
function zonedSlot(time: string, now: number, format: Intl.DateTimeFormat, dayOffset: number): number {
    const [hours, minutes] = parseUnlockTime(time);
    const today = new Date(wallClock(now, format));
    return zonedInstant(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + dayOffset, hours, minutes),
        format,
    );
}

/**
 * The next occurrence of `time`, strictly after `now`, in `timeZone` (server local time when no
 * zone is given). Day arithmetic is on the calendar, so a daylight-saving change makes one
 * interval 23 or 25 hours instead of skipping a day.
 */
export function nextUnlockRunAt(time: string, now: number, timeZone?: string): number {
    const format = timeZone ? zoneFormat(timeZone) : undefined;
    if (format) {
        // A slot inside a skipped hour can resolve to before `now`; a later day never does.
        for (let day = 0; day < 3; day++) {
            const slot = zonedSlot(time, now, format, day);
            if (slot > now) {
                return slot;
            }
        }
    }
    const [hours, minutes] = parseUnlockTime(time);
    const next = new Date(now);
    next.setHours(hours, minutes, 0, 0);
    if (next.getTime() <= now) {
        next.setDate(next.getDate() + 1);
        next.setHours(hours, minutes, 0, 0);
    }
    return next.getTime();
}

/**
 * Start of the most recent slot at or before `now` (today's `time`, or yesterday's if today's is
 * still ahead), in `timeZone` or server local time.
 */
export function lastUnlockSlotAt(time: string, now: number, timeZone?: string): number {
    const format = timeZone ? zoneFormat(timeZone) : undefined;
    if (format) {
        for (let day = 0; day > -3; day--) {
            const slot = zonedSlot(time, now, format, day);
            if (slot <= now) {
                return slot;
            }
        }
    }
    const [hours, minutes] = parseUnlockTime(time);
    const slot = new Date(now);
    slot.setHours(hours, minutes, 0, 0);
    if (slot.getTime() > now) {
        slot.setDate(slot.getDate() - 1);
        slot.setHours(hours, minutes, 0, 0);
    }
    return slot.getTime();
}

/** Outcomes shown in the error tone: the run did not do its job, or left the phone exposed. */
export function isUnlockProblem(outcome: UnlockRunOutcome): boolean {
    return (
        outcome.startsWith('failed-') ||
        outcome === 'unverified' ||
        outcome === 'left-unlocked' ||
        outcome === 'skipped-disconnected' ||
        outcome === 'skipped-no-passcode' ||
        outcome === 'skipped-rejected'
    );
}

/** Plain words for an outcome, shared by the panel, the card line and the push body. */
export function unlockOutcomeText(outcome: UnlockRunOutcome): string {
    switch (outcome) {
        case 'unlocked':
            // The message says "Locked again" when Lock was pressed and confirmed.
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
        case 'skipped-rejected':
            return 'Skipped: the stored passcode was rejected';
        case 'skipped-viewer':
            return 'Skipped: someone is using the phone';
        case 'failed-wake':
            return 'Failed: the screen did not wake';
        case 'failed-session':
            return 'Failed: the screen session failed';
        case 'failed-still-locked':
            return 'Failed: the phone is still locked';
        case 'failed-rejected':
            return 'Failed: the stored passcode was rejected';
        case 'unverified':
            return 'Lock state not confirmed';
        case 'left-unlocked':
            return 'Unlocked, but the phone did not lock again';
    }
}
