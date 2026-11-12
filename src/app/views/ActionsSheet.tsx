import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import KeyEvent from '../googDevice/android/KeyEvent';
import { ControlMessage } from '../controlMessage/ControlMessage';
import { CommandControlMessage, CopyKey } from '../controlMessage/CommandControlMessage';
import { KeyCodeControlMessage } from '../controlMessage/KeyCodeControlMessage';
import { activeStream, deviceClipboard, deviceClipboardError, streamConnected } from '../state/stream';
import { openSettingsSheet } from '../state/settingsSheet';
import { findDeviceForStream } from '../state/streamDevice';
import { ActionsAdapter, NOT_SENT, PanelAction, SENT } from './actions/adapter';
import { PhoneActionsSheet } from './actions/PhoneActionsSheet';

interface ActionsSheetProps {
    client: StreamClientScrcpy;
}

const PANEL_MESSAGE: Record<PanelAction, number> = {
    notifications: ControlMessage.TYPE_EXPAND_NOTIFICATION_PANEL,
    quickSettings: ControlMessage.TYPE_EXPAND_SETTINGS_PANEL,
    collapse: ControlMessage.TYPE_COLLAPSE_PANELS,
};

// The Android server does not recover a clipboard that does not answer, so a read gives up soon.
const CLIPBOARD_GIVE_UP_MS = 5000;

/** The Actions sheet of an Android phone: the one sheet, with what scrcpy sends for each action. */
export function ActionsSheet({ client }: ActionsSheetProps) {
    // No signal is read here (see `ActionsAdapter`).
    const adapter: ActionsAdapter = {
        platform: 'android',
        sessionKey: client,
        entry: () => {
            const session = activeStream.value;
            return session ? findDeviceForStream(session.params) : undefined;
        },
        clipboard: {
            read: () => {
                deviceClipboard.value = undefined;
                // Only an iPhone reports a failed read; this keeps an older one from showing.
                deviceClipboardError.value = '';
                client.sendMessage(CommandControlMessage.createGetClipboardCommand(CopyKey.NONE));
            },
            readTimeouts: { giveUpMs: CLIPBOARD_GIVE_UP_MS },
            // Paste: the phone puts the text on its clipboard and pastes it into the focused field.
            send: (text) => {
                if (!streamConnected.value) {
                    return NOT_SENT;
                }
                client.sendMessage(CommandControlMessage.createSetClipboardCommand(text, true));
                return SENT;
            },
        },
        screen: {
            panel: (which) => {
                client.sendMessage(new CommandControlMessage(PANEL_MESSAGE[which]));
                return SENT;
            },
        },
        // The Power key, pressed and let go, as the Power control sends it from the keyboard.
        sideButton: () => {
            client.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_POWER, 0, 0));
            client.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_POWER, 0, 0));
        },
        openSettings: () => {
            const session = activeStream.value;
            if (session) {
                openSettingsSheet(session.params.udid);
            }
        },
    };
    return <PhoneActionsSheet adapter={adapter} />;
}
