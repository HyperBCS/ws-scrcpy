import { useEffect, useState } from 'preact/hooks';
import '../../style/views/UnlockSheet.css';

export type DeviceLockValue = boolean | 'unknown';

interface LockScreenNoticeProps {
    udid: string;
    connected: boolean;
    locked: DeviceLockValue;
    keyguardShowing: DeviceLockValue;
    onUnlock: () => void;
}

/** In-flow notice: the lock screen stays visible and usable, including pattern gestures. */
export function LockScreenNotice({ udid, connected, locked, keyguardShowing, onUnlock }: LockScreenNoticeProps) {
    const [dismissed, setDismissed] = useState(false);
    useEffect(() => setDismissed(false), [udid, connected, locked, keyguardShowing]);
    if (!connected || dismissed || (locked !== true && keyguardShowing !== true)) {
        return null;
    }
    return (
        <div class="lock-screen-notice" role="status">
            <span>{locked === true ? 'Device locked' : 'Lock screen active'}</span>
            <button type="button" class="lock-screen-unlock" onClick={onUnlock}>
                Unlock
            </button>
            <button
                type="button"
                class="lock-screen-dismiss"
                aria-label="Dismiss lock notice"
                onClick={() => setDismissed(true)}
            >
                <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                >
                    <path d="m6 6 12 12M18 6 6 18" />
                </svg>
            </button>
        </div>
    );
}
