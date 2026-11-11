import { ToolBox } from '../../toolbox/ToolBox';
import KeyEvent from '../android/KeyEvent';
import type { IconName } from '../../ui/icons';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
import { ToolBoxElement } from '../../toolbox/ToolBoxElement';
import { StreamClientScrcpy } from '../client/StreamClientScrcpy';
import { BasePlayer } from '../../player/BasePlayer';
import { closeAllSheets, openSheet } from '../../state/stream';
import { openSettingsSheet } from '../../state/settingsSheet';
import { AudioSession } from '../../state/audio';
import { createSoundButton } from '../../toolbox/soundButton';
import { HeldButtons } from '../../toolbox/heldButtons';

const BUTTONS: { title: string; code: number; icon: IconName }[] = [
    // Keep each group together in the mobile panel's three-column grid.
    {
        title: 'Back',
        code: KeyEvent.KEYCODE_BACK,
        icon: 'navBack',
    },
    {
        title: 'Home',
        code: KeyEvent.KEYCODE_HOME,
        icon: 'home',
    },
    {
        title: 'Overview',
        code: KeyEvent.KEYCODE_APP_SWITCH,
        icon: 'square',
    },
    {
        title: 'Volume down',
        code: KeyEvent.KEYCODE_VOLUME_DOWN,
        icon: 'volDown',
    },
    {
        title: 'Mute device',
        code: KeyEvent.KEYCODE_VOLUME_MUTE,
        icon: 'volMute',
    },
    {
        title: 'Volume up',
        code: KeyEvent.KEYCODE_VOLUME_UP,
        icon: 'volUp',
    },
    {
        title: 'Power',
        code: KeyEvent.KEYCODE_POWER,
        icon: 'power',
    },
];

export interface GoogToolBoxOptions {
    // Physical keyboard capture at start. Settings can change it while streaming.
    captureKeyboard?: boolean;
    // Sound remains reachable when playback is unavailable so Settings can explain recovery.
    audioSession?: AudioSession;
}

export class GoogToolBox extends ToolBox {
    protected constructor(
        list: ToolBoxElement<any>[],
        private readonly cleanup: (() => void)[] = [],
        private readonly held?: HeldButtons,
    ) {
        super(list);
    }

    /** The stream disconnected: nothing more can be sent for a button that is still held. */
    public forgetHeldButtons(): void {
        this.held?.forgetAll();
    }

    public static createToolBox(
        udid: string,
        player: BasePlayer,
        client: StreamClientScrcpy,
        options: GoogToolBoxOptions = {},
    ): GoogToolBox {
        const list = BUTTONS.slice();
        const cleanup: (() => void)[] = [];
        const held = new HeldButtons();
        cleanup.push(() => held.destroy());
        const elements: ToolBoxElement<any>[] = list.map((item) => {
            const button = new ToolBoxButton(item.title, item.icon, { code: item.code });
            const target = button.getElement();
            if (item.code === KeyEvent.KEYCODE_VOLUME_MUTE) {
                target.setAttribute('aria-description', 'Toggle the device volume mute');
            }
            let activePointer: number | undefined;
            const send = (action: number) => client.sendMessage(new KeyCodeControlMessage(action, item.code, 0, 0));
            const end = (notify: boolean) => {
                if (activePointer === undefined) {
                    return;
                }
                activePointer = undefined;
                if (notify) {
                    send(KeyEvent.ACTION_UP);
                }
            };
            const release = () => end(true);
            // Also released when the window loses focus or the page is hidden mid-press.
            held.add(end);
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
            const screenshot = new ToolBoxButton('Take screenshot', 'camera');
            screenshot.addEventListener('click', () => {
                player.createScreenshot(client.getDeviceName());
            });
            elements.push(screenshot);
        }

        // Keyboard capture is on by default (see `parseParameters`); `?captureKeyboard=0` opts
        // out. The toggle that changes it while streaming is in `SettingsSheet`.
        if (options.captureKeyboard !== false) {
            client.setHandleKeyboardEvents(true);
        }

        const tools = new ToolBoxButton('Actions', 'bolt');
        tools.addEventListener('click', () => {
            openSheet('tools');
        });
        elements.push(tools);

        // The settings sheet has a "Playback" group (applied in this browser) and a "Stream
        // quality" group (applied with Apply, which restarts the scrcpy server). The tracker
        // connection it needs for LIST_ENCODERS and UPDATE_STREAM_CONFIG is not this client's own;
        // it is looked up by udid, as `DeviceSwitcherSheet` does.
        const settings = new ToolBoxButton('Settings', 'sliders');
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
        // Leave navigation and volume rows intact; Listen controls this browser's playback.
        elements.splice(BUTTONS.length, 0, toggle);

        const liveText = new ToolBoxButton('Type text', 'text');
        liveText.addEventListener('click', () => {
            // Used to be a blocking `window.prompt()` -- dead on a phone, which has no such
            // dialog worth using. `LiveTextOverlay` (rendered by `StreamView`) hosts a real input
            // so the on-screen keyboard can type into the device live.
            openSheet('liveText');
        });
        elements.push(liveText);

        return new GoogToolBox(elements, cleanup, held);
    }

    public release(): void {
        this.cleanup.splice(0).forEach((dispose) => dispose());
    }
}
