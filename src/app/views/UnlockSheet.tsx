import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { InlineStatus } from '../ui/InlineStatus';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Sheet } from '../ui/Sheet';
import { UnlockRequestError } from '../googDevice/client/passcode';
import { readSavedPasscode, savePasscode, forgetPasscode, PasscodeMode } from '../state/savedPasscode';
import type { DeviceLockValue } from './LockScreenNotice';
import '../../style/views/UnlockSheet.css';

interface UnlockSheetProps {
    open: boolean;
    udid: string;
    /** Shown under the sheet title, as on every device sheet. */
    deviceName?: string;
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
    deviceName,
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
    // The passcode of the attempt in flight, kept only when it is to be remembered: it is
    // written to storage once the device confirms the unlock and dropped in every other case.
    const toRemember = useRef<{ value: string; mode: PasscodeMode }>();
    const [mode, setMode] = useState<PasscodeMode>('pin');
    const [hasDraft, setHasDraft] = useState(false);
    const [saved, setSaved] = useState(false);
    const [remember, setRemember] = useState(false);
    const [phase, setPhase] = useState<Phase>('idle');
    const [feedback, setFeedback] = useState('');
    const formId = useId();
    const fieldId = useId();
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
        toRemember.current = undefined;
    };
    // A saved passcode that did not unlock the device may be out of date; sending it again
    // from a prefilled field would be another failed attempt.
    const dropSaved = () => {
        if (forgetPasscode(udid)) setSaved(false);
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
        const stored = open ? readSavedPasscode(udid) : undefined;
        setSaved(!!stored);
        setRemember(!!stored);
        setMode(stored?.mode || 'pin');
        if (stored && input.current) {
            input.current.value = stored.value;
            setHasDraft(true);
        }
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
                    'Connection lost. The passcode may already have been sent. Check the phone before trying again.',
                );
            }
        } else if (confirmed && controller.current) {
            const confirmedPasscode = toRemember.current;
            cancelPending();
            clearDraft();
            // The only place a passcode is written to storage: after the device confirmed it.
            if (confirmedPasscode) setSaved(savePasscode(udid, confirmedPasscode.value, confirmedPasscode.mode));
            setPhase('confirmed');
            setFeedback('Phone confirmed unlocked.');
        } else if (!confirmed && phase === 'confirmed') {
            clearDraft();
            setPhase('idle');
            setFeedback('The phone lock state changed. Check the phone before sending another passcode.');
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
                    : 'Use up to 128 standard English letters, numbers, spaces or symbols. Other characters must be entered on the phone.',
            );
            return;
        }
        const attempt = new AbortController();
        controller.current = attempt;
        toRemember.current = remember ? { value: passcode, mode } : undefined;
        setPhase('sending');
        setFeedback('Checking the phone lock before sending…');
        timeout.current = setTimeout(() => {
            if (controller.current !== attempt) return;
            cancelPending();
            dropSaved();
            setPhase('unconfirmed');
            setFeedback(
                `Unlock was not confirmed. Check the remote screen before trying again. Nothing will be resent automatically.${
                    saved ? ' The passcode saved in this browser was removed.' : ''
                }`,
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
                    'The passcode was not sent. Make sure the phone is connected and its PIN or password screen is visible, then try again.',
                );
            } else {
                setPhase('waiting');
                setFeedback('Passcode sent once. Waiting for the phone to confirm it is unlocked…');
            }
        } catch (error) {
            if (attempt.signal.aborted || controller.current !== attempt) return;
            cancelPending();
            setPhase('error');
            // Transport errors may contain arguments. Never echo them into the UI or console.
            setFeedback(
                error instanceof UnlockRequestError
                    ? error.message
                    : 'Could not complete the unlock request. Check the phone before trying again.',
            );
        }
    };

    const stateMessage = !connected
        ? 'Waiting for the phone to reconnect. No passcode will be queued.'
        : confirmed
          ? phase === 'confirmed'
              ? feedback
              : 'This phone reports that it is unlocked.'
          : feedback;

    const failed = phase === 'error' || phase === 'unconfirmed';

    return (
        <Sheet
            open={open}
            onClose={close}
            title="Unlock device"
            subtitle={deviceName}
            footer={
                <div class="unlock-actions">
                    <Button onClick={close}>{confirmed ? 'Back to screen' : 'Use remote screen'}</Button>
                    {!confirmed && (
                        <Button
                            type="submit"
                            variant="primary"
                            // The form is in the body of the sheet; the button belongs to it by name.
                            attributes={{ form: formId }}
                            disabled={!connected || pending || !hasDraft || keyguardOccluded === true}
                        >
                            {pending ? 'Waiting for the phone…' : `Send ${mode === 'pin' ? 'PIN' : 'password'}`}
                        </Button>
                    )}
                </div>
            }
        >
            <form
                id={formId}
                class="unlock-form"
                onSubmit={submit}
                autoComplete="off"
                onKeyUp={(event) => event.stopPropagation()}
            >
                <p class="unlock-intro">Enter the phone’s PIN or password.</p>
                {keyguardOccluded === true && (
                    <Banner>
                        Another screen is covering the phone lock. Return to the lock screen before sending a passcode.
                    </Banner>
                )}
                {locked === false && keyguardShowing === true && (
                    <Banner tone="info">
                        The phone does not report a passcode lock. You may only need to swipe its lock screen.
                    </Banner>
                )}
                <div class="kit-field-group">
                    <span class="kit-field-label">Unlock with</span>
                    <SegmentedControl
                        label="Unlock with"
                        full
                        value={mode}
                        options={[
                            { value: 'pin', label: 'PIN' },
                            { value: 'password', label: 'Password' },
                        ]}
                        disabled={pending || confirmed}
                        onChange={(value) => {
                            clearDraft();
                            setMode(value);
                            setFeedback('');
                            setPhase('idle');
                        }}
                    />
                </div>
                {/* Written with the kit's classes: the field keeps its value out of the component
                    state and is read and cleared through its ref. */}
                <div class="kit-field-group">
                    <label class="kit-field-label" for={fieldId}>
                        {mode === 'pin' ? 'Phone PIN' : 'Phone password'}
                    </label>
                    <input
                        ref={input}
                        id={fieldId}
                        class="kit-field unlock-field"
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
                </div>
                <div class="unlock-remember">
                    <Checkbox
                        checked={remember}
                        disabled={pending}
                        describedBy="unlock-input-hint"
                        onChange={(checked) => {
                            setRemember(checked);
                            if (!checked && saved && forgetPasscode(udid)) {
                                setSaved(false);
                                clearDraft();
                            }
                        }}
                    >
                        Remember in this browser
                    </Checkbox>
                    <p id="unlock-input-hint" class="unlock-hint">
                        {saved
                            ? 'Saved in this browser as plain text. Clear the box to forget it.'
                            : remember
                              ? 'Saved as plain text in this browser once the phone confirms it is unlocked.'
                              : 'Not saved. Tick the box to keep it in this browser after a confirmed unlock.'}
                    </p>
                </div>
                <div
                    id="unlock-feedback"
                    class="unlock-feedback"
                    data-unlock-state={confirmed ? 'confirmed' : !connected ? 'disconnected' : phase}
                >
                    {stateMessage && (
                        <InlineStatus tone={failed ? 'error' : confirmed ? 'success' : 'neutral'}>
                            {stateMessage}
                        </InlineStatus>
                    )}
                </div>
                <p class="unlock-hint">For a pattern lock, draw on the remote screen or unlock on the phone.</p>
            </form>
        </Sheet>
    );
}
