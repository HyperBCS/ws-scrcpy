import { ToolBoxButton } from './ToolBoxButton';
import { AudioSession, audioAvailability, listenStateLabel } from '../state/audio';
import { streamNotice } from '../state/stream';

/**
 * The toolbar's Listen button, shared by the Android and iOS toolboxes. It turns this browser's
 * playback on and off, so it is named and drawn apart from the phone's own volume keys: a
 * headphones icon, never a speaker, and a caption that states the playback state ("Listen",
 * "Listening", "Waiting for audio", "Blocked"). Unavailable and error states go to
 * `onUnavailable` (Android opens Stream settings, which explains and offers recovery; iOS shows
 * the message as a notice). Disposers are pushed onto `cleanup`.
 */
export function createSoundButton(
    session: AudioSession | undefined,
    onUnavailable: (message: string) => void,
    cleanup: (() => void)[],
): ToolBoxButton {
    const toggle = new ToolBoxButton('Listen', 'headphones');
    const button = toggle.getElement();
    button.dataset.control = 'audio';
    // A control that stays on: it says whether it is, also before a session reports.
    button.setAttribute('aria-pressed', 'false');
    // `FloatingToolbar` captions every button once from its title. This caption changes with the
    // playback state, so the button brings its own.
    const caption = document.createElement('span');
    caption.className = 'kit-icon-button-caption';
    caption.setAttribute('aria-hidden', 'true');
    caption.textContent = 'Listen';
    button.appendChild(caption);
    if (session) {
        let audioNotice = '';
        cleanup.push(
            session.status.subscribe((status) => {
                const audible = !session.isMuted();
                const label = listenStateLabel(status.state, !audible);
                caption.textContent = label;
                button.setAttribute('aria-pressed', String(audible));
                // The name stays "Listen"; the state and its explanation are the description.
                button.setAttribute(
                    'aria-description',
                    label === 'Listen' ? status.message : `${label}. ${status.message}`,
                );
                button.dataset.audioState = status.state;
                if (status.state === 'error' || status.state === 'unsupported') {
                    audioNotice = status.message;
                    streamNotice.value = status.message;
                } else if (audioNotice) {
                    if (streamNotice.peek() === audioNotice) {
                        streamNotice.value = '';
                    }
                    audioNotice = '';
                }
            }),
        );
        toggle.addEventListener('click', () => {
            const status = session.status.value;
            if (status.state === 'disabled' || status.state === 'error' || status.state === 'unsupported') {
                onUnavailable(status.message);
            } else if (session.isMuted() || status.state === 'blocked') {
                session.unmute();
            } else {
                session.mute();
            }
        });
    } else {
        cleanup.push(
            audioAvailability.subscribe((availability) => {
                button.setAttribute('aria-description', availability.message);
                button.dataset.audioState = availability.state;
            }),
        );
        toggle.addEventListener('click', () => onUnavailable(audioAvailability.value.message));
    }
    return toggle;
}
