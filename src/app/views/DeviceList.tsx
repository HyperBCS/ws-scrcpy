import { useLayoutEffect } from 'preact/hooks';
import { devices, DeviceEntry, deviceName, isDeviceAvailable } from '../state/devices';
import { hostsError, hostsStatus } from '../state/hosts';
import { DeviceCard } from './DeviceCard';
import { DeviceIcon } from '../ui/DeviceIcon';
import '../../style/views/DeviceList.css';

interface TrackerGroup {
    trackerId: string;
    trackerName: string;
    entries: DeviceEntry[];
}

function groupByTracker(list: DeviceEntry[]): TrackerGroup[] {
    const groups = new Map<string, TrackerGroup>();
    list.forEach((entry) => {
        let group = groups.get(entry.trackerId);
        if (!group) {
            group = { trackerId: entry.trackerId, trackerName: entry.trackerName, entries: [] };
            groups.set(entry.trackerId, group);
        }
        group.entries.push(entry);
    });
    return Array.from(groups.values());
}

export function DeviceList() {
    useLayoutEffect(() => {
        document.body.className = 'list';
        document.title = 'Devices · ws-scrcpy';
    }, []);

    const entries = Array.from(devices.value.values());
    const available = entries.filter(isDeviceAvailable).length;
    entries.sort(
        (a, b) =>
            Number(isDeviceAvailable(b)) - Number(isDeviceAvailable(a)) || deviceName(a).localeCompare(deviceName(b)),
    );
    const groups = groupByTracker(entries);
    const disconnected = hostsStatus.value === 'disconnected' || hostsStatus.value === 'error';

    return (
        <main id="devices">
            <div class="devices-content">
                <header class="device-list-header">
                    <h1>Devices</h1>
                    <div class="device-list-summary" role="status">
                        <span class={`device-list-summary-dot ${available ? 'available' : ''}`} />
                        {available
                            ? `${available} available`
                            : entries.length
                              ? 'No devices available'
                              : 'Waiting for devices'}
                    </div>
                </header>

                {!entries.length ? (
                    <section class="device-list-empty" role="status">
                        <DeviceIcon className="device-empty-icon" />
                        <h2>{disconnected ? 'Connection lost' : 'No devices connected'}</h2>
                        <p>
                            {disconnected
                                ? 'Reconnecting…'
                                : 'Connect a device by USB or wireless debugging, then unlock it.'}
                        </p>
                        {hostsError.value && disconnected && <p class="device-empty-error">{hostsError.value}</p>}
                    </section>
                ) : (
                    groups.map((group) => (
                        <section
                            key={group.trackerId}
                            class="tracker-block"
                            aria-label={group.trackerName || 'Devices'}
                        >
                            <div class="tracker-name">
                                <span>{group.trackerName || 'Connected devices'}</span>
                                <span>
                                    {group.entries.length} device{group.entries.length === 1 ? '' : 's'}
                                </span>
                            </div>
                            <div class="device-list">
                                {group.entries.map((entry) => (
                                    <DeviceCard key={entry.key} entry={entry} />
                                ))}
                            </div>
                        </section>
                    ))
                )}
            </div>
        </main>
    );
}
