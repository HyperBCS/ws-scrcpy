import { UnlockRunOutcome } from '../../../common/IosUnlockSchedule';
import { clampHid } from '../../../common/CoreDeviceProtocol';
import { hidUsageForCode } from '../../../app/applDevice/hidKeyboard';
import { CoreDeviceRunner, HttpReply } from './CoreDeviceRunner';
import { DeviceStateMonitor } from './DeviceStateMonitor';
import { CoreDeviceProxy } from '../mw/CoreDeviceProxy';
import { PyMobileDevice } from './PyMobileDevice';

const TAG = '[UnlockDriver]';

// Same holds `CoreDeviceProxy` uses: iOS 27 discards a shorter Home press and reads a longer Lock
// press as Siri.
const HOME_PRESS_MS = 250;
const LOCK_TAP_MS = 300;
// After Home or Lock the backlight needs a moment before a read shows the new state.
const WAKE_SETTLE_MS = 1200;
// `/restart` reopens the touch surface against the live stream; give it time before any input.
const RESTART_SETTLE_MS = 1500;
// The swipe of `StreamClientCoreDevice.unlockWithPasscode`, verified on the bench phone.
const SWIPE_X = 0x8000;
const SWIPE_START_Y = 0xf800;
const SWIPE_STEP = 0x0ccc;
const SWIPE_STEPS = 12;
const SWIPE_INTERVAL_MS = 25;
const SWIPE_SETTLE_MS = 1200;
const KEY_DOWN_MS = 120;
const KEY_UP_MS = 180;
// How long the lock state gets to turn false after the last digit, and true after Lock.
const VERIFY_TIMEOUT_MS = 8000;
const RELOCK_TIMEOUT_MS = 5000;
// Let the home screen settle before putting the phone back to sleep.
const LOCK_DELAY_MS = 2000;
// A viewer typing or touching gets this long, up to this many times, before the run proceeds.
const VIEWER_BACKOFF_MS = 30000;
const VIEWER_BACKOFF_TRIES = 3;
// HID posts answer in milliseconds; button edges and the keyboard detach wait for native completion.
const INPUT_TIMEOUT_MS = 4000;
const INPUT_COMPLETION_TIMEOUT_MS = 10000;
const FAST_PAUSE_MS = 5;

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

/** Test seams. Production uses the singletons and `CoreDeviceProxy.hasInputOwner`. */
export interface UnlockDriverDeps {
    runner: CoreDeviceRunner;
    monitor: DeviceStateMonitor;
    hasInputOwner: (udid: string) => boolean;
}

/**
 * One pause point per step. `IOS_UNLOCK_FAST=1` shortens every pause to 5 ms for fixture tests,
 * following the `IOS_CLIPBOARD_TIMEOUT_MS` pattern.
 */
