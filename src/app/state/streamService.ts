import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';

export type StreamServiceState = 'running' | 'stopped' | 'starting' | 'offline' | 'unauthorized' | 'unknown';
export interface StreamServiceInfo {
    state: StreamServiceState;
    label: string;
    description: string;
}

export function hasRunningStreamService(pid: unknown): boolean {
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

const INFO: Record<StreamServiceState, Omit<StreamServiceInfo, 'state'>> = {
    running: { label: 'Running', description: 'The streaming service is running on this device.' },
    stopped: { label: 'Stopped', description: 'The streaming service is stopped. Opening the screen starts it.' },
    starting: {
        label: 'Starting…',
        description: 'Waiting for the device to confirm that its streaming service started.',
    },
    offline: {
        label: 'Offline',
        description: 'The device is disconnected, so its streaming service cannot be checked.',
    },
    unauthorized: {
        label: 'Unauthorized',
        description: 'Approve USB debugging on the device to check its streaming service.',
    },
    unknown: { label: 'Unknown', description: 'The streaming service status is not available yet.' },
};

export function getStreamServiceStatus(
    descriptor?: Pick<GoogDeviceDescriptor, 'state' | 'pid'>,
    starting = false,
): StreamServiceInfo {
    let state: StreamServiceState = 'unknown';
    if (descriptor?.state === 'unauthorized') {
        state = 'unauthorized';
    } else if (descriptor?.state === 'offline' || descriptor?.state === 'disconnected') {
        state = 'offline';
    } else if (descriptor?.state === 'device') {
        if (hasRunningStreamService(descriptor.pid)) {
            state = 'running';
        } else if (starting) {
            state = 'starting';
        } else if (descriptor.pid === -1) {
            state = 'stopped';
        }
    }
    return { state, ...INFO[state] };
}
