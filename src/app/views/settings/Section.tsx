import { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import { AutoHeight } from '../../ui/AutoHeight';
import type { SettingsSection as SectionName } from '../../state/settingsSheet';
import { SECTION_TITLES } from './sections';

/**
 * One section of the Settings sheet: its heading, then its groups. The heading can take focus,
 * so the sheet can be opened at a section (`openSettings(udid, { section })`).
 */
export function SettingsSection({ name, children }: { name: SectionName; children: ComponentChildren }) {
    const id = useId();
    return (
        <section class="settings-section" data-section={name} aria-labelledby={id}>
            <h3 id={id} class="settings-section-title" tabIndex={-1}>
                {SECTION_TITLES[name]}
            </h3>
            {children}
        </section>
    );
}

interface SettingsGroupProps {
    title?: string;
    hint?: ComponentChildren;
    class?: string;
    /** The outcome of this group's controls, shown directly under its card. */
    status?: ComponentChildren;
    children: ComponentChildren;
}

/**
 * A group of rows inside a section: the markup of the kit's `SheetGroup`, with the title one
 * heading level under the section's.
 */
export function SettingsGroup({ title, hint, class: className, status, children }: SettingsGroupProps) {
    return (
        <section class={`kit-group ${className || ''}`.trim()}>
            {title && <h4 class="kit-group-title">{title}</h4>}
            <AutoHeight className="kit-card kit-list">{children}</AutoHeight>
            {status}
            {hint && <p class="kit-group-hint">{hint}</p>}
        </section>
    );
}
