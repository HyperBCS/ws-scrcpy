import { computed, signal } from '@preact/signals';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import { BaseDeviceDescriptor } from '../../types/BaseDeviceDescriptor';
import { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import { BaseDeviceTracker } from '../client/BaseDeviceTracker';
import { DeviceState } from '../../common/DeviceState';
import { capabilities } from './capabilities';
import { rememberedPhone } from './routes';

export type DeviceDescriptor = GoogDeviceDescriptor | ApplDeviceDescriptor;

export interface DeviceEntry {
    key: string;
    trackerId: string;
    trackerName: string;
    params: ParamsDeviceTracker;
    descriptor: DeviceDescriptor;
    // The concrete descriptor type differs per tracker (Goog vs Appl); views narrow on
    // `params.type` and know which shape to expect. Kept loose here so one store can hold both.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tracker: BaseDeviceTracker<any, any>;
    /**
     * The socket of the phone's tracker closed after this entry was listed. The list keeps the
     * phone as it was last reported until the next list replaces it (`markTrackerDevicesStale`).
     * Its status is what it last was, never Offline; it is not available, and the pages of one
     * phone do not find it (`findDeviceByUdid`).
     */
    stale?: boolean;
}

// The single merged, reactive device list every view reads from, across all trackers/hosts.
export const devices = signal<Map<string, DeviceEntry>>(new Map());

// The trackers whose list is on the page, and a host list that named no tracker.
const listedBy = signal<ReadonlySet<object>>(new Set());

/**
 * A list is on the page, or the server tracks no phones. Until then the Phones list says it is
 * loading, not that no phone is connected. A tracker whose phones were cleared after its server
 * stayed away counts again once its next list comes.
 */
export const listReceived = computed(() => listedBy.value.size > 0);

export function setListed(owner: object, listed: boolean): void {
    const current = listedBy.peek();
    if (current.has(owner) === listed) {
        return;
    }
    const next = new Set(current);
    if (listed) {
        next.add(owner);
    } else {
        next.delete(owner);
    }
    listedBy.value = next;
}

// The last name each serial had in the list, for the life of the page. A phone that drops out of
// the list while its page is open keeps its name there.
const lastNames = new Map<string, string>();

/** The name the phone reports, if it has reported one. */
function reportedName(entry: DeviceEntry): string {
    if (entry.params.type === 'android') {
        const descriptor = entry.descriptor as GoogDeviceDescriptor;
        return [descriptor['ro.product.manufacturer'], descriptor['ro.product.model']].filter(Boolean).join(' ');
    }
    const descriptor = entry.descriptor as ApplDeviceDescriptor;
    return descriptor.name || descriptor.model || '';
}

export function deviceName(entry: DeviceEntry): string {
    return reportedName(entry) || (entry.params.type === 'android' ? 'Android phone' : 'iPhone');
}

/**
 * The name to show for a serial: the listed phone's name, else the last name this page saw for
 * it, else the name this browser kept when it last showed the phone's page (a page reloaded
 * after a server restart, before the list is back), else the serial. `entry` is the listed phone
 * the caller resolved, if there is one.
 */
export function phoneName(udid: string, entry?: DeviceEntry): string {
    return (
        (entry && reportedName(entry)) ||
        lastNames.get(udid) ||
        rememberedPhone(udid)?.name ||
        (entry ? deviceName(entry) : udid)
    );
}

function rememberNames(list: Iterable<DeviceEntry>): void {
    for (const entry of list) {
        const name = reportedName(entry);
        if (name) {
            lastNames.set(entry.descriptor.udid, name);
        }
    }
}

/** The server reported the phone connected in its last list. A stale entry keeps what it said. */
export function reportedConnected(entry: DeviceEntry): boolean {
    return entry.descriptor.state === (entry.params.type === 'android' ? DeviceState.DEVICE : DeviceState.CONNECTED);
}

/** The phone is connected and its list is live, so a command or a page can reach it now. */
export function isDeviceAvailable(entry: DeviceEntry): boolean {
    return !entry.stale && reportedConnected(entry);
}

/** A connected device whose screen can be opened. An iPhone with Developer Mode off cannot. */
export function canOpenScreen(entry: DeviceEntry): boolean {
    return (
        isDeviceAvailable(entry) &&
        !(entry.params.type === 'ios' && (entry.descriptor as ApplDeviceDescriptor).developerMode === false)
    );
}

/** Files and Shell run over adb, so only Android devices have them. */
export function supportsDeviceTools(entry: DeviceEntry): boolean {
    const can = capabilities(entry);
    return can.files || can.shell;
}

/**
 * The device a tool link names, when it is one that has no tools (an iPhone). `undefined` for an
 * Android device and for a serial that is not listed, which may still be connecting.
 */
export function findDeviceWithoutTools(udid: string): DeviceEntry | undefined {
    let found: DeviceEntry | undefined;
    for (const entry of devices.value.values()) {
        if (entry.descriptor.udid !== udid || entry.stale) {
            continue;
        }
        if (supportsDeviceTools(entry)) {
            return undefined;
        }
        found = entry;
    }
    return found;
}

function keyFor(trackerId: string, udid: string): string {
    return `${trackerId}:${udid}`;
}

// Replaces every device belonging to one tracker in a single pass (used for the initial/periodic
// full-list message), dropping entries for devices that dropped out of that tracker's list.
export function setTrackerDevices(
    trackerId: string,
    trackerName: string,
    params: ParamsDeviceTracker,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tracker: BaseDeviceTracker<any, any>,
    list: BaseDeviceDescriptor[],
): void {
    const next = new Map(devices.value);
    for (const [key, entry] of next) {
        if (entry.trackerId === trackerId && !list.some((d) => d.udid === entry.descriptor.udid)) {
            next.delete(key);
        }
    }
    list.forEach((descriptor) => {
        const key = keyFor(trackerId, descriptor.udid);
        next.set(key, { key, trackerId, trackerName, params, descriptor: descriptor as DeviceDescriptor, tracker });
    });
    rememberNames(next.values());
    devices.value = next;
    setListed(tracker, true);
}

/**
 * Marks the phones of one tracker stale when its socket closes. They stay on the list as they
 * were last reported; the tracker's next list replaces them (`setTrackerDevices`), and a tracker
 * that stays closed expires each unchanged stale report (`expireTrackerDevices`).
 */
export function markTrackerDevicesStale(trackerId: string, owner: DeviceEntry['tracker']): ReadonlySet<DeviceEntry> {
    const stale = new Set<DeviceEntry>();
    let next: Map<string, DeviceEntry> | undefined;
    for (const [key, entry] of devices.value) {
        if (entry.trackerId === trackerId && entry.tracker === owner && !entry.stale) {
            next ??= new Map(devices.value);
            const marked = { ...entry, stale: true };
            next.set(key, marked);
            stale.add(marked);
        }
    }
    if (next) {
        devices.value = next;
    }
    return stale;
}

/** Expires only the unchanged entries of one close, leaving newer phone updates in place. */
export function expireTrackerDevices(
    trackerId: string,
    owner: DeviceEntry['tracker'],
    stale: ReadonlySet<DeviceEntry>,
): void {
    const next = new Map(devices.value);
    for (const [key, entry] of next) {
        if (entry.trackerId === trackerId && entry.tracker === owner && stale.has(entry)) {
            next.delete(key);
        }
    }
    if (next.size !== devices.value.size) {
        devices.value = next;
    }
    if (![...next.values()].some((entry) => entry.tracker === owner)) {
        setListed(owner, false);
    }
}

// Applies a single-device update (the `device` tracker message) without touching the rest of
// that tracker's entries.
export function updateTrackerDevice(
    trackerId: string,
    trackerName: string,
    params: ParamsDeviceTracker,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tracker: BaseDeviceTracker<any, any>,
    descriptor: BaseDeviceDescriptor,
): void {
    const key = keyFor(trackerId, descriptor.udid);
    const next = new Map(devices.value);
    const entry: DeviceEntry = {
        key,
        trackerId,
        trackerName,
        params,
        descriptor: descriptor as DeviceDescriptor,
        tracker,
    };
    next.set(key, entry);
    rememberNames([entry]);
    devices.value = next;
    setListed(tracker, true);
}

// Used by stream-side views (`views/screen/iphone.tsx`, ...) that only know the udid they show, not
// which tracker it came from -- the merged map is keyed `${trackerId}:${udid}` so a direct lookup
// isn't possible there. A stale entry is left out: a phone's page treats a phone whose list is
// reconnecting as not listed, as it did before the list kept such phones.
export function findDeviceByUdid(udid: string): DeviceEntry | undefined {
    for (const entry of devices.value.values()) {
        if (entry.descriptor.udid === udid && !entry.stale) {
            return entry;
        }
    }
    return undefined;
}

// Called when a tracker is destroyed (host removed, superseded by a de-duplicated instance, ...)
// or stayed closed past its limit, so its devices do not linger in the merged list. Its list is
// no longer on the page until it sends the next one.
export function removeTrackerDevices(trackerId: string, owner?: DeviceEntry['tracker']): void {
    if (owner) {
        setListed(owner, false);
    }
    const next = new Map(devices.value);
    let changed = false;
    for (const [key, entry] of next) {
        if (entry.trackerId === trackerId && (!owner || entry.tracker === owner)) {
            next.delete(key);
            changed = true;
        }
    }
    if (changed) {
        devices.value = next;
    }
}
