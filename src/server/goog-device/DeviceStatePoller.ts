import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { NetInterface } from '../../types/NetInterface';
import { AndroidLockState } from '../../types/AndroidLockState';
import { LOCK_STATE_COMMAND, parseLockState, unknownLockState } from './LockState';
import { Properties } from './Properties';

enum PID_DETECTION {
    UNKNOWN,
    PIDOF,
    GREP_PS,
    GREP_PS_A,
    LS_PROC,
}
type Poll = 'info' | 'runtime' | 'lock' | 'pid';
interface StateSource {
    TAG: string;
    read(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<string>;
    servicePids(strict: boolean, signal: AbortSignal): Promise<number[] | undefined>;
    patch(values: Partial<GoogDeviceDescriptor>): void;
}

/** One scheduler and cancellation generation for all read-only phone state. */
export class DeviceStatePoller {
    private static readonly INITIAL_UPDATE_TIMEOUT = 1500;
    private static readonly MAX_UPDATES_COUNT = 7;
    private static readonly RUNTIME_STATE_ACTIVE_INTERVAL = 10000;
    private static readonly RUNTIME_STATE_IDLE_INTERVAL = 60000;
    private static readonly LOCK_STATE_ACTIVE_INTERVAL = 2000;
    private static readonly LOCK_STATE_IDLE_INTERVAL = 60000;
    // Modern screen state wins over legacy Display Power. Anchor battery level to skip Capacity level.
    private static readonly RUNTIME_STATE_COMMAND =
        "dumpsys power | grep -E 'mWakefulness=|Display Power: state=' ; " +
        "dumpsys display | grep 'mScreenState=' ; " +
        "dumpsys battery | grep -E '^ +level:|powered'";
    private connected = false;
    private released = false;
    private generation = 0;
    private controller = new AbortController();
    private timer?: NodeJS.Timeout;
    private due: Partial<Record<Poll, number>> = {};
    private inFlight = new Map<Poll, Promise<void>>();
    private active = false;
    private updateCount = 0;
    private updateTimeout = DeviceStatePoller.INITIAL_UPDATE_TIMEOUT;
    private properties?: Record<string, string>;
    private propertiesPromise?: Promise<Record<string, string> | undefined>;
    private pidDetectionVariant = PID_DETECTION.UNKNOWN;
    private detection?: { generation: number; strict: boolean; promise: Promise<PID_DETECTION> };
    private lockReadSequence = 0;
    private lastAppliedLockRead = 0;
    private pidReadSequence = 0;
    private lastAppliedPidRead = 0;
    private pidRevision = 0;
    private pid = 0;

    constructor(private readonly source: StateSource) {}

    public setConnected(connected: boolean): void {
        this.controller.abort(new Error('The phone connection ended.'));
        this.controller = new AbortController();
        this.generation++;
        this.connected = connected && !this.released;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.due = {};
        this.inFlight.clear();
        this.properties = undefined;
        this.propertiesPromise = undefined;
        this.detection = undefined;
        this.updateCount = 0;
        this.updateTimeout = DeviceStatePoller.INITIAL_UPDATE_TIMEOUT;
        this.invalidatePid();
        this.setServerPid(0);
        this.source.patch(unknownLockState());
        if (this.connected) {
            const now = Date.now();
            this.due = { info: now, runtime: now, lock: now, pid: now };
            this.tick();
        }
    }

    public release(): void {
        this.released = true;
        this.setConnected(false);
    }

    public setActive(active: boolean): void {
        if (this.active === active) return;
        this.active = active;
        if (!this.connected) return;
        for (const poll of ['runtime', 'lock', 'pid'] as const) {
            this.due[poll] = Date.now() + (active ? 0 : this.interval(poll));
        }
        this.arm();
    }

    private interval(poll: Poll): number {
        if (poll === 'lock')
            return this.active
                ? DeviceStatePoller.LOCK_STATE_ACTIVE_INTERVAL
                : DeviceStatePoller.LOCK_STATE_IDLE_INTERVAL;
        return this.active
            ? DeviceStatePoller.RUNTIME_STATE_ACTIVE_INTERVAL
            : DeviceStatePoller.RUNTIME_STATE_IDLE_INTERVAL;
    }

    private valid(generation: number): boolean {
        return this.connected && !this.released && generation === this.generation;
    }

    private arm(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        if (!this.connected) return;
        const times = Object.entries(this.due)
            .filter(([poll]) => !this.inFlight.has(poll as Poll))
            .map(([, due]) => due as number);
        if (!times.length) return;
        this.timer = setTimeout(this.tick, Math.max(0, Math.min(...times) - Date.now()));
    }

