// Keyboard rules of the device switcher, kept free of DOM and view imports so they can be tested
// without a browser.

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'defaultPrevented'>;

/**
 * Ctrl+K or Cmd+K opens the switcher. A key the stream or the terminal already used
 * (`defaultPrevented`) stays theirs: with keyboard capture on, the phone gets Ctrl+K.
 */
export function isSwitcherShortcut(event: ShortcutEvent): boolean {
    return (
        !event.defaultPrevented &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k'
    );
}

/** The row an arrow key moves to. Wraps at both ends; `undefined` when no row can be opened. */
export function nextHighlight(keys: string[], current: string | undefined, step: 1 | -1): string | undefined {
    if (!keys.length) {
        return undefined;
    }
    const index = current === undefined ? -1 : keys.indexOf(current);
    if (index < 0) {
        return step > 0 ? keys[0] : keys[keys.length - 1];
    }
    return keys[(index + step + keys.length) % keys.length];
}
