// Direct Android shell, poller and session races. Every transport is a fixture.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { EventEmitter, getEventListeners, once } = require('node:events');
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
const { ScrcpyInstance } = require('../src/server/goog-device/ScrcpyInstance');
const { streamConfig } = require('../src/server/goog-device/StreamConfig');
const { LOCK_STATE_COMMAND } = require('../src/server/goog-device/LockState');
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
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort(Error('cancel startup'));
    assert.ok(sockets.every((socket) => socket.destroyed));
    await rejected;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
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
    assert.equal(getEventListeners(oldSignal.signal, 'abort').length, 0, 'the registered broadcast releases its startup listener');
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

test('release while a registered Broadcast waits for its header settles readiness and closes all resources', async (t) => {
    quickSession(t);
    const f = sessionFixture(t), sockets = fakeSockets(t);
    let removed = 0;
    t.mock.method(AdbUtils, 'acquireForward', async () => ({ port: 18999, release: async () => removed++ }));
    const starting = assert.rejects(f.session.launchServer('fixture', true), /phone connection ended/);
    await flush(); f.shells[0].emit('data', Buffer.from('starting'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    sockets[0].emit('connect'); await flush();
    const broadcast = broadcastManager.getBroadcast(f.target.udid);
    const readiness = broadcast.whenReady();
    f.session.release(); await starting;
    assert.equal(await readiness, false);
    await flush();
    assert.equal(broadcastManager.getBroadcast(f.target.udid), undefined);
    assert.ok(sockets.every((socket) => socket.destroyed));
    assert.equal(f.shells[0].destroyed, true);
    assert.equal(removed, 1);
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

test('a late old lease cannot remove a forward the successor already reused', async (t) => {
    const rows = [], removed = [];
    t.mock.method(AdbExtended, 'createClient', () => ({
        listForwards: async () => rows.slice(),
        forwardNoRebind: async (serial, local, remote) => rows.push({ serial, local, remote }),
        killForward: async (_serial, local) => {
            removed.push(local);
            rows.splice(rows.findIndex((row) => row.local === local), 1);
        },
    }));
    t.mock.method(require('portfinder'), 'getPortPromise', async () => 19002);
    const old = await AdbUtils.acquireForward('overlap-phone', 'localabstract:fixture');
    const current = await AdbUtils.acquireForward('overlap-phone', 'localabstract:fixture');
    assert.equal(old.port, current.port);
    await old.release();
    assert.deepEqual(removed, [], 'the successor still owns this forward');
    assert.equal(rows.length, 1);
    await current.release();
    assert.deepEqual(removed, ['tcp:19002']);
    const fresh = await AdbUtils.acquireForward('overlap-phone', 'localabstract:fixture');
    await old.release(); await current.release();
    assert.equal(rows.length, 1, 'repeated old cleanup cannot remove the fresh identity');
    await fresh.release();
    assert.equal(rows.length, 0);
});

// Keep the public facade and every owner real. Only the adb and TCP boundaries answer here.
function facadeTransport(t, udid) {
    const commands = [], launches = [], rows = [], removed = [], killed = [], uploads = [], diagnostics = [];
    let model = 'Fixture phone', current, nextPid = 400;
    let pendingInfo;
    const lock = 'lock.currentUser=0\nkeyguard.showing=true\nkeyguard.occluded=false\n' +
        'keyguard.screenState=SCREEN_STATE_ON\ntrust.user=0 (current) deviceLocked=true\nlock.currentUserAfter=0';
    const client = {
        shell: async (serial, command) => {
            assert.equal(serial, udid);
            commands.push(command);
            if (command === 'getprop' && pendingInfo) return pendingInfo.promise;
            let output;
            if (command === 'getprop') output = `${props(model)}\n[ro.product.manufacturer]: [Test]\n[ro.build.version.sdk]: [36]`;
            else if (command.startsWith('ip ')) output = netInfo;
            else if (command.startsWith('dumpsys power')) output = 'mScreenState=ON\n  level: 84\nUSB powered: true';
            else if (command === LOCK_STATE_COMMAND) output = lock;
            else if (command.startsWith('which pidof')) output = '0';
            else if (command === 'echo $PPID; pidof init') output = '22\n1';
            else if (command === 'pidof app_process') output = current ? String(current.pid) : '';
            else if (command.startsWith('cat /proc/')) output = `app_process\0${require('../src/common/Constants').SERVER_PACKAGE}\0version\0scid=${ScrcpyInstance.getScid()}\0`;
            else if (command.startsWith('kill ')) {
                killed.push(Number(command.slice(5)));
                current?.shell.destroy(); current = undefined; output = '';
            } else if (command.startsWith('input keyevent 224')) output = '__rc=0';
            else if (command.includes('list_encoders=true')) output = "--video-codec=h264 --video-encoder='fixture.encoder' (hw)";
            else if (command.startsWith('CLASSPATH=')) {
                assert.equal(uploads.at(-1).ended, true, 'the jar finishes before the streaming shell opens');
                const shell = new PassThrough();
                current = { pid: ++nextPid, shell, command, sockets: [] };
                launches.push(current);
                queueMicrotask(() => shell.write('[server] INFO: starting\n'));
                return shell;
            } else assert.fail(`Unexpected fixture command: ${command}`);
            const socket = shellAnswer(output);
            diagnostics.push(socket);
            return socket;
        },
        push: async (serial, _contents, destination) => {
            assert.equal(serial, udid);
            assert.equal(destination, '/data/local/tmp/scrcpy-server.jar');
            const transfer = new EventEmitter();
            uploads.push(transfer);
            setImmediate(() => { transfer.ended = true; transfer.emit('end'); });
            return transfer;
        },
        listForwards: async () => rows.slice(),
        forwardNoRebind: async (serial, local, remote) => rows.push({ serial, local, remote }),
        killForward: async (serial, local) => {
            assert.equal(serial, udid); removed.push(local);
            rows.splice(rows.findIndex((row) => row.local === local), 1);
        },
    };
    t.mock.method(AdbExtended, 'createClient', () => client);
    t.mock.method(require('portfinder'), 'getPortPromise', async () => 19101);
    t.mock.method(cp, 'spawn', () => assert.fail('No Android child process'));
    t.mock.method(net, 'connect', () => {
        assert.ok(current, 'tracking alone never connects a stream');
        const socket = rawShell(), first = current.sockets.length === 0;
        current.sockets.push(socket);
        queueMicrotask(() => {
            if (socket.destroyed) return;
            socket.emit('connect');
            if (first) {
                const header = Buffer.alloc(16);
                header.writeUInt32BE(0x68323634); // h264
                header.writeUInt32BE(0x80000000, 4); // scrcpy session flag
                header.writeUInt32BE(1080, 8); header.writeUInt32BE(1920, 12);
                socket.emit('data', header);
            }
        });
        return socket;
    });
    return { commands, launches, rows, removed, killed, uploads, diagnostics,
        setModel: (value) => { model = value; }, setPendingInfo: (value) => { pendingInfo = value; } };
}

test('public Device wires initial state, cache, tracker cadence, reconnect and release through real owners', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    const f = facadeTransport(t, 'facade-state');
    const device = new Device('facade-state', 'device');
    t.after(() => device.release());
    const updates = [];
    device.on('update', (value) => updates.push({ ...value.descriptor }));
    await flush(); t.mock.timers.tick(301); await flush();
    assert.equal(device.getDeviceName(), 'Test Fixture phone');
    assert.equal(device.descriptor['battery.level'], 84);
    assert.equal(device.descriptor['device.locked'], true);
    assert.equal(device.descriptor.pid, -1);
    assert.deepEqual(device.descriptor.interfaces, [{ name: 'wlan0', ipv4: '192.0.2.4' }]);
    assert.ok(updates.some((state) => state['ro.product.model'] === 'Fixture phone' && state.pid === -1));
    assert.equal(f.launches.length, 0, 'tracking populates state without starting scrcpy');
    assert.equal((await device.getProperties())['ro.product.model'], 'Fixture phone');
    assert.equal(f.commands.filter((command) => command === 'getprop').length, 1, 'public reads reuse the initialized cache');
    assert.deepEqual(await device.getNetInterfaces(), device.descriptor.interfaces);
    assert.deepEqual(await device.updateInterfaces(), device.descriptor.interfaces);
    const lockReads = f.commands.filter((command) => command === LOCK_STATE_COMMAND).length;
    assert.equal((await device.refreshLockState())['device.locked'], true);
    assert.equal(f.commands.filter((command) => command === LOCK_STATE_COMMAND).length, lockReads + 1, 'pre-submit read is fresh');
    device.setRuntimeStatePollActive(true);
    t.mock.timers.tick(0); await flush();
    const activeReads = f.commands.filter((command) => command === LOCK_STATE_COMMAND).length;
    t.mock.timers.tick(2000); await flush();
    assert.equal(f.commands.filter((command) => command === LOCK_STATE_COMMAND).length, activeReads + 1);
    await device.wake(); t.mock.timers.tick(500); await flush();
    assert.equal(f.launches.length, 0, 'Wake uses the shell and scheduler without opening a stream');
    device.setState('offline');
    assert.equal(device.descriptor['device.locked'], 'unknown');
    assert.equal(device.descriptor.pid, 0);
    f.setModel('Reconnected phone'); device.setState('device'); await flush();
    assert.equal(device.getDeviceName(), 'Test Reconnected phone');
    const late = deferred(); f.setPendingInfo(late);
    device.setState('offline'); device.setState('device'); await flush();
    device.release(); const snapshot = { ...device.descriptor }, count = f.commands.length, events = updates.length;
    const socket = new PassThrough(); late.resolve(socket); await flush();
    assert.equal(socket.destroyed, true, 'release closes a getprop socket that connects late');
    t.mock.timers.tick(120000); await flush();
    assert.equal(f.commands.length, count);
    assert.equal(updates.length, events);
    assert.deepEqual(device.descriptor, snapshot);
    device.setState('device'); assert.equal(device.isConnected(), false);
});

test('public Device cooperates through shell, jar, forward and Broadcast for viewers and settings', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 200000 });
    const f = facadeTransport(t, 'facade-session');
    streamConfig.set('facade-session', { audio: false });
    const device = new Device('facade-session', 'device');
    t.after(() => device.release());
    await flush();
    const completeStart = async (pending) => {
        let done = false;
        pending.finally(() => { done = true; }).catch(() => {});
        for (let turn = 0; turn < 10 && !done; turn++) {
            await flush(); t.mock.timers.tick(1000); await flush();
        }
        assert.equal(done, true, 'the real owners finish the queued launch');
        return pending;
    };
    const closes = [], viewer = () => ({ close: (code) => closes.push(code) });
    let leaveFirst = device.addViewer(viewer());
    const first = device.ensureServer(), second = device.ensureServer();
    await completeStart(Promise.all([first, second]));
    assert.equal(f.launches.length, 1);
    assert.equal(device.descriptor.pid, 401);
    assert.equal(f.launches[0].sockets.length, 2);
    assert.equal(await broadcastManager.getBroadcast(device.udid).whenReady(), true);
    assert.equal((await device.listEncoders())[0].encoderName, 'fixture.encoder');
    assert.equal(device.getCachedEncoders()[0].hardware, 'hw');
    const leaveSecond = device.addViewer(viewer()); await device.ensureServer();
    assert.equal(f.launches.length, 1, 'an additional viewer reuses the launch');
    leaveFirst(); t.mock.timers.tick(30000); await flush();
    assert.equal(f.killed.length, 0, 'the remaining viewer retains the stream');
    leaveSecond(); t.mock.timers.tick(29999); await flush();
    assert.equal(f.killed.length, 0);
    leaveFirst = device.addViewer(viewer()); t.mock.timers.tick(1); await flush();
    assert.equal(f.killed.length, 0, 'return cancels the last-viewer grace');
    const changing = device.updateStreamConfig({ audio: true });
    const queuedViewer = device.ensureServer();
    await completeStart(Promise.all([changing, queuedViewer]));
    assert.equal(f.launches.length, 2, 'watched settings restart once through the same queue');
    assert.match(f.launches[1].command, /audio=true/);
    assert.equal(f.launches[1].sockets.length, 3);
    assert.equal(device.getLaunchStreamConfig().audio, true);
    assert.ok(f.launches[0].shell.destroyed);
    assert.ok(f.launches[0].sockets.every((socket) => socket.destroyed));
    assert.deepEqual(closes, [], 'settings restarts use ordinary reconnect behavior');
    await device.killServer(device.descriptor.pid);
    assert.deepEqual(closes, [4012], 'only owner Stop tells a viewer to stay stopped');
    leaveFirst();
    await device.updateStreamConfig({ audio: false });
    assert.equal(f.launches.length, 2, 'unwatched settings do not start a stream');
    const leaveLast = device.addViewer(viewer());
    await completeStart(device.ensureServer());
    leaveLast(); const beforeGrace = f.killed.length;
    t.mock.timers.tick(29999); await flush(); assert.equal(f.killed.length, beforeGrace);
    t.mock.timers.tick(1); await flush(); assert.equal(f.killed.length, beforeGrace + 1);
    assert.equal(broadcastManager.getBroadcast(device.udid), undefined);
    assert.ok(f.launches.at(-1).sockets.every((socket) => socket.destroyed));
    assert.equal(f.rows.length, 0);
    assert.equal(f.removed.length, 3, 'each completed launch releases its owned forward');
    assert.deepEqual(closes, [4012], 'idle stop does not send owner Stop');
    device.setState('offline'); device.setState('device'); await flush();
    device.release(); await flush();
    assert.deepEqual(closes, [4012], 'disconnect and shutdown do not send owner Stop');
    assert.ok(f.launches.every((launch) => launch.shell.destroyed));
});

