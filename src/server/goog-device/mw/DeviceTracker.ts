import WS from 'ws';
import { Mw, RequestParameters } from '../../mw/Mw';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { ControlCenter } from '../services/ControlCenter';
import { ACTION } from '../../../common/Action';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { DeviceTrackerEvent } from '../../../types/DeviceTrackerEvent';
import { DeviceTrackerEventList } from '../../../types/DeviceTrackerEventList';
import { TRACKER_STATUS, TrackerStatus } from '../../../common/TrackerStatus';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ChannelCode } from '../../../common/ChannelCode';

export class DeviceTracker extends Mw {
    public static readonly TAG = 'DeviceTracker';
    public static readonly type = 'android';
    private adt: ControlCenter = ControlCenter.getInstance();
    private readonly id: string;
    private watching = false;
    private stopWatchingAdb?: () => void;

    public static processChannel(ws: Multiplexer, code: string): Mw | undefined {
        if (code !== ChannelCode.GTRC) {
            return;
        }
        return new DeviceTracker(ws);
    }

    public static processRequest(ws: WS, params: RequestParameters): DeviceTracker | undefined {
        if (params.action !== ACTION.GOOG_DEVICE_LIST) {
            return;
        }
        return new DeviceTracker(ws);
    }

    constructor(ws: WS | Multiplexer) {
        super(ws);

        this.id = this.adt.getId();
        // Subscribe at once, whatever state adb is in. ControlCenter keeps retrying by itself,
        // and a list opened while adb was down receives the phones when it comes back.
        this.adt.on('device', this.sendDeviceMessage);
        this.stopWatchingAdb = this.adt.onAdbAvailability(this.sendTrackerStatus);
        this.adt.addTrackerClient();
        this.watching = true;
        this.buildAndSendMessage(this.adt.getDevices());
        this.sendTrackerStatus(this.adt.isAdbAvailable());
    }

    private sendTrackerStatus = (available: boolean): void => {
        const data: TrackerStatus = {
            id: this.id,
            name: this.adt.getName(),
            available,
        };
        this.sendMessage({
            id: -1,
            type: TRACKER_STATUS,
            data,
        });
    };

    private sendDeviceMessage = (device: GoogDeviceDescriptor): void => {
        const data: DeviceTrackerEvent<GoogDeviceDescriptor> = {
            device,
            id: this.id,
            name: this.adt.getName(),
        };
        this.sendMessage({
            id: -1,
            type: 'device',
            data,
        });
    };

    private buildAndSendMessage = (list: GoogDeviceDescriptor[]): void => {
        const data: DeviceTrackerEventList<GoogDeviceDescriptor> = {
            list,
            id: this.id,
            name: this.adt.getName(),
        };
        this.sendMessage({
            id: -1,
            type: 'devicelist',
            data,
        });
    };

    protected onSocketMessage(event: WS.MessageEvent): void {
        let command: ControlCenterCommand;
        try {
            command = ControlCenterCommand.fromJSON(event.data.toString());
        } catch (error: any) {
            console.error(`[${DeviceTracker.TAG}], Received message: ${event.data}. Error: ${error?.message}`);
            return;
        }
        this.adt
            .runCommand(command)
            .then((result) => {
                // Commands like LIST_ENCODERS/UPDATE_STREAM_CONFIG resolve with a JSON payload
                // for the requester; plain fire-and-forget commands (kill/start server, etc.)
                // resolve with nothing and get no reply.
                if (typeof result !== 'string') {
                    return;
                }
                this.sendMessage({
                    id: command.getId(),
                    type: command.getType(),
                    data: JSON.parse(result),
                });
            })
            .catch((e) => {
                console.error(`[${DeviceTracker.TAG}], Received message: ${event.data}. Error: ${e.message}`);
                // Reply with the failure too. Without this a rejected command is indistinguishable
                // from one still in progress, so a client waiting on UPDATE_STREAM_CONFIG /
                // LIST_ENCODERS can only ever time out.
                this.sendMessage({
                    id: command.getId(),
                    type: command.getType(),
                    data: { udid: command.getUdid(), error: e.message },
                });
            });
    }

    public release(): void {
        super.release();
        this.adt.off('device', this.sendDeviceMessage);
        this.stopWatchingAdb?.();
        this.stopWatchingAdb = undefined;
        // Guarded: release() can run more than once.
        if (this.watching) {
            this.watching = false;
            this.adt.removeTrackerClient();
        }
    }
}
