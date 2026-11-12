import { TypedEmitter } from '../../common/TypedEmitter';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { NetInterface } from '../../types/NetInterface';
import { AndroidLockState } from '../../types/AndroidLockState';
import { AdbShell } from './AdbShell';
import { DeviceStatePoller } from './DeviceStatePoller';
import { ScrcpySession, StreamViewer } from './ScrcpySession';
import { EncoderInfo, ScrcpyServer } from './ScrcpyServer';
import { StreamConfigData } from './StreamConfig';
import { unknownLockState } from './LockState';

export type { StreamViewer } from './ScrcpySession';
export interface DeviceEvents {
    update: Device;
}

/** Public phone facade. Shells, polling, and stream lifetime each have one owner. */
export class Device extends TypedEmitter<DeviceEvents> {
    private static readonly WAKE_SETTLE_MS = 500;
    private connected = true;
    private released = false;
    private stateInitialized = false;
    private readonly shell: AdbShell;
    private readonly poller: DeviceStatePoller;
    private readonly session: ScrcpySession;
    private throttleTimeoutId?: NodeJS.Timeout;
    private lastEmit = 0;
    public readonly TAG: string;
    public readonly descriptor: GoogDeviceDescriptor;

    constructor(
        public readonly udid: string,
        state: string,
    ) {
        super();
        this.TAG = `[${udid}]`;
        this.descriptor = {
            udid,
            state,
            interfaces: [],
            pid: 0,
            'wifi.interface': '',
            'ro.build.version.release': '',
            'ro.build.version.sdk': '',
            'ro.product.manufacturer': '',
            'ro.product.model': '',
            'ro.product.cpu.abi': '',
            'last.update.timestamp': 0,
            ...unknownLockState(),
            'device.awake': true,
            'battery.level': -1,
            'battery.charging': false,
        };
        this.shell = new AdbShell(udid);
        this.poller = new DeviceStatePoller({
            TAG: this.TAG,
            read: (command, timeout, signal) => this.runShellCommandAdbKit(command, timeout, signal),
            servicePids: (strict, signal) => ScrcpyServer.getServerPid(this, strict, signal),
            patch: (values) => this.patchDescriptor(values),
        });
        this.session = new ScrcpySession({
            udid,
            TAG: this.TAG,
            isConnected: () => this.isConnected(),
            getPidOf: (name, strict, signal) => this.getPidOf(name, strict, signal),
            runShellCommandAdbKit: (command, timeout, signal) => this.runShellCommandAdbKit(command, timeout, signal),
            push: (contents, path, signal) => this.push(contents, path, signal),
            getLaunchStreamConfig: () => this.getLaunchStreamConfig(),
            launchServer: (command, audio) => this.launchServer(command, audio),
            openShell: (command, signal) => this.shell.open(command, signal),
            killProcess: (pid) => this.killProcess(pid),
            setServerPid: (pid) => this.poller.setServerPid(pid),
            invalidatePid: () => this.poller.invalidatePid(),
            refreshServicePid: () => this.poller.refreshServicePid(),
            sdk: () => this.descriptor['ro.build.version.sdk'],
        });
        this.setState(state);
    }

    public setState(state: string): void {
        if (this.released || (this.stateInitialized && this.descriptor.state === state)) return;
        this.stateInitialized = true;
        this.connected = state === 'device';
        this.descriptor.state = state;
        this.shell.cancel();
        this.session.setConnected(this.connected);
        this.poller.setConnected(this.connected);
        this.emitUpdate();
    }

    public isConnected(): boolean {
        return this.connected;
    }
    public setRuntimeStatePollActive(active: boolean): void {
        this.poller.setActive(active);
    }

    public release(): void {
        this.released = true;
        this.connected = false;
        this.poller.release();
        this.session.release();
        this.shell.release();
        if (this.throttleTimeoutId) clearTimeout(this.throttleTimeoutId);
        this.throttleTimeoutId = undefined;
        Object.assign(this.descriptor, unknownLockState());
    }

    public runShellCommandAdbKit(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
        return this.shell.read(command, timeoutMs, signal);
    }
    public push(contents: string, path: string, signal?: AbortSignal) {
        return this.shell.push(contents, path, signal);
    }
    public getProperties(): Promise<Record<string, string> | undefined> {
        return this.poller.getProperties();
    }
    public getNetInterfaces(): Promise<NetInterface[]> {
        return this.poller.getNetInterfaces();
    }
    public updateInterfaces(): Promise<NetInterface[]> {
        return this.poller.updateInterfaces();
    }
    public getPidOf(name: string, strict = false, signal?: AbortSignal): Promise<number[] | undefined> {
        return this.poller.getPidOf(name, strict, signal);
    }
    public refreshLockState(): Promise<AndroidLockState> {
        return this.poller.refreshLockState();
    }
    public killProcess(pid: number): Promise<string> {
        return this.runShellCommandAdbKit(`kill ${pid}`);
    }

    public async wake(): Promise<void> {
        if (!this.connected) throw Error('The phone is not connected.');
        const { code, output } = await this.shell.exec('input keyevent 224', 6500);
        if (code !== 0) throw Error(output || 'The phone did not accept the wake key.');
        this.poller.refreshRuntimeSoon(Device.WAKE_SETTLE_MS);
    }

    public launchServer(command: string, audioEnabled: boolean): Promise<void> {
        return this.session.launchServer(command, audioEnabled);
    }
    public addViewer(viewer: StreamViewer): () => void {
        return this.session.addViewer(viewer);
    }
    public ensureServer(): Promise<void> {
        return this.session.ensureServer();
    }
    public startServer(): Promise<number | undefined> {
        return this.session.startServer();
    }
    public killServer(pid: number): Promise<void> {
        return this.session.killServer(pid);
    }
    public updateStreamConfig(patch: Partial<StreamConfigData>): Promise<StreamConfigData> {
        return this.session.updateStreamConfig(patch);
    }
    public getLaunchStreamConfig(): StreamConfigData {
        return this.session.getLaunchStreamConfig();
    }
    public listEncoders(force = false): Promise<EncoderInfo[]> {
        return this.session.listEncoders(force);
    }
    public getCachedEncoders(): EncoderInfo[] {
        return this.session.getCachedEncoders();
    }

    public getDeviceName(): string {
        return (
            `${this.descriptor['ro.product.manufacturer'] || ''} ${this.descriptor['ro.product.model'] || ''}`.trim() ||
            this.udid
        );
    }

    private patchDescriptor(values: Partial<GoogDeviceDescriptor>): void {
        if (this.released) return;
        let changed = false;
        for (const key of Object.keys(values) as Array<keyof GoogDeviceDescriptor>) {
            if (JSON.stringify(this.descriptor[key]) !== JSON.stringify(values[key])) changed = true;
        }
        if (changed) {
            Object.assign(this.descriptor, values);
            this.emitUpdate();
        }
    }

    private emitUpdate(setUpdateTime = true): void {
        if (this.released) return;
        const THROTTLE = 300;
        const now = Date.now();
        const time = now - this.lastEmit;
        if (setUpdateTime) this.descriptor['last.update.timestamp'] = now;
        if (time > THROTTLE) {
            this.lastEmit = now;
            this.emit('update', this);
        } else if (!this.throttleTimeoutId) {
            this.throttleTimeoutId = setTimeout(() => {
                this.throttleTimeoutId = undefined;
                this.emitUpdate(false);
            }, THROTTLE - time);
        }
    }
}
