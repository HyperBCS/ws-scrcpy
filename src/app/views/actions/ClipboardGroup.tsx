import { useEffect, useState } from 'preact/hooks';
import { Button } from '../../ui/Button';
import { TextAreaField } from '../../ui/Field';
import { SheetGroup, SheetRow, SheetStatus } from '../../ui/SheetControls';
import { CLIPBOARD_TOO_LONG_NOTE, clipboardTextTooLong } from '../../ui/clipboardLimit';
import { copyPhoneClipboardHere, PHONE_CLIPBOARD_EMPTY_NOTE } from '../../ui/copyText';
import { deviceClipboard, deviceClipboardError, openSheet } from '../../state/stream';
import type { ActionsAdapter } from './adapter';
import { GROUP, NOTE, ROW } from './actionRows';
import { runAction, TrackRequest } from './useStreamRequests';

export interface ClipboardState {
    draft: string;
    setDraft: (draft: string) => void;
    note: string;
    reading: boolean;
    sending: boolean;
    /** What the phone's clipboard held at the last read; `undefined` before one. */
    received: string | undefined;
    tooLong: boolean;
    onRead: () => void;
    onCopy: () => void;
    onSend: () => void;
}

/**
 * The clipboard of both kinds of phone: read it, show it, copy it to this browser, and send text
 * to the phone. One limit, one set of messages and one busy state; what goes to the phone is the
 * platform's own (`adapter.clipboard`). `paste` picks the row's words for the outcome.
 */
export function useClipboard(adapter: ActionsAdapter, paste: boolean, track: TrackRequest): ClipboardState {
    const [draft, setDraft] = useState('');
    const [note, setNote] = useState('');
    const [reading, setReading] = useState(false);
    const [sending, setSending] = useState(false);
    const received = deviceClipboard.value;
    const readError = deviceClipboardError.value;
    const tooLong = clipboardTextTooLong(draft);

    useEffect(() => {
        setDraft('');
        setNote('');
        setReading(false);
        setSending(false);
    }, [adapter.sessionKey]);

    useEffect(() => {
        if (!reading) {
            return;
        }
        if (readError) {
            setReading(false);
            setNote(readError);
            return;
        }
        if (received !== undefined) {
            setReading(false);
            setNote(received ? NOTE.read : PHONE_CLIPBOARD_EMPTY_NOTE);
            return;
        }
        // A phone whose clipboard service has stopped answering costs the iPhone server one
        // timeout, a restart of that service and one more try, around ten seconds, at the end of
        // which the read usually works. Say what is happening instead of sitting on "Reading…",
        // and only give up well past the point where the server would have answered either way.
        const { giveUpMs, recoveryNoteMs } = adapter.clipboard.readTimeouts;
        const slow =
            recoveryNoteMs === undefined ? undefined : setTimeout(() => setNote(NOTE.recovering), recoveryNoteMs);
        const timeout = setTimeout(() => {
            setReading(false);
            setNote(NOTE.noAnswer);
        }, giveUpMs);
        return () => {
            clearTimeout(slow);
            clearTimeout(timeout);
        };
    }, [reading, received, readError]);

    return {
        draft,
        setDraft,
        note,
        reading,
        sending,
        received,
        tooLong,
        onRead: () => {
            setReading(true);
            setNote(NOTE.reading);
            adapter.clipboard.read();
        },
        // On plain HTTP, where `navigator.clipboard` does not exist, this copies through a hidden
        // text area.
        onCopy: async () => setNote(await copyPhoneClipboardHere(received)),
        onSend: () => {
            if (!draft || tooLong) {
                return;
            }
            const started = adapter.clipboard.send(draft);
            if (started.kind === 'request') {
                setSending(true);
            }
            runAction(started, paste ? ROW.pasteText : ROW.sendText, setNote, track, () => setSending(false));
        },
    };
}

interface ClipboardGroupProps {
    state: ClipboardState;
    connected: boolean;
    /** Read the phone's clipboard into this browser. */
    canRead: boolean;
    /** The phone pastes sent text into its focused field; otherwise the text only goes to its clipboard. */
    canPaste: boolean;
    /** The Type text row, for a phone that cannot take pasted text. */
    showTypeText: boolean;
}

export function ClipboardGroup({ state, connected, canRead, canPaste, showTypeText }: ClipboardGroupProps) {
    const { draft, note, reading, sending, received, tooLong } = state;
    const send = canPaste ? ROW.pasteText : ROW.sendText;
    return (
        <SheetGroup
            title={GROUP.clipboard}
            status={
                tooLong ? (
                    <SheetStatus tone="error">{CLIPBOARD_TOO_LONG_NOTE}</SheetStatus>
                ) : (
                    note && <SheetStatus>{note}</SheetStatus>
                )
            }
        >
            {canRead && (
                <SheetRow title={ROW.readClipboard.title} description={ROW.readClipboard.description} layout="pair">
                    <Button size="compact" onClick={state.onRead} disabled={!connected || reading}>
                        {reading ? ROW.readClipboard.busy : ROW.readClipboard.button}
                    </Button>
                    <Button size="compact" onClick={state.onCopy} disabled={received === undefined}>
                        {ROW.readClipboard.copy}
                    </Button>
                </SheetRow>
            )}
            {canRead && received !== undefined && (
                <div class="kit-row kit-row-stack">
                    <TextAreaField
                        label={ROW.phoneClipboard.label}
                        labelHidden
                        value={received}
                        placeholder={ROW.phoneClipboard.placeholder}
                        readOnly
                        rows={3}
                    />
                </div>
            )}
            <SheetRow title={send.title} description={send.description} layout="stack">
                <TextAreaField
                    label={send.field}
                    labelHidden
                    placeholder={ROW.draftPlaceholder}
                    value={draft}
                    rows={3}
                    onInput={(event) => state.setDraft(event.currentTarget.value)}
                />
                <Button onClick={state.onSend} disabled={!connected || !draft || tooLong || sending}>
                    {send.button}
                </Button>
            </SheetRow>
            {showTypeText && (
                <SheetRow title={ROW.typeText.title} description={ROW.typeText.description}>
                    <Button size="compact" onClick={() => openSheet('liveText')} disabled={!connected}>
                        {ROW.typeText.button}
                    </Button>
                </SheetRow>
            )}
        </SheetGroup>
    );
}
