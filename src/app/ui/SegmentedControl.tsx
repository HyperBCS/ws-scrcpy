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
    /** For costly changes: arrows move focus; Enter or Space commits the focused option. */
    activation?: 'automatic' | 'manual';
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
    activation = 'automatic',
}: SegmentedControlProps<T>) {
    const name = useId();
    return (
        <div
            class={`kit-segmented ${full ? 'kit-segmented-full' : ''}`.trim()}
            role="radiogroup"
            aria-label={label}
            aria-description={
                activation === 'manual' ? 'Use arrow keys to browse. Press Enter or Space to apply.' : undefined
            }
        >
            {options.map((option) => (
                <label class="kit-segment" key={option.value}>
                    <input
                        type="radio"
                        name={name}
                        value={option.value}
                        checked={option.value === value}
                        disabled={disabled || option.disabled}
                        onChange={() => onChange(option.value)}
                        onKeyDown={(event) => {
                            if (activation !== 'manual') return;
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                onChange(option.value);
                            } else if (
                                ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
                            ) {
                                event.preventDefault();
                                const inputs = Array.from(
                                    event.currentTarget
                                        .closest('[role="radiogroup"]')!
                                        .querySelectorAll<HTMLInputElement>('input:not(:disabled)'),
                                );
                                const index = inputs.indexOf(event.currentTarget);
                                const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
                                const next =
                                    event.key === 'Home'
                                        ? 0
                                        : event.key === 'End'
                                          ? inputs.length - 1
                                          : (index + direction + inputs.length) % inputs.length;
                                inputs[next]?.focus();
                            }
                        }}
                    />
                    <span>{option.label}</span>
                </label>
            ))}
        </div>
    );
}
