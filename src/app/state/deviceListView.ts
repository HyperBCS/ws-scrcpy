// Where the Phones list was scrolled when it was last left, and the card a page was opened from.
// The page unmounts on every route change, so both are kept here and put back on return. Module
// state on purpose: a reload starts at the top, with nothing focused.
import type { DeviceEntry } from './devices';
import type { HostsStatus } from './hosts';

let scrollTop = 0;

export function rememberListScroll(value: number): void {
    scrollTop = value;
}

export function savedListScroll(): number {
    return scrollTop;
}

/** A control on a card: the card's key, and the control's address, or its name for a button. */
export interface CardControl {
    key: string;
    control: string;
}

let openedFrom: CardControl | undefined;

/** A link on a card opened another page. The list focuses that card when it is shown again. */
export function rememberOpenedCard(card: CardControl | undefined): void {
    openedFrom = card;
}

/** The card a page was opened from, once: a later return does not focus it again. */
export function takeOpenedCard(): CardControl | undefined {
    const card = openedFrom;
    openedFrom = undefined;
    return card;
}

/**
 * What the list shows. `loading` until the first list has come, so no empty state shows before
 * it; `empty` for a list with no phone; `disconnected` with no phone and no connection to the
 * server; `stale` while it keeps the phones of a tracker that is reconnecting; `ready` otherwise.
 */
export type ListState = 'loading' | 'empty' | 'disconnected' | 'stale' | 'ready';

export function listState(
    entries: ReadonlyArray<Pick<DeviceEntry, 'stale'>>,
    received: boolean,
    hosts: HostsStatus,
): ListState {
    if (entries.length) {
        return entries.some((entry) => entry.stale) ? 'stale' : 'ready';
    }
    if (hosts === 'disconnected' || hosts === 'error') {
        return 'disconnected';
    }
    return received ? 'empty' : 'loading';
}
