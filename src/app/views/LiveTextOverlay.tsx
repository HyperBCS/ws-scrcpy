import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { liveTextOpen, streamConnected } from '../state/stream';
import { IconButton } from '../ui/IconButton';
import type { IconName } from '../ui/icons';
import { InlineStatus } from '../ui/InlineStatus';
import { Sheet } from '../ui/Sheet';
import '../../style/views/LiveTextOverlay.css';

/** Keys the sheet can press by name, besides typing text. */
export type LiveTextKey = 'enter' | 'backspace' | 'delete' | 'left' | 'right';

/**
 * What the sheet needs from a stream client. Android injects whole strings; iOS types every
 * character through a virtual HID keyboard and may have no key for some of them. Both hide
 * behind this so the phone-side experience (live typing, keyboard-aware layout, focus handling,
 * paste and IME commits) is written once.
 */
export interface LiveTextTarget {
    /** One line above the field: what to do on the device before typing. */
    hint: string;
    /** Sends committed text. Resolves with the characters the device could not receive, if any. */
    sendText(text: string): Promise<string[]> | void;
    sendKey(key: LiveTextKey): void;
    /** Starts/ends a live typing session without keeping a remote virtual keyboard attached. */
    beginTyping?(): void;
    endTyping?(): void;
}

interface LiveTextOverlayProps {
    open: boolean;
    target: LiveTextTarget;
}

const KEY_BUTTONS: { key: LiveTextKey; icon: IconName; name: string; sent: string }[] = [
    { key: 'left', icon: 'arrowLeft', name: 'Move cursor left', sent: 'Cursor moved' },
    { key: 'right', icon: 'arrowRight', name: 'Move cursor right', sent: 'Cursor moved' },
    { key: 'backspace', icon: 'backspace', name: 'Delete previous character', sent: 'Delete sent' },
    { key: 'enter', icon: 'enter', name: 'Send Enter', sent: 'Enter sent' },
];

const KEY_FOR_KEYDOWN: Record<string, LiveTextKey> = {
    Enter: 'enter',
    Backspace: 'backspace',
    Delete: 'delete',
    ArrowLeft: 'left',
    ArrowRight: 'right',
};

function typingViewport() {
    const viewport = window.visualViewport;
    return {
        top: `${viewport?.offsetTop ?? 0}px`,
        left: `${viewport?.offsetLeft ?? 0}px`,
        width: `${viewport?.width ?? window.innerWidth}px`,
        height: `${viewport?.height ?? window.innerHeight}px`,
    };
}

/**
 * Type text: a sheet with one field. What is typed, pasted or committed by an IME goes to the
 * phone at once and the field stays empty. It is the one sheet that takes focus in a field when
 * it opens, so the on-screen keyboard comes up with it, and the one that is not modal: the
 * picture and the page stay in use, so the owner can tap the next field on the phone and go on
 * typing. It closes by its close control, Escape and Back.
 */
