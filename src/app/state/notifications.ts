import { signal } from '@preact/signals';
import { onPageChange, route } from './router';
import { requestJson } from '../client/request';
import { madeForServerKey, serverKeyBytes } from '../../common/pushKey';

const base = new URL('.', window.location.href);
export const notificationApi = new URL('api/notifications/', base).href;
/**
 * The server waits up to 15 s for the iPhone to confirm one action and works on a bulk request
 * for up to 30 s. The browser must wait longer than that, or it reports a failure while the
 * server carries on and the result never reaches the page.
 */
export const PHONE_ACTION_TIMEOUT_MS = 20000;
export const BULK_PHONE_ACTION_TIMEOUT_MS = 35000;

export async function notificationRequest<T>(
    route: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
): Promise<T> {
    return requestJson<T>(
        notificationApi + route,
        {
            method,
            headers: {
                'Content-Type': 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        signal,
        timeoutMs,
    );
}
export function registerNotificationWorker(): Promise<ServiceWorkerRegistration> {
    if (!window.isSecureContext || !('serviceWorker' in navigator))
        return Promise.reject(Error('Open the app using trusted HTTPS.'));
    return navigator.serviceWorker.register(new URL('sw.js', base).href, { scope: base.pathname });
}

/** The iPhones this device chose to receive from, as last saved to the server. */
export function savedNotificationSources(): string[] | null {
    try {
        const saved: unknown = JSON.parse(localStorage.getItem('notification-sources') || 'null');
        return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : null;
    } catch {
        return null;
    }
}

/**
 * The browser's push subscription for this server's key. One made for other keys is replaced,
 * because the push service refuses every send to it. `create` also makes the first one.
 */
export async function pushSubscriptionFor(
    registration: ServiceWorkerRegistration,
    publicKey: string,
    create: boolean,
): Promise<PushSubscription | null> {
    const existing = await registration.pushManager.getSubscription();
    if (existing && madeForServerKey(existing.options?.applicationServerKey, publicKey)) return existing;
    if (existing) {
        await existing.unsubscribe();
        // The server would also drop the old endpoint itself, after the push service refuses it.
        void notificationRequest('subscriptions', 'DELETE', { endpoint: existing.endpoint }).catch(() => undefined);
    } else if (!create) return null;
    return registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: serverKeyBytes(publicKey),
    });
}

/** The server's id for a subscription: the SHA-256 of its endpoint. */
export async function pushReceiverId(endpoint: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface PushSync {
    // The subscription reached the server.
    sent?: boolean;
    error?: string;
    // The old subscription was removed but a new one could not be made without a tap (Safari
    // asks for one). The device receives nothing until notifications are enabled again.
    lost?: boolean;
}
let pushSync: Promise<PushSync> | undefined;
let pushSyncFailed = false;

/**
 * Once per app load, send this device's push subscription to the server again with the choices
 * it last saved. The browser can replace a subscription and the server can drop one (after the
 * push service reports it gone, or after a data reset); without this the page would go on
 * showing notifications as enabled while nothing can be delivered. A device that never enabled
 * notifications is left alone. `retry` runs it again after a failure.
 */
export function syncPushSubscription(retry = false): Promise<PushSync> {
    if (pushSync && !(retry && pushSyncFailed)) return pushSync;
    pushSyncFailed = false;
    pushSync = (async (): Promise<PushSync> => {
        const sources = savedNotificationSources();
        if (
            !sources ||
            !window.isSecureContext ||
            !('serviceWorker' in navigator) ||
            !('PushManager' in window) ||
            !('Notification' in window) ||
            Notification.permission !== 'granted'
        )
            return {};
        let registration: ServiceWorkerRegistration | undefined;
        try {
            registration = await navigator.serviceWorker.getRegistration(base.href);
            if (!registration || !(await registration.pushManager.getSubscription())) return {};
            const status = await notificationRequest<{ publicKey: string; sources: Array<{ id: string }> }>('status');
            const subscription = await pushSubscriptionFor(registration, status.publicKey, false);
            if (!subscription) return {};
            const linked = new Set(status.sources.map((source) => source.id));
            const receiver = localStorage.getItem('notification-receiver-source') || '';
            await notificationRequest('subscriptions', 'POST', {
                subscription: subscription.toJSON(),
                sources: sources.filter((id) => linked.has(id)),
                receiverSource: linked.has(receiver) ? receiver : '',
            });
            return { sent: true };
        } catch (error) {
            pushSyncFailed = true;
            const current = await registration?.pushManager.getSubscription().catch(() => undefined);
            return { error: (error as Error).message, lost: current === null };
        }
    })();
    return pushSync;
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
            // Notification outages do not interrupt device viewing.
        } finally {
            pending = false;
        }
    };
    void refresh();
    void syncPushSubscription();
    const timer = window.setInterval(refresh, 15000);
    // The router changes pages with pushState and replaceState, which fire no hashchange.
    // Leaving Notifications, where the count was just changed, is the case that matters.
    const stopPageChange = onPageChange(() => void refresh());
    document.addEventListener('visibilitychange', refresh);
    navigator.serviceWorker?.addEventListener('message', refresh);
    return () => {
        alive = false;
        clearInterval(timer);
        stopPageChange();
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
    const blob = fetch(notificationApi + path)
        .then((response) =>
            response.ok && response.headers.get('Content-Type')?.startsWith('image/png') ? response.blob() : null,
        )
        .catch(() => null);
    icons.set(path, { expires: Date.now() + 60000, blob });
    while (icons.size > 100) icons.delete(icons.keys().next().value!);
    return blob;
}
