import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { BottomSheet } from '../ui/BottomSheet';
import { UnlockRequestError } from '../googDevice/client/passcode';
import type { DeviceLockValue } from './LockScreenNotice';
import '../../style/views/UnlockSheet.css';

interface UnlockSheetProps {
    open: boolean;
    udid: string;
    sessionKey?: object;
    connected: boolean;
    locked: DeviceLockValue;
    keyguardShowing: DeviceLockValue;
    keyguardOccluded?: DeviceLockValue;
    onClose: () => void;
    // A true result only means sent. The descriptor must confirm the device is unlocked.
    onSubmit: (passcode: string, signal: AbortSignal) => boolean | Promise<boolean>;
}

type Phase = 'idle' | 'sending' | 'waiting' | 'confirmed' | 'unconfirmed' | 'error';
const CONFIRM_TIMEOUT_MS = 25000;

export function UnlockSheet({
    open,
    udid,
    sessionKey,
    connected,
    locked,
    keyguardShowing,
    keyguardOccluded,
    onClose,
    onSubmit,
}: UnlockSheetProps) {
    const input = useRef<HTMLInputElement>(null);
    const controller = useRef<AbortController>();
    const timeout = useRef<ReturnType<typeof setTimeout>>();
    const composing = useRef(false);
    const [mode, setMode] = useState<'pin' | 'password'>('pin');
    // Keep only whether the uncontrolled field has text; no passcode is put in application state.
    const [hasDraft, setHasDraft] = useState(false);
    const [phase, setPhase] = useState<Phase>('idle');
    const [feedback, setFeedback] = useState('');
    const confirmed = connected && locked === false && keyguardShowing === false;
    const pending = phase === 'sending' || phase === 'waiting';

    const clearDraft = () => {
        if (input.current) input.current.value = '';
        setHasDraft(false);
    };
    const cancelPending = () => {
        controller.current?.abort();
        controller.current = undefined;
        if (timeout.current !== undefined) clearTimeout(timeout.current);
        timeout.current = undefined;
    };
    const close = () => {
        clearDraft();
        cancelPending();
        onClose();
    };

    useLayoutEffect(() => {
        clearDraft();
        cancelPending();
        composing.current = false;
        setMode('pin');
        setPhase('idle');
        setFeedback('');
        return () => {
            if (input.current) input.current.value = '';
            cancelPending();
        };
    }, [open, udid, sessionKey]);

    useLayoutEffect(() => {
        if (!open) return;
        if (!connected) {
            clearDraft();
            if (controller.current) {
                cancelPending();
                setPhase('error');
                setFeedback(
                    'Connection lost. The passcode may already have been sent. Check the device before trying again.',
                );
            }
        } else if (confirmed && controller.current) {
            cancelPending();
            clearDraft();
            setPhase('confirmed');
            setFeedback('Device confirmed unlocked.');
        } else if (!confirmed && phase === 'confirmed') {
            clearDraft();
            setPhase('idle');
            setFeedback('The device lock state changed. Check the device before sending another passcode.');
        }
    }, [open, connected, confirmed, phase]);

    useLayoutEffect(() => {
        if (!open) return;
        let frame: number | undefined;
        const keepFieldVisible = () => {
            if (frame !== undefined) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                if (input.current === document.activeElement) {
                    input.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
                }
            });
        };
        // The phone keyboard shrinks the sheet after focus, independently of the layout
        // viewport. Center the active field in the remaining scroll area above the actions.
        window.visualViewport?.addEventListener('resize', keepFieldVisible);
        return () => {
            window.visualViewport?.removeEventListener('resize', keepFieldVisible);
            if (frame !== undefined) cancelAnimationFrame(frame);
        };
    }, [open]);

    const submit = async (event: Event) => {
        event.preventDefault();
        if (!connected || confirmed || controller.current || composing.current) return;
        let passcode = input.current?.value || '';
        if (!passcode) return;
        clearDraft();
        if (passcode.length > 128 || (mode === 'pin' ? !/^\d+$/.test(passcode) : !/^[\x20-\x7e]+$/.test(passcode))) {
            setPhase('error');
            setFeedback(
                mode === 'pin'
                    ? 'A PIN uses digits only. Choose Password for letters or symbols.'
                    : 'Use up to 128 standard English letters, numbers, spaces or symbols. Other characters must be entered on the device.',
            );
            return;
        }
        const attempt = new AbortController();
        controller.current = attempt;
        setPhase('sending');
        setFeedback('Checking the device lock before sending…');
        timeout.current = setTimeout(() => {
            if (controller.current !== attempt) return;
            cancelPending();
            setPhase('unconfirmed');
            setFeedback(
                'Unlock was not confirmed. Check the remote screen before trying again. Nothing will be resent automatically.',
            );
        }, CONFIRM_TIMEOUT_MS);
        try {
            const result = onSubmit(passcode, attempt.signal);
            passcode = '';
            const sent = await result;
            if (attempt.signal.aborted || controller.current !== attempt) return;
            if (!sent) {
                cancelPending();
                setPhase('error');
                setFeedback(
                    'The passcode was not sent. Make sure the device is connected and its PIN or password screen is visible, then try again.',
                );
            } else {
                setPhase('waiting');
                setFeedback('Passcode sent once. Waiting for the device to confirm it is unlocked…');
            }
        } catch (error) {
            if (attempt.signal.aborted || controller.current !== attempt) return;
            cancelPending();
            setPhase('error');
            // Transport errors may contain arguments. Never echo them into the UI or console.
            setFeedback(
                error instanceof UnlockRequestError
                    ? error.message
                    : 'Could not complete the unlock request. Check the device before trying again.',
            );
        }
    };

    const stateMessage = !connected
        ? 'Waiting for the device to reconnect. No passcode will be queued.'
        : confirmed
          ? phase === 'confirmed'
              ? feedback
              : 'This device reports that it is unlocked.'
          : feedback;

    return (
        <BottomSheet open={open} onClose={close} title="Unlock device">
            <form
                class="unlock-sheet-content"
                onSubmit={submit}
                autoComplete="off"
                onKeyUp={(event) => event.stopPropagation()}
            >
                <p class="unlock-sheet-intro">
                    Enter the device’s PIN or password. We’ll open its lock-screen keypad before sending.
                </p>
                {keyguardOccluded === true && (
                    <p class="unlock-sheet-feedback warning" role="status">
                        Another screen is covering the device lock. Return to the lock screen before sending a passcode.
                    </p>
                )}
                {locked === false && keyguardShowing === true && (
                    <p class="unlock-sheet-feedback" role="status">
                        The device does not report a passcode lock. You may only need to swipe its lock screen.
                    </p>
                )}
                <fieldset class="unlock-sheet-modes" disabled={pending || confirmed}>
                    <legend>Unlock with</legend>
                    {(['pin', 'password'] as const).map((value) => (
                        <label key={value}>
                            <input
                                type="radio"
                                name="unlock-mode"
                                checked={mode === value}
                                onChange={() => {
                                    clearDraft();
                                    setMode(value);
                                    setFeedback('');
                                    setPhase('idle');
                                }}
                            />
                            <span>{value === 'pin' ? 'PIN' : 'Password'}</span>
                        </label>
                    ))}
                </fieldset>
                <label class="unlock-sheet-field">
                    <span>{mode === 'pin' ? 'Device PIN' : 'Device password'}</span>
                    <input
                        ref={input}
                        type="password"
                        inputMode={mode === 'pin' ? 'numeric' : 'text'}
                        enterKeyHint="go"
                        maxLength={128}
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellcheck={false}
                        aria-describedby="unlock-input-hint unlock-feedback"
                        disabled={!connected || pending || confirmed}
                        onInput={(event) => setHasDraft(event.currentTarget.value.length > 0)}
                        onKeyDown={(event) => event.stopPropagation()}
                        onCompositionStart={() => (composing.current = true)}
                        onCompositionEnd={() => (composing.current = false)}
                    />
                </label>
                <p id="unlock-input-hint" class="unlock-sheet-hint">
                    Masked here and cleared after sending. Nothing is sent while you type.
                </p>
                <div
                    id="unlock-feedback"
                    class={`unlock-sheet-feedback ${phase === 'error' || phase === 'unconfirmed' ? 'warning' : ''}`}
                    role="status"
                    aria-live="polite"
                    data-unlock-state={confirmed ? 'confirmed' : !connected ? 'disconnected' : phase}
                >
                    {stateMessage}
                </div>
                <div class="unlock-sheet-actions">
                    <button type="button" onClick={close}>
                        {confirmed ? 'Back to screen' : 'Use remote screen'}
                    </button>
                    {!confirmed && (
                        <button
                            type="submit"
                            class="primary"
                            disabled={!connected || pending || !hasDraft || keyguardOccluded === true}
                        >
                            {pending ? 'Waiting for device…' : `Send ${mode === 'pin' ? 'PIN' : 'password'}`}
                        </button>
                    )}
                </div>
                <p class="unlock-sheet-hint">
                    For a pattern lock, close this panel and draw on the remote screen if it is visible. Otherwise,
                    unlock on the device.
                </p>
            </form>
        </BottomSheet>
    );
}