// Real installed adbkit and TCP sockets. The fake ADB peer deliberately stays half-open.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, message) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (condition()) return;
        await pause(5);
    }
    assert.ok(condition(), message);
}
async function adbPeer(t, answer) {
    const peers = [], frames = [];
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
        peers.push(socket);
        socket.on('error', () => {});
        socket.on('end', () => { socket.sawFin = true; });
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                if (socket.syncData) { socket.syncData(buffer); buffer = Buffer.alloc(0); return; }
                if (buffer.length < 4) return;
                const size = Number.parseInt(buffer.subarray(0, 4).toString(), 16);
                assert.ok(Number.isInteger(size), 'ADB request uses its four-hex-digit length');
                if (buffer.length < size + 4) return;
                const frame = buffer.subarray(4, size + 4).toString();
                buffer = buffer.subarray(size + 4);
                frames.push({ frame, socket });
                answer(frame, socket);
            }
        });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    const clients = () => process._getActiveHandles().filter((handle) => handle instanceof net.Socket && handle.remotePort === port);
    t.after(async () => {
        clients().forEach((socket) => socket.destroy());
        peers.forEach((socket) => socket.destroy());
        await new Promise((resolve) => server.close(resolve));
        await flush();
    });
    const client = originalClient({ host: '127.0.0.1', port });
    t.mock.method(AdbExtended, 'createClient', () => client);
    t.mock.method(cp, 'spawn', () => assert.fail('No daemon/CLI child'));
    t.mock.method(cp, 'execFile', () => assert.fail('No daemon/CLI child'));
    const closed = async (owned) => {
        assert.ok(owned.length > 0, 'the real client opened a TCP socket');
        assert.ok(owned.every((socket) => socket.destroyed), 'cancellation destroys each actual client TCP socket');
        await waitFor(() => clients().length === 0, 'no matching client socket handle remains');
        await waitFor(() => peers.every((socket) => socket.sawFin || socket.destroyed), 'the fake peer observes FIN or close');
    };
    return { client, server, port, peers, frames, clients, closed };
}

