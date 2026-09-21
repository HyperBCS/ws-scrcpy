import { useEffect, useState } from 'preact/hooks';
import { BottomSheet } from '../ui/BottomSheet';
import { SheetGroup, SheetRow, SheetStatus } from '../ui/SheetControls';
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
import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { goToDeviceList } from '../state/router';
import { ControlMessage } from '../controlMessage/ControlMessage';
import { CommandControlMessage, CopyKey } from '../controlMessage/CommandControlMessage';
import '../../style/views/ActionsSheet.css';

interface ActionsSheetProps {
    client: StreamClientScrcpy;
}

export function ActionsSheet({ client }: ActionsSheetProps) {
    const [clipboardDraft, setClipboardDraft] = useState('');
    const [clipboardNote, setClipboardNote] = useState('');
    const [reading, setReading] = useState(false);
    const [copying, setCopying] = useState(false);
    const received = deviceClipboard.value;
    const connected = streamConnected.value;
    const session = activeStream.value;
    const entry = session ? findDeviceForStream(session.params) : undefined;
    const descriptor = entry?.params.type === 'android' ? (entry.descriptor as GoogDeviceDescriptor) : undefined;
    const lockActive = descriptor?.['device.locked'] === true || descriptor?.['keyguard.showing'] === true;

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
            setClipboardNote(received ? 'Read from the device.' : 'The device clipboard is empty.');
            return;
        }
        const timeout = setTimeout(() => {
            setReading(false);
            setClipboardNote('No clipboard response yet. Unlock the device and try again.');
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
        setClipboardNote('Reading the device clipboard…');
        client.sendMessage(CommandControlMessage.createGetClipboardCommand(CopyKey.NONE));
    };

    const onCopy = async () => {
        if (received === undefined) {
            return;
        }
        if (!navigator.clipboard?.writeText) {
            setClipboardNote('Select the clipboard text above and copy it. Browser clipboard access needs HTTPS.');
            return;
        }
        setCopying(true);
        try {
            await navigator.clipboard.writeText(received);
            setClipboardNote('Copied to this browser.');
        } catch {
            setClipboardNote('This browser declined clipboard access. Select the text above and copy it.');
        } finally {
            setCopying(false);
        }
    };

    const onPaste = () => {
        if (clipboardDraft && streamConnected.value) {
            client.sendMessage(CommandControlMessage.createSetClipboardCommand(clipboardDraft, true));
            setClipboardNote('Pasted into the focused field on the device.');
        }
    };

    return (
        <BottomSheet open={toolsSheetOpen.value} onClose={() => (toolsSheetOpen.value = false)} title="Actions">
            <div class="actions-sheet">
                {!connected && (
                    <SheetStatus tone="warning">
                        Reconnecting. Actions that need the stream are paused until it is back.
                    </SheetStatus>
                )}

                <SheetGroup title="Clipboard">
                    <SheetRow
                        title="Read the device's clipboard"
                        description="Shows what the device last copied. Copy here puts it on this browser's clipboard."
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
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={onCopy}
                            disabled={received === undefined || copying}
                        >
                            {copying ? 'Copying…' : 'Copy here'}
                        </button>
                    </SheetRow>
                    {received !== undefined && (
                        <div class="sheet-row stack">
                            <textarea
                                class="sheet-readout actions-clipboard-readout"
                                aria-label="Device clipboard"
                                value={received}
                                placeholder="The device clipboard is empty"
                                readOnly
                                rows={3}
                            />
                        </div>
                    )}
                    <SheetRow
                        title="Paste text on the device"
                        description="Tap a field on the device first. The text is pasted there straight away."
                        layout="stack"
                    >
                        <textarea
                            id="device-paste-text"
                            class="sheet-input actions-paste-input"
                            aria-label="Text to paste on device"
                            placeholder="Type or paste your text here…"
                            value={clipboardDraft}
                            rows={3}
                            onInput={(event) => setClipboardDraft(event.currentTarget.value)}
                        />
                        <button
                            type="button"
                            class="sheet-button primary"
                            onClick={onPaste}
                            disabled={!clipboardDraft || !connected}
                        >
                            Paste
                        </button>
                    </SheetRow>
                </SheetGroup>
                {clipboardNote && <SheetStatus>{clipboardNote}</SheetStatus>}

                <SheetGroup title="Device panels">
                    <SheetRow title="Notifications" description="Pulls the notification shade down.">
                        <button
                            type="button"
                            class="sheet-button"
                            disabled={!connected}
                            onClick={() => send(ControlMessage.TYPE_EXPAND_NOTIFICATION_PANEL)}
                        >
                            Open
                        </button>
                    </SheetRow>
                    <SheetRow title="Quick settings" description="Opens the quick settings tiles.">
                        <button
                            type="button"
                            class="sheet-button"
                            disabled={!connected}
                            onClick={() => send(ControlMessage.TYPE_EXPAND_SETTINGS_PANEL)}
                        >
                            Open
                        </button>
                    </SheetRow>
                    <SheetRow title="Collapse panels" description="Closes whichever panel is open.">
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
                    <SheetRow
                        title="Sound and stream quality"
                        description="Listen in this browser, set the volume, and change capture quality for every viewer."
                    >
                        <button
                            type="button"
                            class="sheet-button"
                            disabled={!session}
                            onClick={() => {
                                if (session) {
                                    closeAllSheets();
                                    openSettingsSheet(session.params.udid);
                                }
                            }}
                        >
                            Open Settings
                        </button>
                    </SheetRow>
                    {lockActive && (
                        <SheetRow
                            title="Unlock device"
                            description="The device is locked. Enter its PIN or password from here."
                        >
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
                    <SheetRow
                        title="Disconnect"
                        description="Returns to your devices. Other viewers keep their stream; file uploads live under Files."
                    >
                        <button type="button" class="sheet-button danger" onClick={goToDeviceList}>
                            Disconnect
                        </button>
                    </SheetRow>
                </SheetGroup>
            </div>
        </BottomSheet>
    );
}
