import { ACTION } from '../../../common/Action';
import { DeviceState } from '../../../common/DeviceState';
import type { BaseDeviceDescriptor } from '../../../types/BaseDeviceDescriptor';
import type { Tool, ToolEntry } from '../../client/Tool';

// Device-list link metadata only, so the stream implementation stays a lazy chunk.
export const coreDeviceStreamTool: Tool = {
    createEntryForDeviceList(descriptor: BaseDeviceDescriptor): ToolEntry | undefined {
        if (descriptor.state !== DeviceState.CONNECTED) {
            return;
        }
        return { title: 'Open screen →', action: ACTION.STREAM_COREDEVICE, params: { udid: descriptor.udid } };
    },
};
