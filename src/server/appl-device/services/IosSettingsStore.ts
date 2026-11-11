import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveDataDir } from '../../dataDir';
import {
    DEFAULT_UNLOCK_TIME,
    isPasscodeLockout,
    isValidUnlockTime,
    isValidUnlockTimeZone,
    localTimeZone,
    nextUnlockRunAt,
    UNLOCK_BY_HAND_ACTION,
    UNLOCK_NOT_TYPED_MESSAGE,
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
/** A path for the key file outside the data directory, such as a Docker secret. */
export const IOS_SETTINGS_KEY_FILE_ENV = 'WS_IOS_SETTINGS_KEY_FILE';
/** A settings file that could not be read is moved here, so the next write does not destroy it. */
export const IOS_SETTINGS_BAD_FILE = 'ios-settings.json.bad';

const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_HEX = /^[0-9a-f]{64}$/i;
const UNREADABLE_KEY_MISSING = 'Stored passcode unreadable: key file missing';
const UNREADABLE_DECRYPT = 'Stored passcode unreadable: decryption failed';

let envKey: string | undefined;

/**
 * The key from `WS_IOS_SETTINGS_KEY`, taken out of the environment the first time it is seen. The
 * server starts Python tools, ffmpeg and the Bluetooth collector as child processes, and each
 * would otherwise inherit the key. This runs when the module loads, which is before any service
 * starts, and again on each read in case the variable was set later.
 */
function takeEnvKey(): string | undefined {
    const value = process.env[IOS_SETTINGS_KEY_ENV];
    if (value !== undefined) {
        envKey = value;
        delete process.env[IOS_SETTINGS_KEY_ENV];
    }
    return envKey;
}
takeEnvKey();

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
    // IANA zone of `time`. Absent on a record written before zones were stored: server local time.
    timeZone?: string;
    passcode?: EncryptedPasscode;
    // Last time the phone was seen going from locked to unlocked, by any means.
    lastUnlockedAt?: number;
    // Last time the server typed the passcode and saw the phone unlock. Only this counts for the
    // skip rule: an unlock that was only observed may have been Face ID.
    lastTypedUnlockAt?: number;
    lastRun?: UnlockRunResult;
    // Start of the last slot that was taken up, written before its run starts.
    lastSlotAt?: number;
    // Set while that slot still owes a run: the earliest time of the next attempt. In the past
    // while the run waits for a phone in use to be locked. Moved an hour on before each run
    // starts, so a server that keeps restarting does not open a session each time.
    retryAt?: number;
    // Failed attempts for that slot: the first is retried after ten minutes, later ones hourly.
    slotAttempts?: number;
    // When a run typed this passcode and the phone stayed locked. Cleared by `setPasscode`.
    passcodeRejectedAt?: number;
    // Runs in a row that typed the passcode without a confirmed unlock.
    unconfirmedAttempts?: number;
    // When the phone refused a connection until its passcode is entered on the phone. Removed
    // when a run or the state monitor reaches the phone again.
    lockedOutAt?: number;
    // The passcode-entry time the 20-hour warning was pushed for.
    warnedFor?: number;
}

const RUN_STATE_FIELDS = [
    'lastUnlockedAt',
    'lastTypedUnlockAt',
    'lastSlotAt',
    'retryAt',
    'slotAttempts',
    'passcodeRejectedAt',
    'unconfirmedAttempts',
    'lockedOutAt',
    'warnedFor',
] as const;

export interface IosSettingsFile {
    version: 1;
    devices: Record<string, { unlock?: StoredUnlockSettings }>;
}

/** The scheduler's bookkeeping, read back by `UnlockScheduler.tick()`. */
export type UnlockRunState = Pick<StoredUnlockSettings, (typeof RUN_STATE_FIELDS)[number]>;

/**
 * What `UnlockScheduler` needs from the store. `IosSettingsStore` implements it against the
 * files above; the scheduler's tests implement it in memory. Every method is synchronous:
 * writes go temp-file-then-rename like `NotificationStorage.write`, and none of them throws for
 * a missing or unreadable key file. Only `readPasscode` decrypts, and it throws instead of
 * returning `undefined` so a caller cannot send an empty passcode by mistake; its error text
 * never contains the passcode.
 */
