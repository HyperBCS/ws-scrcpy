import { TypedEmitter } from '../../../common/TypedEmitter';
import {
    UNLOCK_DEADLINE_MS,
    UNLOCK_DEADLINE_URGENT_MS,
    UNLOCK_DEADLINE_WARN_MS,
    UNLOCK_MANUAL_COOLDOWN_MS,
    UNLOCK_RECENT_MS,
    UNLOCK_RETRY_MS,
    UNLOCK_SESSION_CAP,
    UNLOCK_SESSION_CAP_WINDOW_MS,
    UNLOCK_SLOT_WINDOW_MS,
    UNLOCK_UNCONFIRMED_LIMIT,
    UNLOCK_URGENT_INTERVAL_MS,
    UnlockRunOptions,
    UnlockRunOutcome,
    UnlockRunResult,
    UnlockRunTrigger,
    UnlockSchedulePatch,
    UnlockScheduleStatus,
    lastUnlockSlotAt,
    unlockOutcomeText,
} from '../../../common/IosUnlockSchedule';
import { KnownBoolean } from '../../../types/AndroidLockState';
import { IosSettingsStore, UnlockRunState, UnlockSettingsStore } from './IosSettingsStore';
import { UnlockDriver } from './UnlockDriver';
import { DeviceStateMonitor, DeviceStateMonitorEvents } from './DeviceStateMonitor';
import { NotificationService, SystemPushPayload } from '../../notifications/NotificationService';

const TAG = '[UnlockScheduler]';

const TICK_MS = 60000;
const FIRST_TICK_MS = 5000;
// A scheduled run that ends one of these ways is pushed to every subscription.
const PUSHED_OUTCOMES = new Set<UnlockRunOutcome>([
    'failed-wake',
    'failed-session',
    'failed-still-locked',
    'failed-rejected',
    'unverified',
    'left-unlocked',
    'skipped-disconnected',
    'skipped-no-passcode',
    'skipped-rejected',
]);
// A scheduled run that ends one of these ways without having typed the passcode is retried
// once that night. A run that typed it is never retried: whether iOS counts a repeated wrong
// passcode toward its lockout is unknown, so it is assumed to.
const RETRIED_OUTCOMES = new Set<UnlockRunOutcome>([
    'failed-wake',
    'failed-session',
    'failed-still-locked',
    'unverified',
    'skipped-disconnected',
    'skipped-viewer',
]);
const PAUSED_NOTE = 'Scheduled unlock is paused until the passcode is saved again';
const HOUR_MS = 3600 * 1000;
// The recent-unlock skip is a day minus the slot window, 22 hours, and the panel says so:
// yesterday's own scheduled unlock happened a few seconds after its slot, which is 23 h 59 m
// before today's tick, and a literal 24 h check would skip every other night. An unlock more
// than two hours after yesterday's slot is the user's own and does count.
const RECENT_WINDOW_MS = UNLOCK_RECENT_MS - UNLOCK_SLOT_WINDOW_MS;
const DISCONNECTED_MESSAGE = 'Not connected over USB. If the phone restarted, unlock it once on the phone.';
const PUSH_TITLE = 'iPhone unlock';

export interface UnlockSchedulerEvents {
    /** After every change to a device's status: a command, a run starting or ending, a lock transition. */
    status: { udid: string; status: UnlockScheduleStatus };
}

export interface UnlockSchedulerStartOptions {
    /**
     * `ControlCenter` answers from its descriptors (`state === DeviceState.CONNECTED`). A run on
     * a device that is not connected ends as `skipped-disconnected` without opening a session.
     */
    isConnected: (udid: string) => boolean;
}

/** Test seams. `getInstance()` uses the production singletons. */
export interface UnlockSchedulerDeps {
    store: UnlockSettingsStore;
    driver: UnlockDriver;
    monitor: DeviceStateMonitor;
    notify: (payload: SystemPushPayload) => void;
    now: () => number;
}

