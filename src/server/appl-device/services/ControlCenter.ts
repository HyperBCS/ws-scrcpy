import { Service } from '../../services/Service';
import { BaseControlCenter } from '../../services/BaseControlCenter';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import * as os from 'os';
import * as crypto from 'crypto';
import ApplDeviceDescriptor from '../../../types/ApplDeviceDescriptor';
import { DeviceState } from '../../../common/DeviceState';
import { ProductType } from '../../../common/ProductType';
import { PyMobileDevice } from './PyMobileDevice';
import { CoreDeviceRunner } from './CoreDeviceRunner';
import { AppleRuntimeState, DeviceStateMonitor } from './DeviceStateMonitor';

const TAG = '[ControlCenter]';
const MOUNT_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 3000;
// An untrusted phone answers lockdown with a pairing error until its "Trust This Computer"
// prompt is accepted; asking again every poll would only spam the log.
const UNPAIRED_RETRY_MS = 10000;
const DETAILS_REFRESH_MS = 60000;

type ShortInfo = {
    Identifier?: string;
    DeviceName?: string;
    ProductType?: string;
    ProductVersion?: string;
    UniqueDeviceID?: string;
};

const UNKNOWN_RUNTIME_STATE: AppleRuntimeState = { 'screen.power': 'unknown', 'device.locked': 'unknown' };

interface Tracked {
    descriptor: ApplDeviceDescriptor;
    detailsAt: number;
    detailsPending?: Promise<void>;
}

/**
 * iOS device tracking through `pymobiledevice3` over usbmuxd.
 *
 * `usbmux list --simple --usb` is polled for the set of attached UDIDs (no lockdown, so an
 * untrusted phone still shows up), and each new device gets one `lockdown info` (which raises
 * the Trust prompt through pymobiledevice3's autopair) plus `amfi developer-mode-status`. The
 * emitted `ApplDeviceDescriptor` also mirrors the screen-session state from `CoreDeviceRunner`
 * so the device list can show Starting/Running like it does for scrcpy, and the screen/lock
 * state from `DeviceStateMonitor` so it can show Asleep/Locked like it does for Android.
 */
export class ControlCenter extends BaseControlCenter<ApplDeviceDescriptor> implements Service {
    private static instance?: ControlCenter;

    private initialized = false;
    private pollTimer?: NodeJS.Timeout;
    private polling = false;
    private readonly tracked = new Map<string, Tracked>();
    private readonly id: string;
    private onSessionStatus?: (event: { udid: string; state: string; message?: string }) => void;
    private onRuntimeState?: (event: { udid: string } & AppleRuntimeState) => void;

