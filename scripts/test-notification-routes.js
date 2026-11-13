// HTTP route contracts use an ephemeral fixture listener and fake phone acknowledgments.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-notification-routes-'));
process.env.WS_DATA_DIR = temporary;
process.env.WS_NOTIFICATION_DATA = temporary;
process.env.WS_NOTIFICATIONS_COLLECTOR = '0';
process.env.WS_PUBLIC_URL = 'https://phone.example';
delete process.env.WS_IOS_SETTINGS_KEY;
delete process.env.WS_IOS_SETTINGS_KEY_FILE;
require('ts-node').register({ transpileOnly: true });
const { NotificationService } = require('../src/server/notifications/NotificationService');
const { resetSettingsForTests } = require('../src/server/Settings');
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

const source = { id: 'one', address: 'AA:BB:CC:DD:EE:FF', name: 'First phone', apps: [], preview: true };
const second = { ...source, id: 'two', address: '11:22:33:44:55:66', name: 'Second phone' };
const subscription = { endpoint: 'https://web.push.apple.com/fixture', keys: {
    p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url'),
} };

async function mounted(run, sources = [source, second]) {
    for (const name of ['notifications.json', 'notification-history.json']) fs.rmSync(path.join(temporary, name), { force: true });
    const service = new NotificationService();
    const app = express();
    service.mount(app, '/nested/');
    service.store.sources = structuredClone(sources);
    service.icons.get = async () => null;
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const api = (url, body, extra = {}) => fetch(origin + '/nested/api/notifications' + url, {
        method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...extra.headers },
        body: body === undefined ? undefined : JSON.stringify(body), ...extra,
    });
    const seed = (id, uid, patch = {}) => {
        if (service.sessions.get(id) !== 'active-' + id)
            service.handleCollector({ kind: 'session', source: id, session: 'active-' + id });
        service.receive({ source: id, session: 'active-' + id, uid, event: 'added', app: 'com.example',
            title: 'Fixture alert', date: String(uid), canDismiss: true, negativeActionLabel: 'Clear', ...patch });
        return [...service.feed.values()].find((item) => item.source === id && item.uid === uid);
    };
    try { await run({ service, api, seed, origin }); }
    finally { service.release(); await new Promise((resolve) => server.close(resolve)); }
}

const ready = async (condition) => {
    for (let turn = 0; turn < 100; turn++) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('Fixture request did not reach its fake collector');
};

test('notification routes retain base path, origin checks, response headers and history revisions', async () => {
    await mounted(async ({ api, seed, origin }) => {
        assert.equal((await fetch(origin + '/api/notifications/status')).status, 404);
        assert.equal((await api('/status', undefined, { headers: { origin: 'https://elsewhere.example' } })).status, 403);
        const status = await api('/status', undefined, { headers: { origin: 'https://phone.example' } });
        assert.equal(status.status, 200);
        assert.equal(status.headers.get('cache-control'), 'no-store');
        assert.equal((await api('/sources', { ...source, name: 'x'.repeat(65536) })).status, 413);
        assert.equal((await api('/sources', source, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
            body: zlib.gzipSync(JSON.stringify(source)) })).status, 415);
        seed('one', 1, { body: 'x'.repeat(2000) });
        const history = await api('/history?source=one', undefined, { headers: { 'accept-encoding': 'gzip' } });
        assert.equal(history.headers.get('vary'), 'Accept-Encoding');
        assert.equal(history.headers.get('content-encoding'), 'gzip');
        const body = await history.json();
        assert.equal(body.notifications.length, 1);
        assert.equal((await api('/history?source=one&since=' + body.revision)).status, 304);
        assert.equal((await api('/history?source=missing')).status, 400);
        assert.equal((await api('/icons/missing/com.example')).status, 400);
        assert.equal((await api('/icons/one/com.example')).status, 404);
        assert.deepEqual(await (await api('/summary')).json(), {
            unread: 1, unreadBySource: { one: 1, two: 0 },
            sources: [{ id: 'one', name: source.name }, { id: 'two', name: second.name }],
        });
    });
});

