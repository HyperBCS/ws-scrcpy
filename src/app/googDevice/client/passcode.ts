import { ControlMessage } from '../../controlMessage/ControlMessage';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { TextControlMessage } from '../../controlMessage/TextControlMessage';
import KeyEvent from '../android/KeyEvent';

export const MAX_PASSCODE_LENGTH = 128;

/** Only messages created by our unlock flow are safe to show; never echo transport errors. */
export class UnlockRequestError extends Error {}

export function validatePasscode(passcode: string): void {
    if (!passcode.length || passcode.length > MAX_PASSCODE_LENGTH) {
        throw new UnlockRequestError(`Enter a PIN or password of 1–${MAX_PASSCODE_LENGTH} characters.`);
    }
    // Stock scrcpy synthesizes key events, so it cannot inject arbitrary Unicode text.
    // Reject unsupported input before touching the lock screen, rather than submitting a
    // silently truncated credential. Printable ASCII is covered by Android's virtual keymap.
    if (!/^[\x20-\x7e]+$/.test(passcode)) {
        throw new UnlockRequestError(
            'Remote passwords support English letters, numbers and standard symbols. Use the device for other characters.',
        );
    }
}

export function keyPress(keycode: number): KeyCodeControlMessage[] {
    return [
        new KeyCodeControlMessage(KeyEvent.ACTION_DOWN, keycode, 0, 0),
        new KeyCodeControlMessage(KeyEvent.ACTION_UP, keycode, 0, 0),
    ];
}

export function passcodeMessages(passcode: string): ControlMessage[] {
    validatePasscode(passcode);
    // PIN widgets do not support Ctrl+A. Backspace also works for password fields and
    // clears partial input left on the device before this one explicit submission.
    const messages: ControlMessage[] = [];
    for (let i = 0; i < MAX_PASSCODE_LENGTH; i++) {
        messages.push(...keyPress(KeyEvent.KEYCODE_DEL));
    }
    messages.push(new TextControlMessage(passcode), ...keyPress(KeyEvent.KEYCODE_ENTER));
    return messages;
}
