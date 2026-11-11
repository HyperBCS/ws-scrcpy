import { TrackerChangeSet } from '@dead50f7/adbkit/lib/TrackerChangeSet';
import { Device } from '../Device';
import { Service } from '../../services/Service';
import AdbKitClient from '@dead50f7/adbkit/lib/adb/client';
import { AdbExtended } from '../adb';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import Tracker from '@dead50f7/adbkit/lib/adb/tracker';
import Timeout = NodeJS.Timeout;
import { BaseControlCenter } from '../../services/BaseControlCenter';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import * as os from 'os';
import * as crypto from 'crypto';
import { DeviceState } from '../../../common/DeviceState';
import { streamConfig } from '../StreamConfig';

export class ControlCenter extends BaseControlCenter<GoogDeviceDescriptor> implements Service {
    private static readonly defaultWaitAfterError = 1000;
    private static instance?: ControlCenter;

    private initialized = false;
    private initializing?: Promise<void>;
    // False from the moment the adb device tracker fails until it is running again.
    private adbAvailable = true;
    private adbListeners: Set<(available: boolean) => void> = new Set();
    private released = false;
    private client: AdbKitClient = AdbExtended.createClient();
    private tracker?: Tracker;
    private waitAfterError = 1000;
    private restartTimeoutId?: Timeout;
    private deviceMap: Map<string, Device> = new Map();
    private trackerClients = 0;
    private descriptors: Map<string, GoogDeviceDescriptor> = new Map();
    private readonly id: string;

    protected constructor() {
        super();
        const idString = `goog|${os.hostname()}|${os.uptime()}`;
        this.id = crypto.createHash('md5').update(idString).digest('hex');
    }

