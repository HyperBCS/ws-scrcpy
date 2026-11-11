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
import { UnlockScheduler, UnlockSchedulerEvents } from './UnlockScheduler';
import { UsbmuxListener } from './UsbmuxListener';

const TAG = '[ControlCenter]';
const MOUNT_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 3000;
// While usbmuxd's own feed announces every attach and detach, the list is read on those events.
// The timer then only covers a feed that has gone quiet without closing.
const POLL_LISTENING_MS = 60000;
// usbmuxd sends one message per device; several in a row are one read of the list.
const CHANGE_DEBOUNCE_MS = 150;
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
 * `usbmux list --simple --usb` gives the set of attached UDIDs (no lockdown, so an untrusted
 * phone still shows up). It is read when usbmuxd reports a change (`UsbmuxListener`) and once a
 * minute, or every 3 s where that feed is not available or a phone has not answered lockdown yet
 * (`waitingForLockdown`). At 3 s it was 28,800 Python processes a day for a server with nothing
 * plugged in. Each new device gets one `lockdown info` (which raises
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
    private pollQueued = false;
    private changeTimer?: NodeJS.Timeout;
    private listener?: UsbmuxListener;
    private polled = false;
    private readonly tracked = new Map<string, Tracked>();
    private readonly id: string;
    private onSessionStatus?: (event: { udid: string; state: string; message?: string }) => void;
    private onRuntimeState?: (event: { udid: string } & AppleRuntimeState) => void;
    // The runner and the monitor the two listeners above were added to. `release()` removes them
    // from these and never asks for the singletons: either may have been released first, and
    // `getInstance()` would then build a new one that nothing releases.
    private statusSource?: CoreDeviceRunner;
    private stateSource?: DeviceStateMonitor;
    // Set only when the scheduler started. Tracking never depends on it: without it the four
    // unlock commands are refused and `descriptor.unlockSchedule` stays absent.
    private scheduler?: UnlockScheduler;
    private onUnlockStatus?: (event: UnlockSchedulerEvents['status']) => void;

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
        this.statusSource = CoreDeviceRunner.getInstance();
        this.statusSource.on('status', this.onSessionStatus);
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
        this.stateSource = DeviceStateMonitor.getInstance();
        this.stateSource.on('state', this.onRuntimeState);
        this.startScheduler();
        this.startListener();
        await this.poll();
        this.schedulePoll();
    }

    /** Test seam: the feed of attach and detach events. */
    protected createListener(): UsbmuxListener | undefined {
        return UsbmuxListener.isEnabled() ? new UsbmuxListener() : undefined;
    }

    private startListener(): void {
        const listener = this.createListener();
        if (!listener) {
            return;
        }
        this.listener = listener;
        listener.on('change', () => {
            if (!this.initialized || this.changeTimer) {
                return;
            }
            this.changeTimer = setTimeout(() => {
                this.changeTimer = undefined;
                this.pollNow();
            }, CHANGE_DEBOUNCE_MS);
        });
        // The feed came up or went away: the wait until the next regular poll changes with it.
        listener.on('ready', () => {
            if (this.initialized && this.pollTimer) {
                clearTimeout(this.pollTimer);
                this.pollTimer = undefined;
                this.schedulePoll();
            }
        });
        listener.start();
    }

    /** Reads the list now, or again as soon as the read in progress has finished. */
    private pollNow(): void {
        if (!this.initialized) {
            return;
        }
        if (this.polling) {
            this.pollQueued = true;
            return;
        }
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        this.poll()
            .catch((error: Error) => console.error(`${TAG} ${error.message}`))
            .finally(() => this.schedulePoll());
    }

    /**
     * The scheduled unlock rides on the tracker's lifetime. Its status is mirrored onto the
     * descriptor so the settings panel reads it from the normal device broadcast. A scheduler
     * that cannot start is logged once and left out; the phones are tracked all the same.
     */
    private startScheduler(): void {
        try {
            const scheduler = UnlockScheduler.getInstance();
            scheduler.start({
                isConnected: (udid) => this.tracked.get(udid)?.descriptor.state === DeviceState.CONNECTED,
            });
            this.onUnlockStatus = (event) => {
                const item = this.tracked.get(event.udid);
                if (!item || item.descriptor.state !== DeviceState.CONNECTED) {
                    return;
                }
                item.descriptor.unlockSchedule = { ...event.status };
                item.descriptor['last.update.timestamp'] = Date.now();
                this.emit('device', item.descriptor);
            };
            scheduler.on('status', this.onUnlockStatus);
            this.scheduler = scheduler;
        } catch (error) {
            this.onUnlockStatus = undefined;
            console.error(`${TAG} scheduled unlock unavailable: ${(error as Error).message}`);
        }
    }

    private stopScheduler(): void {
        const scheduler = this.scheduler;
        if (!scheduler) {
            return;
        }
        this.scheduler = undefined;
        try {
            if (this.onUnlockStatus) {
                scheduler.off('status', this.onUnlockStatus);
            }
            scheduler.release();
        } catch (error) {
            console.error(`${TAG} scheduled unlock did not stop cleanly: ${(error as Error).message}`);
        }
        this.onUnlockStatus = undefined;
    }

    private requireScheduler(): UnlockScheduler {
        if (!this.scheduler) {
            throw new Error('Scheduled unlock is not available');
        }
        return this.scheduler;
    }

    private schedulePoll(): void {
        if (!this.initialized || this.pollTimer) {
            return;
        }
        this.pollTimer = setTimeout(
            () => {
                this.pollTimer = undefined;
                this.poll()
                    .catch((error: Error) => console.error(`${TAG} ${error.message}`))
                    .finally(() => this.schedulePoll());
            },
            this.listener?.isReady() && !this.waitingForLockdown() ? POLL_LISTENING_MS : POLL_INTERVAL_MS,
        );
    }

    /**
     * An attached phone that lockdown has not answered for yet: untrusted, or still booting. Its
     * next lockdown read is due UNPAIRED_RETRY_MS later and comes from a poll, and usbmuxd sends
     * nothing when "Trust This Computer" is accepted, so the short poll stays until it answers.
     */
    private waitingForLockdown(): boolean {
        for (const item of this.tracked.values()) {
            if (item.descriptor.state !== DeviceState.DISCONNECTED && !item.descriptor.paired) {
                return true;
            }
        }
        return false;
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
            this.polled = true;
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
                // A phone plugged back in is read again now, not when the next regular refresh
                // comes round up to a minute later. Until then it reads as disconnected, and the
                // runner starts no screen session for a disconnected phone.
                const stale =
                    item.descriptor.state === DeviceState.DISCONNECTED ||
                    (item.descriptor.paired
                        ? now - item.detailsAt > DETAILS_REFRESH_MS
                        : now - item.detailsAt > UNPAIRED_RETRY_MS);
                if (stale && !item.detailsPending) {
                    item.detailsPending = this.refreshDetails(item).finally(() => (item!.detailsPending = undefined));
                }
            }
        } finally {
            this.polling = false;
            if (this.pollQueued) {
                // A change was reported while this read was running, so it may already be out of date.
                this.pollQueued = false;
                setImmediate(() => this.pollNow());
            }
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
            // The tracker can be released, or the phone unplugged, during either read below. A
            // phone must not be watched after that: the monitor would be created again and keep
            // an observer running for a phone nobody tracks.
            const gone = () =>
                !this.initialized || this.tracked.get(udid) !== item || item.descriptor.state !== DeviceState.CONNECTED;
            const developerMode = await this.fetchDeveloperMode(udid);
            if (gone()) {
                return;
            }
            item.descriptor.developerMode = developerMode;
            item.descriptor.session = CoreDeviceRunner.getInstance().getStatus(udid).state;
            const monitor = DeviceStateMonitor.getInstance();
            if (!monitor.isWatching(udid)) {
                const language = await this.fetchLanguage(udid);
                if (gone()) {
                    return;
                }
                monitor.watch(udid, { version: item.descriptor.version, language });
            }
            Object.assign(item.descriptor, monitor.getState(udid));
            item.descriptor.unlockSchedule = this.scheduler?.getStatus(udid);
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

    /** False until the attached phones have been listed once: no descriptor then proves nothing. */
    public hasPolled(): boolean {
        return this.polled;
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

    /** Stops tracking. A second call, or one on a tracker that never started, changes nothing. */
    public release(): void {
        if (ControlCenter.instance === this) {
            ControlCenter.instance = undefined;
        }
        if (!this.initialized) {
            return;
        }
        this.initialized = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        if (this.changeTimer) {
            clearTimeout(this.changeTimer);
            this.changeTimer = undefined;
        }
        this.pollQueued = false;
        this.listener?.stop();
        this.listener = undefined;
        if (this.onSessionStatus) {
            this.statusSource?.off('status', this.onSessionStatus);
            this.onSessionStatus = undefined;
        }
        if (this.onRuntimeState) {
            this.stateSource?.off('state', this.onRuntimeState);
            this.onRuntimeState = undefined;
        }
        this.statusSource = undefined;
        this.stateSource = undefined;
        // Before the monitor: the scheduler holds a listener on it.
        this.stopScheduler();
        if (DeviceStateMonitor.hasInstance()) {
            DeviceStateMonitor.getInstance().release();
        }
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
                // The old serve-web returns the phone's display sessions as it stops. Mount once it
                // has closed, as a new session does.
                await CoreDeviceRunner.whenStopped(udid);
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
            // Scheduled unlock: the reply is the scheduler's return value as JSON, nothing else.
            // The passcode goes straight through to the scheduler; it is not kept or logged here.
            case ControlCenterCommand.UPDATE_UNLOCK_SCHEDULE:
                return JSON.stringify(this.requireScheduler().updateSchedule(udid, command.getUnlockSchedule()!));
            case ControlCenterCommand.SET_UNLOCK_PASSCODE:
                return JSON.stringify(this.requireScheduler().setPasscode(udid, command.getPasscode()!));
            case ControlCenterCommand.CLEAR_UNLOCK_PASSCODE:
                return JSON.stringify(this.requireScheduler().clearPasscode(udid));
            case ControlCenterCommand.RUN_UNLOCK_NOW:
                return JSON.stringify(
                    await this.requireScheduler().runNow(udid, 'manual', command.getUnlockRunOptions()),
                );
            default:
                throw new Error(`Unsupported command: "${type}"`);
        }
    }
}
