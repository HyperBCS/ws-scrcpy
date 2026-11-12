// Direct Android shell, poller and session races. Every transport is a fixture.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const net = require('node:net');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-android-owners-'));
const envNames = ['WS_DATA_DIR', 'WS_NOTIFICATION_DATA', 'WS_SCRCPY_STREAM_CONFIG_PATH', 'ADB_HOST', 'ADB_PORT'];
const previous = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
process.env.WS_DATA_DIR = process.env.WS_NOTIFICATION_DATA = temporary;
process.env.WS_SCRCPY_STREAM_CONFIG_PATH = path.join(temporary, 'stream-config.json');
require('ts-node').register({ transpileOnly: true });
require.extensions['.jar'] = () => {};
require.cache[require.resolve('../vendor/Genymobile/scrcpy/LICENSE')] = { exports: {} };
const { resetSettingsForTests } = require('../src/server/Settings');
const { AdbExtended } = require('../src/server/goog-device/adb');
const { AdbShell } = require('../src/server/goog-device/AdbShell');
const { AdbUtils } = require('../src/server/goog-device/AdbUtils');
const { DeviceStatePoller } = require('../src/server/goog-device/DeviceStatePoller');
const { ScrcpySession } = require('../src/server/goog-device/ScrcpySession');
const { ScrcpyServer } = require('../src/server/goog-device/ScrcpyServer');
const { Device } = require('../src/server/goog-device/Device');
const { broadcastManager } = require('../src/common/BroadcastManager');
const originalClient = AdbExtended.createClient.bind(AdbExtended);
AdbExtended.createClient = () => { throw Error('A fixture must supply its adb transport'); };
after(() => {
    for (const key of envNames) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
    }
    resetSettingsForTests();
    fs.rmSync(temporary, { recursive: true, force: true });
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const flush = async () => { for (let turn = 0; turn < 5; turn++) await tick(); };
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}
function rawShell() {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = () => { socket.destroyed = true; };
    return socket;
}
function shellAnswer(output) {
    const socket = new PassThrough();
    queueMicrotask(() => socket.end(output));
    return socket;
}

test('shared shell reader preserves Files exit codes, markers, size and unbounded diagnostic defaults', async (t) => {
    const commands = [];
    let output = 'refused\n__rc=17\n';
    t.mock.method(AdbExtended, 'createClient', () => ({ shell: async (_serial, command) => {
        commands.push(command);
        return shellAnswer(output);
    } }));
    assert.deepEqual(await AdbUtils.shellExec('phone', 'fixture'), { code: 17, output: 'refused' });
    assert.equal(commands[0], 'fixture 2>&1; echo "__rc=$?"');
    output = 'partial';
    assert.deepEqual(await AdbUtils.shellExec('phone', 'fixture'), { code: -1, output: 'partial' });
    output = 'x'.repeat(2 * 1024 * 1024) + '\n__rc=0';
    assert.equal((await AdbUtils.shellExec('phone', 'fixture')).output.length, 2 * 1024 * 1024);
    await assert.rejects(AdbUtils.shellExec('phone', 'x'.repeat(65001)), /too long/);
    const shell = new AdbShell('phone');
    const pending = deferred();
    shell.client.shell = () => pending.promise;
    const reading = shell.read('no default timeout');
    const socket = shellAnswer('eventual result');
    pending.resolve(socket);
    assert.equal(await reading, 'eventual result');
    shell.release();
});

test('shell errors before connection and during reading retain their cause', async () => {
    const before = new AdbShell('phone', { shell: async () => { throw Error('transport refused'); } });
    await assert.rejects(before.read('diagnostic'), /transport refused/);
    const socket = new PassThrough();
    const afterConnect = new AdbShell('phone', { shell: async () => socket });
    const reading = afterConnect.read('diagnostic');
    const rejected = assert.rejects(reading, /USB read failed/);
    await flush();
    socket.destroy(Error('USB read failed'));
    await rejected;
    before.release(); afterConnect.release();
});

