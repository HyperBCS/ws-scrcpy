import { useEffect, useRef, useState } from 'preact/hooks';
import { BottomSheet } from '../ui/BottomSheet';
import { SheetGroup, SheetRow, SheetStatus, SheetToggleRow } from '../ui/SheetControls';
import { ConfirmPrompt, useArmedAction } from '../ui/ConfirmAction';
import { applSettingsSheetTarget, closeApplSettingsSheet } from '../state/settingsSheet';
import { devices, deviceName, findDeviceByUdid } from '../state/devices';
import {
    clearUnlockPasscode,
    formatUnlockMoment,
    runUnlockNow,
    setUnlockPasscode,
    unlockDisplayZone,
    updateUnlockSchedule,
} from '../state/unlockSchedule';
import {
    DEFAULT_UNLOCK_TIME,
    isUnlockProblem,
    isValidUnlockPasscode,
    isValidUnlockTime,
    localTimeZone,
    unlockOutcomeText,
    UnlockRunOutcome,
    UnlockRunResult,
    UnlockSchedulePatch,
    UnlockScheduleStatus,
} from '../../common/IosUnlockSchedule';
import { DeviceState } from '../../common/DeviceState';
import ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import '../../style/views/SettingsSheet.css';

const DEFAULT_STATUS: UnlockScheduleStatus = { enabled: false, time: DEFAULT_UNLOCK_TIME, hasPasscode: false };

type Pending = 'schedule' | 'time' | 'passcode' | 'clear' | 'run';
type Tone = 'neutral' | 'error' | 'success' | 'warning';
type Note = { text: string; tone: Tone };
type Summary = { state: 'running' | 'paused' | 'blocked' | 'off' | 'on'; title: string; text: string; tone: Tone };

function runTone(outcome: UnlockRunOutcome): Tone {
    if (outcome === 'unlocked' || outcome === 'already-unlocked') {
        return 'success';
    }
    return isUnlockProblem(outcome) ? 'error' : 'neutral';
}

function describeRun(run: UnlockRunResult, when?: string): string {
    return `${unlockOutcomeText(run.outcome)}${when ? ` · ${when}` : ''}${run.message ? `. ${run.message}` : ''}`;
}

/** State, next run and last result in one row, so a schedule that cannot run is seen first. */
function summarize(schedule: UnlockScheduleStatus, running: boolean, moment: (at: number) => string): Summary {
    const last = schedule.lastRun;
    if (running) {
        return {
            state: 'running',
            title: 'Running now',
            // The stream page's Unlock runs here too, and that one does not lock the phone after.
            text: 'An unlock run is in progress.',
            tone: 'neutral',
        };
    }
    if (schedule.passcodeRejected) {
        return {
            state: 'paused',
            title: 'Paused',
            text: 'The phone rejected the stored passcode. Nothing is typed until the passcode is saved again.',
            tone: 'error',
        };
    }
    if (schedule.enabled && !schedule.hasPasscode) {
        const reason = last?.outcome === 'skipped-no-passcode' && last.message ? `${last.message}. ` : '';
        return {
            state: 'blocked',
            title: 'On, but cannot run',
            text: `${reason}Store the passcode below.`,
            tone: 'error',
        };
    }
    const lastText = last ? `Last run: ${unlockOutcomeText(last.outcome)}` : 'No run yet';
    if (!schedule.enabled) {
        return { state: 'off', title: 'Off', text: lastText, tone: 'neutral' };
    }
    return {
        state: 'on',
        title: 'On',
        text: `${schedule.nextRunAt ? `Next run ${moment(schedule.nextRunAt)} · ` : ''}${lastText}`,
        tone: last && isUnlockProblem(last.outcome) ? 'error' : 'neutral',
    };
}

function ProblemIcon() {
    return (
        <svg
            class="sheet-problem-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
        </svg>
    );
}

