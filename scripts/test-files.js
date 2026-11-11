// Files tool: the upload wire format, upload ids and downloads. No device is touched.
const assert = require('node:assert/strict');
const { test } = require('node:test');
global.__PATHNAME__ = '/';
require('ts-node').register({ transpileOnly: true });
require.extensions['.jar'] = () => {};
require.cache[require.resolve('../vendor/Genymobile/scrcpy/LICENSE')] = { exports: {} };

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { once } = require('node:events');
const { PassThrough } = require('node:stream');
const express = require('express');
const { AdbUtils } = require('../src/server/goog-device/AdbUtils');
const { FileListing } = require('../src/server/goog-device/mw/FileListing');
const { FilePushReader } = require('../src/server/goog-device/filePush/FilePushReader');
const { CommandControlMessage, FilePushState } = require('../src/app/controlMessage/CommandControlMessage');

test('upload ids stay inside the signed 16-bit response field', () => {
    const seen = new Set();
    for (let count = 0; count < 70000; count++) {
        const id = FilePushReader.getNextId();
        assert.ok(id >= 1 && id <= 0x7fff, `id ${id} after ${count} uploads`);
        // The response is written with writeInt16BE, which throws on a larger value.
        assert.equal(FilePushReader.createResponse(id, 0).readInt16BE(0), id);
        seen.add(id);
    }
    assert.equal(seen.size, 0x7fff, 'every id is used before one repeats');
});

test('the upload START message states a size of 4 GiB or more in full', () => {
    const start = (fileSize, overwrite) =>
        CommandControlMessage.createPushFileCommand({
            id: 7,
            state: FilePushState.START,
            fileName: '/sdcard/Movies/clip.mp4',
            fileSize,
            overwrite,
        }).toBuffer();
    const small = start(3, false);
    for (const size of [0xffffffff, 0x100000000, 5 * 1024 ** 3, 300 * 1024 ** 3]) {
        const buffer = start(size, false);
        assert.equal(buffer.length, small.length + (size > 0xffffffff ? 4 : 0), 'the high word is sent only when needed');
        const parsed = CommandControlMessage.pushFileCommandFromBuffer(buffer);
        assert.equal(parsed.fileSize, size);
        assert.equal(parsed.fileName, '/sdcard/Movies/clip.mp4');
        assert.equal(parsed.overwrite, false);
    }
    assert.equal(CommandControlMessage.pushFileCommandFromBuffer(start(5 * 1024 ** 3, true)).overwrite, true);
    // The scrcpy layout has no room for the high word. It says so instead of a range error.
    assert.throws(() => start(5 * 1024 ** 3, undefined), /4 GB or more/);
});

// Runs the generated command with the local /bin/sh in place of `adb shell`.
function localShell(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-files-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    t.mock.method(AdbUtils, 'shellExec', async (_serial, command) => {
        const result = childProcess.spawnSync('/bin/sh', ['-c', `{ ${command}\n} 2>&1`], { encoding: 'utf8' });
        return { code: result.status, output: result.stdout.trim() };
    });
    // Sparse files: the sizes are real, the disk use is not.
    const sparse = (name, size) => {
        const target = path.join(directory, name);
        fs.writeFileSync(target, '');
        fs.truncateSync(target, size);
        return target;
    };
    return { directory, sparse };
}

test('the Files channel reports the true size of files that LIST states in 32 bits', async (t) => {
    const { directory, sparse } = localShell(t);
    const big = 5 * 1024 ** 3 + 7;
    sparse("big it's.mp4", big);
    sparse('edge.bin', 0xffffffff);
    sparse('small.txt', 3);
    fs.mkdirSync(path.join(directory, 'folder'));
    sparse('folder/nested.bin', big);

    assert.deepEqual([...(await AdbUtils.largeFileSizes('fake', directory))], [["big it's.mp4", big]]);
    assert.equal(await AdbUtils.fileSize('fake', path.join(directory, "big it's.mp4")), big);
    assert.equal(await AdbUtils.fileSize('fake', path.join(directory, 'missing')), undefined);
    assert.deepEqual([...(await AdbUtils.largeFileSizes('fake', path.join(directory, 'missing')))], []);

    const sent = [];
    await new Promise((resolve) => {
        const channel = { OPEN: 1, readyState: 1, send: (data) => sent.push(Buffer.from(data)), close: resolve };
        const length = Buffer.alloc(4);
        length.writeUInt32LE(Buffer.byteLength(directory));
        FileListing.handleNewChannel('fake', channel, Buffer.concat([Buffer.from('SIZE'), length, Buffer.from(directory)]));
    });
    assert.equal(sent.length, 2);
    const [record, done] = sent;
    assert.equal(record.subarray(0, 4).toString(), 'SIZE');
    assert.equal(record.readUInt32LE(4) + record.readUInt32LE(8) * 0x100000000, big);
    assert.equal(record.subarray(16, 16 + record.readUInt32LE(12)).toString(), "big it's.mp4");
    assert.equal(done.toString(), 'DONE');
});