test('shell timeout destroys connections arriving late and streams already being read', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = deferred();
    const shell = new AdbShell('phone', { shell: () => pending.promise });
    const reading = assert.rejects(shell.read('late', 20), /timed out/);
    await flush();
    t.mock.timers.tick(20);
    await reading;
    const late = new PassThrough();
    pending.resolve(late);
    await flush();
    assert.equal(late.destroyed, true);
    const open = new PassThrough();
    shell.client.shell = async () => open;
    const timed = assert.rejects(shell.exec('open', 20), /did not answer in time/);
    await flush();
    t.mock.timers.tick(20);
    await timed;
    assert.equal(open.destroyed, true);
    const active = new PassThrough();
    shell.client.shell = async () => active;
    const cancelled = assert.rejects(shell.read('released'), /phone connection ended/);
    await flush(); shell.release(); await cancelled;
    assert.equal(active.destroyed, true);
});

test('Android shells use the configured adbkit host and port and spawn no CLI', async (t) => {
    process.env.ADB_HOST = 'adb.fixture.invalid';
    process.env.ADB_PORT = '15037';
    resetSettingsForTests();
    t.after(() => {
        for (const key of ['ADB_HOST', 'ADB_PORT']) {
            if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
        }
        resetSettingsForTests();
    });
    const client = originalClient();
    assert.equal(client.options.host, 'adb.fixture.invalid');
    assert.equal(client.options.port, 15037);
    assert.equal(client.options.bin, '/nonexistent/ws-scrcpy-never-starts-adb');
    const seen = [];
    client.shell = async (serial, command) => { seen.push({ serial, command }); return shellAnswer('fixture'); };
    t.mock.method(AdbExtended, 'createClient', () => client);
    t.mock.method(cp, 'spawn', () => assert.fail('No Android CLI child'));
    t.mock.method(cp, 'execFile', () => assert.fail('No adb daemon child'));
    const shell = new AdbShell('remote-phone');
    assert.equal(await shell.read('fixture'), 'fixture');
    const stream = await shell.open('scrcpy fixture');
    stream.destroy();
    assert.deepEqual(seen, [{ serial: 'remote-phone', command: 'fixture' }, { serial: 'remote-phone', command: 'scrcpy fixture' }]);
    shell.release();
});

function pollerFixture(t, read = () => '') {
    const state = { pid: 0 };
    const patches = [];
    const calls = [];
    const signals = [];
    const source = {
        TAG: '[poll-fixture]',
        read: async (command, timeout, signal) => {
            calls.push(command); signals.push(signal);
            return read(command, timeout, signal);
        },
        servicePids: async () => [],
        patch: (values) => { Object.assign(state, values); patches.push(values); },
    };
    const poller = new DeviceStatePoller(source);
    t.after(() => poller.release());
    return { poller, state, patches, calls, signals, source };
}
const netInfo = '1: wlan0 inet 192.0.2.4/24 scope global';
const props = (model) => `[ro.product.model]: [${model}]`;

test('reconnect cancels the pending info retry and leaves exactly one retry chain', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const f = pollerFixture(t, (command) => command === 'getprop' ? props('new') : '');
    f.poller.setConnected(true);
    await flush();
    assert.equal(f.calls.filter((cmd) => cmd.startsWith('ip ')).length, 1);
    f.poller.setConnected(false);
    f.poller.setConnected(true);
    await flush();
    t.mock.timers.tick(1500); await flush();
    assert.equal(f.calls.filter((cmd) => cmd.startsWith('ip ')).length, 3, 'one initial read per connection and one retry');
    t.mock.timers.tick(3000); await flush();
    assert.equal(f.calls.filter((cmd) => cmd.startsWith('ip ')).length, 4, 'one chain backs off');
    assert.equal(f.calls.filter((cmd) => cmd === 'getprop').length, 2, 'properties cache belongs to one generation');
});

test('old in-flight info cannot update a reconnected descriptor, cache or schedule', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const old = deferred();
    let oldConnection = true;
    const f = pollerFixture(t, (command) => {
        if (command === 'getprop') return oldConnection ? old.promise : props('current');
        return command.startsWith('ip ') ? netInfo : '';
    });
    f.poller.setConnected(true); await flush();
    oldConnection = false;
    f.poller.setConnected(false); f.poller.setConnected(true); await flush();
    assert.equal(f.state['ro.product.model'], 'current');
    old.resolve(props('stale')); await flush();
    assert.equal(f.state['ro.product.model'], 'current');
    assert.equal((await f.poller.getProperties())['ro.product.model'], 'current');
    t.mock.timers.tick(10000); await flush();
    assert.equal(f.calls.filter((cmd) => cmd === 'getprop').length, 2);
    assert.equal(f.poller.due.info, undefined, 'a stale completion cannot rearm the retry');
});

