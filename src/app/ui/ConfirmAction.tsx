import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import '../../style/ui/ConfirmAction.css';

/** An armed action disarms by itself after this long without a confirming press. */
export const CONFIRM_TIMEOUT_MS = 6000;
/** Presses on the confirm button are ignored for this long after it appears. */
export const CONFIRM_GUARD_MS = 500;
// The page holds still for the length of a double tap before the prompt is scrolled into view,
// so the second tap lands on the button that was pressed first and not on whatever moved there.
const CONFIRM_REVEAL_MS = 300;

export interface ArmedAction<T> {
    /** The action waiting for its confirming press, if any. */
    armed: T | undefined;
    /** First press. Pass the pressed element so a repeated press on it changes nothing. */
    arm: (action: T, trigger?: EventTarget | null) => void;
    disarm: () => void;
    /** The element that armed the action; focus returns to it on Cancel. */
    trigger: { current: HTMLElement | null };
    /** Where that element was on screen when it was pressed. */
    pressed: { current: DOMRect | null };
}

/**
 * The one confirmation used for destructive and phone-side actions. The first press only arms
 * the action; `ConfirmPrompt` then shows the confirming button somewhere else, so a double tap
 * cannot run it. The armed state ends after `CONFIRM_TIMEOUT_MS`, when `active` turns false
 * (the sheet closed), when the window loses focus, and when the user presses anywhere else.
 */
