export type KnownBoolean = boolean | 'unknown';

export interface AndroidLockState {
    // Android's logical keyguard state includes a lock screen covered by another activity.
    'keyguard.showing': KnownBoolean;
    'keyguard.occluded': KnownBoolean;
    // Authentication is required for the current full user; swipe/trusted dismissal is false.
    'device.locked': KnownBoolean;
    'screen.power': 'on' | 'off' | 'unknown';
}

export type AndroidLockStateReply = AndroidLockState & { udid: string };