for (const phase of ['transport', 'shell']) for (const action of ['release', 'timeout']) {
    test(`real adbkit stalled ${phase} closes actual TCP on ${action}`, { timeout: 3000 }, async (t) => {
        const f = await adbPeer(t, (frame, socket) => {
            if (phase === 'shell' && frame.startsWith('host:transport:')) socket.write('OKAY');
        });
        const shell = new AdbShell('handshake-phone', f.client);
        t.after(() => shell.release());
        const pending = (action === 'timeout' ? shell.read('fixture', 100) : shell.open('fixture')).catch((error) => error);
        await waitFor(() => f.frames.some(({ frame }) => phase === 'shell' ? frame === 'shell:fixture' : frame.startsWith('host:transport:')), 'the stalled handshake is reached');
        const owned = f.clients();
        if (action === 'release') shell.release(); else await pause(130);
        await f.closed(owned);
        assert.match((await pending).message, action === 'timeout' ? /timed out/ : /connection ended/);
        assert.ok(f.peers.some((socket) => socket.sawFin && !socket.destroyed), 'client destruction does not wait for a half-open peer to close');
    });
}

for (const phase of ['list', 'forward-first', 'forward-second']) {
    test(`real adbkit stalled ${phase} closes actual TCP on launch abort`, { timeout: 3000 }, async (t) => {
        const f = await adbPeer(t, (frame, socket) => {
            if (frame.endsWith(':list-forward') && phase !== 'list') socket.end('OKAY0000');
            else if (frame.includes(':forward:norebind:') && phase === 'forward-second') socket.write('OKAY');
        });
        t.mock.method(require('portfinder'), 'getPortPromise', async () => 19201);
        const controller = new AbortController();
        const pending = AdbUtils.acquireForward('handshake-phone', 'localabstract:handshake-fixture', controller.signal).catch((error) => error);
        await waitFor(() => f.frames.some(({ frame }) => phase === 'list' ? frame.endsWith(':list-forward') : frame.includes(':forward:norebind:')), 'the forward handshake is reached');
        const owned = f.clients(); controller.abort(Error('Cancel forward fixture'));
        await f.closed(owned);
        assert.match((await pending).message, /Cancel forward fixture/);
        assert.ok(!f.frames.some(({ frame }) => frame.includes('killforward')), 'unconfirmed forward ownership is not guessed');
    });
}