test('HTTP downloads state the file size, and a transfer that ends early is not a complete file', async (t) => {
    const { mountFileDownloads } = require('../src/server/goog-device/filePush/HttpDownload');
    const app = express();
    mountFileDownloads(app, '/');
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const url = `http://127.0.0.1:${server.address().port}/api/files/download?udid=fake&path=/sdcard/clip.mp4`;
    let size;
    let chunks = [];
    const asked = [];
    t.mock.method(AdbUtils, 'fileSize', async (_serial, file) => {
        asked.push(file);
        return size;
    });
    t.mock.method(AdbUtils, 'pipePullFile', async () => {
        const stream = new PassThrough();
        stream.cancel = () => undefined;
        process.nextTick(() => {
            chunks.forEach((chunk) => stream.write(chunk));
            stream.end();
        });
        return stream;
    });

    // The size comes from the device, so the browser can show progress for any file.
    size = 11;
    chunks = ['hello ', 'world'];
    let response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), '11');
    assert.match(response.headers.get('content-disposition'), /attachment; filename="clip.mp4"/);
    assert.equal(await response.text(), 'hello world');
    assert.deepEqual(asked, ['/sdcard/clip.mp4']);

    // A file that grew after its size was read is cut at the stated length.
    chunks = ['hello ', 'world', ' and more'];
    response = await fetch(url);
    assert.equal(await response.text(), 'hello world');

    // A pull that stops short must fail in the browser, not look like a finished download.
    chunks = ['hello'];
    response = await fetch(url);
    assert.equal(response.headers.get('content-length'), '11');
    await assert.rejects(response.text());

    // Without a size the bytes are still streamed.
    size = undefined;
    chunks = ['abc'];
    response = await fetch(url);
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(await response.text(), 'abc');
});

test('name conflicts follow the storage: case is ignored on shared storage only', async () => {
    const { freeName, nameKey, resolveNameConflicts } = require('../src/app/googDevice/filePush/nameConflicts');
    for (const folder of ['/sdcard', '/sdcard/Download', '/storage/emulated/0/DCIM', '/storage/1A2B-3C4D', '/mnt/sdcard/x']) {
        assert.equal(nameKey(folder)('Notes.TXT'), nameKey(folder)('notes.txt'), folder);
    }
    for (const folder of ['/data/local/tmp', '/', '/sdcardx', '/system/storage']) {
        assert.notEqual(nameKey(folder)('Notes.TXT'), nameKey(folder)('notes.txt'), folder);
    }

    const key = nameKey('/sdcard/Download');
    assert.equal(freeName('Notes.txt', new Set(['notes.txt', 'notes (1).txt']), false, key), 'Notes (2).txt');
    const existing = new Map([
        [key('notes.txt'), { isFolder: false, name: 'notes.txt' }],
        [key('Camera'), { isFolder: true, name: 'Camera' }],
    ]);
    const asked = [];
    const ask = (answers) => async (name, item, canReplace, remaining) => {
        asked.push({ name, existing: item.name, canReplace, remaining });
        return answers.shift();
    };
    const kept = await resolveNameConflicts(
        ['Notes.txt', 'camera', 'fresh.txt'],
        existing,
        true,
        ask([{ choice: 'keep', all: false }, { choice: 'keep', all: false }]),
        () => false,
        key,
    );
    assert.deepEqual(kept, [
        { name: 'Notes.txt', target: 'Notes (1).txt', replace: false },
        { name: 'camera', target: 'camera (1)', replace: false },
        { name: 'fresh.txt', target: 'fresh.txt', replace: false },
    ]);
    const replaced = await resolveNameConflicts(
        ['NOTES.TXT'],
        existing,
        true,
        ask([{ choice: 'replace', all: false }]),
        () => false,
        key,
    );
    assert.deepEqual(replaced, [{ name: 'NOTES.TXT', target: 'NOTES.TXT', replace: true }]);
    assert.deepEqual(asked, [
        { name: 'Notes.txt', existing: 'notes.txt', canReplace: true, remaining: 1 },
        { name: 'camera', existing: 'Camera', canReplace: false, remaining: 0 },
        { name: 'NOTES.TXT', existing: 'notes.txt', canReplace: true, remaining: 0 },
    ]);

    // Where case matters, the same names are simply different files.
    const exact = nameKey('/data/local/tmp');
    const plain = await resolveNameConflicts(
        ['Notes.txt'],
        new Map([[exact('notes.txt'), { isFolder: false, name: 'notes.txt' }]]),
        true,
        async () => assert.fail('no question where the names differ'),
        () => false,
        exact,
    );
    assert.deepEqual(plain, [{ name: 'Notes.txt', target: 'Notes.txt', replace: false }]);
});

