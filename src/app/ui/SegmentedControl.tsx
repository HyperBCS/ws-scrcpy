import { useId } from 'preact/hooks';
import '../../style/kit/SegmentedControl.css';

export interface Segment<T extends string> {
    value: T;
    label: string;
    disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
    /** Names the group for assistive technology, for example "Quality". */
    label: string;
    /** Two to four options. Use a select for more. */
    options: ReadonlyArray<Segment<T>>;
    value: T;
    onChange: (value: T) => void;
    /** Takes the width of its container, with segments of equal width. */
    full?: boolean;
    disabled?: boolean;
}

/**
 * A choice of one among two to four options. It is a group of radio buttons: Tab reaches the
 * chosen option and the arrow keys move the choice.
 */
export function SegmentedControl<T extends string>({
    label,
    options,
    value,
    onChange,
    full = false,
    disabled = false,
}: SegmentedControlProps<T>) {
    const name = useId();
    return (
        <div class={`kit-segmented ${full ? 'kit-segmented-full' : ''}`.trim()} role="radiogroup" aria-label={label}>
            {options.map((option) => (
                <label class="kit-segment" key={option.value}>
                    <input
                        type="radio"
                        name={name}
                        value={option.value}
                        checked={option.value === value}
                        disabled={disabled || option.disabled}
                        onChange={() => onChange(option.value)}
                    />
                    <span>{option.label}</span>
                </label>
            ))}
        </div>
    );
}
