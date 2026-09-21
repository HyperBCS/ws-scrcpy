import { ToolBox } from '../../toolbox/ToolBox';
import KeyEvent from '../android/KeyEvent';
import SvgImage from '../../ui/SvgImage';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
import { ToolBoxElement } from '../../toolbox/ToolBoxElement';
import { StreamClientScrcpy } from '../client/StreamClientScrcpy';
import { BasePlayer } from '../../player/BasePlayer';
import { closeAllSheets, openSheet } from '../../state/stream';
import { openSettingsSheet } from '../../state/settingsSheet';
import { AudioSession } from '../../state/audio';
import { createSoundButton } from '../../toolbox/soundButton';

const BUTTONS = [
    // Keep each group together in the mobile panel's three-column grid.
    {
        title: 'Back',
        code: KeyEvent.KEYCODE_BACK,
        icon: SvgImage.Icon.BACK,
    },
    {
        title: 'Home',
        code: KeyEvent.KEYCODE_HOME,
        icon: SvgImage.Icon.HOME,
    },
    {
        title: 'Overview',
        code: KeyEvent.KEYCODE_APP_SWITCH,
        icon: SvgImage.Icon.OVERVIEW,
    },
    {
        title: 'Volume down',
        code: KeyEvent.KEYCODE_VOLUME_DOWN,
        icon: SvgImage.Icon.VOLUME_DOWN,
    },
    {
        title: 'Mute device',
        code: KeyEvent.KEYCODE_VOLUME_MUTE,
        icon: SvgImage.Icon.VOLUME_OFF,
    },
    {
        title: 'Volume up',
        code: KeyEvent.KEYCODE_VOLUME_UP,
        icon: SvgImage.Icon.VOLUME_UP,
    },
    {
        title: 'Power',
        code: KeyEvent.KEYCODE_POWER,
        icon: SvgImage.Icon.POWER,
    },
];

export interface GoogToolBoxOptions {
    // Start with keyboard capture enabled instead of requiring the user to open the tools sheet
    // and tick the checkbox first.
    captureKeyboard?: boolean;
    // Sound remains reachable when playback is unavailable so Settings can explain recovery.
    audioSession?: AudioSession;
}

export class GoogToolBox extends ToolBox {
    protected constructor(
        list: ToolBoxElement<any>[],
        private readonly cleanup: (() => void)[] = [],
    ) {
        super(list);
    }

    public static createToolBox(
        udid: string,
        player: BasePlayer,
        client: StreamClientScrcpy,
        options: GoogToolBoxOptions = {},
    ): GoogToolBox {
        const list = BUTTONS.slice();
        const cleanup: (() => void)[] = [];
        const elements: ToolBoxElement<any>[] = list.map((item) => {
            const button = new ToolBoxButton(item.title, item.icon, { code: item.code });
            const target = button.getElement();
            if (item.code === KeyEvent.KEYCODE_VOLUME_MUTE) {
                target.setAttribute('aria-description', 'Toggle the device volume mute');
            }
            let activePointer: number | undefined;
            const send = (action: number) => client.sendMessage(new KeyCodeControlMessage(action, item.code, 0, 0));
            const release = () => {
                if (activePointer === undefined) {
                    return;
                }
                activePointer = undefined;
                send(KeyEvent.ACTION_UP);
            };
            target.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || activePointer !== undefined) {
                    return;
                }
                event.preventDefault();
                activePointer = event.pointerId;
                target.setPointerCapture(event.pointerId);
                send(KeyEvent.ACTION_DOWN);
            });
            // Capture keeps releases outside a button paired, including a cancelled phone gesture.
            target.addEventListener('pointerup', release);
            target.addEventListener('pointercancel', release);
            target.addEventListener('lostpointercapture', release);
            target.addEventListener('click', (event) => {
                // Keyboard/assistive activation has no pointer events. Pointer clicks already sent
                // their down/up pair and must not trigger the command twice.
                if (event.detail === 0) {
                    send(KeyEvent.ACTION_DOWN);
                    send(KeyEvent.ACTION_UP);
                }
            });
            return button;
        });
        if (player.supportsScreenshot) {
            const screenshot = new ToolBoxButton('Take screenshot', SvgImage.Icon.CAMERA);
            screenshot.addEventListener('click', () => {
                player.createScreenshot(client.getDeviceName());
            });
            elements.push(screenshot);
        }

        // Keyboard capture is on by default (see `parseParameters`); `?captureKeyboard=0` opts
        // out. The toggle that lets a user change it interactively lives in `ToolsSheet`.
        if (options.captureKeyboard !== false) {
            client.setHandleKeyboardEvents(true);
        }

        // Replaces `ConfigureScrcpy` (the old 646-line manual-DOM dialog, deleted): a bottom
        // sheet with a "Playback" group (instant, client-side) and a "Stream quality" group
        // (codec/encoder/bitrate/..., behind an explicit Apply that restarts the scrcpy server).
        // The device-list tracker connection this needs (for LIST_ENCODERS/UPDATE_STREAM_CONFIG)
        // isn't this client's own -- it's looked up by udid, same as `DeviceSwitcherSheet` does.
        const tools = new ToolBoxButton('Actions', SvgImage.Icon.MORE);
        tools.addEventListener('click', () => {
            openSheet('tools');
        });
        elements.push(tools);

        const settings = new ToolBoxButton('Settings', SvgImage.Icon.TUNE);
        settings.addEventListener('click', () => {
            closeAllSheets();
            openSettingsSheet(udid);
        });
        elements.push(settings);

        const toggle = createSoundButton(
            options.audioSession,
            () => {
                closeAllSheets();
                openSettingsSheet(udid);
            },
            cleanup,
        );
        // Leave navigation and volume rows intact; Sound controls this browser's playback.
        elements.splice(BUTTONS.length, 0, toggle);

        const liveText = new ToolBoxButton('Type text', SvgImage.Icon.KEYBOARD);
        liveText.addEventListener('click', () => {
            // Used to be a blocking `window.prompt()` -- dead on a phone, which has no such
            // dialog worth using. `LiveTextOverlay` (rendered by `StreamView`) hosts a real input
            // so the on-screen keyboard can type into the device live.
            openSheet('liveText');
        });
        elements.push(liveText);

        return new GoogToolBox(elements, cleanup);
    }

    public release(): void {
        this.cleanup.splice(0).forEach((dispose) => dispose());
    }
}
