import { devices, DeviceEntry } from '../../state/devices';
import { findDeviceForStream } from '../../state/streamDevice';
import { rememberedPhone, Platform } from '../../state/routes';
import type { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import type { SettingsSheetTarget } from '../../state/settingsSheet';

export interface SettingsPhone {
    /** The listed phone, once the list has it. */
    entry?: DeviceEntry;
    /** Its kind: from the list, from a screen open in this browser, or from what this browser last knew. */
    platform?: Platform;
}

/**
 * The phone a Settings target names. `deviceKey` names it outright (a list card). A request from
 * the screen carries only the serial, and two hosts can each have that serial, so an Android
 * screen's own socket decides. Without either, a serial is taken only when one Android phone has
 * it: picking the first would load another host's settings and restart that host's stream. An
 * iPhone serial is its own. A server that restarted lists its phones under a new tracker id, so
 * a card's key that is no longer listed is resolved by the serial in the same way.
 */
export function settingsPhone(
    target: SettingsSheetTarget,
    androidStream?: ParamsStreamScrcpy,
    iosStreamUdid?: string,
): SettingsPhone {
    let entry: DeviceEntry | undefined;
    if (target.deviceKey) {
        entry = devices.value.get(target.deviceKey);
    }
    if (!entry) {
        const bound = androidStream?.udid === target.udid ? findDeviceForStream(androidStream) : undefined;
        const matches = Array.from(devices.value.values()).filter((item) => item.descriptor.udid === target.udid);
        entry = bound ?? (matches.length === 1 ? matches[0] : matches.find((item) => item.params.type === 'ios'));
    }
    const platform: Platform | undefined =
        entry?.params.type ??
        (androidStream?.udid === target.udid
            ? 'android'
            : iosStreamUdid === target.udid
              ? 'ios'
              : rememberedPhone(target.udid)?.platform);
    return { entry, platform };
}
