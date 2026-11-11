import { DeviceEntry, deviceName } from './devices';
import { DeviceView, parseRoute } from './routes';

/** The one name of the app: tab titles, the manifest, index.html and push banners use it. */
export const APP_NAME = 'ws-scrcpy';

/**
 * The list's own heading still reads "Devices", and its tab title follows the heading. The name
 * the owner chose for the page is `LIST_PAGE_NAME` in `routes.ts`; both change together when
 * the list is renamed.
 */
const LIST_TITLE = 'Devices';

/** The view of a phone's page as the title names it, and the platform that has it. */
const VIEWS: Record<DeviceView, { label: string; type?: 'android' | 'ios' }> = {
    screen: { label: 'Screen' },
    files: { label: 'Files', type: 'android' },
    shell: { label: 'Shell', type: 'android' },
};

/**
 * The tab title of a route. Every page uses this, so browser history and the task switcher read
 * the same way everywhere: "<Device> · Screen · ws-scrcpy", "<Device> · Files · ws-scrcpy",
 * "Devices · ws-scrcpy", "Notifications · ws-scrcpy". The device is named like its card
 * (`deviceName`), or by its serial until the device list has arrived. A `title` parameter in a
 * device link replaces the whole title, as it always has. Both forms of a phone's address
 * (`state/routes.ts`) give the same title.
 */
export function pageTitle(route: URLSearchParams, list: Iterable<DeviceEntry>): string {
    const page = parseRoute(route);
    if (page.page === 'notifications') {
        return `Notifications · ${APP_NAME}`;
    }
    if (page.page !== 'device') {
        return `${LIST_TITLE} · ${APP_NAME}`;
    }
    const custom = route.get('title');
    if (custom) {
        return custom;
    }
    const screen = VIEWS[page.view];
    // The device of the page's platform first. A Files or Shell link that names an iPhone is
    // refused, and that page is still titled with the iPhone's name. An older screen address
    // names its platform; the current one does not, and the first device with the serial is it.
    const type = screen.type ?? page.platform;
    let match: DeviceEntry | undefined;
    for (const entry of list) {
        if (entry.descriptor.udid !== page.udid) {
            continue;
        }
        if (!type || entry.params.type === type) {
            match = entry;
            break;
        }
        match ??= entry;
    }
    return `${match ? deviceName(match) : page.udid} · ${screen.label} · ${APP_NAME}`;
}