export interface UnlockSettingsStore {
    /** Create the directory (0700) and read the settings file. Idempotent. Never throws at startup. */
    load(): void;
    /**
     * What stops stored schedules from running, in plain sentences for a push: a settings file
     * that could not be read, or a schedule that is on while its passcode cannot be decrypted.
     * Empty when all is well.
     */
    getProblems(): string[];
    /** Every udid with an unlock record. */
    listUdids(): string[];
    /**
     * Public status of one device, defaults for an unknown udid (`enabled: false`,
     * `time: DEFAULT_UNLOCK_TIME`, `hasPasscode: false`). `nextRunAt` is
     * `nextUnlockRunAt(time, Date.now(), timeZone)` while `enabled && hasPasscode` and the
     * passcode has not been rejected, else absent. `needsManualUnlock` is set while `lockedOutAt`
     * is. `running` and `waitingForLock` are never set here; the scheduler adds them and may
     * bring `nextRunAt` forward to `retryAt`.
     * `hasPasscode` is false when ciphertext exists but cannot be decrypted (key file missing);
     * then `lastRun.message` reads "Stored passcode unreadable: key file missing".
     */
    getSchedule(udid: string): UnlockScheduleStatus;
    /** The scheduler's own fields for `tick()`. */
    getRunState(udid: string): UnlockRunState;
    /** Apply a validated patch and persist. Returns the new status. */
    updateSchedule(udid: string, patch: UnlockSchedulePatch): UnlockScheduleStatus;
    /**
     * Encrypt and persist a validated passcode, creating the key file if needed, and clear the
     * rejected mark and the unconfirmed count of the passcode it replaces. Returns the new status.
     */
    setPasscode(udid: string, passcode: string): UnlockScheduleStatus;
    /** Remove the ciphertext and its rejected mark; `enabled` is left as it is. Returns the new status. */
    clearPasscode(udid: string): UnlockScheduleStatus;
    /** Decrypt the stored passcode. Throws when none is stored or it cannot be decrypted. */
    readPasscode(udid: string): string;
    recordUnlockedAt(udid: string, at: number): void;
    recordRun(udid: string, result: UnlockRunResult): void;
    setRetryAt(udid: string, at: number | undefined): void;
    setLastSlotAt(udid: string, at: number): void;
    /** Set the given bookkeeping fields; a field given as `undefined` is removed. */
    setRunState(udid: string, patch: Partial<UnlockRunState>): void;
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
    if (isValidUnlockTimeZone(value.timeZone)) {
        unlock.timeZone = value.timeZone;
    }
    if (isEncryptedPasscode(value.passcode)) {
        unlock.passcode = value.passcode;
    }
    if (isPlainObject(value.lastRun)) {
        unlock.lastRun = value.lastRun as unknown as UnlockRunResult;
    }
    for (const field of RUN_STATE_FIELDS) {
        const at = optionalNumber(value[field]);
        if (at !== undefined) {
            unlock[field] = at;
        }
    }
    // Before the 2026-11-10 review a run that typed the passcode and found the phone still locked
    // was also `failed-still-locked`, and the passcode was typed again at the retry and every night
    // after. A record left that way is read as `failed-rejected`, which marks the passcode rejected.
    const last = unlock.lastRun;
    if (
        last?.outcome === 'failed-still-locked' &&
        !(typeof last.message === 'string' && last.message.startsWith(UNLOCK_NOT_TYPED_MESSAGE))
    ) {
        last.outcome = 'failed-rejected';
        if (unlock.passcode && unlock.passcodeRejectedAt === undefined) {
            unlock.passcodeRejectedAt = optionalNumber(last.at) ?? Date.now();
        }
    }
    // Before 2026-11-11 a phone that refused the connection until its passcode was entered ended
    // the run as `failed-session` with pymobiledevice3's message. A record left that way is read
    // as `needs-manual-unlock`, and the phone as still refusing until something reaches it.
    if (last?.outcome === 'failed-session' && isPasscodeLockout(last.message)) {
        last.outcome = 'needs-manual-unlock';
        last.message = UNLOCK_BY_HAND_ACTION;
        if (unlock.lockedOutAt === undefined) {
            unlock.lockedOutAt = optionalNumber(last.at) ?? Date.now();
        }
    }
    return unlock;
}

