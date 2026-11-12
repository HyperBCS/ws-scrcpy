import { effect, signal } from '@preact/signals';
import type { AndroidLockStateReply } from '../../types/AndroidLockState';
import type ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { ControlCenterCommand } from '../../common/ControlCenterCommand';
import { unlockOutcomeText, UnlockRunResult } from '../../common/IosUnlockSchedule';
import type { DeviceTracker } from '../googDevice/client/DeviceTracker';
import type { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import KeyEvent from '../googDevice/android/KeyEvent';
import { keyPress, passcodeMessages, validatePasscode, UnlockRequestError } from '../googDevice/client/passcode';
import { capabilities } from './capabilities';
import { findDeviceByUdid } from './devices';
import { forgetPasscode, readSavedPasscode } from './savedPasscode';
import { activeCoreDeviceStream, activeStream, streamConnected, unlockSheetOpen } from './stream';
import { findDeviceForStream } from './streamDevice';
import { parseRoute } from './routes';
import { runUnlockNow } from './unlockSchedule';

type LockReply = Partial<AndroidLockStateReply> & { udid: string; requestId: number; error?: string };

export function requestLockState(tracker: DeviceTracker, udid: string, signal: AbortSignal): Promise<LockReply> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new UnlockRequestError('Unlock canceled.'));
            return;
        }
        let requestId: number | undefined;
        const cleanup = () => {
            clearTimeout(timeout);
            tracker.off('get_lock_state', onReply);
            signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(new UnlockRequestError('Unlock canceled.'));
        };
        const onReply = (reply: LockReply) => {
            if (reply?.udid !== udid || reply.requestId !== requestId) {
                return;
            }
            cleanup();
            if (reply.error) {
                reject(new UnlockRequestError('Could not check the phone lock. Check the connection and try again.'));
            } else {
                resolve(reply);
            }
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new UnlockRequestError('Checking the phone lock timed out. Reconnect and try again.'));
        }, 8000);
        tracker.on('get_lock_state', onReply);
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            requestId = tracker.sendCommand(ControlCenterCommand.GET_LOCK_STATE, { udid });
        } catch {
            cleanup();
            reject(new UnlockRequestError('Could not reach the phone. Reconnect and try again.'));
        }
    });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new UnlockRequestError('Unlock canceled.'));
            return;
        }
        const onAbort = () => {
            clearTimeout(timeout);
            reject(new UnlockRequestError('Unlock canceled.'));
        };
        const timeout = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function requireLockScreen(state: LockReply): void {
    if (state['device.locked'] === false) {
        throw new UnlockRequestError('This phone is already unlocked.');
    }
    if (state['keyguard.occluded'] === true) {
        throw new UnlockRequestError(
            'Another screen is covering the lock screen. Return to the phone lock screen and try again.',
        );
    }
    if (state['device.locked'] !== true || state['keyguard.showing'] !== true || state['keyguard.occluded'] !== false) {
        throw new UnlockRequestError('The phone lock screen could not be confirmed. Unlock it on the phone.');
    }
}

/**
 * Uses the existing control connection; on this Android path credentials never enter tracker
 * commands or storage. The iOS scheduled unlock (`state/unlockSchedule.ts`) is the one deliberate
 * exception: one `SET_UNLOCK_PASSCODE` command, one direction, encrypted at rest on the server.
 *
 * `wanted` says whether the owner still wants this attempt: by default while the Unlock sheet is
 * open. The lock notice's one-tap attempt has no sheet and is ended by its `signal` instead.
 */
