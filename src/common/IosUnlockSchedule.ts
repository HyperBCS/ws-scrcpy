/**
 * Shared contract for the scheduled iPhone unlock: the schedule status the server keeps on
 * `ApplDeviceDescriptor.unlockSchedule`, the patch the settings panel sends, the outcomes a run
 * can end with, and the validators both sides apply.
 *
 * The status never carries the passcode. It travels to every browser with the normal `device`
 * broadcast, so the panel needs no read command; the passcode travels once, browser to server,
 * as `SET_UNLOCK_PASSCODE`, and is only ever decrypted on the server right before a run.
 */

/** Default time of the first of the two daily runs, `HH:MM` in the schedule's time zone. */
export const DEFAULT_UNLOCK_TIME = '03:00';
/**
 * An iPhone refuses every new service connection (mount, tunnel, diagnostics) once this long has
 * passed since its passcode was last entered. Nothing remote works after that, the unlock
 * included, until the passcode is entered on the phone. Inferred from one event on iOS 27.2.
 */
export const UNLOCK_PASSCODE_LIMIT_MS = 24 * 3600 * 1000;
/** The schedule runs at the set time and this long after it. Not a setting. */
export const UNLOCK_INTERVAL_MS = 12 * 3600 * 1000;
/** Kept free between the slot after a skipped one and the limit. An autumn clock change uses half an hour of it. */
export const UNLOCK_SKIP_MARGIN_MS = 3600 * 1000;
/**
 * A slot is skipped only when the server typed the passcode, and saw the phone unlock, less than
 * this long before it: 11 hours. The next slot then still comes before the limit.
 */
export const UNLOCK_SKIP_WINDOW_MS = UNLOCK_PASSCODE_LIMIT_MS - UNLOCK_INTERVAL_MS - UNLOCK_SKIP_MARGIN_MS;
/** With the schedule on, one push is sent when the passcode was last entered this long ago. */
export const UNLOCK_WARN_MS = 20 * 3600 * 1000;
/** The first retry after a failed scheduled run that typed nothing. Manual runs never retry. */
export const UNLOCK_RETRY_MS = 10 * 60 * 1000;
/** Every retry after the first, until a run works or the next slot arrives. */
export const UNLOCK_HOURLY_RETRY_MS = 3600 * 1000;
/** How long a browser waits for the `RUN_UNLOCK_NOW` reply; a cold session can take ~45 s. */
export const UNLOCK_RUN_TIMEOUT_MS = 180000;
/** A manual run is refused this long after the last run that opened a display session. */
export const UNLOCK_MANUAL_COOLDOWN_MS = 2 * 60 * 1000;
/** At most this many session-opening runs per phone in `UNLOCK_SESSION_CAP_WINDOW_MS`. */
export const UNLOCK_SESSION_CAP = 3;
export const UNLOCK_SESSION_CAP_WINDOW_MS = 5 * 60 * 1000;
/**
 * Runs that typed the whole passcode without a confirmed unlock (lock state unreadable, or the
 * session failed after the digits). This many in a row stop the schedule like a rejected passcode.
 */
export const UNLOCK_UNCONFIRMED_LIMIT = 2;

/** Start of the message of a `failed-still-locked` run, the only kind that typed nothing. */
export const UNLOCK_NOT_TYPED_MESSAGE = 'Passcode not entered';

const LOCKOUT_TEXT = 'The iPhone stopped accepting connections';
/** The message of a `needs-manual-unlock` run. */
export const UNLOCK_BY_HAND_ACTION = 'Enter the passcode on the phone.';
/** What the panel, the card, the push and the stream page say when the phone refuses connections. */
export const UNLOCK_BY_HAND_MESSAGE = `${LOCKOUT_TEXT}. ${UNLOCK_BY_HAND_ACTION}`;

// pymobiledevice3 11.44.0: `PasswordRequiredError` reads "Device is password protected. Please
// unlock and retry.", a refused service start "The device is protected with a passcode. Unlock it
// and try again.", and lockdown's own error code is `PasswordProtected`.
const PASSCODE_REFUSAL = /password protected|protected with a passcode|PasswordProtected|PasswordRequiredError/i;