    private tick = (): void => {
        this.timer = undefined;
        if (!this.connected) return;
        const generation = this.generation;
        for (const poll of Object.keys(this.due) as Poll[]) {
            if (this.due[poll]! > Date.now() || this.inFlight.has(poll)) continue;
            delete this.due[poll];
            const task = Promise.resolve()
                .then(async () => {
                    if (!this.valid(generation)) return;
                    if (poll === 'info') await this.fetchDeviceInfo();
                    else if (poll === 'runtime') await this.fetchRuntimeState();
                    else if (poll === 'lock') await this.refreshLockState();
                    else await this.refreshServicePid();
                })
                .catch((error: Error) => {
                    if (this.valid(generation))
                        console.error(this.source.TAG, `Failed to read phone ${poll}: ${error.message}`);
                })
                .finally(() => {
                    if (!this.valid(generation)) return;
                    this.inFlight.delete(poll);
                    if (poll !== 'info' && this.due[poll] === undefined)
                        this.due[poll] = Date.now() + this.interval(poll);
                    this.arm();
                });
            this.inFlight.set(poll, task);
        }
        this.arm();
    };

    public async getProperties(timeoutMs?: number): Promise<Record<string, string> | undefined> {
        if (this.properties) return this.properties;
        if (!this.connected) return;
        if (!this.propertiesPromise) {
            const generation = this.generation;
            const pending = this.source
                .read('getprop', timeoutMs, this.controller.signal)
                .then((output) => {
                    if (!this.valid(generation)) return undefined;
                    const props: Record<string, string> = {};
                    const re = /^\[([\s\S]*?)\]: \[([\s\S]*?)\]\r?$/gm;
                    let match: RegExpExecArray | null;
                    while ((match = re.exec(output))) props[match[1]] = match[2];
                    this.properties = props;
                    return props;
                })
                .finally(() => {
                    if (this.propertiesPromise === pending) this.propertiesPromise = undefined;
                });
            this.propertiesPromise = pending;
        }
        return this.propertiesPromise;
    }

    public async getNetInterfaces(timeoutMs?: number): Promise<NetInterface[]> {
        if (!this.connected) return [];
        const generation = this.generation;
        const output = await this.source.read(
            "ip -4 -f inet -o a | grep 'scope global'",
            timeoutMs,
            this.controller.signal,
        );
        if (!this.valid(generation)) return [];
        const list: NetInterface[] = [];
        for (const line of output.split('\n').filter(Boolean)) {
            const fields = line.trim().split(/\s+/);
            if (fields[1] && fields[3]) list.push({ name: fields[1], ipv4: fields[3].split('/')[0] });
        }
        return list.sort((a, b) => (a.name > b.name ? 1 : a.name < b.name ? -1 : 0));
    }

    public async updateInterfaces(timeoutMs?: number): Promise<NetInterface[]> {
        const generation = this.generation;
        const interfaces = await this.getNetInterfaces(timeoutMs);
        if (this.valid(generation)) this.source.patch({ interfaces });
        return interfaces;
    }

    public async fetchDeviceInfo(): Promise<void> {
        const generation = this.generation;
        if (!this.valid(generation)) return;
        const properties = this.getProperties(6500).then((props) => {
            if (props && this.valid(generation)) {
                const values: Partial<GoogDeviceDescriptor> = {};
                for (const key of Properties) (values[key] as string) = props[key];
                this.source.patch(values);
            }
            return !!props;
        });
        // A failed branch must not rearm a retry while the other branch is still reading.
        const [props, interfaces] = await Promise.allSettled([properties, this.updateInterfaces(6500)]);
        const complete =
            props.status === 'fulfilled' &&
            props.value &&
            interfaces.status === 'fulfilled' &&
            !!interfaces.value.length;
        if (!this.valid(generation)) return;
        if (complete) {
            this.updateCount = 0;
            this.updateTimeout = DeviceStatePoller.INITIAL_UPDATE_TIMEOUT;
        } else if (++this.updateCount <= DeviceStatePoller.MAX_UPDATES_COUNT) {
            this.due.info = Date.now() + this.updateTimeout;
            this.updateTimeout *= 2;
        } else console.error(this.source.TAG, 'The maximum number of attempts to fetch phone info has been reached.');
    }

    public refreshRuntimeSoon(delay = 0): void {
        if (!this.connected) return;
        this.due.runtime = Date.now() + delay;
        this.due.pid = Date.now() + delay;
        this.arm();
    }

