import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { childEnvironment, getSettings } from '../Settings';

const RESTART_MS = 3000;
const RESTART_MAX_MS = 60000;
const STABLE_MS = 60000;
const LINE_LIMIT = 131072;
const LOG_LIMIT = 16384;
const STARTING = 'Bluetooth collector is starting; try again shortly';
const WRITE_FAILED = 'Bluetooth collector could not accept the command';

export interface CollectorCallbacks {
    commands(): object[];
    started(at: number): void;
    message(message: Record<string, unknown>): void;
    fault(message: string): void;
    stderr(started: number): void;
    stopped(expected: boolean, started: number): void;
}

interface CollectorRuntime {
    spawn: typeof spawn;
    script(): string | undefined;
    now(): number;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
}

const runtime: CollectorRuntime = {
    spawn,
    script: () =>
        [
            path.resolve(process.cwd(), 'python/notifications/collector.py'),
            path.resolve(process.cwd(), '../python/notifications/collector.py'),
        ].find((file) => fs.existsSync(file)),
    now: () => Date.now(),
    setTimeout,
    clearTimeout,
};

/** Owns one collector and its retry timer. Domain state stays with NotificationService. */
export class CollectorProcess {
    private child?: ChildProcessWithoutNullStreams;
    private restart?: NodeJS.Timeout;
    private expectedExit?: ChildProcessWithoutNullStreams;
    private closed = false;
    private version = 0;
    private startedAt = 0;
    private restarts = 0;
    private writes = new Set<(error: Error) => void>();
    private readonly runtime: CollectorRuntime;

    constructor(
        private readonly callbacks: CollectorCallbacks,
        overrides: Partial<CollectorRuntime> = {},
    ) {
        this.runtime = { ...runtime, ...overrides };
    }

    /** Changes whenever a child takes ownership or that ownership ends. */
    get generation(): number {
        return this.version;
    }

    get started(): number {
        return this.startedAt;
    }

    restartCount(): number {
        if (this.child && this.runtime.now() - this.startedAt >= STABLE_MS) this.restarts = 0;
        return this.restarts;
    }

    private restartDelay(expected: boolean, uptime: number): number {
        if (expected) return RESTART_MS;
        if (uptime >= STABLE_MS) this.restarts = 0;
        return Math.min(RESTART_MAX_MS, RESTART_MS * 2 ** this.restarts++);
    }

    resume(): void {
        this.closed = false;
        this.start();
    }

    start(): void {
        if (this.closed || this.child || !getSettings().notificationsCollector) return;
        if (this.restart) this.runtime.clearTimeout(this.restart);
        this.restart = undefined;
        const script = this.runtime.script();
        if (!script) {
            this.callbacks.fault('Bluetooth collector is not installed');
            return;
        }
        const child = this.runtime.spawn(getSettings().bluetoothPython, [script], {
            stdio: 'pipe',
            env: childEnvironment(),
        });
        this.child = child;
        this.version++;
        const started = this.runtime.now();
        this.startedAt = started;
        this.callbacks.started(started);
        const current = () => !this.closed && this.child === child;
        let pending = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            if (!current()) return;
            pending += chunk;
            if (pending.length > LINE_LIMIT) {
                child.kill('SIGTERM');
                return;
            }
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0 && current()) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                try {
                    this.callbacks.message(JSON.parse(line));
                } catch {
                    this.callbacks.fault('Invalid Bluetooth collector event');
                }
            }
        });
        let logged = 0;
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            if (!current()) return;
            this.callbacks.stderr(started);
            if (logged >= LOG_LIMIT) return;
            const text = chunk.slice(0, LOG_LIMIT - logged);
            logged += text.length;
            console.error(`[NotificationService] collector: ${text.trimEnd()}`);
            if (logged >= LOG_LIMIT)
                console.error('[NotificationService] collector: further output from this process is not logged');
        });
        child.stdin.on('error', () => {
            if (current()) this.rejectWrites(Error(WRITE_FAILED));
        });
        child.on('error', () => {
            if (current()) this.callbacks.fault('Could not start Bluetooth collector');
        });
        child.on('close', () => {
            if (!current()) return;
            this.child = undefined;
            this.version++;
            this.rejectWrites(Error(STARTING));
            const expected = this.expectedExit === child;
            this.expectedExit = undefined;
            this.callbacks.stopped(expected, started);
            const retry = this.runtime.setTimeout(
                () => {
                    if (this.closed || this.restart !== retry) return;
                    this.restart = undefined;
                    this.start();
                },
                this.restartDelay(expected, this.runtime.now() - started),
            );
            this.restart = retry;
        });
        let startupFailed = false;
        for (const command of this.callbacks.commands()) {
            void this.command(command).catch(() => {
                if (!current() || startupFailed) return;
                startupFailed = true;
                this.callbacks.fault(WRITE_FAILED);
            });
        }
    }

    /** Resolving a write only means the pipe accepted it; phone actions need their own confirmation. */
    command(command: object): Promise<void> {
        const child = this.child;
        if (this.closed || !child?.stdin.writable) return Promise.reject(Error(STARTING));
        return new Promise<void>((resolve, reject) => {
            const fail = (error: Error) => {
                if (!this.writes.delete(fail)) return;
                reject(error);
            };
            this.writes.add(fail);
            try {
                child.stdin.write(JSON.stringify(command) + '\n', (error) => {
                    if (error) fail(Error(WRITE_FAILED));
                    else if (this.closed || this.child !== child) fail(Error(STARTING));
                    else if (this.writes.delete(fail)) resolve();
                });
            } catch {
                fail(Error(WRITE_FAILED));
            }
        });
    }

    private rejectWrites(error: Error): void {
        for (const fail of this.writes) fail(error);
    }

    /** A changed or removed phone restarts the collector without counting a failure. */
    restartCollector(): void {
        this.expectedExit = this.child;
        this.child?.kill('SIGTERM');
    }

    release(): void {
        this.closed = true;
        this.version++;
        if (this.restart) this.runtime.clearTimeout(this.restart);
        this.restart = undefined;
        const child = this.child;
        this.child = undefined;
        this.expectedExit = undefined;
        this.rejectWrites(Error(STARTING));
        child?.kill('SIGTERM');
    }
}
