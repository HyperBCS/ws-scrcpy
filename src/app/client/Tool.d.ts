import { BaseDeviceDescriptor } from '../../types/BaseDeviceDescriptor';

// A tool used to build its own DOM row; now it just describes the link(s) it wants to appear in
// the device list, and `DeviceCard` renders them. `action`/`params` are exactly what `navigate()`
// or an `<a href>` need (see `state/router.ts` and `state/links.ts`).
export interface ToolEntry {
    title: string;
    action: string;
    params?: Record<string, string>;
}

export interface Tool {
    createEntryForDeviceList(descriptor: BaseDeviceDescriptor): ToolEntry[] | ToolEntry | undefined;
}
