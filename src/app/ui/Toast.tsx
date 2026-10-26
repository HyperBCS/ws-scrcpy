import { useEffect, useRef } from 'preact/hooks';
import { Presence } from './Presence';
import '../../style/ui/Toast.css';

interface ToastProps {
    message: string;
    identity: unknown;
    onDismiss: () => void;
    duration?: number;
    action?: { label: string; run: () => void; disabled?: boolean };
    className?: string;
    dismissLabel?: string;
}

export function Toast({
    message,
    identity,
    onDismiss,
    duration = 6000,
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
    return (
        <Presence
            show={!!message}
            kind="toast"
            class={`app-toast ${className}`}
            role="status"
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
            <svg
                class="toast-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                aria-hidden="true"
            >
                <path d="m5 12 4 4L19 6" />
            </svg>
            <span class="toast-message" key={String(identity)}>
                {message}
            </span>
            {action && (
                <button class="toast-action" disabled={action.disabled} onClick={action.run}>
                    {action.label}
                </button>
            )}
            <button class="toast-close" aria-label={dismissLabel} onClick={onDismiss}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                    <path d="m6 6 12 12M18 6 6 18" />
                </svg>
            </button>
        </Presence>
    );
}
