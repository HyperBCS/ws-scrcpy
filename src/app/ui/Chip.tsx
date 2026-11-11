import { ComponentChildren } from 'preact';
import '../../style/kit/Chip.css';

export type ChipTone = 'neutral' | 'success' | 'info' | 'warning' | 'error';

/** The classes of a chip, for code that builds HTML. */
export function chipClass(tone: ChipTone = 'neutral'): string {
    return tone === 'neutral' ? 'kit-chip' : `kit-chip kit-chip-${tone}`;
}

interface ChipProps {
    tone?: ChipTone;
    class?: string;
    /** `aria-*`, `data-*` and `title` attributes. */
    attributes?: Record<string, string | undefined>;
    children: ComponentChildren;
}

/** A state in a word or two, such as Ready or Offline. The words carry it; the colour only helps. */
export function Chip({ tone, class: className = '', attributes, children }: ChipProps) {
    return (
        <span {...attributes} class={`${chipClass(tone)} ${className}`.trim()}>
            {children}
        </span>
    );
}