    public async fetchRuntimeState(): Promise<void> {
        const generation = this.generation;
        const output = await this.source.read(DeviceStatePoller.RUNTIME_STATE_COMMAND, 6500, this.controller.signal);
        if (this.valid(generation)) this.applyRuntimeState(output);
    }

    /** Pre-submit reads always start a new diagnostic; older results cannot authorize a caller. */
    public async refreshLockState(): Promise<AndroidLockState> {
        if (!this.connected) return unknownLockState();
        const generation = this.generation;
        const read = ++this.lockReadSequence;
        let state = unknownLockState();
        try {
            state = parseLockState(await this.source.read(LOCK_STATE_COMMAND, 6500, this.controller.signal));
        } catch {
            /* Diagnostic failure removes stale lock claims. */
        }
        if (!this.valid(generation) || read < this.lastAppliedLockRead) return unknownLockState();
        this.lastAppliedLockRead = read;
        this.source.patch(state);
        return state;
    }

    public invalidatePid(): void {
        this.pidRevision++;
    }

    public setServerPid(pid: number): void {
        this.pidRevision++;
        this.applyPid(pid);
    }

    private applyPid(pid: number): void {
        if (this.pid !== pid) {
            this.pid = pid;
            this.source.patch({ pid });
        }
    }

    public async refreshServicePid(): Promise<void> {
        if (!this.connected) return;
        const generation = this.generation;
        const revision = this.pidRevision;
        const read = ++this.pidReadSequence;
        let pid = 0;
        try {
            const pids = await this.source.servicePids(true, this.controller.signal);
            pid = pids?.find((value) => Number.isInteger(value) && value > 0) ?? -1;
        } catch {
            /* A failed read is unknown, rather than stopped. */
        }
        if (this.valid(generation) && revision === this.pidRevision && read >= this.lastAppliedPidRead) {
            this.lastAppliedPidRead = read;
            this.applyPid(pid);
        }
    }
    public async getPidOf(
        processName: string,
        strict = false,
        signal: AbortSignal = this.controller.signal,
    ): Promise<number[] | undefined> {
        if (!this.connected) {
            return;
        }
        if (this.pidDetectionVariant === PID_DETECTION.UNKNOWN) {
            const generation = this.generation;
            if (!this.detection || this.detection.generation !== generation || this.detection.strict !== strict) {
                this.detection = { generation, strict, promise: this.findDetectionVariant(strict, signal) };
            }
            const pending = this.detection;
            try {
                const variant = await pending.promise;
                if (!this.valid(generation) || signal?.aborted) return;
                this.pidDetectionVariant = variant;
            } finally {
                if (this.detection === pending) this.detection = undefined;
            }
        }
        switch (this.pidDetectionVariant) {
            case PID_DETECTION.PIDOF:
                return this.pidOf(processName, strict, signal);
            case PID_DETECTION.GREP_PS:
                return this.grepPs(processName, strict, signal);
            case PID_DETECTION.GREP_PS_A:
                return this.grepPs_A(processName, strict, signal);
            default:
                return this.listProc(processName, strict, signal);
        }
    }

    private async pidOf(processName: string, strict = false, signal?: AbortSignal): Promise<number[]> {
        return this.source
            .read(`pidof ${processName}`, strict ? 6500 : undefined, signal)
            .then((output) => {
                return output
                    .split(' ')
                    .map((pid) => parseInt(pid, 10))
                    .filter((num) => !isNaN(num));
            })
            .catch((error) => {
                if (strict) {
                    throw error;
                }
                return [];
            });
    }

    private filterPsOutput(processName: string, output: string): number[] {
        const list: number[] = [];
        const processes = output.split('\n');
        processes.map((line) => {
            const cols = line
                .trim()
                .split(' ')
                .filter((item) => item.length);
            if (cols[cols.length - 1] === processName) {
                const pid = parseInt(cols[1], 10);
                if (!isNaN(pid)) {
                    list.push(pid);
                }
            }
        });
        return list;
    }

    private async grepPs_A(processName: string, strict = false, signal?: AbortSignal): Promise<number[]> {
        return this.source
            .read(`ps -A | grep ${processName}`, strict ? 6500 : undefined, signal)
            .then((output) => {
                return this.filterPsOutput(processName, output);
            })
            .catch((error) => {
                if (strict) {
                    throw error;
                }
                return [];
            });
    }

    private async grepPs(processName: string, strict = false, signal?: AbortSignal): Promise<number[]> {
        return this.source
            .read(`ps | grep ${processName}`, strict ? 6500 : undefined, signal)
            .then((output) => {
                return this.filterPsOutput(processName, output);
            })
            .catch((error) => {
                if (strict) {
                    throw error;
                }
                return [];
            });
    }

