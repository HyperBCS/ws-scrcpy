const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const webpush = require('web-push');
require('ts-node').register({ transpileOnly: true });
const { NotificationService, validateSubscription, shouldRelay } = require('../src/server/notifications/NotificationService');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-notifications-'));
process.env.WS_NOTIFICATION_DATA = temporary;
process.env.WS_NOTIFICATIONS_COLLECTOR = '0';
process.env.WS_PUBLIC_URL = 'https://phone.example';
const originalSend = webpush.sendNotification;
after(() => { webpush.sendNotification = originalSend; fs.rmSync(temporary, { recursive: true, force: true }); });
const tick = () => new Promise(resolve => setImmediate(resolve));
const freshService = () => {
    fs.rmSync(path.join(temporary, 'notification-history.json'), { force: true });
    return new NotificationService();
};
const subscription = { endpoint: 'https://web.push.apple.com/test', keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } };
const source = { id: 'iphone', address: 'AA:BB:CC:DD:EE:FF', name: 'iPhone', apps: [], preview: true };
const event = { source: 'iphone', session: 'a', uid: 1, event: 'added', app: 'com.example', appName: 'Example', title: 'Title', body: 'Body', date: '20261025T120000' };
const sub = { id: 'sub', subscription, sources: ['iphone'], receiverSource: '', updated: Date.now() };
const withPushEnv = async (values, run) => {
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    try {
        for (const [key, value] of Object.entries(values)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await run();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

test('push destinations reject arbitrary servers, credentials, insecure transport and malformed keys', () => {
    assert.deepEqual(validateSubscription(subscription), subscription);
    for (const endpoint of ['http://web.push.apple.com/x', 'https://localhost/x', 'https://web.push.apple.com.evil.example/x', 'https://user@web.push.apple.com/x', 'https://web.push.apple.com:8080/x']) {
        assert.throws(() => validateSubscription({ ...subscription, endpoint }));
    }
    assert.throws(() => validateSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'bad' } }));
});

test('relay policy excludes old alerts, modifications, unselected sources and the receiving source phone', () => {
    assert.equal(shouldRelay(event, source, sub), true);
    for (const patch of [{ preExisting: true }, { event: 'modified' }, { event: 'removed' }, { app: 'com.apple.WebKit.PushBundle.123' }]) assert.equal(shouldRelay({ ...event, ...patch }, source, sub), false);
    assert.equal(shouldRelay(event, source, { ...sub, receiverSource: 'iphone' }), false);
    assert.equal(shouldRelay(event, source, { ...sub, sources: [] }), false);
    assert.equal(shouldRelay(event, { ...source, apps: ['different'] }, sub), false);
});

