// Run with: node --test scripts/test-shell.js
// The Shell tool: what the server accepts from the browser, and how the toolbar Ctrl key changes
// typed input. adb and its pty are replaced by a fake, and the socket is an object the tests
// drive by hand. No device and no port is used.
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

const resize = (cols, rows) => shellMessage({ type: 'resize', cols, rows });
const binary = (text) => new Uint8Array(Buffer.from(text)).buffer;

test('a resize message in a binary frame resizes the pty', () => {
    const { socket, terminal } = openShell();
    socket.message(binary(resize(120, 40)));
    // A multiplexed channel delivers an ArrayBuffer and a plain socket a Buffer.
    socket.message(Buffer.from(resize(64, 18)));
    assert.deepEqual(terminal.resized, [
        [120, 40],
        [64, 18],
    ]);
    assert.deepEqual(terminal.written, [], 'a message is never typed into the shell');
});

test('typed text that looks like a resize message is still input', () => {
    const { socket, terminal } = openShell();
    socket.message(resize(120, 40));
    assert.deepEqual(terminal.resized, []);
    assert.deepEqual(terminal.written, [resize(120, 40)]);
});

test('a resize outside the allowed range, or a malformed binary frame, is ignored', () => {
    const { socket, terminal } = openShell();
    for (const message of [resize(0, 24), resize(80, 501), resize(80.5, 24), resize('80', 24), 'not json', '{}']) {
        socket.message(binary(message));
    }
    socket.message(binary(shellMessage({ type: 'start', udid: 'other', cols: 80, rows: 24 })));
    assert.deepEqual(terminal.resized, []);
    assert.deepEqual(terminal.written, []);
    assert.equal(socket.closed, undefined, 'the session stays open');
});

test('a resize that the pty refuses does not throw out of the socket handler', (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const { socket, terminal } = openShell();
    terminal.resize = () => {
        throw Error('ioctl(2) failed, EBADF');
    };
    socket.message(binary(resize(100, 30)));
    assert.equal(logged.mock.callCount(), 1);
    assert.equal(socket.closed, undefined);
});

test('a stop message in a binary frame ends the session', () => {
    const { socket, terminal } = openShell();
    socket.message(binary(shellMessage({ type: 'stop' })));
    assert.equal(terminal.killed, 1);
    assert.equal(socket.readyState, socket.CLOSED);
});

// ------------------------------------------------------------------ toolbar Ctrl key

const { applyControl, withControl } = require('../src/app/googDevice/client/shellInput');

test('Ctrl changes the next single character and is then released', () => {
    assert.deepEqual(applyControl('c', true), { data: '\x03', armed: false });
    assert.deepEqual(applyControl('D', true), { data: '\x04', armed: false });
    assert.deepEqual(applyControl('[', true), { data: '\x1b', armed: false });
    assert.deepEqual(applyControl('1', true), { data: '1', armed: false }, 'a key without a control code still uses it');
    // Typing "ls" and Enter after a forgotten Ctrl used to send ^L ^S: clear screen, then freeze.
    let armed = true;
    const sent = ['l', 's', '\r'].map((key) => {
        const next = applyControl(key, armed);
        armed = next.armed;
        return next.data;
    });
    assert.deepEqual(sent, ['\x0c', 's', '\r']);
});

test('Ctrl never rewrites an escape sequence or pasted text', () => {
    assert.deepEqual(applyControl('\x1b[A', true), { data: '\x1b[A', armed: true }, 'a hardware Up arrow');
    assert.deepEqual(applyControl('rm -rf [a]', true), { data: 'rm -rf [a]', armed: true }, 'a paste');
    assert.deepEqual(applyControl('', true), { data: '', armed: true });
});

test('input is untouched while Ctrl is off', () => {
    assert.deepEqual(applyControl('c', false), { data: 'c', armed: false });
    assert.deepEqual(applyControl('\x1b[A', false), { data: '\x1b[A', armed: false });
});

test('letters and the punctuation with a control code map as a Ctrl key would', () => {
    assert.equal(withControl('a'), '\x01');
    assert.equal(withControl('z'), '\x1a');
    assert.equal(withControl('@'), '\x00');
    assert.equal(withControl('\\'), '\x1c');
    assert.equal(withControl('?'), '\x7f');
    assert.equal(withControl('é'), 'é');
});
