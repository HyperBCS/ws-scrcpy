import { signal } from '@preact/signals';
import { readStorage, removeStorage, writeStorage } from '../ui/storage';

/** Where this browser keeps the theme. It holds 'light' or 'dark'; with no value, System. */
export const THEME_KEY = 'ws-scrcpy.theme';

/** System follows the system's own setting, as the app always did. */
export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

/**
 * The colour of the browser's bar and of the installed app's title bar in each theme: the page's
 * background, `--surface` of `style/tokens.css`. index.html and `public/theme.js` have the same
 * two; scripts/test-theme.js holds all four places to them.
 */
export const THEME_COLOURS = { light: '#f5f6f8', dark: '#17191d' } as const;

/** The choice a stored value makes. Anything but 'light' or 'dark', and no value, is System. */
export function storedTheme(value: string | null): ThemeChoice {
    return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * Puts a choice on the page: `data-theme` on the root for Light and Dark, which `tokens.css`
 * reads, and none for System, where its media query decides. The `color-scheme` meta and the
 * `theme-color` metas follow, so the browser's own parts and its bar match before and after the
 * styles load. A style change only: nothing is mounted again and nothing is sent.
 * `public/theme.js` does the same before the first paint.
 */
export function applyTheme(choice: ThemeChoice, doc: Document = document): void {
    const root = doc.documentElement;
    if (choice === 'system') {
        root.removeAttribute('data-theme');
    } else if (root.getAttribute('data-theme') !== choice) {
        root.setAttribute('data-theme', choice);
    }
    doc.querySelectorAll('meta[name="color-scheme"]').forEach((meta) => {
        meta.setAttribute('content', choice === 'system' ? 'light dark' : choice);
    });
    // Each meta keeps its media query; with a choice both name its colour, so the one in effect
    // has it whatever the system says.
    doc.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
        const own = /dark/.test(meta.getAttribute('media') || '') ? 'dark' : 'light';
        meta.setAttribute('content', THEME_COLOURS[choice === 'system' ? own : choice]);
    });
}

/**
 * The theme of every page of the app: System (the default), Light or Dark. Kept in this browser
 * and read back on the next load. Another tab or the installed app takes a change at once.
 */
export const theme = signal(storedTheme(readStorage(THEME_KEY)));

/** Changes the theme at once, and keeps the choice in this browser where it can. */
export function setTheme(choice: ThemeChoice): void {
    theme.value = choice;
    applyTheme(choice);
    if (choice === 'system') {
        removeStorage(THEME_KEY);
    } else {
        writeStorage(THEME_KEY, choice);
    }
}

// The page normally has the choice from `public/theme.js` already. This covers a page that did not
// run it; applying the same choice again changes nothing.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    applyTheme(theme.value);
    window.addEventListener('storage', (event) => {
        if (event.key === THEME_KEY || event.key === null) {
            theme.value = storedTheme(readStorage(THEME_KEY));
            applyTheme(theme.value);
        }
    });
}
