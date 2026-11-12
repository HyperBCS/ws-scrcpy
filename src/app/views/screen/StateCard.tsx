import { useEffect, useState } from 'preact/hooks';
import type { ConnectionStatus } from '../../state/phoneStatus';
import { CONNECTION, SCREEN, STATUS, UNAVAILABLE_HINT } from '../../copy';
import { goUp } from '../../state/router';
import { LIST_PAGE_NAME } from '../../state/routes';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import type { IconName } from '../../ui/icons';
import { Presence } from '../../ui/Presence';

// How long to stay optimistically hidden after the owner taps Wake. The Android device-state poll
// runs every 10s while a tracker client is connected (the iOS one every 4s while streaming), so
// this has to outlast one full cycle or the card flaps back in on stale data before the
// refreshed descriptor arrives.
const WAKE_GRACE_MS = 12000;
/** A connection that has not come up by now gets a hint under its word. */
const SLOW_MS = 12000;

/** Why the stage has no picture, when the page knows the cause. Its card wins over every other. */
export interface ScreenProblem {
    /** `data-stream-problem` of the card. */
    kind: string;
    icon: IconName;
    title: string;
    message: string;
    /** Changes with each new attempt; not read out again each time. */
    note?: string;
    /** The one thing to do about it: Retry, Start again. */
    action?: { label: string; run: () => void };
    /** A hook class for the browser checks (the Android stopped card). */
    className?: string;
}

/** What one card says. `state` is its `data-state`: a connection state, or asleep or unauthorized. */
export interface CardContent {
    state: string;
    /** A spinner in place of the icon: something is under way and nothing can be done. */
    spinner?: boolean;
    icon?: IconName;
    title: string;
    message?: string;
    note?: string;
    action?: { label: string; run: () => void };
    /** The way back to the list, beside the main action. Only a card that explains a failure has it. */
    leave?: boolean;
    /** Set for a card that explains a failure: its `data-stream-problem`. */
    problem?: string;
    className?: string;
}

/**
 * The card itself: an icon or a spinner, the word, what it means and at most one main action.
 * A card that explains a failure is an alert. `stream-start-error` stays on those as a hook class
 * for the browser checks.
 */
export function StateCardBody({ content }: { content: CardContent }) {
    const failure = content.problem !== undefined;
    return (
        <div
            class={['stream-state-card', failure && 'stream-start-error', content.className].filter(Boolean).join(' ')}
            role={failure ? 'alert' : 'status'}
            data-state={content.state}
            data-stream-problem={content.problem}
        >
            {content.spinner ? (
                <div class="stream-state-spinner" aria-hidden="true" />
            ) : (
                content.icon && <Icon name={content.icon} />
            )}
            <h2 class="stream-state-title">{content.title}</h2>
            {content.message && <p class="stream-state-message">{content.message}</p>}
            {content.note && (
                <p class="stream-start-error-note" aria-live="off">
                    {content.note}
                </p>
            )}
            {(content.action || content.leave) && (
                <div class="stream-state-actions">
                    {content.action && (
                        <Button variant="primary" onClick={content.action.run}>
                            {content.action.label}
                        </Button>
                    )}
                    {content.leave && <Button onClick={goUp}>{LIST_PAGE_NAME}</Button>}
                </div>
            )}
        </div>
    );
}

interface StateCardProps {
    /** Identity of the mounted stream; the optimistic Wake and the slow hint reset when it changes. */
    sessionKey: unknown;
    /** The page's connection, from `screenConnection`: the card says what the header says. */
    connection: ConnectionStatus;
    /** The stream client is mounted for this phone. Before that only a problem has a card. */
    mounted: boolean;
    /** The picture is up. */
    connected: boolean;
    problem?: ScreenProblem;
    /** The listed phone has not trusted this computer. */
    unauthorized: boolean;
    /**
     * Only on positive evidence from the phone (see the adapters): an unknown screen must never be
     * treated as a sleeping one.
     */
    screenOff: boolean;
    /** Sends whatever wakes this platform's screen (a WAKEUP key on Android, a Lock tap on iOS). */
    onWake: () => void;
}