test('API authentication, settings persistence, delivery deduplication and expired endpoints', async () => {
    const service = freshService();
    const app = express(); service.mount(app, '/');
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/notifications`;
    const token = fs.readFileSync(path.join(temporary, 'notification-setup-key'), 'utf8').trim();
    const api = (url, body, extra = {}) => fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra }, body: body && JSON.stringify(body) });
    try {
        assert.equal((await fetch(base + '/status')).status, 401);
        assert.equal((await api('/status', null, { origin: 'https://evil.example' })).status, 403);
        assert.equal((await api('/sources', source)).status, 200);
        assert.equal((await api('/subscriptions', { subscription, sources: ['iphone'], receiverSource: '' })).status, 200);
        const delivered = [];
        webpush.sendNotification = async (_s, payload) => { delivered.push(JSON.parse(payload)); };
        service.receive({ ...event, preExisting: true }); await tick();
        assert.equal(delivered.length, 0);
        service.receive({ ...event, uid: 2, title: 'Fresh', date: '20261025T120001' }); await tick();
        service.receive({ ...event, session: 'reconnected', uid: 20, title: 'Fresh', date: '20261025T120001' }); await tick();
        assert.equal(delivered.length, 1, 'reconnect duplicates are not pushed twice');
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'next' });
        assert.equal(service.feed.size, 2, 'reconnect retains historical alerts');
        assert.ok([...service.feed.values()].every(n => !n.active), 'old connection IDs cannot remain actionable');
        service.receive({ ...event, session: 'next', uid: 1, title: 'Fresh', date: '20261025T120001', preExisting: true });
        await tick();
        assert.equal(delivered.length, 1, 'session reset preserves push deduplication');
        service.receive({ ...event, session: 'next', uid: 1, event: 'removed' });
        assert.equal(service.feed.size, 2, 'removal preserves notification history');
        assert.ok([...service.feed.values()].every(n => !n.active));
        assert.equal(delivered[0].title, 'Example: Fresh');
        assert.match(delivered[0].url, /source=iphone/);
        assert.equal(typeof delivered[0].notificationKey, 'string');
        assert.equal(delivered[0].unreadCount, 2);
        await api('/sources', { ...source, preview: false });
        service.receive({ ...event, session: 'next', uid: 3, body: 'Private', date: '20261025T120002' }); await tick();
        assert.equal(delivered.at(-1).title, 'iPhone: new notification');
        assert.equal(delivered.at(-1).body, 'Open the device to view it.');
        const status = await (await api('/status')).json();
        assert.ok(status.notifications.every(n => !n.body));
        assert.equal(JSON.stringify(status).includes(token), false);
        assert.equal(JSON.stringify(status).includes(subscription.endpoint), false);
        const before = JSON.parse(fs.readFileSync(path.join(temporary, 'notifications.json')));
        const reloaded = new NotificationService(); reloaded.mount(express(), '/');
        assert.deepEqual(reloaded.store.vapid, before.vapid);
        assert.deepEqual(reloaded.store.subscriptions, before.subscriptions);
        reloaded.release();
        webpush.sendNotification = async () => { throw { statusCode: 410 }; };
        service.receive({ ...event, session: 'next', uid: 4, date: '20261025T120003' }); await tick();
        assert.equal(service.store.subscriptions.length, 0, 'expired subscriptions are persisted as removed');
        assert.equal(fs.statSync(path.join(temporary, 'notifications.json')).mode & 0o777, 0o600);
    } finally { service.release(); await new Promise(r => server.close(r)); }
});

test('changing notification policy cancels pending retries carrying old previews', async () => {
    const service = freshService(); service.load();
    service.store.sources = [source]; service.store.subscriptions = [sub];
    let calls = 0; let reject;
    webpush.sendNotification = () => { calls++; return new Promise((_, r) => reject = r); };
    service.receive({ ...event, uid: 40, date: 'new' });
    service.receive({ ...event, uid: 41, date: 'newer' });
    service.deliveryGeneration++;
    reject({ statusCode: 500 });
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(calls, 1);
    service.release();
});

test('distinct notification identities relay even when content and timestamp match', async () => {
    const service = freshService(); service.load();
    service.store.sources = [source]; service.store.subscriptions = [sub];
    const delivered = [];
    webpush.sendNotification = async (_s, payload) => delivered.push(JSON.parse(payload));
    try {
        service.receive({ ...event, uid: 100, subtitle: 'Alice' });
        service.receive({ ...event, uid: 101, subtitle: 'Bob' });
        service.receive({ ...event, uid: 102, subtitle: 'Bob' });
        await tick();
        assert.equal(delivered.length, 3, 'different UIDs are distinct alerts even when all their attributes match');
        assert.deepEqual(delivered.map(n => n.body), ['Alice\nBody', 'Bob\nBody', 'Bob\nBody']);
        service.receive({ ...event, uid: 102, subtitle: 'Bob', body: 'Duplicate Added with changed text' });
        service.receive({ ...event, uid: 102, event: 'modified', subtitle: 'Bob', body: 'Latest text' });
        await tick();
        assert.equal(delivered.length, 3, 'one UID can push only once within its connection');
        service.receive({ ...event, session: 'next', uid: 200, subtitle: 'Alice' });
        service.receive({ ...event, session: 'next', uid: 201, subtitle: 'Bob' });
        service.receive({ ...event, session: 'next', uid: 202, subtitle: 'Bob', body: 'Latest text' });
        await tick();
        assert.equal(delivered.length, 3, 'each prior alert is matched once after reconnect, including latest modified content');
        service.receive({ ...event, session: 'next', uid: 203, subtitle: 'Bob' });
        await tick();
        assert.equal(delivered.length, 4, 'an additional same-session UID is not consumed by an already matched old alert');
        service.receive({ ...event, session: 'later', uid: 300, subtitle: 'Carol' });
        await tick();
        assert.equal(delivered.length, 5, 'subtitle differences remain distinct across connections too');
    } finally { service.release(); }
});

test('pre-existing alerts, modifications and removals do not suppress unrelated new identities', async () => {
    const service = freshService(); service.load();
    service.store.sources = [source]; service.store.subscriptions = [sub];
    const delivered = [];
    webpush.sendNotification = async (_s, payload) => delivered.push(JSON.parse(payload));
    try {
        service.receive({ ...event, uid: 400, preExisting: true });
        service.receive({ ...event, uid: 401, event: 'modified' });
        service.receive({ ...event, uid: 402 });
        await tick();
        assert.equal(delivered.length, 1, 'an existing alert or modification cannot hide a distinct new alert');
        service.receive({ ...event, uid: 402, event: 'removed' });
        service.receive({ ...event, uid: 402 });
        await tick();
        assert.equal(delivered.length, 2, 'Removed ends the lifetime, so a later Added can reuse its UID');
        service.receive({ ...event, session: 'next', uid: 500, preExisting: true });
        service.receive({ ...event, session: 'next', uid: 501 });
        await tick();
        assert.equal(delivered.length, 2, 'each of the two active alert lifetimes consumes one reconnect candidate');
        service.receive({ ...event, session: 'next', uid: 502, date: undefined, preExisting: true });
        service.receive({ ...event, session: 'later', uid: 503, date: undefined, preExisting: true });
        service.receive({ ...event, session: 'later', uid: 504, date: undefined });
        await tick();
        assert.equal(delivered.length, 3, 'without a date, preExisting and session identities determine suppression');
    } finally { service.release(); }
});

test('notification dedup memory expires and stays bounded', () => {
    const service = freshService(); service.load();
    service.store.sources = [source]; service.store.subscriptions = [];
    try {
        for (let uid = 0; uid < 2100; uid++) service.receive({ ...event, uid, preExisting: true });
        assert.equal(service.observed.size, 2000);
        assert.equal(service.replayCandidates.size, 2000);
        service.observed.set('expired', Date.now() - 3600001);
        service.replayCandidates.set('expired', { fingerprint: 'old', session: 'old', received: Date.now() - 3600001 });
        service.prune();
        assert.equal(service.observed.has('expired'), false);
        assert.equal(service.replayCandidates.has('expired'), false);
    } finally { service.release(); }
});

test('Web Push uses the public HTTPS address as sender without rotating stored keys', async () => {
    await withPushEnv({ WS_PUBLIC_URL: 'https://phone.example', WS_PUSH_SUBJECT: undefined }, async () => {
        const service = freshService(); service.load();
        service.store.sources = [source]; service.store.subscriptions = [sub];
        const keys = { ...service.store.vapid };
        const delivered = [];
        webpush.sendNotification = async (_sub, _payload, options) => delivered.push(options);
        try {
            service.receive(event); await tick();
            assert.equal(delivered.length, 1);
            assert.deepEqual(delivered[0].vapidDetails, { subject: 'https://phone.example', ...keys });
            assert.deepEqual(service.store.vapid, keys);
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporary, 'notifications.json'))).vapid, keys);
        } finally { service.release(); }
    });
});

test('an explicit Web Push sender overrides the public app address', async () => {
    await withPushEnv({ WS_PUBLIC_URL: 'https://phone.example', WS_PUSH_SUBJECT: 'mailto:push@example.com' }, async () => {
        const service = freshService(); service.load();
        service.store.sources = [source]; service.store.subscriptions = [sub];
        const delivered = [];
        webpush.sendNotification = async (_sub, _payload, options) => delivered.push(options);
        try {
            service.receive(event); await tick();
            assert.equal(delivered.length, 1);
            assert.equal(delivered[0].vapidDetails.subject, 'mailto:push@example.com');
            assert.equal(delivered[0].vapidDetails.publicKey, service.store.vapid.publicKey);
            assert.equal(delivered[0].vapidDetails.privateKey, service.store.vapid.privateKey);
        } finally { service.release(); }
    });
});

test('missing Web Push sender configuration fails once without contacting a provider', async () => {
    await withPushEnv({ WS_PUBLIC_URL: undefined, WS_PUSH_SUBJECT: undefined }, async () => {
        const service = freshService(); service.load();
        service.store.sources = [source]; service.store.subscriptions = [sub];
        let calls = 0;
        webpush.sendNotification = async () => { calls++; };
        try {
            service.receive(event); await tick();
            assert.equal(calls, 0);
            assert.deepEqual(service.delivery, {
                sent: 0, failed: 1,
                lastError: 'Set WS_PUBLIC_URL or WS_PUSH_SUBJECT to configure the push sender.',
            });
            assert.equal(service.draining.size, 0, 'no retry is left waiting');
            assert.equal(service.queues.size, 0);
            assert.equal(service.store.subscriptions.length, 1);
        } finally { service.release(); }
    });
});

test('Web Push authentication failures retain subscriptions and expose only a recognized reason', async () => {
    await withPushEnv({ WS_PUBLIC_URL: 'https://phone.example', WS_PUSH_SUBJECT: undefined }, async () => {
        for (const body of [
            JSON.stringify({ reason: 'BadJwtToken', detail: 'private provider detail', endpoint: subscription.endpoint }),
            '<html>private provider detail ' + subscription.endpoint,
            JSON.stringify({ reason: 'private provider detail', endpoint: subscription.endpoint }),
        ]) {
            const service = freshService(); service.load();
            service.store.sources = [source]; service.store.subscriptions = [sub];
            let calls = 0;
            webpush.sendNotification = async () => { calls++; throw { statusCode: 403, body }; };
            try {
                service.receive(event); await tick();
                assert.equal(calls, 1);
                assert.equal(service.delivery.failed, 1);
                assert.equal(service.delivery.sent, 0);
                assert.deepEqual(service.store.subscriptions, [sub]);
                assert.equal(service.draining.size, 0, 'authentication errors are not retried');
                assert.equal(service.delivery.lastError.includes(subscription.endpoint), false);
                assert.equal(service.delivery.lastError.includes('private provider detail'), false);
                if (body.includes('BadJwtToken')) {
                    assert.match(service.delivery.lastError, /BadJwtToken/);
                    assert.match(service.delivery.lastError, /sender credentials/);
                } else assert.equal(service.delivery.lastError, 'Push provider rejected delivery (403)');
            } finally { service.release(); }
        }
    });
});

test('service worker displays pushes and keeps notification clicks within the app', async () => {
    const handlers = {}; const shown = []; const opened = [];
    const self = { registration: { scope: 'https://phone.example/app/', showNotification: async (...args) => shown.push(args) },
        location: new URL('https://phone.example/app/sw.js'),
        clients: { matchAll: async () => [], openWindow: async url => opened.push(url), claim: async () => {} },
        skipWaiting() {}, addEventListener: (name, fn) => handlers[name] = fn };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/public/sw.js'), 'utf8'), { self, URL });
    let work;
    handlers.push({ data: { json: () => ({ title: 'Test', body: 'Hello', url: 'https://evil.example' }) }, waitUntil: p => work = p });
    await work; assert.equal(shown.length, 1); assert.equal(shown[0][0], 'Test');
    handlers.notificationclick({ notification: { data: shown[0][1].data, close() {} }, waitUntil: p => work = p });
    await work; assert.ok(opened[0].startsWith('https://phone.example/app/'));
});

async function historyApi(run) {
    const service = freshService();
    const app = express(); app.set('env', 'test'); service.mount(app, '/');
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/notifications`;
    const token = fs.readFileSync(path.join(temporary, 'notification-setup-key'), 'utf8').trim();
    const api = (url, body, method = body === undefined ? 'GET' : 'POST') => fetch(base + url, {
        method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    try {
        service.store.sources = []; service.store.subscriptions = [];
        await api('/sources', source);
        await run({ service, api });
    } finally { service.release(); await new Promise(r => server.close(r)); }
}

test('per-device unread counts, read and local dismissal persist while source removal preserves history', async () => {
    await historyApi(async ({ service, api }) => {
        await api('/sources', { ...source, id: 'ipad', name: 'iPad', address: 'AA:BB:CC:DD:EE:01' });
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        service.receive({ ...event, canDismiss: true, negativeActionLabel: 'Clear' });
        service.receive({ ...event, source: 'ipad', uid: 2 });
        const status = await (await api('/status')).json();
        assert.equal(status.unread, 2);
        assert.deepEqual(status.unreadBySource, { iphone: 1, ipad: 1 });
        assert.equal(status.retentionDays, 30);
        const item = status.notifications.find(n => n.source === 'iphone');
        assert.equal(item.active, true);
        assert.equal('fingerprint' in item, false);
        const summary = await (await api('/summary')).json();
        assert.equal(summary.unread, 2);
        assert.equal('notifications' in summary, false, 'badge polling does not download private history');
        assert.equal((await api('/history/read', {})).status, 400);
        assert.equal((await api('/history/read', { source: 'unknown' })).status, 400);
        assert.equal((await api('/history/read', { keys: 'not-an-array' })).status, 400);
        assert.equal((await (await api('/history/read', { keys: [item.key] })).json()).unread, 1);
        assert.equal((await (await api('/history/read', { keys: [item.key], read: false })).json()).unread, 2);
        let commands = 0; service.command = () => commands++;
        assert.equal((await (await api(`/history/${item.key}/dismiss`, {})).json()).unread, 1);
        assert.equal(commands, 0, 'dismiss here must not perform an unlabelled iPhone action');
        assert.equal(service.feed.get(item.key).active, true);
        assert.equal(service.feed.get(item.key).dismissed, true);
        service.receive({ ...event, event: 'removed' });
        assert.equal(service.feed.size, 2);
        assert.equal(service.feed.get(item.key).active, false);
        await api('/history/read', { source: 'ipad' });
        await api('/history/read', { keys: [item.key], read: false });
        assert.equal((await api('/history/read', { all: true })).status, 200);
        assert.equal((await (await api('/status')).json()).unread, 0);
        assert.equal(fs.statSync(path.join(temporary, 'notification-history.json')).mode & 0o777, 0o600);
        const reloaded = new NotificationService(); reloaded.load();
        try {
            assert.equal(reloaded.feed.size, 2);
            assert.equal(reloaded.feed.get(item.key).dismissed, true);
            assert.equal(reloaded.feed.get(item.key).read, true);
            assert.equal(reloaded.counts().unread, 0);
            assert.ok([...reloaded.feed.values()].every(n => !n.active), 'reloaded identifiers cannot act until rediscovered');
        } finally { reloaded.release(); }
        await api('/sources/iphone', undefined, 'DELETE');
        assert.equal(service.feed.size, 1);
        assert.equal([...service.feed.values()][0].source, 'ipad');
        assert.deepEqual((await (await api('/summary')).json()).unreadBySource, { ipad: 0 });
    });
});

test('reconnect merges one history item per current UID while keeping read state and identity', async () => {
    await historyApi(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        service.receive(event);
        service.receive({ ...event, uid: 2 });
        const original = [...service.feed.values()];
        await api('/history/read', { keys: [original[0].key] });
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'b' });
        assert.ok([...service.feed.values()].every(n => !n.active));
        service.receive({ ...event, session: 'b', uid: 10, preExisting: true });
        service.receive({ ...event, session: 'b', uid: 11, preExisting: true });
        assert.equal(service.feed.size, 2);
        assert.equal(service.feed.get(original[0].key).read, true);
        assert.equal(service.feed.get(original[1].key).read, false);
        assert.equal(service.feed.get(original[0].key).session, 'b');
        assert.equal(service.feed.get(original[1].key).session, 'b');
        assert.notEqual(service.feed.get(original[0].key).uid, service.feed.get(original[1].key).uid);
        service.receive({ ...event, session: 'a', event: 'removed' });
        assert.ok([...service.feed.values()].every(n => n.active), 'old-session events cannot mutate rediscovered alerts');
        service.receive({ ...event, session: 'b', uid: 10, event: 'removed' });
        service.receive({ ...event, session: 'b', uid: 10 });
        assert.equal(service.feed.size, 3, 'reusing a removed UID creates a separate history lifetime');
        service.saveHistory(true);
        const reloaded = new NotificationService(); reloaded.load();
        try {
            reloaded.handleCollector({ kind: 'session', source: 'iphone', session: 'c' });
            reloaded.receive({ ...event, session: 'c', uid: 20, preExisting: true });
            reloaded.receive({ ...event, session: 'c', uid: 21, preExisting: true });
            assert.equal(reloaded.feed.size, 3, 'restart does not duplicate the two surviving alerts');
            assert.equal([...reloaded.feed.values()].filter(n => n.active).length, 2);
        } finally { reloaded.release(); }
    });
});

