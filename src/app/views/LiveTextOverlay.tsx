import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { liveTextOpen, streamConnected } from '../state/stream';
import '../../style/views/LiveTextOverlay.css';
import { usePresence } from '../ui/Presence';

/** Keys the overlay can press by name, besides typing text. */
export type LiveTextKey = 'enter' | 'backspace' | 'delete' | 'left' | 'right';

/**
 * What the overlay needs from a stream client. Android injects whole strings; iOS types every
 * character through a virtual HID keyboard and may have no key for some of them. Both hide
 * behind this so the phone-side experience (live typing, keyboard-aware layout, focus handling,
 * paste and IME commits) is written once.
 */
export interface LiveTextTarget {
    /** One line under the title: what to do on the device before typing. */
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

const KEY_BUTTONS: { key: LiveTextKey; label: string; name: string; sent: string }[] = [
    { key: 'left', label: '←', name: 'Move cursor left', sent: 'Cursor moved' },
    { key: 'right', label: '→', name: 'Move cursor right', sent: 'Cursor moved' },
    { key: 'backspace', label: '⌫ Delete', name: 'Delete previous character', sent: 'Delete sent' },
    { key: 'enter', label: 'Enter ↵', name: 'Send Enter', sent: 'Enter sent' },
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

export function LiveTextOverlay({ open, target }: LiveTextOverlayProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const { ref: panelRef, present } = usePresence<HTMLDivElement>(open, 'sheet');
    const composingRef = useRef(false);
    const compositionCommit = useRef<string>();
    const compositionTimer = useRef<ReturnType<typeof setTimeout>>();
    // Feedback from an earlier, slower send must not overwrite a later one.
    const sendSequence = useRef(0);
    const [feedback, setFeedback] = useState('');
    const [feedbackError, setFeedbackError] = useState(false);
    const [viewportStyle, setViewportStyle] = useState(typingViewport);
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
    // the gesture; the post-paint timing of `useEffect` would not be.
    useLayoutEffect(() => {
        if (!present) return;
        const previous = document.activeElement;
        const input = inputRef.current;
        const overlay = overlayRef.current;
        const panel = panelRef.current;
        const stream = overlay?.closest<HTMLElement>('.stream-view');
        const viewport = window.visualViewport;
        let frame = 0;
        const update = () => {
            const bounds = typingViewport();
            setViewportStyle(bounds);
            if (overlay) {
                // Apply synchronously before focus and before measuring the dock. The keyboard
                // can pan as well as shrink Safari's visual viewport without a window resize.
                Object.assign(overlay.style, bounds);
                overlay.classList.toggle(
                    'keyboard-raised',
                    window.innerHeight - (viewport?.height ?? window.innerHeight) > 120,
                );
            }
            if (stream && panel) {
                stream.style.setProperty('--typing-viewport-top', bounds.top);
                stream.style.setProperty('--typing-viewport-left', bounds.left);
                stream.style.setProperty('--typing-viewport-width', bounds.width);
                stream.style.setProperty('--typing-viewport-height', bounds.height);
                const gap = parseFloat(getComputedStyle(panel).marginBottom) || 0;
                stream.style.setProperty(
                    '--typing-dock-height',
                    `${Math.ceil(panel.getBoundingClientRect().height + gap)}px`,
                );
            }
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
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            viewport?.removeEventListener('resize', schedule);
            viewport?.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
            stream?.classList.remove('stream-typing');
            for (const property of ['top', 'left', 'width', 'height'])
                stream?.style.removeProperty(`--typing-viewport-${property}`);
            stream?.style.removeProperty('--typing-dock-height');
            if (document.activeElement === input) input?.blur();
            if (compositionTimer.current) clearTimeout(compositionTimer.current);
            if (previous instanceof HTMLElement && previous.isConnected && previous.getClientRects().length) {
                previous.focus({ preventScroll: true });
            } else {
                document.querySelector<HTMLButtonElement>('.floating-toolbar-fab')?.focus({ preventScroll: true });
            }
        };
    }, [present]);

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
        event.stopPropagation();
        if (event.key === 'Escape' && !event.isComposing) {
            event.preventDefault();
            close();
        } else if (event.key === 'Tab') {
            const controls = Array.from(
                panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || [],
            );
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && event.target === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && event.target === last) {
                event.preventDefault();
                first?.focus();
            }
        } else if (event.target === inputRef.current && !event.isComposing && !composingRef.current) {
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

    if (!present) return null;
    return (
        <div data-exiting={!open || undefined} class="live-text-overlay" ref={overlayRef} style={viewportStyle}>
            <div class="live-text-backdrop" onClick={close} />
            <div
                class="live-text-bar"
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="live-text-title"
                aria-describedby="live-text-hint"
                onKeyDown={onKeyDown}
                onKeyUp={(event) => event.stopPropagation()}
            >
                <div class="live-text-heading">
                    <div>
                        <strong id="live-text-title">Type on device</strong>
                        <p id="live-text-hint">{target.hint}</p>
                    </div>
                    <button type="button" class="live-text-done" onClick={close}>
                        Done
                    </button>
                </div>
                <input
                    ref={inputRef}
                    class="live-text-input"
                    type="text"
                    inputMode="text"
                    autocomplete="off"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck={false}
                    placeholder={connected ? 'Type or paste text…' : 'Reconnecting to device…'}
                    aria-label="Text to send to device"
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
                <span
                    class={`live-text-feedback ${feedbackError || !connected ? 'live-text-feedback-error' : ''}`}
                    role="status"
                >
                    {connected ? feedback || 'Keyboard ready' : 'Waiting for connection'}
                </span>
                <div class="live-text-actions">
                    {KEY_BUTTONS.map((button) => (
                        <button
                            key={button.key}
                            type="button"
                            class={`live-text-key live-text-key-${button.key}`}
                            disabled={!connected}
                            // Keep focus (and the phone keyboard) on the field: a focus change
                            // here would close the keyboard the user is typing with.
                            // Cancel only the focus-taking mouse action. Cancelling pointerdown
                            // suppresses the later touch click entirely in mobile WebKit.
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => key(button.key)}
                            aria-label={button.name}
                            title={button.name}
                        >
                            {button.label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
