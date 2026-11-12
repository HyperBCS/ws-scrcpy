import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../../ui/Button';
import { ConfirmPrompt, useArmedAction } from '../../ui/ConfirmAction';
import { SheetRow, SheetStatus } from '../../ui/SheetControls';
import type { StatusTone } from '../../ui/InlineStatus';
import { TrackerCommandAborted } from '../../client/trackerCommand';
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
    /** Asked first: the action ends something for every viewer. */
    confirm?: { question: string; consequence: string; confirmLabel: string };
    /** Shown while the command runs, such as 'Restarting services…'. */
    running?: string;
    /**
     * Sends the command. A command the server answers (`sendServiceCommand`) returns a promise
     * of the words to show; one that it answers only with a device update returns nothing.
     */
    run: (signal: AbortSignal) => Promise<string> | void;
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
    const leaving = useRef<AbortController>();

    useEffect(() => {
        const controller = new AbortController();
        leaving.current = controller;
        setBusy('');
        setFeedback(undefined);
        return () => controller.abort();
    }, [opening]);

    const run = (row: ServiceRow) => {
        const signal = leaving.current?.signal ?? new AbortController().signal;
        const result = row.run(signal);
        if (!result) {
            setFeedback(undefined);
            return;
        }
        setBusy(row.id);
        setFeedback({ tone: 'neutral', text: row.running ?? `${row.title}…` });
        result.then(
            (text) => {
                setBusy('');
                setFeedback({ tone: 'success', text });
            },
            (error: Error) => {
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
                        attributes={{ 'data-service': row.id }}
                    >
                        <Button
                            size="compact"
                            variant={row.variant}
                            disabled={row.disabled || !!busy}
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
