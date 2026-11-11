import type { AndroidLockStateReply } from '../../types/AndroidLockState';
import { ControlCenterCommand } from '../../common/ControlCenterCommand';
import type { DeviceTracker } from '../googDevice/client/DeviceTracker';
import type { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import KeyEvent from '../googDevice/android/KeyEvent';
import { keyPress, passcodeMessages, validatePasscode, UnlockRequestError } from '../googDevice/client/passcode';
import { activeStream, unlockSheetOpen } from './stream';
import { findDeviceForStream } from './streamDevice';
import { parseRoute } from './routes';

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
                reject(new UnlockRequestError('Could not check the device lock. Check the connection and try again.'));
            } else {
                resolve(reply);
            }
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new UnlockRequestError('Checking the device lock timed out. Reconnect and try again.'));
        }, 8000);
        tracker.on('get_lock_state', onReply);
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            requestId = tracker.sendCommand(ControlCenterCommand.GET_LOCK_STATE, { udid });
        } catch {
            cleanup();
            reject(new UnlockRequestError('Could not reach the device. Reconnect and try again.'));
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
        throw new UnlockRequestError('This device is already unlocked. Close this panel to continue.');
    }
    if (state['keyguard.occluded'] === true) {
        throw new UnlockRequestError(
            'Another screen is covering the lock screen. Return to the device lock screen and try again.',
        );
    }
    if (state['device.locked'] !== true || state['keyguard.showing'] !== true || state['keyguard.occluded'] !== false) {
        throw new UnlockRequestError('The device lock screen could not be confirmed. Unlock it on the device.');
    }
}

/**
 * Uses the existing control connection; on this Android path credentials never enter tracker
 * commands or storage. The iOS scheduled unlock (`state/unlockSchedule.ts`) is the one deliberate
 * exception: one `SET_UNLOCK_PASSCODE` command, one direction, encrypted at rest on the server.
 */
export async function submitDevicePasscode(
    client: StreamClientScrcpy,
    udid: string,
    passcode: string,
    signal: AbortSignal,
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
            !unlockSheetOpen.peek() ||
            session?.client !== client ||
            session.params.udid !== udid ||
            !onScreen ||
            location.hash !== address ||
            !client.isControlReady() ||
            client.getClientId() !== clientId ||
            findDeviceForStream(session.params)?.tracker !== entry?.tracker
        ) {
            throw new UnlockRequestError('Unlock canceled because the device connection changed.');
        }
    };
    stillCurrent();
    if (entry?.params.type !== 'android') {
        throw new UnlockRequestError(
            'This stream could not be matched to a device. Open it from the device list and try again.',
        );
    }
    const tracker = entry.tracker as DeviceTracker;
    const initial = await requestLockState(tracker, udid, signal);
    stillCurrent();
    requireLockScreen(initial);
    if (!client.sendImmediateMessages(keyPress(KeyEvent.KEYCODE_WAKEUP))) {
        throw new UnlockRequestError('The device disconnected. Reconnect and try again.');
    }
    await pause(300, signal);
    stillCurrent();
    if (!client.sendImmediateMessages(keyPress(KeyEvent.KEYCODE_MENU))) {
        throw new UnlockRequestError('The device disconnected. Reconnect and try again.');
    }
    await pause(500, signal);
    // Waking may have unlocked via biometrics, or another viewer may have navigated away.
    // A fresh, correlated reply is required immediately before any credential bytes leave.
    const current = await requestLockState(tracker, udid, signal);
    stillCurrent();
    requireLockScreen(current);
    if (current['screen.power'] !== 'on') {
        throw new UnlockRequestError('The lock screen is not awake yet. Wake the device and try again.');
    }
    return client.sendImmediateMessages(passcodeMessages(passcode));
}
