import { useEffect, useRef, useState } from 'preact/hooks';
import { BottomSheet } from '../ui/BottomSheet';
import { SheetGroup, SheetRow, SheetStatus, SheetToggleRow } from '../ui/SheetControls';
import { applSettingsSheetTarget, closeApplSettingsSheet } from '../state/settingsSheet';
import { devices, deviceName, findDeviceByUdid } from '../state/devices';
import { readSavedPasscode } from '../state/savedPasscode';
import {
    clearUnlockPasscode,
    formatUnlockMoment,
    runUnlockNow,
    setUnlockPasscode,
    updateUnlockSchedule,
} from '../state/unlockSchedule';
import {
    DEFAULT_UNLOCK_TIME,
    isValidUnlockPasscode,
    isValidUnlockTime,
    unlockOutcomeText,
    UnlockRunOutcome,
    UnlockRunResult,
    UnlockScheduleStatus,
} from '../../common/IosUnlockSchedule';
import { DeviceState } from '../../common/DeviceState';
import ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import '../../style/views/SettingsSheet.css';

const DEFAULT_STATUS: UnlockScheduleStatus = { enabled: false, time: DEFAULT_UNLOCK_TIME, hasPasscode: false };

type Pending = 'schedule' | 'time' | 'passcode' | 'clear' | 'run';
type Tone = 'neutral' | 'error' | 'success' | 'warning';
type Note = { text: string; tone: Tone };

function runTone(outcome: UnlockRunOutcome): Tone {
    if (outcome === 'unlocked' || outcome === 'already-unlocked') {
        return 'success';
    }
    return outcome.startsWith('failed-') || outcome === 'skipped-disconnected' ? 'error' : 'neutral';
}

function describeRun(run: UnlockRunResult, withTime: boolean): string {
    const when = withTime ? ` · ${formatUnlockMoment(run.at)}` : '';
    return `${unlockOutcomeText(run.outcome)}${when}${run.message ? `. ${run.message}` : ''}`;
}

/**
 * The iPhone "Settings" sheet: the scheduled unlock and read-only phone facts. Everything shown
 * comes from `descriptor.unlockSchedule`, which the server keeps current through the normal
 * device broadcast; a command reply is used only until the next broadcast arrives. The passcode
 * lives in this component's state until Save and goes nowhere else in the browser.
 */
