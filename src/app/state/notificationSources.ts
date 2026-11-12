import type { MutedApp, NotificationHistoryItem, NotificationSource } from '../../common/Notification';
import { notificationRequest } from './notifications';

/**
 * The settings of one sending iPhone as Setup changes them: its mute list and its older
 * allow-list. Each change saves the whole record (`POST sources`), the request a page left open
 * across an update also sends. The builders are pure so they run without a browser.
 */

/** The apps muted on this iPhone. Settings saved before the mute list existed have none. */
export function mutedApps(source: NotificationSource): MutedApp[] {
    return Array.isArray(source.muted) ? source.muted : [];
}

export function isAppMuted(source: NotificationSource, app: string): boolean {
    return mutedApps(source).some((entry) => entry.app === app);
}

/** The record with one app muted or unmuted. Nothing else changes. */
export function withAppMuted(
    source: NotificationSource,
    app: string,
    name: string,
    muted: boolean,
): NotificationSource {
    const others = mutedApps(source).filter((entry) => entry.app !== app);
    return { ...source, muted: muted ? [...others, { app, name }] : others };
}

/** One app as Setup lists it. */
export interface SeenApp {
    app: string;
    name: string;
    muted: boolean;
    /** False while the older allow-list leaves this app out: its notifications are not kept. */
    listed: boolean;
}

/**
 * The apps seen from this iPhone: those in its stored notifications, by the newest name, and
 * those on its mute list, whose notifications are no longer stored. Sorted by name.
 */
export function seenApps(source: NotificationSource, items: NotificationHistoryItem[]): SeenApp[] {
    const names = new Map<string, string>();
    for (const item of [...items].sort((a, b) => b.received - a.received)) {
        if (item.source === source.id && item.app && !names.has(item.app))
            names.set(item.app, item.appName || item.app);
    }
    for (const entry of mutedApps(source)) if (!names.has(entry.app)) names.set(entry.app, entry.name || entry.app);
    return [...names]
        .map(([app, name]) => ({
            app,
            name,
            muted: isAppMuted(source, app),
            listed: !source.apps.length || source.apps.includes(app),
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.app.localeCompare(b.app));
}

/** Saves the whole record of one iPhone. The server refuses a change it cannot make, with the reason. */
export async function saveNotificationSource(source: NotificationSource): Promise<void> {
    await notificationRequest('sources', 'POST', source);
}

/**
 * Mutes or unmutes one app of an iPhone: its new notifications are not kept or pushed. The
 * Setup switches call this, and so will "Mute this app" in a notification's menu. Undo is the
 * same call with `muted` the other way. The page reads the status again afterwards.
 */
export function setAppMuted(source: NotificationSource, app: string, name: string, muted: boolean): Promise<void> {
    return saveNotificationSource(withAppMuted(source, app, name, muted));
}