/**
 * Runs the daily unlock per iPhone and keeps `UnlockScheduleStatus` current. Timer, slot and
 * retry rules, skip order, serialisation of runs, logging and the failure push are in plan
 * section 3.5; the cases table in 3.8.
 *
 * Responsibility split with `ControlCenter` (W1):
 * - `ControlCenter.init()` calls `UnlockScheduler.getInstance().start({ isConnected })` after
 *   its own monitor listeners are registered, inside a try/catch that logs and continues, and
 *   keeps the instance in a private field only when `start` succeeded. Device tracking must
 *   never depend on the scheduler.
 * - `ControlCenter` subscribes to `status` and copies `event.status` into
 *   `descriptor.unlockSchedule`, then emits `device`. `refreshDetails` seeds it from
 *   `getStatus(udid)`.
 * - The four commands map 1:1 onto `updateSchedule`, `setPasscode`, `clearPasscode` and
 *   `runNow(udid, 'manual')`; `ControlCenter` replies `JSON.stringify(<return value>)` and does
 *   no other work. It never imports `IosSettingsStore`.
 * - `ControlCenter.release()` calls `release()` here before `DeviceStateMonitor.release()`.
 *
 * This class owns the only reference to the store (`IosSettingsStore.getInstance()` by default)
 * and calls `store.load()` from `start()`. It emits `status` itself after each of its mutating
 * methods and after each run, so a command reply and the descriptor broadcast always agree.
 * `getStatus` is `store.getSchedule(udid)` plus `running` and, while a retry is pending, that
 * `retryAt` as `nextRunAt`.
 *
 * Safety rules added after the 2026-11-10 review: a run that typed the passcode is never
 * retried, and one that ends still locked stops every later run until the passcode is saved
 * again (`recordPasscodeVerdict`); manual runs join, cool down and are capped (`runNow`); the
 * 72-hour deadline is watched (`checkDeadline`).
 */
export class UnlockScheduler extends TypedEmitter<UnlockSchedulerEvents> {
    private static instance?: UnlockScheduler;

    public static getInstance(): UnlockScheduler {
        if (!this.instance) {
            this.instance = new UnlockScheduler();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!UnlockScheduler.instance;
    }

    protected readonly deps: Partial<UnlockSchedulerDeps>;
    private options?: UnlockSchedulerStartOptions;
    private interval?: NodeJS.Timeout;
    private firstTick?: NodeJS.Timeout;
    private onState?: (event: DeviceStateMonitorEvents['state']) => void;
    // The last `device.locked` seen per device, for the `true -> false` rule.
    private readonly lastLocked = new Map<string, KnownBoolean>();
    // Runs queued or in progress per device; `running` in the status while non-zero.
    private readonly pending = new Map<string, number>();
    // One run at a time across the process: two phones never open display sessions together.
    private chain: Promise<unknown> = Promise.resolve();
    // The run queued or in progress per device; a manual run that arrives meanwhile joins it.
    private readonly inflight = new Map<string, { run: Promise<UnlockRunResult>; keepUnlocked: boolean }>();
    // When each recent run that opened a display session ended, per device, oldest first.
    private readonly sessionRuns = new Map<string, number[]>();
    private storeChecked = false;
    private released = false;

    /** Public for tests; production goes through `getInstance()`. Missing deps are resolved in `start()`. */
    constructor(deps: Partial<UnlockSchedulerDeps> = {}) {
        super();
        this.deps = deps;
    }

    /**
     * Load the store, subscribe to `DeviceStateMonitor` `state` events (a `true -> false`
     * transition of `device.locked` records `lastUnlockedAt`; `unknown -> false` does not), start
     * an unref'd 60 s interval and run `tick()` once after 5 s. Synchronous; failures to read the
     * store are reported through `getStatus`, not thrown. A start that throws leaves no timer or
     * listener behind, so the next `start` begins from scratch.
     */
    public start(options: UnlockSchedulerStartOptions): void {
        if (this.options) {
            return;
        }
        this.released = false;
        try {
            this.store.load();
            this.onState = (event) => this.handleState(event);
            this.monitor.on('state', this.onState);
            this.interval = setInterval(() => this.tick(), TICK_MS);
            this.interval.unref();
            this.firstTick = setTimeout(() => this.tick(), FIRST_TICK_MS);
            this.firstTick.unref();
        } catch (error) {
            this.stop();
            throw error;
        }
        this.options = options;
    }

    /** Stop timers and listeners, release the store, drop the singleton. A run in progress finishes on its own. */
    public release(): void {
        this.released = true;
        this.stop();
        this.deps.store?.release();
        if (UnlockScheduler.instance === this) {
            UnlockScheduler.instance = undefined;
        }
    }

    private stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
        if (this.firstTick) {
            clearTimeout(this.firstTick);
            this.firstTick = undefined;
        }
        if (this.onState) {
            this.monitor.off('state', this.onState);
            this.onState = undefined;
        }
        this.options = undefined;
        this.lastLocked.clear();
        this.storeChecked = false;
    }

