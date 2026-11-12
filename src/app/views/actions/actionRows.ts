import type { UnlockKind } from '../../state/capabilities';

/**
 * The words of the Actions sheet for both kinds of phone, in one table: the group titles, the
 * row titles, descriptions and button labels, and the lines that report an outcome. The same
 * action has the same words on both. Where the two phones do different things the row is a
 * different one: Android pastes text into the focused field (`pasteText`), an iPhone only takes
 * it on its clipboard (`sendText`).
 *
 * `sending` is shown while the phone has not answered, `sent` once it has, or at once for an
 * action that gets no answer.
 */

export const ACTIONS_TITLE = 'Actions';

/** How the Unlock row says the phone is unlocked, by the kind of unlock it has. */
const UNLOCK_DESCRIPTION: Readonly<Record<UnlockKind, string>> = {
    'passcode-field': "Enter the phone's PIN or password.",
    'server-passcode': 'Uses the passcode stored on the server.',
};

/** The groups, in the order the sheet shows them. A platform with nothing for a group skips it. */
export const GROUP = {
    clipboard: 'Clipboard',
    screen: 'Screen',
    lock: 'Lock',
    power: 'Power',
} as const;

export const ROW = {
    readClipboard: {
        title: "Read the phone's clipboard",
        description: 'Copy from the phone to this browser.',
        button: 'Read',
        busy: 'Reading…',
        copy: 'Copy here',
    },
    phoneClipboard: {
        label: 'Phone clipboard',
        placeholder: 'The phone clipboard is empty',
    },
    pasteText: {
        title: 'Paste text on the phone',
        description: 'Tap a field on the phone, then paste.',
        field: 'Text to paste on the phone',
        button: 'Paste',
        sending: 'Pasting on the phone…',
        sent: 'Pasted into the focused field on the phone.',
    },
    sendText: {
        title: 'Send text to the phone',
        description: 'Copy to the phone, then paste in a field.',
        field: 'Text for the phone clipboard',
        button: 'Send to phone',
        sending: 'Sending to the phone clipboard…',
        sent: 'Sent. Long-press a field on the phone and choose Paste.',
    },
    draftPlaceholder: 'Type or paste text…',
    typeText: {
        title: 'Type text',
        description: 'Type into the focused field on the phone.',
        button: 'Open',
    },
    notifications: { title: 'Notifications', button: 'Open' },
    quickSettings: { title: 'Quick settings', button: 'Open' },
    collapsePanels: { title: 'Collapse panels', button: 'Collapse' },
    rotate: {
        title: 'Rotate',
        description: 'Apps with a fixed orientation may ignore this.',
        left: 'Left',
        right: 'Right',
        sending: 'Rotating…',
        sent: 'Done.',
    },
    refreshPicture: {
        title: 'Refresh picture',
        description: 'Refresh a smeared picture.',
        button: 'Refresh',
        sent: 'Asked for a new keyframe.',
    },
    restartVideo: {
        title: 'Restart video',
        description: 'For frozen or broken video.',
        button: 'Restart video',
        sending: 'Restarting the video…',
        sent: 'The video was restarted.',
    },
    reconnect: {
        title: 'Reconnect',
        description: 'Reconnect video, touch and keyboard.',
        button: 'Reconnect',
        sent: 'Reconnecting to the phone…',
    },
    unlock: {
        title: 'Unlock the phone',
        description: UNLOCK_DESCRIPTION,
        button: 'Unlock',
    },
    /** The side button on both: the Power key of an Android phone, the side button of an iPhone. */
    lock: {
        title: 'Lock the phone',
        description: 'Turns the screen off with the side button.',
        button: 'Lock',
    },
    reboot: {
        title: 'Reboot',
        description: 'Reconnects after restarting. If a passcode is set, unlock on the phone.',
        button: 'Reboot',
        question: (name: string): string => `Reboot ${name}?`,
        consequence: 'It reconnects after restarting. If a passcode is set, it has to be entered on the phone.',
        sending: 'Asking the phone to reboot…',
        sent: 'Rebooting…',
    },
    shutdown: {
        title: 'Shut down',
        description: 'Power it on using the phone’s button.',
        button: 'Shut down',
        question: (name: string): string => `Shut down ${name}?`,
        consequence: 'You cannot turn it back on from here.',
        sending: 'Asking the phone to shut down…',
        sent: 'Shutting down…',
    },
    settings: {
        title: 'Settings',
        button: 'Open',
        label: 'Open Settings',
    },
} as const;

/** The outcome lines that are not one row's own. */
export const NOTE = {
    /** Above the groups while the stream is down. */
    paused: 'Reconnecting to the phone. Actions that need the stream are paused until it is back.',
    /** Above the groups when this browser cannot decode an iPhone's video. */
    noDecoder: 'This browser cannot show the phone’s video. Actions that need the stream are off.',
    reading: 'Reading the phone clipboard…',
    read: 'Read from the phone.',
    /** A read that waits while the server restarts the phone's clipboard service. */
    recovering: 'The phone stopped answering. Restarting its clipboard service and trying again…',
    noAnswer: 'No answer from the phone. Check that it is still connected.',
    notSent: 'Not connected to the phone. Try again once the stream is back.',
    dropped: 'The connection dropped before the phone answered. Try again once the stream is back.',
    refused: 'The phone refused that action.',
    notListed: 'This phone is no longer in the list.',
    /** The phone in a confirm prompt when it is not in the list. */
    unnamedPhone: 'this phone',
} as const;