    public static getInstance(): ControlCenter {
        if (!this.instance) {
            this.instance = new ControlCenter();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!ControlCenter.instance;
    }

    private restartTracker = (): void => {
        if (this.released) {
            return;
        }
        this.setAdbAvailable(false);
        if (this.restartTimeoutId) {
            return;
        }
        console.log(`Device tracker is down. Will try to restart in ${this.waitAfterError}ms`);
        this.restartTimeoutId = setTimeout(() => {
            this.restartTimeoutId = undefined;
            this.stopTracker();
            this.waitAfterError = Math.min(30000, this.waitAfterError * 1.2);
            this.init().catch((e) => {
                console.error(`Error: Failed to restart "${this.getName()}". ${e.message}`);
                // Without a tracker there is no 'end'/'error' event to trigger the next attempt
                this.restartTracker();
            });
        }, this.waitAfterError);
    };

    private onChangeSet = (changes: TrackerChangeSet): void => {
        this.waitAfterError = ControlCenter.defaultWaitAfterError;
        if (changes.added.length) {
            for (const item of changes.added) {
                const { id, type } = item;
                this.handleConnected(id, type);
            }
        }
        if (changes.removed.length) {
            for (const item of changes.removed) {
                const { id } = item;
                this.handleConnected(id, DeviceState.DISCONNECTED);
            }
        }
        if (changes.changed.length) {
            for (const item of changes.changed) {
                const { id, type } = item;
                this.handleConnected(id, type);
            }
        }
    };

    private onDeviceUpdate = (device: Device): void => {
        const { udid, descriptor } = device;
        this.descriptors.set(udid, descriptor);
        this.emit('device', descriptor);
    };

    private handleConnected(udid: string, state: string): void {
        let device = this.deviceMap.get(udid);
        if (device) {
            if (device.descriptor.state != state) {
                device.setState(state);
            }
        } else {
            device = new Device(udid, state);
            device.on('update', this.onDeviceUpdate);
            device.setRuntimeStatePollActive(this.trackerClients > 0);
            this.deviceMap.set(udid, device);
        }
    }

    /** Callers that arrive while a start is in flight share it, so only one adb tracker opens. */
    public init(): Promise<void> {
        if (this.initialized || this.released) {
            return Promise.resolve();
        }
        if (!this.initializing) {
            this.initializing = this.initNow().finally(() => {
                this.initializing = undefined;
            });
        }
        return this.initializing;
    }

    private async initNow(): Promise<void> {
        const tracker = await this.startTracker();
        this.tracker = tracker;
        const list = await this.client.listDevices();
        if (this.released) return;
        if (this.tracker !== tracker) {
            // The tracker failed and was stopped while the list was being read.
            throw new Error('Device tracker stopped');
        }
        list.forEach((device) => {
            const { id, type } = device;
            this.handleConnected(id, type);
        });
        // A new adb tracker reports only what it sees from now on. A phone that left while the
        // old one was down is never reported as removed, so it is marked here.
        const present = new Set(list.map((device) => device.id));
        this.deviceMap.forEach((_device, udid) => {
            if (!present.has(udid)) {
                this.handleConnected(udid, DeviceState.DISCONNECTED);
            }
        });
        this.initialized = true;
        this.setAdbAvailable(true);
    }

    /** Whether the adb device tracker is running. Device lists show a notice while it is not. */
    public isAdbAvailable(): boolean {
        return this.adbAvailable;
    }

    /** Calls `listener` on every change. Returns the function that stops it. */
    public onAdbAvailability(listener: (available: boolean) => void): () => void {
        this.adbListeners.add(listener);
        return () => {
            this.adbListeners.delete(listener);
        };
    }

    private setAdbAvailable(available: boolean): void {
        if (this.adbAvailable === available) {
            return;
        }
        this.adbAvailable = available;
        this.adbListeners.forEach((listener) => listener(available));
    }

    private async startTracker(): Promise<Tracker> {
        if (this.tracker) {
            return this.tracker;
        }
        const tracker = await this.client.trackDevices();
        if (this.released) {
            tracker.end();
            throw new Error('Device tracker stopped');
        }
        tracker.on('changeSet', this.onChangeSet);
        tracker.on('end', this.restartTracker);
        tracker.on('error', this.restartTracker);
        return tracker;
    }

    private stopTracker(): void {
        if (this.restartTimeoutId) {
            clearTimeout(this.restartTimeoutId);
            this.restartTimeoutId = undefined;
        }
        if (this.tracker) {
            this.tracker.off('changeSet', this.onChangeSet);
            this.tracker.off('end', this.restartTracker);
            this.tracker.off('error', this.restartTracker);
            this.tracker.end();
            this.tracker = undefined;
        }
        this.tracker = undefined;
        this.initialized = false;
    }

    public getDevices(): GoogDeviceDescriptor[] {
        return Array.from(this.descriptors.values());
    }

    public getDevice(udid: string): Device | undefined {
        return this.deviceMap.get(udid);
    }

    /**
     * Tracks how many browsers have a device list open. Devices poll their runtime state
     * (screen power, battery) on a slow interval by default and a fast one while someone is
     * actually watching, so the "asleep" badge is not up to a minute stale in front of a user.
     */
    public addTrackerClient(): void {
        if (++this.trackerClients === 1) {
            this.deviceMap.forEach((device) => device.setRuntimeStatePollActive(true));
        }
    }

    public removeTrackerClient(): void {
        if (this.trackerClients === 0) {
            return;
        }
        if (--this.trackerClients === 0) {
            this.deviceMap.forEach((device) => device.setRuntimeStatePollActive(false));
        }
    }

    public getId(): string {
        return this.id;
    }

    public getName(): string {
        return `aDevice Tracker [${os.hostname()}]`;
    }

    public start(): Promise<void> {
        this.released = false;
        return this.init().catch((e) => {
            console.error(`Error: Failed to init "${this.getName()}". ${e.message}`);
            this.restartTracker();
        });
    }

    public release(): void {
        this.released = true;
        this.stopTracker();
        this.deviceMap.forEach((device) => {
            device.off('update', this.onDeviceUpdate);
            device.release();
        });
        this.deviceMap.clear();
        this.descriptors.clear();
        this.trackerClients = 0;
        this.adbListeners.clear();
    }

    public async runCommand(command: ControlCenterCommand): Promise<string | void> {
        const udid = command.getUdid();
        const device = this.getDevice(udid);
        if (!device) {
            console.error(`Device with udid:"${udid}" not found`);
            return;
        }
        const type = command.getType();
        switch (type) {
            case ControlCenterCommand.KILL_SERVER:
                await device.killServer(command.getPid());
                return;
            case ControlCenterCommand.START_SERVER:
                await device.startServer();
                return;
            case ControlCenterCommand.UPDATE_INTERFACES:
                await device.updateInterfaces();
                return;
            case ControlCenterCommand.GET_LOCK_STATE:
                return JSON.stringify({ udid, ...(await device.refreshLockState()) });
            case ControlCenterCommand.LIST_ENCODERS: {
                const encoders = await device.listEncoders(true);
                return JSON.stringify({ udid, encoders, config: streamConfig.get(udid) });
            }
            case ControlCenterCommand.UPDATE_STREAM_CONFIG: {
                const patch = command.getConfig();
                if (!patch) {
                    throw new Error('Missing "config" in UPDATE_STREAM_CONFIG command');
                }
                const config = await device.updateStreamConfig(patch);
                return JSON.stringify({ udid, config });
            }
            default:
                throw new Error(`Unsupported command: "${type}"`);
        }
    }
}
