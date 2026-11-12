import { useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Banner, BannerTone } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { InlineStatus, StatusTone } from '../ui/InlineStatus';
import { UNLOCK } from '../copy';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Sheet } from '../ui/Sheet';
import { readSavedPasscode, savePasscode, forgetPasscode, PasscodeMode } from '../state/savedPasscode';
import {
    androidUnlock,
    noticeUnlockFailure,
    UNLOCK_TEXT,
    UnlockAdapter,
    unlockErrorText,
    unlockingFromNotice,
    UnlockNotConfirmed,
    unlockOnce,
} from '../state/unlockDevice';
import type { DeviceLockValue } from './LockScreenNotice';
import '../../style/views/UnlockSheet.css';

/** A condition over the form. One that `blocks` keeps Unlock from being pressed. */
export interface UnlockBanner {
    tone: BannerTone;
    text: string;
    blocks?: boolean;
    action?: { label: string; run: () => void };
}

interface PhoneUnlockSheetProps {
    open: boolean;
    udid: string;
    /** Shown under the sheet title, as on every phone sheet. */
    subtitle?: string;
    /** A new stream client starts a new form. */
    sessionKey?: object;
    connected: boolean;
    /** The phone list reports the phone unlocked. */
    unlocked: boolean;
    adapter: UnlockAdapter;
    intro?: string;
    banners?: UnlockBanner[];
    onClose: () => void;
}

/** idle, waiting (sent or being sent, not yet confirmed), confirmed, failed: the same on both kinds of phone. */
type Phase = 'idle' | 'waiting' | 'confirmed' | 'failed';

// A mouse and a keyboard: the field can take focus without raising a phone keyboard.
const KEYBOARD_QUERY = '(hover: hover) and (pointer: fine)';
const HINT = 'You can also unlock on the remote screen or on the phone itself.';

function focusSoon(target: { current: HTMLElement | null }): () => void {
    if (!window.matchMedia(KEYBOARD_QUERY).matches) {
        return () => undefined;
    }
    // The sheet takes focus itself when it opens, and a field is enabled only after the render
    // that ends an attempt; the field takes over after that.
    let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => target.current?.focus({ preventScroll: true }));
    });
    return () => cancelAnimationFrame(frame);
}

/**
 * The one Unlock sheet of both kinds of phone. The adapter says how the passcode reaches the
 * phone and whether there is a field for it: on Android the owner types a PIN or password here;
 * an iPhone has no field, because the server types the passcode it stores. The states, the
 * Unlock button, the tones and the hint are the same for both. The sheet closes when the phone
 * list reports the phone unlocked.
 */