test('the server acknowledges every upload chunk while its buffer has room, so chunks can be in flight', async (t) => {
    const { EventEmitter } = require('node:events');
    const { AdbExtended } = require('../src/server/goog-device/adb');
    const { FilePushResponseStatus } = require('../src/app/googDevice/filePush/FilePushResponseStatus');
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const channel = new EventEmitter();
    Object.assign(channel, {
        OPEN: 1,
        CLOSING: 2,
        CLOSED: 3,
        readyState: 1,
        responses: [],
        closes: [],
        addEventListener: (name, listener) => channel.on(name, listener),
        removeEventListener: (name, listener) => channel.off(name, listener),
        send: (data) => channel.responses.push(Buffer.from(data)),
        close: (code = 1000) => {
            channel.closes.push(code);
            channel.readyState = 3;
            channel.emit('close');
        },
    });
    const transfer = new EventEmitter();
    transfer.cancel = () => assert.fail('A finished upload is not cancelled');
    let input;
    const client = new EventEmitter();
    client.push = async (_serial, stream) => {
        input = stream;
        return transfer;
    };
    t.mock.method(AdbExtended, 'createClient', () => client);
    t.mock.method(AdbUtils, 'targetKind', async () => 'missing');
    const moves = [];
    t.mock.method(AdbUtils, 'move', async (_serial, _from, to) => moves.push(to));
    t.mock.method(AdbUtils, 'remove', async () => undefined);

    const reader = new FilePushReader('upload-fixture', channel);
    const send = (state, fields = {}) =>
        reader.onMessage({
            data: CommandControlMessage.createPushFileCommand({ id: reader.pushId, state, ...fields }).toBuffer(),
        });
    const acks = () =>
        channel.responses.filter((response) => response.readInt8(2) === FilePushResponseStatus.NO_ERROR).length;
    const chunk = Buffer.alloc(64 * 1024, 7);
    const count = 24; // 1.5 MiB: more than the server buffers.
    await send(FilePushState.NEW);
    await send(FilePushState.START, { fileName: '/sdcard/clip.mp4', fileSize: chunk.length * count });
    const afterStart = acks();
    // The client sends every chunk without waiting; adb has not read anything yet.
    for (let index = 0; index < count; index++) {
        await send(FilePushState.APPEND, { chunk });
    }
    await tick();
    const early = acks() - afterStart;
    assert(early >= 4, `chunks are acknowledged before adb reads them (${early})`);
    assert(early < count, `no more than the buffer holds is acknowledged (${early} of ${count})`);
    // adb reads the way adbkit's sync push does; the remaining chunks are acknowledged as the
    // buffer empties.
    const received = [];
    const drain = () => {
        let data;
        while ((data = input.read(64 * 1024) || input.read())) received.push(data);
    };
    input.on('readable', drain);
    drain();
    for (let round = 0; round < 5; round++) await tick();
    assert.equal(acks() - afterStart, count, 'every chunk gets exactly one acknowledgement');
    await send(FilePushState.FINISH);
    await tick();
    assert.equal(Buffer.concat(received).length, chunk.length * count);
    transfer.emit('end');
    await tick();
    assert.deepEqual(moves, ['/sdcard/clip.mp4']);
    assert.equal(acks() - afterStart, count + 1, 'and one more once the file is saved');
    assert.deepEqual(channel.closes, [1000]);
});

// ------------------------------------------------------------------ the Files stylesheet

test('the Files stylesheet states each rule once and forces nothing', () => {
    const file = path.join(__dirname, '..', 'src', 'style', 'filelisting.css');
    const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/!\s*important/i.test(source), false, 'no declaration is !important: the selector and the layer decide');
    // A rule is its selector under the conditions it is inside. One that is written twice has
    // its declarations in two places, and the later place overrides the earlier one.
    const seen = new Set();
    const repeated = [];
    const open = [];
    let buffer = '';
    for (const character of source) {
        if (character === '{') {
            const prelude = buffer.trim().replace(/\s+/g, ' ');
            const key = [...open, prelude].join(' { ');
            if (!prelude.startsWith('@')) {
                if (seen.has(key)) repeated.push(key);
                seen.add(key);
            }
            open.push(prelude);
            buffer = '';
        } else if (character === '}') {
            open.pop();
            buffer = '';
        } else if (character === ';') {
            buffer = '';
        } else {
            buffer += character;
        }
    }
    assert.ok(seen.size > 50, 'the rules are found');
    assert.deepEqual(repeated, [], 'each selector is written once under each condition');
});

