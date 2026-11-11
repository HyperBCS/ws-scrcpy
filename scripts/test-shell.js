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

// ------------------------------------------------------------------ client side

const { applyControl, withControl, terminalSize, MAX_TERMINAL_SIZE } = require('../src/app/googDevice/client/shellInput');

test('the browser never reports a size the server refuses', () => {
    assert.deepEqual(terminalSize(80, 24), { cols: 80, rows: 24 });
    // A tall or zoomed-out window can fit more rows than the server accepts. A refused start
    // message would leave the owner with a shell that never opens.
    assert.deepEqual(terminalSize(714, 650), { cols: MAX_TERMINAL_SIZE, rows: MAX_TERMINAL_SIZE });
    assert.deepEqual(terminalSize(0, NaN), { cols: 1, rows: 1 });
    for (const size of [terminalSize(9999, 9999), terminalSize(0, 0)]) {
        assert.ok(parseShellMessage(JSON.parse(start(size))), `${size.cols}x${size.rows} starts a shell`);
        assert.ok(parseShellMessage(JSON.parse(resize(size.cols, size.rows))), `${size.cols}x${size.rows} resizes it`);
    }
});

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

// ------------------------------------------------------------------ the terminal while its tab is hidden
//
// The phone's page keeps Shell mounted while it shows another tab and tells it with setActive.
// xterm, the page and the socket are stand-ins that record what is done to them.

/** Opens a terminal 800 px wide on a desktop (`fine`) or on a phone. Ten pixels are one column. */
function openTerminal(t, fine = true) {
    const made = {};
    class Terminal {
        constructor(options) {
            Object.assign(this, { options: { ...options }, cols: 80, rows: 24, written: [], focused: 0, blurred: 0 });
            made.term = this;
        }
        loadAddon(addon) {
            addon.term = this;
        }
        open() {}
        onData() {}
        onBinary() {}
        onResize(listener) {
            this.resized = listener;
        }
        focus() {
            this.focused++;
        }
        blur() {
            this.blurred++;
        }
        write(data) {
            this.written.push(data);
        }
        dispose() {}
    }
    class FitAddon {
        constructor() {
            this.fits = 0;
            made.fit = this;
        }
        fit() {
            this.fits++;
            const cols = Math.floor(made.container.clientWidth / 10);
            if (cols !== this.term.cols) {
                this.term.cols = cols;
                this.term.resized();
            }
        }
    }
    const stub = (name, exports) => {
        const id = require.resolve(name);
        const before = require.cache[id];
        require.cache[id] = { id, filename: id, loaded: true, exports };
        t.after(() => (before ? (require.cache[id] = before) : delete require.cache[id]));
    };
    stub('@xterm/xterm', { Terminal });
    stub('@xterm/addon-fit', { FitAddon });
    require.extensions['.css'] = () => {};
    const timers = new Map();
    const globals = {
        window: {
            matchMedia: () => ({ matches: fine }),
            setTimeout: (run) => timers.set(timers.size + 1, run).size,
            clearTimeout: (id) => timers.delete(id),
        },
        document: {
            createElement: () => (made.container = { clientWidth: 800, clientHeight: 400, remove: () => undefined }),
        },
        location: new URL('http://phones.test:8000/'),
        ResizeObserver: class {
            constructor(listener) {
                made.observed = listener;
            }
            observe() {}
            disconnect() {}
        },
    };
    const before = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(global, key)]));
    Object.entries(globals).forEach(([key, value]) => Object.defineProperty(global, key, { value, configurable: true, writable: true }));
    const socket = { OPEN: 1, readyState: 1, sent: [], closed: 0, send: (data) => socket.sent.push(data), close: () => socket.closed++ };
    const { ManagerClient } = require('../src/app/client/ManagerClient');
    const { ShellClient } = require('../src/app/googDevice/client/ShellClient');
    t.mock.method(ManagerClient.prototype, 'openNewConnection', function () {
        this.ws = socket;
        return socket;
    });
    const client = ShellClient.start({ action: 'shell', udid: 'fixture' }, { appendChild: () => undefined });
    client.onSocketOpen();
    t.after(() => {
        client.stop();
        delete require.cache[require.resolve('../src/app/googDevice/client/ShellClient')];
        Object.entries(before).forEach(([key, descriptor]) =>
            descriptor ? Object.defineProperty(global, key, descriptor) : delete global[key],
        );
    });
    /** Runs the timers that are due and returns the messages sent as binary frames. */
    const sizesSent = () => {
        [...timers.values()].forEach((run) => run());
        timers.clear();
        return socket.sent.filter((data) => typeof data !== 'string').map((data) => JSON.parse(Buffer.from(data)).data);
    };
    return { client, socket, timers, sizesSent, ...made };
}

test('a hidden Shell keeps its session, takes no focus and is not fitted until it is shown again', (t) => {
    const { client, socket, term, fit, container, observed, timers, sizesSent } = openTerminal(t);
    assert.deepEqual(JSON.parse(socket.sent[0]).data, { type: 'start', rows: 24, cols: 80, udid: 'fixture' });
    assert.equal(term.focused, 1, 'a desktop focuses the terminal on open');
    const fits = fit.fits;

    // A resize is waiting to be sent when the tab is left: it is dropped with the tab.
    term.resized();
    assert.equal(timers.size, 1);
    client.setActive(false);
    assert.equal(timers.size, 0, 'no size is sent from a hidden terminal');
    assert.equal(term.blurred, 1, 'the terminal gives up the keyboard');

    // The page hides the terminal and the window changes size meanwhile.
    container.clientWidth = 600;
    observed();
    client.focus();
    assert.equal(fit.fits, fits, 'not fitted while hidden');
    assert.equal(term.focused, 1, 'no focus while hidden');
    client.onSocketMessage({ data: 'still running\r\n' });
    assert.deepEqual(term.written, ['still running\r\n'], 'output is still written');
    assert.equal(socket.closed, 0, 'the session stays open');
    assert.equal(client.hasConnection(), true);
    assert.equal(client.sessionEnded(), false);
    assert.deepEqual(sizesSent(), []);

    client.setActive(true);
    assert.equal(fit.fits, fits + 1, 'fitted to the size it has now');
    assert.equal(term.focused, 2, 'and focused as on open');
    assert.deepEqual(sizesSent(), [{ type: 'resize', cols: 60, rows: 24 }], 'the phone is told the new size');
    assert.equal(socket.sent.filter((data) => typeof data === 'string').length, 1, 'in the same session: no second start');
    client.setActive(true);
    assert.equal(fit.fits, fits + 1, 'a repeated call does nothing');
});

test('a size that was waiting when the tab was left is sent when it is shown again', (t) => {
    const { client, container, observed, timers, sizesSent } = openTerminal(t);
    // The window narrows just before the tab is left: the terminal is fitted, the size waits.
    container.clientWidth = 600;
    observed();
    assert.equal(timers.size, 1);
    client.setActive(false);
    assert.deepEqual(sizesSent(), []);
    // Shown again at the same width: the fit changes nothing, and the phone still has 80 columns.
    client.setActive(true);
    const resized = [{ type: 'resize', cols: 60, rows: 24 }];
    assert.deepEqual(sizesSent(), resized);
    client.setActive(false);
    client.setActive(true);
    assert.deepEqual(sizesSent(), resized, 'a size the phone already has is not sent again');
});

test('showing Shell again on a phone does not open the keyboard', (t) => {
    const { client, term } = openTerminal(t, false);
    assert.equal(term.focused, 0, 'opening it does not either');
    client.setActive(false);
    client.setActive(true);
    assert.equal(term.focused, 0);
});
