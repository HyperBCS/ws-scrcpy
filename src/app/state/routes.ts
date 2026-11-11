import { ACTION } from '../../common/Action';
import { readStorage, writeStorage } from '../ui/storage';

/**
 * The pages of the app and their addresses. The form stays `#!key=value`:
 *
 *   list            #!                (push alerts use #!action=)
 *   one phone       #!action=device&udid=<udid>&view=screen|files|shell[&path=]
 *   notifications   #!action=notifications[&source=]...
 *
 * A phone's address names the phone and the view. The platform, the player and the socket are
 * found when the page opens; `player` and `ws` stay as optional overrides. The older addresses
 * (`action=stream`, `stream-coredevice`, `shell`, `list-files`) are still read everywhere and are
 * rewritten to this form by the router.
 */
export type Platform = 'android' | 'ios';
export type DeviceView = 'screen' | 'files' | 'shell';

export type Route =
    | { page: 'list' }
    | { page: 'notifications' }
    | {
          page: 'device';
          udid: string;
          view: DeviceView;
          /** Known only from an older address, which named the platform in its action. */
          platform?: Platform;
      };

export const DEVICE_ACTION = 'device';
export const NOTIFICATIONS_ACTION = 'notifications';

/** The name of the root page, and so the label of every back control (owner decision D1). */
export const LIST_PAGE_NAME = 'Phones';

/** The tabs of one phone's page, in order (owner decision D2). Settings is a sheet, not a tab. */
export const DEVICE_TABS: Record<Platform, ReadonlyArray<{ view: DeviceView; title: string }>> = {
    android: [
        { view: 'screen', title: 'Screen' },
        { view: 'files', title: 'Files' },
        { view: 'shell', title: 'Shell' },
    ],
    ios: [{ view: 'screen', title: 'Screen' }],
};

const VIEWS: readonly DeviceView[] = ['screen', 'files', 'shell'];

/** The older address of each view. Two platforms shared no action, so the action named both. */
const OLD_ACTIONS: Record<string, { view: DeviceView; platform: Platform }> = {
    [ACTION.STREAM_SCRCPY]: { view: 'screen', platform: 'android' },
    [ACTION.STREAM_COREDEVICE]: { view: 'screen', platform: 'ios' },
    [ACTION.FILE_LISTING]: { view: 'files', platform: 'android' },
    [ACTION.SHELL]: { view: 'shell', platform: 'android' },
};

/** Reads an address in either form. Anything that is not a phone or Notifications is the list. */
export function parseRoute(params: URLSearchParams): Route {
    const action = params.get('action') || '';
    if (action === NOTIFICATIONS_ACTION) {
        return { page: 'notifications' };
    }
    const udid = params.get('udid');
    if (!udid) {
        return { page: 'list' };
    }
    if (action === DEVICE_ACTION) {
        const view = params.get('view') as DeviceView;
        return { page: 'device', udid, view: VIEWS.includes(view) ? view : 'screen' };
    }
    const old = OLD_ACTIONS[action];
    return old ? { page: 'device', udid, ...old } : { page: 'list' };
}

/**
 * Whether two addresses show the same page: the list, Notifications, or one view of one phone.
 * The other keys (a Files path, a filter, a player) and the form of the address do not count.
 */
export function samePage(a: URLSearchParams, b: URLSearchParams): boolean {
    const one = parseRoute(a);
    const other = parseRoute(b);
    if (one.page !== 'device' || other.page !== 'device') {
        return one.page === other.page;
    }
    return one.udid === other.udid && one.view === other.view;
}

/** The same keys with `action`, `udid` and `view` first, so one page has one spelling. */
function withHead(params: URLSearchParams, head: Record<string, string>): URLSearchParams {
    const result = new URLSearchParams(head);
    params.forEach((value, key) => {
        if (key !== 'action' && key !== 'udid' && key !== 'view') {
            result.append(key, value);
        }
    });
    return result;
}

/**
 * The address the app keeps for a route: an older phone address becomes the new one, and every
 * other key is kept (`player`, `ws`, `path`, the proxied host). Returns `params` itself when
 * there is nothing to change.
 */
export function canonicalRoute(params: URLSearchParams): URLSearchParams {
    const route = parseRoute(params);
    if (route.page !== 'device') {
        return params;
    }
    const result = withHead(params, { action: DEVICE_ACTION, udid: route.udid, view: route.view });
    return result.toString() === params.toString() ? params : result;
}

/** The address of one phone's page. `extra` carries `path`, an override, or the proxied host. */
export function deviceRoute(
    udid: string,
    view: DeviceView,
    extra: Record<string, string | number | boolean | undefined> = {},
): URLSearchParams {
    const params = new URLSearchParams({ action: DEVICE_ACTION, udid, view });
    Object.entries(extra).forEach(([key, value]) => {
        if (value !== undefined) {
            params.set(key, String(value));
        }
    });
    return canonicalRoute(params);
}

/**
 * The parameters the stream and tool clients parse: the route under the older action, which is
 * also the action their sockets are opened with. `platform` chooses between the two screens.
 */
export function clientParams(params: URLSearchParams, platform: Platform = 'android'): URLSearchParams {
    const route = parseRoute(params);
    if (route.page !== 'device') {
        return params;
    }
    const action =
        route.view === 'files'
            ? ACTION.FILE_LISTING
            : route.view === 'shell'
              ? ACTION.SHELL
              : platform === 'ios'
                ? ACTION.STREAM_COREDEVICE
                : ACTION.STREAM_SCRCPY;
    return withHead(params, { action, udid: route.udid });
}

export interface RememberedPhone {
    platform: Platform;
    /** The name the phone had in the list when it was last seen there. */
    name?: string;
}

const PHONES_KEY = 'ws-scrcpy.phones';
/** More than any owner has; the oldest entries go first. */
const PHONES_KEPT = 50;
let phones: Map<string, RememberedPhone> | undefined;

function rememberedPhones(): Map<string, RememberedPhone> {
    if (phones) {
        return phones;
    }
    phones = new Map();
    try {
        const stored: unknown = JSON.parse(readStorage(PHONES_KEY) || '{}');
        Object.entries(stored && typeof stored === 'object' ? stored : {}).forEach(([udid, value]) => {
            const { platform, name } = (value || {}) as { platform?: unknown; name?: unknown };
            if (platform === 'android' || platform === 'ios') {
                phones?.set(udid, { platform, name: typeof name === 'string' ? name : undefined });
            }
        });
    } catch {
        // A damaged entry is the same as none: the page waits for the list.
    }
    return phones;
}

/**
 * What this browser last knew about a phone. A phone's address does not say whether it is an
 * Android phone or an iPhone, so a reloaded or bookmarked page reads it here and starts without
 * waiting for the list.
 */
export function rememberedPhone(udid: string): RememberedPhone | undefined {
    return rememberedPhones().get(udid);
}

/** Without a name, the name already kept for the phone stays. */
export function rememberPhone(udid: string, platform: Platform, name?: string): void {
    const all = rememberedPhones();
    const before = all.get(udid);
    const next = { platform, name: name ?? before?.name };
    if (before?.platform === next.platform && before.name === next.name) {
        return;
    }
    all.delete(udid);
    all.set(udid, next);
    while (all.size > PHONES_KEPT) {
        all.delete(all.keys().next().value as string);
    }
    writeStorage(PHONES_KEY, JSON.stringify(Object.fromEntries(all)));
}