/**
 * Whether a failure text says the phone refused the connection until its passcode is entered:
 * pymobiledevice3's wording, or `UNLOCK_BY_HAND_MESSAGE` once the session runner has put it in
 * plain words. The only place the wording is matched.
 */
export function isPasscodeLockout(text: unknown): boolean {
    return typeof text === 'string' && (PASSCODE_REFUSAL.test(text) || text.includes(LOCKOUT_TEXT));
}

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
    | 'left-unlocked'
    // The phone refused the connection: the passcode has to be entered on the phone itself.
    | 'needs-manual-unlock';

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
    // Set while `enabled && hasPasscode`: the next of the two daily slots, or a pending retry if
    // one is earlier.
    nextRunAt?: number;
    // The phone refused the last connection until its passcode is entered on the phone. Cleared
    // when a run or the state monitor reaches the phone again.
    needsManualUnlock?: boolean;
    // A slot has arrived while the phone was in use; its run starts when the phone is locked.
    waitingForLock?: boolean;
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
 * the same fields). A time skipped by a daylight-saving change resolves to an instant one hour
 * from it on the clock, and a time that occurs twice to one of the two; which one depends on the
 * side of UTC the zone is on. Either way the slot happens once that day.
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

/** The same in server local time, for a schedule saved without a zone. */
function localSlot(time: string, now: number, dayOffset: number): number {
    const [hours, minutes] = parseUnlockTime(time);
    const slot = new Date(now);
    slot.setDate(slot.getDate() + dayOffset);
    slot.setHours(hours, minutes, 0, 0);
    return slot.getTime();
}

/**
 * The slots around `now`, in order. Each calendar day has two: `time`, and the moment halfway to
 * the next day's `time`. That is 12 hours later on every day but the two with a daylight-saving
 * change, where the 23 or 25 hours are split evenly. A second slot at a fixed 12 hours, or at a
 * fixed clock time, would leave one gap of 13 hours in autumn, which the skip rule has no margin
 * for. Day arithmetic is on the calendar, so no slot is skipped or doubled.
 */
function unlockSlots(time: string, now: number, timeZone?: string): number[] {
    const format = timeZone ? zoneFormat(timeZone) : undefined;
    const starts: number[] = [];
    for (let day = -2; day <= 3; day++) {
        starts.push(format ? zonedSlot(time, now, format, day) : localSlot(time, now, day));
    }
    const slots: number[] = [];
    for (let index = 0; index + 1 < starts.length; index++) {
        const half = Math.floor((starts[index + 1] - starts[index]) / 2 / 60000) * 60000;
        slots.push(starts[index], starts[index] + half);
    }
    return slots;
}

/**
 * The next slot strictly after `now`, in `timeZone` (server local time when no zone is given):
 * `time`, or the slot 12 hours after it.
 */
export function nextUnlockRunAt(time: string, now: number, timeZone?: string): number {
    const slots = unlockSlots(time, now, timeZone);
    return slots.find((slot) => slot > now) ?? slots[slots.length - 1];
}

/** Start of the most recent slot at or before `now`, in `timeZone` or server local time. */
export function lastUnlockSlotAt(time: string, now: number, timeZone?: string): number {
    const slots = unlockSlots(time, now, timeZone);
    return [...slots].reverse().find((slot) => slot <= now) ?? slots[0];
}

/** The clock time of the second daily slot, `HH:MM`: `time` plus `UNLOCK_INTERVAL_MS`. */
export function secondUnlockTime(time: string): string {
    const [hours, minutes] = parseUnlockTime(time);
    const second = (hours + UNLOCK_INTERVAL_MS / 3600000) % 24;
    return `${String(second).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Outcomes shown in the error tone: the run did not do its job, or left the phone exposed.
 * `needs-manual-unlock` is not one of them: `needsManualUnlock` in the status says whether the
 * phone still refuses connections, and that is what the panel and the card show.
 */
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
            return `Skipped: the server entered the passcode less than ${UNLOCK_SKIP_WINDOW_MS / 3600000} hours earlier`;
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
        case 'needs-manual-unlock':
            // With `UNLOCK_BY_HAND_ACTION` as the message, the two read as `UNLOCK_BY_HAND_MESSAGE`.
            return LOCKOUT_TEXT;
    }
}
