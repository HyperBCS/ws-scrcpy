import { signal } from '@preact/signals';

// The app has always used `#!key=value&...` deep links (documented in the README, produced by
// `BaseDeviceTracker.buildLink` historically). Keeping `location.hash` as the source of truth
// means bookmarked/shared links keep working with zero server-side routing.
export type RouteParams = URLSearchParams;

function parseHash(): RouteParams {
    return new URLSearchParams(location.hash.replace(/^#!/, ''));
}

export const route = signal<RouteParams>(parseHash());

window.addEventListener('hashchange', () => {
    route.value = parseHash();
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
        route.value = parseHash();
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
export function pushRoute(params: URLSearchParams): void {
    const hash = `#!${params.toString()}`;
    if (location.hash === hash) {
        return;
    }
    history.pushState(null, '', hash);
    route.value = parseHash();
}
