// Collector supervision, Setup page errors and stored previews in NotificationService, and the
// feed it keeps (NotificationFeed) on its own.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
require('ts-node').register({ transpileOnly: true });
const { resetSettingsForTests } = require('../src/server/Settings');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-notification-service-'));
process.env.WS_NOTIFICATION_DATA = temporary;
process.env.WS_DATA_DIR = temporary;
process.env.WS_NOTIFICATIONS_COLLECTOR = '0';
const { NotificationService } = require('../src/server/notifications/NotificationService');
const { NotificationFeed, shouldRelay } = require('../src/server/notifications/NotificationFeed');
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const source = { id: 'iphone', address: 'AA:BB:CC:DD:EE:FF', name: 'iPhone', apps: [], preview: true };
const event = {
    source: 'iphone',
    session: 'a',
    uid: 1,
    event: 'added',
    app: 'com.example',
    appName: 'Example',
    title: 'Bank',
    body: 'Your code is 123456',
    date: '20261025T120000',
};
const historyFile = path.join(temporary, 'notification-history.json');
const savedHistory = () => fs.readFileSync(historyFile, 'utf8');
// What the service stored for each record before this was fixed.
const textFingerprint = (item) =>
    crypto
        .createHash('sha256')
        .update(JSON.stringify([item.source, item.app, item.title || '', item.subtitle || '', item.body || '', item.date]))
        .digest('hex');

