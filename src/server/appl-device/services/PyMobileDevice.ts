import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

const TAG = '[pymobiledevice3]';

export type OneShotResult = { stdout: string; stderr: string; code: number | null };

/**
 * Locates and runs the `pymobiledevice3` CLI (https://github.com/doronz88/pymobiledevice3), the
 * one external tool the iOS path needs. It owns usbmuxd device discovery, lockdown, pairing,
 * Developer Mode, the Developer Disk Image mount and -- through its `display serve-web` server --
 * the iOS 27 CoreDevice screen stream and HID injection. Nothing is installed on the phone.
 *
 * Resolution order: `IOS_PYMOBILEDEVICE3` env, the project venv (`npm run setup:ios` creates
 * `python/venv`), then `pymobiledevice3` on PATH. The venv is checked from the working directory
 * and its parent because `npm start` runs from `dist/`.
 */
export class PyMobileDevice {
    private static resolved?: string;

    public static resolveBin(): string {
        if (this.resolved) {
            return this.resolved;
        }
        if (process.env.IOS_PYMOBILEDEVICE3) {
            return (this.resolved = process.env.IOS_PYMOBILEDEVICE3);
        }
        const name = process.platform === 'win32' ? 'Scripts/pymobiledevice3.exe' : 'bin/pymobiledevice3';
        for (const root of [process.cwd(), path.resolve(process.cwd(), '..')]) {
            const candidate = path.join(root, 'python', 'venv', name);
            if (fs.existsSync(candidate)) {
                return (this.resolved = candidate);
            }
        }
        return (this.resolved = 'pymobiledevice3');
    }

    /** Test seam: lets the fixtures point at a fake CLI without touching the environment. */
    public static useBin(bin: string | undefined): void {
        this.resolved = bin;
    }