test('preview changes redact saved history immediately and retention is bounded per device', async () => {
    await historyApi(async ({ service, api }) => {
        service.receive(event);
        await api('/sources', { ...source, preview: false });
        const saved = JSON.parse(fs.readFileSync(path.join(temporary, 'notification-history.json')));
        assert.equal(saved.items.length, 1);
        assert.equal(saved.items[0].body, '');
        assert.equal(saved.items[0].title, '');
        await api('/sources', source);
        assert.equal([...service.feed.values()][0].body, '', 'reenabling previews does not resurrect old private text');
        for (let uid = 2; uid <= 502; uid++) service.receive({ ...event, uid, date: String(uid), preExisting: true });
        assert.equal(service.feed.size, 500);
        const oldest = [...service.feed.values()][0];
        oldest.received = Date.now() - 31 * 86400000;
        service.prune();
        assert.equal(service.feed.has(oldest.key), false);
        assert.equal(service.feed.size, 499);
    });
});

test('iPhone actions require the displayed label, active session and matching confirmation', async () => {
    await historyApi(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        service.receive({ ...event, canDismiss: true, negativeActionLabel: 'Clear' });
        const item = [...service.feed.values()][0];
        const route = `/history/${item.key}/action`;
        let calls = 0;
        service.command = command => {
            calls++;
            assert.equal(command.type, 'dismiss');
            assert.equal(command.expectedLabel, 'Clear');
            assert.equal(command.session, 'a');
            service.handleCollector({ ...command, kind: 'action-result', session: 'wrong', ok: true });
            assert.equal(service.actions.size, 1, 'unrelated confirmation does not complete request');
            setImmediate(() => service.handleCollector({ ...command, kind: 'action-result', ok: true }));
        };
        assert.equal((await api(route, {})).status, 400);
        assert.equal((await api(route, { expectedLabel: 'Decline' })).status, 400);
        assert.equal(calls, 0);
        assert.equal((await api(route, { expectedLabel: 'Clear' })).status, 200);
        assert.equal(calls, 1);
        assert.equal(item.read, true);
        assert.equal(item.active, true, 'write confirmation does not falsely claim notification removal');
        service.receive({ ...event, event: 'removed' });
        assert.equal(item.active, false);
        assert.equal((await api(route, { expectedLabel: 'Clear' })).status, 400);
        service.receive({ ...event, uid: 2, canDismiss: true, negativeActionLabel: 'Clear' });
        const next = [...service.feed.values()].find(n => n.uid === 2);
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'b' });
        assert.equal((await api(`/history/${next.key}/action`, { expectedLabel: 'Clear' })).status, 400);
        assert.equal(calls, 1, 'stale connection never receives an action command');
    });
});

