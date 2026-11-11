import { Icon } from './Icon';
import type { IconName } from './icons';
import type { ControlSize } from './Button';
import '../../style/kit/IconButton.css';

interface IconButtonLook {
    /** `bare` has no outline or fill: for a header, a toolbar and a row. */
    variant?: 'outlined' | 'bare';
    size?: ControlSize;
    danger?: boolean;
}

/** The classes of an icon button, for code that builds HTML. Such a button needs an `aria-label`. */
export function iconButtonClass({
    variant = 'outlined',
    size = 'default',
    danger = false,
}: IconButtonLook = {}): string {
    return [
        'kit-icon-button',
        variant === 'bare' && 'kit-icon-button-bare',
        danger && 'kit-icon-button-danger',
        size === 'compact' && 'kit-icon-button-compact',
    ]
        .filter(Boolean)
        .join(' ');
}

interface IconButtonProps extends IconButtonLook {
    icon: IconName;
    /** The name of the button. It is read out and shown on hover; an icon alone has no name. */
    label: string;
    /** For a control that stays on. Sets `aria-pressed`. */
    pressed?: boolean;
    disabled?: boolean;
    /** With an address the button is a link. */
    href?: string;
    class?: string;
    onClick?: (event: MouseEvent) => void;
    /** `aria-*` and `data-*` attributes. */
    attributes?: Record<string, string | undefined>;
}

/** A button that shows only an icon. It is refused without a label. */
export function IconButton({
    icon,
    label,
    variant,
    size,
    danger,
    pressed,
    disabled = false,
    href,
    class: className = '',
    onClick,
    attributes,
}: IconButtonProps) {
    if (typeof label !== 'string' || !label.trim()) {
        throw new Error(`The icon button "${icon}" has no label. An icon alone has no name.`);
    }
    const shared = {
        ...attributes,
        class: `${iconButtonClass({ variant, size, danger })} ${className}`.trim(),
        'aria-label': label,
        title: label,
        'aria-pressed': pressed === undefined ? undefined : pressed,
        onClick: disabled ? undefined : onClick,
    };
    const content = <Icon name={icon} size={size === 'compact' ? 20 : 24} />;
    if (href !== undefined) {
        return (
            <a
                {...shared}
                href={disabled ? undefined : href}
                role={disabled ? 'link' : undefined}
                aria-disabled={disabled || undefined}
            >
                {content}
            </a>
        );
    }
    return (
        <button {...shared} type="button" disabled={disabled}>
            {content}
        </button>
    );
}
