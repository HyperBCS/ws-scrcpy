import WS from 'ws';
import { Mw, RequestParameters } from '../../mw/Mw';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { ACTION } from '../../../common/Action';
import { DeviceTrackerEvent } from '../../../types/DeviceTrackerEvent';
import { DeviceTrackerEventList } from '../../../types/DeviceTrackerEventList';
import { ControlCenter } from '../services/ControlCenter';
import ApplDeviceDescriptor from '../../../types/ApplDeviceDescriptor';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ChannelCode } from '../../../common/ChannelCode';

export class DeviceTracker extends Mw {
    public static readonly TAG = 'IosDeviceTracker';
    public static readonly type = 'ios';
    private icc: ControlCenter = ControlCenter.getInstance();
    private readonly id: string;
    private released = false;

    public static processChannel(ws: Multiplexer, code: string): Mw | undefined {
        if (code !== ChannelCode.ATRC) {
            return;
        }
        return new DeviceTracker(ws);
    }

    public static processRequest(ws: WS, params: RequestParameters): DeviceTracker | undefined {
        if (params.action !== ACTION.APPL_DEVICE_LIST) {
            return;
        }
        return new DeviceTracker(ws);
    }

    constructor(ws: WS | Multiplexer) {
        super(ws);

        this.id = this.icc.getId();
        this.icc
            .init()
            .then(() => {
                if (this.released) {
                    // The socket closed while the tracker was still starting. `release()` had no
                    // listener to remove then, so none is added now.
                    return;
                }
                this.icc.on('device', this.sendDeviceMessage);
                this.buildAndSendMessage(this.icc.getDevices());
            })
            .catch((error: Error) => {
                console.error(`[${DeviceTracker.TAG}] Error: ${error.message}`);
            });
    }

    private sendDeviceMessage = (device: ApplDeviceDescriptor): void => {
        const data: DeviceTrackerEvent<ApplDeviceDescriptor> = {
            device,
            id: this.id,
            name: this.icc.getName(),
        };
        this.sendMessage({
            id: -1,
            type: 'device',
            data,
        });
    };

    private buildAndSendMessage = (list: ApplDeviceDescriptor[]): void => {
        const data: DeviceTrackerEventList<ApplDeviceDescriptor> = {
            list,
            id: this.id,
            name: this.icc.getName(),
        };
        this.sendMessage({
            id: -1,
            type: 'devicelist',
            data,
        });
    };

    /**
     * What a log line may say about a message: its type and device, never its data. The body of
     * a rejected `set_unlock_passcode` carries the passcode, and the server log is not private.
     */
    private static describe(raw: string): string {
        try {
            const body = JSON.parse(raw);
            const type = typeof body?.type === 'string' ? body.type.slice(0, 64) : 'no type';
            const udid = typeof body?.data?.udid === 'string' ? body.data.udid.slice(0, 64) : 'no device';
            return `"${type}" for ${udid}`;
        } catch {
            return 'unparseable message';
        }
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        const raw = event.data.toString();
        let command: ControlCenterCommand;
        try {
            command = ControlCenterCommand.fromJSON(raw);
        } catch (error: any) {
            // A SyntaxError from JSON.parse quotes the input, so it is not repeated either.
            const reason = error instanceof SyntaxError ? 'not valid JSON' : error.message;
            console.error(`[${DeviceTracker.TAG}], Rejected ${DeviceTracker.describe(raw)}. Error: ${reason}`);
            return;
        }
        // Answered like the Android tracker does, so the device card can show the outcome of a
        // long command (enabling Developer Mode reboots the phone) instead of guessing.
        this.icc
            .runCommand(command)
            .then((result) => {
                this.sendMessage({
                    id: command.getId(),
                    type: command.getType(),
                    data: { udid: command.getUdid(), result: result ?? null },
                });
            })
            .catch((error: Error) => {
                console.error(
                    `[${DeviceTracker.TAG}], Command "${command.getType()}" for ${command.getUdid()} failed. ` +
                        `Error: ${error.message}`,
                );
                this.sendMessage({
                    id: command.getId(),
                    type: command.getType(),
                    data: { udid: command.getUdid(), error: error.message },
                });
            });
    }

    public release(): void {
        this.released = true;
        super.release();
        this.icc.off('device', this.sendDeviceMessage);
    }
}