for (const phase of ['transport', 'sync']) {
    test(`real adbkit stalled push ${phase} closes actual TCP on launch abort`, { timeout: 3000 }, async (t) => {
        const f = await adbPeer(t, (frame, socket) => {
            if (phase === 'sync' && frame.startsWith('host:transport:')) socket.write('OKAY');
        });
        const controller = new AbortController(), shell = new AdbShell('handshake-phone', f.client);
        t.after(() => shell.release());
        const pending = shell.push(path.join(temporary, 'not-opened-before-sync'), '/data/local/tmp/fixture', controller.signal).catch((error) => error);
        await waitFor(() => f.frames.some(({ frame }) => phase === 'sync' ? frame === 'sync:' : frame.startsWith('host:transport:')), 'the upload handshake is reached');
        const owned = f.clients(); controller.abort(Error('Cancel upload fixture'));
        await f.closed(owned);
        assert.match((await pending).message, /Cancel upload fixture/);
    });
}

test('real adbkit pre-abort and abort during TCP connect leave no client handle or child', { timeout: 3000 }, async (t) => {
    const f = await adbPeer(t, () => {}), controller = new AbortController();
    controller.abort(Error('Pre-aborted fixture'));
    const shell = new AdbShell('handshake-phone', f.client);
    t.after(() => shell.release());
    await assert.rejects(shell.open('fixture', controller.signal), /Pre-aborted/);
    await assert.rejects(shell.push('not-opened', '/fixture', controller.signal), /Pre-aborted/);
    await assert.rejects(AdbUtils.acquireForward('handshake-phone', 'localabstract:fixture', controller.signal), /Pre-aborted/);
    await flush(); assert.equal(f.peers.length, 0);
    const during = new AbortController(), before = new Set(process._getActiveHandles());
    const operation = AdbExtended.operation(f.client, during.signal);
    const connecting = operation.client.shell('handshake-phone', 'fixture').catch((error) => error);
    const created = process._getActiveHandles().filter((handle) => handle instanceof net.Socket && !before.has(handle));
    assert.equal(created.length, 1);
    during.abort(Error('Cancelled TCP connect'));
    assert.ok(created.every((socket) => socket.destroyed));
    assert.match((await connecting).message, /Cancelled TCP connect/);
    await waitFor(() => created.every((socket) => !process._getActiveHandles().includes(socket)), 'connecting socket leaves the handle list');
    operation.close();
});

