import KeyEvent from '../googDevice/android/KeyEvent';
import { KeyCodeControlMessage } from '../controlMessage/KeyCodeControlMessage';
import type { ControlMessage } from '../controlMessage/ControlMessage';
import type { BasePlayer } from '../player/BasePlayer';
import type { AudioSession } from '../state/audio';
import { closeAllSheets, openSheet } from '../state/stream';
import { openSettingsSheet } from '../state/settingsSheet';
import { createPhoneControls, KeyAction, PhoneControls, RunAction } from './definition';
import { watchListenNotice } from './listen';

/** What the controls need from the Android stream client. */
export interface AndroidControlClient {
    sendMessage(message: ControlMessage): void;
    getDeviceName(): string;
}

/** An Android key: down when pressed, up when let go, as a key code message each. */
function key(client: AndroidControlClient, code: number): KeyAction {
    const send = (action: number) => client.sendMessage(new KeyCodeControlMessage(action, code, 0, 0));
    return { kind: 'key', down: () => send(KeyEvent.ACTION_DOWN), up: () => send(KeyEvent.ACTION_UP) };
}

const run = (action: () => void): RunAction => ({ kind: 'run', run: action });

/** The actions of the controls of an Android phone's screen. */
export function createAndroidControls(
    udid: string,
    player: BasePlayer,
    client: AndroidControlClient,
    audioSession?: AudioSession,
): PhoneControls {
    // The settings sheet looks the tracker connection up by udid (`state/settingsSheet.ts`).
    const openSettings = () => {
        closeAllSheets();
        openSettingsSheet(udid);
    };
    return createPhoneControls(
        'android',
        {
            back: key(client, KeyEvent.KEYCODE_BACK),
            home: key(client, KeyEvent.KEYCODE_HOME),
            overview: key(client, KeyEvent.KEYCODE_APP_SWITCH),
            volumeDown: key(client, KeyEvent.KEYCODE_VOLUME_DOWN),
            mute: key(client, KeyEvent.KEYCODE_VOLUME_MUTE),
            volumeUp: key(client, KeyEvent.KEYCODE_VOLUME_UP),
            lock: key(client, KeyEvent.KEYCODE_POWER),
            // Stream settings explain an unavailable sound and offer the way back.
            listen: { kind: 'listen', session: audioSession, onUnavailable: openSettings },
            screenshot: player.supportsScreenshot
                ? run(() => player.createScreenshot(client.getDeviceName()))
                : undefined,
            typeText: run(() => openSheet('liveText')),
            actions: run(() => openSheet('tools')),
            settings: run(openSettings),
        },
        [watchListenNotice(audioSession)],
    );
}