/** A phone or tablet picker hands over one finished value; a desktop field changes per segment typed. */
function commitsOnChange(): boolean {
    try {
        return window.matchMedia('(pointer: coarse)').matches;
    } catch {
        return false;
    }
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
    const [passcodeAgain, setPasscodeAgain] = useState('');
    const [replacing, setReplacing] = useState(false);
    // The time as typed, until it is saved. Segments of a desktop time field arrive one by one.
    const [timeDraft, setTimeDraft] = useState<string>();
    const [timeSaved, setTimeSaved] = useState(false);
    const [note, setNote] = useState<Note>();
    const [runNote, setRunNote] = useState<Note>();
    const timeInput = useRef<HTMLInputElement>(null);
    // Removing the passcode stops the scheduled unlock, so it is confirmed. Closing the sheet disarms it.
    const confirmRemove = useArmedAction<'passcode'>(!!target);
    // A reply that lands after the sheet closed, or reopened for another phone, is dropped.
    const generation = useRef(0);

    useEffect(() => {
        generation.current++;
        setReplyStatus(undefined);
        setPending(undefined);
        setPasscode('');
        setPasscodeAgain('');
        setReplacing(false);
        setTimeDraft(undefined);
        setTimeSaved(false);
        setNote(undefined);
        setRunNote(undefined);
    }, [target]);

    // The server emits the status before it replies, so a broadcast is never older than a reply.
    useEffect(() => {
        setReplyStatus(undefined);
    }, [broadcast]);

    const schedule = replyStatus ?? broadcast ?? DEFAULT_STATUS;
    // A passcode removed from another browser takes the Remove button, and its waiting prompt, with it.
    const removable = schedule.hasPasscode && !replacing;
    useEffect(() => {
        if (!removable) {
            confirmRemove.disarm();
        }
    }, [removable]);
    const connected = descriptor?.state === DeviceState.CONNECTED;
    const locked = pending !== undefined || !tracker;
    const browserZone = localTimeZone();
    // Every time in the sheet is shown in the schedule's zone, which the Time row names.
    const zone = unlockDisplayZone(schedule);
    const moment = (at: number) => formatUnlockMoment(at, zone);
    const zoneLabel =
        schedule.timeZone ?? (schedule.serverTimeZone ? `Server time (${schedule.serverTimeZone})` : 'Server time');

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
        // Turning it on saves the schedule from this browser; a schedule without a zone gets this one.
        const patch: UnlockSchedulePatch =
            enabled && !schedule.timeZone && browserZone ? { enabled, timeZone: browserZone } : { enabled };
        send(
            'schedule',
            () => updateUnlockSchedule(tracker, renderTarget.udid, patch),
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

    const saveTime = (time: string) => {
        if (!tracker || !renderTarget) {
            return;
        }
        setNote(undefined);
        setTimeSaved(false);
        send(
            'time',
            () =>
                updateUnlockSchedule(tracker, renderTarget.udid, {
                    time,
                    ...(browserZone ? { timeZone: browserZone } : {}),
                }),
            (status) => {
                setReplyStatus(status);
                setTimeSaved(true);
                // Keep what was typed while the request was out.
                setTimeDraft((draft) => (draft === time ? undefined : draft));
            },
            (message) => {
                setTimeDraft(undefined);
                setNote({ text: message, tone: 'error' });
            },
        );
    };

    /** Save the typed time once it is complete: on Enter, on leaving the field, or when a picker closes. */
    const commitTime = (value = timeDraft) => {
        if (value === undefined) {
            return;
        }
        if (!isValidUnlockTime(value) || value === schedule.time) {
            setTimeDraft(undefined);
            return;
        }
        // A save already out is followed up by the effect below.
        if (pending === undefined) {
            saveTime(value);
        }
    };

    useEffect(() => {
        if (pending === undefined && timeDraft !== undefined && document.activeElement !== timeInput.current) {
            commitTime();
        }
    }, [pending]);

    const onSavePasscode = () => {
        if (!tracker || !renderTarget || locked) {
            return;
        }
        const digits = passcode.trim();
        if (!isValidUnlockPasscode(digits)) {
            setNote({ text: 'Enter a passcode with 4 to 10 digits.', tone: 'error' });
            return;
        }
        // A mistyped passcode costs a failed attempt on the phone, so it is entered twice.
        if (passcodeAgain.trim() !== digits) {
            setPasscodeAgain('');
            setNote({ text: 'The two entries do not match. Enter the passcode again.', tone: 'error' });
            return;
        }
        setNote({ text: 'Saving on the server…', tone: 'neutral' });
        // The fields are cleared after the reply either way; the server holds the only copy.
        send(
            'passcode',
            () => setUnlockPasscode(tracker, renderTarget.udid, digits),
            (status) => {
                setReplyStatus(status);
                setPasscode('');
                setPasscodeAgain('');
                setReplacing(false);
                setNote({ text: 'Passcode stored on the server.', tone: 'success' });
            },
            (message) => {
                setPasscode('');
                setPasscodeAgain('');
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
                setNote(
                    status.enabled
                        ? {
                              text: 'Passcode removed. Scheduled unlock is on but cannot run until a passcode is stored.',
                              tone: 'warning',
                          }
                        : { text: 'Passcode removed from the server.', tone: 'neutral' },
                );
            },
            (message) => setNote({ text: message, tone: 'error' }),
        );
    };

    const onUseBrowserZone = () => {
        if (!tracker || !renderTarget || !browserZone) {
            return;
        }
        setNote(undefined);
        send(
            'schedule',
            () => updateUnlockSchedule(tracker, renderTarget.udid, { time: schedule.time, timeZone: browserZone }),
            (status) => {
                setReplyStatus(status);
                setNote({ text: `The time is now in ${browserZone}.`, tone: 'neutral' });
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
            (result) => setRunNote({ text: describeRun(result), tone: runTone(result.outcome) }),
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
    const summary = summarize(schedule, running, moment);
    const lastRunProblem = !!lastRun && isUnlockProblem(lastRun.outcome);
    const timeDescription =
        pending === 'time'
            ? 'Saving…'
            : timeDraft !== undefined && timeDraft !== schedule.time
              ? 'Not saved yet. Press Enter or leave the field to save.'
              : timeSaved
                ? `${zoneLabel} · saved${schedule.nextRunAt ? `, next run ${moment(schedule.nextRunAt)}` : ''}`
                : zoneLabel;
    const stopKeys = (event: KeyboardEvent) => event.stopPropagation();

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
                    title="Schedule"
                    hint="Unlocks the phone once a day so iOS does not restart it after 72 hours without an unlock, then locks it again. Skipped if the phone was unlocked in the last 22 hours."
                    status={note && <SheetStatus tone={note.tone}>{note.text}</SheetStatus>}
                >
                    <SheetRow
                        title={
                            <>
                                {summary.tone === 'error' && <ProblemIcon />}
                                {summary.title}
                            </>
                        }
                        description={summary.text}
                        attributes={{ 'data-unlock-summary': summary.state, 'data-tone': summary.tone }}
                    />
                    <SheetToggleRow
                        title="Unlock every day"
                        description={schedule.hasPasscode ? 'At the time below.' : 'Store a passcode below first.'}
                        checked={schedule.enabled}
                        // Turning it off never needs a passcode: a removed one leaves the switch on.
                        disabled={locked || (!schedule.hasPasscode && !schedule.enabled)}
                        onChange={onToggle}
                    />
                    <SheetRow title="Time" description={timeDescription} attributes={{ 'data-unlock-time': '' }}>
                        <input
                            ref={timeInput}
                            type="time"
                            step="60"
                            class="sheet-input"
                            aria-label="Unlock time"
                            value={timeDraft ?? schedule.time}
                            // Not disabled by its own save: that would drop focus in the middle of typing.
                            disabled={!tracker || (pending !== undefined && pending !== 'time')}
                            onInput={(event) => {
                                setTimeDraft(event.currentTarget.value);
                                setTimeSaved(false);
                            }}
                            onChange={(event) => {
                                if (commitsOnChange()) {
                                    commitTime(event.currentTarget.value);
                                }
                            }}
                            onBlur={(event) => commitTime(event.currentTarget.value)}
                            onKeyDown={(event) => {
                                event.stopPropagation();
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    commitTime(event.currentTarget.value);
                                }
                            }}
                            onKeyUp={stopKeys}
                        />
                    </SheetRow>
                    {browserZone && schedule.timeZone !== browserZone && (
                        <SheetRow
                            title="Time zone"
                            description={
                                schedule.timeZone
                                    ? `The time is in ${schedule.timeZone}. This browser is in ${browserZone}.`
                                    : `The time is server time, saved before time zones were stored. This browser is in ${browserZone}.`
                            }
                            layout="stack"
                        >
                            <button type="button" class="sheet-button" disabled={locked} onClick={onUseBrowserZone}>
                                Use {browserZone}
                            </button>
                        </SheetRow>
                    )}
                    {!schedule.hasPasscode || replacing ? (
                        <SheetRow
                            title="Passcode"
                            description="Enter it twice. Encrypted on the server; never shown or sent to a browser."
                            layout="stack"
                        >
                            <input
                                type="password"
                                inputMode="numeric"
                                enterKeyHint="next"
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
                                onKeyUp={stopKeys}
                            />
                            <input
                                type="password"
                                inputMode="numeric"
                                enterKeyHint="go"
                                autoComplete="off"
                                maxLength={10}
                                class="sheet-input"
                                aria-label="Repeat the passcode"
                                placeholder="Repeat"
                                value={passcodeAgain}
                                disabled={locked}
                                onInput={(event) => setPasscodeAgain(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                    event.stopPropagation();
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        onSavePasscode();
                                    }
                                }}
                                onKeyUp={stopKeys}
                            />
                            <button
                                type="button"
                                class="sheet-button primary"
                                disabled={locked || !passcode || !passcodeAgain}
                                onClick={onSavePasscode}
                            >
                                Save on server
                            </button>
                            {replacing && (
                                <button
                                    type="button"
                                    class="sheet-button"
                                    disabled={locked}
                                    onClick={() => {
                                        setReplacing(false);
                                        setPasscode('');
                                        setPasscodeAgain('');
                                    }}
                                >
                                    Cancel
                                </button>
                            )}
                        </SheetRow>
                    ) : (
                        <SheetRow
                            title="Passcode"
                            description={
                                schedule.passcodeRejected
                                    ? 'Rejected by the phone. Replace it to resume the schedule.'
                                    : 'Stored on the server. Never shown or sent to a browser.'
                            }
                            layout="pair"
                            attributes={{ 'data-tone': schedule.passcodeRejected ? 'error' : undefined }}
                        >
                            <button
                                type="button"
                                class="sheet-button"
                                disabled={locked}
                                onClick={() => setReplacing(true)}
                            >
                                Replace
                            </button>
                            <button
                                type="button"
                                class="sheet-button danger"
                                disabled={locked}
                                onClick={(event) => confirmRemove.arm('passcode', event.currentTarget)}
                            >
                                Remove
                            </button>
                        </SheetRow>
                    )}
                </SheetGroup>
                {confirmRemove.armed && removable && (
                    <ConfirmPrompt
                        action={confirmRemove}
                        question={`Remove the stored passcode for ${entry ? deviceName(entry) : 'this iPhone'}?`}
                        consequence={
                            schedule.enabled
                                ? 'Scheduled unlock stops. iOS restarts the phone after 72 hours without an unlock.'
                                : 'Scheduled unlock cannot run without it.'
                        }
                        confirmLabel="Remove passcode"
                        danger
                        onConfirm={onClearPasscode}
                    />
                )}

                <SheetGroup
                    title="Runs"
                    status={runNote && <SheetStatus tone={runNote.tone}>{runNote.text}</SheetStatus>}
                >
                    <SheetRow
                        title={
                            <>
                                {lastRunProblem && <ProblemIcon />}
                                Last run
                            </>
                        }
                        description={lastRun ? describeRun(lastRun, moment(lastRun.at)) : 'No run yet.'}
                        attributes={{
                            'data-outcome': lastRun?.outcome,
                            'data-tone': lastRunProblem ? 'error' : undefined,
                        }}
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
