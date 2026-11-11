import { AnimatedDetails } from '../ui/AnimatedDetails';
import { useEffect, useState } from 'preact/hooks';
import { BottomSheet } from '../ui/BottomSheet';
import { SheetGroup, SheetRow, SheetStatus, SheetToggleRow, SoundRows } from '../ui/SheetControls';
import { ConfirmPrompt, useArmedAction } from '../ui/ConfirmAction';
import { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';
import { deviceClipboard, deviceClipboardError, openSheet, streamConnected, toolsSheetOpen } from '../state/stream';
import { activeAudioSession, audioAvailability } from '../state/audio';
import { goToDeviceList } from '../state/router';
import { deviceName, findDeviceByUdid } from '../state/devices';
import { ControlCenterCommand } from '../../common/ControlCenterCommand';
import { copyPhoneClipboardHere } from '../ui/copyText';
import { CLIPBOARD_TOO_LONG_NOTE, clipboardTextTooLong } from '../ui/clipboardLimit';
import ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import '../../style/views/ActionsSheet.css';

interface ApplActionsSheetProps {
    client: StreamClientCoreDevice;
    descriptor?: ApplDeviceDescriptor;
}

type PendingRequest = { id: number; kind: 'rotate' | 'clipboard' };

// When the phone's clipboard service wedges the server restarts it and asks again, which takes
// about ten seconds all told; these bracket that rather than the happy path's ~50 ms.
const CLIPBOARD_RECOVERY_NOTE_MS = 9000;
const CLIPBOARD_GIVE_UP_MS = 25000;

/** The iOS "Actions" sheet: sound, screen recovery, keyboard, lock screen, clipboard, power. */
export function ApplActionsSheet({ client, descriptor }: ApplActionsSheetProps) {
    const [clipboardDraft, setClipboardDraft] = useState('');
    const [screenNote, setScreenNote] = useState('');
    const [clipboardNote, setClipboardNote] = useState('');
    const [reading, setReading] = useState(false);
    const [pending, setPending] = useState<PendingRequest>();
    const [keyboard, setKeyboard] = useState(client.isHandlingKeyboardEvents());
    // Reboot and shut down are hard to undo from here, and the two service actions end the phone
    // session for every viewer, so each is confirmed in a separate prompt. The armed state ends
    // when the sheet closes, so reopening never shows a waiting confirm.
    const confirm = useArmedAction<'reboot' | 'shutdown' | 'restart' | 'remount'>(toolsSheetOpen.value);
    const [power, setPower] = useState('');
    const [debugBusy, setDebugBusy] = useState(false);
    const [debugNote, setDebugNote] = useState('');
    const received = deviceClipboard.value;
    const draftTooLong = clipboardTextTooLong(clipboardDraft);
    const readError = deviceClipboardError.value;
    const connected = streamConnected.value;
    const audioSession = activeAudioSession.value;

    useEffect(() => {
        setClipboardDraft('');
        setScreenNote('');
        setClipboardNote('');
        setReading(false);
        setKeyboard(client.isHandlingKeyboardEvents());
        const onResult = (result: { id: number; ok: boolean; error?: string; data?: unknown }) => {
            setPending((current) => {
                if (current?.id !== result.id) {
                    return current;
                }
                const note = result.ok ? 'Done.' : result.error || 'The phone refused that action.';
                if (current.kind === 'rotate') {
                    setScreenNote(note);
                } else {
                    setClipboardNote(result.ok ? 'Sent. Long-press a field on the phone and choose Paste.' : note);
                }
                return undefined;
            });
        };
        client.on('result', onResult);
        return () => client.off('result', onResult);
    }, [client]);

    useEffect(() => {
        if (!reading) {
            return;
        }
        if (readError) {
            setReading(false);
            setClipboardNote(readError);
            return;
        }
        if (received !== undefined) {
            setReading(false);
            setClipboardNote(received ? 'Read from the phone.' : 'The phone clipboard is empty.');
            return;
        }
        // A phone whose clipboard service has stopped answering costs the server one timeout, a
        // restart of that service and one more try -- around ten seconds, at the end of which the
        // read usually just works. Say what is happening instead of sitting on "Reading…", and
        // only give up well past the point where the server would have answered either way.
        const slow = setTimeout(
            () => setClipboardNote('The phone stopped answering. Restarting its clipboard service and trying again…'),
            CLIPBOARD_RECOVERY_NOTE_MS,
        );
        const timeout = setTimeout(() => {
            setReading(false);
            setClipboardNote('No answer from the phone. Check that it is still connected.');
        }, CLIPBOARD_GIVE_UP_MS);
        return () => {
            clearTimeout(slow);
            clearTimeout(timeout);
        };
    }, [reading, received, readError]);

    const onReadClipboard = () => {
        setReading(true);
        setClipboardNote('Reading the phone clipboard…');
        client.requestClipboard();
    };

    const onCopyHere = async () => setClipboardNote(await copyPhoneClipboardHere(received));

    const onSendClipboard = () => {
        if (!clipboardDraft || draftTooLong) {
            return;
        }
        setClipboardNote('Sending to the phone clipboard…');
        setPending({ id: client.setClipboard(clipboardDraft), kind: 'clipboard' });
    };

    const onRotate = (direction: 'left' | 'right') => {
        setScreenNote('Rotating…');
        setPending({ id: client.rotate(direction), kind: 'rotate' });
    };

    const onPower = (action: 'reboot' | 'shutdown') => {
        const entry = findDeviceByUdid(client.getDeviceUdid());
        if (!entry) {
            setPower('This phone is no longer in the device list.');
            return;
        }
        const command = action === 'reboot' ? ControlCenterCommand.REBOOT_DEVICE : ControlCenterCommand.SHUTDOWN_DEVICE;
        const onReply = (data: { udid?: string; error?: string }) => {
            if (data.udid !== client.getDeviceUdid()) {
                return;
            }
            entry.tracker.off(command as never, onReply as never);
            setPower(data.error ? data.error : action === 'reboot' ? 'Rebooting…' : 'Shutting down…');
        };
        entry.tracker.on(command as never, onReply as never);
        entry.tracker.sendCommand(command, { udid: client.getDeviceUdid() });
        setPower(action === 'reboot' ? 'Asking the phone to reboot…' : 'Asking the phone to shut down…');
    };

    /** Service-level recovery that does not depend on the stream socket still working. */
    const onServiceCommand = (command: string, label: string, done: string) => {
        const entry = findDeviceByUdid(client.getDeviceUdid());
        if (!entry) {
            setDebugNote('This phone is no longer in the device list.');
            return;
        }
        setDebugBusy(true);
        setDebugNote(`${label}…`);
        const onReply = (data: { udid?: string; error?: string; result?: unknown }) => {
            if (data.udid !== client.getDeviceUdid()) {
                return;
            }
            entry.tracker.off(command as never, onReply as never);
            setDebugBusy(false);
            setDebugNote(data.error || (typeof data.result === 'string' && data.result) || done);
        };
        entry.tracker.on(command as never, onReply as never);
        entry.tracker.sendCommand(command, { udid: client.getDeviceUdid() });
    };

    const onKeyboardToggle = (next: boolean) => {
        client.setHandleKeyboardEvents(next);
        setKeyboard(next);
    };

    const phoneEntry = findDeviceByUdid(client.getDeviceUdid());
    const phoneName = phoneEntry ? deviceName(phoneEntry) : descriptor?.name || descriptor?.model || 'this iPhone';
    const phoneSummary = descriptor
        ? `${descriptor.model}, iOS ${descriptor.version}${descriptor.developerMode === false ? '. Developer Mode is off.' : ''}`
        : 'Phone details unavailable.';

    return (
        <BottomSheet
            open={toolsSheetOpen.value}
            onClose={() => (toolsSheetOpen.value = false)}
            title="Actions"
            subtitle={phoneEntry || descriptor ? phoneName : undefined}
        >
            <div class="actions-sheet">
                {!connected && (
                    <SheetStatus tone="warning">
                        Reconnecting to the phone. Actions that need the stream are paused until it is back.
                    </SheetStatus>
                )}

                <SheetGroup title="Sound">
                    {audioSession ? (
                        <SoundRows session={audioSession} />
                    ) : (
                        <SheetRow title="Listen in this browser" description={audioAvailability.value.message} />
                    )}
                </SheetGroup>

                <SheetGroup title="Screen" status={screenNote && <SheetStatus>{screenNote}</SheetStatus>}>
                    <SheetRow title="Rotate" description="Apps with a fixed orientation may ignore this." layout="pair">
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={() => onRotate('left')}
                            disabled={!connected}
                        >
                            Left
                        </button>
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={() => onRotate('right')}
                            disabled={!connected}
                        >
                            Right
                        </button>
                    </SheetRow>
                    <SheetRow title="Refresh picture" description="Refresh a smeared picture.">
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={() => {
                                setScreenNote('Asked for a new keyframe.');
                                client.requestKeyframe();
                            }}
                            disabled={!connected}
                        >
                            Refresh
                        </button>
                    </SheetRow>
                    <SheetRow title="Restart video" description="For frozen or broken video.">
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={() => {
                                setScreenNote('Restarting the video…');
                                client.restartStream();
                            }}
                        >
                            Restart video
                        </button>
                    </SheetRow>
                    <SheetRow title="Reconnect" description="Reconnect video, touch and keyboard.">
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={() => {
                                setScreenNote('Reconnecting to the phone…');
                                client.restartSession();
                            }}
                        >
                            Reconnect
                        </button>
                    </SheetRow>
                </SheetGroup>

                <SheetGroup title="Keyboard">
                    <SheetRow title="Type text">
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={() => openSheet('liveText')}
                            disabled={!connected}
                        >
                            Open
                        </button>
                    </SheetRow>
                    <SheetToggleRow
                        title="Send keystrokes"
                        description="Keys typed in this browser go to the phone."
                        checked={keyboard}
                        onChange={onKeyboardToggle}
                    />
                </SheetGroup>

                <SheetGroup title="Lock screen">
                    <SheetRow title="Unlock device" description="Uses the passcode stored on the server.">
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={() => openSheet('unlock')}
                            disabled={!connected}
                        >
                            Unlock
                        </button>
                    </SheetRow>
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
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={onCopyHere}
                            disabled={received === undefined}
                        >
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
                        title="Send text to the phone"
                        description="Copy to the phone, then paste in a field."
                        layout="stack"
                    >
                        <textarea
                            id="ios-clipboard-text"
                            class="sheet-input actions-paste-input"
                            aria-label="Text for the phone clipboard"
                            placeholder="Type or paste text…"
                            value={clipboardDraft}
                            rows={3}
                            onInput={(event) => setClipboardDraft(event.currentTarget.value)}
                        />
                        <button
                            type="button"
                            class="sheet-button primary"
                            onClick={onSendClipboard}
                            disabled={!connected || !clipboardDraft || draftTooLong || pending?.kind === 'clipboard'}
                        >
                            Send to phone
                        </button>
                    </SheetRow>
                </SheetGroup>

                <SheetGroup title="Phone" hint={phoneSummary} status={power && <SheetStatus>{power}</SheetStatus>}>
                    <SheetRow
                        title="Reboot"
                        description="Reconnects after restarting. If a passcode is set, unlock on the phone."
                    >
                        <button
                            type="button"
                            class="sheet-button danger"
                            onClick={(event) => {
                                setPower('');
                                confirm.arm('reboot', event.currentTarget);
                            }}
                        >
                            Reboot
                        </button>
                    </SheetRow>
                    <SheetRow title="Shut down" description="Power it on using the phone’s button.">
                        <button
                            type="button"
                            class="sheet-button danger"
                            onClick={(event) => {
                                setPower('');
                                confirm.arm('shutdown', event.currentTarget);
                            }}
                        >
                            Shut down
                        </button>
                    </SheetRow>
                </SheetGroup>
                {confirm.armed === 'reboot' && (
                    <ConfirmPrompt
                        action={confirm}
                        question={`Reboot ${phoneName}?`}
                        consequence="It reconnects after restarting. If a passcode is set, it has to be entered on the phone."
                        confirmLabel="Reboot"
                        danger
                        onConfirm={() => onPower('reboot')}
                    />
                )}
                {confirm.armed === 'shutdown' && (
                    <ConfirmPrompt
                        action={confirm}
                        question={`Shut down ${phoneName}?`}
                        consequence="You cannot turn it back on from here."
                        confirmLabel="Shut down"
                        danger
                        onConfirm={() => onPower('shutdown')}
                    />
                )}

                <AnimatedDetails class="sheet-details">
                    <summary>
                        Troubleshooting<span>services and diagnostics</span>
                    </summary>
                    <dl class="sheet-facts device-debug-facts">
                        <dt>Decoder</dt>
                        <dd>{client.getDecoderKind() ?? 'none yet'}</dd>
                        <dt>Session</dt>
                        <dd>{descriptor?.session ?? 'unknown'}</dd>
                        <dt>Connection</dt>
                        <dd>{connected ? 'connected' : 'disconnected'}</dd>
                        <dt>Screen</dt>
                        <dd>{descriptor?.['screen.power'] ?? 'unknown'}</dd>
                        <dt>Lock</dt>
                        <dd>
                            {descriptor?.['device.locked'] === true
                                ? 'locked'
                                : descriptor?.['device.locked'] === false
                                  ? 'unlocked'
                                  : 'unknown'}
                        </dd>
                    </dl>
                    <SheetRow
                        title="Restart services"
                        description="Use if touch, keyboard or clipboard stop responding. Ends the phone session for every viewer."
                    >
                        <button
                            type="button"
                            class="sheet-button danger"
                            disabled={debugBusy}
                            onClick={(event) => confirm.arm('restart', event.currentTarget)}
                        >
                            Restart services
                        </button>
                    </SheetRow>
                    <SheetRow
                        title="Remount developer image"
                        description="Use if the screen will not start. Ends the phone session first."
                    >
                        <button
                            type="button"
                            class="sheet-button danger"
                            aria-label="Remount developer image"
                            disabled={debugBusy}
                            onClick={(event) => confirm.arm('remount', event.currentTarget)}
                        >
                            Remount
                        </button>
                    </SheetRow>
                    <SheetRow title="Refresh info" description="Check pairing and Developer Mode.">
                        <button
                            type="button"
                            class="sheet-button"
                            disabled={debugBusy}
                            onClick={() =>
                                onServiceCommand(
                                    ControlCenterCommand.REFRESH_DEVICE,
                                    'Refreshing',
                                    'Phone info refreshed.',
                                )
                            }
                        >
                            Refresh
                        </button>
                    </SheetRow>
                    {confirm.armed === 'restart' && (
                        <ConfirmPrompt
                            action={confirm}
                            question={`Restart services on ${phoneName}?`}
                            consequence="The phone session ends for every viewer. The next viewer gets a new one."
                            confirmLabel="Restart services"
                            danger
                            onConfirm={() =>
                                onServiceCommand(
                                    ControlCenterCommand.RESTART_SESSION,
                                    'Restarting services',
                                    'Services restarted. Open the screen again.',
                                )
                            }
                        />
                    )}
                    {confirm.armed === 'remount' && (
                        <ConfirmPrompt
                            action={confirm}
                            question={`Remount the developer image on ${phoneName}?`}
                            consequence="The phone session ends for every viewer while the image is reloaded."
                            confirmLabel="Remount"
                            danger
                            onConfirm={() =>
                                onServiceCommand(
                                    ControlCenterCommand.REMOUNT_DDI,
                                    'Remounting the developer image',
                                    'Developer image mounted. Open the screen again.',
                                )
                            }
                        />
                    )}
                    {debugNote && <SheetStatus>{debugNote}</SheetStatus>}
                </AnimatedDetails>

                <div class="sheet-footer">
                    <button type="button" class="sheet-button" onClick={goToDeviceList}>
                        Back to devices
                    </button>
                </div>
            </div>
        </BottomSheet>
    );
}
