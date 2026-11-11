import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { PyMobileDevice } from '../appl-device/services/PyMobileDevice';

const MAX_BYTES = 1024 * 1024;
const MAX_ICONS = 100;
// A phone that answered and had no icon for an app will not have one a minute later.
const NEGATIVE_TTL = 3_600_000;
// For a lookup that did not get an answer (a timeout), or when it is not known whether the
// phone is attached.
const RETRY_TTL = 60_000;
// notification_icon.py exits with this when the phone answered and has no usable icon. It exits
// with 1 when it could not ask the phone, its own 6 s timeout included.
const NO_ICON_EXIT = 3;
const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');

function validPng(value: Buffer): boolean {
    return (
        value.length >= 33 &&
        value.length <= MAX_BYTES &&
        value.subarray(0, 8).equals(PNG_HEADER) &&
        value.readUInt32BE(8) === 13 &&
        value.toString('ascii', 12, 16) === 'IHDR' &&
        value.readUInt32BE(16) > 0 &&
        value.readUInt32BE(16) <= 1024 &&
        value.readUInt32BE(20) > 0 &&
        value.readUInt32BE(20) <= 1024
    );
}

/** `true`: on USB and trusted. `false`: not reachable over USB. `undefined`: not known. */
export type IconPhoneCheck = (udid: string) => boolean | undefined;

/** Icons come from the paired phone over USB; no app identifiers leave the NUC. */
export class NotificationIcons {
    private static phoneCheck: IconPhoneCheck = () => undefined;
    /**
     * A sending iPhone is often in Bluetooth range and not on USB. Without this check every
     * missing icon started pymobiledevice3 for up to 8 s, again each minute. A source's id is
     * the phone's UDID.
     */
    static setPhoneCheck(check: IconPhoneCheck): void {
        this.phoneCheck = check;
    }

    private root: string;
    private pending = new Map<string, Promise<Buffer | null>>();
    private failures = new Map<string, number>();
    private generations = new Map<string, number>();
    private active = 0;
    private waiting: Array<() => void> = [];

    constructor(dataDir: string) {
        this.root = path.join(dataDir, 'notification-icons');
    }

    private hash(value: string): string {
        return crypto.createHash('sha256').update(value).digest('hex');
    }

    async get(source: string, app: string): Promise<Buffer | null> {
        if (!/^[\w-]{1,128}$/.test(source) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(app)) return null;
        const sourceKey = this.hash(source);
        const key = `${sourceKey}/${this.hash(app)}`;
        const directory = path.join(this.root, sourceKey);
        const file = path.join(this.root, `${key}.png`);
        try {
            const stat = fs.lstatSync(file);
            if (stat.isFile() && stat.size <= MAX_BYTES) {
                const png = fs.readFileSync(file);
                if (validPng(png)) {
                    try {
                        const now = new Date();
                        fs.utimesSync(file, now, now);
                    } catch {
                        // A read-only cache can still supply a previously fetched icon.
                    }
                    return png;
                }
            }
        } catch {
            // A cache miss, corrupt file, or unavailable disk falls back to the phone.
        }
        if ((this.failures.get(key) || 0) > Date.now()) return null;
        const existing = this.pending.get(key);
        if (existing) return existing;
        // Not remembered as a failure: the icon loads on the first request after the phone is back.
        const reachable = NotificationIcons.phoneCheck(source);
        if (reachable === false) return null;
        if (this.pending.size >= 64) return null;
        const generation = this.generations.get(sourceKey) || 0;
        const operation = this.fetch(source, app, sourceKey, generation)
            .then(({ png, answered }) => {
                if ((this.generations.get(sourceKey) || 0) !== generation) return null;
                if (!png || !validPng(png)) {
                    this.failures.set(key, Date.now() + (reachable && answered ? NEGATIVE_TTL : RETRY_TTL));
                    while (this.failures.size > 1024) this.failures.delete(this.failures.keys().next().value!);
                    return null;
                }
                this.failures.delete(key);
                try {
                    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
                    fs.writeFileSync(file + '.tmp', png, { mode: 0o600 });
                    fs.renameSync(file + '.tmp', file);
                    this.trim(directory);
                } catch {
                    // Showing an icon should not depend on writable persistent storage.
                }
                return png;
            })
            .finally(() => this.pending.delete(key));
        this.pending.set(key, operation);
        return operation;
    }

    /**
     * `answered` is false when the phone was not asked or did not answer in time, so the result
     * says nothing about the icon.
     */
    private async fetch(
        source: string,
        app: string,
        sourceKey: string,
        generation: number,
    ): Promise<{ png: Buffer | null; answered: boolean }> {
        if (this.active >= 2) await new Promise<void>((resolve) => this.waiting.push(resolve));
        else this.active++;
        try {
            if ((this.generations.get(sourceKey) || 0) !== generation) return { png: null, answered: false };
            const probe = PyMobileDevice.probeCommand('notification_icon.py');
            if (!probe) return { png: null, answered: false };
            return await new Promise((resolve) => {
                execFile(
                    probe.command,
                    [...probe.args, source, app],
                    {
                        encoding: 'buffer',
                        timeout: 8000,
                        killSignal: 'SIGKILL',
                        maxBuffer: MAX_BYTES,
                        windowsHide: true,
                    },
                    (error, stdout) =>
                        resolve({
                            png: error ? null : stdout,
                            answered: !error || (error.code === NO_ICON_EXIT && !error.killed),
                        }),
                );
            });
        } catch {
            return { png: null, answered: false };
        } finally {
            const next = this.waiting.shift();
            if (next) next();
            else this.active--;
        }
    }

    private trim(directory: string): void {
        const entries = fs
            .readdirSync(directory)
            .filter((name) => /^[a-f0-9]{64}\.png$/.test(name))
            .map((name) => ({
                file: path.join(directory, name),
                modified: fs.statSync(path.join(directory, name)).mtimeMs,
            }))
            .sort((a, b) => b.modified - a.modified);
        for (const item of entries.slice(MAX_ICONS)) fs.unlinkSync(item.file);
    }

    removeSource(source: string): void {
        const sourceKey = this.hash(source);
        this.generations.set(sourceKey, (this.generations.get(sourceKey) || 0) + 1);
        for (const key of this.failures.keys()) if (key.startsWith(sourceKey + '/')) this.failures.delete(key);
        fs.rmSync(path.join(this.root, sourceKey), { recursive: true, force: true });
    }
}
