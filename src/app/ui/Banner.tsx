import { ComponentChildren } from 'preact';
import { Button } from './Button';
import { Icon } from './Icon';
import '../../style/kit/Banner.css';

export type BannerTone = 'warning' | 'info' | 'error';

interface BannerProps {
    tone?: BannerTone;
    /** The one thing to do about it. */
    action?: { label: string; run: () => void; busy?: boolean; disabled?: boolean };
    children: ComponentChildren;
}

/**
 * A condition that blocks the page or sheet it heads, with one action. For the outcome of a
 * control use `InlineStatus`, and for an action that is done use `Toast`.
 */
export function Banner({ tone = 'warning', action, children }: BannerProps) {
    return (
        <div
            class={`kit-banner ${tone === 'warning' ? '' : `kit-banner-${tone}`}`.trim()}
            role={tone === 'error' ? 'alert' : 'status'}
        >
            <Icon name={tone === 'info' ? 'info' : 'warning'} size={16} />
            <span class="kit-banner-text">{children}</span>
            {action && (
                <Button size="compact" busy={action.busy} disabled={action.disabled} onClick={action.run}>
                    {action.label}
                </Button>
            )}
        </div>
    );
}
