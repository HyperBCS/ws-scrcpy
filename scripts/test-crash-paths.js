// Run with: node --test scripts/test-crash-paths.js
// Inputs that used to stop the whole server or lose data: an oversized WebSocket frame, shell
// output after the Shell tool closed, an unreadable notifications.json, and system push alerts
// that expired or were evicted. No device and no fixed port is used.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const webpush = require('web-push');
const WS = require('ws');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-crash-paths-'));
const previousEnv = Object.fromEntries(
    ['WS_NOTIFICATION_DATA', 'WS_NOTIFICATIONS_COLLECTOR', 'WS_PUBLIC_URL', 'WS_PUSH_SUBJECT'].map((key) => [
        key,
        process.env[key],
    ]),
);
process.env.WS_NOTIFICATION_DATA = path.join(temporary, 'unused');
process.env.WS_NOTIFICATIONS_COLLECTOR = '0';
process.env.WS_PUBLIC_URL = 'https://phone.example';
delete process.env.WS_PUSH_SUBJECT;
// Webpack defines this constant; HttpServer reads it when the module loads.
global.__PATHNAME__ = '/';

// The Shell tool spawns adb in a pty. The tests give it this one, which they drive by hand.
const terminals = [];
function fakeTerminal() {
    const listeners = { data: new Set(), exit: new Set() };
    const subscribe = (set) => (listener) => {
        set.add(listener);
        return { dispose: () => set.delete(listener) };
    };
    const terminal = {
        killed: 0,
        written: [],
        listeners,
        onData: subscribe(listeners.data),
        onExit: subscribe(listeners.exit),
        write: (data) => terminal.written.push(data),
        kill: () => terminal.killed++,
        emitData: (text) => listeners.data.forEach((listener) => listener(Buffer.from(text))),
    };
    terminals.push(terminal);
    return terminal;
}
require.cache[require.resolve('node-pty')] = {
    id: require.resolve('node-pty'),
    filename: require.resolve('node-pty'),
    loaded: true,
    exports: { spawn: fakeTerminal },
};

require('ts-node').register({ transpileOnly: true });
const { resetSettingsForTests } = require('../src/server/Settings');
// Webpack treats these imports as assets. Node only needs the surrounding server classes.
require.extensions['.jar'] = () => {};
require.cache[require.resolve('../vendor/Genymobile/scrcpy/LICENSE')] = { exports: {} };

const { WebSocketServer } = require('../src/server/services/WebSocketServer');
const { WebsocketMultiplexer } = require('../src/server/mw/WebsocketMultiplexer');
const { Mw } = require('../src/server/mw/Mw');
const { RemoteShell } = require('../src/server/goog-device/mw/RemoteShell');
const { Multiplexer } = require('../src/packages/multiplexer/Multiplexer');
const { Message } = require('../src/packages/multiplexer/Message');
const { MessageType } = require('../src/packages/multiplexer/MessageType');
const { NotificationService } = require('../src/server/notifications/NotificationService');
const { NotificationStorage } = require('../src/server/notifications/NotificationStorage');
const { PushDelivery } = require('../src/server/notifications/PushDelivery');
const { CLIPBOARD_MAX_BYTES, clipboardTextTooLong } = require('../src/app/ui/clipboardLimit');

