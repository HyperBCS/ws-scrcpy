import type { DeviceEntry } from './devices';
import type { Platform } from './routes';

/** How a locked phone is unlocked from its page. */
export type UnlockKind = 'passcode-field' | 'server-passcode';
/** The power controls of a phone's page. */
export type PowerAction = 'power-key' | 'side-button' | 'reboot' | 'shutdown';

/**
 * What a phone's page can do, as data. Each value is what the code does today; the comment names
 * the place. The views still check the platform themselves in many places. They move onto this
 * table as the screens are rebuilt.
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
    // views/ActionsSheet.tsx, the "Phone panels" group.
    panels: true,
    // No rotate control on Android: the picture follows the phone.
    rotate: false,
    // views/ActionsSheet.tsx `onReadClipboard`, GET_CLIPBOARD.
    clipboardRead: true,
    // views/ActionsSheet.tsx `onPaste`, SET_CLIPBOARD with paste.
    clipboardPaste: true,
    // views/UnlockSheet.tsx: the owner types the PIN or password into a field.
    unlock: 'passcode-field',
    // googDevice/toolbox/GoogToolBox.ts, the Power key.
    power: ['power-key'],
    // The schedule is an iPhone feature (views/ApplSettingsSheet.tsx).
    scheduledUnlock: false,
    // views/SettingsSheet.tsx, "Stream quality".
    streamQuality: true,
    // googDevice/toolbox/GoogToolBox.ts, Type text.
    typeText: true,
};

const IOS: PhoneCapabilities = {
    // state/devices.ts `supportsDeviceTools`: no adb on an iPhone.
    files: false,
    shell: false,
    panels: false,
    // views/ApplActionsSheet.tsx `onRotate`.
    rotate: true,
    // views/ApplActionsSheet.tsx `onReadClipboard`.
    clipboardRead: true,
    // views/ApplActionsSheet.tsx `onSendClipboard` sets the phone's clipboard only.
    clipboardPaste: false,
    // views/ApplUnlockSheet.tsx: the passcode stored on the server is typed by the server.
    unlock: 'server-passcode',
    // applDevice/toolbox/ApplToolBox.ts Lock (the side button); views/ApplActionsSheet.tsx
    // Reboot and Shut down.
    power: ['side-button', 'reboot', 'shutdown'],
    // views/ApplSettingsSheet.tsx, "Scheduled unlock".
    scheduledUnlock: true,
    // The iPhone stream has no quality settings.
    streamQuality: false,
    // applDevice/toolbox/ApplToolBox.ts, Type text.
    typeText: true,
};

const TABLE: Record<Platform, PhoneCapabilities> = { android: ANDROID, ios: IOS };

/** What the page of a phone, or of a kind of phone, can do. */
export function capabilities(target: DeviceEntry | Platform): PhoneCapabilities {
    return TABLE[typeof target === 'string' ? target : target.params.type];
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
