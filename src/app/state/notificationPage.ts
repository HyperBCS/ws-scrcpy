import { NOTIFICATIONS_ACTION } from './routes';

/**
 * What the Notifications address says:
 *
 *   #!action=notifications[&source=][&panel=setup][&filter=unread|archive][&app=][&q=][&notification=]
 *
 * The address is where this state lives, so a reload, a link and Back all show the same view.
 * A value that is the default is left out. `notificationNav.ts` writes the changes; this file
 * only reads and builds the address, so it loads without a browser.
 */
export type NotificationPanel = 'history' | 'setup';
export type NotificationFilter = 'inbox' | 'unread' | 'archive';

export interface NotificationPage {
    /** The iPhone whose inbox is shown. Empty: all linked iPhones. */
    source: string;
    panel: NotificationPanel;
    filter: NotificationFilter;
    /** The app the inbox is narrowed to, by its identifier. */
    app: string;
    /** The search text. */
    q: string;
    /** The notification a push banner asks for. It leaves the address once it has been opened. */
    notification: string;
}

const DEFAULTS: NotificationPage = { source: '', panel: 'history', filter: 'inbox', app: '', q: '', notification: '' };

export function readNotificationPage(params: URLSearchParams): NotificationPage {
    const filter = params.get('filter');
    return {
        source: params.get('source') || '',
        panel: params.get('panel') === 'setup' ? 'setup' : 'history',
        filter: filter === 'unread' || filter === 'archive' ? filter : 'inbox',
        app: params.get('app') || '',
        q: params.get('q') || '',
        notification: params.get('notification') || '',
    };
}

/** The address of a Notifications view, with one spelling for each view. */
export function notificationRoute(page: Partial<NotificationPage> = {}): URLSearchParams {
    const params = new URLSearchParams({ action: NOTIFICATIONS_ACTION });
    (Object.keys(DEFAULTS) as Array<keyof NotificationPage>).forEach((key) => {
        const value = page[key];
        if (value && value !== DEFAULTS[key]) {
            params.set(key, value);
        }
    });
    return params;
}