const originalSend = webpush.sendNotification;
const MAX_PAYLOAD = 4 * 1024 * 1024;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, label, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for: ${label}`);
        await pause(5);
    }
}

// ------------------------------------------------------------------ WebSocket server

// The defects here threw from socket events and timers, where nothing can catch. The runner
// reports such a throw against whichever test created the server, so record them and let each
// test check for its own.
const uncaught = [];
process.on('uncaughtException', (error) => uncaught.push(error));
function takeUncaught() {
    return uncaught.splice(0).map((error) => error.message);
}

// Answers every text message on `?action=echo`, and holds any channel opened with code TEST.
const heldChannels = [];
class Echo extends Mw {
    static processRequest(ws, params) {
        return params.action === 'echo' ? new Echo(ws) : undefined;
    }
    static processChannel(channel, code) {
        if (code !== 'TEST') return undefined;
        heldChannels.push(channel);
        return new Echo(channel);
    }
    constructor(ws) {
        super(ws);
    }
    onSocketMessage(event) {
        this.ws.send(`echo:${event.data}`);
    }
}

let listening;
async function serverPort() {
    if (!listening) {
        const server = http.createServer();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const service = WebSocketServer.getInstance();
        service.registerMw(Echo);
        service.registerMw(WebsocketMultiplexer);
        WebsocketMultiplexer.registerMw(Echo);
        WebsocketMultiplexer.registerMw(RemoteShell);
        service.attachToServer({ server, port: server.address().port });
        listening = { server, service };
    }
    return listening.server.address().port;
}
async function connect(action) {
    const socket = new WS(`ws://127.0.0.1:${await serverPort()}/?action=${action}`);
    socket.on('error', () => undefined);
    await once(socket, 'open');
    return socket;
}
async function assertStillServing() {
    assert.deepEqual(takeUncaught(), [], 'nothing was thrown where the server cannot catch it');
    const socket = await connect('echo');
    socket.send('ping');
    const [reply] = await once(socket, 'message');
    assert.equal(reply.toString(), 'echo:ping', 'a new connection is served after the bad one');
    socket.close();
    await once(socket, 'close');
}

after(async () => {
    webpush.sendNotification = originalSend;
    if (listening) {
        listening.service.release();
        listening.server.closeAllConnections();
        await new Promise((resolve) => listening.server.close(resolve));
    }
    for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
});

test('a frame over the size limit closes its own socket and the server keeps serving', async (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const socket = await connect('echo');
    takeUncaught();
    socket.send(Buffer.alloc(MAX_PAYLOAD + 1));
    const [code] = await once(socket, 'close');
    assert.equal(code, 1009, 'the oversized frame is refused with "message too big"');
    assert.ok(
        logged.mock.calls.some((call) => /Socket error: Max payload size exceeded/.test(String(call.arguments[0]))),
        'the error is logged',
    );
    await assertStillServing();
});

test('a frame over the size limit on a multiplexed socket with an open channel does not stop the server', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const socket = await connect('multiplex');
    takeUncaught();
    const before = heldChannels.length;
    socket.send(Message.createBuffer(MessageType.CreateChannel, 1, Buffer.from('TEST')));
    await waitFor(() => heldChannels.length === before + 1, 'the server opens the channel');
    const channel = heldChannels.at(-1);
    let closed = false;
    channel.addEventListener('close', () => (closed = true));
    socket.send(Buffer.alloc(MAX_PAYLOAD + 1));
    const [code] = await once(socket, 'close');
    assert.equal(code, 1009);
    await waitFor(() => closed, 'the channel closes with its socket');
    await assertStillServing();
});

test('the multiplexer drops an error event that has no listener', (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const listeners = new Map();
    const socket = {
        readyState: 1,
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: (type) => listeners.delete(type),
        send: () => undefined,
        close: () => undefined,
    };
    const multiplexer = Multiplexer.wrap(socket);
    assert.doesNotThrow(() => listeners.get('error')({ type: 'error', error: Error('Invalid WebSocket frame') }));
    assert.match(String(logged.mock.calls.at(-1).arguments[0]), /Socket error: Invalid WebSocket frame/);
    // A message type the protocol does not define is reported the same way.
    assert.doesNotThrow(() => listeners.get('message')({ type: 'message', data: Message.createBuffer(99, 0).buffer }));
    assert.match(String(logged.mock.calls.at(-1).arguments[0]), /Unsupported message type: 99/);
    // A listener still receives the event.
    const seen = [];
    multiplexer.addEventListener('error', (event) => seen.push(event.error.message));
    listeners.get('error')({ type: 'error', error: Error('second') });
    assert.deepEqual(seen, ['second']);
});