// ------------------------------------------------------------------ the explorer while its tab is hidden
//
// The phone's page keeps Files mounted while it shows another tab and tells it with setActive.
// The explorer runs here against a stand-in for the page and the browser: elements that accept
// what is done to them, a session history, and a Files channel answered by hand.

const PHONE = 'PIXEL';
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeElement {
    constructor(tag) {
        Object.assign(this, { tagName: tag, dataset: {}, style: {}, hidden: false, inert: false, open: false, returnValue: '' });
        Object.assign(this, { children: [], parentNode: null, listeners: {}, found: new Map(), classes: new Set(), attributes: {} });
        this.classList = {
            add: (...names) => names.forEach((name) => this.classes.add(name)),
            remove: (...names) => names.forEach((name) => this.classes.delete(name)),
            contains: (name) => this.classes.has(name),
            toggle: (name, force = !this.classes.has(name)) => (force ? this.classes.add(name) : this.classes.delete(name), force),
        };
    }
    set className(value) {
        this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    }
    get className() {
        return [...this.classes].join(' ');
    }
    /** One element per selector, the same one each time it is asked for. */
    querySelector(selector) {
        if (!this.found.has(selector)) this.found.set(selector, Object.assign(new FakeElement(selector), { parentNode: this }));
        return this.found.get(selector);
    }
    querySelectorAll() {
        return [];
    }
    closest() {
        return null;
    }
    contains(node) {
        for (let item = node; item; item = item.parentNode) if (item === this) return true;
        return false;
    }
    appendChild(child) {
        child.remove();
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    insertBefore(child) {
        return this.appendChild(child);
    }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
        this.parentNode = null;
    }
    addEventListener(type, listener, options) {
        (this.listeners[type] ||= []).push({ listener, once: !!options?.once });
    }
    removeEventListener(type, listener) {
        this.listeners[type] = (this.listeners[type] || []).filter((item) => item.listener !== listener);
    }
    dispatch(type, fields = {}) {
        const event = { type, target: this, defaultPrevented: false, preventDefault: () => (event.defaultPrevented = true), ...fields };
        for (const item of [...(this.listeners[type] || [])]) {
            if (item.once) this.removeEventListener(type, item.listener);
            item.listener(event);
        }
        return event;
    }
    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }
    getAttribute(name) {
        return this.attributes[name] ?? null;
    }
    toggleAttribute(name, force = !(name in this.attributes)) {
        if (force) this.attributes[name] = '';
        else delete this.attributes[name];
    }
    focus() {
        global.document.activeElement = this;
    }
    blur() {
        if (global.document.activeElement === this) global.document.activeElement = null;
    }
    getBoundingClientRect() {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    showModal() {
        this.open = true;
    }
    /**
     * Like a browser, the close event comes in a later task, and promise callbacks run between
     * two of its listeners.
     */
    close(value) {
        if (!this.open) return;
        this.open = false;
        this.returnValue = value ?? this.returnValue;
        setImmediate(() => {
            for (const item of [...(this.listeners.close || [])]) {
                setImmediate(() => {
                    if (!this.listeners.close.includes(item)) return;
                    if (item.once) this.removeEventListener('close', item.listener);
                    item.listener({ type: 'close', target: this });
                });
            }
        });
    }
}
class FakeButton extends FakeElement {}

/** A tab's session history. Back, Forward and go act at once and fire the events a browser fires. */
function fakeTab(address) {
    const listeners = {};
    const entries = [{ url: new URL(address, 'http://phones.test:8000/'), state: null }];
    let index = 0;
    const writes = [];
    const fire = (type) => [...(listeners[type] || [])].forEach((listener) => listener({ type }));
    const write = (kind, state, url) => {
        const entry = { url: url ? new URL(url, entries[index].url) : entries[index].url, state: structuredClone(state) };
        if (kind === 'push') entries.length = ++index;
        entries[index] = entry;
        writes.push(`${kind} ${entry.url.hash}`);
    };
    const location = {};
    for (const key of ['hash', 'href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname'])
        Object.defineProperty(location, key, { get: () => entries[index].url[key] });
    const history = {
        get state() {
            return entries[index].state;
        },
        get length() {
            return entries.length;
        },
        pushState: (state, _unused, url) => write('push', state, url),
        replaceState: (state, _unused, url) => write('replace', state, url),
        go(delta) {
            if (index + delta < 0 || index + delta >= entries.length) return;
            const from = entries[index].url.hash;
            index += delta;
            fire('popstate');
            if (entries[index].url.hash !== from) fire('hashchange');
        },
        back: () => history.go(-1),
        forward: () => history.go(1),
    };
    const window = {
        addEventListener: (type, listener) => (listeners[type] ||= new Set()).add(listener),
        removeEventListener: (type, listener) => listeners[type]?.delete(listener),
        matchMedia: () => ({ matches: true, addEventListener: () => undefined }),
    };
    // The owner presses something. An overlay gets a history entry only after a press.
    const press = () => [...(listeners.pointerup || [])].forEach((listener) => listener({ type: 'pointerup', isTrusted: true }));
    return { location, history, window, writes, press, hashes: () => entries.map((entry) => entry.url.hash) };
}

