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

/**
 * Opens a terminal of 800 by 400 px on a desktop (`fine`) or on a phone. At the default text
 * size of 14px a cell is 10 px wide and 400/24 px high: 80 columns and 24 rows. `storage` is the
 * browser's localStorage, kept from one terminal to the next when a test passes the same one.
 */
function openTerminal(t, fine = true, storage = new Map()) {
    const made = {};
    class Terminal {
        constructor(options) {
            Object.assign(this, { options: { ...options }, cols: 80, rows: 24, written: [], focused: 0, blurred: 0, scrolled: 0 });
            this.modes = { applicationCursorKeysMode: false, bracketedPasteMode: false };
            this.selection = '';
            // The rows of the screen, top to bottom, as xterm's buffer gives them.
            this.screen = [];
            this.buffer = {
                active: {
                    viewportY: 0,
                    getLine: (y) => this.screen[y] && { translateToString: () => this.screen[y].text, isWrapped: this.screen[y].wrapped },
                },
            };
            made.term = this;
        }
        loadAddon(addon) {
            addon.term = this;
        }
        open() {}
        onData(listener) {
            this.typed = listener;
        }
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
        hasSelection() {
            return !!this.selection;
        }
        getSelection() {
            return this.selection;
        }
        scrollToBottom() {
            this.scrolled++;
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
            const size = this.term.options.fontSize;
            const cols = Math.floor((made.container.clientWidth * 14) / (10 * size));
            const rows = Math.floor((made.container.clientHeight * 24 * 14) / (400 * size));
            if (cols !== this.term.cols || rows !== this.term.rows) {
                Object.assign(this.term, { cols, rows });
                // The first fit, in the constructor, comes before the client listens.
                this.term.resized?.();
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
        localStorage: {
            getItem: (key) => (storage.has(key) ? storage.get(key) : null),
            setItem: (key, value) => storage.set(key, String(value)),
        },
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
    /** What was typed into the shell after the start message: the text frames. */
    const typed = () => socket.sent.slice(1).filter((data) => typeof data === 'string');
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
    return { client, socket, timers, sizesSent, typed, storage, ...made };
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

// ------------------------------------------------------------------ the key row under the terminal
//
// A touch screen has a row of the keys a phone keyboard lacks (`views/shell/ShellKeys.tsx`). The
// row calls the terminal; these tests call the terminal as the row does.

const { keyInput, pasteInput, screenText, stepTextSize, TEXT_SIZES, DEFAULT_TEXT_SIZE } = require('../src/app/googDevice/client/shellInput');

test('each key of the row sends the bytes a hardware keyboard would', () => {
    assert.equal(keyInput('escape'), '\x1b');
    assert.equal(keyInput('tab'), '\t');
    assert.deepEqual(['left', 'up', 'down', 'right'].map((key) => keyInput(key)), ['\x1b[D', '\x1b[A', '\x1b[B', '\x1b[C']);
    // vi, less and top turn on application cursor keys and read the arrows as ESC O x.
    assert.deepEqual(['left', 'up', 'down', 'right'].map((key) => keyInput(key, true)), ['\x1bOD', '\x1bOA', '\x1bOB', '\x1bOC']);
    assert.equal(keyInput('escape', true), '\x1b');
});

test('a key of the row reaches the shell in the mode the terminal is in, and leaves Ctrl waiting', (t) => {
    const { client, term, typed } = openTerminal(t, false);
    client.sendKey('left');
    client.sendKey('right');
    term.modes.applicationCursorKeysMode = true;
    client.sendKey('up');
    client.sendKey('tab');
    assert.deepEqual(typed(), ['\x1b[D', '\x1b[C', '\x1bOA', '\t']);
    assert.equal(term.focused, 4, 'each key gives the terminal the keyboard');
    // Ctrl is one-shot, as before: a key of the row does not use it, the next character does.
    client.setControl(true);
    client.sendKey('escape');
    term.typed('c');
    term.typed('c');
    assert.deepEqual(typed().slice(4), ['\x1b', '\x03', 'c']);
});

test('Paste sends the text once, with bracketed paste only when the program asked for it', (t) => {
    assert.equal(pasteInput('echo one\nls\r\n', false), 'echo one\rls\r', 'line ends are sent as Enter');
    assert.equal(pasteInput('ls', true), '\x1b[200~ls\x1b[201~');
    assert.equal(pasteInput('a\x1b[201~rm -rf x\n', true), '\x1b[200~arm -rf x\r\x1b[201~', 'an end marker in the text cannot end the paste');

    const { client, socket, term, typed } = openTerminal(t, false);
    client.pasteText('echo one\nls');
    assert.deepEqual(typed(), ['echo one\rls'], 'one text frame');
    term.modes.bracketedPasteMode = true;
    client.pasteText('pwd');
    assert.deepEqual(typed(), ['echo one\rls', '\x1b[200~pwd\x1b[201~']);
    assert.equal(term.scrolled, 2, 'the terminal shows its last line');
    // Ctrl waiting for a character does not turn a pasted "c" into ^C.
    term.modes.bracketedPasteMode = false;
    client.setControl(true);
    client.pasteText('c');
    client.pasteText('');
    assert.deepEqual(typed().slice(2), ['c'], 'nothing is sent for an empty clipboard');
    term.typed('d');
    assert.deepEqual(typed().slice(3), ['\x04'], 'and Ctrl still applies to the next key');
    // A closed session takes nothing.
    t.mock.method(console, 'log', () => undefined);
    client.onSocketClose({ reason: 'test' });
    client.pasteText('late');
    assert.equal(typed().length, 4);
    assert.equal(socket.sent.filter((data) => typeof data !== 'string').length, 0, 'no message is sent with it');
});

test('Copy takes the selection, or with none the text on screen', (t) => {
    assert.equal(
        screenText([
            { text: '$ ls      ', wrapped: false },
            { text: 'a-long-na', wrapped: false },
            { text: 'me.txt   ', wrapped: true },
            { text: '$        ', wrapped: false },
            { text: '         ', wrapped: false },
        ]),
        '$ ls\na-long-name.txt\n$',
        'a wrapped row continues its line; trailing spaces and blank rows are left out',
    );
    const { client, term } = openTerminal(t, false);
    term.screen = [{ text: 'old line', wrapped: false }, ...Array.from({ length: 24 }, (_, row) => ({ text: `row ${row}  `, wrapped: false }))];
    term.buffer.active.viewportY = 1;
    const shown = client.textToCopy();
    assert.equal(shown.selection, false);
    assert.equal(shown.text.split('\n').length, 24, 'the rows on screen, not the scrollback');
    assert.ok(shown.text.startsWith('row 0\nrow 1\n') && shown.text.endsWith('row 23'));
    term.selection = 'row 3';
    assert.deepEqual(client.textToCopy(), { text: 'row 3', selection: true });
});

test('text size changes the columns and rows and tells the phone once per change', (t) => {
    assert.deepEqual(TEXT_SIZES, [12, 14, 16, 18]);
    assert.equal(DEFAULT_TEXT_SIZE, 14);
    assert.deepEqual([stepTextSize(14, 1), stepTextSize(16, 1), stepTextSize(18, 1)], [16, 18, 18], 'larger up to 18');
    assert.deepEqual([stepTextSize(14, -1), stepTextSize(12, -1)], [12, 12], 'smaller down to 12');
    assert.equal(stepTextSize(15, 1), 14, 'a size not on the list goes back to the default');

    const { client, term, socket, storage, sizesSent } = openTerminal(t, false);
    assert.equal(term.options.fontSize, 14, 'the default size');
    assert.deepEqual(JSON.parse(socket.sent[0]).data, { type: 'start', rows: 24, cols: 80, udid: 'fixture' });
    client.setTextSize(16);
    assert.equal(term.options.fontSize, 16);
    assert.deepEqual([term.cols, term.rows], [70, 21], 'larger text: fewer columns and rows');
    const larger = { type: 'resize', cols: 70, rows: 21 };
    assert.deepEqual(sizesSent(), [larger], 'the phone is told once');
    client.setTextSize(16);
    client.setTextSize(15);
    assert.deepEqual(sizesSent(), [larger], 'the same size, or one not on the list, changes nothing');
    assert.equal(term.options.fontSize, 16);
    client.setTextSize(12);
    assert.deepEqual(sizesSent(), [larger, { type: 'resize', cols: 93, rows: 28 }]);
    assert.equal(storage.get('ws-scrcpy.shell.text-size'), '12', 'kept in this browser');
    assert.equal(socket.sent.filter((data) => typeof data === 'string').length, 1, 'no size is typed into the shell');
});

test('a new terminal in the same browser starts at the size kept there', (t) => {
    const storage = new Map([['ws-scrcpy.shell.text-size', '18']]);
    const { term, socket, sizesSent } = openTerminal(t, false, storage);
    assert.equal(term.options.fontSize, 18);
    assert.deepEqual(JSON.parse(socket.sent[0]).data, { type: 'start', rows: 18, cols: 62, udid: 'fixture' }, 'the start message has the size shown');
    assert.deepEqual(sizesSent(), [], 'and no resize follows it');
});

test('a kept size is used only when it is on the list, and a blocked storage gives the default', (t) => {
    const { storedTextSize, storeTextSize } = require('../src/app/googDevice/client/shellInput');
    const before = Object.getOwnPropertyDescriptor(global, 'localStorage');
    t.after(() => (before ? Object.defineProperty(global, 'localStorage', before) : delete global.localStorage));
    const kept = new Map();
    const storage = { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, String(value)) };
    Object.defineProperty(global, 'localStorage', { value: storage, configurable: true, writable: true });
    assert.equal(storedTextSize(), 14, 'nothing kept');
    storeTextSize(16);
    assert.equal(storedTextSize(), 16);
    for (const value of ['20', '15', 'large', '']) {
        kept.set('ws-scrcpy.shell.text-size', value);
        assert.equal(storedTextSize(), 14, `"${value}" is not a size of the list`);
    }
    // Safari with site data blocked throws on every access.
    Object.defineProperty(global, 'localStorage', {
        get: () => {
            throw Error('SecurityError');
        },
        configurable: true,
    });
    assert.equal(storedTextSize(), 14);
    assert.doesNotThrow(() => storeTextSize(18));
});