export async function submitDevicePasscode(
    client: StreamClientScrcpy,
    udid: string,
    passcode: string,
    signal: AbortSignal,
    wanted: () => boolean = () => unlockSheetOpen.peek(),
): Promise<boolean> {
    validatePasscode(passcode);
    const initialSession = activeStream.peek();
    const entry = initialSession ? findDeviceForStream(initialSession.params) : undefined;
    const clientId = client.getClientId();
    // The page this was sent from: this phone's screen, under either form of its address. A
    // player or socket the address names must be the one this stream runs on.
    const address = location.hash;
    const query = new URLSearchParams(address.replace(/^#!/, ''));
    const page = parseRoute(query);
    const named = (key: 'ws' | 'player') => !query.has(key) || query.get(key) === initialSession?.params[key];
    const onScreen =
        page.page === 'device' && page.view === 'screen' && page.udid === udid && named('ws') && named('player');
    const stillCurrent = () => {
        const session = activeStream.peek();
        // Hash navigation changes synchronously; Preact tears the old client down later.
        // Compare the actual URL too, so a late lock reply cannot win that interval. Any change
        // of address counts: another phone, another view, another player or socket.
        if (
            signal.aborted ||
            !wanted() ||
            session?.client !== client ||
            session.params.udid !== udid ||
            !onScreen ||
            location.hash !== address ||
            !client.isControlReady() ||
            client.getClientId() !== clientId ||
            findDeviceForStream(session.params)?.tracker !== entry?.tracker
        ) {
            throw new UnlockRequestError('Unlock canceled because the phone connection changed.');
        }
    };
    stillCurrent();
    if (entry?.params.type !== 'android') {
        throw new UnlockRequestError(
            'This stream could not be matched to a phone. Open it from the list of phones and try again.',
        );
    }
    const tracker = entry.tracker as DeviceTracker;
    const initial = await requestLockState(tracker, udid, signal);
    stillCurrent();
    requireLockScreen(initial);
    if (!client.sendImmediateMessages(keyPress(KeyEvent.KEYCODE_WAKEUP))) {
        throw new UnlockRequestError('The phone disconnected. Reconnect and try again.');
    }
    await pause(300, signal);
    stillCurrent();
    if (!client.sendImmediateMessages(keyPress(KeyEvent.KEYCODE_MENU))) {
        throw new UnlockRequestError('The phone disconnected. Reconnect and try again.');
    }
    await pause(500, signal);
    // Waking may have unlocked via biometrics, or another viewer may have navigated away.
    // A fresh, correlated reply is required immediately before any credential bytes leave.
    const current = await requestLockState(tracker, udid, signal);
    stillCurrent();
    requireLockScreen(current);
    if (current['screen.power'] !== 'on') {
        throw new UnlockRequestError('The lock screen is not awake yet. Wake the phone and try again.');
    }
    return client.sendImmediateMessages(passcodeMessages(passcode));
}

// The one unlock of both kinds of phone, used by the Unlock sheet and by the lock notice. An
// attempt sends once, then waits for the phone list to report the phone unlocked. It is never
// sent again on its own: a failure ends the attempt, and the next one is the owner's.

/** How long the phone list has, after a send, to report the phone unlocked. */
export const UNLOCK_CONFIRM_TIMEOUT_MS = 25000;

/** The phone did not report itself unlocked in time. The passcode may or may not be wrong. */
export class UnlockNotConfirmed extends UnlockRequestError {}

export const UNLOCK_TEXT = {
    notSent:
        'The passcode was not sent. Make sure the phone is connected and its PIN or password screen is visible, then try again.',
    notConfirmed:
        'Unlock was not confirmed. Check the remote screen before trying again. Nothing will be resent automatically.',
    savedRemoved: 'The passcode saved in this browser was removed.',
    connectionLost: 'Connection lost. The passcode may already have been sent. Check the phone before trying again.',
    failed: 'Could not complete the unlock request. Check the phone before trying again.',
    confirmed: 'Phone confirmed unlocked.',
} as const;

/** What the one Unlock sheet and the lock notice need from a kind of phone. */
export interface UnlockAdapter {
    /** Android types the PIN or password into a field; an iPhone uses the passcode stored on the server. */
    field: boolean;
    /**
     * Sends the passcode once. Resolves when it was sent (Android) or when the server reports it
     * entered (iPhone). Rejects with an `UnlockRequestError` whose message can be shown.
     */
    submit(passcode: string, signal: AbortSignal): Promise<void>;
    /** The phone list reports the phone unlocked. Reads signals, so it can be watched. */
    isUnlocked(): boolean;
    /** The connection the passcode went over has gone while the unlock is awaited. */
    isLost(): boolean;
    /** Said while `submit` runs, and after it while the phone list is awaited. */
    sending: string;
    sent: string;
}

/** The descriptor of the Android phone this page streams, bound to its socket as the screen does. */
function androidDescriptor(udid: string): GoogDeviceDescriptor | undefined {
    const session = activeStream.value;
    const entry = session?.params.udid === udid ? findDeviceForStream(session.params) : undefined;
    return entry?.params.type === 'android' ? (entry.descriptor as GoogDeviceDescriptor) : undefined;
}

function iphoneDescriptor(udid: string): ApplDeviceDescriptor | undefined {
    const entry = findDeviceByUdid(udid);
    return entry?.params.type === 'ios' ? (entry.descriptor as ApplDeviceDescriptor) : undefined;
}

/** Android: unlocked once the phone reports no lock and no lock screen, over a live stream. */
export function androidUnlock(
    udid: string,
    send: (passcode: string, signal: AbortSignal) => boolean | Promise<boolean>,
): UnlockAdapter {
    return {
        field: capabilities('android').unlock === 'passcode-field',
        submit: async (passcode, signal) => {
            if (!(await send(passcode, signal))) {
                throw new UnlockRequestError(UNLOCK_TEXT.notSent);
            }
        },
        isUnlocked: () => {
            const descriptor = androidDescriptor(udid);
            return (
                streamConnected.value &&
                descriptor?.['device.locked'] === false &&
                descriptor['keyguard.showing'] === false
            );
        },
        isLost: () => !streamConnected.value,
        sending: 'Checking the phone lock before sending…',
        sent: 'Passcode sent once. Waiting for the phone to confirm it is unlocked…',
    };
}

/** "Failed: the stored passcode was rejected. Scheduled unlock is paused until …." */
export function unlockResultText(result: UnlockRunResult): string {
    // Some messages end their own sentence, such as "Enter the passcode on the phone."
    const message = result.message?.replace(/\.$/, '');
    return `${unlockOutcomeText(result.outcome)}${message ? `. ${message}` : ''}.`;
}

/**
 * iPhone: the server types the passcode stored for the scheduled unlock (`RUN_UNLOCK_NOW` with
 * `keepUnlocked`), the same request as Run now, with its cooldown and start budget. Nothing is
 * typed or kept in the browser. Unlocked once the phone list reports `device.locked: false`.
 */
export function iphoneUnlock(udid: string): UnlockAdapter {
    return {
        field: capabilities('ios').unlock === 'passcode-field',
        submit: async () => {
            const tracker = findDeviceByUdid(udid)?.tracker;
            if (!tracker) {
                throw new UnlockRequestError('This phone is not in the list of phones. Reconnect and try again.');
            }
            let result: UnlockRunResult;
            try {
                result = await runUnlockNow(tracker, udid, { keepUnlocked: true });
            } catch (error) {
                // The server's refusal ("Try again in 90 s.") or the tracker's own plain words.
                throw new UnlockRequestError(error instanceof Error ? error.message : UNLOCK_TEXT.failed);
            }
            if (result.outcome !== 'unlocked' && result.outcome !== 'already-unlocked') {
                throw new UnlockRequestError(unlockResultText(result));
            }
        },
        isUnlocked: () => iphoneDescriptor(udid)?.['device.locked'] === false,
        // The server's run goes on without the stream.
        isLost: () => false,
        sending: 'Unlocking with the passcode stored on the server…',
        sent: 'Passcode entered. Waiting for the phone to confirm it is unlocked…',
    };
}

/** Resolves when the phone list reports the phone unlocked; rejects when that does not come in time. */
function untilUnlocked(adapter: UnlockAdapter, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        let done = false;
        // The watch below; it can settle the promise while it is being set up.
        const watch: { stop?: () => void } = {};
        const finish = (error?: Error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            watch.stop?.();
            if (error) reject(error);
            else resolve();
        };
        const onAbort = () => finish(new UnlockRequestError('Unlock canceled.'));
        const timer = setTimeout(
            () => finish(new UnlockNotConfirmed(UNLOCK_TEXT.notConfirmed)),
            UNLOCK_CONFIRM_TIMEOUT_MS,
        );
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }
        watch.stop = effect(() => {
            if (done) return;
            if (adapter.isUnlocked()) finish();
            else if (adapter.isLost()) finish(new UnlockRequestError(UNLOCK_TEXT.connectionLost));
        });
        if (done) watch.stop();
    });
}

