import { AudioSession, audioAvailability, listenStateLabel } from '../state/audio';
import { streamNotice } from '../state/stream';
import type { ListenAction } from './definition';

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
    /** The words under the icon: Listen, Listening, Waiting for audio or Blocked. None without sound. */
    caption?: string;
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
    const caption = listenStateLabel(status.state, !audible);
    // While the caption is the control's own name, the description is the message alone.
    const plain = caption === listenStateLabel('muted', true);
    return {
        caption,
        pressed: audible,
        description: plain ? status.message : `${caption}. ${status.message}`,
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
