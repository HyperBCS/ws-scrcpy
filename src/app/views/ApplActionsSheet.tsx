import { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';
import { openApplSettingsSheet } from '../state/settingsSheet';
import { sendServiceCommand } from '../client/trackerCommand';
import { findDeviceByUdid } from '../state/devices';
import { ControlCenterCommand } from '../../common/ControlCenterCommand';
import ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import { ActionsAdapter, request, SENT } from './actions/adapter';
import { NOTE } from './actions/actionRows';
import { PhoneActionsSheet } from './actions/PhoneActionsSheet';

interface ApplActionsSheetProps {
    client: StreamClientCoreDevice;
    /** Kept for the screen that mounts the sheet. The sheet looks the phone up by its serial. */
    descriptor?: ApplDeviceDescriptor;
}

// When the phone's clipboard service wedges the server restarts it and asks again, which takes
// about ten seconds all told; these bracket that rather than the happy path's ~50 ms.
const CLIPBOARD_RECOVERY_NOTE_MS = 9000;
const CLIPBOARD_GIVE_UP_MS = 25000;
// A request over the stream socket is answered on that socket. The server's own limit for one
// request to the phone is 15 s; past this the answer is not coming.
const REQUEST_GIVE_UP_MS = 20000;

/** The Actions sheet of an iPhone: the one sheet, with what the CoreDevice stream sends. */
export function ApplActionsSheet({ client }: ApplActionsSheetProps) {
    const udid = client.getDeviceUdid();
    // No signal is read here (see `ActionsAdapter`).
    const adapter: ActionsAdapter = {
        platform: 'ios',
        sessionKey: client,
        entry: () => findDeviceByUdid(udid),
        pausedReason: () => (client.getDecoderProblem() ? NOTE.noDecoder : ''),
        onResult: (listener) => {
            client.on('result', listener);
            return () => client.off('result', listener);
        },
        clipboard: {
            read: () => client.requestClipboard(),
            readTimeouts: { giveUpMs: CLIPBOARD_GIVE_UP_MS, recoveryNoteMs: CLIPBOARD_RECOVERY_NOTE_MS },
            // Only the phone's clipboard: the owner pastes on the phone.
            send: (text) => request(client.setClipboard(text), CLIPBOARD_GIVE_UP_MS),
        },
        screen: {
            rotate: (direction) => request(client.rotate(direction), REQUEST_GIVE_UP_MS),
            refreshPicture: () => {
                client.requestKeyframe();
                return SENT;
            },
            restartVideo: () => request(client.restartStream(), REQUEST_GIVE_UP_MS),
            reconnect: () => {
                client.restartSession();
                return SENT;
            },
        },
        // A press, not a down and up pair: the server holds the button for as long as a tap does.
        sideButton: () => client.pressButton('lock', 'press'),
        // Over the tracker, so they work when no screen session is up.
        power: (command, signal) => {
            const entry = findDeviceByUdid(udid);
            if (!entry) {
                return undefined;
            }
            const type =
                command === 'reboot' ? ControlCenterCommand.REBOOT_DEVICE : ControlCenterCommand.SHUTDOWN_DEVICE;
            return sendServiceCommand(entry.tracker, type, udid, signal);
        },
        openSettings: () => openApplSettingsSheet(udid),
    };
    return <PhoneActionsSheet adapter={adapter} />;
}
