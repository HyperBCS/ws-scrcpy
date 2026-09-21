import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import { ACTION } from '../../../common/Action';
import ApplDeviceDescriptor from '../../../types/ApplDeviceDescriptor';
import { HostItem } from '../../../types/Configuration';
import { ChannelCode } from '../../../common/ChannelCode';
import { Tool } from '../../client/Tool';

export class DeviceTracker extends BaseDeviceTracker<ApplDeviceDescriptor, never> {
    public static ACTION = ACTION.APPL_DEVICE_LIST;
    public static tools: Set<Tool> = new Set();
    private static instancesByUrl: Map<string, DeviceTracker> = new Map();

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

    constructor(params: HostItem, directUrl: string) {
        super({ ...params, action: DeviceTracker.ACTION }, directUrl);
        DeviceTracker.instancesByUrl.set(directUrl, this);
        this.openNewConnection();
    }

    protected onSocketOpen(): void {
        // do nothing;
    }

    protected getChannelCode(): string {
        return ChannelCode.ATRC;
    }

    public destroy(): void {
        super.destroy();
        if (DeviceTracker.instancesByUrl.get(this.directUrl) === this) {
            DeviceTracker.instancesByUrl.delete(this.directUrl);
        }
    }
}