/** The phone's side of the Files channel: every folder exists and holds the same two files. */
function fakePhone(Multiplexer) {
    const channels = [];
    const socket = Object.assign(Object.create(Multiplexer.prototype), {
        OPEN: 1,
        readyState: 1,
        closed: 0,
        close: () => socket.closed++,
        createChannel(payload) {
            const listeners = { message: new Set(), close: new Set() };
            const channel = {
                command: payload.subarray(0, 4).toString(),
                path: payload.subarray(8, 8 + payload.readUInt32LE(4)).toString(),
                answered: false,
                closedByClient: false,
                addEventListener: (type, listener) => listeners[type]?.add(listener),
                removeEventListener: (type, listener) => listeners[type]?.delete(listener),
                send: () => undefined,
                reply: (data) => [...listeners.message].forEach((listener) => listener({ data })),
                end: () => [...listeners.close].forEach((listener) => listener({ code: 1000 })),
                close() {
                    channel.closedByClient = true;
                    channel.end();
                },
            };
            channels.push(channel);
            return channel;
        },
    });
    const record = (code, name, mode) => {
        const text = Buffer.from(name);
        const data = Buffer.alloc(20 + text.length);
        data.write(code);
        data.writeUInt32LE(mode, 4);
        data.writeUInt32LE(1700000000, 12);
        data.writeUInt32LE(text.length, 16);
        text.copy(data, 20);
        return data;
    };
    return {
        socket,
        channels,
        asked: (command) => channels.filter((channel) => channel.command === command).map((channel) => channel.path),
        /** Answers every request that is waiting, and the requests those answers lead to. */
        serve() {
            for (let channel; (channel = channels.find((item) => !item.answered && !item.closedByClient)); ) {
                channel.answered = true;
                if (channel.command === 'STAT') channel.reply(record('STAT', '', 0o40755));
                if (channel.command === 'LIST') {
                    channel.reply(record('DENT', 'notes.txt', 0o100644));
                    channel.reply(record('DENT', 'photo.png', 0o100644));
                    channel.reply(Buffer.from('DONE'));
                }
                channel.end();
            }
        },
    };
}

/** Opens Files for the phone in a tab that came from the list, as the phone's page does. */
function openFiles(t, folder = '/sdcard') {
    const tab = fakeTab('#!');
    const body = new FakeElement('body');
    const frames = [];
    const storage = () => ({ getItem: () => null, setItem: () => undefined });
    const globals = {
        window: tab.window,
        location: tab.location,
        history: tab.history,
        localStorage: storage(),
        sessionStorage: storage(),
        document: {
            body,
            activeElement: null,
            createElement: (tag) => Object.assign(new FakeElement(tag), tag === 'template' ? { content: new FakeElement('content') } : {}),
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        },
        HTMLElement: FakeElement,
        HTMLButtonElement: FakeButton,
        getComputedStyle: () => ({ opacity: '1', transform: 'none' }),
        requestAnimationFrame: (run) => frames.push(run),
        cancelAnimationFrame: () => undefined,
    };
    const before = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(global, key)]));
    Object.entries(globals).forEach(([key, value]) => Object.defineProperty(global, key, { value, configurable: true, writable: true }));
    require.extensions['.css'] = () => {};
    const app = path.join(__dirname, '..', 'src', 'app') + path.sep;
    for (const key of Object.keys(require.cache)) if (key.startsWith(app)) delete require.cache[key];
    const { Multiplexer } = require('../src/packages/multiplexer/Multiplexer');
    const { ManagerClient } = require('../src/app/client/ManagerClient');
    const router = require('../src/app/state/router');
    const { deviceRoute } = require('../src/app/state/routes');
    const { FileListingClient } = require('../src/app/googDevice/client/FileListingClient');
    const phone = fakePhone(Multiplexer);
    t.mock.method(ManagerClient.prototype, 'openNewConnection', function () {
        this.ws = phone.socket;
        return phone.socket;
    });

    router.openRoute(deviceRoute(PHONE, 'files', { path: folder }));
    const mount = body.appendChild(new FakeElement('mount'));
    const params = new URLSearchParams({ action: 'list-files', udid: PHONE, path: folder });
    const client = FileListingClient.start(FileListingClient.parseParameters(params), mount);
    const wrapper = mount.children[0];
    // The template marks these hidden; the stand-in elements know nothing of the markup.
    wrapper.querySelector('.fx-menu').hidden = true;
    wrapper.querySelector('.fx-address-input').hidden = true;
    const toasts = [];
    client.renderToast = (message, error) => message && toasts.push({ message, error });
    const settle = async () => {
        for (let round = 0; round < 4; round++) {
            phone.serve();
            frames.splice(0).forEach((run) => run());
            await tick();
        }
    };
    t.after(() => {
        client.stop();
        Object.entries(before).forEach(([key, descriptor]) =>
            descriptor ? Object.defineProperty(global, key, descriptor) : delete global[key],
        );
    });
    client.onSocketOpen();
    const upload = (fields) =>
        client.onFilePushUpdate({
            key: 1,
            pushId: 0,
            fileName: 'clip.bin',
            message: 'Waiting',
            progress: 0,
            error: false,
            finished: false,
            sent: 0,
            size: 10,
            ...fields,
        });
    const dialog = wrapper.querySelector('.fx-dialog');
    return { tab, body, wrapper, client, phone, router, deviceRoute, toasts, settle, upload, dialog };
}

