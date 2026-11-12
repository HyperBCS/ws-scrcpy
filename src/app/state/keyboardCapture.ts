import { signal } from '@preact/signals';
import { isLocalKeyboardTarget } from '../googDevice/localKeyboardTarget';
import { clipboardTextTooLong, CLIPBOARD_TOO_LONG_NOTE } from '../ui/clipboardLimit';
import { copyTextToClipboard } from '../ui/copyText';
import { shownControls, PhoneControls } from '../controls/definition';
import { deviceClipboard, deviceClipboardError, openSheet, streamNotice } from './stream';
import { effect } from '@preact/signals';

export const KEYBOARD_SHORTCUTS = [
    { letter: 'K', label: 'Release keyboard', action: 'release' },
    { letter: 'S', label: 'Switch phone', action: 'switch' },
    { letter: 'H', label: 'Home', action: 'home' },
    { letter: 'B', label: 'Back', action: 'back' },
    { letter: 'O', label: 'Overview', action: 'overview' },
    { letter: 'T', label: 'Type text', action: 'typeText' },
    { letter: 'P', label: 'Screenshot', action: 'screenshot' },
    { letter: 'C', label: 'Copy from phone', action: 'copy' },
] as const;

type CaptureState = { session?: KeyboardCapture; enabled: boolean; phone: boolean };
/** The target shown by the chip and the preference changed in Keyboard settings. */
export const keyboardCapture = signal<CaptureState>({ enabled: false, phone: false });

interface CaptureOptions {
    container: HTMLElement;
    enabled: boolean;
    connected(): boolean;
    key(event: KeyboardEvent): void;
    release(): void;
    controls(): PhoneControls | undefined;
    paste(text: string, current: () => boolean): Promise<void> | void;
    requestClipboard(): void;
    onEnabledChange?(enabled: boolean): void;
}

/**
 * One keyboard target for an open screen. It owns the browser listeners; platform handlers only
 * translate a key that passed these rules. Control, Alt and Meta wait for a non-modifier, so a
 * reserved chord and native paste never send their modifiers to the phone.
 */
export class KeyboardCapture {
    private enabled: boolean;
    private stopped = false;
    private generation = 0;
    private readonly modifiers = new Map<string, KeyboardEvent>();
    private readonly sentModifiers = new Set<string>();
    private readonly swallowed = new Set<string>();
    private hadSheet = false;
    private observer?: MutationObserver;
    private clipboardBusy = false;
    private cancelRead?: () => void;
    private chipWasPhone?: boolean;
    private windowFocused = true;

    constructor(private readonly options: CaptureOptions) {
        this.enabled = options.enabled;
        window.addEventListener('keydown', this.onKey, true);
        window.addEventListener('keyup', this.onKey, true);
        window.addEventListener('paste', this.onPaste, true);
        window.addEventListener('blur', this.onBlur);
        window.addEventListener('pagehide', this.onBlur);
        window.addEventListener('focus', this.onWindowFocus);
        document.addEventListener('focusin', this.onFocus);
        document.addEventListener('visibilitychange', this.onVisibility);
        document.addEventListener('click', this.onControlClick);
        document.addEventListener('pointerdown', this.onPointerDown, true);
        if (typeof MutationObserver !== 'undefined') {
            this.observer = new MutationObserver(this.onSheets);
            this.observer.observe(document.body, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['open'],
            });
        }
        this.refresh();
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    public setEnabled(enabled: boolean): void {
        const changed = this.enabled !== enabled;
        if (changed) this.invalidate();
        this.enabled = enabled;
        if (changed) this.options.onEnabledChange?.(enabled);
        this.refresh();
    }

    public toggle(): void {
        const phone = this.chipWasPhone ?? keyboardCapture.value.phone;
        this.chipWasPhone = undefined;
        if (phone) this.setEnabled(false);
        else {
            this.setEnabled(true);
            this.focusPicture();
        }
    }

    public focusPicture = (): void => {
        if (this.stopped || document.querySelector('dialog.kit-sheet[open]')) return;
        const target = this.options.container.querySelector?.<HTMLElement>('.touch-layer') ?? this.options.container;
        target.tabIndex = 0;
        target.focus?.({ preventScroll: true });
        this.refresh();
    };