test('one scheduler does not duplicate a pending runtime read when cadence changes, and release cancels it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const runtime = deferred();
    const f = pollerFixture(t, (command) => command.startsWith('dumpsys power') ? runtime.promise : command.startsWith('ip ') ? netInfo : props('current'));
    f.poller.setConnected(true); await flush();
    f.poller.setActive(true);
    t.mock.timers.tick(30000); await flush();
    assert.equal(f.calls.filter((cmd) => cmd.startsWith('dumpsys power')).length, 1);
    f.poller.release();
    const count = f.patches.length;
    assert.equal(f.poller.timer, undefined);
    assert.deepEqual(f.poller.due, {});
    assert.ok(f.signals.every((signal) => signal.aborted));
    runtime.resolve('mScreenState=OFF\n  level: 1'); await flush();
    t.mock.timers.tick(60000); await flush();
    assert.equal(f.patches.length, count);
});

test('runtime parser keeps modern power, anchored battery level and unknown data behavior', (t) => {
    const f = pollerFixture(t);
    f.poller.applyRuntimeState('Display Power: state=OFF\nmScreenState=ON\nCapacity level: 5\n  level: 84\nUSB powered: true');
    assert.equal(f.state['screen.power'], 'on');
    assert.equal(f.state['device.awake'], true);
    assert.equal(f.state['battery.level'], 84);
    assert.equal(f.state['battery.charging'], true);
    f.poller.applyRuntimeState('Display Power: state=OFF');
    assert.equal(f.state['screen.power'], 'off');
    assert.equal(f.state['device.awake'], false);
    f.poller.applyRuntimeState('');
    assert.equal(f.state['screen.power'], 'unknown');
    assert.equal(f.state['device.awake'], true);
    assert.equal(f.state['battery.level'], -1);
});

test('fresh PID reads apply in request order and explicit session changes invalidate pending status', async (t) => {
    const f = pollerFixture(t);
    f.poller.connected = true;
    const first = deferred(), second = deferred();
    let calls = 0;
    f.source.servicePids = () => ++calls === 1 ? first.promise : second.promise;
    const older = f.poller.refreshServicePid(), newer = f.poller.refreshServicePid();
    second.resolve([456]); await newer;
    first.resolve([123]); await older;
    assert.equal(f.state.pid, 456);
    const pending = deferred();
    f.source.servicePids = () => pending.promise;
    const old = f.poller.refreshServicePid();
    f.poller.setServerPid(789);
    pending.resolve([123]); await old;
    assert.equal(f.state.pid, 789);
    f.source.servicePids = async () => { throw Error('USB gone'); };
    await f.poller.refreshServicePid(); assert.equal(f.state.pid, 0);
});

function sessionFixture(t) {
    const shells = [];
    const target = {
        udid: 'session-fixture', TAG: '[session-fixture]', pid: 0, connected: true,
        isConnected: () => target.connected,
        getPidOf: async () => [],
        runShellCommandAdbKit: async () => '',
        push: async () => { const transfer = new EventEmitter(); queueMicrotask(() => transfer.emit('end')); return transfer; },
        openShell: async () => { const shell = rawShell(); shells.push(shell); return shell; },
        killProcess: async () => '', setServerPid: (pid) => { target.pid = pid; },
        invalidatePid() {}, refreshServicePid: async () => {}, sdk: () => '36',
        getLaunchStreamConfig: () => session.getLaunchStreamConfig(),
        launchServer: (command, audio) => session.launchServer(command, audio),
    };
    const session = new ScrcpySession(target);
    t.after(() => session.release());
    return { session, target, shells };
}
function quickSession(t) {
    for (const name of ['STREAM_CONNECT_DELAY_MS', 'STREAM_RETRY_DELAY_MS']) {
        const before = ScrcpySession[name]; ScrcpySession[name] = 1;
        t.after(() => { ScrcpySession[name] = before; });
    }
}

