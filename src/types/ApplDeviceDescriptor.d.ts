import { BaseDeviceDescriptor } from './BaseDeviceDescriptor';
import { CoreDeviceSessionState } from '../common/CoreDeviceProtocol';
import { KnownBoolean } from './AndroidLockState';

export default interface ApplDeviceDescriptor extends BaseDeviceDescriptor {
    name: string;
    model: string;
    // Apple's identifier (`iPhone14,3`); `model` is its marketing name.
    productType?: string;
    version: string;
    'last.update.timestamp': number;
    // Lockdown could be reached: the phone has trusted this host. `false` while the "Trust This
    // Computer" prompt is still unanswered (`state` is 'unauthorized' then).
    paired?: boolean;
    // Settings > Privacy & Security > Developer Mode. Required for every CoreDevice service;
    // `'unknown'` until lockdown answered.
    developerMode?: boolean | 'unknown';
    // The screen/HID session (`pymobiledevice3 ... display serve-web`) for this device.
    session?: CoreDeviceSessionState;
    sessionMessage?: string;
    // Runtime state read by `DeviceStateMonitor`, named like the Android fields so the shared
    // status/overlay code treats both platforms alike. `screen.power` comes from the display
    // backlight in the IORegistry; `device.locked` from an accessibility walk of the screen (the
    // lock screen exposes a "Locked"/"Unlocked" padlock). Absent or 'unknown' until probed.
    'screen.power'?: 'on' | 'off' | 'unknown';
    'device.locked'?: KnownBoolean;
}