test('failed and disconnected iPhone actions report errors without marking the alert read', async () => {
    await historyApi(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        service.receive({ ...event, canDismiss: true, negativeActionLabel: 'Clear' });
        const item = [...service.feed.values()][0];
        const route = `/history/${item.key}/action`;
        service.command = command => setImmediate(() => service.handleCollector({
            ...command, kind: 'action-result', ok: false, error: 'The iPhone rejected this action',
        }));
        let response = await api(route, { expectedLabel: 'Clear' });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /rejected/);
        assert.equal(item.read, false);
        assert.equal(item.dismissed, false);
        service.command = () => setImmediate(() => service.handleCollector({
            kind: 'status', source: 'iphone', status: 'Bluetooth disconnected; waiting for iPhone',
        }));
        response = await api(route, { expectedLabel: 'Clear' });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /disconnected/);
        assert.equal(item.read, false);
        assert.equal(item.active, false);
        assert.equal(service.actions.size, 0);
    });
});

test('history keeps its identity after a reconnect beyond the short push dedup window', async () => {
    await historyApi(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        service.receive(event);
        const original = [...service.feed.values()][0];
        await api(`/history/${original.key}/dismiss`, {});
        for (const hint of service.replayCandidates.values()) hint.received = Date.now() - 7200000;
        service.prune();
        assert.equal(service.replayCandidates.size, 0);
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'later' });
        service.receive({ ...event, session: 'later', uid: 99, preExisting: true });
        assert.equal(service.feed.size, 1);
        assert.equal(service.feed.get(original.key).uid, 99);
        assert.equal(service.feed.get(original.key).dismissed, true);
        assert.equal(service.counts().unread, 0);
    });
});