test('release while shell opening destroys a late stream and cannot launch queued work', async (t) => {
    const f = sessionFixture(t);
    const opening = deferred();
    f.target.openShell = () => opening.promise;
    const starting = assert.rejects(f.session.launchServer('fixture', false), /phone connection ended/);
    f.session.release(); await starting;
    const late = rawShell(); opening.resolve(late); await flush();
    assert.equal(late.destroyed, true);
    await assert.rejects(f.session.startServer(), /phone connection ended/);
    assert.equal(f.session.launch, undefined);
    assert.equal(f.session.idleStopTimeoutId, undefined);
});

test('release while forwarding removes the late owned forward and opens no broadcast', async (t) => {
    const f = sessionFixture(t);
    const forwarding = deferred();
    t.mock.method(AdbUtils, 'acquireForward', () => forwarding.promise);
    t.mock.method(broadcastManager, 'startBroadcast', () => assert.fail('No stream after cancellation'));
    const starting = assert.rejects(f.session.launchServer('fixture', false), /phone connection ended/);
    await flush(); f.shells[0].emit('data', Buffer.from('starting')); await flush();
    f.session.release(); await starting;
    let released = 0;
    forwarding.resolve({ port: 18999, release: async () => released++ }); await flush();
    assert.equal(released, 1);
    assert.equal(f.shells[0].destroyed, true);
    assert.equal(f.session.launch, undefined);
});

test('forward cancellation and removal finish before a successor can bind or reuse the port', async (t) => {
    const binding = deferred(), removal = deferred();
    const rows = [];
    const events = [];
    let binds = 0;
    t.mock.method(AdbExtended, 'createClient', () => ({
        listForwards: async () => { events.push('list'); return rows.slice(); },
        forwardNoRebind: async (serial, local, remote) => {
            events.push('bind'); rows.push({ serial, local, remote });
            if (++binds === 1) await binding.promise;
        },
        killForward: async (_serial, local) => {
            events.push('remove'); await removal.promise;
            rows.splice(rows.findIndex((row) => row.local === local), 1);
        },
    }));
    const portfinder = require('portfinder');
    t.mock.method(portfinder, 'getPortPromise', async () => 19001);
    const controller = new AbortController();
    const first = assert.rejects(AdbUtils.acquireForward('phone', 'localabstract:fixture', controller.signal), /cancel fixture/);
    await flush(); controller.abort(Error('cancel fixture'));
    const next = AdbUtils.acquireForward('phone', 'localabstract:fixture');
    binding.resolve(); await flush();
    assert.deepEqual(events, ['list', 'bind', 'remove']);
    removal.resolve(); await first;
    const successor = await next;
    assert.deepEqual(events, ['list', 'bind', 'remove', 'list', 'bind']);
    const release = successor.release();
    const third = AdbUtils.acquireForward('phone', 'localabstract:fixture');
    await release; const fresh = await third;
    assert.equal(binds, 3, 'the successor does not reuse a forward still being removed');
    await fresh.release(); await successor.release();
    assert.equal(rows.length, 0, 'lease cleanup happens once');
});

test('release during jar upload cancels its late transfer and launches nothing', async (t) => {
    const f = sessionFixture(t);
    const upload = deferred();
    f.target.push = () => upload.promise;
    f.target.openShell = () => assert.fail('A released upload must not launch');
    const starting = f.session.startServer().catch((error) => error);
    await flush(); f.session.release();
    const transfer = new EventEmitter(); let cancelled = 0;
    transfer.cancel = () => cancelled++;
    upload.resolve(transfer); await starting;
    transfer.emit('error', Error('late cancelled transfer'));
    assert.equal(cancelled, 1);
    assert.equal(f.session.launch, undefined);
});

test('a queued start cannot outlive release while an earlier operation is pending', async (t) => {
    const f = sessionFixture(t), first = deferred();
    let starts = 0;
    t.mock.method(ScrcpyServer, 'run', async () => { starts++; await first.promise; });
    const one = f.session.startServer();
    const two = assert.rejects(f.session.startServer(), /phone connection ended/);
    await flush(); f.session.release(); first.resolve();
    await one; await two;
    assert.equal(starts, 1);
    assert.equal(f.session.idleStopTimeoutId, undefined);
});