test('real adbkit concurrent shell scopes and late errors cannot cancel their sibling', { timeout: 3000 }, async (t) => {
    const f = await adbPeer(t, (frame, socket) => { if (frame.startsWith('host:transport:')) socket.write('OKAY'); });
    const originalConnection = f.client.connection, shell = new AdbShell('handshake-phone', f.client);
    t.after(() => shell.release());
    const one = new AbortController(), two = new AbortController();
    const first = shell.open('one', one.signal).catch((error) => error), second = shell.open('two', two.signal);
    await waitFor(() => f.frames.filter(({ frame }) => frame.startsWith('shell:')).length === 2, 'both shell scopes reach their own handshake');
    const peerOne = f.frames.find(({ frame }) => frame === 'shell:one').socket;
    const peerTwo = f.frames.find(({ frame }) => frame === 'shell:two').socket;
    const socketOne = f.clients().find((socket) => socket.localPort === peerOne.remotePort);
    const socketTwo = f.clients().find((socket) => socket.localPort === peerTwo.remotePort);
    one.abort(Error('Cancel one scope'));
    assert.equal(socketOne.destroyed, true);
    assert.equal(socketTwo.destroyed, false);
    assert.match((await first).message, /Cancel one scope/);
    assert.doesNotThrow(() => socketOne.emit('error', Error('Late cancelled connection error')));
    peerTwo.write('OKAY');
    assert.equal(await second, socketTwo, 'the un-aborted shell receives its original raw socket');
    assert.equal(f.client.connection, originalConnection, 'the shared client is unchanged');
    two.abort(Error('End second scope'));
    await f.closed([socketOne, socketTwo]);
});

test('real adbkit refused operation never invokes adbkit daemon startup', { timeout: 3000 }, async (t) => {
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port; await new Promise((resolve) => server.close(resolve));
    let children = 0;
    t.mock.method(cp, 'execFile', () => { children++; assert.fail('No daemon startup child'); });
    t.mock.method(cp, 'spawn', () => { children++; assert.fail('No CLI child'); });
    const shell = new AdbShell('handshake-phone', originalClient({ host: '127.0.0.1', port }));
    await assert.rejects(shell.read('fixture', 1000), new RegExp(`adb server at 127.0.0.1:${port} is not running`));
    shell.release(); assert.equal(children, 0);
});

for (const commit of [false, true]) test(`unconfirmed real forward ${commit ? 'lost ACK' : 'norebind collision'} never removes an uncertain binding`, { timeout: 3000 }, async (t) => {
    const rows = [], removals = [];
    const f = await adbPeer(t, (frame, socket) => {
        if (frame.endsWith(':list-forward')) socket.end('OKAY0000');
        else if (frame.includes(':forward:norebind:')) {
            rows.push({ serial: commit ? 'handshake-phone' : 'another-phone', local: 'tcp:19202', remote: commit ? 'localabstract:owned-fixture' : 'localabstract:external' });
            socket.write('OKAY'); // final success/failure status is lost
        } else if (frame.includes('killforward')) { removals.push(frame); socket.end('OKAY'); }
    });
    t.mock.method(require('portfinder'), 'getPortPromise', async () => 19202);
    const controller = new AbortController();
    const pending = AdbUtils.acquireForward('handshake-phone', 'localabstract:owned-fixture', controller.signal).catch((error) => error);
    await waitFor(() => rows.length === 1, 'the fake daemon has committed or collided before losing the reply');
    const owned = f.clients(); controller.abort(Error('Lost forward reply'));
    await f.closed(owned); assert.match((await pending).message, /Lost forward reply/);
    assert.deepEqual(removals, []);
    assert.equal(rows.length, 1, 'an unconfirmed mapping remains: the protocol cannot establish its owner');
});