export function pause(name: string, defaultMs: number): Promise<void> {
    const ms = process.env.IOS_UNLOCK_FAST === '1' ? FAST_PAUSE_MS : defaultMs;
    PyMobileDevice.log(`unlock pause ${name} ${ms} ms`);
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown by a step so the catch can name it; the cause is the runner's or serve-web's message. */
class StepError extends Error {
    constructor(
        public readonly step: string,
        message: string,
    ) {
        super(message);
    }
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
 * `verify`, `lock`).
 */
export class UnlockDriver {
    protected readonly deps: Partial<UnlockDriverDeps>;

    constructor(deps: Partial<UnlockDriverDeps> = {}) {
        this.deps = deps;
    }

    /** Resolves with the outcome; rejects only on programming errors. Session failures are outcomes. */
    public async run(udid: string, readPasscode: () => string): Promise<UnlockDriverResult> {
        const runner = this.deps.runner ?? CoreDeviceRunner.getInstance();
        const monitor = this.deps.monitor ?? DeviceStateMonitor.getInstance();
        const hasInputOwner = this.deps.hasInputOwner ?? CoreDeviceProxy.hasInputOwner;
        const log = (step: string) => console.log(`${TAG} [${udid}] ${step}`);
        const post = async (step: string, path: string, body?: object, timeoutMs = INPUT_TIMEOUT_MS) => {
            let reply: HttpReply;
            try {
                reply = await runner.request(udid, 'POST', path, body && JSON.stringify(body), timeoutMs);
            } catch (error) {
                throw new StepError(step, (error as Error).message);
            }
            if (reply.status !== 200) {
                throw new StepError(step, `${path} answered ${reply.status}`);
            }
        };
        const button = async (step: string, name: 'home' | 'lock', holdMs: number) => {
            await post(step, '/button', { name, state: 'down' }, INPUT_COMPLETION_TIMEOUT_MS);
            try {
                await pause(step, holdMs);
            } finally {
                // A button left down is a stuck Home or a long Lock press that starts Siri.
                await post(step, '/button', { name, state: 'up' }, INPUT_COMPLETION_TIMEOUT_MS);
            }
        };

        for (let attempt = 0; attempt < VIEWER_BACKOFF_TRIES && hasInputOwner(udid); attempt++) {
            log('viewer is typing or touching; waiting');
            await pause('viewer', VIEWER_BACKOFF_MS);
        }

        const reused = runner.getStatus(udid).state === 'ready';
        try {
            await runner.acquire(udid);
        } catch (error) {
            // `acquire` has already dropped its hold on failure.
            return { outcome: 'failed-session', message: (error as Error).message };
        }
        let touched = false;
        let keyboardAttached = false;
        try {
            if (reused) {
                // An input POST that reached this process while the screen was dark left its
                // touch surface unauthenticated; reopen it against the live stream.
                log('restart');
                await post('restart', '/restart');
                await pause('restart', RESTART_SETTLE_MS);
            }

            log('home');
            await button('home', 'home', HOME_PRESS_MS);
            await pause('wake', WAKE_SETTLE_MS);
            let screen = await monitor.readScreen(udid);
            if (screen === 'unknown') {
                // A failed read says nothing about the screen; Lock would put an awake phone to sleep.
                await pause('wake', WAKE_SETTLE_MS);
                screen = await monitor.readScreen(udid);
            }
            if (screen === 'off') {
                // From a dark lock screen Home may not wake a Face ID phone; Lock does.
                log('wake with lock');
                await button('wake', 'lock', LOCK_TAP_MS);
                await pause('wake', WAKE_SETTLE_MS);
                screen = await monitor.readScreen(udid);
            }
            if (screen !== 'on') {
                // No touch is sent before the backlight reads on.
                const message =
                    screen === 'off'
                        ? 'The screen stayed dark after Home and Lock'
                        : 'The screen state could not be read';
                return { outcome: 'failed-wake', message };
            }

            log('swipe');
            touched = true;
            let y = SWIPE_START_Y;
            for (let step = 0; step < SWIPE_STEPS; step++) {
                if (step > 0) {
                    await pause('swipe', SWIPE_INTERVAL_MS);
                    y = clampHid(y - SWIPE_STEP);
                }
                await post('swipe', '/touch', { type: 'contact', x: SWIPE_X, y });
            }
            await post('swipe', '/touch', { type: 'release', x: SWIPE_X, y });
            await pause('swipe', SWIPE_SETTLE_MS);

            let typed = false;
            let readError: string | undefined;
            {
                // The passcode is read here and nowhere else, and this block is its whole lifetime.
                let usages: number[] = [];
                try {
                    usages = Array.from(readPasscode(), (digit) => hidUsageForCode(`Digit${digit}`) ?? -1);
                } catch (error) {
                    readError = (error as Error).message;
                }
                if (!readError && usages.some((usage) => usage < 0)) {
                    readError = 'The stored passcode is not all digits';
                }
                if (!readError) {
                    log(`digits (${usages.length})`);
                    keyboardAttached = true;
                    for (const usage of usages) {
                        await post('digits', '/key', { usages: [usage] });
                        await pause('key', KEY_DOWN_MS);
                        await post('digits', '/key', { usages: [] });
                        await pause('key', KEY_UP_MS);
                    }
                    typed = true;
                }
            }
            if (keyboardAttached) {
                await post('digits', '/keyboard/detach', undefined, INPUT_COMPLETION_TIMEOUT_MS);
                keyboardAttached = false;
            }

            let result: UnlockDriverResult;
            if (!typed) {
                result = { outcome: 'failed-still-locked', message: `Passcode not entered: ${readError}` };
            } else {
                log('verify');
                const locked = await monitor.waitForLock(udid, false, VERIFY_TIMEOUT_MS);
                if (locked === false) {
                    result = { outcome: 'unlocked', verifiedAt: Date.now() };
                } else if (locked === true) {
                    result = { outcome: 'failed-still-locked' };
                } else {
                    result = { outcome: 'unverified', message: 'Lock state could not be read' };
                }
            }

            // Put the phone back to sleep whatever the verdict: an unlocked phone left awake is
            // worse than one that did not unlock.
            await pause('lock', LOCK_DELAY_MS);
            log('lock');
            await button('lock', 'lock', LOCK_TAP_MS);
            const relocked = await monitor.waitForLock(udid, true, RELOCK_TIMEOUT_MS);
            // "Locked again" only matters after an unlock; a phone left unlocked is always reported.
            const note =
                relocked === false
                    ? 'Lock not confirmed'
                    : relocked === true && result.outcome === 'unlocked'
                      ? 'Locked again'
                      : undefined;
            if (note) {
                result.message = result.message ? `${result.message}. ${note}` : note;
            }
            return result;
        } catch (error) {
            const step = error instanceof StepError ? error.step : 'run';
            return { outcome: 'failed-session', message: `${step}: ${(error as Error).message}` };
        } finally {
            if (touched) {
                // The frame `CoreDeviceProxy.release` sends: no finger stays down on the phone.
                await post('cleanup', '/touch', {
                    type: 'frame',
                    contacts: [0, 1, 2, 3, 4].map((id) => ({ id, touching: false, x: 0, y: 0 })),
                }).catch(() => undefined);
            }
            if (keyboardAttached) {
                await post('cleanup', '/keyboard/detach', undefined, INPUT_COMPLETION_TIMEOUT_MS).catch(
                    () => undefined,
                );
            }
            // With no viewer the runner stops serve-web after its grace period, SIGTERM first.
            runner.release(udid);
        }
    }
}
