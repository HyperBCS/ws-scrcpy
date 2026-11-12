import { useEffect, useRef, useState } from 'preact/hooks';
import '../../style/kit/Banner.css';
import '../../style/views/UnlockSheet.css';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { UNLOCK } from '../copy';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { Presence } from '../ui/Presence';
import { findDeviceByUdid } from '../state/devices';
import { lockNotice } from '../state/phoneStatus';
import { noticeUnlockFailure, oneTapUnlock, unlockingFromNotice } from '../state/unlockDevice';

export type DeviceLockValue = boolean | 'unknown';

interface LockScreenNoticeProps {
    udid: string;
    connected: boolean;
    locked: DeviceLockValue;
    keyguardShowing: DeviceLockValue;
    /** Opens the Unlock sheet: when no passcode is saved for the phone, or after a failed one-tap unlock. */
    onUnlock: () => void;
}

/**
 * In-flow notice: the lock screen stays visible and usable, including pattern gestures. With a
 * passcode saved for the phone (Android: in this browser; iPhone: on the server), Unlock sends it
 * at once and the notice says Unlocking… until the phone reports itself unlocked; the sheet opens
 * only when that fails. A lock screen that asks for no passcode has no Unlock: it is swiped.
 */
export function LockScreenNotice({ udid, connected, locked, keyguardShowing, onUnlock }: LockScreenNoticeProps) {
    const [dismissed, setDismissed] = useState(false);
    const attempt = useRef<AbortController>();
    useEffect(() => setDismissed(false), [udid, connected, locked, keyguardShowing]);
    // An attempt belongs to the phone and the page it was started on, and so does its failure.
    useEffect(
        () => () => {
            attempt.current?.abort();
            attempt.current = undefined;
            if (noticeUnlockFailure.peek()?.udid === udid) {
                noticeUnlockFailure.value = undefined;
            }
        },
        [udid],
    );
    const unlocking = unlockingFromNotice.value === udid;
    const entry = findDeviceByUdid(udid);
    // Another screen over the lock screen (a call, the camera): nothing to swipe.
    const occluded =
        entry?.params.type === 'android' && (entry.descriptor as GoogDeviceDescriptor)['keyguard.occluded'] === true;
    const swipe = locked === false && !unlocking;
    const visible = connected && !dismissed && (locked === true || keyguardShowing === true) && !(swipe && occluded);

    const unlock = () => {
        const run = oneTapUnlock(udid);
        if (!run) {
            onUnlock();
            return;
        }
        attempt.current?.abort();
        const controller = new AbortController();
        attempt.current = controller;
        void run(controller.signal).then((outcome) => {
            if (attempt.current !== controller) return;
            attempt.current = undefined;
            if (outcome === 'failed') onUnlock();
        });
    };

    return (
        <Presence show={visible} kind="collapse" class="lock-screen-notice kit-banner kit-banner-info" role="status">
            <Icon name="lock" size={16} />
            <span class="kit-banner-text">{unlocking ? UNLOCK.unlocking : lockNotice(locked)}</span>
            {!swipe && (
                <Button size="compact" class="lock-screen-unlock" busy={unlocking} onClick={unlock}>
                    Unlock
                </Button>
            )}
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
