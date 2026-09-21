import { ChildProcess } from 'child_process';
import { TypedEmitter } from '../../../common/TypedEmitter';
import { KnownBoolean } from '../../../types/AndroidLockState';
import { PyMobileDevice } from './PyMobileDevice';

const TAG = '[DeviceStateMonitor]';

export type ScreenPower = 'on' | 'off' | 'unknown';

export interface AppleRuntimeState {
    'screen.power': ScreenPower;
    'device.locked': KnownBoolean;
}

export interface DeviceStateMonitorEvents {
    state: { udid: string } & AppleRuntimeState;
}

export interface WatchOptions {
    // BCP 47 tag from lockdown's `com.apple.international` domain (`en-US`). The lock probe reads
    // localized accessibility captions, so it only trusts a "no padlock seen" result in English.
    language?: string;
}

// The screen probe is one lockdown request (~0.6 s, no tunnel), cheap enough to keep the device
// list honest while nobody is streaming. The lock probe is the expensive, intrusive one: it opens
// a developer tunnel and asks the accessibility daemon what is on screen (~1.3 s), so it never
// runs on a timer -- only when something that could change the lock happened (a SpringBoard lock
// notification, the screen blanking or lighting up, a button or passcode sent through the stream,
// an explicit refresh), and never while the phone is known to be unlocked and awake, which is
// exactly when somebody is using it.
const SCREEN_POLL_IDLE_MS = 15000;
const SCREEN_POLL_ACTIVE_MS = 4000;
// SpringBoard posts a notification the instant the screen blanks or the lock changes; the state
// itself is read a moment later, once the transition has settled.
const NOTIFICATION_DEBOUNCE_MS = 400;
// After a Lock/Home press or a passcode typed through the stream the phone needs a moment to
// actually lock, wake or unlock before a probe would see the new state.
const INPUT_SETTLE_MS = 1500;
const OBSERVER_RETRY_MIN_MS = 5000;
const OBSERVER_RETRY_MAX_MS = 60000;
const SCREEN_PROBE_TIMEOUT_MS = 20000;
const LOCK_PROBE_TIMEOUT_MS = 40000;
const LOCK_PROBE_SCRIPT = 'lockstate.py';

const SCREEN_NOTIFICATION = 'com.apple.springboard.hasBlankedScreen';
const LOCK_NOTIFICATIONS = ['com.apple.springboard.lockstate', 'com.apple.springboard.lockcomplete'];

// Captions of the lock screen's accessibility elements as iOS 27 reports them in English: the
// padlock under the clock reads "Locked" or "Unlocked" (Face ID has recognised the owner but the
// screen has not been swiped away yet), the passcode keypad is titled "Enter Passcode". Other
// languages can be added through IOS_LOCKED_CAPTIONS (comma separated).
const LOCKED_CAPTIONS = ['locked', 'enter passcode'];
const UNLOCKED_CAPTIONS = ['unlocked'];

type AccessibilityItem = string | { caption?: string | null; spoken_description?: string | null };

interface Watched {
    udid: string;
    language?: string;
    state: AppleRuntimeState;
    sessionActive: boolean;
    wantScreen: boolean;
    wantLock: boolean;
    running: boolean;
    rerun: boolean;
    probeTimer?: NodeJS.Timeout;
    probeDueAt: number;
    screenTimer?: NodeJS.Timeout;
    lockProbeMissing?: boolean;
    observer?: ChildProcess;
    observerBuffer: string;
    observerRetryMs: number;
    observerRetryTimer?: NodeJS.Timeout;
    stopped: boolean;
}