test('an action confirmation marks the current history record read after an intervening modification', async () => {
    await historyApi(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        service.receive({ ...event, canDismiss: true, negativeActionLabel: 'Clear' });
        const original = [...service.feed.values()][0];
        service.command = command => setImmediate(() => {
            service.receive({ ...event, event: 'modified', body: 'Updated', canDismiss: true, negativeActionLabel: 'Clear' });
            service.handleCollector({ ...command, kind: 'action-result', ok: true });
        });
        assert.equal((await api(`/history/${original.key}/action`, { expectedLabel: 'Clear' })).status, 200);
        assert.equal(service.feed.get(original.key).read, true);
        assert.equal(service.feed.get(original.key).body, 'Updated');
        assert.equal(service.counts().unread, 0);
    });
});

test('queued pushes use current unread counts after the user marks history read', async () => {
    await historyApi(async ({ service, api }) => {
        service.store.subscriptions = [sub];
        const delivered = []; let finishFirst;
        webpush.sendNotification = async (_s, payload) => {
            delivered.push(JSON.parse(payload));
            if (delivered.length === 1) await new Promise(resolve => finishFirst = resolve);
        };
        service.receive(event);
        service.receive({ ...event, uid: 2, date: 'later' });
        await api('/history/read', { all: true });
        finishFirst(); await tick();
        assert.equal(delivered.length, 2);
        assert.equal(delivered[1].unreadCount, 0);
    });
});