test('confirmed real forward cleanup stays usable after launch abort and preserves external forwards', { timeout: 3000 }, async (t) => {
    const rows = [{ serial: 'external-phone', local: 'tcp:19203', remote: 'localabstract:external' }], removals = [];
    const f = await adbPeer(t, (frame, socket) => {
        if (frame.endsWith(':list-forward')) {
            const value = rows.map((row) => `${row.serial} ${row.local} ${row.remote}\n`).join('');
            socket.end('OKAY' + Buffer.byteLength(value).toString(16).padStart(4, '0') + value);
        } else if (frame.includes(':forward:norebind:')) {
            rows.push({ serial: 'handshake-phone', local: 'tcp:19204', remote: 'localabstract:owned-fixture' });
            socket.end('OKAYOKAY');
        } else if (frame.endsWith(':killforward:tcp:19204')) {
            removals.push(frame); rows.splice(rows.findIndex((row) => row.local === 'tcp:19204'), 1); socket.end('OKAYOKAY');
        } else assert.fail(`Unexpected forward frame ${frame}`);
    });
    t.mock.method(require('portfinder'), 'getPortPromise', async ({ port }) => port === 19204 ? 19204 : 19203);
    const controller = new AbortController();
    const lease = await AdbUtils.acquireForward('handshake-phone', 'localabstract:owned-fixture', controller.signal);
    assert.equal(lease.port, 19204);
    controller.abort(Error('Launch ended'));
    await lease.release(); await lease.release();
    assert.equal(removals.length, 1);
    assert.deepEqual(rows, [{ serial: 'external-phone', local: 'tcp:19203', remote: 'localabstract:external' }]);
    await waitFor(() => f.clients().length === 0, 'finite command scopes release their sockets');
});

test('confirmed real forward cleanup has its own budget and retains ownership after a lost removal reply', { timeout: 3000 }, async (t) => {
    const rows = [], removals = [];
    let acknowledge = false;
    const f = await adbPeer(t, (frame, socket) => {
        if (frame.endsWith(':list-forward')) {
            const value = rows.map((row) => `${row.serial} ${row.local} ${row.remote}\n`).join('');
            socket.end('OKAY' + Buffer.byteLength(value).toString(16).padStart(4, '0') + value);
        } else if (frame.includes(':forward:norebind:')) {
            rows.push({ serial: 'cleanup-phone', local: 'tcp:19205', remote: 'localabstract:cleanup-fixture' });
            socket.end('OKAYOKAY');
        } else if (frame.endsWith(':killforward:tcp:19205')) {
            removals.push(frame);
            if (acknowledge) { rows.length = 0; socket.end('OKAYOKAY'); } else socket.write('OKAY');
        } else assert.fail(`Unexpected cleanup frame ${frame}`);
    });
    t.mock.method(require('portfinder'), 'getPortPromise', async () => 19205);
    const before = AdbUtils.FORWARD_CLEANUP_TIMEOUT_MS;
    AdbUtils.FORWARD_CLEANUP_TIMEOUT_MS = 40;
    t.after(() => { AdbUtils.FORWARD_CLEANUP_TIMEOUT_MS = before; });
    const controller = new AbortController();
    const lease = await AdbUtils.acquireForward('cleanup-phone', 'localabstract:cleanup-fixture', controller.signal);
    controller.abort(Error('Launch already ended'));
    const release = lease.release().catch((error) => error);
    await waitFor(() => removals.length === 1, 'cleanup uses a fresh connection despite the dead launch signal');
    const owned = f.clients(); await pause(50); await f.closed(owned);
    assert.match((await release).message, /forward timed out/);
    assert.equal(rows.length, 1, 'mapping removal was not confirmed');
    const successor = await AdbUtils.acquireForward('cleanup-phone', 'localabstract:cleanup-fixture');
    await lease.release(); assert.equal(removals.length, 1, 'old cleanup does not affect the successor');
    acknowledge = true; await successor.release();
    assert.equal(removals.length, 2, 'a later explicit owner can release the retained confirmed identity');
    assert.equal(rows.length, 0);
});

test('legacy real forward cleanup times out its own stalled removal socket', { timeout: 3000 }, async (t) => {
    const local = 'localfilesystem:/tmp/cleanup-fixture', removals = [];
    const f = await adbPeer(t, (frame, socket) => {
        if (frame.endsWith(':list-forward')) {
            const value = `cleanup-phone ${local} localabstract:legacy\n`;
            socket.end('OKAY' + Buffer.byteLength(value).toString(16).padStart(4, '0') + value);
        } else if (frame.endsWith(':killforward:' + local)) { removals.push(frame); socket.write('OKAY'); }
        else assert.fail(`Unexpected legacy cleanup frame ${frame}`);
    });
    const before = AdbUtils.FORWARD_CLEANUP_TIMEOUT_MS;
    AdbUtils.FORWARD_CLEANUP_TIMEOUT_MS = 40;
    t.after(() => { AdbUtils.FORWARD_CLEANUP_TIMEOUT_MS = before; });
    const pending = AdbUtils.removeFileSocketForwards('cleanup-phone').catch((error) => error);
    await waitFor(() => removals.length === 1, 'legacy removal reaches the stalled second status');
    const owned = f.clients(); await pause(50); await f.closed(owned);
    assert.match((await pending).message, /forward timed out/);
    assert.equal(removals.length, 1, 'cleanup has no retry loop');
});