/**
 * Screen and lock state for iOS devices, the counterpart of Android's `dumpsys` polling.
 *
 * iOS has no API that answers "is the phone locked" over USB (CoreDevice's `getlockstate` action
 * reports "not implemented" on iOS 27), so the state is assembled from three sources, all through
 * the `pymobiledevice3` CLI and nothing installed on the phone:
 *
 * - **Screen**: the `AppleARMBacklight` IORegistry entry over the lockdown diagnostics relay.
 *   `IODisplayParameters.brightness.value` is 0 exactly while the display is blanked (verified
 *   on an iPhone 13 Pro Max: 1 awake in a dark room, 0 asleep).
 * - **Lock**: `python/probes/lockstate.py` asks the accessibility daemon what is on screen. The
 *   lock screen carries a padlock captioned "Locked"/"Unlocked" and the passcode keypad "Enter
 *   Passcode"; anything else means the phone is in use. It works with the screen off too (it
 *   reports the lock screen underneath). The probe is ours rather than the CLI's `list-items`
 *   because that one leaves the inspector overlay on, so the phone drew a green highlight box
 *   around each element on every poll.
 * - **Triggers**: `notification observe` relays SpringBoard's Darwin notifications for screen
 *   blanking and lock changes, so a probe runs within a second of the phone changing instead of
 *   at the next poll. Notifications alone would not do: they carry no payload, so the direction
 *   of a change has to be read from the device.
 *
 * `IOS_STATE_PROBE=0` turns all of this off, `IOS_LOCK_PROBE=0` only the lock probe (it is the
 * one that opens a developer tunnel and touches the accessibility daemon),
 * `IOS_STATE_NOTIFICATIONS=0` the observer process.
 */
export class DeviceStateMonitor extends TypedEmitter<DeviceStateMonitorEvents> {
    private static instance?: DeviceStateMonitor;
    private readonly watched = new Map<string, Watched>();

