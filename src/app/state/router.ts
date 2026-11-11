import { signal } from '@preact/signals';

// The app has always used `#!key=value&...` deep links (documented in the README, produced by
// `BaseDeviceTracker.buildLink` historically). Keeping `location.hash` as the source of truth
// means bookmarked/shared links keep working with zero server-side routing.
export type RouteParams = URLSearchParams;

function parseHash(): RouteParams {
    return new URLSearchParams(location.hash.replace(/^#!/, ''));
}

export const route = signal<RouteParams>(parseHash());

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
    route.value = parseHash();
}

window.addEventListener('hashchange', () => {
    const guard = leaveGuard;
    if (guard?.blocks(parseHash())) {
        // The browser has already moved: Back, a link, or a typed address. Put the address of
        // the page that is still shown back on top, and leave only if the owner says so. The
        // destination is then the entry right behind it, whichever way it was reached.
        history.pushState(shown.state, '', shown.hash);
        void guard.ask().then((leave) => {
            if (leave) {
                clearLeaveGuard(guard);
                history.back();
            }
        });
        return;
    }
    accept();
});

export type NavigateParams = Record<string, string | number | boolean | undefined>;

function toSearchParams(params: NavigateParams): URLSearchParams {
    const usp = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
            usp.set(key, String(value));
        }
    });
    return usp;
}

// Pushes a new hash so the UI can switch device/action in place instead of opening a new tab.
// `hashchange` fires from this (browsers do not fire it for same-document JS-only navigation
// unless the hash actually changes), which updates `route` above.
export function navigate(params: NavigateParams): void {
    const hash = `#!${toSearchParams(params).toString()}`;
    if (location.hash === hash) {
        accept();
        return;
    }
    location.hash = hash;
}

export function goToDeviceList(): void {
    navigate({});
}

/**
 * Same-view route changes (Files walking into a folder) push history without a fragment
 * navigation. Assigning `location.hash` is a real navigation in WebKit -- iOS paints it as a
 * page transition, which showed up as the whole screen flashing on every folder change -- and
 * `pushState` is not. The browser still fires `hashchange` for Back/Forward between these
 * entries, so the listener above keeps `route` in step.
 */
export function pushRoute(params: URLSearchParams, state: unknown = null): void {
    const hash = `#!${params.toString()}`;
    if (location.hash === hash) {
        return;
    }
    history.pushState(state, '', hash);
    accept();
}

/**
 * Rewrites the current history entry: the same place under a corrected address, or the same
 * address with `state` attached. Back and Forward are unaffected.
 */
export function replaceRoute(params: URLSearchParams, state: unknown = history.state): void {
    const hash = `#!${params.toString()}`;
    const changed = location.hash !== hash;
    history.replaceState(state, '', hash);
    if (changed) {
        accept();
    } else {
        shown = { hash: location.hash, state: history.state };
    }
}
