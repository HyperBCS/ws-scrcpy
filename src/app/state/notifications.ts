import { signal } from '@preact/signals';
import { route } from './router';
import { requestJson } from '../client/request';

const base = new URL('.', window.location.href);
export const notificationApi = new URL('api/notifications/', base).href;
const keyName = 'ws-scrcpy-notification-key';
export function notificationKey(): string {
    return localStorage.getItem(keyName) || '';
}
export function setNotificationKey(key: string): void {
    localStorage.setItem(keyName, key.trim());
}
export async function notificationRequest<T>(
    route: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
): Promise<T> {
    const key = notificationKey();
    return requestJson<T>(
        notificationApi + route,
        {
            method,
            headers: {
                ...(key ? { Authorization: `Bearer ${key}` } : {}),
                'Content-Type': 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        signal,
    );
}
export function registerNotificationWorker(): Promise<ServiceWorkerRegistration> {
    if (!window.isSecureContext || !('serviceWorker' in navigator))
        return Promise.reject(Error('Open the app using trusted HTTPS.'));
    return navigator.serviceWorker.register(new URL('sw.js', base).href, { scope: base.pathname });
}

import type { NotificationSummary } from '../../common/Notification';
export type { NotificationSummary } from '../../common/Notification';
export const notificationSummary = signal<NotificationSummary>({ unread: 0, unreadBySource: {}, sources: [] });
let summaryVersion = 0;

export function applyNotificationSummary(value: NotificationSummary): void {
    summaryVersion++;
    notificationSummary.value = {
        unread: value.unread || 0,
        unreadBySource: value.unreadBySource || {},
        sources: value.sources,
    };
    void updateAppBadge(value.unread || 0);
}

async function updateAppBadge(count: number): Promise<void> {
    try {
        if ('setAppBadge' in navigator) {
            if (count > 0) await navigator.setAppBadge(count);
            else await navigator.clearAppBadge();
        }
    } catch {
        // Badging is optional and may be disabled in the phone's settings.
    }
}

export function startNotificationSummary(): () => void {
    let alive = true;
    let pending = false;
    const refresh = async () => {
        // The notification page already polls the complete status.
        if (!alive || pending || document.hidden || route.value.get('action') === 'notifications') return;
        pending = true;
        const version = summaryVersion;
        try {
            const result = await notificationRequest<NotificationSummary>('summary');
            if (alive && version === summaryVersion) applyNotificationSummary(result);
        } catch {
            // Device viewing also works without notification setup or authentication.
        } finally {
            pending = false;
        }
    };
    void refresh();
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('hashchange', refresh);
    document.addEventListener('visibilitychange', refresh);
    navigator.serviceWorker?.addEventListener('message', refresh);
    return () => {
        alive = false;
        clearInterval(timer);
        window.removeEventListener('hashchange', refresh);
        document.removeEventListener('visibilitychange', refresh);
        navigator.serviceWorker?.removeEventListener('message', refresh);
    };
}

const notificationCleanupKeys = new Set<string>();
let notificationCleanupRunning = false;

/** Closing OS alerts is optional; never hold a history mutation or its Undo UI. */
export function closeReadNotifications(keys: string[]): void {
    if (!('serviceWorker' in navigator) || !keys.length) return;
    for (const key of keys) notificationCleanupKeys.add(key);
    while (notificationCleanupKeys.size > 1000)
        notificationCleanupKeys.delete(notificationCleanupKeys.values().next().value!);
    if (notificationCleanupRunning) return;
    notificationCleanupRunning = true;
    void cleanNotificationTray();
}

async function cleanNotificationTray(): Promise<void> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const notifications = await Promise.race([
            Promise.resolve()
                .then(() => navigator.serviceWorker.getRegistration(base.href))
                .then((registration) => (expired ? undefined : registration?.getNotifications())),
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => {
                    expired = true;
                    resolve(undefined);
                }, 1000);
            }),
        ]);
        notifications?.forEach((notification) => {
            if (notificationCleanupKeys.has(notification.data?.notificationKey)) {
                try {
                    notification.close();
                } catch {
                    // A browser may refuse to close one alert; try the others.
                }
            }
        });
    } catch {
        // History remains usable when the browser has no notification controls.
    } finally {
        expired = true;
        if (timer !== undefined) clearTimeout(timer);
        notificationCleanupKeys.clear();
        notificationCleanupRunning = false;
    }
}

const icons = new Map<string, { expires: number; blob: Promise<Blob | null> }>();
export function notificationIcon(source: string, app: string): Promise<Blob | null> {
    const path = `icons/${encodeURIComponent(source)}/${encodeURIComponent(app)}`;
    const cached = icons.get(path);
    if (cached && cached.expires > Date.now()) return cached.blob;
    const key = notificationKey();
    const blob = fetch(notificationApi + path, { headers: key ? { Authorization: `Bearer ${key}` } : {} })
        .then((response) =>
            response.ok && response.headers.get('Content-Type')?.startsWith('image/png') ? response.blob() : null,
        )
        .catch(() => null);
    icons.set(path, { expires: Date.now() + 60000, blob });
    while (icons.size > 100) icons.delete(icons.keys().next().value!);
    return blob;
}
