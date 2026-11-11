import { useEffect, useState } from 'preact/hooks';
import { BottomSheet } from '../ui/BottomSheet';
import { SheetGroup, SheetRow, SheetStatus, SoundRows } from '../ui/SheetControls';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import {
    activeStream,
    closeAllSheets,
    deviceClipboard,
    openSheet,
    streamConnected,
    toolsSheetOpen,
} from '../state/stream';
import { openSettingsSheet } from '../state/settingsSheet';
import { findDeviceForStream } from '../state/streamDevice';
import { deviceName } from '../state/devices';
import { activeAudioSession, audioAvailability } from '../state/audio';
import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { ControlMessage } from '../controlMessage/ControlMessage';
import { CommandControlMessage, CopyKey } from '../controlMessage/CommandControlMessage';
import { CLIPBOARD_TOO_LONG_NOTE, clipboardTextTooLong } from '../ui/clipboardLimit';
import { copyPhoneClipboardHere } from '../ui/copyText';
import '../../style/views/ActionsSheet.css';

interface ActionsSheetProps {
    client: StreamClientScrcpy;
}

export function ActionsSheet({ client }: ActionsSheetProps) {
    const [clipboardDraft, setClipboardDraft] = useState('');
    const [clipboardNote, setClipboardNote] = useState('');
    const [reading, setReading] = useState(false);
    const received = deviceClipboard.value;
    const draftTooLong = clipboardTextTooLong(clipboardDraft);
    const connected = streamConnected.value;
    const session = activeStream.value;
    const entry = session ? findDeviceForStream(session.params) : undefined;
    const descriptor = entry?.params.type === 'android' ? (entry.descriptor as GoogDeviceDescriptor) : undefined;
    const lockActive = descriptor?.['device.locked'] === true || descriptor?.['keyguard.showing'] === true;
    const audioSession = activeAudioSession.value;

    useEffect(() => {
        setClipboardDraft('');
        setClipboardNote('');
        setReading(false);
    }, [client]);

    useEffect(() => {
        if (!reading) {
            return;
        }
        if (received !== undefined) {
            setReading(false);
            setClipboardNote(received ? 'Read from the phone.' : 'The phone clipboard is empty.');
            return;
        }
        const timeout = setTimeout(() => {
            setReading(false);
            setClipboardNote('No clipboard response yet. Unlock the phone and try again.');
        }, 5000);
        return () => clearTimeout(timeout);
    }, [reading, received]);

    const send = (type: number) => {
        client.sendMessage(new CommandControlMessage(type));
        toolsSheetOpen.value = false;
    };

    const onReadClipboard = () => {
        deviceClipboard.value = undefined;
        setReading(true);
        setClipboardNote('Reading the phone clipboard…');
        client.sendMessage(CommandControlMessage.createGetClipboardCommand(CopyKey.NONE));
    };

    // The same helper as the iPhone sheet: on plain HTTP, where `navigator.clipboard` does not
    // exist, it copies through a hidden text area.
    const onCopy = async () => setClipboardNote(await copyPhoneClipboardHere(received));

    const onPaste = () => {
        if (clipboardDraft && !draftTooLong && streamConnected.value) {
            client.sendMessage(CommandControlMessage.createSetClipboardCommand(clipboardDraft, true));
            setClipboardNote('Pasted into the focused field on the phone.');
        }
    };

    return (
        <BottomSheet
            open={toolsSheetOpen.value}
            onClose={() => (toolsSheetOpen.value = false)}
            title="Actions"
            subtitle={entry ? deviceName(entry) : undefined}
        >
            <div class="actions-sheet">
                {!connected && (
                    <SheetStatus tone="warning">
                        Reconnecting. Actions that need the stream are paused until it is back.
                    </SheetStatus>
                )}

                <SheetGroup title="Sound">
                    {audioSession ? (
                        <SoundRows session={audioSession} />
                    ) : (
                        <SheetRow title="Listen in this browser" description={audioAvailability.value.message} />
                    )}
                </SheetGroup>

                <SheetGroup
                    title="Clipboard"
                    status={
                        draftTooLong ? (
                            <SheetStatus tone="error">{CLIPBOARD_TOO_LONG_NOTE}</SheetStatus>
                        ) : (
                            clipboardNote && <SheetStatus>{clipboardNote}</SheetStatus>
                        )
                    }
                >
                    <SheetRow
                        title="Read the phone's clipboard"
                        description="Copy from the phone to this browser."
                        layout="pair"
                    >
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={onReadClipboard}
                            disabled={!connected || reading}
                        >
                            {reading ? 'Reading…' : 'Read'}
                        </button>
                        <button type="button" class="sheet-button" onClick={onCopy} disabled={received === undefined}>
                            Copy here
                        </button>
                    </SheetRow>
                    {received !== undefined && (
                        <div class="sheet-row stack">
                            <textarea
                                class="sheet-readout actions-clipboard-readout"
                                aria-label="Phone clipboard"
                                value={received}
                                placeholder="The phone clipboard is empty"
                                readOnly
                                rows={3}
                            />
                        </div>
                    )}
                    <SheetRow
                        title="Paste text on the phone"
                        description="Tap a field on the phone, then paste."
                        layout="stack"
                    >
                        <textarea
                            id="device-paste-text"
                            class="sheet-input actions-paste-input"
                            aria-label="Text to paste on the phone"
                            placeholder="Type or paste text…"
                            value={clipboardDraft}
                            rows={3}
                            onInput={(event) => setClipboardDraft(event.currentTarget.value)}
                        />
                        <button
                            type="button"
                            class="sheet-button primary"
                            onClick={onPaste}
                            disabled={!clipboardDraft || draftTooLong || !connected}
                        >
                            Paste
                        </button>
                    </SheetRow>
                </SheetGroup>

                <SheetGroup title="Phone panels">
                    <SheetRow title="Notifications">
                        <button
                            type="button"
                            class="sheet-button"
                            disabled={!connected}
                            onClick={() => send(ControlMessage.TYPE_EXPAND_NOTIFICATION_PANEL)}
                        >
                            Open
                        </button>
                    </SheetRow>
                    <SheetRow title="Quick settings">
                        <button
                            type="button"
                            class="sheet-button"
                            disabled={!connected}
                            onClick={() => send(ControlMessage.TYPE_EXPAND_SETTINGS_PANEL)}
                        >
                            Open
                        </button>
                    </SheetRow>
                    <SheetRow title="Collapse panels">
                        <button
                            type="button"
                            class="sheet-button"
                            disabled={!connected}
                            onClick={() => send(ControlMessage.TYPE_COLLAPSE_PANELS)}
                        >
                            Collapse
                        </button>
                    </SheetRow>
                </SheetGroup>

                <SheetGroup title="Session">
                    <SheetRow title="Stream settings" description="Stream quality and sound capture.">
                        <button
                            type="button"
                            class="sheet-button"
                            aria-label="Open Stream settings"
                            disabled={!session}
                            onClick={() => {
                                if (session) {
                                    closeAllSheets();
                                    openSettingsSheet(session.params.udid);
                                }
                            }}
                        >
                            Open
                        </button>
                    </SheetRow>
                    {lockActive && (
                        <SheetRow title="Unlock device" description="Enter the phone's PIN or password.">
                            <button
                                type="button"
                                class="sheet-button"
                                disabled={!connected}
                                onClick={() => openSheet('unlock')}
                            >
                                Unlock
                            </button>
                        </SheetRow>
                    )}
                </SheetGroup>
            </div>
        </BottomSheet>
    );
}