    public getStatus(udid: string): UnlockScheduleStatus {
        const status = this.store.getSchedule(udid);
        const { retryAt } = this.store.getRunState(udid);
        if (
            retryAt !== undefined &&
            status.enabled &&
            status.hasPasscode &&
            !status.passcodeRejected &&
            (status.nextRunAt === undefined || retryAt < status.nextRunAt)
        ) {
            status.nextRunAt = retryAt;
        }
        if ((this.pending.get(udid) ?? 0) > 0) {
            status.running = true;
        }
        return status;
    }

    /**
     * `UPDATE_UNLOCK_SCHEDULE`. The patch is already validated by `ControlCenterCommand`. When
     * the schedule is turned on or its time or zone changes, the slot that has already passed is
     * marked used and a pending retry is dropped, so the first run is the next slot shown as
     * "Next run" and nothing starts within a minute of the change.
     */
    public updateSchedule(udid: string, patch: UnlockSchedulePatch): UnlockScheduleStatus {
        const before = this.store.getSchedule(udid);
        const after = this.store.updateSchedule(udid, patch);
        if ((after.enabled && !before.enabled) || after.time !== before.time || after.timeZone !== before.timeZone) {
            this.skipPassedSlot(udid, after);
        }
        return this.emitStatus(udid);
    }

    /** `SET_UNLOCK_PASSCODE`. Already validated; must not be logged, kept or echoed. */
    public setPasscode(udid: string, passcode: string): UnlockScheduleStatus {
        const status = this.store.setPasscode(udid, passcode);
        this.skipPassedSlot(udid, status);
        return this.emitStatus(udid);
    }

    /** `CLEAR_UNLOCK_PASSCODE`. */
    public clearPasscode(udid: string): UnlockScheduleStatus {
        this.store.clearPasscode(udid);
        return this.emitStatus(udid);
    }

    /**
     * The only way a run starts, for the schedule and for `RUN_UNLOCK_NOW`. One run at a time
     * across the process; a second call waits. Resolves when the run has ended, with the result
     * that was also recorded and broadcast. Manual runs ignore `skipped-disabled` and
     * `skipped-recent` and never schedule a retry.
     *
     * A manual run that arrives while a run for the same phone is queued or in progress resolves
     * with that run's result instead of starting another; a `keepUnlocked` run is refused instead
     * when that run will press Lock afterwards. A manual run too soon after a run that opened a
     * display session is refused: the promise rejects with a message that says when it can run.
     * Bursts of short display sessions wedge the phone's display service.
     */
    public runNow(udid: string, trigger: UnlockRunTrigger, options: UnlockRunOptions = {}): Promise<UnlockRunResult> {
        if (trigger === 'manual') {
            const current = this.inflight.get(udid);
            if (current && options.keepUnlocked && !current.keepUnlocked) {
                // Its "unlocked" would be reported to a viewer who then finds the phone locked.
                return Promise.reject(
                    new Error('Another unlock run is in progress and will lock the phone again. Try again when it ends.'),
                );
            }
            if (current) {
                return current.run;
            }
            const waitMs = this.manualWaitMs(udid);
            if (waitMs > 0) {
                const seconds = Math.ceil(waitMs / 1000);
                return Promise.reject(
                    new Error(`A screen session was opened for this phone a moment ago. Try again in ${seconds} s.`),
                );
            }
        }
        return this.enqueue(udid, trigger, false, options);
    }

