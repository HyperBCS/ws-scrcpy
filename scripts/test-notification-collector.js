// Collector supervision uses fake child streams and a clock. No tool or socket is started.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-notification-collector-'));
process.env.WS_DATA_DIR = temporary;
process.env.WS_NOTIFICATION_DATA = temporary;
process.env.WS_NOTIFICATIONS_COLLECTOR = '1';
delete process.env.WS_IOS_SETTINGS_KEY;
delete process.env.WS_IOS_SETTINGS_KEY_FILE;
require('ts-node').register({ transpileOnly: true });
const { CollectorProcess } = require('../src/server/notifications/CollectorProcess');
const { resetSettingsForTests } = require('../src/server/Settings');
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function boundedWrite(promise) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Collector write stayed pending')), 500);
        promise.then((value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); });
    });
}

function child() {
    const value = new EventEmitter();
    value.stdout = new EventEmitter();
    value.stderr = new EventEmitter();
    value.stdout.setEncoding = value.stderr.setEncoding = () => undefined;
    value.stdin = new EventEmitter();
    value.stdin.writable = true;
    value.written = [];
    value.callbacks = [];
    value.stdin.write = (text, callback) => {
        value.written.push(text);
        if (value.holdWrites) value.callbacks.push(callback);
        else callback();
        return true;
    };
    value.signals = [];
    value.kill = (signal) => { value.signals.push(signal); return true; };
    return value;
}

function fixture(t, options = {}) {
    let now = 100000;
    const timers = [];
    const children = [];
    const spawnCalls = [];
    const messages = [], faults = [], stopped = [], starts = [], stderr = [];
    const commands = options.commands || [{ type: 'configure', sources: [] }, { type: 'pair', seconds: 73 }];
    const collector = new CollectorProcess({
        commands: () => commands,
        started: (at) => starts.push(at),
        message: (message) => { if (options.message) options.message(message); messages.push(message); },
        fault: (message) => faults.push(message),
        stderr: (at) => stderr.push(at),
        stopped: (...args) => stopped.push(args),
    }, {
        spawn: (...args) => { const value = child(); children.push(value); spawnCalls.push(args); return value; },
        script: () => '/fixture/collector.py',
        now: () => now,
        setTimeout: (callback, delay) => { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; },
        clearTimeout: (timer) => { timer.cancelled = true; },
    });
    t.after(() => collector.release());
    return { collector, timers, children, spawnCalls, commands, messages, faults, stopped, starts, stderr,
        advance: (ms) => { now += ms; }, retry: () => timers.at(-1).callback() };
}

test('collector starts once with unchanged commands, settings interpreter and filtered child environment', (t) => {
    const f = fixture(t);
    // Only a synthetic value is ever added. No inherited key is retained by this fixture.
    process.env.WS_IOS_SETTINGS_KEY = 'fixture-key-must-not-reach-child';
    process.env.WS_BLUETOOTH_PYTHON = '/fixture/python';
    resetSettingsForTests();
    try {
        f.collector.start(); f.collector.start();
        assert.equal(f.children.length, 1);
        assert.equal(f.spawnCalls[0][0], '/fixture/python');
        assert.deepEqual(f.spawnCalls[0][1], ['/fixture/collector.py']);
        assert.equal(f.spawnCalls[0][2].env.WS_IOS_SETTINGS_KEY, undefined);
        assert.equal(f.spawnCalls[0][2].env.WS_DATA_DIR, temporary);
        assert.deepEqual(f.children[0].written.map((line) => JSON.parse(line)), f.commands);
        assert.ok(f.children[0].written.every((line) => line.endsWith('\n')));
    } finally {
        delete process.env.WS_IOS_SETTINGS_KEY;
        delete process.env.WS_BLUETOOTH_PYTHON;
        resetSettingsForTests();
    }
});

