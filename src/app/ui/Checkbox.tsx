import '../../style/kit/Checkbox.css';

interface CheckboxProps {
    /** The visible name, beside the box. A press on it ticks the box. */
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
}

/**
 * A tick box, for one item of a list from which several can be chosen and then saved. A setting
 * that applies at once is a `Switch`.
 */
export function Checkbox({ label, checked, onChange, disabled }: CheckboxProps) {
    return (
        <label class="kit-check">
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onChange(event.currentTarget.checked)}
            />
            <span>{label}</span>
        </label>
    );
}
