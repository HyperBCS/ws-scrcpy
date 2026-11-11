import { ACTION } from '../../common/Action';
import { DeviceEntry, deviceName } from './devices';

/** The one name of the app: tab titles, the manifest, index.html and push banners use it. */
export const APP_NAME = 'ws-scrcpy';

const SCREENS: Record<string, { label: string; type: 'android' | 'ios' }> = {
    [ACTION.STREAM_SCRCPY]: { label: 'Screen', type: 'android' },
    [ACTION.STREAM_COREDEVICE]: { label: 'Screen', type: 'ios' },
    [ACTION.FILE_LISTING]: { label: 'Files', type: 'android' },
    [ACTION.SHELL]: { label: 'Shell', type: 'android' },
};

/**
 * The tab title of a route. Every page uses this, so browser history and the task switcher read
 * the same way everywhere: "<Device> · Screen · ws-scrcpy", "<Device> · Files · ws-scrcpy",
 * "Devices · ws-scrcpy", "Notifications · ws-scrcpy". The device is named like its card
 * (`deviceName`), or by its serial until the device list has arrived. A `title` parameter in a
 * device link replaces the whole title, as it always has.
 */
export function pageTitle(route: URLSearchParams, list: Iterable<DeviceEntry>): string {
    const action = route.get('action') || '';
    if (action === 'notifications') {
        return `Notifications · ${APP_NAME}`;
    }
    const screen = SCREENS[action];
    const udid = route.get('udid');
    if (!screen || !udid) {
        return `Devices · ${APP_NAME}`;
    }
    const custom = route.get('title');
    if (custom) {
        return custom;
    }
    let name = udid;
    for (const entry of list) {
        if (entry.descriptor.udid === udid && entry.params.type === screen.type) {
            name = deviceName(entry);
            break;
        }
    }
    return `${name} · ${screen.label} · ${APP_NAME}`;
}