/**
 * Settings and the encrypted unlock passcode for each iPhone, under the server data directory.
 * The file layout is `IosSettingsFile`: per udid, an optional `unlock` record
 * (`StoredUnlockSettings`). The cipher parameters are on `EncryptedPasscode` and in the
 * constants above.
 *
 * Responsibility split: `ControlCenter` never calls this class. All four unlock commands go to
 * `UnlockScheduler`, which owns the only reference to the store (`IosSettingsStore.getInstance()`
 * by default, an in-memory `UnlockSettingsStore` in tests) and emits `status` after each change,
 * so the descriptor update path is the same for a command and for a run.
 *
 * The key file is read whenever the key is needed and never cached, so a key file removed while
 * the server runs is noticed by the next `getSchedule`. A key from the environment is read once
 * and removed from it (`takeEnvKey`). The plaintext passcode exists only inside `setPasscode` and
 * `readPasscode`.
 *
 * What the encryption is worth: with the key file in the data directory, anything that can read
 * that directory (a backup, a copy of the Docker volume) has both halves. It stops a casual look
 * at the settings file and no more. `WS_IOS_SETTINGS_KEY_FILE` or `WS_IOS_SETTINGS_KEY` keep the
 * key somewhere else.
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

    /** Test seam: drop the key taken from the environment, as a new process would start. */
    public static forgetEnvKey(): void {
        envKey = undefined;
    }

    private loaded = false;
    private loadedAt = 0;
    // An unusable `WS_IOS_SETTINGS_KEY` is logged once, not on every status read.
    private keyEnvReported = false;
    private directoryModeReported = false;
    // Why the settings file was not used, for `getProblems`.
    private loadProblem?: string;
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
            this.ensureDirectory();
        } catch (error) {
            console.error(`${TAG} could not create ${this.directory}: ${(error as Error).message}`);
            this.loadProblem = 'The iPhone settings directory could not be created. Scheduled unlock cannot run.';
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
            // Start empty rather than fail the tracker, and move the file aside: the next write
            // would replace it, and it may hold the only copy of a schedule and its ciphertext.
            console.error(`${TAG} could not read ${IOS_SETTINGS_FILE}: ${(error as Error).message}`);
            this.file = { version: 1, devices: {} };
            let kept = `It was kept as ${IOS_SETTINGS_BAD_FILE}.`;
            try {
                fs.renameSync(name, path.join(this.directory, IOS_SETTINGS_BAD_FILE));
            } catch (renameError) {
                kept = 'It will be replaced on the next change.';
                console.error(`${TAG} could not keep the unreadable file: ${(renameError as Error).message}`);
            }
            this.loadProblem = `${IOS_SETTINGS_FILE} could not be read, so no scheduled unlock is set. ${kept}`;
        }
    }

    public getProblems(): string[] {
        this.load();
        const problems = this.loadProblem ? [this.loadProblem] : [];
        const unreadable = Object.values(this.file.devices).some(
            (entry) => entry.unlock?.enabled && entry.unlock.passcode,
        );
        if (unreadable && !this.readKey()) {
            problems.push(`${UNREADABLE_KEY_MISSING}. Scheduled unlock cannot run until the passcode is saved again.`);
        }
        return problems;
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
        if (record.timeZone) {
            status.timeZone = record.timeZone;
        } else {
            status.serverTimeZone = localTimeZone();
        }
        if (status.hasPasscode && record.passcodeRejectedAt !== undefined) {
            status.passcodeRejected = true;
        }
        if (record.lockedOutAt !== undefined) {
            status.needsManualUnlock = true;
        }
        if (status.enabled && status.hasPasscode && !status.passcodeRejected) {
            status.nextRunAt = nextUnlockRunAt(status.time, Date.now(), record.timeZone);
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
        for (const field of RUN_STATE_FIELDS) {
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
        if (isValidUnlockTimeZone(patch.timeZone)) {
            record.timeZone = patch.timeZone;
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
        delete record.passcodeRejectedAt;
        delete record.unconfirmedAttempts;
        this.write();
        return this.getSchedule(udid);
    }

    public clearPasscode(udid: string): UnlockScheduleStatus {
        const record = this.record(udid);
        delete record.passcode;
        delete record.passcodeRejectedAt;
        delete record.unconfirmedAttempts;
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

    public setRunState(udid: string, patch: Partial<UnlockRunState>): void {
        const record = this.record(udid);
        for (const field of RUN_STATE_FIELDS) {
            if (!(field in patch)) {
                continue;
            }
            const value = patch[field];
            if (value === undefined) {
                delete record[field];
            } else {
                record[field] = value;
            }
        }
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
        this.ensureDirectory();
        this.writePrivate(path.join(this.directory, IOS_SETTINGS_FILE), JSON.stringify(this.file));
    }

    /**
     * The data directory, private to the server's user. `mkdir`'s mode only applies to a directory
     * it creates, and a Docker volume root or a directory made by another tool already exists, so
     * the mode is set as well. A directory owned by someone else keeps its mode.
     */
    private ensureDirectory(): void {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        try {
            if ((fs.statSync(this.directory).mode & 0o777) !== 0o700) {
                fs.chmodSync(this.directory, 0o700);
            }
        } catch (error) {
            if (!this.directoryModeReported) {
                this.directoryModeReported = true;
                console.error(`${TAG} could not make ${this.directory} private: ${(error as Error).message}`);
            }
        }
    }

    /** Temp-file-then-rename, 0600, like `NotificationStorage.write`. */
    private writePrivate(file: string, content: string | Buffer): void {
        fs.writeFileSync(file + '.tmp', content, { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
    }

    /** `WS_IOS_SETTINGS_KEY_FILE`, else `ios-settings.key` in the data directory. */
    private keyFile(): string {
        const elsewhere = process.env[IOS_SETTINGS_KEY_FILE_ENV];
        return elsewhere ? path.resolve(elsewhere) : path.join(this.directory, IOS_SETTINGS_KEY_FILE);
    }

    /**
     * The 32-byte key: `WS_IOS_SETTINGS_KEY` when set, else the key file. `undefined` when
     * neither is usable, which `getSchedule` reports and `readPasscode` throws on.
     */
    private readKey(): Buffer | undefined {
        const fromEnv = takeEnvKey();
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
        try {
            const key = fs.readFileSync(this.keyFile());
            if (key.length === KEY_BYTES) {
                return key;
            }
            // A secret written by hand or by a secrets manager is text: the same 64 hex characters.
            const text = key.toString('utf8').trim();
            return KEY_HEX.test(text) ? Buffer.from(text, 'hex') : undefined;
        } catch {
            return undefined;
        }
    }

    /** First `setPasscode` without a key: write a random one. Not reached while the env var is set. */
    private createKeyFile(): Buffer {
        if (takeEnvKey()) {
            throw new Error(`${IOS_SETTINGS_KEY_ENV} is set but not a valid key (64 hex characters)`);
        }
        const file = this.keyFile();
        const key = crypto.randomBytes(KEY_BYTES);
        if (!process.env[IOS_SETTINGS_KEY_FILE_ENV]) {
            this.ensureDirectory();
            this.writePrivate(file, key);
            return key;
        }
        if (fs.existsSync(file)) {
            // Never replaced: it may be the key for ciphertext stored elsewhere.
            throw new Error(
                `${IOS_SETTINGS_KEY_FILE_ENV} names a file that is not a key (32 bytes or 64 hex characters)`,
            );
        }
        // The system's own message can name paths; the caller's error goes to a browser.
        let written = true;
        try {
            this.writePrivate(file, key);
        } catch (error) {
            written = false;
            console.error(`${TAG} could not write the key file: ${(error as Error).message}`);
        }
        if (!written) {
            throw new Error(`The key file named by ${IOS_SETTINGS_KEY_FILE_ENV} could not be written`);
        }
        return key;
    }
}
