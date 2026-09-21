import { signal } from '@preact/signals';

export interface SettingsSheetTarget {
    udid: string;
    deviceKey?: string;
}

// Reachable from two places that don't share a component tree -- the in-stream toolbar
// (`GoogToolBox`, which only knows `udid`/`client`) and a device-list card (`DeviceCard`, which
// only knows `udid`/`tracker`) -- so `SettingsSheet` is mounted once at the `App` level (see
// `views/App.tsx`) and reads this instead of being passed the target as a prop.
export const settingsSheetTarget = signal<SettingsSheetTarget | undefined>(undefined);

/**
 * Only the udid is carried: the sheet resolves the tracker itself from the device store. Taking
 * the tracker here meant the caller had to have found the device already, so on a reloaded stream
 * deep link -- where the store is still filling -- the button silently did nothing.
 */
export function openSettingsSheet(udid: string, deviceKey?: string): void {
    settingsSheetTarget.value = { udid, deviceKey };
}

export function closeSettingsSheet(): void {
    settingsSheetTarget.value = undefined;
}
