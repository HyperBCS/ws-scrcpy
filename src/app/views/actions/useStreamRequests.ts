import { useEffect, useRef } from 'preact/hooks';
import type { ActionsAdapter, Started } from './adapter';
import { NOTE } from './actionRows';

export type RequestOutcome = { ok: boolean; error?: string };
/** Shows the outcome of one request where its button is. */
export type Settle = (outcome: RequestOutcome) => void;
/** Waits for the answer to a request and passes it to `settle`. */
export type TrackRequest = (started: Extract<Started, { kind: 'request' }>, settle: Settle) => void;

/**
 * Requests waiting for a `result` on the stream socket, by id. Each has a time limit, and all of
 * them end when the socket drops: the answer to a request sent on the old socket is gone. A new
 * stream client ends them without a word.
 */
export function useStreamRequests(adapter: ActionsAdapter, connected: boolean): TrackRequest {
    const requests = useRef(new Map<number, { settle: Settle; timer: ReturnType<typeof setTimeout> }>());

    const finish = (id: number, outcome: RequestOutcome) => {
        const request = requests.current.get(id);
        if (!request) {
            return;
        }
        clearTimeout(request.timer);
        requests.current.delete(id);
        request.settle(outcome);
    };

    const endAll = (error?: string) => {
        for (const id of Array.from(requests.current.keys())) {
            if (error) {
                finish(id, { ok: false, error });
            } else {
                clearTimeout(requests.current.get(id)?.timer);
                requests.current.delete(id);
            }
        }
    };

    useEffect(() => {
        const stop = adapter.onResult?.((result) => finish(result.id, result));
        return () => {
            stop?.();
            endAll();
        };
    }, [adapter.sessionKey]);

    useEffect(() => {
        if (!connected) {
            endAll(NOTE.dropped);
        }
    }, [connected]);

    return (started, settle) => {
        const timer = setTimeout(() => finish(started.id, { ok: false, error: NOTE.noAnswer }), started.giveUpMs);
        requests.current.set(started.id, { settle, timer });
    };
}

/**
 * Starts an action and reports it in its group: `sending` until the phone answers a request,
 * then `sent` or the reason it failed. An action that gets no answer shows `sent` at once.
 */
export function runAction(
    started: Started,
    notes: { sending?: string; sent: string },
    setNote: (note: string) => void,
    track: TrackRequest,
    onSettled?: () => void,
): void {
    if (started.kind === 'not-sent') {
        setNote(NOTE.notSent);
    } else if (started.kind === 'sent') {
        setNote(notes.sent);
    } else {
        setNote(notes.sending ?? '');
        track(started, (outcome) => {
            onSettled?.();
            setNote(outcome.ok ? notes.sent : outcome.error || NOTE.refused);
        });
    }
}