export function useArmedAction<T>(active = true): ArmedAction<T> {
    const [armed, setArmed] = useState<T>();
    const trigger = useRef<HTMLElement | null>(null);
    const pressed = useRef<DOMRect | null>(null);

    useEffect(() => {
        if (!active) {
            setArmed(undefined);
        }
    }, [active]);

    useEffect(() => {
        if (armed === undefined) {
            return;
        }
        const disarm = () => setArmed(undefined);
        const onVisibility = () => {
            if (document.hidden) {
                disarm();
            }
        };
        const timer = setTimeout(disarm, CONFIRM_TIMEOUT_MS);
        window.addEventListener('blur', disarm);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            clearTimeout(timer);
            window.removeEventListener('blur', disarm);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [armed]);

    return {
        armed,
        arm: (action, element) => {
            trigger.current = element instanceof HTMLElement ? element : null;
            pressed.current = trigger.current?.getBoundingClientRect() ?? null;
            setArmed(action);
        },
        disarm: () => setArmed(undefined),
        trigger,
        pressed,
    };
}

interface ConfirmPromptProps {
    // The prompt never reads the armed value, so one prompt type serves every action type.
    action: Pick<ArmedAction<unknown>, 'disarm' | 'trigger' | 'pressed'>;
    /** Names the action and the device: "Shut down iPhone 13 Pro Max?" */
    question: string;
    /** What happens if it goes ahead. */
    consequence?: string;
    confirmLabel: string;
    /** Red confirm button. Leave off for actions that are easy to undo. */
    danger?: boolean;
    /**
     * `row`: confirm on the left, Cancel on the right, where sheet controls sit.
     * `stack`: full-width buttons with Cancel last, for sheets that grow from the bottom edge.
     */
    layout?: 'row' | 'stack';
    onConfirm: () => void;
}

/** Render only while the action is armed. Cancel takes focus; the confirm button waits. */
export function ConfirmPrompt({
    action,
    question,
    consequence,
    confirmLabel,
    danger = false,
    layout = 'row',
    onConfirm,
}: ConfirmPromptProps) {
    const root = useRef<HTMLDivElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const confirm = useRef<HTMLButtonElement>(null);
    // The two buttons trade places when the confirm button would sit where the first press landed.
    const [swapped, setSwapped] = useState(false);
    const shownAt = useRef(0);
    const [ready, setReady] = useState(false);
    const questionId = useId();
    const consequenceId = useId();
    const disarm = useRef(action.disarm);
    disarm.current = action.disarm;

    useLayoutEffect(() => {
        const node = root.current;
        shownAt.current = performance.now();
        setReady(false);
        setSwapped(false);
        // Showing the prompt can move the page (a sheet anchored to the bottom edge grows upwards,
        // a centred dialog grows both ways), and so can scrolling it into view.
        const keepClear = () => {
            const press = action.pressed.current;
            const box = confirm.current?.getBoundingClientRect();
            if (
                press &&
                box &&
                box.left < press.right &&
                press.left < box.right &&
                box.top < press.bottom &&
                press.top < box.bottom
            ) {
                setSwapped(true);
            }
        };
        keepClear();
        // Cancel is the default.
        cancel.current?.focus({ preventScroll: true });
        const reveal = setTimeout(() => {
            node?.scrollIntoView({ block: 'nearest' });
            keepClear();
        }, CONFIRM_REVEAL_MS);
        const timer = setTimeout(() => setReady(true), CONFIRM_GUARD_MS);
        const inside = (target: EventTarget | null) =>
            target instanceof Node && (!!node?.contains(target) || !!action.trigger.current?.contains(target));
        // A press or a focus move anywhere else withdraws the request. A repeated press on the
        // button that armed it is left alone, so it neither confirms nor restarts the prompt.
        // The press counts when it completes (click), not when it starts: removing the prompt
        // under a finger that is still down would move the page before the press lands. It is
        // withdrawn after the click has been delivered, so the pressed control still sees the
        // page as it was (a re-render in the middle of a click undoes a checkbox toggle).
        let withdraw: ReturnType<typeof setTimeout> | undefined;
        const onClick = (event: Event) => {
            if (!inside(event.target)) {
                withdraw = setTimeout(() => disarm.current(), 0);
            }
        };
        // Focus that moves because of a press is settled by that press's click. Only a move
        // made from the keyboard is acted on here.
        let pressing = false;
        let pointerAt = -Infinity;
        const onPointer = (event: PointerEvent) => {
            pressing = event.type === 'pointerdown';
            pointerAt = performance.now();
        };
        const onFocus = (event: FocusEvent) => {
            if (!pressing && performance.now() - pointerAt > CONFIRM_GUARD_MS && !inside(event.target)) {
                disarm.current();
            }
        };
        const pointerEvents = ['pointerdown', 'pointerup', 'pointercancel'] as const;
        pointerEvents.forEach((name) => document.addEventListener(name, onPointer, true));
        document.addEventListener('click', onClick, true);
        document.addEventListener('focusin', onFocus);
        return () => {
            clearTimeout(reveal);
            clearTimeout(timer);
            clearTimeout(withdraw);
            pointerEvents.forEach((name) => document.removeEventListener(name, onPointer, true));
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('focusin', onFocus);
            // Runs before the prompt leaves the page: hand focus back instead of dropping it.
            const trigger = action.trigger.current;
            if (node?.contains(document.activeElement) && trigger?.isConnected) {
                trigger.focus({ preventScroll: true });
            }
        };
        // A different question is a different request: the guard starts again.
    }, [question]);

    return (
        <div
            ref={root}
            class={`confirm-prompt ${layout} ${danger ? 'danger' : ''} ${swapped ? 'swapped' : ''}`}
            role="alertdialog"
            aria-labelledby={questionId}
            aria-describedby={consequence ? consequenceId : undefined}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    action.disarm();
                }
            }}
        >
            <p id={questionId} class="confirm-prompt-question">
                {question}
            </p>
            {consequence && (
                <p id={consequenceId} class="confirm-prompt-consequence">
                    {consequence}
                </p>
            )}
            <div class="confirm-prompt-actions">
                <button
                    ref={confirm}
                    type="button"
                    class={`confirm-prompt-button ${danger ? 'danger' : 'primary'}`}
                    aria-disabled={ready ? undefined : true}
                    onClick={() => {
                        if (performance.now() - shownAt.current < CONFIRM_GUARD_MS) {
                            return;
                        }
                        action.disarm();
                        onConfirm();
                    }}
                >
                    {confirmLabel}
                </button>
                <button ref={cancel} type="button" class="confirm-prompt-button" onClick={action.disarm}>
                    Cancel
                </button>
            </div>
        </div>
    );
}
