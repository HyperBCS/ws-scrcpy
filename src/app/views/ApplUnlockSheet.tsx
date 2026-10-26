import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';
import { forgetPasscode, readSavedPasscode, savePasscode } from '../state/savedPasscode';
import { streamConnected, unlockSheetOpen } from '../state/stream';
import { BottomSheet } from '../ui/BottomSheet';
import '../../style/views/UnlockSheet.css';

export function ApplUnlockSheet({ client }: { client: StreamClientCoreDevice }) {
    const open = unlockSheetOpen.value;
    const connected = streamConnected.value;
    const udid = client.getDeviceUdid();
    const [passcode, setPasscode] = useState('');
    const [saved, setSaved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState('');
    const pending = useRef<object>();

    useLayoutEffect(() => {
        const stored = open ? readSavedPasscode(udid) : undefined;
        setPasscode(stored?.value || '');
        setSaved(!!stored);
        setNote('');
    }, [open, client]);
    useLayoutEffect(() => {
        pending.current = undefined;
        setBusy(false);
        return () => {
            pending.current = undefined;
        };
    }, [client]);

    const submit = async (event: Event) => {
        event.preventDefault();
        if (!connected || pending.current) return;
        const digits = passcode.trim();
        if (!/^\d{4,10}$/.test(digits)) {
            setNote('Enter a passcode with 4 to 10 digits.');
            return;
        }
        const attempt = {};
        pending.current = attempt;
        setBusy(true);
        setSaved(savePasscode(udid, digits, 'pin'));
        setNote('Unlocking…');
        try {
            const sent = await client.unlockWithPasscode(digits);
            if (pending.current === attempt) {
                setNote(sent ? 'Passcode sent.' : 'Could not send the passcode. Try again.');
            }
        } catch {
            if (pending.current === attempt) setNote('Connection lost. Reconnect and try again.');
        } finally {
            if (pending.current === attempt) {
                pending.current = undefined;
                setBusy(false);
            }
        }
    };

    return (
        <BottomSheet open={open} onClose={() => (unlockSheetOpen.value = false)} title="Unlock device">
            <form
                class="unlock-sheet-content"
                onSubmit={submit}
                autoComplete="off"
                onKeyUp={(event) => event.stopPropagation()}
            >
                <label class="unlock-sheet-field">
                    <span>Device passcode</span>
                    <input
                        type="password"
                        inputMode="numeric"
                        enterKeyHint="go"
                        autoComplete="off"
                        maxLength={10}
                        value={passcode}
                        disabled={!connected || busy}
                        onInput={(event) => setPasscode(event.currentTarget.value)}
                        onKeyDown={(event) => event.stopPropagation()}
                    />
                </label>
                <p class="unlock-sheet-hint">
                    {saved ? 'Saved in this browser.' : 'Saved in this browser when you unlock.'}
                    {saved && (
                        <button
                            type="button"
                            class="unlock-forget"
                            disabled={busy}
                            onClick={() => {
                                if (forgetPasscode(udid)) {
                                    setSaved(false);
                                    setPasscode('');
                                }
                            }}
                        >
                            Forget
                        </button>
                    )}
                </p>
                <div class="unlock-sheet-feedback" role="status" aria-live="polite">
                    {!connected ? 'Waiting for the device to reconnect.' : note}
                </div>
                <div class="unlock-sheet-actions">
                    <button type="submit" class="primary" disabled={!connected || !passcode || busy}>
                        {busy ? 'Unlocking…' : 'Unlock'}
                    </button>
                </div>
                <p class="unlock-sheet-hint">After a restart, unlock once on the phone.</p>
            </form>
        </BottomSheet>
    );
}