test('bulk dismissal recognizes only explicit Clear and Dismiss labels', () => {
    const { isDismissActionLabel } = require('../src/common/NotificationActions');
    for (const label of ['Clear', 'Dismiss', 'clear notification', ' DISMISS NOTIFICATION '])
        assert.equal(isDismissActionLabel(label), true, label);
    for (const label of [undefined, '', 'Decline', 'Delete', 'Block', 'Accept', 'Clear data', 'Dismiss all', 'Remove', 'Clear and delete'])
        assert.equal(isDismissActionLabel(label), false, String(label));
});

test('local bulk dismissal is limited to the confirmed device snapshot and makes no phone calls', async () => {
    await historyApi(async ({ service, api }) => {
        await api('/sources', { ...source, id: 'ipad', address: 'AA:BB:CC:DD:EE:01' });
        service.receive(event);
        service.receive({ ...event, uid: 2 });
        const keys = [...service.feed.keys()];
        service.receive({ ...event, source: 'ipad', uid: 3 });
        const other = [...service.feed.values()].find(item => item.source === 'ipad');
        service.receive({ ...event, uid: 4 });
        const arriving = [...service.feed.values()].find(item => item.uid === 4);
        let calls = 0; service.command = () => calls++;
        assert.equal((await api('/history/dismiss', { source: 'iphone', keys: [keys[0], other.key] })).status, 400);
        assert.ok([...service.feed.values()].every(item => !item.dismissed), 'invalid cross-device selection is atomic');
        assert.equal((await api('/history/dismiss', { source: 'iphone', keys: [keys[0], keys[0]] })).status, 400);
        assert.equal((await api('/history/dismiss', { source: 'unknown', keys })).status, 400);
        assert.equal((await api('/history/dismiss', { source: 'iphone', keys: [] })).status, 400);
        const reply = await (await api('/history/dismiss', { source: 'iphone', keys: [...keys, 'expired-key'] })).json();
        assert.deepEqual(reply.dismissed, keys);
        assert.equal(reply.unread, 2);
        assert.equal(service.feed.get(arriving.key).dismissed, false, 'arrivals after confirmation are not included');
        assert.equal(service.feed.get(other.key).dismissed, false);
        assert.equal(calls, 0);
        const repeated = await (await api('/history/dismiss', { source: 'iphone', keys })).json();
        assert.deepEqual(repeated.dismissed, [], 'already dismissed records are not reported twice');
        const saved = JSON.parse(fs.readFileSync(path.join(temporary, 'notification-history.json')));
        assert.equal(saved.items.filter(item => item.dismissed && item.read).length, 2);
    });
});

test('phone bulk dismissal validates every source and label before writing any action', async () => {
    await historyApi(async ({ service, api }) => {
        await api('/sources', { ...source, id: 'ipad', address: 'AA:BB:CC:DD:EE:01' });
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        service.handleCollector({ kind: 'session', source: 'ipad', session: 'a' });
        service.receive({ ...event, canDismiss: true, negativeActionLabel: 'Clear' });
        service.receive({ ...event, uid: 2, canDismiss: true, negativeActionLabel: 'Decline' });
        service.receive({ ...event, source: 'ipad', uid: 3, canDismiss: true, negativeActionLabel: 'Clear' });
        const all = [...service.feed.values()];
        const selected = item => ({ key: item.key, expectedLabel: item.negativeActionLabel });
        let calls = 0; service.command = () => calls++;
        assert.equal((await api('/history/actions', { source: 'iphone', items: [selected(all[0]), selected(all[1])] })).status, 400);
        assert.equal((await api('/history/actions', { source: 'iphone', items: [selected(all[0]), selected(all[2])] })).status, 400);
        assert.equal((await api('/history/actions', { source: 'iphone', items: [selected(all[0]), { key: all[1].key, expectedLabel: 'Clear' }] })).status, 400);
        assert.equal((await api('/history/actions', { source: 'iphone', items: [selected(all[0]), selected(all[0])] })).status, 400);
        assert.equal((await api('/history/actions', { source: 'iphone', items: [selected(all[0]), { key: 'expired-key', expectedLabel: 'Delete' }] })).status, 400);
        assert.equal(calls, 0, 'no earlier valid action executes if a later selection is invalid');
        assert.ok(all.every(item => !item.read));
    });
});