async function mounted(run, sources = [source]) {
    for (const name of ['notifications.json', 'notification-history.json']) fs.rmSync(path.join(temporary, name), { force: true });
    const service = new NotificationService();
    const app = express();
    service.mount(app, '/');
    service.store.sources = sources.map((item) => ({ ...item }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/notifications`;
    const api = (url, body) =>
        fetch(base + url, {
            method: body ? 'POST' : 'GET',
            headers: { 'content-type': 'application/json' },
            body: body && JSON.stringify(body),
        });
    const status = async () => (await api('/status')).json();
    try {
        await run({ service, api, status });
    } finally {
        service.release();
        await new Promise((resolve) => server.close(resolve));
    }
}
const report = (service) => service.handleCollector({ kind: 'devices', devices: [], pairingOpen: false });

test('a collector report does not clear a collector, storage or pairing error', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    await mounted(async ({ service, api, status }) => {
        service.command = () => undefined;
        assert.equal((await status()).error, '');

        service.handleCollector({ kind: 'error', message: 'Bluetooth advertising unavailable: busy' });
        const write = t.mock.method(service.storage, 'write', () => {
            throw Error('ENOSPC: no space left on device');
        });
        service.receive(event);
        await sleep(300);
        service.handleCollector({ kind: 'error', message: 'Pairing failed: org.bluez.Error.AuthenticationCanceled' });
        report(service);
        report(service);
        let current = await status();
        assert.equal(current.collectorError, 'Bluetooth advertising unavailable: busy');
        assert.equal(current.storageError, 'Notification history could not be saved');
        assert.equal(current.pairingError.message, 'Pairing failed: org.bluez.Error.AuthenticationCanceled');
        assert.ok(Date.now() - current.pairingError.at < 5000);
        assert.equal(
            current.error,
            'Notification history could not be saved. Bluetooth advertising unavailable: busy. ' +
                'Pairing failed: org.bluez.Error.AuthenticationCanceled',
        );

        // A save that fails inside a request is reported too, not only answered with an error.
        service.storageError = '';
        assert.equal((await api('/history/read', { all: true })).status, 400);
        assert.equal((await status()).storageError, 'Notification history could not be saved');

        // Each part clears on its own condition.
        service.collectorErrorAt = Date.now() - 30000;
        report(service);
        current = await status();
        assert.equal(current.collectorError, '');
        assert.equal(current.storageError, 'Notification history could not be saved');
        write.mock.restore();
        service.receive({ ...event, uid: 2, date: '20261025T120001' });
        await sleep(300);
        current = await status();
        assert.equal(current.storageError, '', 'the next history save that succeeds clears it');
        assert.equal(current.error, 'Pairing failed: org.bluez.Error.AuthenticationCanceled');
        assert.equal((await api('/pair', {})).status, 200);
        current = await status();
        assert.equal(current.pairingError, null);
        assert.equal(current.error, '');

        service.pairingError = { message: 'Pairing failed: old', at: Date.now() - 10 * 60000 };
        assert.equal((await status()).pairingError, null, 'a pairing error is shown for ten minutes');
    });
});

test('a collector error stays until the collector started after it has reported for 30 s', () => {
    const service = new NotificationService();
    service.handleCollector({ kind: 'error', message: 'Bluetooth collector stopped after an internal error (KeyError)' });
    // The next collector starts after a minute's restart delay and reports at once.
    service.collectorErrorAt = Date.now() - 60000;
    service.collectorStarted = Date.now() - 2000;
    report(service);
    assert.equal(service.collectorError, 'Bluetooth collector stopped after an internal error (KeyError)');
    service.collectorStarted = Date.now() - 30000;
    report(service);
    assert.equal(service.collectorError, '');
});

test('collector restarts back off to one minute and start over after a minute of uptime', () => {
    const service = new NotificationService();
    assert.deepEqual(
        Array.from({ length: 7 }, () => service.restartDelay(false, 1500)),
        [3000, 6000, 12000, 24000, 48000, 60000, 60000],
    );
    assert.equal(service.collectorRestarts, 7);
    assert.equal(service.restartDelay(true, 1500), 3000, 'a restart for changed phones is not a failure');
    assert.equal(service.collectorRestarts, 7);
    assert.equal(service.restartDelay(false, 60000), 3000);
    assert.equal(service.collectorRestarts, 1);
    // The count shown on the Setup page falls back once the running collector has stayed up.
    service.child = {};
    service.collectorStarted = Date.now() - 59000;
    assert.equal(service.restartCount(), 1);
    service.collectorStarted = Date.now() - 60000;
    assert.equal(service.restartCount(), 0);
    service.child = undefined;
});

// Stands in for /usr/bin/python3: the service runs `<interpreter> <collector.py>`.
function fakeInterpreter(body) {
    const file = path.join(temporary, `collector-${crypto.randomUUID()}`);
    fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
    return file;
}
async function withCollector(interpreter, run) {
    process.env.WS_BLUETOOTH_PYTHON = interpreter;
    process.env.WS_NOTIFICATIONS_COLLECTOR = '1';
    resetSettingsForTests();
    try {
        await mounted(async (context) => {
            context.service.closed = false;
            context.service.startCollector();
            await run(context);
        });
    } finally {
        delete process.env.WS_BLUETOOTH_PYTHON;
        process.env.WS_NOTIFICATIONS_COLLECTOR = '0';
        resetSettingsForTests();
    }
}
const until = async (condition, what) => {
    for (let waited = 0; waited < 10000; waited += 20) {
        if (condition()) return;
        await sleep(20);
    }
    assert.fail(`Timed out waiting for ${what}`);
};

test('a crashing collector is logged with a size cap, counted, and its error stays on the Setup page', async (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const crash = fakeInterpreter(`
        process.stdout.write(JSON.stringify({ kind: 'devices', devices: [], pairingOpen: false }) + '\\n');
        process.stderr.write('Traceback (most recent call last):\\n' + 'x'.repeat(40000) + '\\nKeyError: 7\\n', () => process.exit(1));
    `);
    await withCollector(crash, async ({ service, status }) => {
        await until(() => !service.child && service.restart, 'the collector to exit');
        const lines = logged.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('collector:'));
        assert.match(lines[0], /^\[NotificationService\] collector: Traceback \(most recent call last\):/);
        assert.equal(lines.filter((line) => line.endsWith('further output from this process is not logged')).length, 1);
        assert.ok(lines.join('').length < 16384 + 100 * lines.length, 'the log is capped');
        assert.equal(service.collectorRestarts, 1);
        report(service);
        const current = await status();
        assert.equal(current.collectorError, 'Bluetooth collector failed; check host BlueZ and D-Bus access');
        assert.equal(current.collectorRestarts, 1);
        assert.equal(current.error, current.collectorError);
        service.collectorRestarts = 4;
        assert.equal((await status()).error, `${current.collectorError}. The collector has been restarted 4 times`);
    });
});

test('the error a collector reports about itself is not replaced by its traceback', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const crash = fakeInterpreter(`
        const message = 'Bluetooth collector stopped after an internal error (KeyError)';
        process.stdout.write(JSON.stringify({ kind: 'error', message }) + '\\n', () =>
            setTimeout(() => process.stderr.write('Traceback (most recent call last):\\nKeyError: 7\\n', () => process.exit(0)), 100));
    `);
    await withCollector(crash, async ({ service, status }) => {
        await until(() => !service.child && service.restart, 'the collector to exit');
        assert.equal((await status()).collectorError, 'Bluetooth collector stopped after an internal error (KeyError)');
    });
});

test('a collector that exits without a message is reported, and a restart for changed phones is not', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const idle = fakeInterpreter(`process.stdin.on('data', () => undefined); setInterval(() => undefined, 1000);`);
    await withCollector(idle, async ({ service, status }) => {
        const first = service.child;
        service.restartCollector();
        await until(() => !service.child && service.restart, 'the collector to stop');
        assert.equal(service.collectorRestarts, 0);
        assert.equal((await status()).error, '');
        clearTimeout(service.restart);
        service.restart = undefined;
        service.startCollector();
        assert.notEqual(service.child, first);
        // An error this collector reported earlier and that has since been cleared.
        service.handleCollector({ kind: 'error', message: 'Invalid collector command' });
        service.collectorError = '';
        service.child.kill();
        await until(() => !service.child && service.restart, 'the collector to stop');
        assert.equal(service.collectorRestarts, 1);
        assert.equal((await status()).collectorError, 'Bluetooth collector stopped');
    });
});

test('an icon that loads may be cached by the browser for a day; a miss and the status may not', async () => {
    await mounted(async ({ service, api }) => {
        const png = Buffer.from('89504e470d0a1a0a', 'hex');
        service.icons.get = async (_source, app) => (app === 'com.example' ? png : null);
        const found = await api('/icons/iphone/com.example');
        assert.equal(found.status, 200);
        assert.equal(found.headers.get('content-type'), 'image/png');
        assert.equal(found.headers.get('cache-control'), 'private, max-age=86400');
        const missing = await api('/icons/iphone/com.other');
        assert.equal(missing.status, 404);
        assert.equal(missing.headers.get('cache-control'), 'no-store');
        assert.equal((await api('/status')).headers.get('cache-control'), 'no-store');
    });
});

const hidden = { ...source, preview: false };

test('with previews off the history holds nothing the text can be recovered from', async () => {
    await mounted(async ({ service, api }) => {
        service.save();
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        service.receive(event);
        assert.equal((await api('/history/read', { all: true, read: false })).status, 200);
        const saved = JSON.parse(savedHistory()).items;
        assert.equal(saved.length, 1);
        assert.equal(saved[0].body, '');
        assert.match(saved[0].fingerprint, /^l:[a-f0-9]{64}$/);
        assert.equal(savedHistory().includes(textFingerprint(event)), false, 'no hash of the text is stored');
        assert.ok([...service.replayCandidates.values()].every((hint) => hint.fingerprint === saved[0].fingerprint));

        // The same alert announced again after a reconnect is still one history item.
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'b' });
        service.receive({ ...event, session: 'b', uid: 9, preExisting: true });
        assert.equal(service.feed.size, 1);
        // Also after a server restart, when only the file is left.
        service.storage.flush();
        const restarted = new NotificationService();
        try {
            restarted.load();
            restarted.handleCollector({ kind: 'session', source: 'iphone', session: 'c' });
            restarted.receive({ ...event, session: 'c', uid: 4, preExisting: true });
            assert.equal(restarted.feed.size, 1);
            restarted.receive({ ...event, session: 'c', uid: 5, body: 'Your code is 654321!', preExisting: true });
            assert.equal(restarted.feed.size, 2, 'a different alert is not merged');
        } finally {
            restarted.release();
        }
    }, [hidden]);
});

test('turning previews off replaces stored fingerprints of the text', async () => {
    await mounted(async ({ service, api }) => {
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'a' });
        service.receive(event);
        assert.equal((await api('/history/read', { all: true, read: false })).status, 200);
        assert.ok(savedHistory().includes(textFingerprint(event)), 'with previews on the text is stored anyway');

        assert.equal((await api('/sources', hidden)).status, 200);
        assert.equal(savedHistory().includes(textFingerprint(event)), false);
        assert.equal(savedHistory().includes('123456'), false);
        assert.ok([...service.replayCandidates.values()].every((hint) => hint.fingerprint.startsWith('l:')));
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'b' });
        service.receive({ ...event, session: 'b', uid: 9, preExisting: true });
        assert.equal(service.feed.size, 1, 'the alert is still recognised after a reconnect');

        // Previews on again: a record stored without text still matches its alert.
        assert.equal((await api('/sources', source)).status, 200);
        service.handleCollector({ kind: 'session', source: 'iphone', session: 'c' });
        service.receive({ ...event, session: 'c', uid: 3, preExisting: true });
        assert.equal(service.feed.size, 1);
        assert.equal([...service.feed.values()][0].body, event.body);
    });
});

test('a text fingerprint saved by an earlier version is removed when previews are off', async () => {
    await mounted(async ({ service }) => {
        service.store.sources = [hidden, { ...source, id: 'shown', address: 'AA:BB:CC:DD:EE:00' }];
        service.save();
        const record = (item, text) => ({
            ...event,
            ...text,
            source: item,
            key: `key-${item}`,
            received: Date.now(),
            read: false,
            dismissed: false,
            active: false,
            reconnectable: true,
            fingerprint: textFingerprint({ ...event, source: item }),
        });
        const items = [record('iphone', { title: '', body: '' }), record('shown', {})];
        fs.writeFileSync(historyFile, JSON.stringify({ version: 1, items }));
        const restarted = new NotificationService();
        try {
            restarted.load();
            assert.equal(restarted.feed.get('key-iphone').fingerprint, undefined);
            assert.equal(restarted.feed.get('key-shown').fingerprint, items[1].fingerprint);
            assert.deepEqual([...restarted.replayCandidates.values()].map((hint) => hint.historyKey), ['key-shown']);
            await sleep(300);
            const saved = JSON.parse(savedHistory()).items;
            assert.deepEqual(saved.map((item) => item.fingerprint), [undefined, items[1].fingerprint]);
        } finally {
            restarted.release();
        }
    });
});

// The feed on its own: no file, no timer and no push. The clock and the keys are the test's.
function feedFixture() {
    let now = Date.parse('2026-11-12T12:00:00Z');
    let next = 0;
    const feed = new NotificationFeed(() => now, () => `key-${++next}`);
    return { feed, advance: (ms) => (now += ms) };
}

test('the feed keeps a new alert once, offers it for a push once, and knows it again after a reconnect', () => {
    const { feed } = feedFixture();
    assert.deepEqual(feed.receive(event, source, 'a'), { changed: true, push: 'key-1' });
    assert.equal(feed.items.get('key-1').active, true);
    // The same alert of the same session again: kept as it is, not offered again.
    assert.deepEqual(feed.receive({ ...event, title: 'Bank (2)' }, source, 'a'), { changed: true });
    assert.equal(feed.items.size, 1);
    assert.equal(feed.items.get('key-1').title, 'Bank (2)');
    assert.deepEqual(feed.receive({ ...event, event: 'modified', title: 'Bank (2)', body: 'Edited' }, source, 'a'), { changed: true });
    assert.equal(feed.items.get('key-1').body, 'Edited');
    // An event of another session than the one the service holds is left out.
    assert.deepEqual(feed.receive({ ...event, session: 'old', uid: 7 }, source, 'a'), { changed: false });
    assert.equal(feed.items.size, 1);
    // A new session: the iPhone announces its alerts again under new numbers. The read state of
    // the stored one is kept and nothing is offered for a push.
    feed.items.get('key-1').read = true;
    feed.deactivate('iphone');
    feed.rememberReplays('iphone');
    assert.equal(feed.items.get('key-1').active, false);
    assert.deepEqual(feed.receive({ ...event, session: 'b', uid: 42, title: 'Bank (2)', body: 'Edited' }, source, 'b'), { changed: true });
    assert.equal(feed.items.size, 1);
    const kept = feed.items.get('key-1');
    assert.deepEqual([kept.session, kept.uid, kept.read, kept.active], ['b', 42, true, true]);
    // An alert that was there before the session started is kept and not pushed.
    assert.deepEqual(feed.receive({ ...event, session: 'b', uid: 43, date: '20261025T130000', preExisting: true }, source, 'b'), { changed: true });
    assert.equal(feed.items.size, 2);
    // Removed on the iPhone: kept here, no longer live, never matched again.
    assert.deepEqual(feed.receive({ ...event, session: 'b', uid: 42, event: 'removed' }, source, 'b'), { changed: true });
    assert.deepEqual([kept.active, kept.reconnectable], [false, false]);
    assert.deepEqual(feed.receive({ ...event, session: 'b', uid: 99, event: 'removed' }, source, 'b'), { changed: false }, 'an unknown removal changes nothing');
    // The link state: live only while receiving, and only for the alerts of the session.
    feed.setActive('iphone', 'b', true);
    assert.deepEqual([...feed.items.values()].map((item) => item.active), [false, true]);
    feed.setActive('iphone', 'b', false);
    assert.deepEqual([...feed.items.values()].map((item) => item.active), [false, false]);
});

test('the feed takes the saved history, drops a text hash of a phone with previews off, and rebuilds its hints', () => {
    const { feed } = feedFixture();
    const record = (id, fingerprint) => ({ ...event, source: id, key: `saved-${id}`, received: Date.now(), read: false, dismissed: false, active: false, reconnectable: true, fingerprint });
    const shown = { ...source, id: 'shown', address: 'AA:BB:CC:DD:EE:00' };
    assert.equal(feed.load([record('iphone', 'a'.repeat(64)), record('shown', 'b'.repeat(64))], [hidden, shown]), true);
    assert.equal(feed.items.get('saved-iphone').fingerprint, undefined);
    assert.deepEqual([...feed.replayCandidates.values()].map((hint) => hint.historyKey), ['saved-shown']);
    assert.equal(new NotificationFeed().load([record('shown', `l:${'c'.repeat(64)}`)], [shown]), false, 'nothing to change');
});

test('the feed drops history after 30 days or past 500 per iPhone, and hints after an hour or past 2000', () => {
    const { feed, advance } = feedFixture();
    for (let uid = 0; uid < 502; uid++) {
        feed.receive({ ...event, uid, date: `d${uid}` }, source, 'a');
        advance(1);
    }
    assert.equal(feed.items.size, 500, 'the oldest go first');
    assert.deepEqual([feed.items.has('key-2'), feed.items.has('key-3')], [false, true]);
    assert.equal(feed.prune(), false, 'nothing more to drop');
    advance(3600001);
    assert.equal(feed.prune(), false, 'hints are not history');
    assert.deepEqual([feed.observed.size, feed.replayCandidates.size], [0, 0]);
    advance(30 * 86400000);
    assert.equal(feed.prune(), true);
    assert.equal(feed.items.size, 0);
    for (let uid = 0; uid < 2100; uid++) feed.receive({ ...event, uid, date: `e${uid}`, preExisting: true }, source, 'a');
    assert.deepEqual([feed.observed.size, feed.replayCandidates.size], [2000, 2000]);
});

test('the feed counts unread notifications that are not archived, for each iPhone', () => {
    const { feed } = feedFixture();
    const other = { ...source, id: 'other', address: 'AA:BB:CC:DD:EE:01' };
    for (let uid = 1; uid <= 3; uid++) feed.receive({ ...event, uid, date: `d${uid}` }, source, 'a');
    feed.receive({ ...event, source: 'other', session: 'x', uid: 1 }, other, 'x');
    feed.items.get('key-1').read = true;
    feed.items.get('key-2').dismissed = true;
    assert.deepEqual(feed.counts([source, other, { ...source, id: 'empty' }]), { unread: 2, unreadBySource: { iphone: 1, other: 1, empty: 0 } });
    assert.deepEqual(feed.storedBySource([source, other]), { iphone: 3, other: 1 });
    assert.deepEqual(feed.history('iphone').map((item) => item.key).sort(), ['key-1', 'key-2', 'key-3']);
    assert.equal('fingerprint' in feed.history()[0], false, 'the page is not sent the fingerprint');
    feed.removeSource('iphone');
    assert.deepEqual(feed.history().map((item) => item.key), ['key-4']);
});

test('shouldRelay is the one app filter: what it refuses is neither kept nor pushed', () => {
    const { feed } = feedFixture();
    const sub = { id: 'sub', sources: ['iphone'], receiverSource: '' };
    for (const app of ['com.apple.WebKit.WebPush.1', 'com.apple.WebKit.PushBundle.2', '']) {
        assert.equal(shouldRelay({ ...event, app }, source), false, app);
        assert.deepEqual(feed.receive({ ...event, app }, source, 'a'), { changed: false });
    }
    assert.equal(feed.items.size, 0);
    assert.equal(shouldRelay(event, source), true);
    assert.equal(shouldRelay(event, source, sub), true);
    assert.equal(shouldRelay({ ...event, preExisting: true }, source), true, 'kept');
    assert.equal(shouldRelay({ ...event, preExisting: true }, source, sub), false, 'and not pushed');
});

// The mute list. A subscription that takes this iPhone's alerts, and the pushes it is queued.
const subscriber = { id: 'sub', subscription: { endpoint: 'https://web.push.apple.com/mute', keys: {} }, sources: ['iphone'], receiverSource: '', updated: 0 };
const queued = (t, service) => {
    const enqueue = t.mock.method(service.push, 'enqueue', () => undefined);
    return () => enqueue.mock.calls.map((call) => call.arguments[0]);
};
const kept = (service) => [...service.feed.values()].map((item) => item.app).sort();
const settings = () => JSON.parse(fs.readFileSync(path.join(temporary, 'notifications.json'), 'utf8'));

test('an existing allow-list keeps filtering exactly as before', async (t) => {
    await mounted(async ({ service, api }) => {
        service.store.subscriptions = [subscriber];
        const pushes = queued(t, service);
        service.receive({ ...event, app: 'com.allowed' });
        service.receive({ ...event, uid: 2, app: 'com.other' });
        assert.deepEqual(kept(service), ['com.allowed'], 'an app the list does not name is not kept');
        assert.deepEqual(pushes(), ['sub'], 'and not pushed');
        const item = [...service.feed.values()][0];
        assert.equal(shouldRelay({ ...event, app: 'com.other' }, service.store.sources[0], subscriber), false);
        assert.equal(service.preparePush('sub', item.key).payload.includes('Bank'), true);
        // The list arrives in the status as it was saved, and no mute list is added to the record.
        const [record] = (await (await api('/status')).json()).sources;
        assert.deepEqual(record.apps, ['com.allowed']);
        assert.equal('muted' in record, false);
    }, [{ ...source, apps: ['com.allowed'] }]);
});

test('a muted app is not relayed and not pushed, also on top of an allow-list', async (t) => {
    await mounted(async ({ service, api }) => {
        service.store.subscriptions = [subscriber];
        const pushes = queued(t, service);
        service.receive({ ...event, uid: 1, app: 'com.noisy', date: 'd1' });
        const before = [...service.feed.values()][0];
        const mute = await api('/sources', { ...source, muted: [{ app: 'com.noisy', name: 'Noisy' }] });
        assert.equal(mute.status, 200);
        assert.equal(pushes().length, 1);
        assert.equal(service.preparePush('sub', before.key), undefined, 'a push still queued for it is not sent');
        service.receive({ ...event, uid: 2, app: 'com.noisy', date: 'd2' });
        service.receive({ ...event, uid: 3, app: 'com.example', date: 'd3' });
        assert.deepEqual(kept(service), ['com.example', 'com.noisy'], 'only the alert from before the mute is kept');
        assert.equal(pushes().length, 2, 'the other app is still pushed');
        assert.equal((await (await api('/status')).json()).unread, 2);
        // With an allow-list that names it, a muted app is still muted.
        assert.equal((await api('/sources', { ...source, apps: ['com.noisy', 'com.example'] })).status, 200);
        service.receive({ ...event, uid: 4, app: 'com.noisy', date: 'd4' });
        assert.equal(service.feed.size, 2);
        assert.equal(shouldRelay({ ...event, app: 'com.noisy' }, service.store.sources[0]), false);
    });
});

test('muting and unmuting are saved, and a server started later reads them', async () => {
    await mounted(async ({ api, status }) => {
        const muted = [{ app: 'com.noisy', name: 'Noisy' }, { app: 'com.games', name: 'Games' }];
        assert.equal((await api('/sources', { ...source, muted: [...muted, { ...muted[0], name: 'Again' }] })).status, 200);
        assert.deepEqual(settings().sources[0].muted, [{ app: 'com.noisy', name: 'Again' }, muted[1]], 'one entry per app');
        assert.deepEqual((await status()).sources[0].muted, settings().sources[0].muted);
        const restarted = new NotificationService();
        try {
            restarted.load();
            assert.deepEqual(restarted.store.sources[0].muted, settings().sources[0].muted);
        } finally {
            restarted.release();
        }
        assert.equal((await api('/sources', { ...source, muted: [muted[1]] })).status, 200);
        assert.deepEqual(settings().sources[0].muted, [muted[1]]);
        assert.equal((await api('/sources', { ...source, muted: [] })).status, 200);
        assert.deepEqual(settings().sources[0].muted, []);
        // A list the page could not have sent is refused, and nothing changes.
        for (const bad of [{}, [{ app: '' , name: 'x' }], [{ app: 'a'.repeat(513), name: '' }], [{ app: 'com.x' }], Array.from({ length: 201 }, (_, i) => ({ app: `a${i}`, name: '' }))]) {
            assert.equal((await api('/sources', { ...source, muted: bad })).status, 400, JSON.stringify(bad).slice(0, 60));
        }
        assert.deepEqual(settings().sources[0].muted, []);
    });
});

test('a changed iPhone keeps its place in the list, so the inbox shown first stays the same', async () => {
    const other = { ...source, id: 'other', address: 'AA:BB:CC:DD:EE:01', name: 'Other' };
    await mounted(async ({ api, status }) => {
        const order = async () => (await status()).sources.map((item) => item.id);
        assert.equal((await api('/sources', { ...source, muted: [{ app: 'com.noisy', name: 'Noisy' }] })).status, 200);
        assert.deepEqual(await order(), ['iphone', 'other'], 'muting an app does not move the iPhone to the end');
        assert.equal((await api('/sources', { ...source, preview: false })).status, 200);
        assert.deepEqual(await order(), ['iphone', 'other']);
        assert.deepEqual(settings().sources.map((item) => item.id), ['iphone', 'other']);
        // A new iPhone is added after the others.
        const third = { ...source, id: 'third', address: 'AA:BB:CC:DD:EE:02', name: 'Third' };
        assert.equal((await api('/sources', third)).status, 200);
        assert.deepEqual(await order(), ['iphone', 'other', 'third']);
    }, [source, other]);
});

test('a request in the old shape is still accepted and means what it meant', async () => {
    await mounted(async ({ service, api }) => {
        assert.equal((await api('/sources', { ...source, muted: [{ app: 'com.noisy', name: 'Noisy' }] })).status, 200);
        // A page left open since before the mute list sends the fields it knew: `apps` is the
        // allow-list, as it was, and the mute list is left as it is.
        const { id, address, name, preview } = source;
        assert.equal((await api('/sources', { id, address, name, apps: ['com.example', 'com.noisy'], preview })).status, 200);
        assert.deepEqual(settings().sources[0], { id, address, name, apps: ['com.example', 'com.noisy'], preview, muted: [{ app: 'com.noisy', name: 'Noisy' }] });
        service.receive({ ...event, uid: 1, app: 'com.example', date: 'd1' });
        service.receive({ ...event, uid: 2, app: 'com.other', date: 'd2' });
        service.receive({ ...event, uid: 3, app: 'com.noisy', date: 'd3' });
        assert.deepEqual(kept(service), ['com.example']);
        // Its Save app filter with an empty field clears the list.
        assert.equal((await api('/sources', { id, address, name, apps: [], preview })).status, 200);
        service.receive({ ...event, uid: 4, app: 'com.other', date: 'd4' });
        assert.deepEqual(kept(service), ['com.example', 'com.other']);
        assert.deepEqual(settings().sources[0].muted, [{ app: 'com.noisy', name: 'Noisy' }]);
        // An iPhone linked from such a page is stored as it always was.
        const other = { id: 'other', address: 'AA:BB:CC:DD:EE:01', name: 'Other', apps: [], preview: true };
        assert.equal((await api('/sources', other)).status, 200);
        assert.deepEqual(settings().sources.find((item) => item.id === 'other'), other);
    });
});

test('settings saved before the mute list existed are read as they are and keep working', () => {
    const old = { id: 'iphone', address: 'AA:BB:CC:DD:EE:FF', name: 'iPhone', apps: ['com.example'], preview: false, extra: 'kept' };
    const file = path.join(temporary, 'notifications.json');
    fs.rmSync(path.join(temporary, 'notification-history.json'), { force: true });
    fs.writeFileSync(file, JSON.stringify({ vapid: { publicKey: 'public', privateKey: 'private' }, sources: [old], subscriptions: [subscriber] }));
    const service = new NotificationService();
    try {
        service.load();
        assert.equal(service.disabled, '');
        assert.deepEqual(service.store.sources, [old]);
        assert.deepEqual(service.store.subscriptions, [subscriber]);
        assert.deepEqual(service.store.vapid, { publicKey: 'public', privateKey: 'private' });
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sources, [old], 'reading writes nothing back');
        service.receive({ ...event, app: 'com.example', preExisting: true });
        assert.equal(service.feed.size, 1, 'the allow-list it held still applies');
    } finally {
        service.release();
    }
});
