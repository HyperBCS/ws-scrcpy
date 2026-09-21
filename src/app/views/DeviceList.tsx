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
                        <h2>{disconnected ? 'Connection interrupted' : 'Your next screen starts here'}</h2>
                        <p>
                            {disconnected
                                ? 'Reconnecting to the device server. Your devices will appear when it is reachable.'
                                : 'Connected Android and iOS devices appear here automatically.'}
                        </p>
                        {hostsError.value && disconnected && <p class="device-empty-error">{hostsError.value}</p>}
                        {!disconnected && (
                            <ol>
                                <li>Connect your device to the server by USB or wireless debugging.</li>
                                <li>Unlock it and approve the debugging or trust prompt.</li>
                                <li>Choose Open screen to start controlling it.</li>
                            </ol>
                        )}
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