test('phone bulk dismissal uses only its snapshot, skips stale entries and keeps history until removal events', async () => {
    await historyApi(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        for (let uid = 1; uid <= 3; uid++) service.receive({ ...event, uid, canDismiss: true, negativeActionLabel: 'Clear' });
        const all = [...service.feed.values()];
        const items = all.map(item => ({ key: item.key, expectedLabel: item.negativeActionLabel }));
        service.receive({ ...event, uid: 3, event: 'removed' });
        const called = [];
        service.command = command => {
            called.push(command.uid);
            if (called.length === 1) service.receive({ ...event, uid: 4, canDismiss: true, negativeActionLabel: 'Clear' });
            setImmediate(() => service.handleCollector({ ...command, kind: 'action-result', ok: true }));
        };
        const reply = await (await api('/history/actions', { source: 'iphone', items: [...items, { key: 'expired-key', expectedLabel: 'Clear' }] })).json();
        assert.equal(reply.ok, true);
        assert.deepEqual(called, [1, 2]);
        assert.deepEqual(reply.accepted, all.slice(0, 2).map(item => item.key));
        assert.deepEqual(reply.skipped, [all[2].key, 'expired-key']);
        assert.deepEqual(reply.failed, []);
        assert.deepEqual(reply.unprocessed, []);
        assert.equal(service.feed.size, 4, 'accepted phone actions retain history');
        assert.equal(service.feed.get(all[0].key).active, true, 'ATT acceptance does not claim source removal');
        assert.equal([...service.feed.values()].find(item => item.uid === 4).read, false, 'new arrivals are untouched');
    });
});

test('phone bulk dismissal stops after an uncertain failure and reports partial acceptance without raw errors', async () => {
    await historyApi(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        for (let uid = 1; uid <= 3; uid++) service.receive({ ...event, uid, canDismiss: true, negativeActionLabel: 'Clear' });
        const all = [...service.feed.values()];
        const called = [];
        service.command = command => {
            called.push(command.uid);
            setImmediate(() => service.handleCollector({ ...command, kind: 'action-result', ok: command.uid === 1,
                error: 'Raw private provider error should not escape', }));
        };
        const reply = await (await api('/history/actions', { source: 'iphone', items: all.map(item => ({ key: item.key, expectedLabel: 'Clear' })) })).json();
        assert.equal(reply.ok, false);
        assert.deepEqual(called, [1, 2], 'failed action is not retried and later actions are not sent');
        assert.deepEqual(reply.accepted, [all[0].key]);
        assert.deepEqual(reply.failed, [{ key: all[1].key, error: 'The iPhone did not confirm dismissal. Check the phone before trying again.' }]);
        assert.deepEqual(reply.unprocessed, [all[2].key]);
        assert.equal(service.feed.get(all[0].key).read, true);
        assert.equal(service.feed.get(all[1].key).read, false);
        assert.equal(service.feed.get(all[2].key).read, false);
        assert.equal(service.bulkSources.size, 0);
    });
});

test('phone bulk dismissal prevents concurrent same-device actions and bounds total processing time', async () => {
    await historyApi(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        for (let uid = 1; uid <= 2; uid++) service.receive({ ...event, uid, canDismiss: true, negativeActionLabel: 'Clear' });
        const all = [...service.feed.values()];
        const body = { source: 'iphone', items: all.map(item => ({ key: item.key, expectedLabel: 'Clear' })) };
        let written; let captured;
        const firstWrite = new Promise(resolve => written = resolve);
        service.command = command => { captured = command; written(); };
        const pending = api('/history/actions', body);
        await firstWrite;
        assert.equal((await api('/history/actions', body)).status, 400);
        assert.equal((await api(`/history/${all[1].key}/action`, { expectedLabel: 'Clear' })).status, 400);
        const originalNow = Date.now;
        const advanced = originalNow() + 31000;
        try {
            Date.now = () => advanced;
            service.handleCollector({ ...captured, kind: 'action-result', ok: true });
            const reply = await (await pending).json();
            assert.equal(reply.ok, false);
            assert.deepEqual(reply.accepted, [all[0].key]);
            assert.deepEqual(reply.unprocessed, [all[1].key]);
            assert.equal(service.bulkSources.size, 0);
        } finally { Date.now = originalNow; }
    });
});

test('phone bulk dismissal skips a changed action label instead of declining a call', async () => {
    await historyApi(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        for (let uid = 1; uid <= 2; uid++) service.receive({ ...event, uid, canDismiss: true, negativeActionLabel: 'Clear' });
        const all = [...service.feed.values()];
        const called = [];
        service.command = command => {
            called.push(command.uid);
            service.receive({ ...event, uid: 2, event: 'modified', canDismiss: true, negativeActionLabel: 'Decline' });
            setImmediate(() => service.handleCollector({ ...command, kind: 'action-result', ok: true }));
        };
        const reply = await (await api('/history/actions', { source: 'iphone', items: all.map(item => ({ key: item.key, expectedLabel: 'Clear' })) })).json();
        assert.deepEqual(called, [1]);
        assert.deepEqual(reply.accepted, [all[0].key]);
        assert.deepEqual(reply.skipped, [all[1].key]);
        assert.equal(service.feed.get(all[1].key).negativeActionLabel, 'Decline');
    });
});

test('bulk endpoints accept a full 500-notification confirmation snapshot and reject larger batches', async () => {
    await historyApi(async ({ api }) => {
        const items = Array.from({ length: 500 }, (_, index) => ({
            key: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            expectedLabel: 'Dismiss notification',
        }));
        const body = { source: 'iphone', items };
        assert.ok(JSON.stringify(body).length > 24 * 1024, 'the full phone snapshot exceeds the earlier request limit');
        const response = await api('/history/actions', body);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).skipped.length, 500);
        assert.equal((await api('/history/actions', { source: 'iphone', items: [...items, { key: 'extra', expectedLabel: 'Clear' }] })).status, 400);
        assert.equal((await api('/history/dismiss', { source: 'iphone', keys: items.map(item => item.key) })).status, 200);
        assert.equal((await api('/history/dismiss', { source: 'iphone', keys: [...items.map(item => item.key), 'extra'] })).status, 400);
    });
});