test('clipboard text is capped below the frame limit in both clients', () => {
    assert.ok(CLIPBOARD_MAX_BYTES * 6 + 1024 < MAX_PAYLOAD, 'fits even when JSON escapes every character');
    assert.equal(clipboardTextTooLong(''), false);
    assert.equal(clipboardTextTooLong('a'.repeat(CLIPBOARD_MAX_BYTES)), false);
    assert.equal(clipboardTextTooLong('a'.repeat(CLIPBOARD_MAX_BYTES + 1)), true);
    assert.equal(clipboardTextTooLong('a'.repeat(5 * 1024 * 1024)), true);
    // The limit counts UTF-8 bytes: three per character here.
    const wide = Math.floor(CLIPBOARD_MAX_BYTES / 3);
    assert.equal(clipboardTextTooLong('€'.repeat(wide)), false);
    assert.equal(clipboardTextTooLong('€'.repeat(wide + 1)), true);
});

// ------------------------------------------------------------------ Shell tool

async function openShell() {
    const socket = await connect('multiplex');
    takeUncaught();
    const received = [];
    socket.on('message', (data) => received.push(Message.parse(new Uint8Array(data).buffer)));
    const before = terminals.length;
    socket.send(Message.createBuffer(MessageType.CreateChannel, 7, Buffer.from('SHEL')));
    const start = JSON.stringify({
        id: 1,
        type: 'shell',
        data: { type: 'start', udid: 'fixture', rows: 24, cols: 80 },
    });
    socket.send(Message.createBuffer(MessageType.RawStringData, 7, Buffer.from(start)));
    await waitFor(() => terminals.length === before + 1, 'the shell starts its terminal');
    const output = () =>
        received
            .filter((message) => message.type === MessageType.RawBinaryData)
            .map((message) => Buffer.from(message.data).toString())
            .join('');
    return { socket, terminal: terminals.at(-1), output, received };
}

test('shell output that arrives after the tool closed is dropped', async () => {
    const { socket, terminal, output } = await openShell();
    terminal.emitData('first');
    await waitFor(() => output() === 'first', 'output reaches the browser');
    // The flush timer is idle now. Close the channel the way the Shell tool does.
    socket.send(Message.fromCloseEvent(7, 1000, 'closed').toBuffer());
    await waitFor(() => terminal.killed === 1, 'closing the tool stops adb');
    // adb writes once more before the signal reaches it. A throw from the flush timer would
    // be an uncaught exception, which stops a real server.
    const lateListeners = [...terminal.listeners.data];
    terminal.emitData('late');
    await pause(40);
    assert.equal(output(), 'first');
    await assertStillServing();
    assert.deepEqual(lateListeners, [], 'the output listener is removed');
    assert.equal(terminal.listeners.exit.size, 0, 'the exit listener is removed');
    socket.close();
});

test('shell output that is waiting to be sent when the connection drops is dropped', async () => {
    const { socket, terminal, output } = await openShell();
    terminal.emitData('pending');
    socket.terminate();
    await waitFor(() => terminal.killed === 1, 'losing the socket stops adb');
    terminal.emitData('late');
    await pause(40);
    assert.equal(output(), '');
    await assertStillServing();
});

test('a shell that exits by itself still delivers its last output before closing the channel', async () => {
    const { socket, terminal, output, received } = await openShell();
    terminal.emitData('bye');
    terminal.listeners.exit.forEach((listener) => listener({ exitCode: 0 }));
    await waitFor(() => received.some((message) => message.type === MessageType.CloseChannel), 'the channel closes');
    assert.equal(output(), 'bye');
    assert.equal(received.find((message) => message.type === MessageType.CloseChannel).toCloseEvent().code, 1000);
    socket.close();
});

// ------------------------------------------------------------------ notification settings

