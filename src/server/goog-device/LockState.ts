import { AndroidLockState, KnownBoolean } from '../../types/AndroidLockState';

// Read only the small policy/trust summaries. Redact user names on-device, and read the active
// user before and after the diagnostics so a user switch cannot authorize stale credential input.
// Consume each dump fully (no head/grep -m1), and let dumpsys bound service calls to two seconds.
export const LOCK_STATE_COMMAND =
    "am get-current-user | sed 's/^/lock.currentUser=/' ; " +
    "dumpsys -t 2 window policy | sed -nE 's/^[[:space:]]*(showing|occluded|screenState)=(.*)$/keyguard.\\1=\\2/p' ; " +
    "dumpsys -t 2 trust | sed -nE 's/^[[:space:]]*User .*\\(id=([0-9]+),[^)]*\\)(.*)$/trust.user=\\1\\2/p' ; " +
    "am get-current-user | sed 's/^/lock.currentUserAfter=/'";

export function unknownLockState(): AndroidLockState {
    return {
        'keyguard.showing': 'unknown',
        'keyguard.occluded': 'unknown',
        'device.locked': 'unknown',
        'screen.power': 'unknown',
    };
}

function uniqueValue(values: string[]): string | undefined {
    return values.length && values.every((value) => value === values[0]) ? values[0] : undefined;
}

function field(output: string, name: string): string | undefined {
    const prefix = `${name}=`;
    return uniqueValue(
        output
            .split(/\r?\n/)
            .filter((line) => line.startsWith(prefix))
            .map((line) => line.slice(prefix.length).trim()),
    );
}

function knownBoolean(value: string | undefined): KnownBoolean {
    if (value === 'true' || value === '1') {
        return true;
    }
    if (value === 'false' || value === '0') {
        return false;
    }
    return 'unknown';
}

/**
 * AOSP TrustManagerService's current-user deviceLocked flag follows isDeviceLocked(): secure,
 * keyguard showing, not trusted, and not biometrically authenticated. Neither secure=true nor
 * inputRestricted=true alone establishes that authentication is required. Keyguard showing is
 * independent and can remain true while a call/camera occludes it or the display is off.
 * Source: https://developer.android.com/reference/android/app/KeyguardManager#isDeviceLocked()
 */
export function parseLockState(output: string): AndroidLockState {
    const state = unknownLockState();
    const before = field(output, 'lock.currentUser');
    const after = field(output, 'lock.currentUserAfter');
    // Without a stable active-user identity, do not combine policy and trust snapshots.
    if (!before || !/^\d+$/.test(before) || before !== after) {
        return state;
    }
    state['keyguard.showing'] = knownBoolean(field(output, 'keyguard.showing'));
    state['keyguard.occluded'] = knownBoolean(field(output, 'keyguard.occluded'));
    const screen = field(output, 'keyguard.screenState');
    state['screen.power'] = screen === 'SCREEN_STATE_ON' ? 'on' : screen === 'SCREEN_STATE_OFF' ? 'off' : 'unknown';

    const users = output.split(/\r?\n/).filter((line) => line.startsWith('trust.user='));
    const current = users.filter((line) => /\(current\)/.test(line));
    if (current.length !== 1) {
        return state;
    }
    const user = current[0].match(/^trust\.user=(\d+)\b/);
    if (!user || user[1] !== before) {
        return unknownLockState();
    }
    const locked = current[0].match(/\bdeviceLocked=(true|false|[01])(?=\s|,|$)/);
    state['device.locked'] = knownBoolean(locked?.[1]);
    return state;
}
