import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import { SERVER_PORT, ScrcpyServerConfig } from '../../../common/Constants';
import { ACTION } from '../../../common/Action';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { HostItem } from '../../../types/Configuration';
import { ChannelCode } from '../../../common/ChannelCode';
import { Tool } from '../../client/Tool';
import { EncoderInfo } from '../../../types/EncoderInfo';
import { AndroidLockStateReply } from '../../../types/AndroidLockState';

// Replies to the `ControlCenterCommand`s this tracker's connection can carry beyond the
// device-list itself (see `ControlCenter.runCommand` on the server and `sendCommand()` above) --
// consumed by `SettingsSheet` via `BaseDeviceTracker.on()`.
export interface GoogDeviceTrackerEvents {
    // `encoders`/`config` are omitted when the command rejected; `error` carries the reason.
    list_encoders: {
        udid: string;
        requestId: number;
        encoders?: EncoderInfo[];
        config?: ScrcpyServerConfig;
        error?: string;
    };
    update_stream_config: { udid: string; requestId: number; config?: ScrcpyServerConfig; error?: string };
    get_lock_state: Partial<AndroidLockStateReply> & { udid: string; requestId: number; error?: string };
}

export class DeviceTracker extends BaseDeviceTracker<GoogDeviceDescriptor, GoogDeviceTrackerEvents> {
    public static readonly ACTION = ACTION.GOOG_DEVICE_LIST;
    private static instancesByUrl: Map<string, DeviceTracker> = new Map();
    public static tools: Set<Tool> = new Set();

    public static start(hostItem: HostItem): DeviceTracker {
        const url = this.buildUrlForTracker(hostItem).toString();
        let instance = this.instancesByUrl.get(url);
        if (!instance) {
            instance = new DeviceTracker(hostItem, url);
        }
        return instance;
    }

    public static getInstance(hostItem: HostItem): DeviceTracker {
        return this.start(hostItem);
    }

    protected constructor(params: HostItem, directUrl: string) {
        super({ ...params, action: DeviceTracker.ACTION }, directUrl);
        DeviceTracker.instancesByUrl.set(directUrl, this);
        this.openNewConnection();
    }

    protected onSocketOpen(): void {
        // nothing here;
    }

    protected setIdAndHostName(id: string, hostName: string): void {
        super.setIdAndHostName(id, hostName);
        for (const value of DeviceTracker.instancesByUrl.values()) {
            if (value.id === id && value !== this) {
                console.warn(
                    `Tracker with url: "${this.url}" has the same id(${this.id}) as tracker with url "${value.url}"`,
                );
                console.warn(`This tracker will shut down`);
                this.destroy();
            }
        }
    }

    // The "proxy over adb" address for a device: the current server forwards a TCP connection to
    // the device's local scrcpy server port. This is always available, unlike the direct network
    // interfaces below, which require the device to be reachable on the LAN.
    public static createUrl(params: ParamsDeviceTracker, udid = ''): URL {
        const secure = !!params.secure;
        const hostname = params.hostname || location.hostname;
        const port = typeof params.port === 'number' ? params.port : secure ? 443 : 80;
        const pathname = params.pathname || location.pathname;
        const urlObject = this.buildUrl({ ...params, secure, hostname, port, pathname });
        if (udid) {
            urlObject.searchParams.set('action', ACTION.PROXY_ADB);
            urlObject.searchParams.set('remote', `tcp:${SERVER_PORT.toString(10)}`);
            urlObject.searchParams.set('udid', udid);
        }
        return urlObject;
    }

    public static getLocalStorageKey(fullName: string): string {
        return `device_list::${fullName}::interface`;
    }

    protected getChannelCode(): string {
        return ChannelCode.GTRC;
    }

    public destroy(): void {
        super.destroy();
        if (DeviceTracker.instancesByUrl.get(this.directUrl) === this) {
            DeviceTracker.instancesByUrl.delete(this.directUrl);
        }
    }
}
