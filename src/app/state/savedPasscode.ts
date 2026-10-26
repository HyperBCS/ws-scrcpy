export type PasscodeMode = 'pin' | 'password';
interface SavedPasscode {
    value: string;
    mode: PasscodeMode;
}

const key = (udid: string) => `ws-scrcpy:passcode:${udid}`;

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
