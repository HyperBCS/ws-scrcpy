import { TypedEmitter } from '../../../common/TypedEmitter';
import {
    UNLOCK_RECENT_MS,
    UNLOCK_RETRY_MS,
    UNLOCK_SLOT_WINDOW_MS,
    UnlockRunOutcome,
    UnlockRunResult,
    UnlockRunTrigger,
    UnlockSchedulePatch,
    UnlockScheduleStatus,
    lastUnlockSlotAt,
    unlockOutcomeText,
} from '../../../common/IosUnlockSchedule';
import { KnownBoolean } from '../../../types/AndroidLockState';
import { IosSettingsStore, UnlockSettingsStore } from './IosSettingsStore';
import { UnlockDriver } from './UnlockDriver';
import { DeviceStateMonitor, DeviceStateMonitorEvents } from './DeviceStateMonitor';
import { NotificationService, SystemPushPayload } from '../../notifications/NotificationService';

const TAG = '[UnlockScheduler]';

const TICK_MS = 60000;
const FIRST_TICK_MS = 5000;
// A scheduled run that ends one of these ways is pushed to every subscription and, the first
// time that night, retried once.
const REPORTED_OUTCOMES = new Set<UnlockRunOutcome>([
    'failed-wake',
    'failed-session',
    'failed-still-locked',
    'unverified',
    'skipped-disconnected',
]);
// "Unlocked in the last 24 hours" is measured from the slot, with the slot window taken off:
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
     * store are reported through `getStatus`, not thrown.
     */
    public start(options: UnlockSchedulerStartOptions): void {
        if (this.options) {
            return;
        }
        this.options = options;
        this.released = false;
        this.store.load();
        this.onState = (event) => this.handleState(event);
        this.monitor.on('state', this.onState);
        this.interval = setInterval(() => this.tick(), TICK_MS);
        this.interval.unref();
        this.firstTick = setTimeout(() => this.tick(), FIRST_TICK_MS);
        this.firstTick.unref();
    }

    /** Stop timers and listeners, release the store, drop the singleton. A run in progress finishes on its own. */
    public release(): void {
        this.released = true;
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
        this.deps.store?.release();
        if (UnlockScheduler.instance === this) {
            UnlockScheduler.instance = undefined;
        }
    }

    public getStatus(udid: string): UnlockScheduleStatus {
        const status = this.store.getSchedule(udid);
        const { retryAt } = this.store.getRunState(udid);
        if (
            retryAt !== undefined &&
            status.enabled &&
            status.hasPasscode &&
            (status.nextRunAt === undefined || retryAt < status.nextRunAt)
        ) {
            status.nextRunAt = retryAt;
        }
        if ((this.pending.get(udid) ?? 0) > 0) {
            status.running = true;
        }
        return status;
    }

    /** `UPDATE_UNLOCK_SCHEDULE`. The patch is already validated by `ControlCenterCommand`. */
    public updateSchedule(udid: string, patch: UnlockSchedulePatch): UnlockScheduleStatus {
        this.store.updateSchedule(udid, patch);
        return this.emitStatus(udid);
    }

    /** `SET_UNLOCK_PASSCODE`. Already validated; must not be logged, kept or echoed. */
    public setPasscode(udid: string, passcode: string): UnlockScheduleStatus {
        this.store.setPasscode(udid, passcode);
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
     */
    public runNow(udid: string, trigger: UnlockRunTrigger): Promise<UnlockRunResult> {
        return this.enqueue(udid, trigger, false);
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
     */
    private tick(): void {
        if (this.released) {
            return;
        }
        const now = this.now();
        for (const udid of this.store.listUdids()) {
            const schedule = this.store.getSchedule(udid);
            if (!schedule.enabled || !schedule.hasPasscode) {
                continue;
            }
            const state = this.store.getRunState(udid);
            if (state.retryAt !== undefined) {
                if (state.retryAt > now) {
                    continue;
                }
                this.store.setRetryAt(udid, undefined);
                if (now - state.retryAt < UNLOCK_SLOT_WINDOW_MS) {
                    this.schedule(udid, true);
                } else {
                    this.emitStatus(udid);
                }
                continue;
            }
            const slotStart = lastUnlockSlotAt(schedule.time, now);
            if (now - slotStart < UNLOCK_SLOT_WINDOW_MS && (state.lastSlotAt ?? -Infinity) < slotStart) {
                this.store.setLastSlotAt(udid, slotStart);
                this.schedule(udid, false);
            }
        }
    }

    private schedule(udid: string, retry: boolean): void {
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
            this.store.recordUnlockedAt(event.udid, this.now());
            this.emitStatus(event.udid);
        }
    }

    // ------------------------------------------------------------------ runs

    private enqueue(udid: string, trigger: UnlockRunTrigger, retry: boolean): Promise<UnlockRunResult> {
        this.pending.set(udid, (this.pending.get(udid) ?? 0) + 1);
        this.emitStatus(udid);
        const run = this.chain.then(() => this.execute(udid, trigger, retry));
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private async execute(udid: string, trigger: UnlockRunTrigger, retry: boolean): Promise<UnlockRunResult> {
        const at = this.now();
        const started = Date.now();
        let result: UnlockRunResult;
        try {
            result = await this.perform(udid, trigger, at);
        } catch (error) {
            // The driver rejects only on programming errors; the run still ends with a result so
            // the panel never stays on "running".
            console.error(`${TAG} [${udid}] ${trigger} run threw: ${(error as Error).message}`);
            result = { at, trigger, outcome: 'failed-session', message: (error as Error).message };
        }
        this.store.recordRun(udid, result);
        if (trigger === 'schedule' && REPORTED_OUTCOMES.has(result.outcome)) {
            if (!retry) {
                this.store.setRetryAt(udid, this.now() + UNLOCK_RETRY_MS);
            }
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

    /** The skip rules in order, then the driver. */
    private async perform(udid: string, trigger: UnlockRunTrigger, at: number): Promise<UnlockRunResult> {
        const options = this.options;
        if (!options) {
            throw new Error('Scheduler not started');
        }
        const skip = (outcome: UnlockRunOutcome, message?: string): UnlockRunResult => ({
            at,
            trigger,
            outcome,
            message,
        });
        const schedule = this.store.getSchedule(udid);
        if (trigger === 'schedule' && !schedule.enabled) {
            return skip('skipped-disabled');
        }
        if (!schedule.hasPasscode) {
            return skip('skipped-no-passcode');
        }
        if (!options.isConnected(udid)) {
            return skip('skipped-disconnected', DISCONNECTED_MESSAGE);
        }
        const { lastUnlockedAt } = this.store.getRunState(udid);
        if (trigger === 'schedule' && lastUnlockedAt !== undefined && at - lastUnlockedAt < RECENT_WINDOW_MS) {
            return skip('skipped-recent');
        }
        if (this.monitor.getState(udid)['device.locked'] === false) {
            this.store.recordUnlockedAt(udid, at);
            return skip('already-unlocked');
        }
        // The passcode is decrypted inside the thunk only, by the driver, right before typing.
        const outcome = await this.driver.run(udid, () => this.store.readPasscode(udid));
        if (outcome.outcome === 'unlocked') {
            this.store.recordUnlockedAt(udid, outcome.verifiedAt ?? this.now());
        }
        return { at, trigger, outcome: outcome.outcome, message: outcome.message };
    }

    private emitStatus(udid: string): UnlockScheduleStatus {
        const status = this.getStatus(udid);
        this.emit('status', { udid, status });
        return status;
    }
}
