import { resolveDataDir } from '../../dataDir';
import { UnlockRunResult, UnlockSchedulePatch, UnlockScheduleStatus } from '../../../common/IosUnlockSchedule';

/** `ios-settings.json` in the data directory, next to `notifications.json`. */
export const IOS_SETTINGS_FILE = 'ios-settings.json';
/** 32 random bytes, 0600, written on the first `setPasscode` unless `WS_IOS_SETTINGS_KEY` is set. */
export const IOS_SETTINGS_KEY_FILE = 'ios-settings.key';
/** 64 hex characters. When set, no key file is written or read. */
export const IOS_SETTINGS_KEY_ENV = 'WS_IOS_SETTINGS_KEY';

/** AES-256-GCM, new 12-byte IV per write, AAD = udid. All three fields base64. */
export interface EncryptedPasscode {
    iv: string;
    tag: string;
    data: string;
}

/** Per-device record as stored on disk. The scheduler's bookkeeping fields live here too. */
export interface StoredUnlockSettings {
    enabled: boolean;
    time: string;
    passcode?: EncryptedPasscode;
    lastUnlockedAt?: number;
    lastRun?: UnlockRunResult;
    // A failed scheduled run is retried once, this long after it. Cleared when the retry ran.
    retryAt?: number;
    // Start of the last daily slot that was used, set before the run starts so a crash cannot loop.
    lastSlotAt?: number;
}

export interface IosSettingsFile {
    version: 1;
    devices: Record<string, { unlock?: StoredUnlockSettings }>;
}

/** The scheduler's bookkeeping, read back by `UnlockScheduler.tick()`. */
export interface UnlockRunState {
    lastUnlockedAt?: number;
    retryAt?: number;
    lastSlotAt?: number;
}

/**
 * What `UnlockScheduler` (W2) needs from the store. `IosSettingsStore` (W1) implements it against
 * the files above; W2's tests implement it in memory. Every method is synchronous: writes go
 * temp-file-then-rename like `NotificationStorage.write`, and none of them throws for a missing
 * or unreadable key file. Only `readPasscode` decrypts, and it throws instead of returning
 * `undefined` so a caller cannot send an empty passcode by mistake; its error text never
 * contains the passcode.
 */
export interface UnlockSettingsStore {
    /** Create the directory (0700) and read the settings file. Idempotent. Never throws at startup. */
    load(): void;
    /** Every udid with an unlock record. */
    listUdids(): string[];
    /**
     * Public status of one device, defaults for an unknown udid (`enabled: false`,
     * `time: DEFAULT_UNLOCK_TIME`, `hasPasscode: false`). `nextRunAt` is
     * `nextUnlockRunAt(time, Date.now())` while `enabled && hasPasscode`, else absent. `running`
     * is never set here; the scheduler adds it and may bring `nextRunAt` forward to `retryAt`.
     * `hasPasscode` is false when ciphertext exists but cannot be decrypted (key file missing);
     * then `lastRun.message` reads "Stored passcode unreadable: key file missing".
     */
    getSchedule(udid: string): UnlockScheduleStatus;
    /** The scheduler's own fields for `tick()`. */
    getRunState(udid: string): UnlockRunState;
    /** Apply a validated patch and persist. Returns the new status. */
    updateSchedule(udid: string, patch: UnlockSchedulePatch): UnlockScheduleStatus;
    /** Encrypt and persist a validated passcode, creating the key file if needed. Returns the new status. */
    setPasscode(udid: string, passcode: string): UnlockScheduleStatus;
    /** Remove the ciphertext; `enabled` is left as it is. Returns the new status. */
    clearPasscode(udid: string): UnlockScheduleStatus;
    /** Decrypt the stored passcode. Throws when none is stored or it cannot be decrypted. */
    readPasscode(udid: string): string;
    recordUnlockedAt(udid: string, at: number): void;
    recordRun(udid: string, result: UnlockRunResult): void;
    setRetryAt(udid: string, at: number | undefined): void;
    setLastSlotAt(udid: string, at: number): void;
    /** Drop the singleton. No pending writes exist, since every write is synchronous. */
    release(): void;
}

/**
 * Settings and the encrypted unlock passcode for each iPhone, under the server data directory.
 * File layout and cipher parameters are in the plan (section 3.3) and the constants above.
 *
 * Responsibility split: `ControlCenter` never calls this class. All four unlock commands go to
 * `UnlockScheduler`, which owns the only reference to the store (`IosSettingsStore.getInstance()`
 * by default, an in-memory `UnlockSettingsStore` in tests) and emits `status` after each change,
 * so the descriptor update path is the same for a command and for a run. Owned by W1.
 */
export class IosSettingsStore implements UnlockSettingsStore {
    private static instance?: IosSettingsStore;

    public static getInstance(): IosSettingsStore {
        if (!this.instance) {
            this.instance = new IosSettingsStore();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!IosSettingsStore.instance;
    }

    /** `directory` is a test seam; production uses the data directory. */
    constructor(public readonly directory: string = resolveDataDir()) {}

    public load(): void {
        throw new Error('not implemented');
    }

    public listUdids(): string[] {
        throw new Error('not implemented');
    }

    public getSchedule(_udid: string): UnlockScheduleStatus {
        throw new Error('not implemented');
    }

    public getRunState(_udid: string): UnlockRunState {
        throw new Error('not implemented');
    }

    public updateSchedule(_udid: string, _patch: UnlockSchedulePatch): UnlockScheduleStatus {
        throw new Error('not implemented');
    }

    public setPasscode(_udid: string, _passcode: string): UnlockScheduleStatus {
        throw new Error('not implemented');
    }

    public clearPasscode(_udid: string): UnlockScheduleStatus {
        throw new Error('not implemented');
    }

    public readPasscode(_udid: string): string {
        throw new Error('not implemented');
    }

    public recordUnlockedAt(_udid: string, _at: number): void {
        throw new Error('not implemented');
    }

    public recordRun(_udid: string, _result: UnlockRunResult): void {
        throw new Error('not implemented');
    }

    public setRetryAt(_udid: string, _at: number | undefined): void {
        throw new Error('not implemented');
    }

    public setLastSlotAt(_udid: string, _at: number): void {
        throw new Error('not implemented');
    }

    public release(): void {
        IosSettingsStore.instance = undefined;
    }
}
