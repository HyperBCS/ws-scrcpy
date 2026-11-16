import { useEffect, useId, useState } from 'preact/hooks';
import '../../style/kit/SegmentedControl.css';

/** A touch screen without a mouse: there the keys of a manual choice are no help. */
const TOUCH_SCREEN = '(hover: none) and (pointer: coarse)';

/**
 * Whether the window is a touch screen without a mouse, kept up to date. A manual choice leaves
 * its keyboard sentence out there, and so does a hint beside it (the Quality presets of Settings).
 */
export function useTouchScreen(): boolean {
    const [touch, setTouch] = useState(() => window.matchMedia(TOUCH_SCREEN).matches);
    useEffect(() => {
        const media = window.matchMedia(TOUCH_SCREEN);
        const update = () => setTouch(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    return touch;
}

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
    /**
     * For costly changes: arrows move focus; Enter or Space commits the focused option. The
     * group says so to assistive technology, except on a touch screen, where a tap commits.
     */
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
    const touch = useTouchScreen();
    return (
        <div
            class={`kit-segmented ${full ? 'kit-segmented-full' : ''}`.trim()}
            role="radiogroup"
            aria-label={label}
            aria-description={
                activation === 'manual' && !touch
                    ? 'Use arrow keys to browse. Press Enter or Space to apply.'
                    : undefined
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
