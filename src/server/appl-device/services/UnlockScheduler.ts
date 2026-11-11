import { TypedEmitter } from '../../../common/TypedEmitter';
import {
    UNLOCK_HOURLY_RETRY_MS,
    UNLOCK_MANUAL_COOLDOWN_MS,
    UNLOCK_PASSCODE_LIMIT_MS,
    UNLOCK_RETRY_MS,
    UNLOCK_SESSION_CAP,
    UNLOCK_SESSION_CAP_WINDOW_MS,
    UNLOCK_SKIP_WINDOW_MS,
    UNLOCK_UNCONFIRMED_LIMIT,
    UNLOCK_WARN_MS,
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
import { DeviceStateMonitor, DeviceStateMonitorEvents, ScreenPower } from './DeviceStateMonitor';
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
    'needs-manual-unlock',
]);
// A scheduled run that ends one of these ways without having typed the passcode is retried:
// after ten minutes, then once an hour until a run works or the next slot arrives. A run that
// typed it is never retried: whether iOS counts a repeated wrong passcode toward its lockout is
// unknown, so it is assumed to. `needs-manual-unlock` is not retried either: nothing the server
// does helps until the passcode is entered on the phone, and the next slot tries again.
const RETRIED_OUTCOMES = new Set<UnlockRunOutcome>([
    'failed-wake',
    'failed-session',
    'failed-still-locked',
    'unverified',
    'skipped-disconnected',
    'skipped-viewer',
]);
// The run had a screen session, or the phone reads unlocked: it accepts connections.
const REACHED_OUTCOMES = new Set<UnlockRunOutcome>([
    'unlocked',
    'left-unlocked',
    'already-unlocked',
    'failed-wake',
    'failed-still-locked',
    'failed-rejected',
    'unverified',
]);
const PAUSED_NOTE = 'Scheduled unlock is paused until the passcode is saved again';
const HOUR_MS = 3600 * 1000;
// While a phone refuses connections, this often the monitor opens a new observer and reads the
// screen once, to see whether the passcode has been entered on the phone.
const LOCKOUT_CHECK_MS = 5 * 60 * 1000;
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
 * Runs the unlock twice a day per iPhone and keeps `UnlockScheduleStatus` current. An iPhone
 * refuses new connections 24 hours after its passcode was last entered, so the schedule has two
 * slots a day, 12 hours apart, and a slot that could not run is tried again until the next one
 * (`tickDevice`). Skip order, serialisation of runs, logging and the failure push are in plan
 * section 3.5; docs/HANDOFF.md has the 2026-11-11 changes.
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
 * `getStatus` is `store.getSchedule(udid)` plus `running`, `waitingForLock` while a slot waits
 * for a phone in use, and, while a retry is pending, that `retryAt` as `nextRunAt`.
 *
 * Safety rules added after the 2026-11-10 review: a run that typed the passcode is never
 * retried, and one that ends still locked stops every later run until the passcode is saved
 * again (`recordPasscodeVerdict`); manual runs join, cool down and are capped (`runNow`); the
 * 24-hour limit is watched (`checkWarning`).
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
    private timer?: NodeJS.Timeout;
    private firstTick?: NodeJS.Timeout;
    private onState?: (event: DeviceStateMonitorEvents['state']) => void;
    // The last state seen per device, for the `true -> false` rule and the first screen reading
    // after one that failed.
    private readonly lastState = new Map<string, { locked: KnownBoolean; screen: ScreenPower }>();
    // Phones whose slot is waiting for them to be locked; the status says so once.
    private readonly waiting = new Set<string>();
    // Runs queued or in progress per device; `running` in the status while non-zero.
    private readonly pending = new Map<string, number>();
    // One run at a time across the process: two phones never open display sessions together.
    private chain: Promise<unknown> = Promise.resolve();
    // The run queued or in progress per device; a manual run that arrives meanwhile joins it.
    private readonly inflight = new Map<string, { run: Promise<UnlockRunResult>; keepUnlocked: boolean }>();
    // When each recent run that opened a display session ended, per device, oldest first.
    private readonly sessionRuns = new Map<string, number[]>();
    // When the last check of a phone that refuses connections started, and the checks in progress.
    private readonly lockoutChecks = new Map<string, number>();
    private readonly checkingLockout = new Set<string>();
    private storeChecked = false;
    private released = false;

    /** Public for tests; production goes through `getInstance()`. Missing deps are resolved in `start()`. */
    constructor(deps: Partial<UnlockSchedulerDeps> = {}) {
        super();
        this.deps = deps;
    }

    /**
     * Load the store, subscribe to `DeviceStateMonitor` `state` events (a `true -> false`
     * transition of `device.locked` records `lastUnlockedAt`; `unknown -> false` does not), tick
     * on every minute of the clock (unref'd) and once after 5 s. Synchronous; failures to read
     * the store are reported through `getStatus`, not thrown. A start that throws leaves no timer
     * or listener behind, so the next `start` begins from scratch.
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
            this.armTick();
            this.firstTick = setTimeout(() => {
                this.firstTick = undefined;
                this.tick();
            }, FIRST_TICK_MS);
            this.firstTick.unref();
        } catch (error) {
            this.stop();
            throw error;
        }
        this.options = options;
    }

    /**
     * The next tick, on the next whole minute of the clock. Slots are whole minutes, so a run
     * starts within about a second of its slot whatever second the process started at, and a
     * restart does not move it. A timer that fires a moment early is armed again for the rest.
     * A minute that falls in the first 5 s after start is left to the first tick: the tracker
     * has not listed the phones yet, and a run would end as `skipped-disconnected`.
     */
    private armTick(): void {
        this.timer = setTimeout(
            () => {
                this.armTick();
                if (!this.firstTick) {
                    this.tick();
                }
            },
            TICK_MS - (this.now() % TICK_MS),
        );
        this.timer.unref();
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
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
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
        this.lastState.clear();
        this.waiting.clear();
        this.lockoutChecks.clear();
        this.storeChecked = false;
    }

    public getStatus(udid: string): UnlockScheduleStatus {
        const status = this.store.getSchedule(udid);
        const { retryAt } = this.store.getRunState(udid);
        const running = (this.pending.get(udid) ?? 0) > 0;
        if (retryAt !== undefined && status.enabled && status.hasPasscode && !status.passcodeRejected) {
            if (retryAt > this.now()) {
                if (status.nextRunAt === undefined || retryAt < status.nextRunAt) {
                    status.nextRunAt = retryAt;
                }
            } else if (!running && this.monitor.getState(udid)['device.locked'] === false) {
                status.waitingForLock = true;
            }
        }
        if (running) {
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
                    new Error(
                        'Another unlock run is in progress and will lock the phone again. Try again when it ends.',
                    ),
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
        return this.enqueue(udid, trigger, options);
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

    /** Mark the slot that has already passed as used and drop what it still owed. */
    private skipPassedSlot(udid: string, status: UnlockScheduleStatus): void {
        const passed = lastUnlockSlotAt(status.time, this.now(), status.timeZone);
        const { lastSlotAt } = this.store.getRunState(udid);
        this.store.setRunState(udid, {
            lastSlotAt: Math.max(passed, lastSlotAt ?? passed),
            retryAt: undefined,
            slotAttempts: undefined,
        });
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
     * On every minute of the clock, and once after start: each phone's slot and warning are
     * checked (`tickDevice`). The first tick also pushes what the store reports as stopping
     * schedules from running.
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

    /**
     * A slot that arrives is taken up at once: `lastSlotAt` is written, and `retryAt` says its
     * run is owed from now. The run starts when it is due and the phone is not in use. A slot
     * the server was down for is taken up the same way when it is back, since the next slot may
     * come too late for the 24-hour limit. What the run's result does to `retryAt` is in
     * `settleSlot`. A new slot replaces whatever the one before still owed.
     */
    private tickDevice(udid: string, now: number): void {
        this.checkLockout(udid, now);
        const schedule = this.store.getSchedule(udid);
        if (!schedule.enabled) {
            this.waiting.delete(udid);
            return;
        }
        let state = this.store.getRunState(udid);
        const slot = lastUnlockSlotAt(schedule.time, now, schedule.timeZone);
        if ((state.lastSlotAt ?? -Infinity) < slot) {
            this.store.setRunState(udid, { lastSlotAt: slot, retryAt: slot, slotAttempts: undefined });
            state = this.store.getRunState(udid);
        }
        const due = state.retryAt !== undefined && state.retryAt <= now && (this.pending.get(udid) ?? 0) === 0;
        // Someone is using the phone: no session, no passcode and no Lock press until it reads
        // locked. The monitor has the lock state already, so reading it opens nothing. A schedule
        // without a usable passcode still gets its run, which ends as `skipped-no-passcode` or
        // `skipped-rejected` and is pushed, so it is not silent.
        const inUse =
            due &&
            schedule.hasPasscode &&
            !schedule.passcodeRejected &&
            this.monitor.getState(udid)['device.locked'] === false;
        if (inUse !== this.waiting.has(udid)) {
            if (inUse) {
                this.waiting.add(udid);
                this.emitStatus(udid);
            } else {
                this.waiting.delete(udid);
            }
        }
        if (due && !inUse) {
            // Stored before the run starts, so a write that fails starts nothing and a server
            // that keeps restarting does not open a session each time.
            this.store.setRunState(udid, { retryAt: now + UNLOCK_HOURLY_RETRY_MS });
            this.enqueue(udid, 'schedule', {}, slot).catch((error: Error) =>
                console.error(`${TAG} [${udid}] scheduled run failed: ${error.message}`),
            );
            return;
        }
        this.checkWarning(udid, schedule, state, now);
    }

    /**
     * With the schedule on: one push when the passcode was last entered 20 hours ago, with the
     * hours left before the phone stops accepting connections. The time is the server's last
     * typed unlock, which a run that works replaces, or the last unlock seen when the store has
     * nothing else. Not sent while the phone already refuses connections (that was pushed). It
     * is sent while the phone reads unlocked: a Face ID unlock does not restart the 24 hours,
     * and a phone in use holds back the run that would. iOS also restarts a phone that has not
     * been unlocked for 72 hours; the 24-hour limit comes first, so nothing here waits for that.
     */
    private checkWarning(udid: string, schedule: UnlockScheduleStatus, state: UnlockRunState, now: number): void {
        const entered = state.lastTypedUnlockAt ?? state.lastUnlockedAt;
        if (
            entered === undefined ||
            state.warnedFor === entered ||
            state.lockedOutAt !== undefined ||
            now - entered < UNLOCK_WARN_MS
        ) {
            return;
        }
        this.store.setRunState(udid, { warnedFor: entered });
        const left = Math.ceil((entered + UNLOCK_PASSCODE_LIMIT_MS - now) / HOUR_MS);
        const parts = [
            `The passcode was last entered ${Math.floor((now - entered) / HOUR_MS)} hours ago`,
            left > 0
                ? `The iPhone stops accepting connections in about ${left} ${left === 1 ? 'hour' : 'hours'} unless it is entered again`
                : 'The iPhone has probably stopped accepting connections. Enter the passcode on the phone',
        ];
        if (!schedule.hasPasscode) {
            parts.push('Scheduled unlock has no usable passcode');
        } else if (schedule.passcodeRejected) {
            parts.push(PAUSED_NOTE);
        } else if (left > 0 && this.waiting.has(udid)) {
            parts.push('Scheduled unlock runs when the phone is next locked');
        }
        this.notify({
            title: PUSH_TITLE,
            body: `${parts.join('. ')}.`,
            tag: `ios-unlock-deadline-${udid}`,
            url: '#!action=',
        });
    }

    private handleState(event: DeviceStateMonitorEvents['state']): void {
        const { udid } = event;
        const locked = event['device.locked'];
        const screen = event['screen.power'];
        const previous = this.lastState.get(udid);
        this.lastState.set(udid, { locked, screen });
        // `unknown -> false` does not count: at server start the phone may have been unlocked days ago.
        const unlocked = previous?.locked === true && locked === false;
        if (unlocked) {
            this.recordUnlockedAt(udid, this.now());
        }
        // The owner unlocked the phone, or a screen read worked after one that failed. The screen
        // is read over a new connection each time, so the phone accepts connections again.
        const reached = locked === false || (screen !== 'unknown' && (previous?.screen ?? 'unknown') === 'unknown');
        if ((reached && this.clearLockout(udid)) || unlocked) {
            this.emitStatus(udid);
        }
    }

    /**
     * Persist `lastUnlockedAt`, and `lastTypedUnlockAt` when the server typed the passcode for
     * it. A failed write is logged, not thrown: it is called from the monitor's emit and from
     * the end of a run that did unlock the phone.
     */
    private recordUnlockedAt(udid: string, at: number, typed = false): void {
        try {
            this.store.recordUnlockedAt(udid, at);
            if (typed) {
                this.store.setRunState(udid, { lastTypedUnlockAt: at });
            }
        } catch (error) {
            console.error(`${TAG} [${udid}] could not record the unlock: ${(error as Error).message}`);
        }
    }

    /**
     * The phone accepts connections again: drop `lockedOutAt`. The 20-hour warning for the same
     * passcode entry is marked as sent, since the lockout push said more. Returns whether the
     * phone was marked. Called from the monitor's emit, so a failed write is logged.
     */
    private clearLockout(udid: string): boolean {
        try {
            const state = this.store.getRunState(udid);
            if (state.lockedOutAt === undefined) {
                return false;
            }
            this.store.setRunState(udid, {
                lockedOutAt: undefined,
                warnedFor: state.lastTypedUnlockAt ?? state.lastUnlockedAt,
            });
            return true;
        } catch (error) {
            console.error(`${TAG} [${udid}] could not clear the lockout: ${(error as Error).message}`);
            return false;
        }
    }

    /**
     * While the phone refuses connections, every 5 minutes: the monitor drops and reopens its
     * observer and reads the screen over a new connection (`DeviceStateMonitor.reconnect`). An
     * answer means the passcode has been entered on the phone, and the state is cleared without
     * waiting for the observer that was open before the refusal. Opens no display session, and
     * does nothing while a run for the phone is queued or in progress.
     */
    private checkLockout(udid: string, now: number): void {
        const { lockedOutAt } = this.store.getRunState(udid);
        if (lockedOutAt === undefined) {
            this.lockoutChecks.delete(udid);
            return;
        }
        const since = Math.max(lockedOutAt, this.lockoutChecks.get(udid) ?? -Infinity);
        if (
            now - since < LOCKOUT_CHECK_MS ||
            this.checkingLockout.has(udid) ||
            (this.pending.get(udid) ?? 0) > 0 ||
            !this.monitor.isWatching(udid)
        ) {
            return;
        }
        this.lockoutChecks.set(udid, now);
        this.checkingLockout.add(udid);
        this.monitor
            .reconnect(udid)
            .then((answered) => {
                if (answered && !this.released && this.clearLockout(udid)) {
                    console.log(`${TAG} [${udid}] the phone accepts connections again`);
                    this.emitStatus(udid);
                }
            })
            .catch((error: Error) => console.error(`${TAG} [${udid}] connection check failed: ${error.message}`))
            .finally(() => this.checkingLockout.delete(udid));
    }

    // ------------------------------------------------------------------ runs

    /** `slotAt` is the slot a timer run is for; the skip rule is measured from it. */
    private enqueue(
        udid: string,
        trigger: UnlockRunTrigger,
        options: UnlockRunOptions = {},
        slotAt?: number,
    ): Promise<UnlockRunResult> {
        this.pending.set(udid, (this.pending.get(udid) ?? 0) + 1);
        this.emitStatus(udid);
        const run = this.chain.then(() => this.execute(udid, trigger, options, slotAt));
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
        options: UnlockRunOptions,
        slotAt?: number,
    ): Promise<UnlockRunResult> {
        const at = this.now();
        const started = Date.now();
        let result: UnlockRunResult;
        // The last digit was sent, and the run started a serve-web (or tried to).
        let typed = false;
        let openedSession: boolean;
        try {
            const performed = await this.perform(udid, trigger, at, options, slotAt ?? at);
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
        // An hourly retry that fails the way the run before it did is not pushed again.
        let repeated = false;
        try {
            const before = this.store.getRunState(udid);
            const last = this.store.getSchedule(udid).lastRun;
            repeated =
                trigger === 'schedule' &&
                (before.slotAttempts ?? 0) > 0 &&
                last?.trigger === 'schedule' &&
                last.outcome === result.outcome &&
                last.message === result.message;
            let paused = false;
            if (result.outcome === 'needs-manual-unlock') {
                // Says nothing about the stored passcode: none was typed. The 20-hour warning
                // for this passcode entry has nothing to add to the push below.
                this.store.setRunState(udid, {
                    lockedOutAt: at,
                    warnedFor: before.lastTypedUnlockAt ?? before.lastUnlockedAt,
                });
            } else {
                if (REACHED_OUTCOMES.has(result.outcome)) {
                    this.clearLockout(udid);
                }
                paused = this.recordPasscodeVerdict(udid, result.outcome, typed);
                if (paused) {
                    result.message = result.message ? `${result.message}. ${PAUSED_NOTE}` : PAUSED_NOTE;
                }
            }
            this.store.recordRun(udid, result);
            if (trigger === 'schedule') {
                this.settleSlot(udid, result.outcome, !typed && !paused, openedSession);
            }
        } catch (error) {
            // The run itself is over; the panel must not stay on "running" because a write failed.
            console.error(`${TAG} [${udid}] could not record the run: ${(error as Error).message}`);
        }
        // A phone left unlocked is reported whoever started the run.
        if (
            (trigger === 'schedule' && PUSHED_OUTCOMES.has(result.outcome) && !repeated) ||
            result.outcome === 'left-unlocked'
        ) {
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
     * What a timer run's result means for its slot. `retryAt` set: the slot still owes a run,
     * not before that time. Removed: the slot is done.
     * - The phone was in use (`already-unlocked`): owed until it reads locked. If a session was
     *   opened to find that out, not before the usual retry time.
     * - A failure that typed nothing and did not pause the schedule (`retriable`): owed, after
     *   ten minutes the first time and an hour each time after. The next slot ends it.
     * - Anything else is final: the run worked, was skipped for good reason, typed the passcode
     *   (never retried), or the phone refuses connections until its passcode is entered.
     */
    private settleSlot(udid: string, outcome: UnlockRunOutcome, retriable: boolean, openedSession: boolean): void {
        const now = this.now();
        if (outcome === 'already-unlocked') {
            this.store.setRunState(udid, { retryAt: openedSession ? now + UNLOCK_RETRY_MS : now });
        } else if (retriable && RETRIED_OUTCOMES.has(outcome)) {
            const attempts = (this.store.getRunState(udid).slotAttempts ?? 0) + 1;
            this.store.setRunState(udid, {
                slotAttempts: attempts,
                retryAt: now + (attempts === 1 ? UNLOCK_RETRY_MS : UNLOCK_HOURLY_RETRY_MS),
            });
        } else {
            this.store.setRunState(udid, { retryAt: undefined, slotAttempts: undefined });
        }
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
        slotAt: number,
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
        // Only an unlock the server typed counts, and it is measured from the slot: 24 hours,
        // less the 12 to the next slot, less an hour of margin. An unlock that was only observed
        // may have been Face ID, and only a passcode entry is known to restart the 24 hours.
        const { lastTypedUnlockAt } = this.store.getRunState(udid);
        if (
            trigger === 'schedule' &&
            lastTypedUnlockAt !== undefined &&
            slotAt - lastTypedUnlockAt < UNLOCK_SKIP_WINDOW_MS
        ) {
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
            // `unlocked` is only reported after the digits. A phone left unlocked may have been
            // unlocked by someone else while the run could not read the passcode.
            const byServer = outcome.outcome === 'unlocked' || (outcome.outcome === 'left-unlocked' && !!outcome.typed);
            this.recordUnlockedAt(udid, outcome.verifiedAt ?? this.now(), byServer);
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
