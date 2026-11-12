import type { PhoneCapabilities } from '../../state/capabilities';
import type { SettingsSection } from '../../state/settingsSheet';

/** The sections of the Settings sheet in their one order. A platform may leave one out, never move it. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['stream', 'sound', 'keyboard', 'unlock', 'about'];

export const SECTION_TITLES: Record<SettingsSection, string> = {
    stream: 'Stream',
    sound: 'Sound',
    keyboard: 'Keyboard',
    unlock: 'Unlock',
    about: 'About and troubleshooting',
};

/**
 * The sections a phone's sheet shows, in order. A section is left out only where the platform
 * has nothing for it: an iPhone stream has no quality settings, so it has no Stream section. A
 * phone whose kind is not known yet shows About alone, with what is known of it.
 */
export function sectionsFor(can: PhoneCapabilities | undefined): SettingsSection[] {
    return SETTINGS_SECTIONS.filter((section) => {
        if (section === 'about') {
            return true;
        }
        if (!can) {
            return false;
        }
        return section === 'stream' ? can.streamQuality : true;
    });
}

/** What `focusSection` needs of the sheet: the DOM's `querySelector`. */
interface SectionRoot {
    querySelector(selector: string): SectionHeading | null;
}
interface SectionHeading {
    focus(options?: FocusOptions): void;
    scrollIntoView(options?: ScrollIntoViewOptions): void;
}

/**
 * Moves the sheet to a section: its heading is scrolled to the top of the sheet's body and takes
 * focus, so the next Tab goes to the section's first control. False when the sheet has no such
 * section.
 */
export function focusSection(root: SectionRoot, section: SettingsSection): boolean {
    const heading = root.querySelector(`[data-section="${section}"] .settings-section-title`);
    if (!heading) {
        return false;
    }
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
    return true;
}
