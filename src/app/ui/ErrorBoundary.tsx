import { Component, ComponentChildren } from 'preact';
import { LIST_PAGE_NAME } from '../state/routes';
import { Button } from './Button';
import '../../style/ui/ErrorBoundary.css';

interface ScreenFailedProps {
    title?: string;
    /** Leaves the failed screen. Left out where there is nowhere else to go. */
    onBack?: () => void;
    backLabel?: string;
    /**
     * A sheet failed and the page behind it still works: a notice at the bottom edge instead of
     * a full page. Its title is then a heading under the page's own.
     */
    notice?: boolean;
}

/** Shown in place of a screen that could not be drawn, so the app is never left blank. */
export function ScreenFailed({
    title = 'This screen failed',
    onBack,
    backLabel = LIST_PAGE_NAME,
    notice = false,
}: ScreenFailedProps) {
    return (
        <div class={`screen-failed ${notice ? 'notice' : ''}`.trim()} role="alert">
            {notice ? <h2 class="screen-failed-title">{title}</h2> : <h1 class="screen-failed-title">{title}</h1>}
            {!notice && <p class="screen-failed-text">Reload the page to try again.</p>}
            <div class="screen-failed-actions">
                <Button variant="primary" onClick={() => location.reload()}>
                    Reload
                </Button>
                {onBack && <Button onClick={onBack}>{backLabel}</Button>}
            </div>
        </div>
    );
}

interface ErrorBoundaryProps {
    children: ComponentChildren;
    /** The failed state is dropped when this changes, for example on navigation. */
    resetKey?: string;
    fallback: (reset: () => void) => ComponentChildren;
}

/**
 * Catches an exception thrown while drawing its children (or in their effects), logs it and
 * draws `fallback` in their place. Without one, a single failing view removes every screen.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    componentDidCatch(error: unknown): void {
        console.error('[ErrorBoundary]', error);
    }

    componentDidUpdate(previous: ErrorBoundaryProps): void {
        if (this.state.failed && previous.resetKey !== this.props.resetKey) {
            this.setState({ failed: false });
        }
    }

    private reset = (): void => this.setState({ failed: false });

    render(): ComponentChildren {
        return this.state.failed ? this.props.fallback(this.reset) : this.props.children;
    }
}