test('source schema preserves old payloads, app scoping, mute limits, source order and no collector restart for filter changes', async () => {
    await mounted(async ({ service, api, seed }) => {
        let restarts = 0;
        service.collector.restartCollector = () => restarts++;
        const muted = [{ app: 'com.muted', name: 'Muted app' }];
        assert.equal((await api('/sources', { ...source, apps: ['com.allowed'], muted, name: 'Renamed' })).status, 200);
        assert.equal((await api('/sources', { ...source, apps: ['com.allowed'] })).status, 200);
        assert.deepEqual(service.store.sources.map((item) => item.id), ['one', 'two']);
        assert.deepEqual(service.store.sources[0].muted, muted);
        assert.equal(restarts, 0);
        seed('one', 1, { app: 'com.ignored' });
        assert.equal(service.feed.size, 0);
        seed('one', 2, { app: 'com.allowed' });
        assert.equal(service.feed.size, 1);
        for (const patch of [
            { id: 'bad/id' }, { address: 'bad' }, { name: ' ' }, { name: 'x'.repeat(101) },
            { preview: 1 }, { apps: ['x'.repeat(257)] }, { apps: Array(101).fill('com.example') },
            { muted: Array(201).fill({ app: 'com.muted', name: 'Muted' }) },
            { muted: [{ app: '', name: 'Muted' }] }, { muted: [{ app: 'com.muted', name: 'x'.repeat(513) }] },
        ]) assert.equal((await api('/sources', { ...source, ...patch })).status, 400);
        assert.equal((await api('/sources', { ...source, address: second.address })).status, 400);
        assert.equal(service.feed.size, 1, 'invalid source requests do not redact stored text');
        assert.equal((await api('/sources', { ...source, preview: false })).status, 200);
        assert.equal([...service.feed.values()][0].title, '');
        assert.equal(restarts, 0);
        assert.equal((await api('/sources', { ...source, address: '77:88:99:AA:BB:CC' })).status, 200);
        assert.equal(restarts, 1);
    });
});

test('read, archive and restore schemas retain bounds, full-snapshot scope and local-only actions', async () => {
    await mounted(async ({ service, api, seed }) => {
        const one = seed('one', 1), two = seed('two', 2);
        let writes = 0; service.command = () => { writes++; };
        for (const body of [{}, { all: true, source: 'one' }, { keys: [1] }, { keys: Array(501).fill('x') }, { source: 'missing' }, { all: 'true' }])
            assert.equal((await api('/history/read', body)).status, 400);
        assert.equal((await api('/history/read', { source: 'one', keys: [two.key] })).status, 200);
        assert.equal(two.read, false, 'read keys remain intersected with their optional source');
        for (const body of [{ source: 'one', keys: [] }, { source: 'one', keys: [one.key, one.key] },
            { source: 'one', keys: ['x'.repeat(257)] }, { source: 'one', keys: [one.key, two.key] }])
            assert.equal((await api('/history/dismiss', body)).status, 400);
        assert.equal(one.dismissed, false, 'scope errors reject the full snapshot before mutating its first item');
        const dismissed = await (await api('/history/dismiss', { source: 'one', keys: [one.key, 'expired'] })).json();
        assert.deepEqual(dismissed.dismissed, [one.key]);
        assert.equal(one.read, true); assert.equal(one.dismissed, true);
        for (const body of [{ source: 'one', items: [] }, { source: 'one', items: [{ key: one.key, read: 'no' }] },
            { source: 'one', items: [{ key: one.key, read: false }, { key: two.key, read: false }] }])
            assert.equal((await api('/history/restore', body)).status, 400);
        assert.equal(one.dismissed, true);
        const restored = await (await api('/history/restore', { source: 'one', items: [{ key: one.key, read: false }] })).json();
        assert.deepEqual(restored.restored, [one.key]);
        assert.equal(one.read, false); assert.equal(one.dismissed, false);
        assert.equal((await api('/history/' + one.key + '/restore', { read: null })).status, 400);
        assert.equal(writes, 0, 'history changes do not write a phone action');
    });
});

