import { signal } from '@preact/signals';
import type { DeviceEntry } from './devices';
import { activeCoreDeviceStream, activeStream } from './stream';
import { DeviceState } from '../../common/DeviceState';
import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import type ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import type { KnownBoolean } from '../../types/AndroidLockState';
import { unlockCardLine } from './unlockSchedule';
import type { ChipTone } from '../ui/Chip';
import type { IconName } from '../ui/icons';
import {
    CONNECTION,
    FACT,
    LIST_SUMMARY,
    LOCK,
    PROBLEM,
    SCREEN,
    SCREEN_CONNECTION,
    SESSION,
    STATUS,
    STREAM_SERVICE,
} from '../copy';

/*
 * One status model for both kinds of phone. An adapter per platform turns a list entry into
 * facts (`phoneFacts`); one function turns facts into the status (`derivePhoneStatus`). Nothing
 * else reads a descriptor field to decide a status. The words are in `copy.ts`.
 */

/** The phone's screen session: an iPhone's session, or an Android phone's stream service. */
export type SessionState = 'starting' | 'running' | 'failed' | 'stopped' | 'unknown';
/** 'unknown' until the phone reports it, and wherever its probe is off. Never shown as asleep. */
export type ScreenState = 'on' | 'asleep' | 'unknown';
/** 'unknown' until the phone reports it. Never shown as locked. */
export type LockState = 'locked' | 'unlocked' | 'unknown';

/**
 * What is wrong with a connected phone. `attention` is a phone that works but needs the owner to
 * do something (Developer Mode is off, the scheduled unlock cannot run). `error` is a phone whose
 * screen session has failed.
 */
export interface DeviceProblem {
    kind: 'developer-mode' | 'session' | 'unlock';
    level: 'attention' | 'error';
    message: string;
}

export interface PhoneFacts {
    /** The phone has trusted this computer (USB debugging approved, Trust This Computer). */
    trusted: boolean;
    /** The server reaches the phone. */
    connected: boolean;
    session: SessionState;
    /** Most serious first. */
    problems: readonly DeviceProblem[];
    screen: ScreenState;
    lock: LockState;
    /** This browser shows the phone's screen. */
    viewed: boolean;
}

export type PhoneStatusKind =
    'unauthorized' | 'offline' | 'error' | 'starting' | 'attention' | 'asleep' | 'locked' | 'ready';

/** The one precedence of the primary status, the same for an Android phone and an iPhone. */
export const PHONE_STATUS_ORDER: readonly PhoneStatusKind[] = [
    'unauthorized',
    'offline',
    'error',
    'starting',
    'attention',
    'asleep',
    'locked',
    'ready',
];

export interface PhoneStatus {
    status: PhoneStatusKind;
    label: string;
    /** The tone of the chip that shows the label (`ui/Chip.tsx`). */
    tone: ChipTone;
    /**
     * A secondary marker: a screen session runs for the phone (an iPhone's session is ready, an
     * Android phone's stream service runs) or this browser shows it. It never takes the place of
     * Asleep, Locked or Ready.
     */
    sessionRunning: boolean;
    /** The screen and the lock of a connected phone; 'unknown' for any other. */
    screen: ScreenState;
    lock: LockState;
}

const STATUS_TONE: Record<PhoneStatusKind, ChipTone> = {
    unauthorized: 'error',
    offline: 'neutral',
    error: 'error',
    starting: 'warning',
    attention: 'warning',
    asleep: 'info',
    locked: 'info',
    ready: 'success',
};

function primaryStatus(facts: PhoneFacts): PhoneStatusKind {
    if (!facts.trusted) {
        return 'unauthorized';
    }
    if (!facts.connected) {
        return 'offline';
    }
    if (facts.session === 'failed' || facts.problems.some((problem) => problem.level === 'error')) {
        return 'error';
    }
    if (facts.session === 'starting') {
        return 'starting';
    }
    // A phone that needs something done says so before it says Asleep, Locked or Ready.
    if (facts.problems.some((problem) => problem.level === 'attention')) {
        return 'attention';
    }
    // Only on positive evidence: an unknown screen or lock is never shown as asleep or locked.
    if (facts.screen === 'asleep') {
        return 'asleep';
    }
    if (facts.lock === 'locked') {
        return 'locked';
    }
    return 'ready';
}

/** The status for a set of facts. The same facts give the same status on both platforms. */
export function derivePhoneStatus(facts: PhoneFacts): PhoneStatus {
    const status = primaryStatus(facts);
    const reachable = facts.trusted && facts.connected;
    return {
        status,
        label: STATUS[status],
        tone: STATUS_TONE[status],
        sessionRunning: reachable && (facts.session === 'running' || facts.viewed),
        screen: reachable ? facts.screen : 'unknown',
        lock: reachable ? facts.lock : 'unknown',
    };
}

// Set the instant the owner presses Start on an Android card (see DeviceCard), cleared either
// when the descriptor confirms a pid (the adapter only counts it while no pid is confirmed) or by
// this timeout if the launch failed without a word. There is no server push for "the service is
// starting"; this is the only signal between the press and the next descriptor update.
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

