import { useEffect, useRef, useState } from 'preact/hooks';
import { wakeDevice, WakeTracker } from '../googDevice/client/wake';
import { Banner } from './Banner';
import { InlineStatus } from './InlineStatus';
import { SCREEN } from '../copy';

type WakeState = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * The card's note that an Android screen is asleep: a banner with the Wake button, and the
 * result of pressing it on a line under the banner. The card removes both once the phone
 * reports that its screen is on.
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
    const sending = state === 'sending';
    return (
        <div class="device-asleep-banner">
            <Banner tone="info" action={{ label: sending ? 'Waking…' : 'Wake', run: onWake, disabled: sending }}>
                {SCREEN.asleepSentence}
            </Banner>
            {state === 'sent' && <InlineStatus>Wake sent. Waiting for the screen.</InlineStatus>}
            {state === 'failed' && <InlineStatus tone="error">Could not wake the screen. {failure}</InlineStatus>}
        </div>
    );
}
