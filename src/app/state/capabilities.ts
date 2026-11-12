import type { DeviceEntry } from './devices';
import type { Platform } from './routes';

/** How a locked phone is unlocked from its page. */
export type UnlockKind = 'passcode-field' | 'server-passcode';
/** The power controls of a phone's page. */
export type PowerAction = 'power-key' | 'side-button' | 'reboot' | 'shutdown';

/**
 * What a phone's page can do, as data. Each value is what the code does today; the comment names
 * the place. The tabs, the Actions and Settings sheets, the controls and the list card choose
 * their rows from this table, not from the platform.
 */
export interface PhoneCapabilities {
    /** The Files tab. Also needs a build with INCLUDE_FILE_LISTING. */
    files: boolean;
    /** The Shell tab. Also needs a build with INCLUDE_ADB_SHELL. */
    shell: boolean;
    /** Notifications, Quick settings and Collapse in the Actions sheet. */
    panels: boolean;
    /** Rotate left and right in the Actions sheet. */
    rotate: boolean;
    /** Read the phone's clipboard into this browser. */
    clipboardRead: boolean;
    /** Paste text into the focused field on the phone. Without it, text only goes to the phone's clipboard. */
    clipboardPaste: boolean;
    unlock: UnlockKind;
    power: readonly PowerAction[];
    /** Unlock at set times with the passcode stored on the server. */
    scheduledUnlock: boolean;
    /** Bitrate, frame rate, resolution, codec and encoder. */
    streamQuality: boolean;
    /** The Type text sheet. */
    typeText: boolean;
}

const ANDROID: PhoneCapabilities = {
    // views/ToolView.tsx `deviceTools`; Files and Shell run over adb (state/devices.ts).
    files: true,
    shell: true,
    // views/ActionsSheet.tsx `screen.panel`, in the Screen group of views/actions/ScreenGroup.tsx.
    panels: true,
    // No rotate control on Android: the picture follows the phone.
    rotate: false,
    // views/ActionsSheet.tsx `clipboard.read`, GET_CLIPBOARD.
    clipboardRead: true,
    // views/ActionsSheet.tsx `clipboard.send`, SET_CLIPBOARD with paste.
    clipboardPaste: true,
    // state/unlockDevice.ts `androidUnlock`: the owner types the PIN or password into a field.
    unlock: 'passcode-field',
    // controls/androidControls.ts Lock, the Power key; views/ActionsSheet.tsx `sideButton`.
    power: ['power-key'],
    // The schedule is an iPhone feature (views/settings/ScheduledUnlock.tsx).
    scheduledUnlock: false,
    // views/settings/StreamSection.tsx, the quality presets and values.
    streamQuality: true,
    // controls/androidControls.ts, Type text.
    typeText: true,
};

const IOS: PhoneCapabilities = {
    // state/devices.ts `supportsDeviceTools`: no adb on an iPhone.
    files: false,
    shell: false,
    panels: false,
    // views/ApplActionsSheet.tsx `screen.rotate`.
    rotate: true,
    // views/ApplActionsSheet.tsx `clipboard.read`.
    clipboardRead: true,
    // views/ApplActionsSheet.tsx `clipboard.send` sets the phone's clipboard only.
    clipboardPaste: false,
    // state/unlockDevice.ts `iphoneUnlock`: the passcode stored on the server is typed by the server.
    unlock: 'server-passcode',
    // controls/iphoneControls.ts Lock (the side button); views/ApplActionsSheet.tsx `sideButton`,
    // Reboot and Shut down.
    power: ['side-button', 'reboot', 'shutdown'],
    // views/settings/ScheduledUnlock.tsx, in the Unlock section of Settings.
    scheduledUnlock: true,
    // The iPhone stream has no quality settings.
    streamQuality: false,
    // controls/iphoneControls.ts, Type text.
    typeText: true,
};

const TABLE: Record<Platform, PhoneCapabilities> = { android: ANDROID, ios: IOS };

/** What the page of a phone, or of a kind of phone, can do. */
export function capabilities(target: DeviceEntry | Platform): PhoneCapabilities {
    return TABLE[typeof target === 'string' ? target : target.params.type];
}

// p5-actions-sheet: rows of the Actions sheet that the table above does not cover.
/** What the Actions sheet of a phone can do beyond `PhoneCapabilities`. */
export interface ActionCapabilities {
    /** Refresh picture, Restart video and Reconnect in the Screen group. */
    pictureRecovery: boolean;
}

const ACTION_TABLE: Record<Platform, ActionCapabilities> = {
    // The scrcpy stream client sends none of these.
    android: { pictureRecovery: false },
    // views/ApplActionsSheet.tsx: requestKeyframe, restartStream and restartSession.
    ios: { pictureRecovery: true },
};

export function actionCapabilities(target: DeviceEntry | Platform): ActionCapabilities {
    return ACTION_TABLE[typeof target === 'string' ? target : target.params.type];
}

// p5-controls: the keys of the phone that the controls of its screen press
// (controls/definition.ts), beside `power` and `typeText` above.

/** A key or button of the phone that the controls press. `volume` is both volume keys. */
export type PhoneKey = 'back' | 'home' | 'overview' | 'volume' | 'mute' | 'siri';

const PHONE_KEYS: Record<Platform, readonly PhoneKey[]> = {
    // controls/androidControls.ts: KEYCODE_BACK, KEYCODE_HOME, KEYCODE_APP_SWITCH, the volume
    // keys and KEYCODE_VOLUME_MUTE.
    android: ['back', 'home', 'overview', 'volume', 'mute'],
    // controls/iphoneControls.ts. No Back and no Overview: iOS has no Back key, and no way to open
    // the app switcher from here works on a Face ID phone (docs/HANDOFF.md).
    ios: ['home', 'volume', 'mute', 'siri'],
};

/** The keys of a phone, or of a kind of phone, that its controls press. */
export function phoneKeys(target: DeviceEntry | Platform): readonly PhoneKey[] {
    return PHONE_KEYS[typeof target === 'string' ? target : target.params.type];
}

// p5-list-rows
/** What the card of a phone on the list offers besides the pages of the phone. */
export interface CardCapabilities {
    /** Wake from the card: the server sends the wake key through adb (`googDevice/client/wake.ts`). */
    wake: boolean;
    /**
     * The stream service can be started from the card (`ControlCenterCommand.START_SERVER`). The
     * card then says when the service is not running.
     */
    startStreamService: boolean;
    /** The screen plays in one of this browser's players (`StreamClientScrcpy.getPlayers()`). */
    player: boolean;
}

const ANDROID_CARD: CardCapabilities = { wake: true, startStreamService: true, player: true };
// No wake request from the list, and the session starts when the screen opens.
const IOS_CARD: CardCapabilities = { wake: false, startStreamService: false, player: false };

const CARD_TABLE: Record<Platform, CardCapabilities> = { android: ANDROID_CARD, ios: IOS_CARD };

/** What the card of a phone, or of a kind of phone, offers. */
export function cardCapabilities(target: DeviceEntry | Platform): CardCapabilities {
    return CARD_TABLE[typeof target === 'string' ? target : target.params.type];
}