    public static getInstance(): DeviceStateMonitor {
        if (!this.instance) {
            this.instance = new DeviceStateMonitor();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!this.instance;
    }

    public static isEnabled(): boolean {
        return process.env.IOS_STATE_PROBE !== '0';
    }

    public static isLockProbeEnabled(): boolean {
        return this.isEnabled() && process.env.IOS_LOCK_PROBE !== '0';
    }

    /** Starts watching a paired, connected device; a second call updates its options. */
    public watch(udid: string, options: WatchOptions = {}): void {
        if (!DeviceStateMonitor.isEnabled()) {
            return;
        }
        let entry = this.watched.get(udid);
        if (entry) {
            entry.language = options.language ?? entry.language;
            return;
        }
        entry = {
            udid,
            language: options.language,
            state: { 'screen.power': 'unknown', 'device.locked': 'unknown' },
            sessionActive: false,
            wantScreen: false,
            wantLock: false,
            running: false,
            rerun: false,
            probeDueAt: 0,
            observerBuffer: '',
            observerRetryMs: OBSERVER_RETRY_MIN_MS,
            stopped: false,
        };
        this.watched.set(udid, entry);
        this.startObserver(entry);
        this.schedule(entry, { screen: true, lock: true }, 0);
    }

    public unwatch(udid: string): void {
        const entry = this.watched.get(udid);
        if (!entry) {
            return;
        }
        this.watched.delete(udid);
        entry.stopped = true;
        for (const timer of [entry.probeTimer, entry.screenTimer, entry.observerRetryTimer]) {
            if (timer) {
                clearTimeout(timer);
            }
        }
        this.killObserver(entry);
    }

    public getState(udid: string): AppleRuntimeState {
        return this.watched.get(udid)?.state ?? { 'screen.power': 'unknown', 'device.locked': 'unknown' };
    }

    public isWatching(udid: string): boolean {
        return this.watched.has(udid);
    }

    /**
     * A screen session is up: someone is looking at the phone, so the screen is polled fast. The
     * lock is read once here and then only on the triggers above -- polling it would drive the
     * accessibility daemon over whatever the person is doing.
     */
    public setSessionActive(udid: string, active: boolean): void {
        const entry = this.watched.get(udid);
        if (!entry || entry.sessionActive === active) {
            return;
        }
        entry.sessionActive = active;
        this.armScreenTimer(entry);
        if (active) {
            this.schedule(entry, { screen: true, lock: this.shouldProbeLock(entry) }, 0);
        }
    }

    /**
     * Whether a lock probe is worth its cost right now. A phone that is awake and known to be
     * unlocked is a phone somebody is using: re-reading its lock state tells us what we already
     * know, and drives the accessibility daemon over the app they are looking at. Transitions
     * that could lock it (the screen blanking, a SpringBoard lock notification) are observed
     * separately and are not gated by this.
     */
    private shouldProbeLock(entry: Watched): boolean {
        return entry.state['device.locked'] !== false || entry.state['screen.power'] === 'off';
    }

    /**
     * A hardware button went to the phone (Lock, Home, the app switcher). The screen may well
     * have changed; the lock only matters if it could have been dismissed, and locking the phone
     * blanks the screen, which the notification observer catches on its own.
     */
    public pokeButton(udid: string): void {
        const entry = this.watched.get(udid);
        if (entry) {
            this.schedule(entry, { screen: true, lock: this.shouldProbeLock(entry) }, INPUT_SETTLE_MS);
        }
    }

    /**
     * Keys or touches went to the phone. Only interesting while it is locked or dark (a passcode
     * being typed, a swipe waking it); re-reading the lock on every tap of a phone in use would
     * open a tunnel every second or two for nothing.
     */
    public pokeInput(udid: string): void {
        const entry = this.watched.get(udid);
        if (!entry) {
            return;
        }
        if (this.shouldProbeLock(entry)) {
            this.schedule(entry, { screen: true, lock: true }, INPUT_SETTLE_MS);
        }
    }

    /** An explicit request (the GET_LOCK_STATE command): read everything now. */
    public refresh(udid: string): void {
        const entry = this.watched.get(udid);
        if (entry) {
            this.schedule(entry, { screen: true, lock: true }, 0);
        }
    }

    public release(): void {
        for (const udid of Array.from(this.watched.keys())) {
            this.unwatch(udid);
        }
        DeviceStateMonitor.instance = undefined;
    }

    // ------------------------------------------------------------------ scheduling

    private schedule(entry: Watched, what: { screen?: boolean; lock?: boolean }, delayMs: number): void {
        if (entry.stopped) {
            return;
        }
        entry.wantScreen = entry.wantScreen || !!what.screen;
        entry.wantLock = entry.wantLock || (!!what.lock && DeviceStateMonitor.isLockProbeEnabled());
        if (!entry.wantScreen && !entry.wantLock) {
            return;
        }
        const dueAt = Date.now() + delayMs;
        if (entry.probeTimer && entry.probeDueAt <= dueAt) {
            return; // An earlier run is already pending and will pick the new flags up.
        }
        if (entry.probeTimer) {
            clearTimeout(entry.probeTimer);
        }
        entry.probeDueAt = dueAt;
        entry.probeTimer = setTimeout(() => {
            entry.probeTimer = undefined;
            this.run(entry).catch((error: Error) => console.error(`${TAG} [${entry.udid}] ${error.message}`));
        }, delayMs);
    }

    private async run(entry: Watched): Promise<void> {
        if (entry.running) {
            entry.rerun = true;
            return;
        }
        entry.running = true;
        try {
            do {
                entry.rerun = false;
                const doScreen = entry.wantScreen;
                const doLock = entry.wantLock;
                entry.wantScreen = false;
                entry.wantLock = false;
                let screen = entry.state['screen.power'];
                let locked = entry.state['device.locked'];
                if (doScreen && !entry.stopped) {
                    screen = await this.probeScreen(entry.udid);
                    this.armScreenTimer(entry);
                }
                if (doLock && !entry.stopped) {
                    locked = await this.probeLock(entry);
                }
                if (entry.stopped) {
                    return;
                }
                this.update(entry, { 'screen.power': screen, 'device.locked': locked });
            } while (entry.rerun || entry.wantScreen || entry.wantLock);
        } finally {
            entry.running = false;
        }
    }

    private update(entry: Watched, next: AppleRuntimeState): void {
        if (
            entry.state['screen.power'] === next['screen.power'] &&
            entry.state['device.locked'] === next['device.locked']
        ) {
            return;
        }
        const wasDark = entry.state['screen.power'] === 'off';
        entry.state = next;
        this.emit('state', { udid: entry.udid, ...next });
        if (wasDark && next['screen.power'] === 'on' && next['device.locked'] !== false) {
            // Waking is when Face ID unlocks; the lock walk that ran alongside this screen read
            // may have been a moment too early for that.
            this.schedule(entry, { lock: true }, INPUT_SETTLE_MS);
        }
    }

    private armScreenTimer(entry: Watched): void {
        if (entry.screenTimer) {
            clearTimeout(entry.screenTimer);
        }
        if (entry.stopped) {
            return;
        }
        entry.screenTimer = setTimeout(
            () => {
                entry.screenTimer = undefined;
                this.schedule(entry, { screen: true }, 0);
            },
            entry.sessionActive ? SCREEN_POLL_ACTIVE_MS : SCREEN_POLL_IDLE_MS,
        );
    }

    // ------------------------------------------------------------------ probes

    private async probeScreen(udid: string): Promise<ScreenPower> {
        try {
            const dump = await PyMobileDevice.runJson<unknown>(
                ['diagnostics', 'ioregistry', '--ioclass', 'AppleARMBacklight', '--udid', udid],
                SCREEN_PROBE_TIMEOUT_MS,
            );
            return DeviceStateMonitor.screenPowerFromBacklight(dump);
        } catch (error) {
            PyMobileDevice.log(`[${udid}] screen probe failed: ${(error as Error).message}`);
            return 'unknown';
        }
    }

    /**
     * The backlight entry as `diagnostics ioregistry` prints it (one object, or a list when the
     * class matches several entries): `IODisplayParameters.brightness.value` is 0 with the screen
     * off and the current level (1..65536) otherwise.
     */
    public static screenPowerFromBacklight(dump: unknown): ScreenPower {
        const entries = Array.isArray(dump) ? dump : [dump];
        for (const entry of entries) {
            const parameters = (entry as { IODisplayParameters?: Record<string, { value?: unknown }> } | null)
                ?.IODisplayParameters;
            const value = parameters?.brightness?.value;
            if (typeof value === 'number') {
                return value > 0 ? 'on' : 'off';
            }
        }
        return 'unknown';
    }

    private async probeLock(entry: Watched): Promise<KnownBoolean> {
        try {
            const result = await PyMobileDevice.runProbeJson<{ locked?: boolean | null; captions?: unknown }>(
                LOCK_PROBE_SCRIPT,
                [],
                LOCK_PROBE_TIMEOUT_MS,
                { PYMOBILEDEVICE3_UDID: entry.udid },
            );
            if (!result) {
                // No probe script next to the server (a partial install): say so once and stop
                // asking, rather than failing a probe every time something pokes the device.
                if (!entry.lockProbeMissing) {
                    entry.lockProbeMissing = true;
                    console.error(`${TAG} ${LOCK_PROBE_SCRIPT} is missing; lock state stays unknown`);
                }
                return 'unknown';
            }
            // The script's own reading is the English one; the captions go through the caller's
            // table so IOS_LOCKED_CAPTIONS and the phone's language still decide.
            return DeviceStateMonitor.lockedFromAccessibilityItems(result.captions, entry.language);
        } catch (error) {
            PyMobileDevice.log(`[${entry.udid}] lock probe failed: ${(error as Error).message}`);
            return 'unknown';
        }
    }

    /**
     * Reads the lock screen out of the probe's captions (or, in the tests, raw accessibility
     * items). A known padlock or keypad caption is
     * decisive either way. With no such caption on an English phone the screen belongs to an app
     * or the home screen, so the phone is unlocked; in another language the same absence may just
     * be a caption this table does not know, so it stays 'unknown' unless IOS_LOCKED_CAPTIONS
     * supplies the localized words.
     */
    public static lockedFromAccessibilityItems(items: unknown, language?: string): KnownBoolean {
        if (!Array.isArray(items) || items.length === 0) {
            return 'unknown';
        }
        const custom = (process.env.IOS_LOCKED_CAPTIONS || '')
            .split(',')
            .map((caption) => caption.trim().toLowerCase())
            .filter(Boolean);
        const locked = [...LOCKED_CAPTIONS, ...custom];
        const captions = (items as AccessibilityItem[]).flatMap((item) =>
            (typeof item === 'string' ? [item] : [item?.caption, item?.spoken_description])
                .filter((text): text is string => typeof text === 'string')
                .map((text) => text.trim().toLowerCase()),
        );
        if (captions.some((caption) => locked.includes(caption))) {
            return true;
        }
        if (captions.some((caption) => UNLOCKED_CAPTIONS.includes(caption))) {
            return false;
        }
        const english = !language || /^en(-|_|$)/i.test(language);
        return english || custom.length > 0 ? false : 'unknown';
    }

    // ------------------------------------------------------------------ notifications

    private startObserver(entry: Watched): void {
        if (entry.stopped || process.env.IOS_STATE_NOTIFICATIONS === '0') {
            return;
        }
        const child = PyMobileDevice.spawnDetached([
            'notification',
            'observe',
            SCREEN_NOTIFICATION,
            ...LOCK_NOTIFICATIONS,
            '--udid',
            entry.udid,
        ]);
        entry.observer = child;
        entry.observerBuffer = '';
        child.stdout?.on('data', (data) => this.onObserverOutput(entry, String(data)));
        child.stderr?.on('data', (data) => PyMobileDevice.log(`[${entry.udid}] notifications: ${data}`));
        const onExit = () => {
            if (entry.observer !== child) {
                return;
            }
            entry.observer = undefined;
            if (entry.stopped) {
                return;
            }
            // A phone that is asleep and locked since boot, or mid-reboot, refuses the service;
            // come back later, more slowly each time, and reset once it works again.
            const delay = entry.observerRetryMs;
            entry.observerRetryMs = Math.min(OBSERVER_RETRY_MAX_MS, entry.observerRetryMs * 2);
            entry.observerRetryTimer = setTimeout(() => {
                entry.observerRetryTimer = undefined;
                this.startObserver(entry);
            }, delay);
        };
        child.on('error', onExit);
        child.on('close', onExit);
    }

    private onObserverOutput(entry: Watched, chunk: string): void {
        entry.observerBuffer = (entry.observerBuffer + chunk).slice(-8192);
        const lines = entry.observerBuffer.split('\n');
        entry.observerBuffer = lines.pop() ?? '';
        for (const line of lines) {
            const name = DeviceStateMonitor.notificationName(line);
            if (!name) {
                continue;
            }
            entry.observerRetryMs = OBSERVER_RETRY_MIN_MS;
            if (name === SCREEN_NOTIFICATION) {
                // The lock is read as well: blanking normally locks a passcode phone, and waking
                // through Face ID unlocks it.
                this.schedule(entry, { screen: true, lock: true }, NOTIFICATION_DEBOUNCE_MS);
            } else if (LOCK_NOTIFICATIONS.includes(name)) {
                this.schedule(entry, { lock: true }, NOTIFICATION_DEBOUNCE_MS);
            }
        }
    }

    /** One `notification observe` line: `{"Command": "RelayNotification", "Name": "..."}`. */
    public static notificationName(line: string): string | undefined {
        const text = line.trim();
        if (!text.startsWith('{')) {
            return undefined;
        }
        try {
            const parsed = JSON.parse(text) as { Name?: unknown };
            return typeof parsed.Name === 'string' ? parsed.Name : undefined;
        } catch {
            return undefined;
        }
    }

    private killObserver(entry: Watched): void {
        const child = entry.observer;
        entry.observer = undefined;
        if (!child || child.exitCode !== null || child.signalCode !== null) {
            return;
        }
        const pid = child.pid;
        const signalAll = (signal: NodeJS.Signals) => {
            try {
                if (pid && process.platform !== 'win32') {
                    process.kill(-pid, signal);
                } else {
                    child.kill(signal);
                }
            } catch {
                // Already gone.
            }
        };
        signalAll('SIGTERM');
        const force = setTimeout(() => signalAll('SIGKILL'), 3000);
        child.once('close', () => clearTimeout(force));
    }
}
