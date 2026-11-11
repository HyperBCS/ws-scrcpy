import { Disclosure } from '../ui/AnimatedDetails';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { TextAreaField } from '../ui/Field';
import { Sheet } from '../ui/Sheet';
import { SheetGroup, SheetRow, SheetStatus, SheetToggleRow, SoundRows } from '../ui/SheetControls';
import { ConfirmPrompt, useArmedAction } from '../ui/ConfirmAction';
import { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';
import {
    closeAllSheets,
    deviceClipboard,
    deviceClipboardError,
    openSheet,
    streamConnected,
    toolsSheetOpen,
} from '../state/stream';
import { openApplSettingsSheet } from '../state/settingsSheet';
import { replyText, sendServiceCommand, TrackerCommandAborted } from '../client/trackerCommand';
import { activeAudioSession, audioAvailability } from '../state/audio';
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

type RequestKind = 'rotate' | 'clipboard' | 'restart';
type RequestResult = { id: number; ok: boolean; error?: string; data?: unknown };

// When the phone's clipboard service wedges the server restarts it and asks again, which takes
// about ten seconds all told; these bracket that rather than the happy path's ~50 ms.
const CLIPBOARD_RECOVERY_NOTE_MS = 9000;
const CLIPBOARD_GIVE_UP_MS = 25000;
// A request over the stream socket is answered on that socket. The server's own limit for one
// request to the phone is 15 s; past these the answer is not coming.
const REQUEST_GIVE_UP_MS: Record<RequestKind, number> = {
    rotate: 20000,
    restart: 20000,
    clipboard: CLIPBOARD_GIVE_UP_MS,
};
const NO_ANSWER_NOTE = 'No answer from the phone. Check that it is still connected.';
const NOT_SENT_NOTE = 'Not connected to the phone. Try again once the stream is back.';

/** The iOS "Actions" sheet: sound, screen recovery, keyboard, lock screen, clipboard, power. */
export function ApplActionsSheet({ client, descriptor }: ApplActionsSheetProps) {
    const [clipboardDraft, setClipboardDraft] = useState('');
    const [screenNote, setScreenNote] = useState('');
    const [clipboardNote, setClipboardNote] = useState('');
    const [reading, setReading] = useState(false);
    // Requests waiting for a `result` on the stream socket, by id. Each has a time limit, and all
    // of them end when the socket drops: the answer to a request sent on the old socket is gone.
    const requests = useRef(new Map<number, { kind: RequestKind; timer: ReturnType<typeof setTimeout> }>());
    const [sendingClipboard, setSendingClipboard] = useState(false);
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
        setSendingClipboard(false);
        setKeyboard(client.isHandlingKeyboardEvents());
        const onResult = (result: RequestResult) => settleRequest(result.id, result);
        client.on('result', onResult);
        return () => {
            client.off('result', onResult);
            endRequests();
        };
    }, [client]);

    /** Shows the outcome of one request where its button is, and forgets the request. */
    const settleRequest = (id: number, result: { ok: boolean; error?: string }) => {
        const request = requests.current.get(id);
        if (!request) {
            return;
        }
        clearTimeout(request.timer);
        requests.current.delete(id);
        const failure = result.error || 'The phone refused that action.';
        if (request.kind === 'clipboard') {
            setSendingClipboard(false);
            setClipboardNote(result.ok ? 'Sent. Long-press a field on the phone and choose Paste.' : failure);
        } else if (request.kind === 'restart') {
            setScreenNote(result.ok ? 'The video was restarted.' : failure);
        } else {
            setScreenNote(result.ok ? 'Done.' : failure);
        }
    };

    /** `id` is undefined when the stream socket was closed and nothing was sent. */
    const trackRequest = (id: number | undefined, kind: RequestKind) => {
        if (id === undefined) {
            if (kind === 'clipboard') {
                setClipboardNote(NOT_SENT_NOTE);
            } else {
                setScreenNote(NOT_SENT_NOTE);
            }
            return;
        }
        if (kind === 'clipboard') {
            setSendingClipboard(true);
        }
        const timer = setTimeout(
            () => settleRequest(id, { ok: false, error: NO_ANSWER_NOTE }),
            REQUEST_GIVE_UP_MS[kind],
        );
        requests.current.set(id, { kind, timer });
    };

    const endRequests = (error?: string) => {
        for (const id of Array.from(requests.current.keys())) {
            if (error) {
                settleRequest(id, { ok: false, error });
            } else {
                clearTimeout(requests.current.get(id)?.timer);
                requests.current.delete(id);
            }
        }
    };

    useEffect(() => {
        if (!connected) {
            endRequests('The connection dropped before the phone answered. Try again once the stream is back.');
        }
    }, [connected]);

    // Tracker commands (power, service recovery) end with a reply, an error, a closed socket or a
    // time limit. Closing the stream page withdraws them.
    const leaving = useRef<AbortController>();
    useEffect(() => {
        const controller = new AbortController();
        leaving.current = controller;
        return () => controller.abort();
    }, []);

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
        trackRequest(client.setClipboard(clipboardDraft), 'clipboard');
    };

    const onRotate = (direction: 'left' | 'right') => {
        setScreenNote('Rotating…');
        trackRequest(client.rotate(direction), 'rotate');
    };

    const onRestartVideo = () => {
        setScreenNote('Restarting the video…');
        trackRequest(client.restartStream(), 'restart');
    };

    const onPower = (action: 'reboot' | 'shutdown') => {
        const entry = findDeviceByUdid(client.getDeviceUdid());
        if (!entry) {
            setPower('This phone is no longer in the device list.');
            return;
        }
        const command = action === 'reboot' ? ControlCenterCommand.REBOOT_DEVICE : ControlCenterCommand.SHUTDOWN_DEVICE;
        setPower(action === 'reboot' ? 'Asking the phone to reboot…' : 'Asking the phone to shut down…');
        sendServiceCommand(entry.tracker, command, client.getDeviceUdid(), leaving.current?.signal).then(
            () => setPower(action === 'reboot' ? 'Rebooting…' : 'Shutting down…'),
            (error: Error) => {
                if (!(error instanceof TrackerCommandAborted)) {
                    setPower(error.message);
                }
            },
        );
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
        sendServiceCommand(entry.tracker, command, client.getDeviceUdid(), leaving.current?.signal).then(
            (result) => {
                setDebugBusy(false);
                setDebugNote(replyText(result, done));
            },
            (error: Error) => {
                if (!(error instanceof TrackerCommandAborted)) {
                    setDebugBusy(false);
                    setDebugNote(error.message);
                }
            },
        );
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
        <Sheet
            open={toolsSheetOpen.value}
            onClose={() => (toolsSheetOpen.value = false)}
            title="Actions"
            subtitle={phoneEntry || descriptor ? phoneName : undefined}
        >
            <div class="actions-sheet">
                {!connected && (
                    <Banner>
                        {client.getDecoderProblem()
                            ? 'This browser cannot show the phone’s video. Actions that need the stream are off.'
                            : 'Reconnecting to the phone. Actions that need the stream are paused until it is back.'}
                    </Banner>
                )}

                <SheetGroup kit title="Sound">
                    {audioSession ? (
                        <SoundRows kit session={audioSession} />
                    ) : (
                        <SheetRow kit title="Listen in this browser" description={audioAvailability.value.message} />
                    )}
                </SheetGroup>

                <SheetGroup kit title="Screen" status={screenNote && <SheetStatus kit>{screenNote}</SheetStatus>}>
                    <SheetRow
                        kit
                        title="Rotate"
                        description="Apps with a fixed orientation may ignore this."
                        layout="pair"
                    >
                        <Button size="compact" onClick={() => onRotate('left')} disabled={!connected}>
                            Left
                        </Button>
                        <Button size="compact" onClick={() => onRotate('right')} disabled={!connected}>
                            Right
                        </Button>
                    </SheetRow>
                    <SheetRow kit title="Refresh picture" description="Refresh a smeared picture.">
                        <Button
                            size="compact"
                            onClick={() => {
                                setScreenNote('Asked for a new keyframe.');
                                client.requestKeyframe();
                            }}
                            disabled={!connected}
                        >
                            Refresh
                        </Button>
                    </SheetRow>
                    <SheetRow kit title="Restart video" description="For frozen or broken video.">
                        <Button size="compact" onClick={onRestartVideo}>
                            Restart video
                        </Button>
                    </SheetRow>
                    <SheetRow kit title="Reconnect" description="Reconnect video, touch and keyboard.">
                        <Button
                            size="compact"
                            onClick={() => {
                                setScreenNote('Reconnecting to the phone…');
                                client.restartSession();
                            }}
                        >
                            Reconnect
                        </Button>
                    </SheetRow>
                </SheetGroup>

                <SheetGroup kit title="Keyboard">
                    <SheetRow kit title="Type text">
                        <Button size="compact" onClick={() => openSheet('liveText')} disabled={!connected}>
                            Open
                        </Button>
                    </SheetRow>
                    <SheetToggleRow
                        kit
                        title="Send keystrokes"
                        description="Keys typed in this browser go to the phone."
                        checked={keyboard}
                        onChange={onKeyboardToggle}
                    />
                </SheetGroup>

                <SheetGroup kit title="Lock screen">
                    <SheetRow kit title="Unlock device" description="Uses the passcode stored on the server.">
                        <Button size="compact" onClick={() => openSheet('unlock')} disabled={!connected}>
                            Unlock
                        </Button>
                    </SheetRow>
                </SheetGroup>

                <SheetGroup kit title="iPhone settings">
                    <SheetRow
                        kit
                        title="Scheduled unlock"
                        description="The two daily unlocks, the passcode and the last run."
                    >
                        <Button
                            size="compact"
                            attributes={{ 'aria-label': 'Open Scheduled unlock' }}
                            onClick={() => {
                                closeAllSheets();
                                openApplSettingsSheet(client.getDeviceUdid());
                            }}
                        >
                            Open
                        </Button>
                    </SheetRow>
                </SheetGroup>

                <SheetGroup
                    kit
                    title="Clipboard"
                    status={
                        draftTooLong ? (
                            <SheetStatus kit tone="error">
                                {CLIPBOARD_TOO_LONG_NOTE}
                            </SheetStatus>
                        ) : (
                            clipboardNote && <SheetStatus kit>{clipboardNote}</SheetStatus>
                        )
                    }
                >
                    <SheetRow
                        kit
                        title="Read the phone's clipboard"
                        description="Copy from the phone to this browser."
                        layout="pair"
                    >
                        <Button size="compact" onClick={onReadClipboard} disabled={!connected || reading}>
                            {reading ? 'Reading…' : 'Read'}
                        </Button>
                        <Button size="compact" onClick={onCopyHere} disabled={received === undefined}>
                            Copy here
                        </Button>
                    </SheetRow>
                    {received !== undefined && (
                        <div class="kit-row kit-row-stack">
                            <TextAreaField
                                label="Phone clipboard"
                                labelHidden
                                value={received}
                                placeholder="The phone clipboard is empty"
                                readOnly
                                rows={3}
                            />
                        </div>
                    )}
                    <SheetRow
                        kit
                        title="Send text to the phone"
                        description="Copy to the phone, then paste in a field."
                        layout="stack"
                    >
                        <TextAreaField
                            label="Text for the phone clipboard"
                            labelHidden
                            placeholder="Type or paste text…"
                            value={clipboardDraft}
                            rows={3}
                            onInput={(event) => setClipboardDraft(event.currentTarget.value)}
                        />
                        <Button
                            onClick={onSendClipboard}
                            disabled={!connected || !clipboardDraft || draftTooLong || sendingClipboard}
                        >
                            Send to phone
                        </Button>
                    </SheetRow>
                </SheetGroup>

                <SheetGroup
                    kit
                    title="Phone"
                    hint={phoneSummary}
                    status={power && <SheetStatus kit>{power}</SheetStatus>}
                >
                    <SheetRow
                        kit
                        title="Reboot"
                        description="Reconnects after restarting. If a passcode is set, unlock on the phone."
                    >
                        <Button
                            size="compact"
                            variant="danger"
                            onClick={(event) => {
                                setPower('');
                                confirm.arm('reboot', event.currentTarget);
                            }}
                        >
                            Reboot
                        </Button>
                    </SheetRow>
                    <SheetRow kit title="Shut down" description="Power it on using the phone’s button.">
                        <Button
                            size="compact"
                            variant="danger"
                            onClick={(event) => {
                                setPower('');
                                confirm.arm('shutdown', event.currentTarget);
                            }}
                        >
                            Shut down
                        </Button>
                    </SheetRow>
                </SheetGroup>
                {confirm.armed === 'reboot' && (
                    <ConfirmPrompt
                        kit
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
                        kit
                        action={confirm}
                        question={`Shut down ${phoneName}?`}
                        consequence="You cannot turn it back on from here."
                        confirmLabel="Shut down"
                        danger
                        onConfirm={() => onPower('shutdown')}
                    />
                )}

                <Disclosure title="Troubleshooting" note="services and diagnostics">
                    <SheetRow kit title="Decoder">
                        <span class="kit-row-value">{client.getDecoderKind() ?? 'none yet'}</span>
                    </SheetRow>
                    <SheetRow kit title="Session">
                        <span class="kit-row-value">{descriptor?.session ?? 'unknown'}</span>
                    </SheetRow>
                    <SheetRow kit title="Connection">
                        <span class="kit-row-value">{connected ? 'connected' : 'disconnected'}</span>
                    </SheetRow>
                    <SheetRow kit title="Screen">
                        <span class="kit-row-value">{descriptor?.['screen.power'] ?? 'unknown'}</span>
                    </SheetRow>
                    <SheetRow kit title="Lock">
                        <span class="kit-row-value">
                            {descriptor?.['device.locked'] === true
                                ? 'locked'
                                : descriptor?.['device.locked'] === false
                                  ? 'unlocked'
                                  : 'unknown'}
                        </span>
                    </SheetRow>
                    <SheetRow
                        kit
                        title="Restart services"
                        description="Use if touch, keyboard or clipboard stop responding. Ends the phone session for every viewer."
                    >
                        <Button
                            size="compact"
                            variant="danger"
                            disabled={debugBusy}
                            onClick={(event) => confirm.arm('restart', event.currentTarget)}
                        >
                            Restart services
                        </Button>
                    </SheetRow>
                    <SheetRow
                        kit
                        title="Remount developer image"
                        description="Use if the screen will not start. Ends the phone session first."
                    >
                        <Button
                            size="compact"
                            variant="danger"
                            attributes={{ 'aria-label': 'Remount developer image' }}
                            disabled={debugBusy}
                            onClick={(event) => confirm.arm('remount', event.currentTarget)}
                        >
                            Remount
                        </Button>
                    </SheetRow>
                    <SheetRow kit title="Refresh info" description="Check pairing and Developer Mode.">
                        <Button
                            size="compact"
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
                        </Button>
                    </SheetRow>
                    {confirm.armed === 'restart' && (
                        <ConfirmPrompt
                            kit
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
                            kit
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
                    {debugNote && <SheetStatus kit>{debugNote}</SheetStatus>}
                </Disclosure>
            </div>
        </Sheet>
    );
}