test('legacy real forward cleanup also bounds its read-only listing phase', { timeout: 3000 }, async (t) => {
    const f = await adbPeer(t, () => {});
    const before = AdbUtils.FORWARD_CLEANUP_TIMEOUT_MS;
    AdbUtils.FORWARD_CLEANUP_TIMEOUT_MS = 40;
    t.after(() => { AdbUtils.FORWARD_CLEANUP_TIMEOUT_MS = before; });
    const pending = AdbUtils.removeFileSocketForwards('cleanup-phone').catch((error) => error);
    await waitFor(() => f.frames.length === 1, 'legacy cleanup reaches its listing');
    const owned = f.clients(); await pause(50); await f.closed(owned);
    assert.match((await pending).message, /forward timed out/);
    assert.equal(f.frames.length, 1, 'failed listing sends no removal');
});

function syncUploadPeer(frame, socket, result, acknowledge) {
    if (frame.startsWith('host:transport:')) { socket.write('OKAY'); return; }
    assert.equal(frame, 'sync:');
    socket.write('OKAY');
    let buffer = Buffer.alloc(0);
    socket.syncData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 8) {
            const kind = buffer.subarray(0, 4).toString(), size = buffer.readUInt32LE(4);
            if (kind === 'DONE') {
                buffer = buffer.subarray(8); result.done = true;
                if (acknowledge) socket.end(Buffer.concat([Buffer.from('OKAY'), Buffer.alloc(4)]));
                continue;
            }
            if (buffer.length < size + 8) return;
            const payload = buffer.subarray(8, size + 8); buffer = buffer.subarray(size + 8);
            if (kind === 'SEND') result.path = payload.toString();
            else { assert.equal(kind, 'DATA'); result.bytes += payload.length; }
        }
    };
}

test('real adbkit post-OKAY upload cancellation closes its TCP socket and file reader', { timeout: 3000 }, async (t) => {
    const result = { bytes: 0 }, f = await adbPeer(t, (frame, socket) => syncUploadPeer(frame, socket, result, false));
    const file = path.join(temporary, 'large-owned-upload'); fs.writeFileSync(file, ''); fs.truncateSync(file, 8 * 1024 * 1024);
    const source = fs.createReadStream(file, { highWaterMark: 1024 }), controller = new AbortController();
    const operation = AdbExtended.operation(f.client, controller.signal);
    t.after(() => { operation.close(); source.destroy(); });
    const transfer = await operation.client.push('handshake-phone', source, '/data/local/tmp/fixture');
    const errors = []; let cancelled = 0, ended = 0;
    transfer.on('error', (error) => errors.push(error));
    transfer.on('cancel', () => cancelled++);
    transfer.on('end', () => ended++);
    await waitFor(() => result.bytes > 0, 'real sync DATA has started');
    assert.equal(source.readableEnded, false, 'the file reader is still active when cancelled');
    const before = { dataBytes: result.bytes, readerEnded: source.readableEnded };
    const owned = f.clients();
    assert.equal(transfer.cancel(), true, 'the public cancel API keeps its boolean result');
    controller.abort(Error('Cancel active upload'));
    assert.equal(transfer.cancel(), true, 'a repeated owner cancellation is harmless');
    await f.closed(owned);
    await waitFor(() => source.destroyed && source.closed, 'the active file reader closes after cancellation');
    await waitFor(() => ended === 1, 'adbkit settles the cancelled transfer once');
    assert.equal(cancelled, 1); assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ proof: 'active-stream', ...before, readerDestroyed: source.destroyed, readerClosed: source.closed, clientHandles: f.clients().length, cancelEvents: cancelled, endEvents: ended, errors: errors.length }) + '\n');
});

function descriptorsFor(file) {
    const result = [];
    for (const fd of fs.readdirSync('/proc/self/fd')) {
        try {
            if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== file) continue;
            const info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
            result.push({ fd, position: Number(info.match(/^pos:\s*(\d+)/m)[1]) });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return result;
}

for (const action of ['abort', 'release']) test(`real AdbShell filepath upload closes its internally opened reader on ${action}`, { timeout: 3000, skip: process.platform !== 'linux' && 'File descriptor inspection uses Linux procfs' }, async (t) => {
    const result = { bytes: 0 }, f = await adbPeer(t, (frame, socket) => syncUploadPeer(frame, socket, result, false));
    const file = path.join(temporary, `internal-upload-${action}`), size = 64 * 1024 * 1024;
    fs.writeFileSync(file, ''); fs.truncateSync(file, size);
    const shell = new AdbShell('handshake-phone', f.client), controller = new AbortController();
    t.after(() => shell.release());
    const transfer = await shell.push(file, '/data/local/tmp/fixture', controller.signal);
    const errors = []; let cancelled = 0, ended = 0;
    transfer.on('error', (error) => errors.push(error));
    transfer.on('cancel', () => cancelled++); transfer.on('end', () => ended++);
    await waitFor(() => result.bytes > 0 && descriptorsFor(file).some(({ position }) => position < size), 'the production filepath reader is open and has not reached EOF');
    const descriptors = descriptorsFor(file), owned = f.clients();
    assert.ok(descriptors.length === 1 && descriptors[0].position < size, 'the actual internal file reader is still active');
    assert.ok(result.bytes > 0 && result.bytes < size);
    if (action === 'release') shell.release(); else controller.abort(Error('Cancel internal upload'));
    await f.closed(owned);
    await waitFor(() => descriptorsFor(file).length === 0, 'the internal file descriptor closes');
    await waitFor(() => ended === 1, 'the cancelled transfer settles once');
    assert.equal(cancelled, 1); assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ proof: 'active-filepath', action, size, descriptorPositionsBefore: descriptors.map(({ position }) => position), dataBytes: result.bytes, descriptorsAfter: descriptorsFor(file).length, clientHandles: f.clients().length, cancelEvents: cancelled, endEvents: ended, errors: errors.length }) + '\n');
});

