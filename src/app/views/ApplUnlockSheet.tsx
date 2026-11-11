import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';
import { deviceName, findDeviceByUdid } from '../state/devices';
import { openApplSettingsSheet } from '../state/settingsSheet';
import { streamConnected, unlockSheetOpen } from '../state/stream';
import { runUnlockNow } from '../state/unlockSchedule';
import { unlockOutcomeText, UnlockRunResult } from '../../common/IosUnlockSchedule';
import ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import { BottomSheet } from '../ui/BottomSheet';
import '../../style/views/UnlockSheet.css';

type Phase = 'idle' | 'running' | 'confirmed' | 'failed';

/**
 * Unlock for the iPhone stream page. Nothing is typed or kept in the browser: the server types
 * the passcode stored for the scheduled unlock (`RUN_UNLOCK_NOW` with `keepUnlocked`), through
 * the same driver, which reads the lock before typing and confirms the unlock afterwards. A
 * phone without a stored passcode is unlocked on the remote screen, or after storing one in
 * Settings.
 */
export function ApplUnlockSheet({ client }: { client: StreamClientCoreDevice }) {
    const open = unlockSheetOpen.value;
    const connected = streamConnected.value;
    const udid = client.getDeviceUdid();
    const entry = findDeviceByUdid(udid);
    const descriptor = entry?.params.type === 'ios' ? (entry.descriptor as ApplDeviceDescriptor) : undefined;
    const tracker = entry?.tracker;
    const schedule = descriptor?.unlockSchedule;
    const locked = descriptor?.['device.locked'] ?? 'unknown';
    const [phase, setPhase] = useState<Phase>('idle');
    const [note, setNote] = useState('');
    const pending = useRef<object>();

    useLayoutEffect(() => {
        // A reply for another phone, or one that lands after the sheet was reopened, is dropped.
        pending.current = undefined;
        setPhase('idle');
        setNote('');
        return () => {
            pending.current = undefined;
        };
    }, [open, client]);

    const unlock = () => {
        if (!tracker || !connected || pending.current) return;
        const attempt = {};
        pending.current = attempt;
        setPhase('running');
        setNote('Unlocking with the passcode stored on the server…');
        const settle = (next: Phase, text: string) => {
            if (pending.current !== attempt) return;
            pending.current = undefined;
            setPhase(next);
            setNote(text);
        };
        runUnlockNow(tracker, udid, { keepUnlocked: true }).then(
            (result: UnlockRunResult) => {
                // Some messages end their own sentence, such as "Enter the passcode on the phone."
                const message = result.message?.replace(/\.$/, '');
                const text = `${unlockOutcomeText(result.outcome)}${message ? `. ${message}` : ''}.`;
                const unlocked = result.outcome === 'unlocked' || result.outcome === 'already-unlocked';
                // Nothing is sent again on a failure; the next attempt is the owner's decision.
                settle(unlocked ? 'confirmed' : 'failed', text);
            },
            (error: Error) => settle('failed', error.message),
        );
    };

    const openSettings = () => {
        unlockSheetOpen.value = false;
        openApplSettingsSheet(udid, entry?.key);
    };

    const running = phase === 'running';
    const unusable = !schedule?.hasPasscode
        ? 'No passcode is stored on the server for this phone. Store one in Settings, or enter it on the remote screen.'
        : schedule.passcodeRejected
          ? 'The stored passcode was rejected by the phone. Save it again in Settings before it is used again.'
          : '';
    const stateMessage = !connected
        ? 'Waiting for the phone to reconnect.'
        : note || (locked === false ? 'This phone reports that it is unlocked.' : unusable);

    return (
        <BottomSheet
            open={open}
            onClose={() => (unlockSheetOpen.value = false)}
            title="Unlock device"
            subtitle={entry ? deviceName(entry) : undefined}
        >
            <div class="unlock-sheet-content">
                <p class="unlock-sheet-intro">
                    The server types the passcode stored for this phone. It is never sent to or kept in this browser.
                </p>
                <div
                    class={`unlock-sheet-feedback ${phase === 'failed' || (!note && unusable) ? 'warning' : ''}`}
                    role="status"
                    aria-live="polite"
                    data-unlock-state={!connected ? 'disconnected' : phase}
                >
                    {stateMessage}
                </div>
                <div class="unlock-sheet-actions">
                    {unusable ? (
                        <button type="button" class="primary" onClick={openSettings}>
                            Open Settings
                        </button>
                    ) : (
                        <button
                            type="button"
                            class="primary"
                            disabled={!connected || !tracker || running || locked === false}
                            onClick={unlock}
                        >
                            {running ? 'Unlocking…' : 'Unlock with stored passcode'}
                        </button>
                    )}
                </div>
                <p class="unlock-sheet-hint">After a restart, unlock once on the phone.</p>
            </div>
        </BottomSheet>
    );
}
