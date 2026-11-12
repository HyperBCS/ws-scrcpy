import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../../ui/Button';
import { ArmedAction, ConfirmPrompt, useArmedAction } from '../../ui/ConfirmAction';
import { SheetGroup, SheetRow, SheetStatus } from '../../ui/SheetControls';
import { TrackerCommandAborted } from '../../client/trackerCommand';
import type { ActionsAdapter, PowerCommand } from './adapter';
import { GROUP, NOTE, ROW } from './actionRows';

export interface PowerState {
    confirm: ArmedAction<PowerCommand>;
    note: string;
    setNote: (note: string) => void;
    run: (command: PowerCommand) => void;
}

/**
 * Reboot and Shut down. Both are hard to undo from here, so each asks first in its own prompt.
 * The armed state ends when the sheet closes (`open`), so reopening never shows a waiting prompt.
 * They go over the tracker, not the stream socket, so they work while the stream is down; closing
 * the page withdraws a command that is still waiting.
 */
export function usePower(adapter: ActionsAdapter, open: boolean): PowerState {
    const confirm = useArmedAction<PowerCommand>(open);
    const [note, setNote] = useState('');
    const leaving = useRef<AbortController>();
    useEffect(() => {
        const controller = new AbortController();
        leaving.current = controller;
        return () => controller.abort();
    }, []);

    const run = (command: PowerCommand) => {
        const row = ROW[command];
        const pending = adapter.power?.(command, leaving.current?.signal);
        if (!pending) {
            setNote(NOTE.notListed);
            return;
        }
        setNote(row.sending);
        pending.then(
            () => setNote(row.sent),
            (error: Error) => {
                if (!(error instanceof TrackerCommandAborted)) {
                    setNote(error.message);
                }
            },
        );
    };
    return { confirm, note, setNote, run };
}

interface PowerGroupProps {
    state: PowerState;
    commands: readonly PowerCommand[];
    /** The phone in the prompts. */
    name: string;
}

export function PowerGroup({ state, commands, name }: PowerGroupProps) {
    const { confirm, note, setNote, run } = state;
    return (
        <>
            <SheetGroup title={GROUP.power} status={note && <SheetStatus>{note}</SheetStatus>}>
                {commands.map((command) => (
                    <SheetRow key={command} title={ROW[command].title} description={ROW[command].description}>
                        <Button
                            size="compact"
                            variant="danger"
                            onClick={(event) => {
                                setNote('');
                                confirm.arm(command, event.currentTarget);
                            }}
                        >
                            {ROW[command].button}
                        </Button>
                    </SheetRow>
                ))}
            </SheetGroup>
            {commands.map(
                (command) =>
                    confirm.armed === command && (
                        <ConfirmPrompt
                            key={command}
                            action={confirm}
                            question={ROW[command].question(name)}
                            consequence={ROW[command].consequence}
                            confirmLabel={ROW[command].button}
                            danger
                            onConfirm={() => run(command)}
                        />
                    ),
            )}
        </>
    );
}
