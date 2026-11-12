import { useEffect, useRef, useState } from 'preact/hooks';
import { wakeDevice, WakeTracker } from '../googDevice/client/wake';
import { Button } from './Button';
import { InlineStatus } from './InlineStatus';

type WakeState = 'idle' | 'sending' | 'sent' | 'failed';

export interface WakeControl {
    state: WakeState;
    /** Why the last wake failed. */
    failure: string;
    wake: () => void;
}

/**
 * Wake from a phone's card: one wake key per press, sent by the server through adb over the
 * list's own connection, so no stream is opened. The outcome belongs to one sleep: once the
 * phone reports its screen on, the next sleep starts with no outcome, and a late reply to an
 * earlier press is dropped.
 */
export function useWake(tracker: WakeTracker, udid: string, asleep: boolean): WakeControl {
    const [state, setState] = useState<WakeState>('idle');
    const [failure, setFailure] = useState('');
    // Counts the presses and the sleeps that ended. A reply applies only to the press it answers.
    const attempt = useRef(0);
    useEffect(
        () => () => {
            attempt.current++;
        },
        [],
    );
    useEffect(() => {
        if (!asleep) {
            attempt.current++;
            setState('idle');
        }
    }, [asleep]);
    const wake = () => {
        const current = ++attempt.current;
        setState('sending');
        wakeDevice(tracker, udid).then(
            () => {
                if (attempt.current === current) {
                    setState('sent');
                }
            },
            (error: Error) => {
                if (attempt.current === current) {
                    setFailure(error.message);
                    setState('failed');
                }
            },
        );
    };
    return { state, failure, wake };
}

/** Wake, beside the status of an asleep phone. It cannot be pressed again while a wake is on its way. */
export function WakeButton({ control }: { control: WakeControl }) {
    const sending = control.state === 'sending';
    return (
        <Button size="compact" class="device-wake" disabled={sending} onClick={control.wake}>
            {sending ? 'Waking…' : 'Wake'}
        </Button>
    );
}

/** What Wake did, on the line under the head of the card. */
export function WakeOutcome({ control }: { control: WakeControl }) {
    if (control.state === 'sent') {
        return <InlineStatus>Wake sent. Waiting for the screen.</InlineStatus>;
    }
    if (control.state === 'failed') {
        return <InlineStatus tone="error">Could not wake the screen. {control.failure}</InlineStatus>;
    }
    return null;
}
