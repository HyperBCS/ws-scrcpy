import * as fs from 'fs';
import * as path from 'path';
import { resolveDataDir } from '../../dataDir';

const TAG = '[StartBudget]';
const FILE_NAME = 'ios-session-starts.json';
// A burst of short display sessions is what wedges the phone's display service until a reboot:
// six inside about four minutes did it on the bench phone (docs/HANDOFF.md). Three in five
// minutes stays well under that and still covers a retry or two.
const START_LIMIT = 3;
const START_WINDOW_MS = 5 * 60 * 1000;

/**
 * How many times serve-web was started for each phone, and when. Kept in the data directory so a
 * server restart (a crash loop, or a dev rebuild) does not hand every phone a fresh allowance.
 */
export class StartBudget {
    private starts?: Map<string, number[]>;
    private warned = false;

    /** `IOS_SESSION_START_LIMIT`: starts allowed per window. 0 turns the budget off. */
    public static limit(): number {
        const override = Number(process.env.IOS_SESSION_START_LIMIT);
        return process.env.IOS_SESSION_START_LIMIT && Number.isInteger(override) && override >= 0
            ? override
            : START_LIMIT;
    }

    /** `IOS_SESSION_START_WINDOW_MS`: the length of the window. */
    public static windowMs(): number {
        const override = Number(process.env.IOS_SESSION_START_WINDOW_MS);
        return Number.isFinite(override) && override > 0 ? override : START_WINDOW_MS;
    }

    /** Milliseconds until this phone may be started again; 0 when it may be started now. */
    public waitMs(udid: string, now = Date.now()): number {
        const limit = StartBudget.limit();
        if (limit === 0) {
            return 0;
        }
        const recent = this.recent(udid, now);
        if (recent.length < limit) {
            return 0;
        }
        // The start that has to leave the window before the count drops below the limit.
        return Math.max(0, recent[recent.length - limit] + StartBudget.windowMs() - now);
    }

    public record(udid: string, now = Date.now()): void {
        const recent = this.recent(udid, now);
        recent.push(now);
        this.load().set(udid, recent);
        this.save(now);
    }

    private recent(udid: string, now: number): number[] {
        const from = now - StartBudget.windowMs();
        // A timestamp ahead of the clock means the clock was set back; it says nothing useful.
        return (this.load().get(udid) || []).filter((time) => time > from && time <= now);
    }

    private static file(): string {
        return path.join(resolveDataDir(), FILE_NAME);
    }

    private load(): Map<string, number[]> {
        if (this.starts) {
            return this.starts;
        }
        const starts = new Map<string, number[]>();
        try {
            const parsed: unknown = JSON.parse(fs.readFileSync(StartBudget.file(), 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                for (const [udid, times] of Object.entries(parsed)) {
                    if (Array.isArray(times)) {
                        starts.set(
                            udid,
                            times.filter((time) => typeof time === 'number' && Number.isFinite(time)),
                        );
                    }
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.error(`${TAG} Ignoring unreadable ${FILE_NAME}: ${(error as Error).message}`);
            }
        }
        this.starts = starts;
        return starts;
    }

    private save(now: number): void {
        const kept: Record<string, number[]> = {};
        for (const udid of Array.from(this.load().keys())) {
            const recent = this.recent(udid, now);
            if (recent.length) {
                kept[udid] = recent;
            } else {
                this.load().delete(udid);
            }
        }
        const file = StartBudget.file();
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            // Written beside the target and renamed, so a crash cannot leave half a file.
            const draft = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(draft, JSON.stringify(kept));
            fs.renameSync(draft, file);
        } catch (error) {
            // The count still holds for this process; only restarts lose it.
            if (!this.warned) {
                this.warned = true;
                console.error(`${TAG} Could not save ${FILE_NAME}: ${(error as Error).message}`);
            }
        }
    }
}
