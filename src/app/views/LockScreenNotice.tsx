import { useEffect, useState } from 'preact/hooks';
import '../../style/kit/Banner.css';
import '../../style/views/UnlockSheet.css';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { Presence } from '../ui/Presence';

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
    const visible = connected && !dismissed && (locked === true || keyguardShowing === true);
    return (
        <Presence show={visible} kind="collapse" class="lock-screen-notice kit-banner kit-banner-info" role="status">
            <Icon name="lock" size={16} />
            <span class="kit-banner-text">{locked === true ? 'Device locked' : 'Lock screen active'}</span>
            <Button size="compact" class="lock-screen-unlock" onClick={onUnlock}>
                Unlock
            </Button>
            <IconButton
                icon="close"
                variant="bare"
                size="compact"
                class="lock-screen-dismiss"
                label="Dismiss lock notice"
                onClick={() => setDismissed(true)}
            />
        </Presence>
    );
}
