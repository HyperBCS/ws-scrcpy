import { useEffect, useState } from 'preact/hooks';
import { SheetToggleRow } from '../../ui/SheetControls';
import type { StreamClientScrcpy } from '../../googDevice/client/StreamClientScrcpy';
import type { StreamClientCoreDevice } from '../../applDevice/client/StreamClientCoreDevice';
import type { Platform } from '../../state/routes';
import { SettingsGroup, SettingsSection } from './Section';

const OPEN_THE_SCREEN = 'Open the screen to change this.';

interface KeyboardSectionProps {
    platform: Platform;
    /** The open screen of an Android phone. */
    android?: StreamClientScrcpy;
    /** The open screen of an iPhone. */
    ios?: StreamClientCoreDevice;
    /** One opening of the sheet. Each reads the switches from the screen again. */
    opening?: object;
}

/**
 * Keyboard: whether keys typed in this browser go to the phone, with one label on both kinds of
 * phone. An Android phone can also take them through its own keyboard layout (UHID). Both apply
 * at once, to the screen open in this browser, and are not sent to the phone as settings.
 */
export function KeyboardSection({ platform, android, ios, opening }: KeyboardSectionProps) {
    const screenOpen = !!(android || ios);
    const captured = () => (android ? android.isKeyboardCaptured() : ios ? ios.isHandlingKeyboardEvents() : false);
    const usingUhid = () => (android ? android.isUsingUhidKeyboard() : true);
    // Read when the section is first drawn as well, so a switch that is on does not slide on as
    // the sheet opens.
    const [capture, setCapture] = useState(captured);
    const [uhid, setUhid] = useState(usingUhid);

    useEffect(() => {
        setCapture(captured());
        setUhid(usingUhid());
    }, [android, ios, opening]);

    const onCapture = (checked: boolean) => {
        setCapture(checked);
        if (android) {
            android.setHandleKeyboardEvents(checked, uhid);
        } else {
            ios?.setHandleKeyboardEvents(checked);
        }
    };

    return (
        <SettingsSection name="keyboard">
            <SettingsGroup class="settings-keyboard">
                <SheetToggleRow
                    title="Send this keyboard to the phone"
                    description={screenOpen ? 'Keys typed in this browser go to the phone.' : OPEN_THE_SCREEN}
                    checked={screenOpen && capture}
                    disabled={!screenOpen}
                    onChange={onCapture}
                />
                {platform === 'android' && (
                    <SheetToggleRow
                        title="Native keyboard (UHID)"
                        description={android ? "Use the phone's keyboard layout · Android 11+" : OPEN_THE_SCREEN}
                        checked={!!android && uhid}
                        disabled={!android || !capture}
                        onChange={(checked) => {
                            setUhid(checked);
                            if (capture) {
                                android?.setHandleKeyboardEvents(true, checked);
                            }
                        }}
                    />
                )}
            </SettingsGroup>
        </SettingsSection>
    );
}
