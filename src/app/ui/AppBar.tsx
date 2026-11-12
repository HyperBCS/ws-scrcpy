import { ComponentChildren } from 'preact';
import { goUp } from '../state/router';
import { LIST_PAGE_NAME } from '../state/routes';
import { Icon } from './Icon';
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
    /** The bar of the list itself: no back control and a larger title. */
    root?: boolean;
    /** Makes the title a button, for the phone switcher; `titleLabel` names it. */
    onTitle?: () => void;
    titleLabel?: string;
}

/**
 * The bar at the top of every page: back, title, one status line, actions. The class names are
 * those of `style/kit/AppBar.css`. The title is the page's h1 unless it is a button.
 */
export function AppBar({
    title,
    status,
    children,
    backLabel = LIST_PAGE_NAME,
    onBack = goUp,
    root,
    onTitle,
    titleLabel,
}: AppBarProps) {
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

/** The status line of the bar: one muted line. */
export function AppBarStatus({ children }: { children: ComponentChildren }) {
    return (
        <span class="kit-bar-status" role="status">
            {children}
        </span>
    );
}
