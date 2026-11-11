import type { ParamsStreamScrcpy } from '../../types/ParamsStreamScrcpy';
import { streamSocketUrl } from '../googDevice/client/deviceInterfaces';
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
                canonicalSocket(streamSocketUrl(entry.descriptor.udid, entry.params)) === target,
        );
        return matches.length === 1 ? matches[0] : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The device a stream settings request is for. `deviceKey` names it outright (a device card).
 * A request from the running stream carries only the serial, so it is resolved through the
 * stream's socket. With neither, a serial is accepted only when one device has it: picking the
 * first match would load another host's settings and restart that host's stream.
 */
export function findDeviceForSettings(
    target: { udid: string; deviceKey?: string },
    stream?: ParamsStreamScrcpy,
): DeviceEntry | undefined {
    if (target.deviceKey) {
        return devices.value.get(target.deviceKey);
    }
    if (stream?.udid === target.udid) {
        const bound = findDeviceForStream(stream);
        if (bound) {
            return bound;
        }
    }
    const matches = Array.from(devices.value.values()).filter(
        (entry) => entry.params.type === 'android' && entry.descriptor.udid === target.udid,
    );
    return matches.length === 1 ? matches[0] : undefined;
}