test('phone action is accepted only after matching acknowledgment, never after a successful pipe write', async () => {
    await mounted(async ({ service, api, seed }) => {
        const item = seed('one', 1);
        let command;
        service.collector.command = async (value) => { command = value; };
        let finished = false;
        const request = api('/history/' + item.key + '/action', { expectedLabel: 'Clear' }).then((response) => { finished = true; return response; });
        await ready(() => command);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(finished, false); assert.equal(item.read, false);
        service.handleCollector({ ...command, kind: 'action-result', uid: command.uid + 1, ok: true });
        assert.equal(service.actions.size, 1);
        service.handleCollector({ ...command, kind: 'action-result', ok: true });
        assert.equal((await request).status, 200);
        assert.equal(item.read, true); assert.equal(item.dismissed, false); assert.equal(item.active, true);
    });
});

test('asynchronous write failure stops a bulk batch with accepted, failed and unprocessed keys kept separate', async () => {
    await mounted(async ({ service, api, seed }) => {
        const items = [seed('one', 1), seed('one', 2), seed('one', 3)];
        const commands = [];
        service.collector.command = async (command) => {
            commands.push(command);
            if (commands.length === 2) throw Error('synthetic pipe failure');
            setImmediate(() => service.handleCollector({ ...command, kind: 'action-result', ok: true }));
        };
        const response = await api('/history/actions', { source: 'one', items: items.map((item) => ({ key: item.key, expectedLabel: 'Clear' })) });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.ok, false);
        assert.deepEqual(body.accepted, [items[0].key]);
        assert.deepEqual(body.failed.map((item) => item.key), [items[1].key]);
        assert.deepEqual(body.skipped, []); assert.deepEqual(body.unprocessed, [items[2].key]);
        assert.equal(commands.length, 2); assert.equal(service.actions.size, 0);
        assert.deepEqual(items.map((item) => item.read), [true, false, false]);
        assert.ok(items.every((item) => !item.dismissed));
    });
});

test('bulk routes validate all labels and sources before writing and retain the 15s action and 30s batch budgets', async (t) => {
    await mounted(async ({ service, api, seed }) => {
        const items = [seed('one', 1), seed('one', 2), seed('one', 3)], other = seed('two', 4);
        let calls = 0;
        service.command = () => { calls++; };
        for (const selected of [
            [{ key: items[0].key, expectedLabel: 'Clear' }, { key: other.key, expectedLabel: 'Clear' }],
            [{ key: items[0].key, expectedLabel: 'Clear' }, { key: items[1].key, expectedLabel: 'Decline' }],
            [{ key: items[0].key, expectedLabel: 'Clear' }, { key: items[1].key, expectedLabel: 'Dismiss' }],
            [{ key: items[0].key, expectedLabel: 'Clear' }, { key: items[0].key, expectedLabel: 'Clear' }],
        ]) assert.equal((await api('/history/actions', { source: 'one', items: selected })).status, 400);
        assert.equal(calls, 0);
        let now = Date.now();
        t.mock.method(Date, 'now', () => now);
        const budgets = [];
        service.performAction = async (_item, label, timeout) => { assert.equal(label, 'Clear'); budgets.push(timeout); now += 15000; };
        const result = await (await api('/history/actions', { source: 'one', items: items.map((item) => ({ key: item.key, expectedLabel: 'Clear' })) })).json();
        assert.deepEqual(budgets, [15000, 15000]);
        assert.deepEqual(result.accepted, items.slice(0, 2).map((item) => item.key));
        assert.deepEqual(result.unprocessed, [items[2].key]);
        assert.equal(result.ok, false);
    });
});