const address = (view, extra = '') => `#!action=device&udid=${PHONE}&view=${view}${extra}`;

test('a hidden Files keeps its folder, its connection and its uploads, and writes no history', async (t) => {
    const { tab, wrapper, client, phone, router, deviceRoute, settle, upload } = openFiles(t);
    await settle();
    assert.equal(client.getPath(), '/sdcard');
    assert.deepEqual(tab.hashes(), ['#!', address('files', '&path=%2Fsdcard')], 'Files reads and keeps the address of the phone page');
    assert.equal(tab.history.state.files.index, 0, 'the entry is tagged as the one Files opened on');

    // A folder step while the tab is shown is one new entry.
    client.navigate('/sdcard/DCIM');
    await settle();
    assert.deepEqual(tab.hashes().slice(2), [address('files', '&path=%2Fsdcard%2FDCIM')]);
    upload();
    assert.equal(wrapper.querySelector('.fx-transfers').children.length, 1, 'an upload is running');

    // Another tab of the same phone: the page replaces the address and hides Files.
    router.switchRoute(deviceRoute(PHONE, 'shell'));
    client.setActive(false);
    assert.equal(tab.location.hash, address('shell'), 'the change of view was not refused');
    const written = tab.writes.length;
    const requests = phone.channels.length;
    client.navigate('/sdcard/Download');
    upload({ sent: 5, message: '50%' });
    await settle();
    assert.equal(client.getPath(), '/sdcard/DCIM', 'the folder is kept: a folder change waits for the upload');
    assert.equal(tab.writes.length, written, 'nothing is written to history while hidden');
    assert.equal(tab.location.hash, address('shell'));
    assert.equal(phone.socket.closed, 0, 'the connection stays open');
    assert.equal(phone.channels.some((channel) => channel.closedByClient), false, 'no request was cancelled');
    assert.equal(wrapper.querySelector('.fx-transfers').children.length, 1, 'the upload goes on');

    // A key that reaches a hidden explorer does nothing.
    const key = wrapper.dispatch('keydown', { key: 'F5', target: wrapper.querySelector('.fx-items') });
    assert.equal(key.defaultPrevented, false);
    assert.equal(phone.channels.length, requests, 'F5 lists nothing while hidden');

    // The upload ends while hidden. The folder that was asked for is opened, without an entry.
    upload({ finished: true, sent: 10, message: 'Uploaded' });
    await settle();
    assert.equal(client.getPath(), '/sdcard/Download');
    assert.equal(tab.writes.length, written, 'still nothing written');

    // The page shows the tab again: first the address, then setActive. A folder that is listed
    // in between is not written either, though the address is the explorer's own again.
    router.switchRoute(deviceRoute(PHONE, 'files'));
    const entries = tab.history.length;
    const beforeShown = tab.writes.length;
    client.navigate('/sdcard/Music');
    await settle();
    assert.equal(client.getPath(), '/sdcard/Music');
    assert.equal(tab.writes.length, beforeShown, 'hidden means no write, whatever the address is');
    // The tab's link names no folder, so the address gets the one that is shown.
    client.setActive(true);
    assert.equal(tab.location.hash, address('files', '&path=%2Fsdcard%2FMusic'));
    assert.equal(tab.history.length, entries, 'in the same history entry');
    assert.equal(tab.history.state.files.index, 1, 'tagged with the place Files has in its own history');
    const pressed = wrapper.dispatch('keydown', { key: 'F5', target: wrapper.querySelector('.fx-items') });
    assert.equal(pressed.defaultPrevented, true, 'keys work again');
});