    /** A drop or a changed target cancels clipboard work and forgets deferred modifiers. */
    public invalidate(): void {
        this.generation++;
        this.cancelRead?.();
        this.cancelRead = undefined;
        this.modifiers.clear();
        this.sentModifiers.clear();
        this.options.release();
        this.refresh();
    }

    public refresh = (): void => {
        if (this.stopped) return;
        const phone =
            this.enabled && this.windowFocused && !document.hidden && !isLocalKeyboardTarget(document.activeElement);
        const before = keyboardCapture.peek();
        if (before.session !== this || before.enabled !== this.enabled || before.phone !== phone)
            keyboardCapture.value = { session: this, enabled: this.enabled, phone };
    };

    private consume(event: KeyboardEvent, prevent = true): void {
        if (prevent) event.preventDefault();
        event.stopImmediatePropagation?.();
    }

    private onKey = (event: KeyboardEvent): void => {
        const down = event.type === 'keydown';
        const shortcut =
            !event.isComposing && event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey
                ? KEYBOARD_SHORTCUTS.find(
                      ({ letter }) => event.code === `Key${letter}` || event.key?.toUpperCase() === letter,
                  )
                : undefined;
        // The release chord also works from the chip, and can recapture after release. Other
        // reserved commands leave local fields and open sheets to their own keys.
        if (shortcut && (shortcut.action === 'release' || !isLocalKeyboardTarget(event.target))) {
            this.consume(event);
            if (!down) {
                this.swallowed.delete(event.code);
                return;
            }
            this.swallowed.add(event.code);
            if (event.repeat) return;
            this.invalidate();
            if (shortcut.action === 'release') {
                this.setEnabled(!this.enabled);
                if (this.enabled) this.focusPicture();
            } else if (shortcut.action === 'switch') openSheet('devices');
            else if (shortcut.action === 'copy') void this.copy();
            else {
                const controls = this.options.controls();
                const control =
                    controls && shownControls(controls).find(({ definition }) => definition.id === shortcut.action);
                if (!control || (control.definition.needsConnection && !this.options.connected())) return;
                if (control.action.kind === 'key') controls?.held.tap(control.action);
                else if (control.action.kind === 'run') control.action.run();
            }
            return;
        }
        if (this.swallowed.has(event.code)) {
            this.consume(event, false);
            if (!down) this.swallowed.delete(event.code);
            return;
        }
        if (!this.enabled) {
            this.refresh();
            return;
        }
        if (isLocalKeyboardTarget(event.target) || event.isComposing) {
            this.invalidate();
            return;
        }
        this.refresh();
        if (!this.options.connected()) {
            if (down) this.swallowed.add(event.code);
            this.consume(event);
            return;
        }
        const deferred = /^(Control|Alt|Meta)(Left|Right)$/.test(event.code);
        if (deferred) {
            this.consume(event, false);
            if (down && !this.sentModifiers.has(event.code)) this.modifiers.set(event.code, event);
            else if (!down) {
                this.modifiers.delete(event.code);
                if (this.sentModifiers.delete(event.code)) this.options.key(event);
            }
            return;
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyV') {
            // Keep the browser's default so it raises a paste event, also over plain HTTP.
            this.consume(event, false);
            this.swallowed.add(event.code);
            this.invalidate();
            return;
        }
        this.consume(event, false);
        if (down) {
            for (const [code, modifier] of this.modifiers) {
                this.options.key(modifier);
                this.sentModifiers.add(code);
            }
            this.modifiers.clear();
        }
        this.options.key(event);
    };

    private onPaste = (event: ClipboardEvent): void => {
        if (!this.enabled || isLocalKeyboardTarget(event.target) || !this.options.connected()) return;
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (clipboardTextTooLong(text)) {
            streamNotice.value = CLIPBOARD_TOO_LONG_NOTE;
            return;
        }
        if (this.clipboardBusy) {
            streamNotice.value = 'Wait for the current clipboard action to finish.';
            return;
        }
        this.invalidate();
        const generation = this.generation;
        const current = () => !this.stopped && generation === this.generation && this.options.connected();
        this.clipboardBusy = true;
        void Promise.resolve()
            .then(() => current() && this.options.paste(text, current))
            .catch((error: Error) => {
                if (current()) streamNotice.value = error.message || 'The text could not be pasted on the phone.';
            })
            .finally(() => {
                this.clipboardBusy = false;
            });
    };

