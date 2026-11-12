import { canOpenScreen, DeviceEntry } from './devices';
import { capabilities, cardCapabilities } from './capabilities';
import { DeviceProblem, derivePhoneStatus, phoneFacts, PhoneFacts, PhoneStatus } from './phoneStatus';

/*
 * The rules of a phone's card on the list, without its markup (`views/DeviceCard.tsx` draws it).
 * The chip is the one status. Under it at most one line says what is wrong or what to do, with
 * the one action for it. Open screen is always there, disabled when the screen cannot be opened,
 * and then the line says why.
 */

/** What the line under the head is about. A problem line has the kind of the problem. */
export type CardLineKind = 'unauthorized' | 'offline' | 'player' | 'stream-service' | DeviceProblem['kind'];

/** The one action of the line, where it has one. */
export type CardLineAction = 'enable-developer-mode' | 'restart-services' | 'open-settings' | 'start-stream-service';

export interface CardLine {
    kind: CardLineKind;
    action?: CardLineAction;
    /** The problem the line states, for a problem line. */
    problem?: DeviceProblem;
}

export interface PhoneCard {
    facts: PhoneFacts;
    status: PhoneStatus;
    line?: CardLine;
    /** Open screen can be followed. */
    openScreen: boolean;
    /** Wake beside the status of an asleep phone. */
    wake: boolean;
    /** The tool pages the card links to, in the order of the page's tabs. */
    tools: ReadonlyArray<'files' | 'shell'>;
}

const LINE_ACTION: Partial<Record<CardLineKind, CardLineAction>> = {
    'developer-mode': 'enable-developer-mode',
    session: 'restart-services',
    unlock: 'open-settings',
    'stream-service': 'start-stream-service',
};

/**
 * The card of a listed phone. `playable` says whether this browser has a player for a screen
 * that needs one (an Android stream). The line, most important first: the phone has not trusted
 * the server, it is offline, its first problem (Developer Mode first when it keeps the screen
 * from opening), no player, then a stream service that is not running on a phone that is
 * otherwise ready.
 */
export function phoneCard(entry: DeviceEntry, playable: boolean, now = Date.now()): PhoneCard {
    const facts = phoneFacts(entry, now);
    const status = derivePhoneStatus(facts);
    const can = capabilities(entry);
    const card = cardCapabilities(entry);
    const screenCanOpen = canOpenScreen(entry);
    const canPlay = !card.player || playable;
    const problem =
        (!screenCanOpen && facts.problems.find((item) => item.kind === 'developer-mode')) || facts.problems[0];
    const serviceIdle = facts.session === 'stopped' || facts.session === 'unknown';
    let kind: CardLineKind | undefined;
    if (status.status === 'unauthorized') {
        kind = 'unauthorized';
    } else if (status.status === 'offline') {
        kind = 'offline';
    } else if (problem) {
        kind = problem.kind;
    } else if (!canPlay) {
        kind = 'player';
    } else if (card.startStreamService && status.status === 'ready' && serviceIdle) {
        kind = 'stream-service';
    }
    const reachable = facts.trusted && facts.connected;
    return {
        facts,
        status,
        line: kind && { kind, action: LINE_ACTION[kind], problem: kind === problem?.kind ? problem : undefined },
        openScreen: screenCanOpen && canPlay,
        wake: card.wake && status.screen === 'asleep',
        tools: reachable ? (['files', 'shell'] as const).filter((view) => can[view]) : [],
    };
}
