import { DeviceEntry, phoneName } from './devices';
import { capabilities } from './capabilities';
import { DeviceView, LIST_PAGE_NAME, parseRoute, Platform } from './routes';

/** The one name of the app: tab titles, the manifest, index.html and push banners use it. */
export const APP_NAME = 'ws-scrcpy';

/** The view of a phone's page as the title names it. */
const VIEWS: Record<DeviceView, string> = { screen: 'Screen', files: 'Files', shell: 'Shell' };
const PLATFORMS: readonly Platform[] = ['android', 'ios'];

/** The one kind of phone that has a view (`capabilities`), or undefined when every kind has it. */
function platformOf(view: DeviceView): Platform | undefined {
    const having = PLATFORMS.filter((platform) => view === 'screen' || capabilities(platform)[view]);
    return having.length === 1 ? having[0] : undefined;
}

/**
 * The tab title of a route. Every page uses this, so browser history and the task switcher read
 * the same way everywhere: "<Device> · Screen · ws-scrcpy", "<Device> · Files · ws-scrcpy",
 * "Phones · ws-scrcpy", "Notifications · ws-scrcpy". The device is named like its card
 * (`phoneName`): while it is not listed by the last name the page saw, and by its serial until
 * the device list has arrived. A `title` parameter in a device link replaces the whole title, as
 * it always has. Both forms of a phone's address (`state/routes.ts`) give the same title.
 */
export function pageTitle(route: URLSearchParams, list: Iterable<DeviceEntry>): string {
    const page = parseRoute(route);
    if (page.page === 'notifications') {
        return `Notifications · ${APP_NAME}`;
    }
    if (page.page !== 'device') {
        return `${LIST_PAGE_NAME} · ${APP_NAME}`;
    }
    const custom = route.get('title');
    if (custom) {
        return custom;
    }
    // The device of the page's platform first. A Files or Shell link that names an iPhone is
    // refused, and that page is still titled with the iPhone's name. An older screen address
    // names its platform; the current one does not, and the first device with the serial is it.
    const type = platformOf(page.view) ?? page.platform;
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
    return `${phoneName(page.udid, match)} · ${VIEWS[page.view]} · ${APP_NAME}`;
}
