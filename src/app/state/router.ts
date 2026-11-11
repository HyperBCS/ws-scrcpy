import { signal } from '@preact/signals';
import { canonicalRoute, parseRoute, rememberPhone } from './routes';

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
// other's writes.
export type RouteParams = URLSearchParams;
export type NavigateParams = Record<string, string | number | boolean | undefined>;
export type RouteTarget = URLSearchParams | NavigateParams;

/** Where an entry sits, kept in `history.state.nav`. */
interface Nav {
    /** Counted from the first entry the app has in this tab. */
    index: number;
    /** The index of the nearest list entry below this one, -1 when there is none. */
    below: number;
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
    return { index: nav.index as number, below: nav.below as number };
}

function withNav(state: unknown, nav: Nav): Record<string, unknown> {
    return { ...(state && typeof state === 'object' ? state : {}), nav };
}

function position(): Nav {
    return readNav(history.state) ?? { index: 0, below: -1 };
}

/** `below` for an entry made on top of the entry `nav`, whose address is `hash`. */
function belowAfter(nav: Nav, hash: string): number {
    return isList(hash) ? nav.index : nav.below;
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
 * Something on the current page that must not be dropped without asking, such as uploads in
 * progress. `blocks` says whether going to `next` would drop it; `ask` puts the question and
 * resolves to true when the owner chooses to leave anyway.
 */
export interface LeaveGuard {
    blocks(next: RouteParams): boolean;
    ask(): Promise<boolean>;
}

let leaveGuard: LeaveGuard | undefined;
/** The address and history state of the page that is shown, to return to when leaving is refused. */
let shown = { hash: location.hash, state: history.state as unknown };

export function setLeaveGuard(guard: LeaveGuard): void {
    leaveGuard = guard;
}

/** Removes `guard`, if it is still the one in place. */
export function clearLeaveGuard(guard: LeaveGuard): void {
    if (leaveGuard === guard) {
        leaveGuard = undefined;
    }
}

function accept(): void {
    shown = { hash: location.hash, state: history.state };
    route.value = hashParams();
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

/** Steps through history. `then` runs on arrival, before anything that was already waiting. */
function travel(delta: number, then?: () => void): void {
    if (!delta) {
        // `history.go(0)` would reload the page.
        then?.();
        return;
    }
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

function write(next: RouteParams, mode: 'push' | 'replace', state: unknown): void {
    const hash = hashOf(next);
    const here = position();
    if (mode === 'replace') {
        history.replaceState(withNav(state, { index: here.index, below: here.below }), '', hash);
    } else if (location.hash !== hash) {
        const nav = { index: here.index + 1, below: belowAfter(here, location.hash) };
        history.pushState(withNav(state, nav), '', hash);
    }
    if (mode === 'push' || location.hash !== shown.hash) {
        accept();
    } else {
        shown = { hash: location.hash, state: history.state };
    }
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
    whenLanded(() => write(next, mode, state));
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
    whenLanded(() => {
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

/** An entry a link or an assigned hash made has no `nav` yet: it follows the page that was shown. */
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
    if (landing !== undefined && readNav(history.state)?.index === landing) {
        landed();
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
            whenLanded(() => {
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
