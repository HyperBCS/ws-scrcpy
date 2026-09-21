import { signal } from '@preact/signals';
import { HostTracker } from '../client/HostTracker';

export type HostsStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

// A successful host-list reply clears any earlier transport error, including after reconnect.
export const hostsStatus = signal<HostsStatus>('connecting');
export const hostsError = signal<string | undefined>(undefined);

let subscribedTracker: HostTracker | undefined;

export function startHostTracker(): HostTracker {
    const instance = HostTracker.getInstance();
    if (subscribedTracker !== instance) {
        subscribedTracker = instance;
        instance.on('connected', () => {
            hostsStatus.value = 'connected';
            hostsError.value = undefined;
        });
        instance.on('disconnected', () => {
            hostsStatus.value = 'disconnected';
        });
        instance.on('error', (message) => {
            hostsError.value = message;
            hostsStatus.value = 'error';
        });
    }
    return instance;
}
