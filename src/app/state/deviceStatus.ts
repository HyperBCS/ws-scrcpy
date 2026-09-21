import { signal } from '@preact/signals';
import { DeviceEntry } from './devices';
import { activeStream } from './stream';
import { DeviceState } from '../../common/DeviceState';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import { hasRunningStreamService } from './streamService';

// Single status vocabulary for both the device list and the stream view, replacing the old
// binary red/green dot. `not-active` used to just mean "can't touch this", with no indication of
// *why* -- these status values are the "why".
export type DeviceStatus = 'streaming' | 'ready' | 'locked' | 'asleep' | 'starting' | 'offline' | 'unauthorized';

export interface DeviceStatusInfo {
    status: DeviceStatus;
    label: string;
    // CSS custom property name (see tokens.css) rather than a literal colour, so light/dark
    // theming stays in one place.
    color: string;
    // A plain text glyph instead of another SVG asset -- keeps the bundle small and inherits
    // `color` via `currentColor` for free.
    icon: string;
}

const STATUS_INFO: Record<DeviceStatus, Omit<DeviceStatusInfo, 'status'>> = {
    streaming: { label: 'Streaming', color: 'var(--status-streaming-color)', icon: '▶' },
    ready: { label: 'Ready', color: 'var(--status-ready-color)', icon: '●' },
    locked: { label: 'Locked', color: 'var(--status-asleep-color)', icon: '▣' },
    asleep: { label: 'Asleep', color: 'var(--status-asleep-color)', icon: '☾' },
    starting: { label: 'Starting…', color: 'var(--status-starting-color)', icon: '◐' },
    offline: { label: 'Offline', color: 'var(--status-offline-color)', icon: '○' },
    unauthorized: { label: 'Unauthorized', color: 'var(--status-unauthorized-color)', icon: '⚠' },
};

// Optimistic "starting" flag: set the instant the user hits "Start server" (see DeviceCard),
// cleared automatically -- either the descriptor confirms a pid (the `starting` check below also
// requires no confirmed positive pid, so it stops matching once that happens) or this timeout fires if
// the launch silently failed. There is no server push for "server is starting"; this is the only
// signal the client has in between the click and the next descriptor update.
const STARTING_TIMEOUT_MS = 8000;
const startingKeys = signal<Set<string>>(new Set());
const startingTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function isDeviceStarting(key?: string): boolean {
    return key !== undefined && startingKeys.value.has(key);
}

export function clearStarting(key: string): void {
    const timer = startingTimers.get(key);
    if (timer !== undefined) {
        clearTimeout(timer);
        startingTimers.delete(key);
    }
    const next = new Set(startingKeys.peek());
    if (next.delete(key)) {
        startingKeys.value = next;
    }
}

export function markStarting(key: string): void {
    const next = new Set(startingKeys.value);
    next.add(key);
    startingKeys.value = next;
    const prevTimer = startingTimers.get(key);
    if (prevTimer !== undefined) {
        clearTimeout(prevTimer);
    }
    startingTimers.set(
        key,
        setTimeout(() => clearStarting(key), STARTING_TIMEOUT_MS),
    );
}

// Only ever true while `StreamView` is mounted for this exact udid (see `state/stream.ts`); the
// device list and the stream view are mutually exclusive routes, so this is never true for the
// entry a list is currently rendering for its own tab.
function isStreamingEntry(entry: DeviceEntry): boolean {
    return activeStream.value?.params.udid === entry.descriptor.udid;
}

function deriveGoogStatus(entry: DeviceEntry): DeviceStatus {
    const d = entry.descriptor as GoogDeviceDescriptor;
    if (d.state === 'unauthorized') {
        return 'unauthorized';
    }
    if (d.state !== DeviceState.DEVICE) {
        return 'offline';
    }
    if (isStreamingEntry(entry)) {
        return 'streaming';
    }
    if (d['screen.power'] === 'off' || d['device.awake'] === false) {
        return 'asleep';
    }
    if (d['device.locked'] === true) {
        return 'locked';
    }
    if (!hasRunningStreamService(d.pid) && isDeviceStarting(entry.key)) {
        return 'starting';
    }
    return 'ready';
}

function deriveApplStatus(entry: DeviceEntry): DeviceStatus {
    const d = entry.descriptor as ApplDeviceDescriptor;
    if (d.state === 'unauthorized') {
        return 'unauthorized';
    }
    if (d.state !== DeviceState.CONNECTED) {
        return 'offline';
    }
    if (d.session === 'starting') {
        return 'starting';
    }
    // Same precedence as Android: a running stream is the most useful thing to say about a phone,
    // even one that has gone dark under it (the stream page shows the sleep overlay for that).
    if (d.session === 'ready' || isStreamingEntry(entry)) {
        return 'streaming';
    }
    // `DeviceStateMonitor` reads these over USB; both stay 'unknown' where it is disabled.
    if (d['screen.power'] === 'off') {
        return 'asleep';
    }
    if (d['device.locked'] === true) {
        return 'locked';
    }
    return 'ready';
}

export function getDeviceStatusInfo(entry: DeviceEntry): DeviceStatusInfo {
    const status = entry.params.type === 'android' ? deriveGoogStatus(entry) : deriveApplStatus(entry);
    return { status, ...STATUS_INFO[status] };
}
