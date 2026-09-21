import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { liveTextOpen, streamConnected } from '../state/stream';
import '../../style/views/LiveTextOverlay.css';

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
}

interface LiveTextOverlayProps {
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

export function LiveTextOverlay({ target }: LiveTextOverlayProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const compositionCommit = useRef<string>();
    const compositionTimer = useRef<ReturnType<typeof setTimeout>>();
    // Feedback from an earlier, slower send must not overwrite a later one.
    const sendSequence = useRef(0);
    const [feedback, setFeedback] = useState('');
    const [viewportStyle, setViewportStyle] = useState({ top: '0px', height: '100%' });
    const connected = streamConnected.value;
    const close = () => {
        liveTextOpen.value = false;
    };

    // Focus during the commit, not after paint: iPhone Safari only raises its keyboard for a
    // programmatic focus() while the tap that opened the sheet still counts as a user gesture.
    // Preact re-renders from a signal change on a microtask, which WebKit still attributes to
    // the gesture; the post-paint timing of `useEffect` would not be.
    useLayoutEffect(() => {
        const previous = document.activeElement;
        inputRef.current?.focus();
        return () => {
            if (previous instanceof HTMLElement && previous.isConnected && previous.getClientRects().length) {
                previous.focus({ preventScroll: true });
            } else {
                document.querySelector<HTMLButtonElement>('.floating-toolbar-fab')?.focus({ preventScroll: true });
            }
        };
    }, []);

    useEffect(() => {
        const update = () =>
            setViewportStyle({
                top: `${window.visualViewport?.offsetTop || 0}px`,
                height: `${window.visualViewport?.height || window.innerHeight}px`,
            });
        update();
        window.visualViewport?.addEventListener('resize', update);
        window.visualViewport?.addEventListener('scroll', update);
        return () => {
            window.visualViewport?.removeEventListener('resize', update);
            window.visualViewport?.removeEventListener('scroll', update);
            if (compositionTimer.current) {
                clearTimeout(compositionTimer.current);
            }
        };
    }, []);

    const sendText = (text: string) => {
        if (!text || !streamConnected.value) {
            return;
        }
        const sequence = ++sendSequence.current;
        setFeedback('Sending…');
        Promise.resolve(target.sendText(text))
            .then((skipped) => {
                if (sequence !== sendSequence.current) {
                    return;
                }
                setFeedback(
                    skipped && skipped.length
                        ? `Sent, except ${Array.from(new Set(skipped)).join(' ')} (no key for these)`
                        : 'Text sent',
                );
            })
            .catch(() => {
                if (sequence === sendSequence.current) {
                    setFeedback('Could not send the text');
                }
            });
    };

    const key = (which: LiveTextKey) => {
        if (!streamConnected.value) {
            return;
        }
        target.sendKey(which);
        sendSequence.current++;
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

    return (
        <div class="live-text-overlay" style={viewportStyle}>
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
                    onCompositionStart={() => {
                        composingRef.current = true;
                    }}
                    onCompositionEnd={(event) => {
                        composingRef.current = false;
                        sendText(event.data);
                        compositionCommit.current = event.data;
                        if (inputRef.current) {
                            inputRef.current.value = '';
                        }
                        // WebKit may follow compositionend with an insertFromComposition input.
                        // Keep that commit through the current event turn to avoid double text.
                        compositionTimer.current = setTimeout(() => {
                            compositionCommit.current = undefined;
                        }, 0);
                    }}
                />
                <span class="live-text-feedback" role="status">
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
                            onPointerDown={(event) => event.preventDefault()}
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
