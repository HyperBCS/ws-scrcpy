import { UnlockRunOutcome } from '../../../common/IosUnlockSchedule';
import { CoreDeviceRunner } from './CoreDeviceRunner';
import { DeviceStateMonitor } from './DeviceStateMonitor';

/** Everything the driver can report. The skip outcomes are decided by the scheduler before it is called. */
export type UnlockDriverOutcome = Extract<
    UnlockRunOutcome,
    'unlocked' | 'failed-wake' | 'failed-session' | 'failed-still-locked' | 'unverified'
>;

export interface UnlockDriverResult {
    outcome: UnlockDriverOutcome;
    // Step names and `PyMobileDevice.explain` text only; never the passcode.
    message?: string;
    // Set with `outcome === 'unlocked'`: when `device.locked` was read as `false`.
    verifiedAt?: number;
}

/**
 * Test seams. Production uses the singletons and `CoreDeviceProxy.hasInputOwner`; W2 may add
 * optional fields.
 */
export interface UnlockDriverDeps {
    runner: CoreDeviceRunner;
    monitor: DeviceStateMonitor;
    hasInputOwner: (udid: string) => boolean;
}

/**
 * One pause point per step. `IOS_UNLOCK_FAST=1` shortens every pause to 5 ms for fixture tests,
 * following the `IOS_CLIPBOARD_TIMEOUT_MS` pattern. Owned by W2.
 */
export function pause(_name: string, _defaultMs: number): Promise<void> {
    throw new Error('not implemented');
}

/**
 * Replays the unlock sequence of `StreamClientCoreDevice.unlockWithPasscode` from the server:
 * acquire the session through `CoreDeviceRunner.acquire` (never start serve-web directly),
 * `/restart` if the session was already `ready`, wake with Home (Lock once as fallback) and
 * read the backlight before any touch, swipe up, type the digits over `/key`, detach the
 * keyboard, verify with `DeviceStateMonitor.waitForLock`, press Lock, and release the session
 * so the runner's grace timer and SIGTERM path stop serve-web. Plan section 3.6 has the exact
 * requests and timings; section 3.7 the display-service rules.
 *
 * Responsibility split: only `UnlockScheduler` calls `run`, one run at a time per process. The
 * driver never touches the store: the scheduler hands it `readPasscode`, which the driver calls
 * once, right before typing, and the plaintext lives in a local for the duration of the digit
 * step only. The driver records nothing; the scheduler persists `lastUnlockedAt` from
 * `verifiedAt` and the run result. Logs step names only (`home`, `swipe`, `digits (n)`,
 * `verify`, `lock`). Owned by W2.
 */
export class UnlockDriver {
    protected readonly deps: Partial<UnlockDriverDeps>;

    constructor(deps: Partial<UnlockDriverDeps> = {}) {
        this.deps = deps;
    }

    /** Resolves with the outcome; rejects only on programming errors. Session failures are outcomes. */
    public run(_udid: string, _readPasscode: () => string): Promise<UnlockDriverResult> {
        throw new Error('not implemented');
    }
}
