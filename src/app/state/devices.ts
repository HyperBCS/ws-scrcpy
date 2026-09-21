import { signal } from '@preact/signals';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import { BaseDeviceDescriptor } from '../../types/BaseDeviceDescriptor';
import { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import { BaseDeviceTracker } from '../client/BaseDeviceTracker';
import { DeviceState } from '../../common/DeviceState';

export type DeviceDescriptor = GoogDeviceDescriptor | ApplDeviceDescriptor;

export interface DeviceEntry {
    key: string;
    trackerId: string;
    trackerName: string;
    params: ParamsDeviceTracker;
    descriptor: DeviceDescriptor;
    // The concrete descriptor type differs per tracker (Goog vs Appl); views narrow on
    // `params.type` and know which shape to expect. Kept loose here so one store can hold both.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tracker: BaseDeviceTracker<any, any>;
}

// The single merged, reactive device list every view reads from, across all trackers/hosts.
export const devices = signal<Map<string, DeviceEntry>>(new Map());

export function deviceName(entry: DeviceEntry): string {
    if (entry.params.type === 'android') {
        const descriptor = entry.descriptor as GoogDeviceDescriptor;
        return (
            [descriptor['ro.product.manufacturer'], descriptor['ro.product.model']].filter(Boolean).join(' ') ||
            'Android device'
        );
    }
    const descriptor = entry.descriptor as ApplDeviceDescriptor;
    return descriptor.name || descriptor.model || 'iOS device';
}

export function isDeviceAvailable(entry: DeviceEntry): boolean {
    return entry.descriptor.state === (entry.params.type === 'android' ? DeviceState.DEVICE : DeviceState.CONNECTED);
}

function keyFor(trackerId: string, udid: string): string {
    return `${trackerId}:${udid}`;
}

// Replaces every device belonging to one tracker in a single pass (used for the initial/periodic
// full-list message), dropping entries for devices that dropped out of that tracker's list.
export function setTrackerDevices(
    trackerId: string,
    trackerName: string,
    params: ParamsDeviceTracker,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tracker: BaseDeviceTracker<any, any>,
    list: BaseDeviceDescriptor[],
): void {
    const next = new Map(devices.value);
    for (const [key, entry] of next) {
        if (entry.trackerId === trackerId && !list.some((d) => d.udid === entry.descriptor.udid)) {
            next.delete(key);
        }
    }
    list.forEach((descriptor) => {
        const key = keyFor(trackerId, descriptor.udid);
        next.set(key, { key, trackerId, trackerName, params, descriptor: descriptor as DeviceDescriptor, tracker });
    });
    devices.value = next;
}

// Applies a single-device update (the `device` tracker message) without touching the rest of
// that tracker's entries.
export function updateTrackerDevice(
    trackerId: string,
    trackerName: string,
    params: ParamsDeviceTracker,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tracker: BaseDeviceTracker<any, any>,
    descriptor: BaseDeviceDescriptor,
): void {
    const key = keyFor(trackerId, descriptor.udid);
    const next = new Map(devices.value);
    next.set(key, { key, trackerId, trackerName, params, descriptor: descriptor as DeviceDescriptor, tracker });
    devices.value = next;
}

// Used by stream-side views (`SleepOverlay`, ...) that only know the udid they are streaming, not
// which tracker it came from -- the merged map is keyed `${trackerId}:${udid}` so a direct lookup
// isn't possible there.
export function findDeviceByUdid(udid: string): DeviceEntry | undefined {
    for (const entry of devices.value.values()) {
        if (entry.descriptor.udid === udid) {
            return entry;
        }
    }
    return undefined;
}

// Called when a tracker is destroyed (host removed, superseded by a de-duplicated instance, ...)
// so its devices do not linger in the merged list.
export function removeTrackerDevices(trackerId: string, owner?: DeviceEntry['tracker']): void {
    const next = new Map(devices.value);
    let changed = false;
    for (const [key, entry] of next) {
        if (entry.trackerId === trackerId && (!owner || entry.tracker === owner)) {
            next.delete(key);
            changed = true;
        }
    }
    if (changed) {
        devices.value = next;
    }
}
