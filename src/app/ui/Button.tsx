import { ComponentChildren } from 'preact';
import { Icon } from './Icon';
import type { IconName } from './icons';
import '../../style/kit/Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
/** `compact` is 32px high under a mouse, for dense rows. On a touch screen it is 44px like the rest. */
export type ControlSize = 'default' | 'compact';

interface ButtonLook {
    variant?: ButtonVariant;
    size?: ControlSize;
    /** Takes the width of its container. */
    full?: boolean;
}

/** The classes of a button, for code that builds HTML. */
export function buttonClass({ variant = 'secondary', size = 'default', full = false }: ButtonLook = {}): string {
    return [
        'kit-button',
        variant !== 'secondary' && `kit-button-${variant}`,
        size === 'compact' && 'kit-button-compact',
        full && 'kit-button-full',
    ]
        .filter(Boolean)
        .join(' ');
}

function ignorePress(event: MouseEvent): void {
    event.preventDefault();
}

interface ButtonProps extends ButtonLook {
    /** Work is under way: a ring shows in place of the icon and a press does nothing. */
    busy?: boolean;
    disabled?: boolean;
    /** For a control that stays on. Sets `aria-pressed`. */
    pressed?: boolean;
    icon?: IconName;
    /** With an address the button is a link. */
    href?: string;
    type?: 'button' | 'submit';
    class?: string;
    onClick?: (event: MouseEvent) => void;
    /** `aria-*` and `data-*` attributes. */
    attributes?: Record<string, string | undefined>;
    children: ComponentChildren;
}

/**
 * The one button: primary for the main action of a page or sheet, secondary for the rest, quiet
 * for an action inside a card or a line of text, danger for an action that removes something.
 */
export function Button({
    variant,
    size,
    full,
    busy = false,
    disabled = false,
    pressed,
    icon,
    href,
    type = 'button',
    class: className = '',
    onClick,
    attributes,
    children,
}: ButtonProps) {
    const inert = disabled || busy;
    const shared = {
        ...attributes,
        class: `${buttonClass({ variant, size, full })} ${className}`.trim(),
        'aria-busy': busy ? ('true' as const) : undefined,
        'aria-pressed': pressed === undefined ? undefined : pressed,
        // A busy button is not disabled, so it keeps the focus. Its press is cancelled, or a
        // submit button would send its form a second time.
        onClick: busy ? ignorePress : disabled ? undefined : onClick,
    };
    const content = (
        <>
            {icon && !busy && <Icon name={icon} size={20} />}
            {children}
        </>
    );
    if (href !== undefined) {
        // A link that cannot be followed has no address, and says so.
        return (
            <a
                {...shared}
                href={inert ? undefined : href}
                role={inert ? 'link' : undefined}
                aria-disabled={inert || undefined}
            >
                {content}
            </a>
        );
    }
    return (
        <button {...shared} type={type} disabled={disabled} aria-disabled={busy || undefined}>
            {content}
        </button>
    );
}
