/**
 * The words for the state of a phone and of the page's connection to it, in one place, so that
 * the list, the switcher, a header and the screen say a state the same way. This is not a
 * translation layer: other strings stay with their views. `state/phoneStatus.ts` decides which
 * state applies; this file only says how each one reads.
 */

/** The page's connection to the phone: the header line, the overlay and the tool chip. */
export const CONNECTION = {
    connecting: 'Connecting…',
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    offline: 'Offline',
    failed: 'Unable to connect',
    stopped: 'Stopped',
    /** Under the overlay's word when a connection has taken a while. */
    slowHint: 'Check that the phone is online and unlocked.',
} as const;

/**
 * What the screen of an iPhone says in place of the general word, for a cause it knows. Each is
 * one of the connection states above (see `screenConnection`).
 */
export const SCREEN_CONNECTION = {
    startingStream: 'Starting the phone stream…',
    tryingAgain: 'Trying again…',
    streamUnavailable: 'Stream unavailable',
    streamStopped: 'Stream stopped',
    noPicture: 'No picture',
} as const;

/** The status of a phone in its chip, most serious first: the order of `PHONE_STATUS_ORDER`. */
export const STATUS = {
    unauthorized: 'Unauthorized',
    offline: 'Offline',
    error: 'Error',
    starting: 'Starting…',
    attention: 'Needs attention',
    asleep: 'Asleep',
    locked: 'Locked',
    ready: 'Ready',
} as const;

/** The phone's screen. */
export const SCREEN = {
    on: 'On',
    asleep: 'Asleep',
    unknown: 'Unknown',
    /** The banner on a card and the card over the picture. */
    asleepSentence: 'Screen is asleep',
} as const;

/** The phone's lock. */
export const LOCK = {
    locked: 'Locked',
    unlocked: 'Unlocked',
    unknown: 'Unknown',
    /** The notice over the screen of a phone that asks for its passcode. */
    notice: 'Phone locked',
    /**
     * The notice for a lock screen that asks for no passcode (Android reports it as not locked).
     * It is a second text because the owner does something else: a swipe on the picture, where
     * the passcode is refused.
     */
    swipeNotice: 'Swipe up to unlock',
} as const;

/** The screen session of a phone: an iPhone's session, or an Android phone's stream service. */
export const SESSION = {
    /** The second chip of a phone whose screen session runs, beside its status. */
    running: 'Session running',
    /** The switcher's mark on the phone this page shows. */
    viewing: 'Viewing',
    /** The value of the Session fact, by the iPhone's session state. */
    fact: {
        starting: 'Starting',
        ready: 'Running',
        error: 'Failed',
        stopped: 'Stopped',
    },
} as const;

/** The status line of the list: "3 available · 1 needs attention". */
export const LIST_SUMMARY = {
    waiting: 'Waiting for devices',
    noneAvailable: 'No devices available',
    separator: ' · ',
    available: (count: number): string => `${count} available`,
    attention: (count: number): string => `${count} ${count === 1 ? 'needs' : 'need'} attention`,
} as const;

/** What is wrong with a connected phone, said on its card. */
export const PROBLEM = {
    sessionFailed: 'The screen session failed.',
    developerMode: 'Enable Developer Mode to open the screen.',
} as const;

/** The value of a yes, no or on, off fact, such as Paired or Developer Mode. */
export const FACT = {
    yes: 'Yes',
    no: 'No',
    on: 'On',
    off: 'Off',
    unknown: 'Unknown',
} as const;

/** The stream service of an Android phone: its line on a card and in a header, and its tooltip. */
export const STREAM_SERVICE = {
    name: 'Stream service',
    running: { label: 'Running', description: 'The stream service is running on this phone.' },
    stopped: { label: 'Stopped', description: 'The stream service is stopped. Opening the screen starts it.' },
    starting: {
        label: 'Starting…',
        description: 'Waiting for the phone to confirm that its stream service started.',
    },
    offline: {
        label: 'Offline',
        description: 'The phone is disconnected, so its stream service cannot be checked.',
    },
    unauthorized: {
        label: 'Unauthorized',
        description: 'Approve USB debugging on the phone to check its stream service.',
    },
    unknown: { label: 'Unknown', description: 'The stream service status is not available yet.' },
    /** The card on the screen of an Android phone whose stream service the owner stopped. */
    stoppedTitle: 'Stream service stopped',
    stoppedMessage: 'The stream service on this phone was stopped. Start it to see the screen again.',
} as const;

// p5-screen-shell
/**
 * Why a listed phone cannot be reached, under its status word: the card on the stage of its
 * screen. The list's card can say the same.
 */
export const UNAVAILABLE_HINT = {
    unauthorized: 'Unlock this phone and approve the USB debugging or trust prompt to connect.',
    offline: 'Check the phone connection and keep it connected to the server.',
} as const;
