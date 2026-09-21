import { ToolBoxButton } from './ToolBoxButton';
import SvgImage from '../ui/SvgImage';
import { AudioSession, audioAvailability } from '../state/audio';
import { streamNotice } from '../state/stream';

/**
 * The toolbar's Sound button, shared by the Android and iOS toolboxes: reflects the browser
 * audio session's state on the icon and ARIA, toggles mute, and hands unavailable/error states
 * to `onUnavailable` (Android opens Settings, which explains and offers recovery; iOS shows the
 * message as a notice). Disposers are pushed onto `cleanup`.
 */
export function createSoundButton(
    session: AudioSession | undefined,
    onUnavailable: (message: string) => void,
    cleanup: (() => void)[],
): ToolBoxButton {
    const toggle = new ToolBoxButton('Sound', SvgImage.Icon.VOLUME_OFF);
    const button = toggle.getElement();
    button.dataset.control = 'audio';
    if (session) {
        let audioNotice = '';
        cleanup.push(
            session.status.subscribe((status) => {
                const audible = !session.isMuted();
                button.setAttribute('aria-pressed', String(audible));
                button.setAttribute('aria-description', status.message);
                button.dataset.audioState = status.state;
                button
                    .querySelector('svg')
                    ?.replaceWith(SvgImage.create(audible ? SvgImage.Icon.VOLUME_UP : SvgImage.Icon.VOLUME_OFF));
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
