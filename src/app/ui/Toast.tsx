import { useEffect, useRef } from 'preact/hooks';
import { Presence } from './Presence';
import { Icon } from './Icon';
import { AboveSheet } from './Sheet';
import '../../style/kit/Toast.css';

interface ToastProps {
    message: string;
    identity: unknown;
    onDismiss: () => void;
    /** Milliseconds before it closes by itself; 0 keeps it until it is closed. */
    duration?: number;
    /** `error` reports a failure: a warning icon, and it is read out at once. */
    tone?: 'success' | 'error';
    action?: { label: string; run: () => void; disabled?: boolean };
    className?: string;
    dismissLabel?: string;
}

export function Toast({
    message,
    identity,
    onDismiss,
    duration = 6000,
    tone = 'success',
    action,
    className = '',
    dismissLabel = 'Dismiss message',
}: ToastProps) {
    const dismiss = useRef(onDismiss);
    dismiss.current = onDismiss;
    const pause = useRef<() => void>(() => undefined);
    const resume = useRef<() => void>(() => undefined);
    const held = useRef({ hover: false, focus: false });
    useEffect(() => {
        if (!message) {
            held.current = { hover: false, focus: false };
            return;
        }
        if (duration <= 0) return;
        let remaining = duration;
        let start = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        pause.current = () => {
            if (timer === undefined) return;
            clearTimeout(timer);
            timer = undefined;
            remaining = Math.max(0, remaining - (performance.now() - start));
        };
        resume.current = () => {
            if (timer !== undefined || document.hidden || held.current.focus || held.current.hover) return;
            start = performance.now();
            timer = setTimeout(() => dismiss.current(), remaining);
        };
        const visibility = () => (document.hidden ? pause.current() : resume.current());
        resume.current();
        document.addEventListener('visibilitychange', visibility);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('visibilitychange', visibility);
            pause.current = resume.current = () => undefined;
        };
    }, [message, identity, duration]);
    const toast = (
        <Presence
            show={!!message}
            kind="toast"
            class={`kit-toast ${className}`.trim()}
            role={tone === 'error' ? 'alert' : 'status'}
            onPointerEnter={(event) => {
                if (event.pointerType === 'mouse') {
                    held.current.hover = true;
                    pause.current();
                }
            }}
            onPointerLeave={() => {
                held.current.hover = false;
                resume.current();
            }}
            onFocusCapture={() => {
                held.current.focus = true;
                pause.current();
            }}
            onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    held.current.focus = false;
                    resume.current();
                }
            }}
        >
            {tone === 'error' && <Icon name="warning" size={20} />}
            <span class="kit-toast-message" key={String(identity)}>
                {message}
            </span>
            {action && (
                <button type="button" class="kit-toast-action" disabled={action.disabled} onClick={action.run}>
                    {action.label}
                </button>
            )}
            <button type="button" class="kit-toast-close" aria-label={dismissLabel} onClick={onDismiss}>
                <Icon name="close" size={20} />
            </button>
        </Presence>
    );
    // A sheet on the native dialog covers the page and makes it inert: a toast raised while one
    // is open is shown inside it.
    return <AboveSheet>{toast}</AboveSheet>;
}
