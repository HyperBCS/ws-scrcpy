import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveDataDir } from '../../dataDir';
import {
    DEFAULT_UNLOCK_TIME,
    isValidUnlockTime,
    nextUnlockRunAt,
    UnlockRunResult,
    UnlockSchedulePatch,
    UnlockScheduleStatus,
} from '../../../common/IosUnlockSchedule';

const TAG = '[IosSettingsStore]';

/** `ios-settings.json` in the data directory, next to `notifications.json`. */
export const IOS_SETTINGS_FILE = 'ios-settings.json';
/** 32 random bytes, 0600, written on the first `setPasscode` unless `WS_IOS_SETTINGS_KEY` is set. */
export const IOS_SETTINGS_KEY_FILE = 'ios-settings.key';
/** 64 hex characters. When set, no key file is written or read. */
export const IOS_SETTINGS_KEY_ENV = 'WS_IOS_SETTINGS_KEY';

const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_HEX = /^[0-9a-f]{64}$/i;
const UNREADABLE_KEY_MISSING = 'Stored passcode unreadable: key file missing';
const UNREADABLE_DECRYPT = 'Stored passcode unreadable: decryption failed';

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isEncryptedPasscode(value: unknown): value is EncryptedPasscode {
    return (
        isPlainObject(value) &&
        typeof value.iv === 'string' &&
        typeof value.tag === 'string' &&
        typeof value.data === 'string'
    );
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** One device's record as read from disk, or `undefined` when it is not usable. */
function sanitizeUnlock(value: unknown): StoredUnlockSettings | undefined {
    if (!isPlainObject(value) || typeof value.enabled !== 'boolean' || !isValidUnlockTime(value.time)) {
        return undefined;
    }
    const unlock: StoredUnlockSettings = { enabled: value.enabled, time: value.time };
    if (isEncryptedPasscode(value.passcode)) {
        unlock.passcode = value.passcode;
    }
    if (isPlainObject(value.lastRun)) {
        unlock.lastRun = value.lastRun as unknown as UnlockRunResult;
    }
    for (const field of ['lastUnlockedAt', 'retryAt', 'lastSlotAt'] as const) {
        const at = optionalNumber(value[field]);
        if (at !== undefined) {
            unlock[field] = at;
        }
    }
    return unlock;
}

/**
 * Settings and the encrypted unlock passcode for each iPhone, under the server data directory.
 * File layout and cipher parameters are in the plan (section 3.3) and the constants above.
 *
 * Responsibility split: `ControlCenter` never calls this class. All four unlock commands go to
 * `UnlockScheduler`, which owns the only reference to the store (`IosSettingsStore.getInstance()`
 * by default, an in-memory `UnlockSettingsStore` in tests) and emits `status` after each change,
 * so the descriptor update path is the same for a command and for a run. Owned by W1.
 *
 * The key is read from disk (or the environment) whenever it is needed and never cached, so a
 * key file removed while the server runs is noticed by the next `getSchedule`. The plaintext
 * passcode exists only inside `setPasscode` and `readPasscode`.
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

    private loaded = false;
    private loadedAt = 0;
    // An unusable `WS_IOS_SETTINGS_KEY` is logged once, not on every status read.
    private keyEnvReported = false;
    private file: IosSettingsFile = { version: 1, devices: {} };

    /** `directory` is a test seam; production uses the data directory. */
    constructor(public readonly directory: string = resolveDataDir()) {}

    public load(): void {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        this.loadedAt = Date.now();
        this.file = { version: 1, devices: {} };
        try {
            fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        } catch (error) {
            console.error(`${TAG} could not create ${this.directory}: ${(error as Error).message}`);
            return;
        }
        const name = path.join(this.directory, IOS_SETTINGS_FILE);
        if (!fs.existsSync(name)) {
            return;
        }
        try {
            const parsed: unknown = JSON.parse(fs.readFileSync(name, 'utf8'));
            if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.devices)) {
                throw new Error('unexpected file layout');
            }
            for (const [udid, entry] of Object.entries(parsed.devices)) {
                const unlock = isPlainObject(entry) ? sanitizeUnlock(entry.unlock) : undefined;
                if (unlock) {
                    this.file.devices[udid] = { unlock };
                }
            }
        } catch (error) {
            // Start empty rather than fail the tracker. The file is replaced on the next write.
            console.error(`${TAG} could not read ${IOS_SETTINGS_FILE}: ${(error as Error).message}`);
            this.file = { version: 1, devices: {} };
        }
    }

    public listUdids(): string[] {
        this.load();
        return Object.keys(this.file.devices).filter((udid) => !!this.file.devices[udid].unlock);
    }

    public getSchedule(udid: string): UnlockScheduleStatus {
        this.load();
        const record = this.file.devices[udid]?.unlock;
        if (!record) {
            return { enabled: false, time: DEFAULT_UNLOCK_TIME, hasPasscode: false };
        }
        const status: UnlockScheduleStatus = {
            enabled: record.enabled,
            time: record.time,
            hasPasscode: !!record.passcode,
        };
        if (record.lastUnlockedAt !== undefined) {
            status.lastUnlockedAt = record.lastUnlockedAt;
        }
        if (record.lastRun) {
            status.lastRun = { ...record.lastRun };
        }
        if (record.passcode && !this.readKey()) {
            // Ciphertext without a key: every run is skipped until the passcode is entered again,
            // so the panel shows that instead of the outcome of the last run that had a key.
            status.hasPasscode = false;
            status.lastRun = {
                at: Math.max(this.loadedAt, record.lastRun?.at ?? 0),
                trigger: record.lastRun?.trigger ?? 'schedule',
                outcome: 'skipped-no-passcode',
                message: UNREADABLE_KEY_MISSING,
            };
        }
        if (status.enabled && status.hasPasscode) {
            status.nextRunAt = nextUnlockRunAt(status.time, Date.now());
        }
        return status;
    }

    public getRunState(udid: string): UnlockRunState {
        this.load();
        const record = this.file.devices[udid]?.unlock;
        const state: UnlockRunState = {};
        if (!record) {
            return state;
        }
        for (const field of ['lastUnlockedAt', 'retryAt', 'lastSlotAt'] as const) {
            if (record[field] !== undefined) {
                state[field] = record[field];
            }
        }
        return state;
    }

    public updateSchedule(udid: string, patch: UnlockSchedulePatch): UnlockScheduleStatus {
        const record = this.record(udid);
        if (typeof patch.enabled === 'boolean') {
            record.enabled = patch.enabled;
        }
        if (isValidUnlockTime(patch.time)) {
            record.time = patch.time;
        }
        this.write();
        return this.getSchedule(udid);
    }

    public setPasscode(udid: string, passcode: string): UnlockScheduleStatus {
        const key = this.readKey() || this.createKeyFile();
        const record = this.record(udid);
        const iv = crypto.randomBytes(IV_BYTES);
        const cipher = crypto.createCipheriv(CIPHER, key, iv);
        cipher.setAAD(Buffer.from(udid, 'utf8'));
        const data = Buffer.concat([cipher.update(passcode, 'utf8'), cipher.final()]);
        record.passcode = {
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            data: data.toString('base64'),
        };
        this.write();
        return this.getSchedule(udid);
    }

    public clearPasscode(udid: string): UnlockScheduleStatus {
        const record = this.record(udid);
        delete record.passcode;
        this.write();
        return this.getSchedule(udid);
    }

    public readPasscode(udid: string): string {
        this.load();
        const stored = this.file.devices[udid]?.unlock?.passcode;
        if (!stored) {
            throw new Error('No passcode stored');
        }
        const key = this.readKey();
        if (!key) {
            throw new Error(UNREADABLE_KEY_MISSING);
        }
        try {
            const iv = Buffer.from(stored.iv, 'base64');
            const tag = Buffer.from(stored.tag, 'base64');
            if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
                throw new Error('bad parameters');
            }
            const decipher = crypto.createDecipheriv(CIPHER, key, iv);
            decipher.setAAD(Buffer.from(udid, 'utf8'));
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]).toString(
                'utf8',
            );
        } catch {
            // The cipher's own message is dropped: it must not carry anything about the plaintext.
            throw new Error(UNREADABLE_DECRYPT);
        }
    }

    public recordUnlockedAt(udid: string, at: number): void {
        this.record(udid).lastUnlockedAt = at;
        this.write();
    }

    public recordRun(udid: string, result: UnlockRunResult): void {
        this.record(udid).lastRun = { ...result };
        this.write();
    }

    public setRetryAt(udid: string, at: number | undefined): void {
        const record = this.record(udid);
        if (at === undefined) {
            delete record.retryAt;
        } else {
            record.retryAt = at;
        }
        this.write();
    }

    public setLastSlotAt(udid: string, at: number): void {
        this.record(udid).lastSlotAt = at;
        this.write();
    }

    public release(): void {
        if (IosSettingsStore.instance === this) {
            IosSettingsStore.instance = undefined;
        }
    }

    /** The device's record, created with defaults when it is new. */
    private record(udid: string): StoredUnlockSettings {
        this.load();
        let entry = this.file.devices[udid];
        if (!entry) {
            entry = this.file.devices[udid] = {};
        }
        if (!entry.unlock) {
            entry.unlock = { enabled: false, time: DEFAULT_UNLOCK_TIME };
        }
        return entry.unlock;
    }

    private write(): void {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        this.writePrivate(IOS_SETTINGS_FILE, JSON.stringify(this.file));
    }

    /** Temp-file-then-rename, 0600, like `NotificationStorage.write`. */
    private writePrivate(name: string, content: string | Buffer): void {
        const file = path.join(this.directory, name);
        fs.writeFileSync(file + '.tmp', content, { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
    }

    /**
     * The 32-byte key: `WS_IOS_SETTINGS_KEY` when set, else the key file. `undefined` when
     * neither is usable, which `getSchedule` reports and `readPasscode` throws on.
     */
    private readKey(): Buffer | undefined {
        const fromEnv = process.env[IOS_SETTINGS_KEY_ENV];
        if (fromEnv !== undefined && fromEnv !== '') {
            if (!KEY_HEX.test(fromEnv)) {
                if (!this.keyEnvReported) {
                    this.keyEnvReported = true;
                    console.error(
                        `${TAG} ${IOS_SETTINGS_KEY_ENV} must be 64 hex characters; stored passcodes are unreadable`,
                    );
                }
                return undefined;
            }
            return Buffer.from(fromEnv, 'hex');
        }
        const file = path.join(this.directory, IOS_SETTINGS_KEY_FILE);
        try {
            const key = fs.readFileSync(file);
            return key.length === KEY_BYTES ? key : undefined;
        } catch {
            return undefined;
        }
    }

    /** First `setPasscode` without a key: write a random one. Not reached while the env var is set. */
    private createKeyFile(): Buffer {
        if (process.env[IOS_SETTINGS_KEY_ENV]) {
            throw new Error(`${IOS_SETTINGS_KEY_ENV} is set but not a valid key (64 hex characters)`);
        }
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const key = crypto.randomBytes(KEY_BYTES);
        this.writePrivate(IOS_SETTINGS_KEY_FILE, key);
        return key;
    }
}