test('collector frames split and multiple lines and recovers after malformed events', (t) => {
    const f = fixture(t, { message: (message) => { if (message === null) throw Error('invalid'); } });
    f.collector.start();
    const out = f.children[0].stdout;
    out.emit('data', '{"kind":"sta');
    assert.equal(f.messages.length, 0);
    out.emit('data', 'tus"}\nnot json\nnull\n{"kind":"devices"}\n{"kind":');
    assert.deepEqual(f.messages, [{ kind: 'status' }, { kind: 'devices' }]);
    assert.deepEqual(f.faults, ['Invalid Bluetooth collector event', 'Invalid Bluetooth collector event']);
    out.emit('data', '"pairing"}\n');
    assert.equal(f.messages[2].kind, 'pairing');
});

test('collector bounds buffered stdout at 131072 characters and terminates with SIGTERM', (t) => {
    const f = fixture(t);
    f.collector.start();
    f.children[0].stdout.emit('data', ' '.repeat(131072));
    assert.deepEqual(f.children[0].signals, []);
    f.children[0].stdout.emit('data', 'x');
    assert.deepEqual(f.children[0].signals, ['SIGTERM']);
    f.children[0].emit('close');
    assert.deepEqual(f.stopped, [[false, 100000]]);
    assert.equal(f.timers[0].delay, 3000);
});

test('collector caps stderr at 16384 characters and records one failure for error plus close', (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const f = fixture(t);
    f.collector.start();
    const first = f.children[0];
    first.stderr.emit('data', 'x'.repeat(20000));
    first.stderr.emit('data', 'more');
    assert.equal(logged.mock.calls.length, 2);
    assert.equal(logged.mock.calls[0].arguments[0].length, '[NotificationService] collector: '.length + 16384);
    first.emit('error', Error('fixture spawn failure'));
    first.emit('close'); first.emit('close');
    assert.deepEqual(f.faults, ['Could not start Bluetooth collector']);
    assert.equal(f.collector.restartCount(), 1);
    assert.equal(f.stopped.length, 1);
    assert.equal(f.timers.length, 1);
});

test('collector retry delays retain 3s exponential backoff, cap and stable reset', (t) => {
    const f = fixture(t);
    for (let index = 0; index < 7; index++) {
        f.collector.start(); f.advance(1000); f.children.at(-1).emit('close');
    }
    assert.deepEqual(f.timers.map((timer) => timer.delay), [3000, 6000, 12000, 24000, 48000, 60000, 60000]);
    assert.equal(f.collector.restartCount(), 7);
    f.retry(); f.advance(59000);
    assert.equal(f.collector.restartCount(), 7);
    f.advance(1000);
    assert.equal(f.collector.restartCount(), 0);
    f.children.at(-1).emit('close');
    assert.equal(f.timers.at(-1).delay, 3000);
    assert.equal(f.collector.restartCount(), 1);
});

test('deliberate collector restart keeps the failure count and starts after 3s', (t) => {
    const f = fixture(t);
    f.collector.start(); f.children[0].emit('close'); f.retry();
    f.collector.restartCollector();
    assert.deepEqual(f.children[1].signals, ['SIGTERM']);
    f.children[1].emit('close');
    assert.deepEqual(f.stopped.at(-1), [true, 100000]);
    assert.equal(f.collector.restartCount(), 1);
    assert.equal(f.timers.at(-1).delay, 3000);
});

test('late events from a replaced collector cannot change its successor or schedule another retry', (t) => {
    t.mock.method(console, 'error', () => undefined);
    const f = fixture(t);
    f.collector.start();
    const old = f.children[0];
    old.emit('close'); f.retry();
    const successor = f.children[1];
    successor.stdout.emit('data', '{"kind":"pairing"}\n');
    const before = { faults: f.faults.length, stderr: f.stderr.length, stopped: f.stopped.length, timers: f.timers.length };
    old.stdout.emit('data', '{"kind":"session"}\n');
    old.stderr.emit('data', 'old traceback');
    old.stdin.emit('error', Error('old pipe'));
    old.emit('error', Error('late error')); old.emit('close');
    assert.equal(f.collector.child, successor);
    assert.deepEqual(f.messages, [{ kind: 'pairing' }]);
    assert.deepEqual({ faults: f.faults.length, stderr: f.stderr.length, stopped: f.stopped.length, timers: f.timers.length }, before);
    assert.equal(f.collector.restartCount(), 1);
});

