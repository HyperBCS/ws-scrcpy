import { useEffect, useState } from 'preact/hooks';
import { ShellKey, stepTextSize, storedTextSize, TEXT_SIZES } from '../../googDevice/client/shellInput';
import { Button } from '../../ui/Button';
import { CLIPBOARD_TOO_LONG_NOTE, clipboardTextTooLong } from '../../ui/clipboardLimit';
import { copyTextToClipboard } from '../../ui/copyText';
import { IconButton } from '../../ui/IconButton';
import type { IconName } from '../../ui/icons';
import { Toast } from '../../ui/Toast';

/** What the key row needs from the terminal (`googDevice/client/ShellClient.ts`). */
export interface ShellTerminal {
    sendKey(key: ShellKey): void;
    setControl(active: boolean): void;
    focus(): void;
    pasteText(text: string): void;
    textToCopy(): { text: string; selection: boolean };
    setTextSize(size: number): void;
}

// A touch screen, whatever its width: a phone in landscape is wide, and a narrow desktop window
// still has a keyboard.
const COARSE_POINTER = '(pointer: coarse)';

function useCoarsePointer(): boolean {
    const [coarse, setCoarse] = useState(() => window.matchMedia(COARSE_POINTER).matches);
    useEffect(() => {
        const media = window.matchMedia(COARSE_POINTER);
        const update = () => setCoarse(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    return coarse;
}

const ARROWS: ReadonlyArray<{ key: ShellKey; icon: IconName; label: string }> = [
    { key: 'left', icon: 'arrowLeft', label: 'Left arrow' },
    { key: 'up', icon: 'arrowUp', label: 'Up arrow' },
    { key: 'down', icon: 'arrowDown', label: 'Down arrow' },
    { key: 'right', icon: 'arrowRight', label: 'Right arrow' },
];

// A press on a key must not take the focus from the terminal: on a phone that would close the
// keyboard, and the key would open it again.
const keepFocus = (event: MouseEvent) => event.preventDefault();

interface ShellKeysProps {
    /** The keys are off while the shell has no session. */
    connected: boolean;
    /** Ctrl is waiting for the next character. */
    control: boolean;
    onControl: (active: boolean) => void;
    /** The terminal the keys act on, or undefined while its code is loading. */
    terminal: () => Partial<ShellTerminal> | undefined;
}

/**
 * The keys a phone keyboard lacks, in one row under the terminal that scrolls sideways: Esc,
 * Tab, Ctrl for the next character, the four arrows, Paste, Copy, and the text size. Only a touch
 * screen has the row. With a mouse and a keyboard the terminal takes its height.
 */
export function ShellKeys({ connected, control, onControl, terminal }: ShellKeysProps) {
    const coarse = useCoarsePointer();
    const [size, setSize] = useState(storedTextSize);
    const [toast, setToast] = useState({ message: '', error: false, count: 0 });
    if (!coarse) {
        return null;
    }
    const say = (message: string, error = false) => setToast((last) => ({ message, error, count: last.count + 1 }));

    // The clipboard is read only here, on a press.
    const paste = async () => {
        // Browsers offer the clipboard read only to a secure page, and the app is often opened
        // on its plain http address.
        if (!window.isSecureContext) {
            say("Paste needs this app's secure (HTTPS) address.", true);
            return;
        }
        let text: string;
        try {
            text = await navigator.clipboard.readText();
        } catch {
            say('This browser blocked reading the clipboard.', true);
            return;
        }
        if (!text) {
            say('The clipboard is empty.');
        } else if (clipboardTextTooLong(text)) {
            say(CLIPBOARD_TOO_LONG_NOTE, true);
        } else {
            terminal()?.pasteText?.(text);
        }
    };

    const copy = async () => {
        const found = terminal()?.textToCopy?.();
        if (!found?.text) {
            say('There is no text to copy.');
        } else if (await copyTextToClipboard(found.text)) {
            say(found.selection ? 'Copied the selected text.' : 'Copied the text on screen.');
        } else {
            say('This browser blocked copying.', true);
        }
    };

    const resize = (step: 1 | -1) => {
        const next = stepTextSize(size, step);
        setSize(next);
        terminal()?.setTextSize?.(next);
    };

    const send = (key: ShellKey) => terminal()?.sendKey?.(key);
    return (
        <>
            <div class="shell-keys" role="group" aria-label="Terminal keys" onMouseDown={keepFocus}>
                <Button size="compact" disabled={!connected} onClick={() => send('escape')}>
                    Esc
                </Button>
                <Button size="compact" disabled={!connected} onClick={() => send('tab')}>
                    Tab
                </Button>
                <Button
                    size="compact"
                    disabled={!connected}
                    pressed={control}
                    attributes={{ title: 'Ctrl for the next key' }}
                    onClick={() => {
                        onControl(!control);
                        terminal()?.setControl?.(!control);
                        terminal()?.focus?.();
                    }}
                >
                    Ctrl
                </Button>
                {ARROWS.map((arrow) => (
                    <IconButton
                        key={arrow.key}
                        icon={arrow.icon}
                        label={arrow.label}
                        size="compact"
                        disabled={!connected}
                        onClick={() => send(arrow.key)}
                    />
                ))}
                <Button size="compact" disabled={!connected} onClick={paste}>
                    Paste
                </Button>
                <Button size="compact" disabled={!connected} onClick={copy}>
                    Copy
                </Button>
                <Button
                    size="compact"
                    disabled={!connected || size === TEXT_SIZES[0]}
                    attributes={{ 'aria-label': 'Smaller text' }}
                    onClick={() => resize(-1)}
                >
                    A−
                </Button>
                <Button
                    size="compact"
                    disabled={!connected || size === TEXT_SIZES[TEXT_SIZES.length - 1]}
                    attributes={{ 'aria-label': 'Larger text' }}
                    onClick={() => resize(1)}
                >
                    A+
                </Button>
            </div>
            <Toast
                message={toast.message}
                identity={toast.count}
                tone={toast.error ? 'error' : 'success'}
                className="shell-keys-toast"
                onDismiss={() => setToast((last) => ({ ...last, message: '' }))}
            />
        </>
    );
}
