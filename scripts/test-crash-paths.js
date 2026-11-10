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