/**
 * One attempt: send once, then wait for the phone to report itself unlocked. `onSent` runs
 * between the two. Rejects with `UnlockNotConfirmed` when the report does not come in time.
 */
export async function unlockOnce(
    adapter: UnlockAdapter,
    passcode: string,
    signal: AbortSignal,
    onSent?: () => void,
): Promise<void> {
    await adapter.submit(passcode, signal);
    if (signal.aborted) {
        throw new UnlockRequestError('Unlock canceled.');
    }
    onSent?.();
    await untilUnlocked(adapter, signal);
}

/** Words for a failed attempt. Transport errors may contain arguments: they are never shown. */
export function unlockErrorText(error: unknown): string {
    return error instanceof UnlockRequestError ? error.message : UNLOCK_TEXT.failed;
}

/** The phone whose saved passcode the lock notice is sending. Its notice says Unlocking…. */
export const unlockingFromNotice = signal<string | undefined>(undefined);

/** Why the lock notice's attempt failed, for the Unlock sheet to show when it opens. */
export const noticeUnlockFailure = signal<{ udid: string; message: string } | undefined>(undefined);

/**
 * The lock notice's Unlock in one tap, when a passcode is saved for the phone: on Android one
 * kept in this browser behind "Remember in this browser", on an iPhone one stored on the server
 * that is usable. Returns undefined when there is none, or when the phone is in a state the
 * sheet explains (another screen over the lock screen, a rejected passcode, the lockout): the
 * notice then opens the sheet.
 *
 * The attempt resolves 'failed' with the reason in `noticeUnlockFailure`; the notice then opens
 * the sheet. Nothing is saved by it. A saved Android passcode that sent without a confirmed
 * unlock is removed, as the sheet does, so it is not sent again from a tap.
 */
