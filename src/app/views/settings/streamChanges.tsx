import { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ConfirmPrompt, useArmedAction } from '../../ui/ConfirmAction';
import { SheetStatus } from '../../ui/SheetControls';
import { ScrcpyServerConfig } from '../../../common/Constants';
import {
    RESTARTING_STREAM,
    StreamConfig,
    StreamConfigPatch,
    StreamConfigTracker,
    useStreamConfig,
} from '../../state/streamConfig';
import type { StreamClientScrcpy } from '../../googDevice/client/StreamClientScrcpy';

/** The group a change came from. Its outcome is shown under that group. */
export type ChangePlace = 'stream' | 'sound';

export const NOT_CONNECTED = 'Not available while the phone is not connected.';

export interface StreamChanges {
    config: StreamConfig;
    /** The phone's values with the change being applied over them. */
    shown: ScrcpyServerConfig;
    /** No stream value can be changed now: loading, applying, asking, or the phone is not there. */
    locked: boolean;
    connected: boolean;
    /**
     * Applies `fields` at once and restarts the stream. `retry` sends them even when the phone
     * already has them (Retry sound). Where other screens are open, the change is asked first.
     */
    change(fields: StreamConfigPatch, place: ChangePlace, retry?: boolean): void;
    /** The outcome line, or the question, for the group of `place`. */
    status(place: ChangePlace): ComponentChildren;
}

interface Options {
    /** One opening of the sheet. Each loads the phone's settings again. */
    opening?: object;
    tracker?: StreamConfigTracker;
    udid?: string;
    /** The server reaches the phone. Nothing is loaded or sent before it does. */
    connected: boolean;
    /** This phone's screen, when it is open in this browser. */
    client?: StreamClientScrcpy;
    name: string;
}

/**
 * Gives focus back to a control that was off while its change was asked or applied, if focus
 * fell to the sheet or the page meanwhile. Focus that moved somewhere else stays there.
 */
function refocus(control: HTMLElement | null | undefined): void {
    const active = document.activeElement;
    const fell = !active || active === document.body || active.matches('dialog');
    if (fell && control?.isConnected && !control.matches(':disabled') && control.closest('dialog[open]')) {
        control.focus({ preventScroll: true });
    }
}

/**
 * The stream values of an Android phone as the Settings sheet changes them: each control applies
 * when it is changed, the stream restarts, and 'Restarting stream…' then the result show under
 * the group of that control. The code knows of other viewers only through a screen open here
 * (`getClientsCount`); with one, the restart is asked first. Without one, it applies at once.
 */
export function useStreamChanges({ opening, tracker, udid, connected, client, name }: Options): StreamChanges {
    const config = useStreamConfig(connected ? opening : undefined, connected ? tracker : undefined, udid);
    const [place, setPlace] = useState<ChangePlace>();
    // The change being asked, and the control it was made with.
    const asking = useRef<{
        fields: StreamConfigPatch;
        place: ChangePlace;
        retry: boolean;
        others: number;
        control: HTMLElement | null;
    }>();
    const confirm = useArmedAction<ChangePlace>(!!opening);
    // The control that was changed. It is disabled while the change is applied, and gets focus
    // back afterwards if focus fell to the sheet meanwhile.
    const changed = useRef<HTMLElement | null>(null);

    useEffect(() => {
        setPlace(undefined);
    }, [opening]);

    // A question about a phone that has gone is withdrawn: nothing could be sent.
    useEffect(() => {
        if (!connected) {
            confirm.disarm();
        }
    }, [connected]);

    // On the render that ends an apply, so that it comes before anything pressed after it.
    const wasApplying = useRef(false);
    useLayoutEffect(() => {
        const ended = wasApplying.current && !config.applying;
        wasApplying.current = config.applying;
        const control = changed.current;
        if (!ended || !control) {
            return;
        }
        changed.current = null;
        // A sheet that is closing gives focus back to what opened it.
        if (opening) {
            refocus(control);
        }
    }, [config.applying]);

    // A question answered with Cancel, or withdrawn: the control was off while it was asked, so
    // the prompt could not hand focus back to it. A confirmed change hands it back when it ends.
    const wasAsking = useRef(false);
    useLayoutEffect(() => {
        const asked = wasAsking.current;
        wasAsking.current = !!confirm.armed;
        if (!asked || confirm.armed || config.applying || !opening) {
            return;
        }
        refocus(asking.current?.control);
    }, [confirm.armed]);

    const locked = config.applying || config.loading || !tracker || !connected || !!confirm.armed;
    const shown = { ...config.baseline, ...config.patch };

    const run = (fields: StreamConfigPatch, where: ChangePlace, retry: boolean, control: HTMLElement | null) => {
        changed.current = control;
        if (retry ? config.apply(fields) : config.change(fields)) {
            setPlace(where);
        }
    };

    const change = (fields: StreamConfigPatch, where: ChangePlace, retry = false) => {
        if (locked) {
            return;
        }
        const active = document.activeElement;
        const control = active instanceof HTMLElement ? active : null;
        const others = client?.getClientsCount() ?? 0;
        if (others > 0) {
            asking.current = { fields, place: where, retry, others, control };
            confirm.arm(where, control);
            return;
        }
        run(fields, where, retry, control);
    };

    const status = (where: ChangePlace): ComponentChildren => {
        const question = asking.current;
        if (confirm.armed === where && question && connected) {
            return (
                <ConfirmPrompt
                    action={confirm}
                    question={`Restart the stream of ${name}?`}
                    consequence={`${question.others} other open screen${question.others === 1 ? '' : 's'} will also reconnect.`}
                    confirmLabel="Restart stream"
                    onConfirm={() => run(question.fields, question.place, question.retry, question.control)}
                />
            );
        }
        if (place !== where) {
            return null;
        }
        if (config.applying) {
            return <SheetStatus>{RESTARTING_STREAM}</SheetStatus>;
        }
        if (config.applyError) {
            return <SheetStatus tone="error">{config.applyError}</SheetStatus>;
        }
        return config.appliedNote ? <SheetStatus tone="success">{config.appliedNote}</SheetStatus> : null;
    };

    return { config, shown, locked, connected, change, status };
}
