import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { SERVER_PORT } from '../../../common/Constants';
import { DeviceTracker } from './DeviceTracker';

export interface InterfaceOption {
    name: string;
    label: string;
    url: string;
}

// Mirrors the old `buildDeviceRow`'s interface <select>: when the scrcpy server only listens on
// localhost (`SCRCPY_LISTENS_ON_ALL_INTERFACES=false`, the common case), the only way to reach a
// device is proxying the connection over adb through this server. When it listens on all
// interfaces, the device's own network interfaces are offered directly too. Kept as a plain
// function (not JSX) so the `ifdef-loader` block below stays easy to reason about.
export function buildInterfaceOptions(device: GoogDeviceDescriptor, params: ParamsDeviceTracker): InterfaceOption[] {
    const options: InterfaceOption[] = [];
    /// #if SCRCPY_LISTENS_ON_ALL_INTERFACES
    device.interfaces.forEach((value) => {
        const url = DeviceTracker.createUrl({
            ...params,
            secure: false,
            hostname: value.ipv4,
            port: SERVER_PORT,
        }).toString();
        options.push({ name: value.name, label: `${value.name}: ${value.ipv4}`, url });
    });
    /// #endif
    const proxyUrl = DeviceTracker.createUrl(params, device.udid).toString();
    options.push({ name: 'proxy', label: 'proxy over adb', url: proxyUrl });
    return options;
}

export function pickDefaultInterfaceName(device: GoogDeviceDescriptor, fullName: string): string {
    let lastSelected: string | null = null;
    try {
        lastSelected = localStorage.getItem(DeviceTracker.getLocalStorageKey(fullName));
    } catch {
        // localStorage can throw (private mode, disabled site data); fall back below.
    }
    if (lastSelected) {
        return lastSelected;
    }
    /// #if SCRCPY_LISTENS_ON_ALL_INTERFACES
    if (device['wifi.interface']) {
        return device['wifi.interface'];
    }
    /// #endif
    return 'proxy';
}

export function rememberSelectedInterface(fullName: string, name: string): void {
    try {
        localStorage.setItem(DeviceTracker.getLocalStorageKey(fullName), name);
    } catch {
        // ignore, see above
    }
}
