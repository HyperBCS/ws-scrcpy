import { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import { NavigateParams, openRoute, switchRoute } from './router';
import { deviceRoute, DeviceView } from './routes';

// Same URL-building rules `BaseDeviceTracker.buildLink` used to bake into an `<a>` tag: a device
// tracked through a remote host must link back to that host directly, unless the connection is
// proxied through the current server (`useProxy`), in which case the link stays on this origin
// and carries the remote host details in the hash instead.
export function buildLinkHref(q: NavigateParams, params: ParamsDeviceTracker): string {
    let { hostname } = params;
    let port: string | number | undefined = params.port;
    let pathname = params.pathname ?? location.pathname;
    let protocol = params.secure ? 'https:' : 'http:';
    const query = { ...q };
    if (params.useProxy) {
        query.hostname = hostname;
        query.port = port;
        query.pathname = pathname;
        query.secure = params.secure;
        query.useProxy = true;
        protocol = location.protocol;
        hostname = location.hostname;
        port = location.port;
        pathname = location.pathname;
    }
    const usp = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined) {
            usp.set(key, String(value));
        }
    });
    const hash = `#!${usp.toString()}`;
    return `${protocol}//${hostname}:${port}${pathname}${hash}`;
}

// A link is navigable in-app (via the hash router) only when it stays on this origin; anything
// pointing at a different host/port/protocol needs a real browser navigation.
export function isLocalLink(params: ParamsDeviceTracker): boolean {
    if (params.useProxy) {
        return true;
    }
    const protocol = params.secure ? 'https:' : 'http:';
    const port = String(params.port ?? (params.secure ? 443 : 80));
    const locationPort = location.port || (location.protocol === 'https:' ? '443' : '80');
    return protocol === location.protocol && params.hostname === location.hostname && port === locationPort;
}

/**
 * The link to one phone's page: the phone and the view, nothing else. The player and the socket
 * are found when the stream starts, so a bookmark does not break when either changes.
 */
export function deviceHref(
    udid: string,
    view: DeviceView,
    params: ParamsDeviceTracker,
    extra: NavigateParams = {},
): string {
    return buildLinkHref(Object.fromEntries(deviceRoute(udid, view, extra)), params);
}

/**
 * Follows a link built above. One that stays in the app goes through the router: `open` adds a
 * history entry, `switch` changes the current one. Any other link is a browser navigation.
 */
export function followLink(href: string, how: 'open' | 'switch'): void {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname) {
        location.assign(url.toString());
        return;
    }
    const target = new URLSearchParams(url.hash.replace(/^#!/, ''));
    if (how === 'open') {
        openRoute(target);
    } else {
        switchRoute(target);
    }
}
