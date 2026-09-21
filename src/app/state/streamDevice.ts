import type { ParamsStreamScrcpy } from '../../types/ParamsStreamScrcpy';
import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { buildInterfaceOptions } from '../googDevice/client/deviceInterfaces';
import { devices, DeviceEntry } from './devices';

function canonicalSocket(value: string): string {
    const url = new URL(value);
    url.searchParams.sort();
    return url.toString();
}

/** A serial is not unique across hosts (for example emulator-5554). Bind telemetry to its socket. */
export function findDeviceForStream(params: ParamsStreamScrcpy): DeviceEntry | undefined {
    try {
        const target = canonicalSocket(params.ws);
        const matches = Array.from(devices.value.values()).filter(
            (entry) =>
                entry.params.type === 'android' &&
                entry.descriptor.udid === params.udid &&
                buildInterfaceOptions(entry.descriptor as GoogDeviceDescriptor, entry.params).some(
                    (option) => canonicalSocket(option.url) === target,
                ),
        );
        return matches.length === 1 ? matches[0] : undefined;
    } catch {
        return undefined;
    }
}
