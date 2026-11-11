import { ComponentChildren } from 'preact';
import { Icon } from './Icon';
import type { IconName } from './icons';
import '../../style/kit/InlineStatus.css';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'error';

const TONE_ICON: Record<StatusTone, IconName | undefined> = {
    neutral: undefined,
    success: 'checkCircle',
    warning: 'warning',
    error: 'errorCircle',
};

interface InlineStatusProps {
    tone?: StatusTone;
    children: ComponentChildren;
}

/**
 * The outcome of a control, placed directly under it. One of three forms a message takes: this
 * line, a `Banner` for a condition that blocks a page or sheet, and a `Toast` for an action that
 * is done.
 */
export function InlineStatus({ tone = 'neutral', children }: InlineStatusProps) {
    const icon = TONE_ICON[tone];
    return (
        <p class={`kit-status kit-status-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
            {icon && <Icon name={icon} size={16} />}
            <span>{children}</span>
        </p>
    );
}