test('a Files tab that is shown again lists its folder again, reports what it missed and keeps a selection', async (t) => {
    const { wrapper, client, phone, router, deviceRoute, toasts, settle, upload } = openFiles(t);
    await settle();
    const lists = () => phone.asked('LIST').length;
    const show = async (shown) => {
        router.switchRoute(deviceRoute(PHONE, shown ? 'files' : 'shell'));
        client.setActive(shown);
        await settle();
    };
    await show(false);
    const before = lists();
    await show(true);
    assert.equal(lists(), before + 1, 'a shell command may have changed the folder');
    assert.equal(phone.asked('LIST').at(-1), '/sdcard');

    // A failed upload while hidden is not lost: it is shown when the tab is.
    await show(false);
    upload();
    upload({ finished: true, error: true, message: 'No space left on the phone.' });
    upload({ key: 2 });
    upload({ key: 2, finished: true, message: 'Uploaded' });
    await settle();
    assert.deepEqual(toasts, [], 'nothing is shown in a hidden explorer');
    await show(true);
    assert.deepEqual(toasts, [{ message: 'clip.bin: No space left on the phone.', error: true }]);

    // With a selection the rows stay as they are: listing again would clear it.
    wrapper.querySelector('.fx-check-all').dispatch('change', { currentTarget: { checked: true } });
    assert.equal(wrapper.classList.contains('fx-selecting'), true);
    await show(false);
    const kept = lists();
    await show(true);
    assert.equal(lists(), kept);
    assert.equal(wrapper.classList.contains('fx-selecting'), true, 'the selection is kept');
});

test('a tab link that names the folder shown is the same place in Files history, not a step', async (t) => {
    const { tab, client, router, deviceRoute, settle } = openFiles(t);
    await settle();
    const place = () => [client.historyIndex, tab.history.state.files?.index];
    const show = async (shown, extra = {}) => {
        router.switchRoute(deviceRoute(PHONE, shown ? 'files' : 'shell', extra));
        client.setActive(shown);
        await settle();
    };
    assert.deepEqual(place(), [0, 0]);
    // Back to the Files tab by a link with the path: the entry Files opened on, so the toolbar's
    // Back still has nothing behind it.
    await show(false);
    await show(true, { path: '/sdcard' });
    assert.deepEqual(place(), [0, 0]);
    assert.equal(tab.history.length, 2);

    // One folder step, then the same with the step's folder.
    client.navigate('/sdcard/DCIM');
    await settle();
    assert.deepEqual(place(), [1, 1]);
    await show(false);
    await show(true, { path: '/sdcard/DCIM' });
    assert.deepEqual(place(), [1, 1]);
    assert.equal(client.getPath(), '/sdcard/DCIM');

    // A tagged entry whose address names no folder gets the folder, and keeps its place.
    const tag = tab.history.state.files;
    await show(false);
    tab.history.replaceState({ ...tab.history.state, files: tag }, '', address('files'));
    client.setActive(true);
    await settle();
    assert.equal(tab.location.hash, address('files', '&path=%2Fsdcard%2FDCIM'));
    assert.deepEqual(place(), [1, 1]);
    tab.history.back();
    await settle();
    assert.equal(tab.location.hash, address('files', '&path=%2Fsdcard'), 'Back is the folder before');
});

test('two questions in a row each have one history entry, and Back answers the one that is open', async (t) => {
    const { tab, client, dialog, settle } = openFiles(t);
    await settle();
    const answer = (value) => dialog.dispatch('submit', { submitter: Object.assign(new FakeButton('button'), { value }) });
    const asks = (name) => dialog.open && dialog.innerHTML.includes(`Replace “${name}”`);
    // The owner picks the files: a press.
    tab.press();
    const plan = client.planUploads([{ name: 'notes.txt' }, { name: 'photo.png' }, { name: 'new.txt' }]);
    await settle();
    assert.equal(asks('notes.txt'), true);
    assert.equal(tab.history.state.nav.overlay, 1, 'the question has an entry on the folder');
    // The next question opens as soon as this one is answered and takes over its entry: the
    // tab does not step back and forward in between.
    const length = tab.history.length;
    answer('keep');
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(asks('photo.png'), true, 'the second question stays open');
    assert.equal(tab.history.state.nav.overlay, 1, 'with one entry');
    assert.equal(tab.history.length, length, 'and no entry was added or stepped over for it');
    tab.history.back();
    await settle();
    assert.equal(dialog.open, false, 'Back closes it');
    assert.equal(tab.location.hash, address('files', '&path=%2Fsdcard'), 'and leaves the folder alone');
    assert.equal(tab.history.state.nav.overlay, undefined);
    assert.deepEqual(
        (await plan).map((upload) => upload.name),
        ['notes (1).txt', 'new.txt'],
        'Back is Skip for that one file',
    );
});