function fakeSockets(t) {
    const sockets = [];
    t.mock.method(net, 'connect', () => {
        const socket = rawShell();
        sockets.push(socket); return socket;
    });
    return sockets;
}

test('pre-aborted broadcast opens zero sockets', async (t) => {
    const sockets = fakeSockets(t), controller = new AbortController();
    controller.abort(Error('cancel startup'));
    await assert.rejects(broadcastManager.startBroadcast('pre-abort', 18999, true, undefined, controller.signal), /cancel startup/);
    assert.equal(sockets.length, 0);
});

for (const audio of [false, true]) test(`aborting ${audio ? 'three' : 'two'} startup sockets cleans late connect and errors`, async (t) => {
    const sockets = fakeSockets(t), controller = new AbortController();
    const udid = `pending-${audio}`;
    const rejected = assert.rejects(broadcastManager.startBroadcast(udid, 18999, audio, undefined, controller.signal), /cancel startup/);
    assert.equal(sockets.length, audio ? 3 : 2);
    controller.abort(Error('cancel startup')); await rejected;
    assert.ok(sockets.every((socket) => socket.destroyed));
    for (const socket of sockets) {
        assert.equal(socket.listenerCount('connect'), 0);
        socket.emit('connect'); socket.emit('error', Error('late startup error'));
    }
    assert.equal(broadcastManager.getBroadcast(udid), undefined);
});

test('an old startup signal and old teardown leave the replacement broadcast alone', async (t) => {
    const sockets = fakeSockets(t), oldSignal = new AbortController();
    const first = broadcastManager.startBroadcast('identity-fixture', 18999, false, undefined, oldSignal.signal);
    sockets[0].emit('connect'); const old = await first;
    assert.equal(sockets[1].listenerCount('connect'), 1, 'successful video keeps control diagnostic logging');
    broadcastManager.stopBroadcast('identity-fixture', old);
    const second = broadcastManager.startBroadcast('identity-fixture', 18999, true);
    sockets[2].emit('connect'); const current = await second;
    oldSignal.abort(Error('old launch ended'));
    sockets[0].emit('close'); sockets[1].emit('error', Error('old control close'));
    assert.equal(broadcastManager.getBroadcast('identity-fixture'), current);
    assert.ok(sockets.slice(2).every((socket) => !socket.destroyed));
    broadcastManager.stopBroadcast('identity-fixture', old);
    assert.equal(broadcastManager.getBroadcast('identity-fixture'), current);
    broadcastManager.stopBroadcast('identity-fixture', current);
});