async function mounted(directory) {
    process.env.WS_NOTIFICATION_DATA = directory;
    resetSettingsForTests();
    const service = new NotificationService();
    const app = express();
    service.mount(app, '/');
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/notifications`;
    const api = (url, body) =>
        fetch(base + url, {
            method: body ? 'POST' : 'GET',
            headers: { 'content-type': 'application/json' },
            body: body && JSON.stringify(body),
        });
    const close = async () => {
        service.release();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    };
    return { service, api, close };
}
const source = { id: 'iphone', address: 'AA:BB:CC:DD:EE:FF', name: 'iPhone', apps: [], preview: true };
const subscription = (name) => ({
    endpoint: `https://web.push.apple.com/${name}`,
    keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') },
});

for (const [label, content] of [
    ['truncated', '{"vapid":'],
    ['empty', ''],
    ['of the wrong shape', '[]'],
    ['damaged inside', '{"sources":[null],"subscriptions":[]}'],
]) {
    test(`a notifications.json that is ${label} turns notifications off and leaves the server running`, async (t) => {
        t.mock.method(console, 'error', () => undefined);
        const directory = fs.mkdtempSync(path.join(temporary, 'settings-'));
        fs.writeFileSync(path.join(directory, 'notifications.json'), content);
        fs.writeFileSync(path.join(directory, 'notification-history.json'), '{"version":1,"items":[]}');
        const { service, api, close } = await mounted(directory);
        try {
            await service.start();
            const kept = fs.readdirSync(directory).filter((name) => name.startsWith('notifications.json.corrupt-'));
            assert.equal(kept.length, 1, 'the damaged file is kept under a new name');
            assert.equal(fs.readFileSync(path.join(directory, kept[0]), 'utf8'), content);
            const status = await (await api('/status')).json();
            assert.match(status.error, /^Notifications are off: notifications\.json is damaged and was kept as /);
            assert.ok(status.error.includes(kept[0]), 'the Setup page names the kept file');
            assert.equal(status.publicKey, '', 'no new push keys are made up');
            assert.deepEqual(status.sources, []);
            const refused = await api('/sources', source);
            assert.equal(refused.status, 503);
            assert.equal((await refused.json()).error, status.error);
            assert.equal((await api('/subscriptions', { subscription: subscription('x'), sources: [] })).status, 503);
            assert.doesNotThrow(() => service.notifySystem({ title: 'a', body: 'b', tag: 'c', url: '#!' }));
            service.release();
            assert.deepEqual(
                fs.readdirSync(directory).sort(),
                [kept[0], 'notification-history.json'].sort(),
                'nothing is written while notifications are off',
            );
        } finally {
            await close();
        }
        // The next start finds no settings file and begins again, as a first run does.
        const next = await mounted(directory);
        try {
            const status = await (await next.api('/status')).json();
            assert.equal(status.error, '');
            assert.ok(status.publicKey.length > 20);
            assert.equal((await next.api('/sources', source)).status, 200);
        } finally {
            await next.close();
        }
    });
}

test('a settings file that cannot be saved turns notifications off instead of failing startup', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const directory = fs.mkdtempSync(path.join(temporary, 'settings-'));
    // A first run on a read-only data directory: the new keys cannot be stored.
    t.mock.method(NotificationStorage.prototype, 'save', () => {
        throw Object.assign(Error('EROFS: read-only file system'), { code: 'EROFS' });
    });
    const { service, api, close } = await mounted(directory);
    try {
        await service.start();
        const status = await (await api('/status')).json();
        assert.match(status.error, /^Notifications are off: the notification settings could not be loaded or saved/);
        assert.equal((await api('/sources', source)).status, 503);
    } finally {
        await close();
    }
});

