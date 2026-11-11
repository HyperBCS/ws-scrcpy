/**
 * Guarded access to `localStorage`. A browser with site data blocked (Safari private browsing,
 * cookies turned off) throws on every access, including the read of `window.localStorage`
 * itself. A view that reads storage while rendering must go through here, or one blocked read
 * takes the whole screen down.
 */
export function readStorage(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

/** Returns false when the value could not be kept; the caller carries on without it. */
export function writeStorage(key: string, value: string): boolean {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}