test('disconnect during broadcast connection closes every startup socket and never sends owner Stop', async (t) => {
    quickSession(t);
    const f = sessionFixture(t), sockets = fakeSockets(t);
    const closes = [];
    f.session.addViewer({ close: (code) => closes.push(code) });
    t.mock.method(AdbUtils, 'acquireForward', async () => ({ port: 18999, release: async () => {} }));
    const starting = assert.rejects(f.session.launchServer('fixture', true), /phone connection ended/);
    await flush(); f.shells[0].emit('data', Buffer.from('starting'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sockets.length, 3);
    f.session.setConnected(false); await starting;
    assert.ok(sockets.every((socket) => socket.destroyed));
    assert.deepEqual(closes, []);
    assert.equal(f.session.launch, undefined);
});

test('an old shell close cannot stop its replacement or change its PID/audio state', async (t) => {
    quickSession(t);
    const f = sessionFixture(t), stopped = [], broadcasts = [];
    t.mock.method(AdbUtils, 'acquireForward', async () => ({ port: 18999, release: async () => {} }));
    t.mock.method(broadcastManager, 'startBroadcast', async () => {
        const broadcast = { whenReady: async () => true }; broadcasts.push(broadcast); return broadcast;
    });
    t.mock.method(broadcastManager, 'stopBroadcast', (_udid, broadcast) => stopped.push(broadcast));
    const old = f.session.launchServer('old', true);
    await flush(); f.shells[0].emit('data', Buffer.from('ready'));
    await old;
    const next = f.session.launchServer('current', false);
    await flush(); f.shells[1].emit('data', Buffer.from('ready'));
    await next;
    f.target.pid = 456;
    f.shells[0].emit('close');
    assert.equal(f.target.pid, 456);
    assert.deepEqual(stopped, [broadcasts[0]]);
    assert.equal(f.session.launch.broadcast, broadcasts[1]);
    f.shells[0].emit('data', Buffer.from('Audio recording error'));
    assert.equal(f.session.audioFailure, undefined);
});

test('unchanged tracker states leave a running session and poll chain alone', async (t) => {
    t.mock.method(AdbExtended, 'createClient', () => ({ shell: async () => shellAnswer('') }));
    const device = new Device('unchanged-fixture', 'device');
    t.after(() => device.release());
    await flush();
    const generation = device.poller.generation;
    const signal = device.session.lifetime.signal;
    const shell = rawShell();
    device.session.launch = { shell, done: true, finish() {}, controller: new AbortController() };
    device.setState('device');
    assert.equal(device.poller.generation, generation);
    assert.equal(signal.aborted, false);
    assert.equal(shell.destroyed, false);
});

test('diagnostics keep no timeout by default and Files keep their 15 second default', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const diagnostic = deferred();
    const shell = new AdbShell('fixture', { shell: () => diagnostic.promise });
    let settled = false;
    const reading = shell.read('diagnostic').then((value) => { settled = true; return value; });
    await flush(); t.mock.timers.tick(120000); await flush();
    assert.equal(settled, false);
    diagnostic.resolve(shellAnswer('late diagnostic'));
    assert.equal(await reading, 'late diagnostic');
    const file = new AdbShell('fixture', { shell: () => new Promise(() => {}) });
    const expired = assert.rejects(file.exec('file command'), /did not answer in time/);
    await flush(); t.mock.timers.tick(14999); await flush();
    t.mock.timers.tick(1); await expired;
    shell.release(); file.release();
});

test('an info retry waits for both branches after one fails', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const pending = deferred();
    const f = pollerFixture(t, (command) => {
        if (command === 'getprop') throw Error('property read failed');
        if (command.startsWith('ip ')) return pending.promise;
        return '';
    });
    f.poller.setConnected(true); await flush();
    t.mock.timers.tick(10000); await flush();
    assert.equal(f.calls.filter((command) => command.startsWith('ip ')).length, 1);
    assert.equal(f.poller.due.info, undefined, 'no retry while interfaces are still reading');
    pending.resolve(''); await flush();
    t.mock.timers.tick(1500); await flush();
    assert.equal(f.calls.filter((command) => command.startsWith('ip ')).length, 2);
});

test('owner Stop prevents an already queued viewer ensure from starting again', async (t) => {
    const f = sessionFixture(t);
    f.session.getServerPid = async () => undefined;
    t.mock.method(broadcastManager, 'hasBroadcast', () => false);
    t.mock.method(ScrcpyServer, 'run', () => assert.fail('A queued viewer must respect owner Stop'));
    const stopped = f.session.killServer(123);
    const queuedViewer = f.session.ensureServer();
    await stopped; await queuedViewer;
    assert.equal(f.session.launch, undefined);
});

test('a public PID capability probe cannot open fallback diagnostics after disconnect', async (t) => {
    const probe = deferred(); let transports = 0;
    const f = pollerFixture(t, (_command, _timeout, signal) => {
        signal?.throwIfAborted();
        transports++;
        return transports === 1 ? probe.promise : '';
    });
    f.poller.connected = true;
    const read = f.poller.getPidOf('app_process');
    await flush(); f.poller.setConnected(false); probe.resolve('');
    await read;
    assert.equal(transports, 1, 'the cancelled generation opens no new shell');
    assert.equal(f.poller.pidDetectionVariant, 0, 'the stale probe does not populate the capability cache');
});

test('info retries stop after seven retries', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    t.mock.method(console, 'error', () => {});
    const f = pollerFixture(t);
    f.poller.setConnected(true); await flush();
    for (const delay of [1500, 3000, 6000, 12000, 24000, 48000, 96000]) {
        t.mock.timers.tick(delay); await flush();
    }
    t.mock.timers.tick(192000); await flush();
    assert.equal(f.calls.filter((command) => command.startsWith('ip ')).length, 8);
    assert.equal(f.poller.due.info, undefined);
});