export function ApplSettingsSheet() {
    const target = applSettingsSheetTarget.value;
    const previousTarget = useRef(target);
    if (target) {
        previousTarget.current = target;
    }
    // Retain content through the closing animation, as `SettingsSheet` does.
    const renderTarget = target ?? previousTarget.current;
    const entry = renderTarget?.deviceKey
        ? devices.value.get(renderTarget.deviceKey)
        : renderTarget
          ? findDeviceByUdid(renderTarget.udid)
          : undefined;
    const descriptor = entry?.params.type === 'ios' ? (entry.descriptor as ApplDeviceDescriptor) : undefined;
    const tracker = target ? entry?.tracker : undefined;
    const broadcast = descriptor?.unlockSchedule;
    const [replyStatus, setReplyStatus] = useState<UnlockScheduleStatus>();
    const [pending, setPending] = useState<Pending>();
    const [passcode, setPasscode] = useState('');
    const [replacing, setReplacing] = useState(false);
    const [browserSaved, setBrowserSaved] = useState(false);
    const [note, setNote] = useState<Note>();
    const [runNote, setRunNote] = useState<Note>();
    // A reply that lands after the sheet closed, or reopened for another phone, is dropped.
    const generation = useRef(0);

    useEffect(() => {
        generation.current++;
        setReplyStatus(undefined);
        setPending(undefined);
        setPasscode('');
        setReplacing(false);
        setNote(undefined);
        setRunNote(undefined);
        setBrowserSaved(!!target && readSavedPasscode(target.udid)?.mode === 'pin');
    }, [target]);

    // The server emits the status before it replies, so a broadcast is never older than a reply.
    useEffect(() => {
        setReplyStatus(undefined);
    }, [broadcast]);

    const schedule = replyStatus ?? broadcast ?? DEFAULT_STATUS;
    const connected = descriptor?.state === DeviceState.CONNECTED;
    const locked = pending !== undefined || !tracker;

    function send<T>(
        kind: Pending,
        request: () => Promise<T>,
        done: (result: T) => void,
        fail: (message: string) => void,
    ) {
        const current = generation.current;
        setPending(kind);
        request().then(
            (result) => {
                if (generation.current === current) {
                    setPending(undefined);
                    done(result);
                }
            },
            (error: Error) => {
                if (generation.current === current) {
                    setPending(undefined);
                    fail(error.message);
                }
            },
        );
    }

    const onToggle = (enabled: boolean) => {
        if (!tracker || !renderTarget) {
            return;
        }
        setNote(undefined);
        send(
            'schedule',
            () => updateUnlockSchedule(tracker, renderTarget.udid, { enabled }),
            (status) => {
                setReplyStatus(status);
                setNote({
                    text: status.enabled ? 'Scheduled unlock is on.' : 'Scheduled unlock is off.',
                    tone: 'neutral',
                });
            },
            (message) => setNote({ text: message, tone: 'error' }),
        );
    };

    const onTimeChange = (time: string) => {
        if (!tracker || !renderTarget || !isValidUnlockTime(time) || time === schedule.time) {
            return;
        }
        setNote(undefined);
        send(
            'time',
            () => updateUnlockSchedule(tracker, renderTarget.udid, { time }),
            (status) => {
                setReplyStatus(status);
                setNote({ text: `Unlock time set to ${status.time}.`, tone: 'neutral' });
            },
            (message) => setNote({ text: message, tone: 'error' }),
        );
    };

    const onSavePasscode = () => {
        if (!tracker || !renderTarget || locked) {
            return;
        }
        const digits = passcode.trim();
        if (!isValidUnlockPasscode(digits)) {
            setNote({ text: 'Enter a passcode with 4 to 10 digits.', tone: 'error' });
            return;
        }
        setNote({ text: 'Saving on the server…', tone: 'neutral' });
        // The field is cleared after the reply either way; the server holds the only copy.
        send(
            'passcode',
            () => setUnlockPasscode(tracker, renderTarget.udid, digits),
            (status) => {
                setReplyStatus(status);
                setPasscode('');
                setReplacing(false);
                setNote({ text: 'Passcode stored on the server.', tone: 'success' });
            },
            (message) => {
                setPasscode('');
                setNote({ text: message, tone: 'error' });
            },
        );
    };

    const onClearPasscode = () => {
        if (!tracker || !renderTarget) {
            return;
        }
        setNote(undefined);
        send(
            'clear',
            () => clearUnlockPasscode(tracker, renderTarget.udid),
            (status) => {
                setReplyStatus(status);
                setNote({ text: 'Passcode removed from the server.', tone: 'neutral' });
            },
            (message) => setNote({ text: message, tone: 'error' }),
        );
    };

    const onRunNow = () => {
        if (!tracker || !renderTarget) {
            return;
        }
        setRunNote({ text: 'Running. This takes about 30 seconds.', tone: 'neutral' });
        send(
            'run',
            () => runUnlockNow(tracker, renderTarget.udid),
            (result) => setRunNote({ text: describeRun(result, false), tone: runTone(result.outcome) }),
            (message) => setRunNote({ text: message, tone: 'error' }),
        );
    };

    if (!renderTarget) {
        return (
            <BottomSheet open={false} onClose={closeApplSettingsSheet} title="Settings">
                {null}
            </BottomSheet>
        );
    }

    const lastRun = schedule.lastRun;
    const running = pending === 'run' || !!schedule.running;
    const developerMode = descriptor?.developerMode;

    return (
        <BottomSheet open={!!target} onClose={closeApplSettingsSheet} title="Settings">
            <div class="appl-settings-sheet">
                <div class="settings-device-context" title={renderTarget.udid}>
                    <span class="settings-device-dot" aria-hidden="true" />
                    <div>
                        <strong>{entry ? deviceName(entry) : 'iPhone'}</strong>
                    </div>
                </div>
                {!tracker && <SheetStatus tone="warning">Waiting for device…</SheetStatus>}
                {tracker && !connected && (
                    <SheetStatus tone="warning">
                        The phone is not connected. Changes are kept on the server and apply when it is back.
                    </SheetStatus>
                )}

                <SheetGroup
                    title="Scheduled unlock"
                    hint="Unlocks the phone once a day so iOS does not restart it after 72 hours without an unlock, then locks it again. Skipped if the phone was unlocked in the last 22 hours."
                >
                    <SheetToggleRow
                        title="Unlock every day"
                        description={
                            schedule.hasPasscode
                                ? 'At the time below, server local time.'
                                : 'Store a passcode below first.'
                        }
                        checked={schedule.enabled}
                        // Turning it off never needs a passcode: a removed one leaves the switch on.
                        disabled={locked || (!schedule.hasPasscode && !schedule.enabled)}
                        onChange={onToggle}
                    />
                    <SheetRow title="Time" description="Server local time">
                        <input
                            type="time"
                            step="60"
                            class="sheet-input"
                            aria-label="Unlock time"
                            value={schedule.time}
                            disabled={locked}
                            onChange={(event) => onTimeChange(event.currentTarget.value)}
                        />
                    </SheetRow>
                    {!schedule.hasPasscode || replacing ? (
                        <SheetRow
                            title="Passcode"
                            description="Encrypted on the server. Never shown or sent to a browser."
                            layout="stack"
                        >
                            <input
                                type="password"
                                inputMode="numeric"
                                enterKeyHint="go"
                                autoComplete="off"
                                maxLength={10}
                                class="sheet-input"
                                aria-label="Passcode for scheduled unlock"
                                value={passcode}
                                disabled={locked}
                                onInput={(event) => setPasscode(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                    event.stopPropagation();
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        onSavePasscode();
                                    }
                                }}
                                onKeyUp={(event) => event.stopPropagation()}
                            />
                            <button
                                type="button"
                                class="sheet-button primary"
                                disabled={locked || !passcode}
                                onClick={onSavePasscode}
                            >
                                Save on server
                            </button>
                            {browserSaved && (
                                <button
                                    type="button"
                                    class="sheet-button"
                                    disabled={locked}
                                    onClick={() => setPasscode(readSavedPasscode(renderTarget.udid)?.value ?? '')}
                                >
                                    Use the passcode saved in this browser
                                </button>
                            )}
                            {replacing && (
                                <button
                                    type="button"
                                    class="sheet-button"
                                    disabled={locked}
                                    onClick={() => {
                                        setReplacing(false);
                                        setPasscode('');
                                    }}
                                >
                                    Cancel
                                </button>
                            )}
                        </SheetRow>
                    ) : (
                        <SheetRow
                            title="Passcode"
                            description="Stored on the server. Never shown or sent to a browser."
                            layout="pair"
                        >
                            <button
                                type="button"
                                class="sheet-button"
                                disabled={locked}
                                onClick={() => setReplacing(true)}
                            >
                                Replace
                            </button>
                            <button type="button" class="sheet-button" disabled={locked} onClick={onClearPasscode}>
                                Remove
                            </button>
                        </SheetRow>
                    )}
                </SheetGroup>
                {note && <SheetStatus tone={note.tone}>{note.text}</SheetStatus>}

                <SheetGroup title="Status">
                    <SheetRow
                        title="Last run"
                        description={lastRun ? describeRun(lastRun, true) : 'No run yet.'}
                        attributes={{ 'data-outcome': lastRun?.outcome }}
                    />
                    <SheetRow
                        title="Next run"
                        description={
                            schedule.running
                                ? 'Running now.'
                                : schedule.nextRunAt
                                  ? formatUnlockMoment(schedule.nextRunAt)
                                  : 'Off'
                        }
                    />
                    <SheetRow
                        title="Run now"
                        description="Opens a screen session, unlocks, then locks. Takes about 30 seconds."
                    >
                        <button type="button" class="sheet-button" disabled={locked || running} onClick={onRunNow}>
                            {running ? 'Running…' : 'Run now'}
                        </button>
                    </SheetRow>
                </SheetGroup>
                {runNote && <SheetStatus tone={runNote.tone}>{runNote.text}</SheetStatus>}

                <SheetGroup title="Phone">
                    <dl class="sheet-facts">
                        <dt>Model</dt>
                        <dd>{descriptor?.model || 'unknown'}</dd>
                        <dt>iOS</dt>
                        <dd>{descriptor?.version || 'unknown'}</dd>
                        <dt>Serial</dt>
                        <dd>{renderTarget.udid}</dd>
                        <dt>Developer Mode</dt>
                        <dd>
                            {developerMode === 'unknown' || developerMode === undefined
                                ? 'unknown'
                                : developerMode
                                  ? 'on'
                                  : 'off'}
                        </dd>
                    </dl>
                </SheetGroup>
            </div>
        </BottomSheet>
    );
}
