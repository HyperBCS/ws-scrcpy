import * as fs from 'fs';
import * as path from 'path';
import { randomInt } from 'crypto';
import { Config } from '../Config';
import { resolveDataDir } from '../dataDir';

const TAG = '[ScrcpyInstance]';
const FILE_NAME = 'scrcpy-instance.json';
const SCID_RE = /^[0-7][0-9a-f]{7}$/;

/**
 * The scrcpy "scid" of this server: eight hex digits (31 bits) that go into the launch
 * arguments and into the device socket name, as desktop scrcpy does for each of its runs.
 *
 * It tells this server's scrcpy processes from everyone else's on the same phone: a test server
 * on another port, or desktop scrcpy. Only a process that carries it is counted, reported or
 * stopped. It is kept in the data directory, one per server port, so a restarted server still
 * recognises the process its predecessor left behind.
 */
export class ScrcpyInstance {
    private static scid?: string;

    public static getScid(): string {
        if (!this.scid) {
            this.scid = this.load();
        }
        return this.scid;
    }

    /** Where the device side listens, as an adb forward target. */
    public static socketName(): string {
        return `localabstract:scrcpy_${this.getScid()}`;
    }

    /** Whether a scrcpy command line, split into arguments, belongs to this server. */
    public static owns(args: string[]): boolean {
        return args.includes(`scid=${this.getScid()}`);
    }

    private static load(): string {
        const file = path.join(resolveDataDir(), FILE_NAME);
        const key = String(Config.getInstance().servers[0]?.port ?? 0);
        let stored: Record<string, unknown> = {};
        try {
            const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                stored = parsed as Record<string, unknown>;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.error(TAG, `Could not read ${file}: ${(error as Error).message}`);
            }
        }
        const known = stored[key];
        if (typeof known === 'string' && SCID_RE.test(known)) {
            return known;
        }
        const scid = randomInt(1, 0x7fffffff).toString(16).padStart(8, '0');
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const temporary = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify({ ...stored, [key]: scid }, null, 2));
            fs.renameSync(temporary, file);
        } catch (error) {
            // Still usable for this run. A restart will not recognise what this one leaves behind.
            console.error(TAG, `Could not save ${file}: ${(error as Error).message}`);
        }
        return scid;
    }
}