/**
 * The one card on the stage for every state without a picture, most telling first: a problem
 * the page knows (with Retry or Start again), a phone that is untrusted or offline, a connection
 * under way (the word and a spinner), and a screen that is asleep (with Wake). The card is inside
 * the stage, under the header and the banners.
 *
 * Deliberately NOT driven by "no frame for N seconds". scrcpy only encodes on screen change, so
 * a healthy stream of a static screen goes seconds between frames; a card shown on a frame gap
 * ate the very touches that would have produced a new frame. Screen state comes from the phone
 * itself (`screen.power` / `device.awake`, polled server-side) and liveness from the socket.
 */
export function StateCard({
    sessionKey,
    connection,
    mounted,
    connected,
    problem,
    unauthorized,
    screenOff,
    onWake,
}: StateCardProps) {
    const [wakeRequestedAt, setWakeRequestedAt] = useState(0);
    const [slow, setSlow] = useState(false);
    const disconnected = !connected;

    useEffect(() => {
        setSlow(false);
        setWakeRequestedAt(0);
    }, [sessionKey]);

    useEffect(() => {
        if (!disconnected) {
            setSlow(false);
            return;
        }
        const timeout = setTimeout(() => setSlow(true), SLOW_MS);
        return () => clearTimeout(timeout);
    }, [disconnected, sessionKey]);

    // Clear the optimistic hide once the phone confirms it is awake again, so a phone that goes
    // back to sleep inside the grace window still shows the card again promptly.
    useEffect(() => {
        if (!screenOff && wakeRequestedAt) {
            setWakeRequestedAt(0);
        }
    }, [screenOff, wakeRequestedAt]);

    const suppressed = wakeRequestedAt !== 0 && Date.now() - wakeRequestedAt < WAKE_GRACE_MS;

    // Re-evaluate when the grace window lapses; nothing else would trigger a render if the phone
    // never reports back (wake key ignored, phone unplugged mid-wake).
    useEffect(() => {
        if (!suppressed) {
            return;
        }
        const id = setTimeout(() => setWakeRequestedAt((v) => (v === wakeRequestedAt ? 0 : v)), WAKE_GRACE_MS);
        return () => clearTimeout(id);
    }, [suppressed, wakeRequestedAt]);

    const wake = () => {
        onWake();
        // Hide at once rather than waiting up to a poll interval for the descriptor to catch up;
        // the effect above reverts this if the phone turns out to still be asleep.
        setWakeRequestedAt(Date.now());
    };

    let content: CardContent | undefined;
    if (problem) {
        const { kind, ...said } = problem;
        content = { ...said, state: connection.state, problem: kind, leave: true };
    } else if (!mounted) {
        content = undefined;
    } else if (disconnected && unauthorized) {
        content = {
            state: 'unauthorized',
            icon: 'lock',
            title: STATUS.unauthorized,
            message: UNAVAILABLE_HINT.unauthorized,
        };
    } else if (disconnected && connection.state === 'offline') {
        content = {
            state: 'offline',
            icon: connection.icon,
            title: connection.label,
            message: UNAVAILABLE_HINT.offline,
        };
    } else if (disconnected) {
        content = {
            state: connection.state,
            spinner: true,
            title: connection.label,
            message: slow ? CONNECTION.slowHint : undefined,
        };
    } else if (screenOff && !suppressed) {
        content = { state: 'asleep', icon: 'moon', title: SCREEN.asleepSentence, action: { label: 'Wake', run: wake } };
    }

    return (
        // `pointer-events: none` on the layer (see the stylesheet), so only the card can ever
        // receive input. Even if the decision above is wrong, the layer cannot block the picture.
        <Presence show={!!content} class="stream-state">
            {content && <StateCardBody content={content} />}
        </Presence>
    );
}