test('a cleared retry callback cannot start a collector ahead of its successor delay', (t) => {
    const f = fixture(t);
    f.collector.start(); f.children[0].emit('close');
    const oldRetry = f.timers[0];
    oldRetry.callback();
    f.children[1].emit('close');
    const nextRetry = f.timers[1];
    assert.equal(nextRetry.delay, 6000);
    oldRetry.callback();
    assert.equal(f.children.length, 2);
    nextRetry.callback();
    assert.equal(f.children.length, 3);
});

test('release cancels pending restart and rejects late callbacks without resurrecting a collector', (t) => {
    const f = fixture(t);
    f.collector.start(); f.children[0].emit('close');
    const timer = f.timers[0];
    f.collector.release();
    assert.equal(timer.cancelled, true);
    timer.callback(); f.collector.start();
    f.children[0].emit('close');
    assert.equal(f.children.length, 1);
    assert.equal(f.stopped.length, 1);
    assert.equal(f.timers.length, 1);
});

test('collector writes reject closed stdin, thrown and callback errors without resubmitting', async (t) => {
    const f = fixture(t, { commands: [] });
    await assert.rejects(f.collector.command({ type: 'pair' }), /starting/);
    f.collector.start();
    const current = f.children[0];
    current.stdin.writable = false;
    await assert.rejects(f.collector.command({ type: 'pair' }), /starting/);
    current.stdin.writable = true;
    current.stdin.write = () => { throw Error('synthetic EPIPE'); };
    await assert.rejects(f.collector.command({ type: 'pair' }), /could not accept/);
    current.stdin.write = (_line, callback) => callback(Error('synthetic EPIPE'));
    await assert.rejects(f.collector.command({ type: 'pair' }), /could not accept/);
    assert.equal(f.children.length, 1);
    assert.equal(f.timers.length, 0);
});

test('stdin errors reject pending writes, and late old write callbacks cannot complete successor writes', async (t) => {
    const f = fixture(t, { commands: [] });
    f.collector.start();
    const old = f.children[0]; old.holdWrites = true;
    const failed = assert.rejects(boundedWrite(f.collector.command({ type: 'dismiss' })), /could not accept/);
    old.stdin.emit('error', Error('synthetic EPIPE'));
    await failed;
    const released = assert.rejects(f.collector.command({ type: 'pair' }), /starting/);
    old.emit('close'); await released; f.retry();
    const successor = f.children[1]; successor.holdWrites = true;
    let completed = false;
    const pending = f.collector.command({ type: 'confirm' }).then(() => { completed = true; });
    for (const callback of old.callbacks) callback();
    await tick(); assert.equal(completed, false);
    successor.callbacks[0](); await pending;
    assert.equal(completed, true);
    const stopped = assert.rejects(f.collector.command({ type: 'pair' }), /starting/);
    f.collector.release(); await stopped;
    assert.deepEqual(successor.signals, ['SIGTERM']);
});

test('a startup write failure is reported once and waits for close before normal failure backoff', async (t) => {
    const f = fixture(t);
    f.collector.runtime.spawn = (...args) => {
        const value = child();
        value.stdin.write = (_line, callback) => callback(Error('synthetic EPIPE'));
        f.children.push(value); f.spawnCalls.push(args); return value;
    };
    f.collector.start(); await tick();
    assert.deepEqual(f.children[0].signals, []);
    assert.equal(f.timers.length, 0);
    assert.deepEqual(f.faults, ['Bluetooth collector could not accept the command']);
    f.children[0].emit('close');
    assert.equal(f.timers[0].delay, 3000);
    assert.equal(f.collector.restartCount(), 1);
});

// The old service ignored an idle stdin error. Keep that policy while rejecting pending writes.
test('stdin error after completed writes does not add a collector fault or restart', async (t) => {
    const f = fixture(t);
    f.collector.start();
    await f.collector.command({ type: 'pair' });
    f.children[0].stdin.emit('error', Error('synthetic idle pipe error'));
    assert.deepEqual(f.faults, []);
    assert.deepEqual(f.children[0].signals, []);
    assert.equal(f.timers.length, 0);
    assert.equal(f.collector.restartCount(), 0);
    await f.collector.command({ type: 'confirm' });
});