    /** How long a manual run has to wait: the cooldown after the last session-opening run, and the cap. */
    private manualWaitMs(udid: string): number {
        const now = this.now();
        const runs = (this.sessionRuns.get(udid) ?? []).filter((at) => now - at < UNLOCK_SESSION_CAP_WINDOW_MS);
        this.sessionRuns.set(udid, runs);
        if (!runs.length) {
            return 0;
        }
        let waitMs = runs[runs.length - 1] + UNLOCK_MANUAL_COOLDOWN_MS - now;
        if (runs.length >= UNLOCK_SESSION_CAP) {
            waitMs = Math.max(waitMs, runs[runs.length - UNLOCK_SESSION_CAP] + UNLOCK_SESSION_CAP_WINDOW_MS - now);
        }
        return Math.max(0, waitMs);
    }

    /** Mark the slot that has already passed as used and drop a pending retry. */
    private skipPassedSlot(udid: string, status: UnlockScheduleStatus): void {
        const passed = lastUnlockSlotAt(status.time, this.now(), status.timeZone);
        const { lastSlotAt, retryAt } = this.store.getRunState(udid);
        if ((lastSlotAt ?? -Infinity) < passed) {
            this.store.setLastSlotAt(udid, passed);
        }
        if (retryAt !== undefined) {
            this.store.setRetryAt(udid, undefined);
        }
    }

    // ------------------------------------------------------------------ dependencies

    private get store(): UnlockSettingsStore {
        return this.deps.store ?? (this.deps.store = IosSettingsStore.getInstance());
    }

    private get driver(): UnlockDriver {
        return this.deps.driver ?? (this.deps.driver = new UnlockDriver());
    }

    private get monitor(): DeviceStateMonitor {
        return this.deps.monitor ?? (this.deps.monitor = DeviceStateMonitor.getInstance());
    }