    protected constructor() {
        super();
        const idString = `appl|${os.hostname()}|${os.uptime()}`;
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

    public async init(): Promise<void> {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        this.onSessionStatus = (event) => {
            const item = this.tracked.get(event.udid);
            if (!item) {
                return;
            }
            if (item.descriptor.state === DeviceState.DISCONNECTED) {
                // An unplugged phone keeps being retried by any viewer still on its page, and each
                // attempt fails with "usbmux has no device matching udid". Stamping that on the
                // card made a phone that is merely unplugged look broken, so the state stands.
                return;
            }
            item.descriptor.session = event.state as ApplDeviceDescriptor['session'];
            item.descriptor.sessionMessage = event.message;
            item.descriptor['last.update.timestamp'] = Date.now();
            this.emit('device', item.descriptor);
            // Someone is streaming: read the screen and lock state faster while they are.
            DeviceStateMonitor.getInstance().setSessionActive(
                event.udid,
                event.state === 'ready' || event.state === 'starting',
            );
        };
        CoreDeviceRunner.getInstance().on('status', this.onSessionStatus);
        this.onRuntimeState = (event) => {
            const item = this.tracked.get(event.udid);
            if (!item || item.descriptor.state !== DeviceState.CONNECTED) {
                return;
            }
            item.descriptor['screen.power'] = event['screen.power'];
            item.descriptor['device.locked'] = event['device.locked'];
            item.descriptor['last.update.timestamp'] = Date.now();
            this.emit('device', item.descriptor);
        };
        DeviceStateMonitor.getInstance().on('state', this.onRuntimeState);
        await this.poll();
        this.schedulePoll();
    }

    private schedulePoll(): void {
        if (!this.initialized || this.pollTimer) {
            return;
        }
        this.pollTimer = setTimeout(() => {
            this.pollTimer = undefined;
            this.poll()
                .catch((error: Error) => console.error(`${TAG} ${error.message}`))
                .finally(() => this.schedulePoll());
        }, POLL_INTERVAL_MS);
    }

    /** One pass: reconcile attached UDIDs with what is tracked. Test seam via `listUdids`. */
    public async poll(): Promise<void> {
        if (this.polling || !this.initialized) {
            return;
        }
        this.polling = true;
        try {
            const udids = await this.listUdids();
            if (!this.initialized) {
                return;
            }
            const present = new Set(udids);
            for (const [udid, item] of this.tracked) {
                if (!present.has(udid) && item.descriptor.state !== DeviceState.DISCONNECTED) {
                    item.descriptor.state = DeviceState.DISCONNECTED;
                    item.descriptor.session = 'stopped';
                    item.descriptor.sessionMessage = undefined;
                    item.descriptor['screen.power'] = 'unknown';
                    item.descriptor['device.locked'] = 'unknown';
                    item.descriptor['last.update.timestamp'] = Date.now();
                    CoreDeviceRunner.getInstance().stopSession(udid, 'Device disconnected');
                    DeviceStateMonitor.getInstance().unwatch(udid);
                    this.emit('device', item.descriptor);
                }
            }
            const now = Date.now();
            for (const udid of udids) {
                let item = this.tracked.get(udid);
                if (!item) {
                    item = {
                        descriptor: {
                            udid,
                            name: '<NoName>',
                            model: '<NoModel>',
                            version: '<NoVersion>',
                            state: 'unauthorized',
                            paired: false,
                            developerMode: 'unknown',
                            session: 'stopped',
                            ...UNKNOWN_RUNTIME_STATE,
                            'last.update.timestamp': now,
                        },
                        detailsAt: 0,
                    };
                    this.tracked.set(udid, item);
                    this.emit('device', item.descriptor);
                }
                const stale = item.descriptor.paired
                    ? now - item.detailsAt > DETAILS_REFRESH_MS
                    : now - item.detailsAt > UNPAIRED_RETRY_MS;
                if (stale && !item.detailsPending) {
                    item.detailsPending = this.refreshDetails(item).finally(() => (item!.detailsPending = undefined));
                }
            }
        } finally {
            this.polling = false;
        }
    }

    protected async listUdids(): Promise<string[]> {
        const list = await PyMobileDevice.runJson<unknown>(['usbmux', 'list', '--simple', '--usb'], 20000);
        if (!Array.isArray(list)) {
            return [];
        }
        return list.filter((item): item is string => typeof item === 'string' && item.length > 0);
    }

    protected async fetchInfo(udid: string): Promise<ShortInfo> {
        return PyMobileDevice.runJson<ShortInfo>(['lockdown', 'info', '--udid', udid], 30000);
    }

    /** The phone's UI language (`en-US`); the lock probe reads localized captions. */
    protected async fetchLanguage(udid: string): Promise<string | undefined> {
        try {
            const value = await PyMobileDevice.runJson<unknown>(
                ['lockdown', 'get', '--domain', 'com.apple.international', '--key', 'Language', '--udid', udid],
                20000,
            );
            return typeof value === 'string' && value ? value : undefined;
        } catch {
            return undefined;
        }
    }

    protected async fetchDeveloperMode(udid: string): Promise<boolean | 'unknown'> {
        try {
            const value = await PyMobileDevice.runJson<unknown>(
                ['amfi', 'developer-mode-status', '--udid', udid],
                20000,
            );
            return typeof value === 'boolean' ? value : 'unknown';
        } catch {
            return 'unknown';
        }
    }

    private async refreshDetails(item: Tracked): Promise<void> {
        const { udid } = item.descriptor;
        item.detailsAt = Date.now();
        try {
            const info = await this.fetchInfo(udid);
            if (!this.initialized || this.tracked.get(udid) !== item) {
                return;
            }
            const productType = info.ProductType || '';
            item.descriptor.name = info.DeviceName || item.descriptor.name;
            item.descriptor.model = productType ? ProductType.getModel(productType) : item.descriptor.model;
            item.descriptor.productType = productType || item.descriptor.productType;
            item.descriptor.version = info.ProductVersion || item.descriptor.version;
            item.descriptor.paired = true;
            item.descriptor.state = DeviceState.CONNECTED;
            item.descriptor.developerMode = await this.fetchDeveloperMode(udid);
            item.descriptor.session = CoreDeviceRunner.getInstance().getStatus(udid).state;
            const monitor = DeviceStateMonitor.getInstance();
            if (!monitor.isWatching(udid)) {
                monitor.watch(udid, { language: await this.fetchLanguage(udid) });
            }
            Object.assign(item.descriptor, monitor.getState(udid));
        } catch (error) {
            if (!this.initialized || this.tracked.get(udid) !== item) {
                return;
            }
            const message = (error as Error).message;
            // Anything lockdown refuses before trust is an "unauthorized" device, like adb's.
            item.descriptor.paired = false;
            item.descriptor.state = 'unauthorized';
            item.descriptor.sessionMessage = message;
            console.error(`${TAG} lockdown info failed for ${udid}: ${message}`);
        }
        item.descriptor['last.update.timestamp'] = Date.now();
        this.emit('device', item.descriptor);
    }

    public getDevices(): ApplDeviceDescriptor[] {
        return Array.from(this.tracked.values()).map((item) => item.descriptor);
    }

    public getDescriptor(udid: string): ApplDeviceDescriptor | undefined {
        return this.tracked.get(udid)?.descriptor;
    }

    public getId(): string {
        return this.id;
    }

    public getName(): string {
        return `iDevice Tracker [${os.hostname()}]`;
    }

    public start(): Promise<void> {
        return this.init().catch((e) => {
            console.error(`Error: Failed to init "${this.getName()}". ${e.message}`);
        });
    }

    public release(): void {
        this.initialized = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        if (this.onSessionStatus) {
            CoreDeviceRunner.getInstance().off('status', this.onSessionStatus);
            this.onSessionStatus = undefined;
        }
        if (this.onRuntimeState) {
            DeviceStateMonitor.getInstance().off('state', this.onRuntimeState);
            this.onRuntimeState = undefined;
        }
        if (DeviceStateMonitor.hasInstance()) {
            DeviceStateMonitor.getInstance().release();
        }
        ControlCenter.instance = undefined;
    }

    public async runCommand(command: ControlCenterCommand): Promise<string | void> {
        const udid = command.getUdid();
        const item = this.tracked.get(udid);
        if (!item) {
            throw new Error(`Device with udid:"${udid}" not found`);
        }
        const type = command.getType();
        switch (type) {
            case ControlCenterCommand.ENABLE_DEVELOPER_MODE: {
                // The phone reboots to apply this; pymobiledevice3 waits for it to come back and
                // confirms the post-restart prompt itself. A set passcode blocks it -- the CLI's
                // last stderr line says so, and that reaches the device card.
                const result = await PyMobileDevice.runOneShot(
                    ['amfi', 'enable-developer-mode', '--udid', udid],
                    240000,
                );
                if (result.code !== 0) {
                    throw new Error(PyMobileDevice.explain(result.stderr) || 'Could not enable Developer Mode');
                }
                item.detailsAt = 0;
                await this.poll();
                return 'Developer Mode enabled';
            }
            case ControlCenterCommand.REBOOT_DEVICE:
            case ControlCenterCommand.SHUTDOWN_DEVICE: {
                // The screen session dies with the device either way; stopping it first means the
                // viewer sees "stopped", not a stream that errors out mid-shutdown.
                const restart = type === ControlCenterCommand.REBOOT_DEVICE;
                CoreDeviceRunner.getInstance().stopSession(
                    udid,
                    restart ? 'Device is rebooting' : 'Device is shutting down',
                );
                const result = await PyMobileDevice.runOneShot(
                    ['diagnostics', restart ? 'restart' : 'shutdown', '--udid', udid],
                    60000,
                );
                if (result.code !== 0) {
                    throw new Error(
                        PyMobileDevice.explain(result.stderr) ||
                            `Could not ${restart ? 'reboot' : 'shut down'} the device`,
                    );
                }
                // The poll loop notices it leave usbmux; a reboot re-mounts the DDI on its own.
                item.detailsAt = 0;
                return;
            }
            case ControlCenterCommand.REMOUNT_DDI: {
                // The image hosts the display and HID daemons, so a live session is holding it
                // open: drop that first, then re-run the mount and report what the CLI said.
                CoreDeviceRunner.getInstance().stopSession(udid, 'Remounting the developer image');
                const result = await PyMobileDevice.runOneShot(
                    ['mounter', 'auto-mount', '--udid', udid],
                    MOUNT_TIMEOUT_MS,
                );
                const detail = PyMobileDevice.explain(result.stderr) || PyMobileDevice.explain(result.stdout);
                if (result.code !== 0) {
                    throw new Error(detail || 'Could not mount the developer image');
                }
                return detail || 'Developer image mounted.';
            }
            case ControlCenterCommand.REFRESH_DEVICE:
                item.detailsAt = 0;
                await this.poll();
                DeviceStateMonitor.getInstance().refresh(udid);
                return;
            case ControlCenterCommand.GET_LOCK_STATE:
                // Same reply shape as the Android tracker; the fresh reading follows as a
                // descriptor update once the probes have run.
                DeviceStateMonitor.getInstance().refresh(udid);
                return JSON.stringify({ udid, ...DeviceStateMonitor.getInstance().getState(udid) });
            case ControlCenterCommand.KILL_SERVER:
                CoreDeviceRunner.getInstance().stopSession(udid, 'Stopped from the device list');
                return;
            case ControlCenterCommand.RESTART_SESSION:
                // Unlike KILL_SERVER this needs no pid: it is the debug "restart the services"
                // action, reachable when there is no working stream page to ask from.
                CoreDeviceRunner.getInstance().stopSession(udid, 'Services restarted from the device list');
                return 'Services restarted. Open the screen again.';
            default:
                throw new Error(`Unsupported command: "${type}"`);
        }
    }
}