    private async listProc(processName: string, strict = false, signal?: AbortSignal): Promise<number[]> {
        const find = `find /proc -maxdepth 2 -name cmdline  2>/dev/null`;
        const lines = await this.source.read(
            `for L in \`${find}\`; do grep -sae '^${processName}' $L 2>&1 >/dev/null && echo $L; done`,
            strict ? 6500 : undefined,
            signal,
        );
        const re = /\/proc\/([0-9]+)\/cmdline/;
        const list: number[] = [];
        lines.split('\n').map((line) => {
            const trim = line.trim();
            const m = trim.match(re);
            if (m) {
                list.push(parseInt(m[1], 10));
            }
        });
        return list;
    }

    private async executedWithoutError(command: string, strict = false, signal?: AbortSignal): Promise<boolean> {
        return this.source
            .read(command, strict ? 6500 : undefined, signal)
            .then((output) => {
                const err = parseInt(output, 10);
                return err === 0;
            })
            .catch((error) => {
                if (strict) {
                    throw error;
                }
                return false;
            });
    }

    private async hasPs(strict = false, signal?: AbortSignal): Promise<boolean> {
        return this.executedWithoutError('ps | grep init 2>&1 >/dev/null; echo $?', strict, signal);
    }

    private async hasPs_A(strict = false, signal?: AbortSignal): Promise<boolean> {
        return this.executedWithoutError('ps -A | grep init 2>&1 >/dev/null; echo $?', strict, signal);
    }

    private async hasPidOf(strict = false, signal?: AbortSignal): Promise<boolean> {
        const ok = await this.executedWithoutError('which pidof 2>&1 >/dev/null && echo $?', strict, signal);
        if (!ok) {
            return false;
        }
        return this.source
            .read('echo $PPID; pidof init', strict ? 6500 : undefined, signal)
            .then((output) => {
                const pids = output.split('\n').filter((a) => a.length);
                if (pids.length < 2) {
                    return false;
                }
                const parentPid = pids[0].replace('\r', '');
                const list = pids[1].split(' ');
                if (list.includes(parentPid)) {
                    return false;
                }
                return list.includes('1');
            })
            .catch((error) => {
                if (strict) {
                    throw error;
                }
                return false;
            });
    }

    private async findDetectionVariant(strict = false, signal?: AbortSignal): Promise<PID_DETECTION> {
        if (await this.hasPidOf(strict, signal)) {
            return PID_DETECTION.PIDOF;
        }
        if (await this.hasPs_A(strict, signal)) {
            return PID_DETECTION.GREP_PS_A;
        }
        if (await this.hasPs(strict, signal)) {
            return PID_DETECTION.GREP_PS;
        }
        return PID_DETECTION.LS_PROC;
    }

    private applyRuntimeState(output: string): void {
        // `mScreenState` first (present on modern Android), then the legacy `Display Power:
        // state=` for older builds. Both use the same ON/OFF vocabulary.
        const displayPowerMatch = output.match(/mScreenState=(\w+)/) || output.match(/Display Power: state=(\w+)/);
        let screenPower: GoogDeviceDescriptor['screen.power'] = 'unknown';
        if (displayPowerMatch) {
            const state = displayPowerMatch[1].toUpperCase();
            if (state === 'ON') {
                screenPower = 'on';
            } else if (state === 'OFF') {
                screenPower = 'off';
            }
        }

        // `mWakefulness` is missing on some OEM builds. Defaulting to `false` there would pin
        // every such device to "asleep" forever, so only report not-awake on positive evidence:
        // the wakefulness field itself, or failing that the display power state.
        const wakefulnessMatch = output.match(/mWakefulness=(\w+)/);
        let awake = true;
        if (wakefulnessMatch) {
            awake = wakefulnessMatch[1] === 'Awake';
        } else if (screenPower !== 'unknown') {
            awake = screenPower === 'on';
        }

        // Anchored: `dumpsys battery` also emits `Capacity level: 5`, which an unanchored
        // `level:` would match if it ever preceded the real one.
        const levelMatch = output.match(/^\s*level:\s*(\d+)/m);
        const batteryLevel = levelMatch ? parseInt(levelMatch[1], 10) : -1;
        const batteryCharging = /powered:\s*true/i.test(output);

        this.source.patch({
            'device.awake': awake,
            'screen.power': screenPower,
            'battery.level': batteryLevel,
            'battery.charging': batteryCharging,
        });
    }
}