    /**
     * The repository root, found by the file the probes live in. `npm start` runs from `dist/`,
     * so the parent is checked too, exactly as `resolveBin` does for the venv.
     */
    private static resolveProbe(name: string): string | undefined {
        for (const root of [process.cwd(), path.resolve(process.cwd(), '..')]) {
            const candidate = path.join(root, 'python', 'probes', name);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return undefined;
    }

    /**
     * How to run one of the Python probes in `python/probes/`: the venv interpreter that sits
     * next to the resolved CLI, else `python3` from PATH. `IOS_PROBE_CMD` and `IOS_PROBE_ARGS`
     * (a JSON array, prepended before the script's own arguments) replace both, which is how the
     * tests point the probe at their fake without a Python interpreter in the loop. The stand-in
     * is given the probe's `name` where the interpreter would be given its path, so one fake can
     * answer for several probes.
     * `undefined` when the script cannot be found, so the caller can degrade instead of throwing.
     */
    public static probeCommand(name: string): { command: string; args: string[] } | undefined {
        if (process.env.IOS_PROBE_CMD) {
            let extra: string[];
            try {
                const parsed = JSON.parse(process.env.IOS_PROBE_ARGS || '[]');
                extra = Array.isArray(parsed) ? parsed.map(String) : [];
            } catch {
                extra = [];
            }
            return { command: process.env.IOS_PROBE_CMD, args: [...extra, name] };
        }
        const script = this.resolveProbe(name);
        if (!script) {
            return undefined;
        }
        const bin = this.resolveBin();
        const suffix = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
        const venv = path.join(path.dirname(path.dirname(bin)), suffix);
        const python = fs.existsSync(venv) ? venv : 'python3';
        return { command: python, args: [script] };
    }

    /** Runs a probe from `python/probes/` and parses its single JSON line of stdout. */
    public static async runProbeJson<T = unknown>(
        name: string,
        args: string[],
        timeoutMs: number,
        env: NodeJS.ProcessEnv = {},
    ): Promise<T | undefined> {
        const probe = this.probeCommand(name);
        if (!probe) {
            return undefined;
        }
        const result = await new Promise<OneShotResult>((resolve, reject) => {
            const child = spawn(probe.command, [...probe.args, ...args], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONUNBUFFERED: '1', ...env },
            });
            let stdout = '';
            let stderr = '';
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    child.kill('SIGKILL');
                    reject(new Error(`Timed out running "${name}"`));
                }
            }, timeoutMs);
            child.stdout?.on('data', (data) => (stdout += data));
            child.stderr?.on('data', (data) => (stderr += data));
            child.on('error', (error) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(error);
                }
            });
            child.on('close', (code) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve({ stdout, stderr, code });
                }
            });
        });
        if (result.code !== 0) {
            throw new Error(PyMobileDevice.explain(result.stderr) || `"${name}" exited with ${result.code}`);
        }
        // The probes log to stderr and print one JSON line to stdout; take the last such line.
        const line = result.stdout
            .split('\n')
            .map((item) => item.trim())
            .filter((item) => item.startsWith('{') || item.startsWith('['))
            .pop();
        if (!line) {
            throw new Error(`"${name}" printed no JSON`);
        }
        return JSON.parse(line) as T;
    }

    public static spawnDetached(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
        return spawn(this.resolveBin(), ['--no-color', ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            env: { ...process.env, PYTHONUNBUFFERED: '1', ...env },
        });
    }

    /**
     * Runs one command to completion. Structured logs go to stderr; JSON output to stdout. `env`
     * is for the `developer` commands, which take the tunnel target from PYMOBILEDEVICE3_UDID
     * rather than `--udid`.
     */
    public static runOneShot(
        args: string[],
        timeoutMs = 60000,
        signal?: AbortSignal,
        env: NodeJS.ProcessEnv = {},
    ): Promise<OneShotResult> {
        return new Promise((resolve, reject) => {
            const child = spawn(this.resolveBin(), ['--no-color', ...args], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONUNBUFFERED: '1', ...env },
            });
            let stdout = '';
            let stderr = '';
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    child.kill('SIGKILL');
                    reject(new Error(`Timed out running "pymobiledevice3 ${args.join(' ')}"`));
                }
            }, timeoutMs);
            const onAbort = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    child.kill('SIGKILL');
                    reject(new Error('Cancelled'));
                }
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            child.stdout?.on('data', (data) => (stdout += data));
            child.stderr?.on('data', (data) => (stderr += data));
            child.on('error', (error) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    reject(error);
                }
            });
            child.on('close', (code) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    resolve({ stdout, stderr, code });
                }
            });
        });
    }

    /**
     * Runs a command whose stdout is JSON. A non-zero exit becomes an error carrying the last
     * meaningful stderr line, which is where pymobiledevice3 explains itself (`NotPairedError`,
     * `DeveloperModeIsNotEnabledError`, ...).
     */
    public static async runJson<T = unknown>(
        args: string[],
        timeoutMs = 60000,
        signal?: AbortSignal,
        env: NodeJS.ProcessEnv = {},
    ): Promise<T> {
        const { stdout, stderr, code } = await this.runOneShot(args, timeoutMs, signal, env);
        if (code !== 0) {
            throw new Error(
                PyMobileDevice.explain(stderr) || `"pymobiledevice3 ${args.join(' ')}" exited with ${code}`,
            );
        }
        const text = stdout.trim();
        if (!text) {
            return undefined as T;
        }
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new Error(`Could not parse JSON from "pymobiledevice3 ${args.join(' ')}": ${text.slice(0, 200)}`);
        }
    }

    /**
     * iOS 17+ developer services sit behind the RSD tunnel. Without a tunnel flag the CLI expects
     * a root `tunneld` on the host; the in-process userspace tunnel needs no privileges and is
     * the default. `IOS_TUNNEL=tunneld` opts into an already running `pymobiledevice3 remote tunneld`.
     */
    public static tunnelArgs(udid: string): string[] {
        return process.env.IOS_TUNNEL === 'tunneld' ? ['--tunnel', udid] : ['--userspace'];
    }

    /**
     * The one line of stderr worth showing a user. Structured log lines lose their
     * `date host logger[pid] LEVEL` prefix; Typer's rich "Error" box (`╭─ Error ─╮ │ text │ ╰─╯`)
     * yields its text; a Python traceback yields its final exception line.
     */
    public static explain(stderr: string): string {
        const lines = stderr
            .split('\n')
            .map((line) => line.replace(/^\s*│\s?|\s?│\s*$/g, '').trim())
            .filter((line) => line && !/^[╭╰]/.test(line) && !/^[─╮╯┤├│\s]+$/.test(line));
        const error = [...lines].reverse().find((line) => / ERROR /.test(line) || /Error\b/.test(line));
        const last = error || lines[lines.length - 1] || '';
        // `2026-09-16 00:18:44 host pymobiledevice3.cli.mounter[53683] ERROR message`
        return last.replace(/^\d{4}-\d{2}-\d{2} \S+ \S+ \S+ (?:ERROR|WARNING|INFO|DEBUG|CRITICAL) /, '').slice(0, 300);
    }

    public static log(line: string): void {
        if (process.env.WS_SCRCPY_DEBUG) {
            process.stderr.write(`${TAG} ${line}\n`);
        }
    }
}