    private notify(payload: SystemPushPayload): void {
        try {
            if (this.deps.notify) {
                this.deps.notify(payload);
            } else {
                NotificationService.getInstance().notifySystem(payload);
            }
        } catch (error) {
            console.error(`${TAG} push failed: ${(error as Error).message}`);
        }
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    // ------------------------------------------------------------------ timer and lock events

    /**
     * Once a minute: a pending retry runs when due; otherwise today's slot runs if it has
     * passed, is less than two hours old and has not been used. `lastSlotAt` is set before the
     * run starts so a crash cannot loop. A retry older than the slot window is dropped the same
     * way a missed slot is, so a server that was down does not unlock the phone in the morning.
     * The exception is the 72-hour deadline (`checkDeadline`). The first tick also pushes what
     * the store reports as stopping schedules from running.
     * Runs from a timer, so a store that cannot be written is logged here and never thrown.
     */
    private tick(): void {
        if (this.released) {
            return;
        }
        const now = this.now();
        if (!this.storeChecked) {
            this.storeChecked = true;
            try {
                for (const problem of this.store.getProblems()) {
                    console.error(`${TAG} ${problem}`);
                    this.notify({ title: PUSH_TITLE, body: problem, tag: 'ios-unlock-store', url: '#!action=' });
                }
            } catch (error) {
                console.error(`${TAG} store check failed: ${(error as Error).message}`);
            }
        }
        for (const udid of this.store.listUdids()) {
            try {
                this.tickDevice(udid, now);
            } catch (error) {
                console.error(`${TAG} [${udid}] schedule check failed: ${(error as Error).message}`);
            }
        }
    }

    private tickDevice(udid: string, now: number): void {
        const schedule = this.store.getSchedule(udid);
        if (!schedule.enabled) {
            return;
        }
        // A schedule that is on without a usable passcode still gets its slot: the run ends as
        // `skipped-no-passcode` or `skipped-rejected` and is pushed, so it is not silent.
        const state = this.store.getRunState(udid);
        if (state.retryAt !== undefined) {
            if (state.retryAt > now) {
                return;
            }
            this.store.setRetryAt(udid, undefined);
            if (now - state.retryAt < UNLOCK_SLOT_WINDOW_MS) {
                this.schedule(udid, true, now);
            } else {
                this.emitStatus(udid);
            }
            return;
        }
        const slotStart = lastUnlockSlotAt(schedule.time, now, schedule.timeZone);
        if (now - slotStart < UNLOCK_SLOT_WINDOW_MS && (state.lastSlotAt ?? -Infinity) < slotStart) {
            this.store.setLastSlotAt(udid, slotStart);
            this.schedule(udid, false, now);
            return;
        }
        this.checkDeadline(udid, schedule, state, now);
    }

    /**
     * iOS restarts a phone that has not been unlocked for 72 hours, and after that it cannot be
     * unlocked remotely. With the schedule on: one push when the last unlock is 36 hours old,
     * with the hours left; past 48 hours, a run outside the slot window, at most every two hours
     * and only while a run can do something (passcode usable, phone connected, deadline not yet
     * passed). A phone that reads unlocked right now is not at risk.
     */
    private checkDeadline(udid: string, schedule: UnlockScheduleStatus, state: UnlockRunState, now: number): void {
        const last = state.lastUnlockedAt;
        if (last === undefined || this.monitor.getState(udid)['device.locked'] === false) {
            return;
        }
        const age = now - last;
        const usable = schedule.hasPasscode && !schedule.passcodeRejected;
        if (age >= UNLOCK_DEADLINE_WARN_MS && state.deadlineWarnedFor !== last) {
            this.store.setRunState(udid, { deadlineWarnedFor: last });
            const left = Math.ceil((last + UNLOCK_DEADLINE_MS - now) / HOUR_MS);
            const parts = [
                `Not unlocked for ${Math.floor(age / HOUR_MS)} hours`,
                left > 0
                    ? `iOS restarts the phone in about ${left} hours unless it is unlocked`
                    : 'iOS has probably restarted it; unlock it once on the phone',
            ];
            if (!schedule.hasPasscode) {
                parts.push('Scheduled unlock has no usable passcode');
            } else if (schedule.passcodeRejected) {
                parts.push(PAUSED_NOTE);
            }
            this.notify({
                title: PUSH_TITLE,
                body: `${parts.join('. ')}.`,
                tag: `ios-unlock-deadline-${udid}`,
                url: '#!action=',
            });
        }
        if (
            usable &&
            age >= UNLOCK_DEADLINE_URGENT_MS &&
            age < UNLOCK_DEADLINE_MS &&
            (this.pending.get(udid) ?? 0) === 0 &&
            now - (state.lastTimerRunAt ?? -Infinity) >= UNLOCK_URGENT_INTERVAL_MS &&
            this.options?.isConnected(udid)
        ) {
            // Its own spacing replaces the ten-minute retry.
            this.schedule(udid, true, now);
        }
    }

    /** Start a timer run. The time is stored first, like `lastSlotAt`: a write that fails starts nothing. */
    private schedule(udid: string, retry: boolean, now: number): void {
        this.store.setRunState(udid, { lastTimerRunAt: now });
        this.enqueue(udid, 'schedule', retry).catch((error: Error) =>
            console.error(`${TAG} [${udid}] scheduled run failed: ${error.message}`),
        );
    }

    private handleState(event: DeviceStateMonitorEvents['state']): void {
        const locked = event['device.locked'];
        const previous = this.lastLocked.get(event.udid) ?? 'unknown';
        this.lastLocked.set(event.udid, locked);
        // `unknown -> false` does not count: at server start the phone may have been unlocked days ago.
        if (previous === true && locked === false) {
            this.recordUnlockedAt(event.udid, this.now());
            this.emitStatus(event.udid);
        }
    }

    /**
     * Persist `lastUnlockedAt`. A failed write is logged, not thrown: it is called from the
     * monitor's emit and from the end of a run that did unlock the phone.
     */
    private recordUnlockedAt(udid: string, at: number): void {
        try {
            this.store.recordUnlockedAt(udid, at);
        } catch (error) {
            console.error(`${TAG} [${udid}] could not record the unlock: ${(error as Error).message}`);
        }
    }

    // ------------------------------------------------------------------ runs

    private enqueue(
        udid: string,
        trigger: UnlockRunTrigger,
        retry: boolean,
        options: UnlockRunOptions = {},
    ): Promise<UnlockRunResult> {
        this.pending.set(udid, (this.pending.get(udid) ?? 0) + 1);
        this.emitStatus(udid);
        const run = this.chain.then(() => this.execute(udid, trigger, retry, options));
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        this.inflight.set(udid, { run, keepUnlocked: !!options.keepUnlocked });
        const done = () => {
            if (this.inflight.get(udid)?.run === run) {
                this.inflight.delete(udid);
            }
        };
        run.then(done, done);
        return run;
    }

    private async execute(
        udid: string,
        trigger: UnlockRunTrigger,
        retry: boolean,
        options: UnlockRunOptions,
    ): Promise<UnlockRunResult> {
        const at = this.now();
        const started = Date.now();
        let result: UnlockRunResult;
        // Every digit was sent, and the run started a serve-web (or tried to).
        let typed = false;
        let openedSession: boolean;
        try {
            const performed = await this.perform(udid, trigger, at, options);
            result = performed.result;
            typed = performed.typed;
            openedSession = performed.openedSession;
        } catch (error) {
            // The driver rejects only on programming errors; the run still ends with a result so
            // the panel never stays on "running".
            console.error(`${TAG} [${udid}] ${trigger} run threw: ${(error as Error).message}`);
            result = { at, trigger, outcome: 'failed-session', message: (error as Error).message };
            openedSession = true;
        }
        if (openedSession) {
            const runs = this.sessionRuns.get(udid) ?? [];
            runs.push(this.now());
            this.sessionRuns.set(udid, runs.slice(-UNLOCK_SESSION_CAP));
        }
        try {
            const paused = this.recordPasscodeVerdict(udid, result.outcome, typed);
            if (paused) {
                result.message = result.message ? `${result.message}. ${PAUSED_NOTE}` : PAUSED_NOTE;
            }
            this.store.recordRun(udid, result);
            if (trigger === 'schedule' && RETRIED_OUTCOMES.has(result.outcome) && !retry && !typed && !paused) {
                this.store.setRetryAt(udid, this.now() + UNLOCK_RETRY_MS);
            }
        } catch (error) {
            // The run itself is over; the panel must not stay on "running" because a write failed.
            console.error(`${TAG} [${udid}] could not record the run: ${(error as Error).message}`);
        }
        // A phone left unlocked is reported whoever started the run.
        if ((trigger === 'schedule' && PUSHED_OUTCOMES.has(result.outcome)) || result.outcome === 'left-unlocked') {
            this.notify({
                title: PUSH_TITLE,
                body: result.message
                    ? `${unlockOutcomeText(result.outcome)}. ${result.message}`
                    : unlockOutcomeText(result.outcome),
                tag: `ios-unlock-${udid}`,
                url: '#!action=',
            });
        }
        const detail = result.message ? ` (${result.message})` : '';
        console.log(`${TAG} [${udid}] ${trigger} ${result.outcome}${detail} in ${Date.now() - started} ms`);
        this.pending.set(udid, Math.max(0, (this.pending.get(udid) ?? 1) - 1));
        this.emitStatus(udid);
        return result;
    }

    /**
     * What the run says about the stored passcode. Typed and still locked: rejected, and no run
     * types it again until it is saved again. Typed without a confirmed unlock: counted, and the
     * second in a row is treated the same way. A confirmed unlock clears the count. Returns
     * whether this run paused the schedule.
     */
    private recordPasscodeVerdict(udid: string, outcome: UnlockRunOutcome, typed: boolean): boolean {
        const state = this.store.getRunState(udid);
        if (outcome === 'unlocked' || outcome === 'left-unlocked') {
            if (state.unconfirmedAttempts !== undefined) {
                this.store.setRunState(udid, { unconfirmedAttempts: undefined });
            }
            return false;
        }
        if (!typed) {
            return false;
        }
        const attempts = (state.unconfirmedAttempts ?? 0) + 1;
        const rejected = outcome === 'failed-rejected' || attempts >= UNLOCK_UNCONFIRMED_LIMIT;
        this.store.setRunState(udid, {
            unconfirmedAttempts: attempts,
            ...(rejected ? { passcodeRejectedAt: this.now(), retryAt: undefined } : {}),
        });
        return rejected;
    }

    /** The skip rules in order, then the driver. */
    private async perform(
        udid: string,
        trigger: UnlockRunTrigger,
        at: number,
        runOptions: UnlockRunOptions,
    ): Promise<{ result: UnlockRunResult; typed: boolean; openedSession: boolean }> {
        const options = this.options;
        if (!options) {
            throw new Error('Scheduler not started');
        }
        const skip = (outcome: UnlockRunOutcome, message?: string) => ({
            result: { at, trigger, outcome, message },
            typed: false,
            openedSession: false,
        });
        const schedule = this.store.getSchedule(udid);
        if (trigger === 'schedule' && !schedule.enabled) {
            return skip('skipped-disabled');
        }
        if (!schedule.hasPasscode) {
            // The store explains a passcode it holds but cannot decrypt in the status it returns.
            const reason = schedule.lastRun?.outcome === 'skipped-no-passcode' ? schedule.lastRun.message : undefined;
            return skip('skipped-no-passcode', reason);
        }
        if (schedule.passcodeRejected) {
            return skip('skipped-rejected', 'Save the passcode again in Settings');
        }
        if (!options.isConnected(udid)) {
            return skip('skipped-disconnected', DISCONNECTED_MESSAGE);
        }
        const { lastUnlockedAt } = this.store.getRunState(udid);
        if (trigger === 'schedule' && lastUnlockedAt !== undefined && at - lastUnlockedAt < RECENT_WINDOW_MS) {
            return skip('skipped-recent');
        }
        if (this.monitor.getState(udid)['device.locked'] === false) {
            this.recordUnlockedAt(udid, at);
            return skip('already-unlocked');
        }
        // The passcode is decrypted inside the thunk only, by the driver, right before typing.
        const outcome = await this.driver.run(udid, () => this.store.readPasscode(udid), {
            keepUnlocked: !!runOptions.keepUnlocked,
        });
        if (
            outcome.outcome === 'unlocked' ||
            outcome.outcome === 'left-unlocked' ||
            outcome.outcome === 'already-unlocked'
        ) {
            this.recordUnlockedAt(udid, outcome.verifiedAt ?? this.now());
        }
        return {
            result: { at, trigger, outcome: outcome.outcome, message: outcome.message },
            typed: !!outcome.typed,
            // A driver that does not say is taken to have opened one.
            openedSession: outcome.openedSession !== false,
        };
    }

    private emitStatus(udid: string): UnlockScheduleStatus {
        const status = this.getStatus(udid);
        this.emit('status', { udid, status });
        return status;
    }
}
