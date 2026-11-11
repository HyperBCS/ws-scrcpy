import { ComponentChildren } from 'preact';
import '../../style/kit/Checkbox.css';

interface CheckboxProps {
    /** Shown beside the box, and its name. */
    children: ComponentChildren;
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    /** The id of the text that explains the choice. */
    describedBy?: string;
}

/**
 * A box to tick, for a choice that takes effect with the action of its form. A setting that
 * applies at once is a `Switch`.
 */
export function Checkbox({ children, checked, onChange, disabled, describedBy }: CheckboxProps) {
    return (
        <label class="kit-check">
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                aria-describedby={describedBy}
                onChange={(event) => onChange(event.currentTarget.checked)}
            />
            <span>{children}</span>
        </label>
    );
}
