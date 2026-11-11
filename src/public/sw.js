/* No streams, notification content or API responses are cached. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
async function setUnreadBadge(count) {
    if (!Number.isSafeInteger(count) || count < 0 || !('setAppBadge' in navigator)) return;
    try {
        if (count) await navigator.setAppBadge(count);
        else await navigator.clearAppBadge();
    } catch (_) { /* The user can disable badges independently. */ }
}
async function currentUnreadCount(fallback) {
    // A queued push may arrive after the alert was read on another device.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
        const response = await fetch(new URL('api/notifications/summary', self.registration.scope), {
            signal: controller.signal,
            cache: 'no-store',
        });
        if (response.ok) {
            const summary = await response.json();
            if (Number.isSafeInteger(summary.unread) && summary.unread >= 0) return summary.unread;
        }
    } catch (_) { /* Offline: use the count included in the push. */ }
    finally { clearTimeout(timeout); }
    return fallback;
}
self.addEventListener('push', event => {
    let message = {};
    try { message = event.data ? event.data.json() : {}; } catch (_) { /* Display a safe fallback. */ }
    const target = new URL(self.registration.scope);
    target.hash = typeof message.url === 'string' && message.url.startsWith('#!') ? message.url : '!action=notifications';
    event.waitUntil((async () => {
        await self.registration.showNotification(String(message.title || 'ws-scrcpy').slice(0, 200), {
            body: String(message.body || 'A device notification is available.').slice(0, 1000),
            tag: String(message.tag || 'ws-scrcpy'),
            icon: new URL('icon-192.png', self.registration.scope).href,
            data: { url: target.href, notificationKey: message.notificationKey },
        });
        // Tests have no count. Never clear unread alerts just because a test arrived.
        if (Number.isSafeInteger(message.unreadCount) && message.unreadCount >= 0)
            await setUnreadBadge(await currentUnreadCount(message.unreadCount));
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        clients.forEach(client => client.postMessage({ type: 'notifications-changed' }));
    })());
});
// The browser replaced or dropped this device's push subscription while the app was closed.
// Subscribe again with the same server key and hand the server the new endpoint; it keeps the
// choices stored for the old one. Whatever cannot be done here is repaired when the app next opens.
self.addEventListener('pushsubscriptionchange', event => {
    event.waitUntil((async () => {
        try {
            const old = event.oldSubscription;
            const key = old?.options?.applicationServerKey;
            const fresh = event.newSubscription
                || (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
            if (fresh && old?.endpoint) {
                await fetch(new URL('api/notifications/subscriptions', self.registration.scope), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ subscription: fresh.toJSON(), replaces: old.endpoint }),
                });
            }
        } catch (_) { /* Left for the app to repair. */ }
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        clients.forEach(client => client.postMessage({ type: 'notifications-changed' }));
    })());
});
// What the app shows in a window, read from its `#!key=value` route.
function windowRoute(client) {
    try { return new URLSearchParams(new URL(client.url).hash.replace(/^#!/, '')); } catch (_) { return new URLSearchParams(); }
}
self.addEventListener('notificationclick', event => {
    event.notification.close();
    let target;
    try { target = new URL(event.notification.data?.url || self.registration.scope); } catch (_) { return; }
    const scope = new URL(self.registration.scope);
    if (target.origin !== self.location.origin || !target.pathname.startsWith(scope.pathname)) return;
    event.waitUntil((async () => {
        // Only a window this worker controls can be navigated. Another one (after a hard reload,
        // for example) is passed over and the notification opens in a window of its own.
        const windows = (await self.clients.matchAll({ type: 'window' })).filter(client => {
            try { const url = new URL(client.url); return url.origin === target.origin && url.pathname.startsWith(scope.pathname); } catch (_) { return false; }
        });
        // A window on a phone's page (its screen, its files or its shell) is left alone: navigating
        // it ends that session. Both forms of that address carry `udid` (#!action=device&udid=...
        // and the older #!action=stream&udid=...); the list and Notifications do not. The check
        // must hold for both: this worker also serves pages that were loaded before a deploy.
        const existing = windows.find(client => windowRoute(client).get('action') === 'notifications')
            || windows.find(client => !windowRoute(client).get('udid'));
        if (existing) {
            // Chromium lets one tap either focus a window or open one, so the window is chosen
            // first. Focus comes before navigate, while the tap still counts as a user gesture.
            try { await existing.focus(); } catch (_) { /* Navigating still shows the notification. */ }
            try {
                await existing.navigate(target.href);
                return;
            } catch (_) { /* Try a new window. */ }
        }
        try { await self.clients.openWindow(target.href); } catch (_) { /* The browser refused a window. */ }
        // The opened page marks only this notification read.
    })());
});