test('subscription replacement preserves selections and keys, bounds providers and scopes the receiver source', async () => {
    await mounted(async ({ service, api }) => {
        const keysBefore = { ...service.store.vapid };
        assert.equal((await api('/subscriptions', { subscription, sources: ['one'], receiverSource: 'two' })).status, 200);
        const old = service.store.subscriptions[0];
        const next = { ...subscription, endpoint: 'https://web.push.apple.com/replacement' };
        const result = await (await api('/subscriptions', { subscription: next, replaces: subscription.endpoint })).json();
        assert.equal(result.id, crypto.createHash('sha256').update(next.endpoint).digest('hex'));
        assert.equal(service.store.subscriptions.length, 1);
        assert.deepEqual(service.store.subscriptions[0].sources, ['one']);
        assert.equal(service.store.subscriptions[0].receiverSource, 'two');
        assert.notEqual(result.id, old.id);
        for (const body of [
            { subscription: next, sources: ['missing'] },
            { subscription: next, sources: ['one'], receiverSource: 'missing' },
            { subscription: { ...next, endpoint: 'https://untrusted.example/endpoint' }, sources: ['one'] },
            { subscription: { ...next, keys: { ...next.keys, auth: 'bad' } }, sources: ['one'] },
        ]) assert.equal((await api('/subscriptions', body)).status, 400);
        assert.deepEqual(service.store.vapid, keysBefore);
        assert.deepEqual(service.store.subscriptions[0].sources, ['one']);
        assert.equal((await api('/subscriptions', { endpoint: next.endpoint }, { method: 'DELETE' })).status, 200);
        assert.equal(service.store.subscriptions.length, 0);
    });
});

test('pairing confirmation retains the exact pending address/code and a pipe failure cannot report success', async () => {
    await mounted(async ({ service, api }) => {
        const commands = [];
        service.collector.command = async (command) => { commands.push(command); };
        assert.equal((await api('/pair', {})).status, 200);
        service.handleCollector({ kind: 'pairing', address: source.address, code: 'fixture-code' });
        for (const body of [{ address: second.address, code: 'fixture-code' }, { address: source.address, code: 'old' }])
            assert.equal((await api('/confirm', body)).status, 400);
        assert.equal(commands.length, 1);
        assert.equal((await api('/confirm', { address: source.address, code: 'fixture-code' })).status, 200);
        assert.deepEqual(commands[1], { type: 'confirm', address: source.address, code: 'fixture-code' });
        const until = service.pairUntil;
        service.collector.command = async () => { throw Error('fixture pipe failure'); };
        assert.equal((await api('/pair', {})).status, 400);
        assert.equal(service.pairUntil, until);
    });
});

// Resolve the actual pipe-write promise, then end its ownership before the await resumes.
test('pair continuation cannot reopen state after release or collector replacement', async (t) => {
    for (const transition of ['release', 'replacement']) await t.test(transition, async () => {
        await mounted(async ({ service, api }) => {
            const children = [];
            const timers = [];
            service.pairUntil = 0;
            service.pairingRejectedAt = 123;
            service.pairingError = { message: 'Pairing failed: fixture', at: Date.now() };
            service.collector.runtime.script = () => '/fixture/collector.py';
            service.collector.runtime.setTimeout = (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; };
            service.collector.runtime.clearTimeout = () => undefined;
            service.collector.runtime.spawn = () => {
                const child = new EventEmitter();
                child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
                child.stdout.setEncoding = child.stderr.setEncoding = () => undefined;
                child.stdin.writable = true;
                child.kill = () => true;
                child.stdin.write = (line, callback) => {
                    callback();
                    if (JSON.parse(line).type !== 'pair') return true;
                    if (transition === 'release') service.release();
                    else { child.emit('close'); timers.at(-1).callback(); }
                    return true;
                };
                children.push(child); return child;
            };
            process.env.WS_NOTIFICATIONS_COLLECTOR = '1'; resetSettingsForTests();
            try {
                service.collector.start();
                const response = await api('/pair', {});
                assert.equal(response.status, 400, 'a stale pair continuation cannot report a newly opened window');
                assert.equal(service.pairUntil, 0);
                assert.equal(service.pairingRejectedAt, 123);
                assert.equal(service.pairingError.message, 'Pairing failed: fixture');
                assert.equal(children.length, transition === 'release' ? 1 : 2);
            } finally {
                process.env.WS_NOTIFICATIONS_COLLECTOR = '0'; resetSettingsForTests();
            }
        });
    });
});
