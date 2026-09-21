import { useEffect, useState } from 'preact/hooks';
import { BottomSheet } from '../ui/BottomSheet';
import { SheetGroup, SheetRow, SheetStatus, SheetToggleRow, SoundRows } from '../ui/SheetControls';
import { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';
import { deviceClipboard, deviceClipboardError, openSheet, streamConnected, toolsSheetOpen } from '../state/stream';
import { activeAudioSession, audioAvailability } from '../state/audio';
import { goToDeviceList } from '../state/router';
import { findDeviceByUdid } from '../state/devices';
import { ControlCenterCommand } from '../../common/ControlCenterCommand';
import { copyTextToClipboard } from '../ui/copyText';
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
    const [lockNote, setLockNote] = useState('');
    const [reading, setReading] = useState(false);
    const [pending, setPending] = useState<PendingRequest>();
    const [keyboard, setKeyboard] = useState(client.isHandlingKeyboardEvents());
    // Reboot and shut down are disruptive, so each needs a second, explicit press.
    const [confirming, setConfirming] = useState<'reboot' | 'shutdown'>();
    const [power, setPower] = useState('');
    // Held only for the moment it takes to type it through: never persisted anywhere.
    const [passcode, setPasscode] = useState('');
    const [unlocking, setUnlocking] = useState(false);
    const [debugBusy, setDebugBusy] = useState(false);
    const [debugNote, setDebugNote] = useState('');
    const received = deviceClipboard.value;
    const readError = deviceClipboardError.value;
    const connected = streamConnected.value;
    const audioSession = activeAudioSession.value;

    useEffect(() => {
        setClipboardDraft('');
        setScreenNote('');
        setClipboardNote('');
        setLockNote('');
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

    const onCopyHere = async () => {
        if (!received) {
            setClipboardNote(
                received === undefined ? 'Read the phone clipboard first.' : 'The phone clipboard is empty.',
            );
            return;
        }
        setClipboardNote(
            (await copyTextToClipboard(received))
                ? 'Copied to this browser.'
                : 'This browser blocked copying. Select the text above and copy it.',
        );
    };

    const onSendClipboard = () => {
        if (!clipboardDraft) {
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
        if (confirming !== action) {
            setConfirming(action);
            setPower(
                action === 'reboot'
                    ? 'Press Confirm reboot to go ahead. The stream reconnects once the phone is back.'
                    : 'Press Confirm shut down to go ahead. You will have to power the phone on by hand.',
            );
            return;
        }
        setConfirming(undefined);
        const entry = findDeviceByUdid(client.getDeviceUdid());
        if (!entry) {
            setPower('This device is no longer in the device list.');
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

    const onUnlock = async () => {
        setUnlocking(true);
        setLockNote('Unlocking…');
        const accepted = await client.unlockWithPasscode(passcode);
        setUnlocking(false);
        if (!accepted) {
            setLockNote('Enter the numeric passcode (4 to 10 digits).');
            return;
        }
        setPasscode('');
        setLockNote('Passcode sent. If the phone stays locked, it was rebooted and needs one unlock by hand.');
    };

    /** Service-level recovery that does not depend on the stream socket still working. */
    const onServiceCommand = (command: string, label: string, done: string) => {
        const entry = findDeviceByUdid(client.getDeviceUdid());
        if (!entry) {
            setDebugNote('This device is no longer in the device list.');
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

    const phoneSummary = descriptor
        ? `${descriptor.model}, iOS ${descriptor.version}${descriptor.developerMode === false ? '. Developer Mode is off.' : ''}`
        : 'Device details unavailable.';

    return (
        <BottomSheet open={toolsSheetOpen.value} onClose={() => (toolsSheetOpen.value = false)} title="Actions">
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

                <SheetGroup title="Screen">
                    <SheetRow
                        title="Rotate"
                        description="Turns the phone's display. Apps that lock their orientation ignore it."
                        layout="pair"
                    >
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
                    <SheetRow
                        title="Refresh picture"
                        description="Asks the phone for a fresh keyframe. Use it when the picture smears."
                    >
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
                    <SheetRow
                        title="Restart picture"
                        description="Rebuilds the video in the current session. Use it when the picture is frozen or broken."
                    >
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={() => {
                                setScreenNote('Restarting the picture…');
                                client.restartStream();
                            }}
                        >
                            Restart
                        </button>
                    </SheetRow>
                    <SheetRow
                        title="Restart session"
                        description="Reconnects everything. Use it when the picture is fine but touch or the keyboard stopped responding. (The clipboard has its own recovery and does not need this.)"
                    >
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={() => {
                                setScreenNote('Reconnecting to the phone…');
                                client.restartSession();
                            }}
                        >
                            Restart
                        </button>
                    </SheetRow>
                </SheetGroup>
                {screenNote && <SheetStatus>{screenNote}</SheetStatus>}

                <SheetGroup title="Keyboard">
                    <SheetRow
                        title="Type text"
                        description="Opens a field here and types each character on the phone as you enter it, so it works from a phone browser too."
                    >
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
                        title="Send this computer's keystrokes"
                        description="Keys pressed on this page reach the phone as a hardware keyboard. Turn it off to type in the browser normally."
                        checked={keyboard}
                        onChange={onKeyboardToggle}
                    />
                </SheetGroup>

                <SheetGroup title="Lock screen">
                    <SheetRow
                        title="Unlock with passcode"
                        description="Typed on the phone's keypad and not saved. Works once the phone has been unlocked by hand since it last rebooted."
                        layout="stack"
                    >
                        <input
                            class="sheet-input"
                            type="password"
                            inputMode="numeric"
                            autoComplete="off"
                            placeholder="Passcode"
                            aria-label="Device passcode"
                            value={passcode}
                            onInput={(event) => setPasscode(event.currentTarget.value)}
                        />
                        <button
                            type="button"
                            class="sheet-button"
                            onClick={onUnlock}
                            disabled={!connected || !passcode || unlocking}
                        >
                            {unlocking ? 'Unlocking…' : 'Unlock'}
                        </button>
                    </SheetRow>
                </SheetGroup>
                {lockNote && <SheetStatus>{lockNote}</SheetStatus>}

                <SheetGroup title="Clipboard">
                    <SheetRow
                        title="Read the phone's clipboard"
                        description="Shows what the phone last copied. Copy here puts it on this browser's clipboard."
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
                                aria-label="Device clipboard"
                                value={received}
                                placeholder="The phone clipboard is empty"
                                readOnly
                                rows={3}
                            />
                        </div>
                    )}
                    <SheetRow
                        title="Send text to the phone"
                        description="Lands on the phone's clipboard. Long-press a field on the phone and choose Paste."
                        layout="stack"
                    >
                        <textarea
                            id="ios-clipboard-text"
                            class="sheet-input actions-paste-input"
                            aria-label="Text for the device clipboard"
                            placeholder="Type or paste your text here…"
                            value={clipboardDraft}
                            rows={3}
                            onInput={(event) => setClipboardDraft(event.currentTarget.value)}
                        />
                        <button
                            type="button"
                            class="sheet-button primary"
                            onClick={onSendClipboard}
                            disabled={!connected || !clipboardDraft || pending?.kind === 'clipboard'}
                        >
                            Send to phone
                        </button>
                    </SheetRow>
                </SheetGroup>
                {clipboardNote && <SheetStatus>{clipboardNote}</SheetStatus>}

                <SheetGroup title="Phone" hint={phoneSummary}>
                    <SheetRow
                        title="Reboot"
                        description="Takes about a minute; the stream reconnects on its own. A phone with a passcode must be unlocked by hand before it reappears."
                    >
                        <button
                            type="button"
                            class={`sheet-button ${confirming === 'reboot' ? 'danger' : ''}`}
                            onClick={() => onPower('reboot')}
                        >
                            {confirming === 'reboot' ? 'Confirm reboot' : 'Reboot'}
                        </button>
                    </SheetRow>
                    <SheetRow title="Shut down" description="You will have to power the phone on by hand.">
                        <button
                            type="button"
                            class={`sheet-button ${confirming === 'shutdown' ? 'danger' : ''}`}
                            onClick={() => onPower('shutdown')}
                        >
                            {confirming === 'shutdown' ? 'Confirm shut down' : 'Shut down'}
                        </button>
                    </SheetRow>
                </SheetGroup>
                {power && <SheetStatus tone={confirming ? 'warning' : 'neutral'}>{power}</SheetStatus>}

                <details class="sheet-details">
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
                        description="Starts a fresh helper process on the server. Fixes touch, keyboard or clipboard that stopped responding."
                    >
                        <button
                            type="button"
                            class="sheet-button"
                            disabled={debugBusy}
                            onClick={() =>
                                onServiceCommand(
                                    ControlCenterCommand.RESTART_SESSION,
                                    'Restarting services',
                                    'Services restarted. Open the screen again.',
                                )
                            }
                        >
                            Restart
                        </button>
                    </SheetRow>
                    <SheetRow
                        title="Remount developer image"
                        description="Reloads the image the screen and touch services live in. Use it when the screen will not start at all."
                    >
                        <button
                            type="button"
                            class="sheet-button"
                            disabled={debugBusy}
                            onClick={() =>
                                onServiceCommand(
                                    ControlCenterCommand.REMOUNT_DDI,
                                    'Remounting the developer image',
                                    'Developer image mounted. Open the screen again.',
                                )
                            }
                        >
                            Remount
                        </button>
                    </SheetRow>
                    <SheetRow
                        title="Refresh info"
                        description="Reads the phone's pairing and Developer Mode state again."
                    >
                        <button
                            type="button"
                            class="sheet-button"
                            disabled={debugBusy}
                            onClick={() =>
                                onServiceCommand(
                                    ControlCenterCommand.REFRESH_DEVICE,
                                    'Refreshing',
                                    'Device info refreshed.',
                                )
                            }
                        >
                            Refresh
                        </button>
                    </SheetRow>
                    {debugNote && <SheetStatus>{debugNote}</SheetStatus>}
                </details>

                <div class="sheet-footer">
                    <button type="button" class="sheet-button" onClick={goToDeviceList}>
                        Back to devices
                    </button>
                </div>
            </div>
        </BottomSheet>
    );
}
