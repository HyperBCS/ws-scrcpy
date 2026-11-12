import { useEffect, useRef, useState } from 'preact/hooks';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { TextField } from '../ui/Field';
import { Icon } from '../ui/Icon';
import { Sheet } from '../ui/Sheet';
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
    secondUnlockTime,
    unlockOutcomeText,
    UNLOCK_BY_HAND_MESSAGE,
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
type Summary = {
    state: 'running' | 'by-hand' | 'paused' | 'blocked' | 'off' | 'on';
    title: string;
    text: string;
    tone: Tone;
};

/** The tone of a run that has just ended; a phone that refuses connections is an error then. */
function runTone(outcome: UnlockRunOutcome): Tone {
    if (outcome === 'unlocked' || outcome === 'already-unlocked') {
        return 'success';
    }
    return isUnlockProblem(outcome) || outcome === 'needs-manual-unlock' ? 'error' : 'neutral';
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
    if (schedule.needsManualUnlock) {
        return {
            state: 'by-hand',
            title: 'Unlock the iPhone by hand',
            text: `${UNLOCK_BY_HAND_MESSAGE}${schedule.nextRunAt ? ` Next try ${moment(schedule.nextRunAt)}.` : ''}`,
            tone: 'error',
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
    const next = schedule.waitingForLock
        ? 'Runs when the phone is next locked · '
        : schedule.nextRunAt
          ? `Next run ${moment(schedule.nextRunAt)} · `
          : '';
    return {
        state: 'on',
        title: 'On',
        text: `${next}${lastText}`,
        tone: last && isUnlockProblem(last.outcome) ? 'error' : 'neutral',
    };
}

/** The title of a row that reports a problem: the warning icon, then the words. */
function ProblemTitle({ children }: { children: string }) {
    return (
        <span class="settings-problem">
            <Icon name="warning" size={16} />
            {children}
        </span>
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
 * The iPhone "Scheduled unlock" sheet: the schedule and read-only phone facts. Everything shown
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
    // The request whose reply is still wanted. A run that a device update has already reported
    // as finished gives its turn up, so its late reply cannot clear a newer request's state.
    const request = useRef(0);
    // `lastRun.at` when Run now was pressed; a different one in a later update is this run's result.
    const runBaseline = useRef<number | undefined>(undefined);

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

    function send<T>(kind: Pending, run: () => Promise<T>, done: (result: T) => void, fail: (message: string) => void) {
        const current = generation.current;
        const turn = ++request.current;
        const wanted = () => generation.current === current && request.current === turn;
        setPending(kind);
        run().then(
            (result) => {
                if (wanted()) {
                    setPending(undefined);
                    done(result);
                }
            },
            (error: Error) => {
                if (wanted()) {
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

    // The reply to Run now is lost when the tracker socket drops during the run, and the run goes
    // on without it. Its result still arrives with the device update, so that ends the wait: the
    // button does not read "Running" for three minutes after the run has finished.
    useEffect(() => {
        const last = broadcast?.lastRun;
        if (pending !== 'run' || !broadcast || broadcast.running || !last || last.at === runBaseline.current) {
            return;
        }
        request.current++;
        setPending(undefined);
        setRunNote({ text: describeRun(last), tone: runTone(last.outcome) });
    }, [broadcast, pending]);

    const onRunNow = () => {
        if (!tracker || !renderTarget) {
            return;
        }
        runBaseline.current = broadcast?.lastRun?.at;
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
            <Sheet open={false} onClose={closeApplSettingsSheet} title="Scheduled unlock">
                {null}
            </Sheet>
        );
    }

    const lastRun = schedule.lastRun;
    const running = pending === 'run' || !!schedule.running;
    const developerMode = descriptor?.developerMode;
    const summary = summarize(schedule, running, moment);
    // A run that found the phone refusing connections is a problem for as long as the phone does.
    const lastRunProblem =
        !!lastRun &&
        (isUnlockProblem(lastRun.outcome) ||
            (lastRun.outcome === 'needs-manual-unlock' && !!schedule.needsManualUnlock));
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
        <Sheet
            open={!!target}
            onClose={closeApplSettingsSheet}
            title="Scheduled unlock"
            subtitle={entry ? deviceName(entry) : 'iPhone'}
        >
            <div class="appl-settings">
                {!tracker && <Banner>Waiting for the phone…</Banner>}
                {tracker && !connected && (
                    <Banner>
                        The phone is not connected. Changes are kept on the server and apply when it is back.
                    </Banner>
                )}

                <SheetGroup
                    title="Schedule"
                    hint="Unlocks the iPhone twice a day, at the set time and 12 hours later, then locks it again. The iPhone stops accepting connections 24 hours after the passcode was last entered."
                    status={note && <SheetStatus tone={note.tone}>{note.text}</SheetStatus>}
                >
                    <SheetRow
                        title={summary.tone === 'error' ? <ProblemTitle>{summary.title}</ProblemTitle> : summary.title}
                        description={summary.text}
                        attributes={{ 'data-unlock-summary': summary.state, 'data-tone': summary.tone }}
                    />
                    <SheetToggleRow
                        title="Unlock twice a day"
                        description={
                            schedule.hasPasscode
                                ? `At ${schedule.time} and ${secondUnlockTime(schedule.time)}.`
                                : 'Store a passcode below first.'
                        }
                        checked={schedule.enabled}
                        // Turning it off never needs a passcode: a removed one leaves the switch on.
                        disabled={locked || (!schedule.hasPasscode && !schedule.enabled)}
                        onChange={onToggle}
                    />
                    <SheetRow title="Time" description={timeDescription} attributes={{ 'data-unlock-time': '' }}>
                        {/* Written with the kit's class: the field is read through its ref. */}
                        <input
                            ref={timeInput}
                            type="time"
                            step="60"
                            class="kit-field"
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
                            <Button disabled={locked} onClick={onUseBrowserZone}>
                                Use {browserZone}
                            </Button>
                        </SheetRow>
                    )}
                    {!schedule.hasPasscode || replacing ? (
                        <SheetRow
                            title="Passcode"
                            description="Enter it twice. Encrypted on the server; never shown or sent to a browser."
                            layout="stack"
                        >
                            <TextField
                                label="Passcode for scheduled unlock"
                                labelHidden
                                type="password"
                                inputMode="numeric"
                                enterKeyHint="next"
                                autoComplete="off"
                                maxLength={10}
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
                            <TextField
                                label="Repeat the passcode"
                                labelHidden
                                type="password"
                                inputMode="numeric"
                                enterKeyHint="go"
                                autoComplete="off"
                                maxLength={10}
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
                            <Button
                                variant="primary"
                                disabled={locked || !passcode || !passcodeAgain}
                                onClick={onSavePasscode}
                            >
                                Save on server
                            </Button>
                            {replacing && (
                                <Button
                                    disabled={locked}
                                    onClick={() => {
                                        setReplacing(false);
                                        setPasscode('');
                                        setPasscodeAgain('');
                                    }}
                                >
                                    Cancel
                                </Button>
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
                            <Button size="compact" disabled={locked} onClick={() => setReplacing(true)}>
                                Replace
                            </Button>
                            <Button
                                size="compact"
                                variant="danger"
                                disabled={locked}
                                onClick={(event) => confirmRemove.arm('passcode', event.currentTarget)}
                            >
                                Remove
                            </Button>
                        </SheetRow>
                    )}
                </SheetGroup>
                {confirmRemove.armed && removable && (
                    <ConfirmPrompt
                        action={confirmRemove}
                        question={`Remove the stored passcode for ${entry ? deviceName(entry) : 'this iPhone'}?`}
                        consequence={
                            schedule.enabled
                                ? 'Scheduled unlock stops. The iPhone stops accepting connections 24 hours after the passcode was last entered.'
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
                        title={lastRunProblem ? <ProblemTitle>Last run</ProblemTitle> : 'Last run'}
                        description={lastRun ? describeRun(lastRun, moment(lastRun.at)) : 'No run yet.'}
                        attributes={{
                            'data-outcome': lastRun?.outcome,
                            'data-tone': lastRunProblem ? 'error' : undefined,
                        }}
                    />
                    <SheetRow
                        title="Run now"
                        description={
                            connected || !tracker
                                ? 'Opens a screen session, unlocks, then locks. Takes about 30 seconds.'
                                : 'Not available while the phone is not connected.'
                        }
                        attributes={{ 'data-unlock-run': connected ? 'ready' : 'unavailable' }}
                    >
                        <Button size="compact" disabled={locked || running || !connected} onClick={onRunNow}>
                            {running ? 'Running…' : 'Run now'}
                        </Button>
                    </SheetRow>
                </SheetGroup>

                <SheetGroup title="Phone">
                    <SheetRow title="Model">
                        <span class="kit-row-value">{descriptor?.model || 'unknown'}</span>
                    </SheetRow>
                    <SheetRow title="iOS">
                        <span class="kit-row-value">{descriptor?.version || 'unknown'}</span>
                    </SheetRow>
                    {/* A serial is long: it goes under its name, where it can wrap. */}
                    <SheetRow title="Serial" description={renderTarget.udid} />
                    <SheetRow title="Developer Mode">
                        <span class="kit-row-value">
                            {developerMode === 'unknown' || developerMode === undefined
                                ? 'unknown'
                                : developerMode
                                  ? 'on'
                                  : 'off'}
                        </span>
                    </SheetRow>
                </SheetGroup>
            </div>
        </Sheet>
    );
}