test('Bluetooth disconnection stops bulk dismissal with the remaining confirmed items unprocessed', async () => {
    await historyApi(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        for (let uid = 1; uid <= 3; uid++) service.receive({ ...event, uid, canDismiss: true, negativeActionLabel: 'Clear' });
        const all = [...service.feed.values()];
        const called = [];
        service.command = command => {
            called.push(command.uid);
            setImmediate(() => {
                if (command.uid === 1) service.handleCollector({ ...command, kind: 'action-result', ok: true });
                else service.handleCollector({ kind: 'status', source: 'iphone', status: 'Bluetooth disconnected; waiting for iPhone' });
            });
        };
        const reply = await (await api('/history/actions', { source: 'iphone', items: all.map(item => ({ key: item.key, expectedLabel: 'Clear' })) })).json();
        assert.equal(reply.ok, false);
        assert.deepEqual(called, [1, 2]);
        assert.deepEqual(reply.accepted, [all[0].key]);
        assert.match(reply.failed[0].error, /disconnected/);
        assert.deepEqual(reply.unprocessed, [all[2].key]);
        assert.equal(service.bulkSources.size, 0);
        assert.equal(service.actions.size, 0);
    });
});

test('restoring a local dismissal preserves its prior read state, recounts and persists without Bluetooth actions', async () => {
    await historyApi(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        service.receive({ ...event, canDismiss: true, negativeActionLabel: 'Clear' });
        const item = [...service.feed.values()][0];
        let commands = 0; service.command = () => commands++;
        await api(`/history/${item.key}/dismiss`, {});
        assert.equal(service.counts().unread, 0);
        let response = await api(`/history/${item.key}/restore`, { read: false });
        assert.equal(response.status, 200);
        let reply = await response.json();
        assert.equal(reply.ok, true);
        assert.equal(reply.unread, 1);
        assert.deepEqual(reply.unreadBySource, { iphone: 1 });
        assert.equal(item.dismissed, false);
        assert.equal(item.read, false);
        assert.equal(item.active, true);
        assert.equal(item.canDismiss, true);
        const saved = JSON.parse(fs.readFileSync(path.join(temporary, 'notification-history.json')));
        assert.equal(saved.items.find(savedItem => savedItem.key === item.key).dismissed, false);
        assert.equal(saved.items.find(savedItem => savedItem.key === item.key).read, false);
        const reloaded = new NotificationService(); reloaded.load();
        try {
            assert.equal(reloaded.feed.get(item.key).dismissed, false);
            assert.equal(reloaded.feed.get(item.key).read, false);
            assert.equal(reloaded.counts().unread, 1);
        } finally { reloaded.release(); }
        await api(`/history/${item.key}/dismiss`, {});
        response = await api(`/history/${item.key}/restore`, {});
        reply = await response.json();
        assert.equal(reply.unread, 0, 'moving an archived notification to the inbox defaults to read');
        assert.equal(item.read, true);
        assert.equal(item.dismissed, false);
        assert.equal(commands, 0, 'Undo never writes an action to the source phone');
    });
});

test('restoring local history cannot revive a removed phone alert or a stale Bluetooth session', async () => {
    await historyApi(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        service.receive({ ...event, canDismiss: true, negativeActionLabel: 'Clear' });
        const item = [...service.feed.values()][0];
        await api(`/history/${item.key}/dismiss`, {});
        service.receive({ ...event, event: 'removed' });
        assert.equal(item.active, false);
        assert.equal(item.canDismiss, false);
        let commands = 0; service.command = () => commands++;
        assert.equal((await api(`/history/${item.key}/restore`, { read: false })).status, 200);
        assert.equal(item.active, false);
        assert.equal(item.canDismiss, false);
        assert.equal(item.reconnectable, false);
        assert.equal((await api(`/history/${item.key}/action`, { expectedLabel: 'Clear' })).status, 400);
        service.receive({ ...event, uid: 2, canDismiss: true, negativeActionLabel: 'Clear' });
        const stale = [...service.feed.values()].find(n => n.uid === 2);
        await api(`/history/${stale.key}/dismiss`, {});
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'b' });
        assert.equal((await api(`/history/${stale.key}/restore`, { read: true })).status, 200);
        assert.equal(stale.active, false);
        assert.equal(stale.session, 'a');
        assert.equal((await api(`/history/${stale.key}/action`, { expectedLabel: 'Clear' })).status, 400);
        assert.equal(commands, 0);
    });
});

test('restoring history rejects invalid read states, malformed bodies and expired keys without mutation', async () => {
    await historyApi(async ({ service, api }) => {
        service.receive(event);
        const item = [...service.feed.values()][0];
        await api(`/history/${item.key}/dismiss`, {});
        for (const body of [{ read: 'false' }, { read: 0 }, { read: null }, [], null])
            assert.equal((await api(`/history/${item.key}/restore`, body)).status, 400);
        assert.equal(item.dismissed, true);
        assert.equal(item.read, true);
        assert.equal((await api('/history/unknown-key/restore', { read: false })).status, 400);
        item.received = Date.now() - 31 * 86400000;
        assert.equal((await api(`/history/${item.key}/restore`, { read: false })).status, 400);
        assert.equal(service.feed.has(item.key), false, 'expired history cannot be resurrected by Undo');
        assert.equal(service.counts().unread, 0);
    });
});
