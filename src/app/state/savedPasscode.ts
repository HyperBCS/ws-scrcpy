/**
 * The Android unlock sheet's optional "Remember in this browser" copy of a PIN or password.
 *
 * It is plain text in `localStorage`, so it exists only when the owner ticked the box, and it is
 * written only after the device confirmed that the passcode unlocked it. iPhones have no browser
 * copy: their passcode is stored encrypted on the server (`IosSettingsStore`).
 */
export type PasscodeMode = 'pin' | 'password';
interface SavedPasscode {
    value: string;
    mode: PasscodeMode;
}

// Copies under the old prefix were written on every send, before any unlock was confirmed and
// without asking. They are removed, not migrated: any of them may be a mistyped passcode.
const LEGACY_PREFIX = 'ws-scrcpy:passcode:';
const key = (udid: string) => `ws-scrcpy:remembered-passcode:${udid}`;

/**
 * Remove every passcode saved by an earlier version, Android and iPhone alike. Runs when the app
 * loads; later calls find nothing. Returns how many were removed.
 */
export function purgeLegacyPasscodes(): number {
    try {
        const stale: string[] = [];
        for (let index = 0; index < localStorage.length; index++) {
            const name = localStorage.key(index);
            if (name?.startsWith(LEGACY_PREFIX)) {
                stale.push(name);
            }
        }
        stale.forEach((name) => localStorage.removeItem(name));
        return stale.length;
    } catch {
        // Nothing can be read from blocked storage either.
        return 0;
    }
}

export function readSavedPasscode(udid: string): SavedPasscode | undefined {
    try {
        const saved = JSON.parse(localStorage.getItem(key(udid)) || 'null');
        if (
            saved &&
            typeof saved.value === 'string' &&
            saved.value.length > 0 &&
            saved.value.length <= 128 &&
            (saved.mode === 'pin'
                ? /^\d+$/.test(saved.value)
                : saved.mode === 'password' && /^[\x20-\x7e]+$/.test(saved.value))
        )
            return saved;
    } catch {
        // Unlock still works when browser storage is unavailable.
    }
    return undefined;
}

/** Call only after the device confirmed the unlock, and only when the owner asked to remember it. */
export function savePasscode(udid: string, value: string, mode: PasscodeMode): boolean {
    try {
        localStorage.setItem(key(udid), JSON.stringify({ value, mode }));
        return true;
    } catch {
        return false;
    }
}

export function forgetPasscode(udid: string): boolean {
    try {
        localStorage.removeItem(key(udid));
        return true;
    } catch {
        return false;
    }
}

purgeLegacyPasscodes();
