import { ACTION } from '../../../common/Action';
import { DeviceState } from '../../../common/DeviceState';
import type { BaseDeviceDescriptor } from '../../../types/BaseDeviceDescriptor';
import type { ToolEntry } from '../../client/Tool';

// The device list needs link metadata, not the terminal or file-browser implementation.
// Keep this module free of client imports so those chunks load only when their tool opens.
function deviceTool(title: string, action: ACTION, params: Record<string, string> = {}) {
    return {
        createEntryForDeviceList(descriptor: BaseDeviceDescriptor): ToolEntry | undefined {
            if (descriptor.state !== DeviceState.DEVICE) {
                return;
            }
            return { title, action, params: { udid: descriptor.udid, ...params } };
        },
    };
}

export const shellTool = deviceTool('Shell', ACTION.SHELL);
export const fileListingTool = deviceTool('Files', ACTION.FILE_LISTING, { path: '/data/local/tmp/' });