    private async copy(): Promise<void> {
        if (!this.options.connected() || this.clipboardBusy) return;
        this.clipboardBusy = true;
        const generation = this.generation;
        const current = () => !this.stopped && generation === this.generation && this.options.connected();
        try {
            this.options.requestClipboard();
            const text = await new Promise<string>((resolve, reject) => {
                let dispose = () => {};
                const timer = setTimeout(() => {
                    dispose?.();
                    reject(Error('No answer from the phone clipboard.'));
                }, 25000);
                this.cancelRead = () => {
                    clearTimeout(timer);
                    dispose();
                    reject(Error('The keyboard target changed before the clipboard was read.'));
                };
                dispose = effect(() => {
                    const error = deviceClipboardError.value;
                    const value = deviceClipboard.value;
                    if (error || value !== undefined) {
                        clearTimeout(timer);
                        this.cancelRead = undefined;
                        queueMicrotask(() => dispose?.());
                        if (error) reject(Error(error));
                        else resolve(value!);
                    }
                });
            });
            if (!current()) return;
            if (clipboardTextTooLong(text)) throw Error(CLIPBOARD_TOO_LONG_NOTE);
            streamNotice.value = !text
                ? 'The phone clipboard is empty.'
                : (await copyTextToClipboard(text))
                  ? 'Copied to this browser.'
                  : 'This browser blocked copying. Read the clipboard in Actions and copy it there.';
        } catch (error) {
            if (current()) streamNotice.value = (error as Error).message;
        } finally {
            this.clipboardBusy = false;
        }
    }

    private onFocus = (): void => {
        if (isLocalKeyboardTarget(document.activeElement)) this.invalidate();
        else this.refresh();
    };
    private onWindowFocus = (): void => {
        this.windowFocused = true;
        this.refresh();
    };
    private onBlur = (): void => {
        this.windowFocused = false;
        this.invalidate();
    };
    private onVisibility = (): void => {
        if (document.hidden) this.invalidate();
        else this.refresh();
    };
    private onSheets = (): void => {
        const open = !!document.querySelector('dialog.kit-sheet[open]');
        if (open && !this.hadSheet) this.invalidate();
        if (!open && this.hadSheet && this.enabled && window.matchMedia?.('(pointer: fine)').matches)
            requestAnimationFrame(this.focusPicture);
        this.hadSheet = open;
        this.refresh();
    };
    private onPointerDown = (event: PointerEvent): void => {
        this.chipWasPhone =
            event.target instanceof Element && event.target.closest('.kit-keyboard-chip')
                ? keyboardCapture.peek().phone
                : undefined;
    };
    private onControlClick = (event: MouseEvent): void => {
        if (
            this.enabled &&
            window.matchMedia?.('(pointer: fine)').matches &&
            event.target instanceof Element &&
            event.target.closest('.control-button')
        )
            queueMicrotask(this.focusPicture);
    };

    public stop(): void {
        this.invalidate();
        this.stopped = true;
        this.observer?.disconnect();
        window.removeEventListener('keydown', this.onKey, true);
        window.removeEventListener('keyup', this.onKey, true);
        window.removeEventListener('paste', this.onPaste, true);
        window.removeEventListener('blur', this.onBlur);
        window.removeEventListener('pagehide', this.onBlur);
        window.removeEventListener('focus', this.onWindowFocus);
        document.removeEventListener('focusin', this.onFocus);
        document.removeEventListener('visibilitychange', this.onVisibility);
        document.removeEventListener('click', this.onControlClick);
        document.removeEventListener('pointerdown', this.onPointerDown, true);
        if (keyboardCapture.peek().session === this) keyboardCapture.value = { enabled: false, phone: false };
    }
}
