import { ComponentChildren } from 'preact';
import { goUp } from '../state/router';
import { LIST_PAGE_NAME } from '../state/routes';
import '../../style/ui/AppBar.css';

interface AppBarProps {
    title: string;
    /** One line under the title: the connection, a service state. */
    status?: ComponentChildren;
    /** The controls at the end of the bar: the bell, Switch. */
    children?: ComponentChildren;
    /** Names the back control, which leads to the list unless `onBack` is given. */
    backLabel?: string;
    onBack?: () => void;
}

/**
 * The header of every page below the list: back, title, one status line, actions. This is the
 * stream header as a component. It keeps that header's class names, so a view that moves onto
 * it looks the same and the browser checks find the same elements.
 */
export function AppBar({ title, status, children, backLabel = LIST_PAGE_NAME, onBack = goUp }: AppBarProps) {
    return (
        <header class="stream-header">
            <button
                type="button"
                class="stream-header-back"
                onClick={() => onBack()}
                aria-label={backLabel}
                title={backLabel}
            >
                <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                >
                    <path d="m15 6-6 6 6 6" />
                </svg>
            </button>
            <div class="stream-header-device">
                <strong title={title}>{title}</strong>
                {status}
            </div>
            {children}
        </header>
    );
}

/** The status line of the bar: a dot, green when `connected`, and a few words. */
export function AppBarStatus({ connected = false, children }: { connected?: boolean; children: ComponentChildren }) {
    return (
        <span class={`stream-header-status ${connected ? 'connected' : ''}`} role="status">
            <span class="stream-header-status-dot" aria-hidden="true" />
            {children}
        </span>
    );
}
