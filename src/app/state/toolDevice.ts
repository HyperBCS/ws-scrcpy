import { ParamsBase } from '../../types/ParamsBase';
import { devices, DeviceEntry } from './devices';

function target(params: ParamsBase): string {
    const remote = typeof params.hostname === 'string' && typeof params.port === 'number';
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    if (remote) {
        url.protocol = params.secure ? 'https:' : 'http:';
        url.hostname = params.hostname as string;
        url.port = String(params.port);
    }
    url.pathname = params.pathname ?? location.pathname;
    return url.toString();
}

/** Device serials can repeat across hosts; tool telemetry must belong to the tool's server. */
export function findDeviceForTool(params: ParamsBase & { udid: string }): DeviceEntry | undefined {
    const endpoint = target(params);
    const matches = Array.from(devices.value.values()).filter(
        (entry) =>
            entry.params.type === 'android' &&
            entry.descriptor.udid === params.udid &&
            target(entry.params) === endpoint,
    );
    return matches.length === 1 ? matches[0] : undefined;
}
