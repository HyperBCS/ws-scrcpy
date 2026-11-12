import type { CoreDeviceButton } from '../../common/CoreDeviceProtocol';
import type { BasePlayer } from '../player/BasePlayer';
import type { AudioSession } from '../state/audio';
import { closeAllSheets, openSheet, streamNotice } from '../state/stream';
import { openSettings } from '../state/settingsSheet';
import { createPhoneControls, KeyAction, PhoneControls, RunAction } from './definition';
import { watchListenNotice } from './listen';

/** What the controls need from the iPhone stream client. */
export interface IphoneControlClient {
    pressButton(name: CoreDeviceButton, state: 'press' | 'down' | 'up'): void;
    getPlayer(): BasePlayer | undefined;
    getDeviceName(): string;
    getDeviceUdid(): string;
}

/**
 * A button of the iPhone. A tap is one `press`: the server holds the button for the time the
 * phone needs (Lock 0.3 s, Siri about 1 s). Down and up are sent only for a real hold.
 */
function button(client: IphoneControlClient, name: CoreDeviceButton): KeyAction {
    return {
        kind: 'key',
        down: () => client.pressButton(name, 'down'),
        up: () => client.pressButton(name, 'up'),
        tap: () => client.pressButton(name, 'press'),
    };
}

const run = (action: () => void): RunAction => ({ kind: 'run', run: action });

/** The actions of the controls of an iPhone's screen. */
export function createIphoneControls(client: IphoneControlClient, audioSession?: AudioSession): PhoneControls {
    return createPhoneControls(
        'ios',
        {
            home: button(client, 'home'),
            volumeDown: button(client, 'volume-down'),
            mute: button(client, 'mute'),
            volumeUp: button(client, 'volume-up'),
            lock: button(client, 'lock'),
            siri: button(client, 'siri'),
            // An unavailable sound is explained in the stream notice.
            listen: {
                kind: 'listen',
                session: audioSession,
                onUnavailable: (message) => {
                    streamNotice.value = message;
                },
            },
            screenshot: run(() => client.getPlayer()?.createScreenshot(client.getDeviceName())),
            typeText: run(() => openSheet('liveText')),
            actions: run(() => openSheet('tools')),
            settings: run(() => {
                closeAllSheets();
                openSettings(client.getDeviceUdid());
            }),
        },
        [watchListenNotice(audioSession)],
    );
}
