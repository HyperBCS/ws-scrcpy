import { signal } from '@preact/signals';

/** The sections of the Settings sheet, in the order the sheet shows them. */
export type SettingsSection = 'stream' | 'sound' | 'keyboard' | 'unlock' | 'about';

export interface SettingsSheetTarget {
    udid: string;
    deviceKey?: string;
    /** The section to scroll to and focus when the sheet opens. */
    section?: SettingsSection;
}

// Reachable from places that don't share a component tree -- the in-stream controls (which only
// know `udid`/`client`) and a list card (which knows the list entry) -- so `SettingsSheet` is
// mounted once at the `App` level (see `views/App.tsx`) and reads this instead of being passed
// the target as a prop. One sheet serves both kinds of phone.
export const settingsSheetTarget = signal<SettingsSheetTarget | undefined>(undefined);

/**
 * Opens the Settings sheet for a phone in any state, the one way to open it for either kind of
 * phone; `section` scrolls to that section and focuses its heading. Only the udid is needed: the sheet resolves
 * the tracker itself from the device store. Taking the tracker here meant the caller had to have
 * found the device already, so on a reloaded stream deep link -- where the store is still
 * filling -- the button silently did nothing.
 */
export function openSettings(udid: string, options: { deviceKey?: string; section?: SettingsSection } = {}): void {
    settingsSheetTarget.value = { udid, deviceKey: options.deviceKey, section: options.section };
}

export function closeSettingsSheet(): void {
    settingsSheetTarget.value = undefined;
}