export function PhoneUnlockSheet({
    open,
    udid,
    subtitle,
    sessionKey,
    connected,
    unlocked,
    adapter,
    intro,
    banners = [],
    onClose,
}: PhoneUnlockSheetProps) {
    const input = useRef<HTMLInputElement>(null);
    const controller = useRef<AbortController>();
    const composing = useRef(false);
    // The passcode of the attempt in flight, kept only when it is to be remembered: it is
    // written to storage once the phone confirms the unlock and dropped in every other case.
    const toRemember = useRef<{ value: string; mode: PasscodeMode }>();
    const wasUnlocked = useRef(unlocked);
    const [mode, setMode] = useState<PasscodeMode>('pin');
    const [hasDraft, setHasDraft] = useState(false);
    const [saved, setSaved] = useState(false);
    const [remember, setRemember] = useState(false);
    const [phase, setPhase] = useState<Phase>('idle');
    const [feedback, setFeedback] = useState('');
    const formId = useId();
    const fieldId = useId();
    // One Unlock sheet per page, so these two can be fixed names.
    const rememberHintId = 'unlock-input-hint';
    const feedbackId = 'unlock-feedback';
    const field = adapter.field;
    // The lock notice is sending the saved passcode, or could not.
    const noticeBusy = unlockingFromNotice.value === udid;
    const handed = noticeUnlockFailure.value;
    const pending = phase === 'waiting' || noticeBusy;
    const blocked = banners.some((banner) => banner.blocks);
    const canSend = connected && !unlocked && !blocked && (!field || hasDraft);

    const clearDraft = () => {
        if (input.current) input.current.value = '';
        setHasDraft(false);
    };
    const cancelPending = () => {
        controller.current?.abort();
        controller.current = undefined;
        toRemember.current = undefined;
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
        // A closed sheet keeps its last words, so they stay while it slides away.
        if (!open) return;
        const stored = field ? readSavedPasscode(udid) : undefined;
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

    // What the lock notice's attempt ended with.
    useLayoutEffect(() => {
        if (!open || handed?.udid !== udid) return;
        noticeUnlockFailure.value = undefined;
        setPhase('failed');
        setFeedback(handed.message);
    }, [open, handed, udid]);

    useLayoutEffect(() => (open && field ? focusSoon(input) : undefined), [open, field]);

    useLayoutEffect(() => {
        const before = wasUnlocked.current;
        wasUnlocked.current = unlocked;
        if (!open) return;
        if (!connected) {
            clearDraft();
            if (controller.current) {
                cancelPending();
                setPhase('failed');
                setFeedback(UNLOCK_TEXT.connectionLost);
            }
        } else if (unlocked && before === false && !controller.current) {
            // Unlocked another way while the sheet was open: on the phone, or from the notice.
            clearDraft();
            setPhase('confirmed');
            setFeedback(UNLOCK_TEXT.confirmed);
            onClose();
        }
    }, [open, connected, unlocked]);

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

    const fail = (message: string) => {
        setPhase('failed');
        setFeedback(message);
        if (field) focusSoon(input);
    };

    const submit = async (event?: Event) => {
        event?.preventDefault();
        if (!canSend || pending || controller.current || composing.current) return;
        let passcode = '';
        if (field) {
            passcode = input.current?.value || '';
            if (!passcode) return;
            clearDraft();
            if (
                passcode.length > 128 ||
                (mode === 'pin' ? !/^\d+$/.test(passcode) : !/^[\x20-\x7e]+$/.test(passcode))
            ) {
                fail(
                    mode === 'pin'
                        ? 'A PIN uses digits only. Choose Password for letters or symbols.'
                        : 'Use up to 128 standard English letters, numbers, spaces or symbols. Other characters must be entered on the phone.',
                );
                return;
            }
        }
        const attempt = new AbortController();
        const current = () => !attempt.signal.aborted && controller.current === attempt;
        controller.current = attempt;
        toRemember.current = field && remember ? { value: passcode, mode } : undefined;
        setPhase('waiting');
        setFeedback(adapter.sending);
        try {
            const result = unlockOnce(adapter, passcode, attempt.signal, () => {
                if (current()) setFeedback(adapter.sent);
            });
            passcode = '';
            await result;
            if (!current()) return;
            const confirmedPasscode = toRemember.current;
            cancelPending();
            clearDraft();
            // The only place a passcode is written to storage: after the phone confirmed it.
            if (confirmedPasscode) setSaved(savePasscode(udid, confirmedPasscode.value, confirmedPasscode.mode));
            setPhase('confirmed');
            setFeedback(UNLOCK_TEXT.confirmed);
            onClose();
        } catch (error) {
            if (!current()) return;
            cancelPending();
            let message = unlockErrorText(error);
            // A saved passcode that did not unlock the phone may be out of date; sending it
            // again from a prefilled field would be another failed attempt.
            if (error instanceof UnlockNotConfirmed && field && forgetPasscode(udid)) {
                if (saved) message = `${message} ${UNLOCK_TEXT.savedRemoved}`;
                setSaved(false);
            }
            fail(message);
        }
    };

    // What the line under the form says: the state of the phone first, then the attempt.
    const [stateMessage, tone]: [string, StatusTone] = !connected
        ? ['Waiting for the phone to reconnect. No passcode will be queued.', 'neutral']
        : noticeBusy && phase !== 'waiting'
          ? [UNLOCK.unlocking, 'neutral']
          : unlocked && phase !== 'confirmed'
            ? ['This phone reports that it is unlocked.', 'neutral']
            : [feedback, phase === 'failed' ? 'error' : phase === 'confirmed' ? 'success' : 'neutral'];

    return (
        <Sheet
            open={open}
            onClose={close}
            title="Unlock phone"
            subtitle={subtitle}
            footer={
                <Button
                    type={field ? 'submit' : 'button'}
                    variant="primary"
                    // The form is in the body of the sheet; the button belongs to it by name.
                    attributes={field ? { form: formId } : undefined}
                    onClick={field ? undefined : () => void submit()}
                    busy={pending}
                    disabled={!pending && !canSend}
                >
                    Unlock
                </Button>
            }
        >
            <form
                id={formId}
                class="unlock-form"
                onSubmit={submit}
                autoComplete="off"
                onKeyUp={(event) => event.stopPropagation()}
            >
                {intro && <p class="unlock-intro">{intro}</p>}
                {banners.map((banner) => (
                    <Banner key={banner.text} tone={banner.tone} action={banner.action}>
                        {banner.text}
                    </Banner>
                ))}
                {field && (
                    <>
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
                                disabled={pending || unlocked}
                                onChange={(value) => {
                                    clearDraft();
                                    setMode(value);
                                    setFeedback('');
                                    setPhase('idle');
                                }}
                            />
                        </div>
                        {/* Written with the kit's classes: the field keeps its value out of the
                            component state and is read and cleared through its ref. */}
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
                                aria-describedby={`${rememberHintId} ${feedbackId}`}
                                disabled={!connected || pending || unlocked}
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
                                describedBy={rememberHintId}
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
                            <p id={rememberHintId} class="unlock-hint">
                                {saved
                                    ? 'Saved in this browser as plain text. Clear the box to forget it.'
                                    : remember
                                      ? 'Saved as plain text in this browser once the phone confirms it is unlocked.'
                                      : 'Not saved. Tick the box to keep it in this browser after a confirmed unlock.'}
                            </p>
                        </div>
                    </>
                )}
                {/* A live region from the start, so the first message is read out too. */}
                <div
                    id={feedbackId}
                    class="unlock-feedback"
                    aria-live="polite"
                    data-unlock-state={noticeBusy && phase !== 'waiting' ? 'waiting' : phase}
                >
                    {stateMessage && <InlineStatus tone={tone}>{stateMessage}</InlineStatus>}
                </div>
                <p class="unlock-hint">{HINT}</p>
            </form>
        </Sheet>
    );
}

interface UnlockSheetProps {
    open: boolean;
    udid: string;
    /** Shown under the sheet title, as on every phone sheet. */
    deviceName?: string;
    sessionKey?: object;
    connected: boolean;
    locked: DeviceLockValue;
    keyguardShowing: DeviceLockValue;
    keyguardOccluded?: DeviceLockValue;
    onClose: () => void;
    // A true result only means sent. The phone list must confirm the phone is unlocked.
    onSubmit: (passcode: string, signal: AbortSignal) => boolean | Promise<boolean>;
}

/** The Unlock sheet of an Android phone: the owner types its PIN or password. */
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
    const send = useRef(onSubmit);
    send.current = onSubmit;
    const adapter = useMemo(() => androidUnlock(udid, (passcode, signal) => send.current(passcode, signal)), [udid]);
    const banners: UnlockBanner[] = [];
    if (keyguardOccluded === true) {
        banners.push({
            tone: 'warning',
            text: 'Another screen is covering the phone lock. Return to the lock screen before sending a passcode.',
            blocks: true,
        });
    }
    if (locked === false && keyguardShowing === true) {
        banners.push({
            tone: 'info',
            text: 'The phone does not report a passcode lock. You may only need to swipe its lock screen.',
        });
    }
    return (
        <PhoneUnlockSheet
            open={open}
            udid={udid}
            subtitle={deviceName}
            sessionKey={sessionKey}
            connected={connected}
            unlocked={locked === false && keyguardShowing === false}
            adapter={adapter}
            banners={banners}
            onClose={onClose}
        />
    );
}
