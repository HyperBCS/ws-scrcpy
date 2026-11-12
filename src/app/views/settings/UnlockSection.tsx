import { useEffect, useState } from 'preact/hooks';
import { Button } from '../../ui/Button';
import { SheetRow, SheetStatus } from '../../ui/SheetControls';
import { forgetPasscode, readSavedPasscode } from '../../state/savedPasscode';
import type { DeviceEntry } from '../../state/devices';
import type { Platform } from '../../state/routes';
import { capabilities } from '../../state/capabilities';
import { SettingsGroup, SettingsSection } from './Section';
import { ScheduledUnlock } from './ScheduledUnlock';

/**
 * The passcode an Android phone's Unlock sheet keeps in this browser, when the owner ticked
 * Remember in this browser and the phone confirmed it. Read again on each opening, since the
 * Unlock sheet writes it while this sheet is closed. Forget works whatever the phone's state.
 * The passcode itself is never shown.
 */
function BrowserPasscode({ udid, opening }: { udid: string; opening?: object }) {
    const [saved, setSaved] = useState(false);
    const [note, setNote] = useState<{ text: string; tone: 'success' | 'error' }>();

    useEffect(() => {
        if (opening) {
            setSaved(!!readSavedPasscode(udid));
            setNote(undefined);
        }
    }, [udid, opening]);

    // Another tab of this browser can save or forget it too.
    useEffect(() => {
        const onStorage = () => setSaved(!!readSavedPasscode(udid));
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [udid]);

    const forget = () => {
        if (forgetPasscode(udid)) {
            setSaved(false);
            setNote({ text: 'Removed from this browser.', tone: 'success' });
        } else {
            setNote({ text: 'This browser did not let the page remove it.', tone: 'error' });
        }
    };

    return (
        <SettingsGroup title="Saved passcode" status={note && <SheetStatus tone={note.tone}>{note.text}</SheetStatus>}>
            <SheetRow
                title="This browser"
                description={
                    saved
                        ? 'Saved as plain text after the phone confirmed it.'
                        : 'Not saved. Tick Remember in this browser when you unlock to keep it here.'
                }
                attributes={{ 'data-store': 'browser', 'data-store-state': saved ? 'saved' : 'empty' }}
            >
                <Button size="compact" disabled={!saved} onClick={forget}>
                    Forget
                </Button>
            </SheetRow>
        </SettingsGroup>
    );
}

interface UnlockSectionProps {
    platform: Platform;
    udid: string;
    entry?: DeviceEntry;
    /** One opening of the sheet; undefined while it is closed. */
    opening?: object;
    name: string;
}

/**
 * Unlock: the Saved passcode group, with one row for each place a passcode is kept for this
 * phone, and on an iPhone the scheduled unlock. An Android passcode can only be kept in this
 * browser; an iPhone passcode only on the server, for the scheduled unlock.
 */
export function UnlockSection({ platform, udid, entry, opening, name }: UnlockSectionProps) {
    return (
        <SettingsSection name="unlock">
            {capabilities(platform).scheduledUnlock ? (
                <ScheduledUnlock udid={udid} entry={entry} opening={opening} name={name} />
            ) : (
                <BrowserPasscode udid={udid} opening={opening} />
            )}
        </SettingsSection>
    );
}
