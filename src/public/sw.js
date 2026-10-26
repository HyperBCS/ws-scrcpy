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
self.addEventListener('notificationclick', event => {
    event.notification.close();
    let target;
    try { target = new URL(event.notification.data?.url || self.registration.scope); } catch (_) { return; }
    if (target.origin !== self.location.origin || !target.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existing = windows.find(client => new URL(client.url).origin === target.origin);
        if (existing) { await existing.navigate(target.href); await existing.focus(); }
        else await self.clients.openWindow(target.href);
        // The opened history page marks only this alert read.
    })());
});
