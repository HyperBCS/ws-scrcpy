import { TypedEmitter } from '../../../common/TypedEmitter';
import {
    UnlockRunResult,
    UnlockRunTrigger,
    UnlockSchedulePatch,
    UnlockScheduleStatus,
} from '../../../common/IosUnlockSchedule';
import { UnlockSettingsStore } from './IosSettingsStore';
import { UnlockDriver } from './UnlockDriver';
import { DeviceStateMonitor } from './DeviceStateMonitor';
import type { SystemPushPayload } from '../../notifications/NotificationService';

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

/** Test seams. `getInstance()` uses the production singletons; W2 may add optional fields. */
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
 * `retryAt` as `nextRunAt`. Owned by W2.
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
    public start(_options: UnlockSchedulerStartOptions): void {
        throw new Error('not implemented');
    }

    /** Stop timers and listeners, release the store, drop the singleton. A run in progress finishes on its own. */
    public release(): void {
        throw new Error('not implemented');
    }

    public getStatus(_udid: string): UnlockScheduleStatus {
        throw new Error('not implemented');
    }

    /** `UPDATE_UNLOCK_SCHEDULE`. The patch is already validated by `ControlCenterCommand`. */
    public updateSchedule(_udid: string, _patch: UnlockSchedulePatch): UnlockScheduleStatus {
        throw new Error('not implemented');
    }

    /** `SET_UNLOCK_PASSCODE`. Already validated; must not be logged, kept or echoed. */
    public setPasscode(_udid: string, _passcode: string): UnlockScheduleStatus {
        throw new Error('not implemented');
    }

    /** `CLEAR_UNLOCK_PASSCODE`. */
    public clearPasscode(_udid: string): UnlockScheduleStatus {
        throw new Error('not implemented');
    }

    /**
     * The only way a run starts, for the schedule and for `RUN_UNLOCK_NOW`. One run at a time
     * across the process; a second call waits. Resolves when the run has ended, with the result
     * that was also recorded and broadcast. Manual runs ignore `skipped-disabled` and
     * `skipped-recent` and never schedule a retry.
     */
    public runNow(_udid: string, _trigger: UnlockRunTrigger): Promise<UnlockRunResult> {
        throw new Error('not implemented');
    }
}
