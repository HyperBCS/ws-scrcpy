import { ManagerClient } from './ManagerClient';
import { Message } from '../../types/Message';
import { BaseDeviceDescriptor } from '../../types/BaseDeviceDescriptor';
import { DeviceTrackerEvent } from '../../types/DeviceTrackerEvent';
import { DeviceTrackerEventList } from '../../types/DeviceTrackerEventList';
import { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import { HostItem } from '../../types/Configuration';
import { Tool } from './Tool';
import Util from '../Util';
import { EventKey, EventMap } from '../../common/TypedEmitter';
import { removeTrackerDevices, setTrackerDevices, updateTrackerDevice } from '../state/devices';

const TAG = '[BaseDeviceTracker]';

export abstract class BaseDeviceTracker<DD extends BaseDeviceDescriptor, TE extends EventMap> extends ManagerClient<
    ParamsDeviceTracker,
    TE
> {
    public static readonly ACTION_LIST = 'devicelist';
    public static readonly ACTION_DEVICE = 'device';
    public static tools: Set<Tool> = new Set();
    protected static instanceId = 0;

    public static registerTool(tool: Tool): void {
        this.tools.add(tool);
    }

    public static buildUrl(item: HostItem): URL {
        const { secure, port, hostname } = item;
        const pathname = item.pathname ?? '/';
        const protocol = secure ? 'wss:' : 'ws:';
        const url = new URL(`${protocol}//${hostname}${pathname}`);
        if (port) {
            url.port = port.toString();
        }
        return url;
    }

    public static buildUrlForTracker(params: HostItem): URL {
        const wsUrl = this.buildUrl(params);
        wsUrl.searchParams.set('action', this.ACTION);
        return wsUrl;
    }

    protected title = 'Device list';
    protected descriptors: DD[] = [];
    protected elementId: string;
    protected trackerName = '';
    protected id = '';
    private messageId = 0;
    private reconnectTimer?: ReturnType<typeof setTimeout>;

    protected constructor(
        params: ParamsDeviceTracker,
        protected readonly directUrl: string,
    ) {
        super(params);
        this.elementId = `tracker_instance${++BaseDeviceTracker.instanceId}`;
        this.trackerName = `Unavailable. Host: ${params.hostname}, type: ${params.type}`;
    }

    public static parseParameters(params: URLSearchParams): ParamsDeviceTracker {
        const typedParams = super.parseParameters(params);
        const type = Util.parseString(params, 'type', true);
        if (type !== 'android' && type !== 'ios') {
            throw Error('Incorrect type');
        }
        return { ...typedParams, type };
    }

    protected getNextId(): number {
        return ++this.messageId;
    }

    // Sends a `{ id, type, data }` command back over this tracker's socket, e.g. for the
    // kill/start-server and update-interfaces actions the device list exposes per device.
    public sendCommand(type: string, data: Record<string, unknown> = {}): number {
        const message: Message = {
            id: this.getNextId(),
            type,
            data,
        };
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
        return message.id;
    }

    protected publishDevices(): void {
        if (this.destroyed) {
            return;
        }
        setTrackerDevices(this.id, this.trackerName, this.params, this, this.descriptors);
    }

    protected onSocketClose(event: CloseEvent): void {
        if (this.destroyed) {
            return;
        }
        console.log(TAG, `Connection closed: ${event.reason}`);
        this.descriptors = [];
        removeTrackerDevices(this.id, this);
        if (this.reconnectTimer === undefined) {
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = undefined;
                if (!this.destroyed) {
                    this.openNewConnection();
                }
            }, 2000);
        }
    }

    protected onSocketMessage(event: MessageEvent): void {
        if (this.destroyed) {
            return;
        }
        let message: Message;
        try {
            message = JSON.parse(event.data);
        } catch (error: any) {
            console.error(TAG, error.message);
            console.log(TAG, error.data);
            return;
        }
        switch (message.type) {
            case BaseDeviceTracker.ACTION_LIST: {
                const event = message.data as DeviceTrackerEventList<DD>;
                this.descriptors = event.list;
                this.setIdAndHostName(event.id, event.name);
                this.publishDevices();
                break;
            }
            case BaseDeviceTracker.ACTION_DEVICE: {
                const event = message.data as DeviceTrackerEvent<DD>;
                this.setIdAndHostName(event.id, event.name);
                this.updateDescriptor(event.device);
                if (!this.destroyed) {
                    updateTrackerDevice(this.id, this.trackerName, this.params, this, event.device);
                }
                break;
            }
            default:
                // Replies to `sendCommand()` (e.g. goog's LIST_ENCODERS/UPDATE_STREAM_CONFIG,
                // see `ControlCenterCommand`) land here with `message.type` equal to the
                // command's own type string and `message.data` as its payload. Forward them
                // through the typed emitter instead of every command needing its own
                // `onSocketMessage` override in a subclass -- callers of `sendCommand()` just
                // `.on()` the matching event name (declared in that subclass's own `TE`).
                this.emit(
                    message.type as EventKey<TE>,
                    message.data && typeof message.data === 'object' && !Array.isArray(message.data)
                        ? { ...message.data, requestId: message.id }
                        : message.data,
                );
        }
    }

    protected setIdAndHostName(id: string, trackerName: string): void {
        if (this.id === id && this.trackerName === trackerName) {
            return;
        }
        if (this.id !== id) {
            removeTrackerDevices(this.id, this);
        }
        this.id = id;
        this.trackerName = trackerName;
    }

    protected updateDescriptor(descriptor: DD): void {
        const idx = this.descriptors.findIndex((item: DD) => {
            return item.udid === descriptor.udid;
        });
        if (idx !== -1) {
            this.descriptors[idx] = descriptor;
        } else {
            this.descriptors.push(descriptor);
        }
    }

    public getDescriptorByUdid(udid: string): DD | undefined {
        if (!this.descriptors.length) {
            return;
        }
        return this.descriptors.find((descriptor: DD) => {
            return descriptor.udid === udid;
        });
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        super.destroy();
        this.descriptors = [];
        // Two URLs can resolve to the same server id; destroying the duplicate must not
        // remove the surviving tracker's cards.
        removeTrackerDevices(this.id, this);
    }

    protected supportMultiplexing(): boolean {
        return true;
    }

    protected getChannelCode(): string {
        throw Error('Not implemented. Must override');
    }

    protected getChannelInitData(): Buffer {
        const code = this.getChannelCode();
        const buffer = Buffer.alloc(code.length);
        buffer.write(code, 'ascii');
        return buffer;
    }
}
