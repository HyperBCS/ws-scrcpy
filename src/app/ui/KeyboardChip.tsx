import { keyboardCapture } from '../state/keyboardCapture';
import { Button } from './Button';
import '../../style/kit/KeyboardChip.css';

/** The current keyboard target. A press gives the phone the keyboard or releases it. */
export function KeyboardChip() {
    const state = keyboardCapture.value;
    return (
        <Button
            class="kit-keyboard-chip"
            size="compact"
            pressed={state.phone}
            disabled={!state.session}
            attributes={{ title: 'Ctrl+Alt+K releases the keyboard' }}
            onClick={() => state.session?.toggle()}
        >
            Keyboard: {state.phone ? 'phone' : 'this page'}
        </Button>
    );
}
