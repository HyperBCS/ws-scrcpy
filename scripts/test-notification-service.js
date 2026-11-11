// Collector supervision, Setup page errors and stored previews in NotificationService.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
require('ts-node').register({ transpileOnly: true });

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-notification-service-'));
process.env.WS_NOTIFICATION_DATA = temporary;
process.env.WS_NOTIFICATIONS_COLLECTOR = '0';
const { NotificationService } = require('../src/server/notifications/NotificationService');
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
    try {
        await mounted(async (context) => {
            context.service.closed = false;
            context.service.startCollector();
            await run(context);
        });
    } finally {
        delete process.env.WS_BLUETOOTH_PYTHON;
        process.env.WS_NOTIFICATIONS_COLLECTOR = '0';
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
        service.child.kill();
        await until(() => !service.child && service.restart, 'the collector to stop');
        assert.equal(service.collectorRestarts, 1);
        assert.equal((await status()).collectorError, 'Bluetooth collector stopped');
    });
});
