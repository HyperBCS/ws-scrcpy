import '../../style/kit/Switch.css';

type SwitchName =
    | { /** The name, when no visible text names the switch. */ label: string; labelledBy?: undefined }
    | { /** The id of the visible text that names the switch. */ labelledBy: string; label?: undefined };

type SwitchProps = SwitchName & {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    /** The id of the text that explains the setting. */
    describedBy?: string;
    /** `data-*` attributes. */
    attributes?: Record<string, string | undefined>;
};

/**
 * On or off, for a setting that applies at once. It is a checkbox with the switch role, so Space
 * turns it, a `<label>` around it turns it, and its state is the checkbox's own.
 */
export function Switch({ checked, onChange, disabled, label, labelledBy, describedBy, attributes }: SwitchProps) {
    return (
        <input
            {...attributes}
            type="checkbox"
            role="switch"
            class="kit-switch"
            checked={checked}
            disabled={disabled}
            aria-label={label}
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.currentTarget.checked)}
        />
    );
}
