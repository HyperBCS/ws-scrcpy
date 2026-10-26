import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { PyMobileDevice } from '../appl-device/services/PyMobileDevice';

const MAX_BYTES = 1024 * 1024;
const MAX_ICONS = 100;
const NEGATIVE_TTL = 60_000;
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

/** Icons come from the paired phone over USB; no app identifiers leave the NUC. */
export class NotificationIcons {
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
        if (this.pending.size >= 64) return null;
        const generation = this.generations.get(sourceKey) || 0;
        const operation = this.fetch(source, app, sourceKey, generation)
            .then((png) => {
                if ((this.generations.get(sourceKey) || 0) !== generation) return null;
                if (!png || !validPng(png)) {
                    this.failures.set(key, Date.now() + NEGATIVE_TTL);
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

    private async fetch(source: string, app: string, sourceKey: string, generation: number): Promise<Buffer | null> {
        if (this.active >= 2) await new Promise<void>((resolve) => this.waiting.push(resolve));
        else this.active++;
        try {
            if ((this.generations.get(sourceKey) || 0) !== generation) return null;
            const probe = PyMobileDevice.probeCommand('notification_icon.py');
            if (!probe) return null;
            return await new Promise<Buffer | null>((resolve) => {
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
                    (error, stdout) => resolve(error ? null : stdout),
                );
            });
        } catch {
            return null;
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