test('real filepath upload preserves a file-open error and closes its sync socket', { timeout: 3000 }, async (t) => {
    const f = await adbPeer(t, (frame, socket) => syncUploadPeer(frame, socket, { bytes: 0 }, false));
    const shell = new AdbShell('handshake-phone', f.client); t.after(() => shell.release());
    const transfer = await shell.push(path.join(temporary, 'missing-upload'), '/data/local/tmp/fixture');
    const [error] = await once(transfer, 'error');
    assert.equal(error.code, 'ENOENT');
    await waitFor(() => f.clients().length === 0, 'failed upload closes its owned sync socket');
});

test('real scrcpy upload abort cancels the internal filepath transfer once and never launches', { timeout: 3000, skip: process.platform !== 'linux' && 'File descriptor inspection uses Linux procfs' }, async (t) => {
    const result = { bytes: 0 }, f = await adbPeer(t, (frame, socket) => syncUploadPeer(frame, socket, result, false));
    const file = path.join(temporary, 'scrcpy-internal-upload'), size = 64 * 1024 * 1024;
    fs.writeFileSync(file, ''); fs.truncateSync(file, size);
    const shell = new AdbShell('handshake-phone', f.client), controller = new AbortController();
    t.after(() => shell.release());
    let cancelled = 0, onceCancelled = 0, ended = 0, launched = 0;
    const order = [];
    const target = {
        udid: 'handshake-phone', TAG: '[handshake-scrcpy]', isConnected: () => true,
        push: async (_contents, destination, signal) => {
            const transfer = await shell.push(file, destination, signal);
            transfer.on('cancel', () => { cancelled++; order.push('on'); });
            transfer.once('cancel', () => { onceCancelled++; order.push('once'); });
            transfer.on('end', () => ended++);
            return transfer;
        },
        getLaunchStreamConfig: () => ({ audio: false }),
        launchServer: async () => { launched++; },
    };
    const running = ScrcpyServer.run(target, controller.signal).catch((error) => error);
    await waitFor(() => result.bytes > 0 && descriptorsFor(file).some(({ position }) => position < size), 'scrcpy upload is active before EOF');
    const descriptorPositionsBefore = descriptorsFor(file).map(({ position }) => position);
    const owned = f.clients(); controller.abort(Error('Cancel scrcpy upload'));
    await f.closed(owned);
    assert.ok((await running) instanceof Error);
    await waitFor(() => descriptorsFor(file).length === 0 && ended === 1, 'scrcpy upload releases the descriptor and settles once');
    assert.equal(cancelled, 1); assert.equal(onceCancelled, 1); assert.equal(launched, 0);
    assert.deepEqual(order, ['on', 'once'], 'other cancel listeners keep their registration order');
    process.stdout.write(JSON.stringify({ proof: 'scrcpy-filepath', size, descriptorPositionsBefore, dataBytes: result.bytes, descriptorsAfter: descriptorsFor(file).length, clientHandles: f.clients().length, cancelEvents: cancelled, onceCancelEvents: onceCancelled, endEvents: ended, lateLaunches: launched, order }) + '\n');
});

test('real adbkit post-OKAY upload and no-signal shell preserve sync framing and combined output', { timeout: 3000 }, async (t) => {
    const result = { bytes: 0 }, f = await adbPeer(t, (frame, socket) => {
        if (frame.startsWith('shell:')) socket.end('OKAYfixture stdout\nfixture stderr\n__rc=7\n');
        else syncUploadPeer(frame, socket, result, true);
    });
    const file = path.join(temporary, 'completed-owned-upload'); fs.writeFileSync(file, 'fixture jar');
    const shell = new AdbShell('handshake-phone', f.client); t.after(() => shell.release());
    const transfer = await shell.push(file, '/data/local/tmp/fixture');
    await once(transfer, 'end');
    assert.equal(result.bytes, 11); assert.equal(result.done, true);
    assert.match(result.path, /^\/data\/local\/tmp\/fixture,\d+$/);
    assert.deepEqual(await shell.exec('fixture'), { code: 7, output: 'fixture stdout\nfixture stderr' });
    await waitFor(() => f.clients().length === 0, 'successful shell/sync scopes release their sockets');
});
