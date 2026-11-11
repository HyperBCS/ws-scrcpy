import { useEffect, useRef, useState } from 'preact/hooks';
import { wakeDevice, WakeTracker } from '../googDevice/client/wake';
import '../../style/ui/AsleepBanner.css';

type WakeState = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * The device card's note that an Android screen is asleep, with its Wake button and the result
 * of pressing it. The card removes the banner once the device reports that its screen is on.
 */
export function AsleepBanner({ tracker, udid }: { tracker: WakeTracker; udid: string }) {
    const [state, setState] = useState<WakeState>('idle');
    const [failure, setFailure] = useState('');
    const mounted = useRef(true);
    useEffect(
        () => () => {
            mounted.current = false;
        },
        [],
    );
    const onWake = () => {
        setState('sending');
        wakeDevice(tracker, udid).then(
            () => {
                if (mounted.current) {
                    setState('sent');
                }
            },
            (error: Error) => {
                if (mounted.current) {
                    setFailure(error.message);
                    setState('failed');
                }
            },
        );
    };
    return (
        <div class={`device-asleep-banner ${state === 'failed' ? 'wake-failed' : ''}`} role="status">
            <span aria-hidden="true">☾</span>
            <span class="device-asleep-text">
                {state === 'sent'
                    ? 'Wake sent. Waiting for the screen.'
                    : state === 'failed'
                      ? `Could not wake the screen. ${failure}`
                      : 'Screen is asleep.'}
            </span>
            <button type="button" class="wake-button" disabled={state === 'sending'} onClick={onWake}>
                {state === 'sending' ? 'Waking…' : 'Wake'}
            </button>
        </div>
    );
}
