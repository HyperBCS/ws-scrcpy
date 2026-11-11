import { useLayoutEffect, useRef } from 'preact/hooks';
import { devices, DeviceEntry, deviceName, isDeviceAvailable } from '../state/devices';
import { listSummary, needsAttention } from '../state/deviceStatus';
import { rememberListScroll, savedListScroll } from '../state/deviceListView';
import { hostsError, hostsStatus } from '../state/hosts';
import { LIST_PAGE_NAME } from '../state/routes';
import { DeviceCard } from './DeviceCard';
import { DeviceIcon } from '../ui/DeviceIcon';
import { TrackerStatusNotice } from '../ui/TrackerStatusNotice';
import { NotificationsLink } from '../ui/NotificationsLink';
import '../../style/views/DeviceList.css';

interface HostGroup {
    key: string;
    name: string;
    entries: DeviceEntry[];
}

function groupByHost(list: DeviceEntry[]): HostGroup[] {
    const groups = new Map<string, HostGroup>();
    list.forEach((entry) => {
        const {
            hostname = location.hostname,
            port = location.port,
            pathname = location.pathname,
            secure,
        } = entry.params;
        const key = `${secure ? 'https' : 'http'}://${hostname}:${port}${pathname}`;
        let group = groups.get(key);
        if (!group) {
            group = { key, name: hostname, entries: [] };
            groups.set(key, group);
        }
        group.entries.push(entry);
    });
    return Array.from(groups.values());
}

export function DeviceList() {
    const scroller = useRef<HTMLElement>(null);
    useLayoutEffect(() => {
        document.body.className = 'list';
        // Back from a screen, a tool or Notifications: the list is where it was left. The cards
        // have already reopened their disclosures (see `CardDetails`), so the height is final.
        if (scroller.current) {
            scroller.current.scrollTop = savedListScroll();
        }
    }, []);

    const entries = Array.from(devices.value.values());
    const available = entries.filter(isDeviceAvailable).length;
    const attention = entries.filter(needsAttention).length;
    entries.sort(
        (a, b) =>
            Number(isDeviceAvailable(b)) - Number(isDeviceAvailable(a)) || deviceName(a).localeCompare(deviceName(b)),
    );
    const groups = groupByHost(entries);
    const disconnected = hostsStatus.value === 'disconnected' || hostsStatus.value === 'error';

    return (
        <main id="devices" ref={scroller} onScroll={(event) => rememberListScroll(event.currentTarget.scrollTop)}>
            <div class="devices-content">
                <header class="device-list-header">
                    <h1>{LIST_PAGE_NAME}</h1>
                    <div class="device-list-summary" role="status">
                        <span
                            class={`device-list-summary-dot ${attention ? 'attention' : available ? 'available' : ''}`}
                        />
                        {listSummary(entries.length, available, attention)}
                    </div>
                    <div class="device-list-actions">
                        <NotificationsLink />
                        {/* An installed app has no browser reload button, and pull-to-refresh is off. */}
                        <button
                            type="button"
                            class="device-list-reload"
                            title="Reload"
                            aria-label="Reload"
                            onClick={() => location.reload()}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.8"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                aria-hidden="true"
                            >
                                <path d="M20 11a8 8 0 1 0-2.3 6.3" />
                                <path d="M20 4v7h-7" />
                            </svg>
                        </button>
                    </div>
                </header>
                <TrackerStatusNotice />

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
                            key={group.key}
                            class="tracker-block"
                            aria-label={groups.length > 1 ? group.name : 'Connected devices'}
                        >
                            {groups.length > 1 && (
                                <div class="tracker-name">
                                    <span>{group.name}</span>
                                    <span>
                                        {group.entries.length} device{group.entries.length === 1 ? '' : 's'}
                                    </span>
                                </div>
                            )}
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
