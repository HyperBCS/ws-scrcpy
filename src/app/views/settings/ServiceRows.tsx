import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../../ui/Button';
import { ConfirmPrompt, useArmedAction } from '../../ui/ConfirmAction';
import { SheetRow, SheetStatus } from '../../ui/SheetControls';
import type { StatusTone } from '../../ui/InlineStatus';
import { TrackerCommandAborted } from '../../client/trackerCommand';
import type { TrackerErrorObservation } from '../../client/trackerCommand';
import { SettingsGroup } from './Section';

/** One service action of a phone, such as Stop stream service or Remount developer image. */
export interface ServiceRow {
    /** Names the row for tests (`data-service`). */
    id: string;
    title: string;
    description: string;
    /** The button's words, and its name where the words alone do not say what it does. */
    label: string;
    ariaLabel?: string;
    variant?: 'secondary' | 'danger';
    disabled?: boolean;
    /** Long explanations use the kit's narrow and docked layout, keeping desktop alignment. */
    layout?: 'inline' | 'pair' | 'stack';
    /** Asked first: the action ends something for every viewer. */
    confirm?: { question: string; consequence: string; confirmLabel: string };
    /** Shown while the command runs, such as 'Restarting services…'. */
    running?: string;
    /**
     * Sends the command. A command the server answers (`sendServiceCommand`) returns a promise
     * of the words to show. A descriptor-driven command observes only its available failures.
     */
    run: (signal: AbortSignal) => Promise<string> | ServiceErrorObservation | void;
}

interface ServiceErrorObservation extends TrackerErrorObservation {
    /** Only the current, failed action may clear its optimistic Starting marker. */
    failed?: () => void;
}

interface ActiveAction {
    controller: AbortController;
    scope: object;
    opening?: object;
    pending: boolean;
    observation?: ServiceErrorObservation;
}

interface ServiceRowsProps {
    rows: readonly ServiceRow[];
    /** One opening of the sheet. Closing the sheet withdraws a command that is still out. */
    opening?: object;
    /** Why no row can be used now, said once under the rows. */
    unavailable?: string;
}

/**
 * The service actions of a phone, for both kinds: one row each, its confirm prompt under the
 * rows, and the outcome of the last command. Each command ends with its reply, an error, a
 * closed socket or a time limit (`client/trackerCommand.ts`), so a button cannot stay disabled.
 */
export function ServiceRows({ rows, opening, unavailable }: ServiceRowsProps) {
    const confirm = useArmedAction<string>(!!opening);
    const [busy, setBusy] = useState('');
    const [feedback, setFeedback] = useState<{ tone: StatusTone; text: string }>();
    const active = useRef<ActiveAction>();
    const scope = useRef<object>({});
    const latestOpening = useRef(opening);
    latestOpening.current = opening;

    useLayoutEffect(() => {
        const currentScope = {};
        scope.current = currentScope;
        setBusy('');
        setFeedback(undefined);
        return () => {
            if (active.current?.scope === currentScope) {
                active.current.controller.abort();
                active.current = undefined;
            }
        };
    }, [opening]);

    useLayoutEffect(() => {
        const observation = active.current?.observation;
        if (observation?.isComplete?.()) {
            observation.stop();
        }
    }, [rows]);

    const run = (row: ServiceRow) => {
        if (row.disabled || active.current?.pending) {
            return;
        }
        active.current?.controller.abort();
        const action: ActiveAction = {
            controller: new AbortController(),
            scope: scope.current,
            opening,
            pending: false,
        };
        active.current = action;
        const current = () =>
            active.current === action &&
            !action.controller.signal.aborted &&
            latestOpening.current === action.opening;
        const result = row.run(action.controller.signal);
        if (!result) {
            setFeedback(undefined);
            return;
        }
        if ('settled' in result) {
            action.observation = result;
            setFeedback(undefined);
            result.settled.then(
                () => {
                    if (current()) {
                        active.current = undefined;
                    }
                },
                (error: Error) => {
                    if (!current()) {
                        return;
                    }
                    active.current = undefined;
                    if (!(error instanceof TrackerCommandAborted) && !result.isComplete?.()) {
                        result.failed?.();
                        setFeedback({ tone: 'error', text: error.message });
                    }
                },
            );
            return;
        }
        action.pending = true;
        setBusy(row.id);
        setFeedback({ tone: 'neutral', text: row.running ?? `${row.title}…` });
        result.then(
            (text) => {
                if (!current()) {
                    return;
                }
                active.current = undefined;
                setBusy('');
                setFeedback({ tone: 'success', text });
            },
            (error: Error) => {
                if (!current()) {
                    return;
                }
                active.current = undefined;
                if (!(error instanceof TrackerCommandAborted)) {
                    setBusy('');
                    setFeedback({ tone: 'error', text: error.message });
                }
            },
        );
    };

    // A prompt shows only while its row can be used, so a phone that disconnects in the meantime
    // does not leave a question for an action that no longer applies.
    const armed = rows.find((row) => row.id === confirm.armed && !row.disabled && !busy);

    return (
        <>
            <SettingsGroup
                title="Services"
                class="settings-services"
                hint={unavailable}
                status={feedback && <SheetStatus tone={feedback.tone}>{feedback.text}</SheetStatus>}
            >
                {rows.map((row) => (
                    <SheetRow
                        key={row.id}
                        title={row.title}
                        description={row.description}
                        layout={row.layout}
                        attributes={{ 'data-service': row.id }}
                    >
                        <Button
                            size="compact"
                            variant={row.variant}
                            busy={busy === row.id}
                            disabled={row.disabled || (!!busy && busy !== row.id)}
                            attributes={{ 'aria-label': row.ariaLabel }}
                            onClick={(event) => (row.confirm ? confirm.arm(row.id, event.currentTarget) : run(row))}
                        >
                            {row.label}
                        </Button>
                    </SheetRow>
                ))}
            </SettingsGroup>
            {armed?.confirm && (
                <ConfirmPrompt
                    action={confirm}
                    question={armed.confirm.question}
                    consequence={armed.confirm.consequence}
                    confirmLabel={armed.confirm.confirmLabel}
                    danger
                    onConfirm={() => run(armed)}
                />
            )}
        </>
    );
}
