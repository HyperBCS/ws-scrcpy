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