test('valid settings load unchanged and every save reaches the disk before and after the rename', async (t) => {
    const directory = fs.mkdtempSync(path.join(temporary, 'settings-'));
    const first = await mounted(directory);
    let publicKey;
    try {
        publicKey = (await (await first.api('/status')).json()).publicKey;
        const steps = [];
        const { fsyncSync, renameSync } = fs;
        const fsync = t.mock.method(fs, 'fsyncSync', (descriptor) => {
            steps.push(fs.fstatSync(descriptor).isDirectory() ? 'sync directory' : 'sync file');
            return fsyncSync(descriptor);
        });
        const rename = t.mock.method(fs, 'renameSync', (...paths) => {
            steps.push('rename');
            return renameSync(...paths);
        });
        assert.equal((await first.api('/sources', source)).status, 200);
        fsync.mock.restore();
        rename.mock.restore();
        // Adding a phone saves the settings and the history, each in the same three steps.
        const save = ['sync file', 'rename', 'sync directory'];
        assert.deepEqual(steps, [...save, ...save]);
    } finally {
        await first.close();
    }
    assert.deepEqual(
        fs.readdirSync(directory).filter((name) => name.includes('corrupt') || name.endsWith('.tmp')),
        [],
    );
    const second = await mounted(directory);
    try {
        const status = await (await second.api('/status')).json();
        assert.equal(status.error, '');
        assert.equal(status.publicKey, publicKey, 'the push keys survive a restart');
        assert.deepEqual(status.sources, [source]);
    } finally {
        await second.close();
    }
});

// ------------------------------------------------------------------ system push alerts

test('a system alert is held for a day at high urgency and a relayed alert keeps the short lifetime', async () => {
    const directory = fs.mkdtempSync(path.join(temporary, 'settings-'));
    const { service, api, close } = await mounted(directory);
    const sent = [];
    webpush.sendNotification = async (_subscription, payload, options) => {
        sent.push({ payload: JSON.parse(payload), options });
    };
    try {
        await service.start();
        assert.equal((await api('/sources', source)).status, 200);
        const body = { subscription: subscription('alerts'), sources: ['iphone'], receiverSource: '' };
        assert.equal((await api('/subscriptions', body)).status, 200);
        service.notifySystem({ title: 'iPhone unlock', body: 'Phone not reachable', tag: 'ios-unlock-x', url: '#!' });
        await waitFor(() => sent.length === 1, 'the system alert is sent');
        assert.equal(sent[0].options.urgency, 'high');
        assert.ok(sent[0].options.TTL > 86300 && sent[0].options.TTL <= 86400, `TTL ${sent[0].options.TTL}`);
        service.receive({
            source: 'iphone',
            session: 'a',
            uid: 1,
            event: 'added',
            app: 'com.example',
            appName: 'Example',
            title: 'Title',
            body: 'Body',
            date: '20261110T120000',
        });
        await waitFor(() => sent.length === 2, 'the relayed alert is sent');
        assert.equal(sent[1].options.urgency, 'normal');
        assert.ok(sent[1].options.TTL > 290 && sent[1].options.TTL <= 300, `TTL ${sent[1].options.TTL}`);
    } finally {
        webpush.sendNotification = originalSend;
        await close();
    }
});

test('a burst of relayed alerts does not push a queued system alert out', async () => {
    const sent = [];
    let release;
    const blocked = new Promise((resolve) => (release = resolve));
    webpush.sendNotification = async (_subscription, payload) => {
        sent.push(payload);
        await blocked;
    };
    const delivery = new PushDelivery(
        (_id, key) => ({
            subscription: subscription('queue'),
            payload: key,
            vapid: { publicKey: 'public', privateKey: 'private' },
        }),
        () => undefined,
    );
    try {
        // The first job is taken off the queue at once and waits in the push service call.
        delivery.enqueue('sub', 'relay-first');
        delivery.enqueue('sub', 'system-1', '{}', 'system');
        for (let index = 0; index < 60; index++) delivery.enqueue('sub', `relay-${index}`);
        release();
        await waitFor(() => delivery.pending === 0, 'the queue drains');
        assert.ok(sent.includes('system-1'), 'the system alert is delivered');
        assert.equal(sent.length, 52, 'one in flight, the system alert, and the newest 50 relayed alerts');
        assert.ok(!sent.includes('relay-9') && sent.includes('relay-10'), 'the oldest relayed alerts make room');
        // System alerts are bounded too, among themselves.
        const held = [];
        let releaseSecond;
        const blockedSecond = new Promise((resolve) => (releaseSecond = resolve));
        webpush.sendNotification = async (_subscription, payload) => {
            held.push(payload);
            await blockedSecond;
        };
        delivery.enqueue('sub', 'relay-first');
        for (let index = 0; index < 55; index++) delivery.enqueue('sub', `system-${index}`, '{}', 'system');
        releaseSecond();
        await waitFor(() => delivery.pending === 0, 'the second queue drains');
        assert.equal(held.length, 51);
        assert.ok(!held.includes('system-4') && held.includes('system-5'));
    } finally {
        delivery.stop();
        webpush.sendNotification = originalSend;
    }
});