test('a question that is answered and not followed by another gives up its entry', async (t) => {
    const { tab, client, dialog, settle } = openFiles(t);
    await settle();
    tab.press();
    const plan = client.planUploads([{ name: 'notes.txt' }, { name: 'new.txt' }]);
    await settle();
    assert.equal(tab.history.state.nav.overlay, 1, 'the question has an entry on the folder');
    dialog.dispatch('submit', { submitter: Object.assign(new FakeButton('button'), { value: 'skip' }) });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await settle();
    assert.equal(dialog.open, false);
    assert.equal(tab.history.state.nav.overlay, undefined, 'the entry was stepped back over');
    assert.equal(tab.location.hash, address('files', '&path=%2Fsdcard'));
    assert.deepEqual((await plan).map((upload) => upload.name), ['new.txt']);
});

test('an upload starts in the folder its name was checked against, not the one shown by then', async (t) => {
    const { client, phone, settle } = openFiles(t);
    await settle();
    const { AdbkitFilePushStream } = require('../src/app/googDevice/filePush/AdbkitFilePushStream');
    const stream = new AdbkitFilePushStream(phone.socket, client);
    const sent = [];
    stream.channels.set(7, { send: (data) => sent.push(CommandControlMessage.pushFileCommandFromBuffer(data)) });
    client.navigate('/sdcard/Music');
    await settle();
    stream.sendEventStart({ id: 7, fileName: 'notes.txt', fileSize: 3, overwrite: true, folder: '/sdcard' });
    stream.sendEventStart({ id: 7, fileName: 'notes.txt', fileSize: 3 });
    assert.deepEqual(
        sent.map(({ fileName, overwrite }) => ({ fileName, overwrite })),
        [
            { fileName: '/sdcard/notes.txt', overwrite: true },
            { fileName: '/sdcard/Music/notes.txt', overwrite: false },
        ],
    );
});

test('uploads: a change of view on the same phone does not ask, leaving the phone does, also from another tab', async (t) => {
    const { tab, body, wrapper, client, router, deviceRoute, settle, upload, dialog } = openFiles(t);
    await settle();
    upload();
    const question = () => dialog.open && dialog.innerHTML.includes('Stop the upload to');

    router.switchRoute(deviceRoute(PHONE, 'shell'));
    router.switchRoute(deviceRoute(PHONE, 'screen'));
    await settle();
    assert.equal(tab.location.hash, address('screen'), 'Shell and Screen of the same phone are not leaving');
    assert.equal(question(), false);

    // Files is hidden under the Screen tab. Another phone, Notifications and the list all ask.
    client.setActive(false);
    for (const leave of [
        () => router.switchRoute(deviceRoute('OTHER', 'screen')),
        () => router.openRoute({ action: 'notifications' }),
        () => router.goUp(),
    ]) {
        leave();
        await settle();
        assert.equal(question(), true, 'the question is asked');
        assert.equal(dialog.parentNode.parentNode, body, 'on the page itself, not inside the hidden explorer');
        assert.equal(dialog.parentNode.className, 'file-explorer');
        // Escape, the Back gesture or "Keep uploading".
        dialog.dispatch('cancel');
        await settle();
        assert.equal(tab.location.hash, address('screen'), 'refused: the phone page stays');
        assert.equal(dialog.parentNode, wrapper, 'the dialog is back in the explorer');
        assert.equal(body.children.length, 1, 'and its holder is gone');
        assert.equal(wrapper.querySelector('.fx-transfers').children.length, 1, 'the upload goes on');
    }

    // The browser's Back, which has already moved when the app hears of it.
    tab.history.back();
    await settle();
    assert.equal(question(), true);
    assert.equal(tab.location.hash, address('screen'), 'the phone page is put back');
    dialog.dispatch('submit', { submitter: Object.assign(new FakeButton('button'), { value: 'confirm' }) });
    await settle();
    assert.equal(tab.location.hash, '#!', 'Stop and leave goes where the owner asked');
});
