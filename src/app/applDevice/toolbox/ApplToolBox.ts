import { ToolBox } from '../../toolbox/ToolBox';
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
import { ToolBoxElement } from '../../toolbox/ToolBoxElement';
import SvgImage, { Icon } from '../../ui/SvgImage';
import { CoreDeviceButton } from '../../../common/CoreDeviceProtocol';
import { openSheet, streamNotice } from '../../state/stream';
import { createSoundButton } from '../../toolbox/soundButton';
import type { AudioSession } from '../../state/audio';
import type { StreamClientCoreDevice } from '../client/StreamClientCoreDevice';

export interface ApplToolBoxOptions {
    // Sound stays reachable when playback is unavailable so the button can explain why.
    audioSession?: AudioSession;
}

// Same shape as the Android toolbox so `FloatingToolbar` lays both out identically: a row of
// navigation (Home, Lock -- the Android row is Back, Home, Overview), a row of volume, then Siri
// with the session controls. `hold` marks buttons that can be held, which the server sends as
// down/up. There is no app-switcher button: iOS offers no way to open the switcher from here that
// works on a Face ID phone (docs/HANDOFF.md), and one that silently did nothing was worse.
const BUTTONS: { title: string; name: CoreDeviceButton; icon: Icon; hold: boolean }[] = [
    { title: 'Home', name: 'home', icon: SvgImage.Icon.HOME, hold: true },
    { title: 'Lock', name: 'lock', icon: SvgImage.Icon.POWER, hold: true },
    { title: 'Volume down', name: 'volume-down', icon: SvgImage.Icon.VOLUME_DOWN, hold: true },
    { title: 'Mute device', name: 'mute', icon: SvgImage.Icon.VOLUME_OFF, hold: true },
    { title: 'Volume up', name: 'volume-up', icon: SvgImage.Icon.VOLUME_UP, hold: true },
    { title: 'Siri', name: 'siri', icon: SvgImage.Icon.MIC, hold: true },
];

export class ApplToolBox extends ToolBox {
    protected constructor(
        list: ToolBoxElement<any>[],
        private readonly cleanup: (() => void)[] = [],
    ) {
        super(list);
    }

    public static createToolBox(client: StreamClientCoreDevice, options: ApplToolBoxOptions = {}): ApplToolBox {
        const cleanup: (() => void)[] = [];
        const elements: ToolBoxElement<any>[] = BUTTONS.map((item) => {
            const button = new ToolBoxButton(item.title, item.icon, { name: item.name });
            const target = button.getElement();
            target.dataset.button = item.name;
            if (!item.hold) {
                target.addEventListener('click', () => client.pressButton(item.name, 'press'));
                return button;
            }
            // Hardware buttons on iOS need their hold time (Lock ~0.5 s, Siri ~1 s), which the
            // server applies for a `press`; down/up pairs are only sent for a genuine hold.
            let activePointer: number | undefined;
            let held = false;
            let holdTimer: ReturnType<typeof setTimeout> | undefined;
            const finish = () => {
                if (activePointer === undefined) {
                    return;
                }
                activePointer = undefined;
                if (holdTimer) {
                    clearTimeout(holdTimer);
                    holdTimer = undefined;
                }
                if (held) {
                    held = false;
                    client.pressButton(item.name, 'up');
                } else {
                    client.pressButton(item.name, 'press');
                }
            };
            target.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || activePointer !== undefined) {
                    return;
                }
                event.preventDefault();
                activePointer = event.pointerId;
                target.setPointerCapture(event.pointerId);
                holdTimer = setTimeout(() => {
                    holdTimer = undefined;
                    held = true;
                    client.pressButton(item.name, 'down');
                }, 700);
            });
            target.addEventListener('pointerup', finish);
            target.addEventListener('pointercancel', finish);
            target.addEventListener('lostpointercapture', finish);
            target.addEventListener('click', (event) => {
                if (event.detail === 0) {
                    client.pressButton(item.name, 'press');
                }
            });
            return button;
        });

        // Sound controls this browser's playback of the phone's audio; there is no Settings sheet
        // on this path, so an unavailable state is explained in the stream notice.
        elements.push(
            createSoundButton(
                options.audioSession,
                (message) => {
                    streamNotice.value = message;
                },
                cleanup,
            ),
        );

        const screenshot = new ToolBoxButton('Take screenshot', SvgImage.Icon.CAMERA);
        screenshot.addEventListener('click', () => {
            client.getPlayer()?.createScreenshot(client.getDeviceName());
        });
        elements.push(screenshot);

        const actions = new ToolBoxButton('Actions', SvgImage.Icon.MORE);
        actions.addEventListener('click', () => openSheet('tools'));
        elements.push(actions);

        const liveText = new ToolBoxButton('Type text', SvgImage.Icon.KEYBOARD);
        liveText.addEventListener('click', () => openSheet('liveText'));
        elements.push(liveText);

        return new ApplToolBox(elements, cleanup);
    }

    public release(): void {
        this.cleanup.splice(0).forEach((dispose) => dispose());
    }
}