export function hasRunningStreamService(pid: unknown): boolean {
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

function lockOf(locked: KnownBoolean | undefined): LockState {
    return locked === true ? 'locked' : locked === false ? 'unlocked' : 'unknown';
}

function googFacts(entry: DeviceEntry): PhoneFacts {
    const d = entry.descriptor as GoogDeviceDescriptor;
    const running = hasRunningStreamService(d.pid);
    return {
        trusted: d.state !== 'unauthorized',
        connected: d.state === DeviceState.DEVICE,
        // pid > 0: observed running; -1: confirmed absent; 0: not known.
        session: running ? 'running' : isDeviceStarting(entry.key) ? 'starting' : d.pid === -1 ? 'stopped' : 'unknown',
        // Android phones report no problems today.
        problems: [],
        // `screen.power` is 'unknown' on phones whose dumpsys does not report it.
        screen:
            d['screen.power'] === 'off' || d['device.awake'] === false
                ? 'asleep'
                : d['screen.power'] === 'on' || d['device.awake'] === true
                  ? 'on'
                  : 'unknown',
        lock: lockOf(d['device.locked']),
        // Only while `StreamView` is mounted for this serial (`state/stream.ts`). The list and a
        // screen are separate pages, so a card is never viewed.
        viewed: activeStream.value?.params.udid === d.udid,
    };
}

const APPL_SESSION: Record<NonNullable<ApplDeviceDescriptor['session']>, SessionState> = {
    starting: 'starting',
    ready: 'running',
    error: 'failed',
    stopped: 'stopped',
};

function applProblems(d: ApplDeviceDescriptor, now: number): DeviceProblem[] {
    // An unplugged or untrusted phone has no problem on top of its own status.
    if (d.state !== DeviceState.CONNECTED) {
        return [];
    }
    const problems: DeviceProblem[] = [];
    if (d.session === 'error') {
        problems.push({ kind: 'session', level: 'error', message: d.sessionMessage || PROBLEM.sessionFailed });
    }
    if (d.developerMode === false) {
        problems.push({ kind: 'developer-mode', level: 'attention', message: PROBLEM.developerMode });
    }
    const unlock = d.unlockSchedule && unlockCardLine(d.unlockSchedule, now);
    if (unlock?.problem) {
        problems.push({ kind: 'unlock', level: 'attention', message: unlock.text });
    }
    return problems;
}

function applFacts(entry: DeviceEntry, now: number): PhoneFacts {
    const d = entry.descriptor as ApplDeviceDescriptor;
    return {
        trusted: d.state !== 'unauthorized',
        connected: d.state === DeviceState.CONNECTED,
        session: APPL_SESSION[d.session ?? 'stopped'] ?? 'unknown',
        problems: applProblems(d, now),
        // `DeviceStateMonitor` reads these over USB; both stay 'unknown' where it is disabled.
        screen: d['screen.power'] === 'off' ? 'asleep' : d['screen.power'] === 'on' ? 'on' : 'unknown',
        lock: lockOf(d['device.locked']),
        viewed: activeCoreDeviceStream.value?.params.udid === d.udid,
    };
}

/** The facts of a listed phone, through the adapter of its platform. */
export function phoneFacts(entry: DeviceEntry, now = Date.now()): PhoneFacts {
    return entry.params.type === 'android' ? googFacts(entry) : applFacts(entry, now);
}

/** The status of a listed phone: its chip on the list and in the switcher. */
export function getDeviceStatusInfo(entry: DeviceEntry): PhoneStatus {
    return derivePhoneStatus(phoneFacts(entry));
}

/**
 * What is wrong with a connected phone, most serious first. Empty for a healthy phone and for
 * one that is offline or untrusted, which its status already says. Only iPhones report these.
 */
export function getDeviceProblems(entry: DeviceEntry, now = Date.now()): DeviceProblem[] {
    return [...phoneFacts(entry, now).problems];
}

/** True for a phone the list header counts as needing attention, whatever its chip says. */
export function needsAttention(entry: DeviceEntry): boolean {
    return getDeviceProblems(entry).length > 0;
}

/** "3 available · 1 needs attention": the header line counts blocked and failed phones too. */
export function listSummary(total: number, available: number, attention: number): string {
    const base = available
        ? LIST_SUMMARY.available(available)
        : total
          ? LIST_SUMMARY.noneAvailable
          : LIST_SUMMARY.waiting;
    return attention ? [base, LIST_SUMMARY.attention(attention)].join(LIST_SUMMARY.separator) : base;
}

/** The value of the Session fact of an iPhone. */
export function sessionFact(session: ApplDeviceDescriptor['session']): string {
    return SESSION.fact[session ?? 'stopped'] ?? FACT.unknown;
}

/** The value of a yes or no fact, such as Paired. */
export function yesNoFact(value: boolean): string {
    return value ? FACT.yes : FACT.no;
}

/** The value of an on or off fact that can be unknown, such as Developer Mode. */
export function onOffFact(value: boolean | 'unknown' | undefined): string {
    return value === 'unknown' || value === undefined ? FACT.unknown : value ? FACT.on : FACT.off;
}

/** The value of the Screen fact. */
export function screenFact(screen: ScreenState): string {
    return SCREEN[screen];
}

/** The value of the Lock fact. */
export function lockFact(lock: LockState): string {
    return LOCK[lock];
}

export type StreamServiceState = 'running' | 'stopped' | 'starting' | 'offline' | 'unauthorized' | 'unknown';
export interface StreamServiceInfo {
    state: StreamServiceState;
    label: string;
    description: string;
}

/**
 * The stream service line of an Android card and header. It says the process on the phone, apart
 * from the browser's connection and from the phone's lock and power.
 */
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
    return { state, ...STREAM_SERVICE[state] };
}

