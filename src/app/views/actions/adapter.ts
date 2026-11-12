import type { DeviceEntry } from '../../state/devices';
import type { Platform } from '../../state/routes';

/** The answer to a request over the stream socket, matched to it by `id`. */
export interface RequestResult {
    id: number;
    ok: boolean;
    error?: string;
}

/**
 * What starting an action led to.
 * - `sent`: the message went out and nothing comes back for it.
 * - `not-sent`: the stream socket is closed, so nothing went out.
 * - `request`: a request over the stream socket, answered by a `result` with this `id`. Past
 *   `giveUpMs` the answer is not coming.
 */
export type Started = { kind: 'sent' } | { kind: 'not-sent' } | { kind: 'request'; id: number; giveUpMs: number };

export const SENT: Started = { kind: 'sent' };
export const NOT_SENT: Started = { kind: 'not-sent' };

/** A request whose id is `undefined` when the stream socket was closed and nothing was sent. */
export function request(id: number | undefined, giveUpMs: number): Started {
    return id === undefined ? NOT_SENT : { kind: 'request', id, giveUpMs };
}

export type PanelAction = 'notifications' | 'quickSettings' | 'collapse';
export type PowerCommand = 'reboot' | 'shutdown';

/**
 * What the one Actions sheet needs from a kind of phone: the actions it can run, as functions.
 * Which rows the sheet shows comes from `capabilities()`, not from which functions are here; a
 * function is here because its row is shown. Each function sends what that platform has always
 * sent for the action, and nothing more.
 *
 * The wrapper that builds an adapter reads no signal while it renders; what depends on one is a
 * function the sheet calls. A component that reads signals and holds no state is skipped when
 * its parent renders (`@preact/signals` answers `shouldComponentUpdate` for it), so the sheet
 * would close one render after the sheet that takes its place had opened, and the closing
 * dialog would pull focus back to its opener (Actions, then Type text).
 */
export interface ActionsAdapter {
    platform: Platform;
    /** The stream client. A new one (another phone, a new stream) clears the drafts and the notes. */
    sessionKey: object;
    /** The listed phone, for its name and its screen. */
    entry: () => DeviceEntry | undefined;
    /** Why the stream is off when it is not a reconnect, or ''. Read while the sheet is drawn. */
    pausedReason?: () => string;
    /** Answers to `request` actions. Returns the function that stops listening. */
    onResult?: (listener: (result: RequestResult) => void) => () => void;
    clipboard: {
        /** Asks the phone for its clipboard; the text comes back in `deviceClipboard`. */
        read: () => void;
        /**
         * How long a read waits. `recoveryNoteMs` is when to say that the server is restarting the
         * phone's clipboard service, which only the iPhone server does.
         */
        readTimeouts: { giveUpMs: number; recoveryNoteMs?: number };
        /** Android pastes the text into the focused field; an iPhone only takes it on its clipboard. */
        send: (text: string) => Started;
    };
    screen: {
        panel?: (which: PanelAction) => Started;
        rotate?: (direction: 'left' | 'right') => Started;
        refreshPicture?: () => Started;
        restartVideo?: () => Started;
        reconnect?: () => Started;
    };
    /** One short press of the side button. */
    sideButton?: () => void;
    /** A tracker command; `undefined` when the phone is no longer in the list. */
    power?: (command: PowerCommand, signal?: AbortSignal) => Promise<unknown> | undefined;
    /** Opens the Settings sheet of this phone. */
    openSettings: () => void;
}