export function LiveTextOverlay({ open, target }: LiveTextOverlayProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const compositionCommit = useRef<string>();
    const compositionTimer = useRef<ReturnType<typeof setTimeout>>();
    // Feedback from an earlier, slower send must not overwrite a later one.
    const sendSequence = useRef(0);
    const [feedback, setFeedback] = useState('');
    const [feedbackError, setFeedbackError] = useState(false);
    const connected = streamConnected.value;
    const close = () => {
        liveTextOpen.value = false;
    };

    useLayoutEffect(() => {
        if (!open) return;
        setFeedback('');
        setFeedbackError(false);
        target.beginTyping?.();
        return () => {
            target.endTyping?.();
        };
    }, [target, open]);

    // Focus during the commit, not after paint: iPhone Safari only raises its keyboard for a
    // programmatic focus() while the tap that opened the sheet still counts as a user gesture.
    // Preact re-renders from a signal change on a microtask, which WebKit still attributes to
    // the gesture; the post-paint timing of `useEffect` would not be. This runs after the
    // sheet's own effect, which shows the dialog and puts focus on it.
    useLayoutEffect(() => {
        if (!open) return;
        const input = inputRef.current;
        const content = contentRef.current;
        const panel = content?.closest<HTMLElement>('.kit-sheet-panel');
        const stream = content?.closest<HTMLElement>('.stream-view');
        const viewport = window.visualViewport;
        let frame = 0;
        // While typing, the picture and the sheet share what the on-screen keyboard leaves in
        // view: the keyboard can pan as well as shrink Safari's visual viewport without a window
        // resize. The sheet stands at the bottom of that area (as a dialog from 600px, a little
        // above the edge), and the whole picture is fitted above it, so the field being typed
        // into on the phone stays in sight. From 1024px it is docked beside the picture instead,
        // and `StreamView.css` ignores the dock height.
        const update = () => {
            if (!stream || !panel) return;
            const bounds = typingViewport();
            stream.style.setProperty('--typing-viewport-top', bounds.top);
            stream.style.setProperty('--typing-viewport-left', bounds.left);
            stream.style.setProperty('--typing-viewport-width', bounds.width);
            stream.style.setProperty('--typing-viewport-height', bounds.height);
            // From the top of the sheet to the bottom of the dialog, which covers that same area.
            // Layout offsets, not drawn ones: the sheet may still be moving in.
            const dialog = panel.offsetParent;
            const dock = dialog ? dialog.clientHeight - panel.offsetTop : panel.offsetHeight;
            stream.style.setProperty('--typing-dock-height', `${Math.max(0, Math.ceil(dock))}px`);
        };
        const schedule = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(update);
        };
        stream?.classList.add('stream-typing');
        update();
        const observer = new ResizeObserver(schedule);
        if (panel) observer.observe(panel);
        viewport?.addEventListener('resize', schedule);
        viewport?.addEventListener('scroll', schedule);
        window.addEventListener('resize', schedule);
        input?.focus({ preventScroll: true });
        // A press on the picture goes to the phone. The Android screen takes focus when it is
        // pressed; give it straight back to the field, in the same press, so the keyboard stays
        // up and typing goes on. The iPhone screen does not take focus.
        const keepFocus = (event: FocusEvent) => {
            if (event.target instanceof Element && event.target.matches('.touch-layer')) {
                input?.focus({ preventScroll: true });
            }
        };
        stream?.addEventListener('focusin', keepFocus);
        return () => {
            stream?.removeEventListener('focusin', keepFocus);
            cancelAnimationFrame(frame);
            observer.disconnect();
            viewport?.removeEventListener('resize', schedule);
            viewport?.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
            stream?.classList.remove('stream-typing');
            for (const property of ['top', 'left', 'width', 'height'])
                stream?.style.removeProperty(`--typing-viewport-${property}`);
            stream?.style.removeProperty('--typing-dock-height');
            // The on-screen keyboard goes down as the sheet starts to close.
            if (document.activeElement === input) input?.blur();
            if (compositionTimer.current) clearTimeout(compositionTimer.current);
        };
    }, [open]);

    const sendText = (text: string) => {
        if (!open || !text || !streamConnected.value) {
            return;
        }
        const sequence = ++sendSequence.current;
        setFeedbackError(false);
        setFeedback('Sending…');
        Promise.resolve(target.sendText(text))
            .then((skipped) => {
                if (sequence !== sendSequence.current) {
                    return;
                }
                setFeedbackError(!!skipped?.length);
                setFeedback(
                    skipped && skipped.length
                        ? `Sent, except ${Array.from(new Set(skipped)).join(' ')} (no key for these)`
                        : 'Text sent',
                );
            })
            .catch(() => {
                if (sequence === sendSequence.current) {
                    setFeedbackError(true);
                    setFeedback('Could not send the text');
                }
            });
    };

    useLayoutEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        const onCompositionStart = () => {
            composingRef.current = true;
        };
        const onCompositionEnd = (event: CompositionEvent) => {
            composingRef.current = false;
            sendText(event.data);
            compositionCommit.current = event.data;
            input.value = '';
            // WebKit may follow compositionend with an insertFromComposition input.
            // Keep that commit through the current event turn to avoid double text.
            if (compositionTimer.current) clearTimeout(compositionTimer.current);
            compositionTimer.current = setTimeout(() => {
                compositionCommit.current = undefined;
            }, 0);
        };
        // These events have no oncomposition* property on inputs in Safari/Chromium.
        // Register the native lowercase names explicitly so Preact does not preserve
        // JSX's CompositionStart/CompositionEnd casing and miss the browser events.
        input.addEventListener('compositionstart', onCompositionStart);
        input.addEventListener('compositionend', onCompositionEnd);
        return () => {
            input.removeEventListener('compositionstart', onCompositionStart);
            input.removeEventListener('compositionend', onCompositionEnd);
        };
    }, [target, open]);

    const key = (which: LiveTextKey) => {
        if (!open || !streamConnected.value) {
            return;
        }
        target.sendKey(which);
        sendSequence.current++;
        setFeedbackError(false);
        setFeedback(KEY_BUTTONS.find((button) => button.key === which)?.sent || 'Delete sent');
        inputRef.current?.focus({ preventScroll: true });
    };

    const onBeforeInput = (event: InputEvent) => {
        if (composingRef.current || event.isComposing) {
            return;
        }
        if (event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') {
            key(event.inputType === 'deleteContentBackward' ? 'backspace' : 'delete');
            event.preventDefault();
        } else if (event.inputType.startsWith('insert') && event.data && event.cancelable) {
            if (event.data !== compositionCommit.current) {
                sendText(event.data);
            }
            event.preventDefault();
        }
    };

    const onInput = (event: InputEvent) => {
        if (composingRef.current || event.isComposing) {
            return;
        }
        const input = event.currentTarget as HTMLInputElement;
        // Some mobile keyboards produce a noncancelable beforeinput or omit its data. Let the
        // browser finish that edit, then forward the committed value exactly once.
        if (input.value !== compositionCommit.current) {
            sendText(input.value);
        }
        input.value = '';
    };

    const onKeyDown = (event: KeyboardEvent) => {
        // Escape and Tab belong to the sheet: it closes, and it keeps focus inside.
        if (event.key === 'Escape' || event.key === 'Tab') {
            return;
        }
        event.stopPropagation();
        if (event.target === inputRef.current && !event.isComposing && !composingRef.current) {
            const which = KEY_FOR_KEYDOWN[event.key];
            // The input stays empty between commits, so desktop Backspace, Delete and the arrows
            // have no native edit to report; forward them to the device instead. Handling keydown
            // also avoids sending a second beforeinput for the same key.
            if (which !== undefined && !event.altKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                key(which);
            }
        }
    };

    return (
        <Sheet open={open} onClose={close} title="Type text" modal={false} dock>
            <div class="live-text" ref={contentRef} onKeyDown={onKeyDown} onKeyUp={(event) => event.stopPropagation()}>
                <p id="live-text-hint" class="live-text-hint">
                    {target.hint}
                </p>
                {/* Written with the kit's class: the field is focused and emptied through its ref. */}
                <input
                    ref={inputRef}
                    class="kit-field live-text-input"
                    type="text"
                    inputMode="text"
                    autocomplete="off"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck={false}
                    placeholder={connected ? 'Type or paste text…' : 'Reconnecting to the phone…'}
                    aria-label="Text to send to the phone"
                    aria-describedby="live-text-hint"
                    disabled={!connected}
                    onBeforeInput={onBeforeInput}
                    onInput={onInput}
                    onPaste={(event) => {
                        const text = event.clipboardData?.getData('text/plain');
                        if (text !== undefined) {
                            event.preventDefault();
                            sendText(text);
                        }
                    }}
                />
                <div class={`live-text-feedback ${feedbackError || !connected ? 'live-text-feedback-error' : ''}`}>
                    <InlineStatus tone={!connected ? 'warning' : feedbackError ? 'error' : 'neutral'}>
                        {connected ? feedback || 'Keyboard ready' : 'Waiting for connection'}
                    </InlineStatus>
                </div>
                <div
                    class="live-text-keys"
                    // Keep focus (and the phone keyboard) on the field: a focus change here would
                    // close the keyboard the user is typing with. Cancel only the focus-taking
                    // mouse action. Cancelling pointerdown suppresses the later touch click
                    // entirely in mobile WebKit.
                    onMouseDown={(event) => event.preventDefault()}
                >
                    {KEY_BUTTONS.map((button) => (
                        <IconButton
                            key={button.key}
                            icon={button.icon}
                            label={button.name}
                            class={`live-text-key live-text-key-${button.key}`}
                            disabled={!connected}
                            onClick={() => key(button.key)}
                        />
                    ))}
                </div>
            </div>
        </Sheet>
    );
}
