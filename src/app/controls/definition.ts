import type { IconName } from '../ui/icons';
import type { Platform } from '../state/routes';
import type { AudioSession } from '../state/audio';
import { capabilities, phoneKeys, PhoneKey } from '../state/capabilities';
import { HeldButtons, KeyAction } from './heldButtons';

export type { KeyAction };

/** The controls of a phone's screen. */
export type ControlId =
    | 'back'
    | 'home'
    | 'overview'
    | 'volumeDown'
    | 'mute'
    | 'volumeUp'
    | 'lock'
    | 'listen'
    | 'screenshot'
    | 'typeText'
    | 'actions'
    | 'settings'
    | 'siri';

export interface ControlDefinition {
    id: ControlId;
    /** The name: read out and shown on hover. */
    label: string;
    /** The words under the icon, where they differ from the name. */
    caption?: string;
    /** Read out after the name. */
    description?: string;
    icon: IconName;
    /**
     * The cell in a grid of three columns. Rows 1 to 4 are the same on every phone, and a cell
     * stays empty where a phone lacks the control, so a control is in the same place on both.
     */
    slot: { row: number; column: number };
    /**
     * A key of the phone that can be held: down while pressed, up when let go (`HeldButtons`).
     * Without it, a key is one tap per click (`ControlButton`).
     */
    hold: boolean;
    /** Sends to the phone, so it is disabled while the stream is not connected. */
    needsConnection: boolean;
    /** What the kind of phone must have (`state/capabilities.ts`). Without it, every phone has it. */
    requires?: { key: PhoneKey } | { capability: 'power' | 'typeText' };
}

/** Every control, in the order of its slot. */
export const CONTROLS: readonly ControlDefinition[] = [
    // Navigation, with Home in the middle.
    {
        id: 'back',
        label: 'Back',
        icon: 'navBack',
        slot: { row: 1, column: 1 },
        hold: true,
        needsConnection: true,
        requires: { key: 'back' },
    },
    {
        id: 'home',
        label: 'Home',
        icon: 'home',
        slot: { row: 1, column: 2 },
        hold: true,
        needsConnection: true,
        requires: { key: 'home' },
    },
    {
        id: 'overview',
        label: 'Overview',
        icon: 'square',
        slot: { row: 1, column: 3 },
        hold: true,
        needsConnection: true,
        requires: { key: 'overview' },
    },
    // Volume.
    {
        id: 'volumeDown',
        label: 'Volume down',
        icon: 'volDown',
        slot: { row: 2, column: 1 },
        hold: true,
        needsConnection: true,
        requires: { key: 'volume' },
    },
    {
        id: 'mute',
        label: 'Mute phone',
        description: 'Turns the sound of the phone off or on',
        icon: 'volMute',
        slot: { row: 2, column: 2 },
        hold: true,
        needsConnection: true,
        requires: { key: 'mute' },
    },
    {
        id: 'volumeUp',
        label: 'Volume up',
        icon: 'volUp',
        slot: { row: 2, column: 3 },
        hold: true,
        needsConnection: true,
        requires: { key: 'volume' },
    },
    // The side button, then this browser's sound and the picture.
    {
        id: 'lock',
        label: 'Lock',
        icon: 'power',
        slot: { row: 3, column: 1 },
        hold: true,
        needsConnection: true,
        requires: { capability: 'power' },
    },
    {
        id: 'listen',
        label: 'Listen',
        icon: 'headphones',
        slot: { row: 3, column: 2 },
        hold: false,
        needsConnection: false,
    },
    {
        id: 'screenshot',
        label: 'Take screenshot',
        caption: 'Screenshot',
        icon: 'camera',
        slot: { row: 3, column: 3 },
        hold: false,
        needsConnection: false,
    },
    // The sheets.
    {
        id: 'typeText',
        label: 'Type text',
        icon: 'text',
        slot: { row: 4, column: 1 },
        hold: false,
        needsConnection: false,
        requires: { capability: 'typeText' },
    },
    { id: 'actions', label: 'Actions', icon: 'bolt', slot: { row: 4, column: 2 }, hold: false, needsConnection: false },
    {
        id: 'settings',
        label: 'Settings',
        icon: 'sliders',
        slot: { row: 4, column: 3 },
        hold: false,
        needsConnection: false,
    },
    // Outside the shared rows: only an iPhone has it.
    {
        id: 'siri',
        label: 'Siri',
        icon: 'mic',
        slot: { row: 5, column: 1 },
        hold: true,
        needsConnection: true,
        requires: { key: 'siri' },
    },
];

/** The number of columns of the slot grid. */
export const SLOT_COLUMNS = 3;

/** The name of the group of controls, in the rail and in the panel. */
export const CONTROLS_LABEL = 'Phone controls';

/** A control that runs once when pressed. */
export interface RunAction {
    kind: 'run';
    run(): void;
}

/** The Listen control: this browser's playback of the phone's sound. */
export interface ListenAction {
    kind: 'listen';
    /** Undefined when this build or this browser has no sound. */
    session?: AudioSession;
    /** Explains why there is no sound (Android opens Settings, an iPhone shows a notice). */
    onUnavailable(message: string): void;
}

export type ControlAction = KeyAction | RunAction | ListenAction;

/** What a platform supplies for the controls of one stream. */
export interface PhoneControls {
    platform: Platform;
    /** The action of each control the platform supports. */
    actions: Partial<Record<ControlId, ControlAction>>;
    held: HeldButtons;
    /** The stream dropped: nothing more can be sent for a key that is still held. */
    forgetHeldButtons(): void;
    /** The stream closed: lets go of what is held and stops listening. */
    release(): void;
}

function offered(control: ControlDefinition, platform: Platform): boolean {
    const needs = control.requires;
    if (!needs) {
        return true;
    }
    if ('key' in needs) {
        return phoneKeys(platform).includes(needs.key);
    }
    const phone = capabilities(platform);
    if (needs.capability === 'power') {
        return phone.power.includes('power-key') || phone.power.includes('side-button');
    }
    return phone.typeText;
}

/** The controls a phone shows, each with its action, in slot order. */
export function shownControls(controls: PhoneControls): { definition: ControlDefinition; action: ControlAction }[] {
    return CONTROLS.flatMap((definition) => {
        const action = controls.actions[definition.id];
        return action && offered(definition, controls.platform) ? [{ definition, action }] : [];
    });
}

/** Builds the controls of one stream from a platform's actions. */
export function createPhoneControls(
    platform: Platform,
    actions: Partial<Record<ControlId, ControlAction>>,
    cleanup: (() => void)[] = [],
): PhoneControls {
    const held = new HeldButtons();
    return {
        platform,
        actions,
        held,
        forgetHeldButtons: () => held.forgetAll(),
        release: () => {
            held.destroy();
            cleanup.splice(0).forEach((dispose) => dispose());
        },
    };
}
