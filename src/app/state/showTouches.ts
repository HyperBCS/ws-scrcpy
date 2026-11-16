import { signal } from '@preact/signals';
import { readStorage, removeStorage, writeStorage } from '../ui/storage';

/** Where this browser keeps the Show touches switch. It holds '1' while the switch is on. */
export const SHOW_TOUCHES_KEY = 'ws-scrcpy.screen.show-touches';

/** Whether a stored value turns Show touches on. Anything but '1', and no value, is off. */
export function storedShowTouches(value: string | null): boolean {
    return value === '1';
}

/**
 * Show touches: a circle on the picture of a phone's screen under each pointer that is down on
 * it (`views/screen/TouchMarks.tsx`). The same for both kinds of phone, kept in this browser and
 * off until it is turned on here. Nothing about it is sent to the phone.
 */
export const showTouches = signal(storedShowTouches(readStorage(SHOW_TOUCHES_KEY)));

/** Turns Show touches on or off at once, and keeps the choice in this browser where it can. */
export function setShowTouches(on: boolean): void {
    showTouches.value = on;
    if (on) {
        writeStorage(SHOW_TOUCHES_KEY, '1');
    } else {
        removeStorage(SHOW_TOUCHES_KEY);
    }
}