// ------------------------------------------------------------------ shutdown order

// Shutdown releases the services in reverse start order. The iPhone tracker holds listeners on
// the session runner and releases the state monitor, so it has to stop before the runner does.
// index.ts starts the server when it is loaded, so its service list is read as text.
test('index.ts starts the iPhone session runner before the tracker and tells it when the server is stopping', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'index.ts'), 'utf8');
    const appl = source.slice(source.indexOf('async function loadApplModules'));
    const runner = appl.indexOf('servicesToStart.push(CoreDeviceRunner)');
    const tracker = appl.indexOf('servicesToStart.push(ControlCenter)');
    assert.ok(runner >= 0 && tracker >= 0, 'both services are in the list');
    assert.ok(runner < tracker, 'the runner starts first, so it stops after the tracker');
    assert.match(appl, /CoreDeviceRunner\.setShutdownCheck\(\(\) => shutdown\.isStopping\(\)\)/);
});

test('once the server is stopping the iPhone session runner runs no command for a new session', async (t) => {
    const { PyMobileDevice } = require('../src/server/appl-device/services/PyMobileDevice');
    const { CoreDeviceRunner } = require('../src/server/appl-device/services/CoreDeviceRunner');
    // Nothing here may reach a phone, whatever the runner does.
    const commands = [
        t.mock.method(PyMobileDevice, 'helperProblem', async () => undefined),
        t.mock.method(PyMobileDevice, 'runOneShot', async () => ({ code: 1, stdout: '', stderr: 'not run in a test' })),
        t.mock.method(PyMobileDevice, 'spawnDetached', () => {
            throw new Error('not run in a test');
        }),
    ];
    const previousPort = process.env.IOS_SERVE_WEB_BASE_PORT;
    process.env.IOS_SERVE_WEB_BASE_PORT = '18600';
    resetSettingsForTests();
    let stopping = false;
    CoreDeviceRunner.setShutdownCheck(() => stopping);
    try {
        const runner = CoreDeviceRunner.getInstance();
        stopping = true;
        runner.release();
        runner.release();
        assert.equal(CoreDeviceRunner.hasInstance(), false);
        // A caller that still asks for the singleton gets a new runner, and a refusal from it.
        const late = CoreDeviceRunner.getInstance();
        await assert.rejects(late.acquire('iphone-a'), /Server is shutting down/);
        assert.equal(late.getStatus('iphone-a').state, 'stopped', 'no session was created');
        assert.equal(
            commands.reduce((count, command) => count + command.mock.callCount(), 0),
            0,
            'nothing was checked, mounted or spawned',
        );
        assert.equal(CoreDeviceRunner.hasChildren(), false);
        late.release();
        // A second release of the first runner leaves a newer one alone.
        const next = CoreDeviceRunner.getInstance();
        runner.release();
        assert.equal(CoreDeviceRunner.getInstance(), next);
        next.release();
    } finally {
        CoreDeviceRunner.setShutdownCheck(undefined);
        if (CoreDeviceRunner.hasInstance()) CoreDeviceRunner.getInstance().release();
        if (previousPort === undefined) delete process.env.IOS_SERVE_WEB_BASE_PORT;
        else process.env.IOS_SERVE_WEB_BASE_PORT = previousPort;
        resetSettingsForTests();
    }
});
