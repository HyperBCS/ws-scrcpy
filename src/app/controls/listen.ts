import { AudioSession, audioAvailability, listenStateLabel } from '../state/audio';
import type { AudioPlaybackState } from '../state/audio';
import { streamNotice } from '../state/stream';
import type { ListenAction } from './definition';

/** Every state of the sound, so that every caption of the tile is known. */
const AUDIO_STATES: Record<AudioPlaybackState, true> = {
    muted: true,
    waiting: true,
    playing: true,
    blocked: true,
    disabled: true,
    error: true,
    unsupported: true,
    disconnected: true,
};

/**
 * The caption of the tile for the words of a state. "Waiting for audio" is too long for one line
 * of the rail, which is as wide as its resting captions ("Volume down"), so the tile says
 * "Waiting". The title and the description keep the full words.
 */
function tileCaption(words: string): string {
    return words === listenStateLabel('waiting', false) ? 'Waiting' : words;
}

/** Every caption the Listen tile can show. The rail is wide enough for each (`ControlRail.tsx`). */
export const LISTEN_CAPTIONS: readonly string[] = Array.from(
    new Set(
        (Object.keys(AUDIO_STATES) as AudioPlaybackState[]).flatMap((state) =>
            [false, true].map((muted) => tileCaption(listenStateLabel(state, muted))),
        ),
    ),
);

/**
 * Shows a playback error of the stream as the stream notice, and takes the notice away when
 * playback recovers. It lives as long as the stream, not as long as the controls are drawn.
 * Returns the disposer.
 */
export function watchListenNotice(session: AudioSession | undefined): () => void {
    if (!session) {
        return () => undefined;
    }
    let audioNotice = '';
    return session.status.subscribe((status) => {
        if (status.state === 'error' || status.state === 'unsupported') {
            audioNotice = status.message;
            streamNotice.value = status.message;
        } else if (audioNotice) {
            if (streamNotice.peek() === audioNotice) {
                streamNotice.value = '';
            }
            audioNotice = '';
        }
    });
}

export interface ListenView {
    /** The words under the icon: Listen, Listening, Waiting or Blocked. None without sound. */
    caption?: string;
    /** The state in full words, for the title: Listen, Listening, Waiting for audio or Blocked. */
    words?: string;
    /** Whether this browser plays the sound. */
    pressed: boolean;
    description: string;
    state: string;
}

/**
 * What the Listen control shows. Its name stays Listen; the state goes in the caption and the
 * description. Reads signals, so a component that calls it follows the playback state.
 */
export function listenView({ session }: ListenAction): ListenView {
    if (!session) {
        const availability = audioAvailability.value;
        return { pressed: false, description: availability.message, state: availability.state };
    }
    const status = session.status.value;
    const audible = !session.isMuted();
    const words = listenStateLabel(status.state, !audible);
    // While the words are the control's own name, the description is the message alone.
    const plain = words === listenStateLabel('muted', true);
    return {
        caption: tileCaption(words),
        words,
        pressed: audible,
        description: plain ? status.message : `${words}. ${status.message}`,
        state: status.state,
    };
}

/** A press on Listen: plays or stops the sound, or explains why there is none. */
export function pressListen({ session, onUnavailable }: ListenAction): void {
    if (!session) {
        onUnavailable(audioAvailability.value.message);
        return;
    }
    const status = session.status.value;
    if (status.state === 'disabled' || status.state === 'error' || status.state === 'unsupported') {
        onUnavailable(status.message);
    } else if (session.isMuted() || status.state === 'blocked') {
        // Called in the press, so the browser lets the page start playback.
        session.unmute();
    } else {
        session.mute();
    }
}
