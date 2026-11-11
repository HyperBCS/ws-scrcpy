import { ComponentChildren } from 'preact';
import { goUp } from '../state/router';
import { LIST_PAGE_NAME } from '../state/routes';
import { Icon } from './Icon';
import '../../style/ui/AppBar.css';
import '../../style/kit/AppBar.css';

interface AppBarProps {
    title: string;
    /** One line under the title: the connection, a service state. */
    status?: ComponentChildren;
    /** The controls at the end of the bar: the bell, Switch. */
    children?: ComponentChildren;
    /** Names the back control, which leads to the list unless `onBack` is given. */
    backLabel?: string;
    onBack?: () => void;
    /** The kit look: other class names, the same behaviour. Without it nothing changes. */
    kit?: boolean;
    /** Kit look only. The bar of the list itself: no back control and a larger title. */
    root?: boolean;
    /** Kit look only. Makes the title a button, for the phone switcher; `titleLabel` names it. */
    onTitle?: () => void;
    titleLabel?: string;
}

/**
 * The header of every page below the list: back, title, one status line, actions. This is the
 * stream header as a component. It keeps that header's class names, so a view that moves onto
 * it looks the same and the browser checks find the same elements. With `kit` it is the bar of
 * the design system, with the class names of `style/kit/AppBar.css`.
 */
export function AppBar({
    title,
    status,
    children,
    backLabel = LIST_PAGE_NAME,
    onBack = goUp,
    kit,
    root,
    onTitle,
    titleLabel,
}: AppBarProps) {
    if (kit) {
        return (
            <header class={`kit-bar ${root ? 'kit-bar-root' : ''}`.trim()}>
                {!root && (
                    <button
                        type="button"
                        class="kit-bar-back"
                        onClick={() => onBack()}
                        aria-label={backLabel}
                        title={backLabel}
                    >
                        <Icon name="back" />
                        <span class="kit-bar-back-label">{backLabel}</span>
                    </button>
                )}
                {onTitle ? (
                    <button type="button" class="kit-bar-title" onClick={() => onTitle()} aria-label={titleLabel}>
                        <span class="kit-bar-name-line">
                            <strong class="kit-bar-name" title={title}>
                                {title}
                            </strong>
                            <Icon name="chevDown" size={16} />
                        </span>
                        {status}
                    </button>
                ) : (
                    <div class="kit-bar-title">
                        <h1 class="kit-bar-name" title={title}>
                            {title}
                        </h1>
                        {status}
                    </div>
                )}
                {children}
            </header>
        );
    }
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

interface AppBarStatusProps {
    connected?: boolean;
    /** The kit look: one muted line, without the dot. */
    kit?: boolean;
    children: ComponentChildren;
}

/** The status line of the bar: a dot, green when `connected`, and a few words. */
export function AppBarStatus({ connected = false, kit, children }: AppBarStatusProps) {
    if (kit) {
        return (
            <span class="kit-bar-status" role="status">
                {children}
            </span>
        );
    }
    return (
        <span class={`stream-header-status ${connected ? 'connected' : ''}`} role="status">
            <span class="stream-header-status-dot" aria-hidden="true" />
            {children}
        </span>
    );
}
