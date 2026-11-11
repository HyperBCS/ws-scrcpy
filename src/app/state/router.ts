import { signal } from '@preact/signals';
import { canonicalRoute, parseRoute, rememberPhone, samePage } from './routes';

// The app has always used `#!key=value&...` deep links (documented in the README, produced by
// `BaseDeviceTracker.buildLink` historically). Keeping `location.hash` as the source of truth
// means bookmarked/shared links keep working with zero server-side routing.
//
// This module is the only one that writes history. It has three verbs:
//
//   openRoute    a new entry       list to a phone, list to Notifications, a notification to a screen
//   switchRoute  the same entry    a tab, another phone, a filter, a corrected address
//   goUp         back to the list  the back control of every header
//
// The list is the root: `goUp` steps back to the list entry instead of adding one, so the
// browser's Back from the list leaves the app and never reopens a phone's stream.
//
// `history.state` is shared. The router keeps `nav`, Files keeps `files`; both survive each
// other's writes. An overlay (a sheet, a dialog, a menu) has an entry of its own under the same
// address, marked in `nav`, so the browser's Back closes it.
//
// Overlay entries are counted, not owned: the open overlays that have an entry and the overlay
// entries on top of the page are kept equal in number. So one sheet can take the place of
// another without a step through history, and an overlay can close under one that stays open.
export type RouteParams = URLSearchParams;
export type NavigateParams = Record<string, string | number | boolean | undefined>;
export type RouteTarget = URLSearchParams | NavigateParams;

/** Where an entry sits, kept in `history.state.nav`. */
interface Nav {
    /** Counted from the first entry the app has in this tab. */
    index: number;
    /** The index of the nearest list entry below this one, -1 when there is none. */
    below: number;
    /** On an overlay's entry: how many overlay entries sit on the page, this one included. */
    overlay?: number;
    /**
     * On an overlay's entry: the page changed its address or state while the overlay was open.
     * The change is here, and the entry below takes it when this one is left.
     */
    moved?: boolean;
}

interface Overlay {
    onLeave: () => void;
    /** Whether it has a history entry. */
    entry: boolean;
    stays?: () => boolean;
}

export interface OverlayOptions {
    /**
     * False for an overlay that opens without a press. Chrome skips an entry that was added
     * without one when the owner goes back, and the page under it with it. Such an overlay has
     * no entry: Back leaves the page, and the overlay closes with the page.
     */
    entry?: boolean;
    /**
     * Asked when the browser's Back would close the overlay. True keeps it open: the router
     * steps forward to its entry again. Another page closes it whatever this says.
     */
    stays?: () => boolean;
}

/** A history entry that belongs to an open overlay. */
export interface OverlayEntry {
    /** The overlay closed by itself: its entry is stepped back over. Safe to call twice. */
    release(): void;
}

/** How long a step through history may take before the router stops waiting for it. */
const LANDING_MS = 1000;