export function oneTapUnlock(
    udid: string,
): ((signal: AbortSignal) => Promise<'unlocked' | 'failed' | 'canceled'>) | undefined {
    let adapter: UnlockAdapter | undefined;
    let passcode = '';
    let browserCopy = false;
    const android = activeStream.peek();
    const iphone = activeCoreDeviceStream.peek();
    if (android?.params.udid === udid) {
        const client = android.client;
        const saved = readSavedPasscode(udid);
        if (!saved || androidDescriptor(udid)?.['keyguard.occluded'] === true) {
            return undefined;
        }
        passcode = saved.value;
        browserCopy = true;
        adapter = androidUnlock(udid, (value, signal) => submitDevicePasscode(client, udid, value, signal, () => true));
    } else if (iphone?.params.udid === udid) {
        const schedule = iphoneDescriptor(udid)?.unlockSchedule;
        if (!schedule?.hasPasscode || schedule.passcodeRejected || schedule.needsManualUnlock) {
            return undefined;
        }
        adapter = iphoneUnlock(udid);
    }
    if (!adapter || unlockingFromNotice.peek() === udid) {
        return undefined;
    }
    const chosen = adapter;
    return async (signal) => {
        unlockingFromNotice.value = udid;
        noticeUnlockFailure.value = undefined;
        try {
            await unlockOnce(chosen, passcode, signal);
            return 'unlocked';
        } catch (error) {
            if (signal.aborted) {
                return 'canceled';
            }
            let message = unlockErrorText(error);
            if (error instanceof UnlockNotConfirmed && browserCopy && forgetPasscode(udid)) {
                message = `${message} ${UNLOCK_TEXT.savedRemoved}`;
            }
            noticeUnlockFailure.value = { udid, message };
            return 'failed';
        } finally {
            passcode = '';
            if (unlockingFromNotice.peek() === udid) {
                unlockingFromNotice.value = undefined;
            }
        }
    };
}