/** The page's connection to the phone. */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'failed' | 'stopped';
/** A cause the screen knows, said in place of the general word of its state. */
export type ScreenConnectionDetail = keyof typeof SCREEN_CONNECTION;

export interface ConnectionStatus {
    state: ConnectionState;
    label: string;
    tone: ChipTone;
    icon: IconName;
}

// Failed is red and a phone that is not there grey. Waiting for a connection is amber.
const CONNECTION_TONE: Record<ConnectionState, ChipTone> = {
    connecting: 'warning',
    connected: 'success',
    reconnecting: 'warning',
    offline: 'neutral',
    failed: 'error',
    stopped: 'neutral',
};

const CONNECTION_ICON: Record<ConnectionState, IconName> = {
    connecting: 'refresh',
    connected: 'checkCircle',
    reconnecting: 'refresh',
    offline: 'phone',
    failed: 'errorCircle',
    stopped: 'square',
};

/** The words, tone and icon of a connection state. */
export function connectionStatus(state: ConnectionState, detail?: ScreenConnectionDetail): ConnectionStatus {
    return {
        state,
        label: detail ? SCREEN_CONNECTION[detail] : CONNECTION[state],
        tone: CONNECTION_TONE[state],
        icon: CONNECTION_ICON[state],
    };
}

export interface ScreenConnectionFacts {
    /** The stream could not be started at all. */
    startError?: boolean;
    /** This browser cannot decode the phone's video. */
    decoderError?: boolean;
    /** An iPhone's session failed or was stopped, and whether a new start is under way. */
    failure?: { state: 'error' | 'stopped'; trying: boolean };
    /** The picture is up. */
    connected: boolean;
    /** The owner stopped the Android stream service. The page does not reconnect by itself. */
    serviceStopped?: boolean;
    /** The phone is in the list and is not connected to the server. */
    phoneOffline?: boolean;
    /** An iPhone's socket is open and its session is starting. */
    sessionStarting?: boolean;
    /** This stream client has been connected. A page that was connected reconnects. */
    hasConnected: boolean;
}

/**
 * The connection of a phone's screen, for its header and the card over the picture. Both read it
 * from here, so a page that was connected says Reconnecting in both places.
 */
export function screenConnection(facts: ScreenConnectionFacts): ConnectionStatus {
    if (facts.startError) {
        return connectionStatus('failed');
    }
    if (facts.decoderError) {
        return connectionStatus('failed', 'noPicture');
    }
    if (facts.failure) {
        // A new start after a failure. The card that says why stays until it succeeds.
        if (facts.failure.trying) {
            return connectionStatus('connecting', 'tryingAgain');
        }
        return facts.failure.state === 'error'
            ? connectionStatus('failed', 'streamUnavailable')
            : connectionStatus('stopped', 'streamStopped');
    }
    if (facts.connected) {
        return connectionStatus('connected');
    }
    if (facts.serviceStopped) {
        return connectionStatus('stopped');
    }
    if (facts.phoneOffline) {
        return connectionStatus('offline');
    }
    if (facts.hasConnected) {
        return connectionStatus('reconnecting');
    }
    return connectionStatus('connecting', facts.sessionStarting ? 'startingStream' : undefined);
}

export interface ToolConnectionFacts {
    /** The tool could not open. */
    failed: boolean;
    connected: boolean;
    /** What `ToolView` reports after a lost connection. */
    lost: '' | 'reconnecting' | 'closed' | 'ended';
    /** The phone is in the list and is not connected to the server. */
    phoneOffline: boolean;
}

/** The connection of Files or Shell, for the chip at the end of the tab row. */
export function toolConnection(facts: ToolConnectionFacts): ConnectionStatus {
    if (facts.failed) {
        return connectionStatus('failed');
    }
    if (facts.connected) {
        return connectionStatus('connected');
    }
    if (facts.lost === 'reconnecting') {
        return connectionStatus('reconnecting');
    }
    // A shell that exited. Nothing starts it again until the owner asks.
    if (facts.lost === 'ended') {
        return connectionStatus('stopped');
    }
    // The automatic attempts are over.
    if (facts.lost === 'closed') {
        return connectionStatus(facts.phoneOffline ? 'offline' : 'failed');
    }
    return connectionStatus('connecting');
}