function hashParams(hash: string = location.hash): RouteParams {
    return new URLSearchParams(hash.replace(/^#!/, ''));
}

function hashOf(params: RouteParams): string {
    return `#!${params.toString()}`;
}

function toSearchParams(target: RouteTarget): RouteParams {
    if (target instanceof URLSearchParams) {
        return target;
    }
    const usp = new URLSearchParams();
    Object.entries(target).forEach(([key, value]) => {
        if (value !== undefined) {
            usp.set(key, String(value));
        }
    });
    return usp;
}

/**
 * The address the app keeps for `params`: an older phone address in its new form. The older
 * address of a screen named the platform, which the new one does not, so it is remembered here.
 */
function canonical(params: RouteParams): RouteParams {
    const target = parseRoute(params);
    if (target.page === 'device' && target.view === 'screen' && target.platform) {
        rememberPhone(target.udid, target.platform);
    }
    return canonicalRoute(params);
}

function isList(hash: string): boolean {
    return parseRoute(hashParams(hash)).page === 'list';
}

function readNav(state: unknown): Nav | undefined {
    const nav = (state as { nav?: Partial<Nav> } | null)?.nav;
    if (!nav || !Number.isInteger(nav.index) || !Number.isInteger(nav.below)) {
        return undefined;
    }
    const overlay = Number.isInteger(nav.overlay) && (nav.overlay as number) > 0 ? nav.overlay : undefined;
    return {
        index: nav.index as number,
        below: nav.below as number,
        ...(overlay ? { overlay } : {}),
        ...(overlay && nav.moved ? { moved: true } : {}),
    };
}

function withNav(state: unknown, nav: Nav): Record<string, unknown> {
    return { ...(state && typeof state === 'object' ? state : {}), nav };
}

function position(): Nav {
    return readNav(history.state) ?? { index: 0, below: -1 };
}

/** `below` for an entry made on top of the entry `nav`, whose address is `hash`. */
function belowAfter(nav: Nav, hash: string): number {
    return isList(hash) && !nav.overlay ? nav.index : nav.below;
}

// A link opened in this tab, a reload, or a return from another site. An older address is
// rewritten before anything reads the route, so the first view to mount is the only one: a
// stream view that mounted under the old address and again under the new one would start two
// sessions on the phone.
{
    const params = hashParams();
    const next = canonical(params);
    if (next !== params || !readNav(history.state)) {
        history.replaceState(withNav(history.state, position()), '', next !== params ? hashOf(next) : undefined);
    }
}

export const route = signal<RouteParams>(hashParams());

/**
 * Runs `listener` each time another page is shown: the list, Notifications, or another view or
 * phone. A change within the page (a Files folder, a corrected path, a filter, another player)
 * does not count. Returns the function that stops it.
 */
export function onPageChange(listener: () => void): () => void {
    let page = route.peek();
    return route.subscribe((next) => {
        const left = !samePage(next, page);
        page = next;
        if (left) {
            listener();
        }
    });
}

/**
 * Something on the current page that must not be dropped without asking, such as uploads in
 * progress. `blocks` says whether going to `next` would drop it; `ask` puts the question and
 * resolves to true when the owner chooses to leave anyway.
 */
export interface LeaveGuard {
    blocks(next: RouteParams): boolean;
    ask(): Promise<boolean>;
}

let leaveGuard: LeaveGuard | undefined;
/**
 * The address and history state of the entry the app is on: the page that is shown, or the top
 * overlay on it. It is where to return to when leaving is refused, and what the entry below an
 * overlay takes over when the overlay is left.
 */
let shown = { hash: location.hash, state: history.state as unknown };

function seen(): void {
    shown = { hash: location.hash, state: history.state };
}

export function setLeaveGuard(guard: LeaveGuard): void {
    leaveGuard = guard;
}

/** Removes `guard`, if it is still the one in place. */
export function clearLeaveGuard(guard: LeaveGuard): void {
    if (leaveGuard === guard) {
        leaveGuard = undefined;
    }
}

const overlays: Overlay[] = [];

/** Closes every open overlay. Their history entries are left to the caller. */
function closeOverlays(): void {
    overlays
        .splice(0)
        .reverse()
        .forEach((overlay) => overlay.onLeave());
}

function accept(): void {
    const next = hashParams();
    if (!samePage(next, hashParams(shown.hash))) {
        // An overlay belongs to the page it was opened on. A change within that page (a
        // corrected path, a filter) leaves it open.
        closeOverlays();
    }
    seen();
    route.value = next;
}

// `history.go()` and `history.back()` finish later, in a task of their own. Until the browser
// reports the entry they were heading for, anything else that would write history waits here:
// an entry pushed in between would be the one stepped back over.
let landing: number | undefined;
let landingTimer: ReturnType<typeof setTimeout> | undefined;
const waiting: Array<() => void> = [];

function landed(): void {
    clearTimeout(landingTimer);
    landing = undefined;
    while (waiting.length && landing === undefined) {
        waiting.shift()?.();
    }
}

const stepListeners = new Set<() => void>();

/**
 * Runs `listener` each time the tab steps through history: when the router starts a step, and
 * when the browser reports one the router did not start (Back, Forward). Returns the function
 * that stops it.
 */
export function onHistoryStep(listener: () => void): () => void {
    stepListeners.add(listener);
    return () => void stepListeners.delete(listener);
}

function stepped(): void {
    stepListeners.forEach((listener) => listener());
}

/** Steps through history. `then` runs on arrival, before anything that was already waiting. */
function travel(delta: number, then?: () => void): void {
    if (!delta) {
        // `history.go(0)` would reload the page.
        then?.();
        return;
    }
    stepped();
    landing = (landing ?? position().index) + delta;
    if (then) {
        waiting.unshift(then);
    }
    clearTimeout(landingTimer);
    // A step the browser never reports must not hold the app up for good.
    landingTimer = setTimeout(landed, LANDING_MS);
    history.go(delta);
}

function whenLanded(run: () => void): void {
    if (landing === undefined && !waiting.length) {
        run();
    } else {
        waiting.push(run);
    }
}

/**
 * Closes the open overlays and steps back over their entries, then runs `then` on the entry of
 * the page itself. A route written from an overlay's entry would leave the page's own entry
 * below it, and Back would show that page again.
 */
function leaveOverlays(then: () => void): void {
    closeOverlays();
    whenLanded(() => {
        const over = position().overlay;
        if (over) {
            travel(-over, then);
        } else {
            then();
        }
    });
}

function write(next: RouteParams, mode: 'push' | 'replace', state: unknown): void {
    const hash = hashOf(next);
    const here = position();
    if (mode === 'replace') {
        // Under an open overlay the write goes to the overlay's entry, which is the one the tab
        // is on. The page's entry takes it when the overlay is left; see `carryDown`.
        const nav: Nav = here.overlay ? { ...here, moved: true } : { index: here.index, below: here.below };
        history.replaceState(withNav(state, nav), '', hash);
    } else if (location.hash !== hash) {
        const nav = { index: here.index + 1, below: belowAfter(here, location.hash) };
        history.pushState(withNav(state, nav), '', hash);
    }
    if (mode === 'push' || location.hash !== shown.hash) {
        accept();
    } else {
        seen();
    }
}

/**
 * Called when the browser reports the entry `here`. If the tab came down from an overlay's entry
 * that holds a change of the page (`moved`), the entry reached takes that address and state. The
 * change then is on the page's own entry, and Back from the page does not undo it.
 */
function carryDown(here: Nav): void {
    const from = readNav(shown.state);
    if (!from?.overlay || !from.moved || here.index >= from.index || here.index < from.index - from.overlay) {
        return;
    }
    const nav: Nav = here.overlay ? { ...here, moved: true } : { index: here.index, below: here.below };
    history.replaceState(withNav(shown.state, nav), '', shown.hash);
}

function commit(target: RouteTarget, mode: 'push' | 'replace', state: unknown): void {
    const next = canonical(toSearchParams(target));
    const guard = leaveGuard;
    if (guard?.blocks(next)) {
        void guard.ask().then((leave) => {
            if (leave) {
                clearLeaveGuard(guard);
                commit(next, mode, state);
            }
        });
        return;
    }
    // A change within the page that is shown (a Files folder or a corrected path, a filter,
    // another player) belongs to that page. If a step through history that was already under
    // way has left the page by the time it can be written (the back control was pressed a moment
    // before), it is dropped: written then, it would show the page again over the list.
    const from = samePage(next, hashParams()) ? hashParams() : undefined;
    if (from && mode === 'replace') {
        // The tab stays on the entry it is on, so an open overlay stays open. Code makes these
        // changes by itself (a listing that corrects the path, a filter, the state Files tags
        // its entries with), and a sheet must not close under the owner's hands for one.
        whenLanded(() => {
            if (samePage(hashParams(), from)) {
                write(next, mode, state);
            }
        });
        return;
    }
    leaveOverlays(() => {
        if (from && !samePage(hashParams(), from)) {
            return;
        }
        write(next, mode, state);
    });
}

/** Opens a page as a new history entry, so the browser's Back returns to this one. */
export function openRoute(target: RouteTarget): void {
    commit(target, 'push', undefined);
}

/** Shows another address in the current history entry. Back and Forward are unaffected. */
export function switchRoute(target: RouteTarget): void {
    commit(target, 'replace', undefined);
}

function showList(): void {
    if (!isList(location.hash)) {
        write(new URLSearchParams(), 'replace', undefined);
    } else if (location.hash !== shown.hash) {
        accept();
    }
}

/**
 * Goes to the list without adding an entry: back to the list entry below this page, or, when
 * the tab was opened on this page, to the first entry the app has, which becomes the list.
 */
export function goUp(): void {
    const guard = leaveGuard;
    if (guard?.blocks(new URLSearchParams())) {
        void guard.ask().then((leave) => {
            if (leave) {
                clearLeaveGuard(guard);
                goUp();
            }
        });
        return;
    }
    leaveOverlays(() => {
        const here = position();
        const target = here.below >= 0 ? here.below : 0;
        if (!isList(location.hash) && target < here.index) {
            // On arrival the entry is checked: if it is not the list any more, it becomes it.
            travel(target - here.index, showList);
        } else {
            showList();
        }
    });
}

/** Makes the overlay entries on top of the page as many as the open overlays that have one. */
function settleOverlays(): void {
    whenLanded(() => {
        const want = overlays.filter((overlay) => overlay.entry).length;
        let here = position();
        const have = here.overlay ?? 0;
        if (have > want) {
            travel(want - have);
            return;
        }
        for (let count = have; count < want; count++) {
            here = { index: here.index + 1, below: belowAfter(here, location.hash), overlay: count + 1 };
            history.pushState(withNav(history.state, here), '');
        }
        // Not while an assigned address is still to be reported: `hashchange` reads `shown`.
        if (want > have && location.hash === shown.hash) {
            seen();
        }
    });
}

let settling = false;

/**
 * The same, once the code that is running has finished. A sheet that takes the place of another
 * in the same task then takes its entry over, whichever of the two the router hears of first,
 * and history is not touched.
 */
function settleOverlaysSoon(): void {
    if (settling) {
        return;
    }
    settling = true;
    queueMicrotask(() => {
        settling = false;
        settleOverlays();
    });
}

/**
 * Gives an open overlay a history entry under the same address. `onLeave` runs when that entry
 * is left: by the browser's Back, or because another page is shown. An overlay that closes by
 * itself calls `release`; one that is open on top of it stays open and keeps an entry. Views
 * use `ui/overlayHistory.ts`.
 */
export function pushOverlay(onLeave: () => void, options: OverlayOptions = {}): OverlayEntry {
    const overlay: Overlay = { onLeave, entry: options.entry !== false, stays: options.stays };
    overlays.push(overlay);
    if (overlay.entry) {
        settleOverlaysSoon();
    }
    return {
        release: () => {
            const at = overlays.indexOf(overlay);
            if (at < 0) {
                return;
            }
            overlays.splice(at, 1);
            if (overlay.entry) {
                settleOverlaysSoon();
            }
        },
    };
}

/** An entry a link or an assigned hash made has no `nav` yet: it follows the entry the tab was on. */
function tagEntry(): Nav {
    const nav = readNav(history.state);
    if (nav) {
        return nav;
    }
    const from = readNav(shown.state) ?? { index: 0, below: -1 };
    const tagged = { index: from.index + 1, below: belowAfter(from, shown.hash) };
    history.replaceState(withNav(history.state, tagged), '');
    return tagged;
}

window.addEventListener('popstate', () => {
    const here = readNav(history.state);
    if (here) {
        carryDown(here);
    }
    if (landing !== undefined) {
        if (here?.index === landing) {
            if (location.hash === shown.hash) {
                seen();
            }
            landed();
        }
        return;
    }
    stepped();
    if (!here) {
        return;
    }
    // On another address the page or its folder was left, and every overlay entry with it.
    const within = location.hash === shown.hash;
    const held = overlays.filter((overlay) => overlay.entry);
    const have = here.overlay ?? 0;
    const keep = within ? Math.min(have, held.length) : 0;
    if (held.length > keep) {
        if (within && held[held.length - 1].stays?.()) {
            // Back from an overlay that may not close now. Its entry is still ahead.
            travel(held.length - have);
            return;
        }
        // Back from an overlay: the overlays whose entries were left close, and with each one
        // whatever was opened on top of it without an entry.
        overlays
            .splice(overlays.indexOf(held[keep]))
            .reverse()
            .forEach((overlay) => overlay.onLeave());
    }
    if (within) {
        seen();
    }
    // An overlay's entry without its overlay (after a reload, or reached by Forward) is skipped.
    if (have > keep) {
        travel(keep - have);
    }
});

window.addEventListener('hashchange', () => {
    if (location.hash === shown.hash) {
        return;
    }
    const made = !readNav(history.state);
    const here = tagEntry();
    const params = hashParams();
    const next = canonical(params);
    const guard = leaveGuard;
    if (guard?.blocks(next)) {
        // The browser has already moved: Back, a link, or a typed address. Return to the entry
        // of the page that is still shown, and go where the browser went only if the owner says
        // so. History is left as it was, so a refused tab is not what Back leads to afterwards.
        const stay = readNav(shown.state)?.index ?? here.index;
        travel(stay - here.index);
        void guard.ask().then((leave) => {
            if (!leave) {
                return;
            }
            clearLeaveGuard(guard);
            leaveOverlays(() => {
                if (made || here.index > stay) {
                    // A new entry, or one that was ahead: anything pushed since has removed it.
                    write(next, 'push', undefined);
                } else {
                    travel(here.index - position().index);
                }
            });
        });
        return;
    }
    if (next !== params) {
        history.replaceState(history.state, '', hashOf(next));
    }
    accept();
});

// A page reloaded while an overlay was open sits on that overlay's entry.
{
    const over = position().overlay;
    if (over) {
        travel(-over);
    }
}

// The exports below are the router's earlier interface. They stay for the views that still call
// them and do the same as before, except that returning to the list no longer adds an entry.

/** Opens a page given as plain values. Same as `openRoute`. */
export function navigate(params: NavigateParams): void {
    openRoute(params);
}

/** Same as `goUp`. */
export function goToDeviceList(): void {
    goUp();
}

/**
 * Same-view route changes (Files walking into a folder) push history without a fragment
 * navigation. Assigning `location.hash` is a real navigation in WebKit -- iOS paints it as a
 * page transition, which showed up as the whole screen flashing on every folder change -- and
 * `pushState` is not. The browser still fires `hashchange` for Back/Forward between these
 * entries, so the listener above keeps `route` in step.
 */
export function pushRoute(params: URLSearchParams, state: unknown = null): void {
    if (location.hash === hashOf(canonicalRoute(params))) {
        return;
    }
    commit(params, 'push', state);
}

/**
 * Rewrites the current history entry: the same place under a corrected address, or the same
 * address with `state` attached. Back and Forward are unaffected.
 */
export function replaceRoute(params: URLSearchParams, state: unknown = history.state): void {
    commit(params, 'replace', state);
}
