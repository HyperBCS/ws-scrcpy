// Run with: node --test scripts/test-shell.js
// The Shell tool: what the server accepts from the browser. adb and its pty are replaced by a
// fake, and the socket is an object the tests drive by hand. No device and no port is used.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const terminals = [];
function spawn(file, args, options) {
    const terminal = {
        file,
        args,
        options,
        written: [],
        resized: [],
        killed: 0,
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
        write: (data) => terminal.written.push(data),
        resize: (cols, rows) => terminal.resized.push([cols, rows]),
        kill: () => terminal.killed++,
    };
    terminals.push(terminal);
    return terminal;
}
require.cache[require.resolve('node-pty')] = {
    id: require.resolve('node-pty'),
    filename: require.resolve('node-pty'),
    loaded: true,
    exports: { spawn },
};
require('ts-node').register({ transpileOnly: true });

const { RemoteShell, parseShellMessage } = require('../src/server/goog-device/mw/RemoteShell');

function fakeSocket() {
    const listeners = {};
    const socket = {
        OPEN: 1,
        CLOSING: 2,
        CLOSED: 3,
        readyState: 1,
        sent: [],
        closed: undefined,
        addEventListener: (type, listener) => (listeners[type] = listener),
        send: (data) => socket.sent.push(data),
        close: (code, reason) => {
            if (socket.readyState === socket.CLOSED) return;
            socket.readyState = socket.CLOSED;
            socket.closed = { code, reason };
            listeners.close?.({ code, reason });
        },
        message: (data) => listeners.message({ type: 'message', data }),
    };
    return socket;
}
const shellMessage = (data) => JSON.stringify({ id: 1, type: 'shell', data });
const start = (extra = {}) => shellMessage({ type: 'start', udid: 'fixture', cols: 80, rows: 24, ...extra });

function openShell() {
    const socket = fakeSocket();
    new RemoteShell(socket);
    const before = terminals.length;
    socket.message(start());
    assert.equal(terminals.length, before + 1, 'a valid start message starts the terminal');
    return { socket, terminal: terminals.at(-1) };
}

test('a start message runs adb for that device at the requested size', () => {
    const { terminal } = openShell();
    assert.equal(terminal.file, 'adb');
    assert.deepEqual(terminal.args, ['-s', 'fixture', 'shell']);
    assert.equal(terminal.options.cols, 80);
    assert.equal(terminal.options.rows, 24);
});

test('a start message cannot set the working directory or environment of adb', (t) => {
    t.mock.method(console, 'error', () => undefined);
    const socket = fakeSocket();
    new RemoteShell(socket);
    socket.message(start({ cwd: '/tmp/planted', env: { LD_PRELOAD: '/tmp/planted.so', PATH: '/tmp' }, pid: 1 }));
    const { options } = terminals.at(-1);
    assert.notEqual(options.cwd, '/tmp/planted');
    assert.equal(options.env.LD_PRELOAD, process.env.LD_PRELOAD);
    assert.equal(options.env.PATH, process.env.PATH);
    assert.deepEqual(
        parseShellMessage(JSON.parse(start({ cwd: '/tmp/planted', env: { PATH: '/tmp' }, pid: 1 }))),
        { type: 'start', udid: 'fixture', cols: 80, rows: 24 },
        'only the known fields are kept',
    );
});

test('a start message with a bad device or size is refused and nothing is started', (t) => {
    t.mock.method(console, 'error', () => undefined);
    const bad = [
        ['a numeric udid', start({ udid: 7 })],
        ['an empty udid', start({ udid: '' })],
        ['a missing udid', shellMessage({ type: 'start', cols: 80, rows: 24 })],
        ['zero columns', start({ cols: 0 })],
        ['too many columns', start({ cols: 501 })],
        ['too many rows', start({ rows: 501 })],
        ['a fractional row count', start({ rows: 24.5 })],
        ['a string size', start({ cols: '80' })],
        ['a missing size', shellMessage({ type: 'start', udid: 'fixture' })],
        ['an unknown action', shellMessage({ type: 'spawn', udid: 'fixture', cols: 80, rows: 24 })],
        ['another message type', JSON.stringify({ id: 1, type: 'other', data: { type: 'start' } })],
        ['no data', JSON.stringify({ id: 1, type: 'shell' })],
        ['text that is not JSON', 'ls -la'],
        ['a JSON value that is not an object', 'null'],
    ];
    for (const [label, message] of bad) {
        const socket = fakeSocket();
        new RemoteShell(socket);
        const before = terminals.length;
        socket.message(message);
        assert.equal(terminals.length, before, `${label} starts nothing`);
        assert.equal(socket.closed?.code, 4001, `${label} closes the channel`);
    }
});

test('the largest allowed size is accepted', () => {
    const socket = fakeSocket();
    new RemoteShell(socket);
    socket.message(start({ cols: 500, rows: 500 }));
    assert.equal(terminals.at(-1).options.cols, 500);
    assert.equal(socket.closed, undefined);
});

test('a stop message before start closes the channel without starting anything', () => {
    const socket = fakeSocket();
    new RemoteShell(socket);
    const before = terminals.length;
    socket.message(shellMessage({ type: 'stop' }));
    assert.equal(terminals.length, before);
    assert.equal(socket.readyState, socket.CLOSED);
});

test('text after start is typed into the shell unchanged', () => {
    const { socket, terminal } = openShell();
    socket.message('ls\r');
    assert.deepEqual(terminal.written, ['ls\r']);
});
