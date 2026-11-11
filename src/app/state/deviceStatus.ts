import { signal } from '@preact/signals';
import { DeviceEntry } from './devices';
import { activeStream } from './stream';
import { DeviceState } from '../../common/DeviceState';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import { hasRunningStreamService } from './streamService';
import { unlockCardLine } from './unlockSchedule';
import type { ChipTone } from '../ui/Chip';

// Single status vocabulary for both the device list and the stream view, replacing the old
// binary red/green dot. `not-active` used to just mean "can't touch this", with no indication of
// *why* -- these status values are the "why".
// `attention` is a device that works but needs the owner to do something (Developer Mode is off,
// the scheduled unlock cannot run). `error` is a device whose screen session has failed.
export type DeviceStatus =
    'streaming' | 'ready' | 'locked' | 'asleep' | 'starting' | 'offline' | 'unauthorized' | 'attention' | 'error';

export interface DeviceStatusInfo {
    status: DeviceStatus;
    label: string;
    /** The tone of the chip that shows the label (`ui/Chip.tsx`). */
    tone: ChipTone;
}

const STATUS_INFO: Record<DeviceStatus, Omit<DeviceStatusInfo, 'status'>> = {
    streaming: { label: 'Streaming', tone: 'info' },
    ready: { label: 'Ready', tone: 'success' },
    locked: { label: 'Locked', tone: 'info' },
    asleep: { label: 'Asleep', tone: 'info' },
    starting: { label: 'Starting…', tone: 'warning' },
    offline: { label: 'Offline', tone: 'neutral' },
    unauthorized: { label: 'Unauthorized', tone: 'error' },
    attention: { label: 'Needs attention', tone: 'warning' },
    error: { label: 'Error', tone: 'error' },
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

export interface DeviceProblem {
    kind: 'developer-mode' | 'session' | 'unlock';
    level: 'attention' | 'error';
    message: string;
}

/**
 * What is wrong with a connected device, most serious first. Empty for a healthy device and for
 * one that is offline or untrusted, which its status already says. Only iPhones report these.
 */
export function getDeviceProblems(entry: DeviceEntry, now = Date.now()): DeviceProblem[] {
    if (entry.params.type !== 'ios') {
        return [];
    }
    const d = entry.descriptor as ApplDeviceDescriptor;
    if (d.state !== DeviceState.CONNECTED) {
        return [];
    }
    const problems: DeviceProblem[] = [];
    if (d.session === 'error') {
        problems.push({
            kind: 'session',
            level: 'error',
            message: d.sessionMessage || 'The screen session failed.',
        });
    }
    if (d.developerMode === false) {
        problems.push({
            kind: 'developer-mode',
            level: 'attention',
            message: 'Enable Developer Mode to open the screen.',
        });
    }
    const unlock = d.unlockSchedule && unlockCardLine(d.unlockSchedule, now);
    if (unlock?.problem) {
        problems.push({ kind: 'unlock', level: 'attention', message: unlock.text });
    }
    return problems;
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
    if (d.session === 'error') {
        return 'error';
    }
    // Same precedence as Android: a running stream is the most useful thing to say about a phone,
    // even one that has gone dark under it (the stream page shows the sleep overlay for that).
    if (d.session === 'ready' || isStreamingEntry(entry)) {
        return 'streaming';
    }
    // A phone that needs something done says so before it says Asleep, Locked or Ready.
    if (getDeviceProblems(entry).length) {
        return 'attention';
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

/** True for a device the Devices header counts as needing attention, whatever its badge says. */
export function needsAttention(entry: DeviceEntry): boolean {
    return getDeviceProblems(entry).length > 0;
}

/** "3 available · 1 needs attention": the header pill counts blocked and failed devices too. */
export function listSummary(total: number, available: number, attention: number): string {
    const base = available ? `${available} available` : total ? 'No devices available' : 'Waiting for devices';
    return attention ? `${base} · ${attention} ${attention === 1 ? 'needs' : 'need'} attention` : base;
}
