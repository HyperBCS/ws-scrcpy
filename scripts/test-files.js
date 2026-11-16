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
    // A property that one selector of a list sets again in another rule under the same
    // condition: the later rule overrides the earlier one inside this file.
    const declared = new Map();
    const overridden = [];
    /** The selectors of a list, split at the commas that are not inside parentheses. */
    const selectors = (prelude) => {
        const parts = [''];
        let depth = 0;
        for (const character of prelude) {
            if (character === ',' && depth === 0) parts.push('');
            else {
                depth += character === '(' ? 1 : character === ')' ? -1 : 0;
                parts[parts.length - 1] += character;
            }
        }
        return parts.map((part) => part.trim());
    };
    const declare = (text) => {
        const prelude = open[open.length - 1];
        const property = text.split(':')[0].trim();
        if (!prelude || prelude.startsWith('@') || !property) return;
        const conditions = open.slice(0, -1).join(' { ');
        for (const selector of selectors(prelude)) {
            const key = `${conditions} { ${selector} { ${property}`;
            const rule = [...open].join(' { ');
            if (declared.has(key) && declared.get(key) !== rule) overridden.push(key);
            declared.set(key, rule);
        }
    };
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
            declare(buffer);
            open.pop();
            buffer = '';
        } else if (character === ';') {
            declare(buffer);
            buffer = '';
        } else {
            buffer += character;
        }
    }
    assert.ok(seen.size > 50, 'the rules are found');
    assert.deepEqual(repeated, [], 'each selector is written once under each condition');
    assert.ok(declared.size > 300, 'the declarations are found');
    assert.deepEqual(overridden, [], 'no rule sets a property that another rule for the same selector sets');
});

test('every kind of file has an icon of the kit set, with the classes the explorer sizes it by', () => {
    const { iconMarkup } = require('../src/app/googDevice/client/fileTypes');
    const { ICONS } = require('../src/app/ui/icons');
    const paths = new Set(Object.values(ICONS));
    const kinds = ['folder', 'apk', 'image', 'video', 'audio', 'archive', 'code', 'text', 'document', 'link', 'special', 'file'];
    for (const kind of kinds) {
        const markup = iconMarkup(kind);
        assert.ok(markup.includes(`class="kit-icon fx-icon fx-icon-${kind}"`), `${kind}: ${markup}`);
        assert.ok(markup.includes('aria-hidden="true"'), `${kind} is not read out`);
        const drawn = markup.match(/<path d="([^"]+)"\/>/g) || [];
        assert.equal(drawn.length, 1, `${kind} is one path`);
        assert.ok(paths.has(/d="([^"]+)"/.exec(drawn[0])[1]), `${kind} is drawn from the kit set`);
    }
    assert.notEqual(iconMarkup('folder'), iconMarkup('file').replace('fx-icon-file', 'fx-icon-folder'), 'a folder and a file differ');
});

/**
 * The box around the points a path's commands end on: near enough to tell an arrow from a folder.
 * The flags of an arc must be written apart, as Lucide writes them.
 */
function pathBox(data) {
    const counts = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
    let x = 0;
    let y = 0;
    let start = [0, 0];
    const xs = [];
    const ys = [];
    for (const [, letter, args] of data.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g)) {
        const numbers = (args.match(/-?(?:\d+\.?\d*|\.\d+)/g) || []).map(Number);
        const lower = letter.toLowerCase();
        const relative = letter === lower;
        if (lower === 'z') {
            [x, y] = start;
            continue;
        }
        for (let at = 0; at < numbers.length; at += counts[lower]) {
            const set = numbers.slice(at, at + counts[lower]);
            if (lower === 'h') x = relative ? x + set[0] : set[0];
            else if (lower === 'v') y = relative ? y + set[0] : set[0];
            else {
                const [endX, endY] = set.slice(-2);
                x = relative ? x + endX : endX;
                y = relative ? y + endY : endY;
            }
            if (lower === 'm' && at === 0) start = [x, y];
            xs.push(x);
            ys.push(y);
        }
    }
    return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

test('Move in the selection bar has a shape of its own, not the arrow of Forward', () => {
    const { ICONS, iconSvg } = require('../src/app/ui/icons');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'googDevice', 'client', 'FileListingClient.ts'), 'utf8');
    const forward = /const TOOLBAR_ICONS[\s\S]*?\bforward: '(\w+)'/.exec(source)[1];
    const move = /const SELECTION_ICONS[\s\S]*?\bcut: '(\w+)'/.exec(source)[1];
    assert.equal(forward, 'arrowRight');
    assert.equal(move, 'move');
    // The arrow is a line with a head, a little more than half the grid high. Move is a folder
    // with an arrow going into it (Lucide's folder-input), nearly the whole grid high.
    assert.ok(pathBox(ICONS.arrowRight).height <= 12, `the arrow is ${pathBox(ICONS.arrowRight).height} high`);
    assert.ok(pathBox(ICONS.move).height >= 16, `Move is ${pathBox(ICONS.move).height} high, not an arrow`);
    assert.equal((iconSvg('move').match(/<path /g) || []).length, 1, 'Move is one path');
    assert.deepEqual(
        Object.keys(ICONS).filter((name) => name !== 'move' && ICONS[name] === ICONS.move),
        [],
        'no other icon has the shape of Move',
    );
    const notice = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'ui', 'icons.ts'), 'utf8').split('/*!')[1];
    assert.match(notice, /move \(folder-input\)/, 'the notice at the end of icons.ts names Move');
});

// ------------------------------------------------------------------ FileService
//
// The service against a Files channel answered by hand: each request opens a channel, and the
// test replies on it, closes it from the phone's side, or leaves it waiting.

/** A Files channel whose request channels record what is sent and are answered by the test. */
function serviceSocket() {
    const channels = [];
    const socket = {
        OPEN: 1,
        readyState: 1,
        createChannel(payload) {
            const listeners = { message: new Set(), close: new Set() };
            const channel = {
                command: Buffer.from(payload).subarray(0, 4).toString(),
                payload: Buffer.from(payload),
                sent: [],
                /** How the explorer closed it, if it did. */
                closedBy: null,
                open: true,
                addEventListener: (type, listener) => listeners[type].add(listener),
                removeEventListener: (type, listener) => listeners[type].delete(listener),
                send: (data) => channel.sent.push(Buffer.from(data)),
                reply: (data) => [...listeners.message].forEach((listener) => listener({ data })),
                end(code = 1000, reason = '') {
                    if (!channel.open) return;
                    channel.open = false;
                    [...listeners.close].forEach((listener) => listener({ code, reason }));
                },
                close(code = 1000) {
                    if (!channel.open) return;
                    channel.closedBy = `client ${code}`;
                    channel.end(code);
                },
                /** The upload messages sent on it, decoded. */
                pushes: () => channel.sent.map((data) => CommandControlMessage.pushFileCommandFromBuffer(data)),
            };
            channels.push(channel);
            return channel;
        },
    };
    return { socket, channels, last: () => channels.at(-1) };
}

const record = (code, name, mode, size = 0) => {
    const text = Buffer.from(name);
    const data = Buffer.alloc(20 + text.length);
    data.write(code);
    data.writeUInt32LE(mode, 4);
    data.writeUInt32LE(size, 8);
    data.writeUInt32LE(1700000000, 12);
    data.writeUInt32LE(text.length, 16);
    text.copy(data, 20);
    return data;
};
const statReply = (mode, size = 0) => {
    const data = Buffer.alloc(16);
    data.write('STAT');
    data.writeUInt32LE(mode, 4);
    data.writeUInt32LE(size, 8);
    data.writeUInt32LE(1700000000, 12);
    return data;
};
const failReply = (message) => {
    const text = Buffer.from(message);
    const data = Buffer.alloc(8 + text.length);
    data.write('FAIL');
    data.writeUInt32LE(text.length, 4);
    text.copy(data, 8);
    return data;
};
const pushReply = (id, code) => {
    const data = Buffer.alloc(3);
    data.writeInt16BE(id);
    data.writeInt8(code, 2);
    return data;
};
/** Waits for whatever the promises in flight do next. */
const later = () => new Promise((resolve) => setImmediate(resolve));
const outcome = (promise) =>
    promise.then(
        (value) => ({ value }),
        (error) => ({ error: { kind: error.kind, message: error.message, isFileError: error.name === 'FileError' } }),
    );
const fileService = () => {
    const { FileService } = require('../src/app/googDevice/files/FileService');
    const wire = serviceSocket();
    return { service: new FileService(wire.socket, { serial: PHONE }), ...wire };
};

test('FileService: list, stat, large sizes and the folder operations resolve, with the request on the wire', async (t) => {
    const { service, last } = fileService();
    global.location = { href: 'http://phones.test:8000/' };
    t.after(() => delete global.location);
    const heard = [];
    const listing = outcome(service.list('/sdcard', (entry) => heard.push(entry.name)));
    const list = last();
    assert.equal(list.command, 'LIST');
    assert.equal(list.payload.subarray(8).toString(), '/sdcard');
    list.reply(record('DENT', '.', 0o40755));
    list.reply(record('DENT', 'DCIM', 0o40755));
    list.reply(record('DENT', 'notes.txt', 0o100644, 12));
    assert.deepEqual(heard, ['DCIM', 'notes.txt'], 'each item is heard of as it arrives');
    list.end(0);
    const { value: entries } = await listing;
    assert.deepEqual(entries.map((entry) => [entry.name, entry.isDirectory(), entry.size]), [['DCIM', true, 0], ['notes.txt', false, 12]]);

    // A listing that ends with DONE resolves at DONE.
    const done = outcome(service.list('/data'));
    last().reply(Buffer.from('DONE'));
    assert.deepEqual((await done).value, []);

    const stat = outcome(service.stat('/sdcard/DCIM'));
    assert.equal(last().command, 'STAT');
    last().reply(statReply(0o40755));
    const { value: folder } = await stat;
    assert.deepEqual([folder.name, folder.isDirectory()], ['DCIM', true]);
    assert.equal(last().closedBy, null, 'the phone closes a STAT itself');

    const sizes = outcome(service.largeSizes('/sdcard/DCIM'));
    const big = Buffer.alloc(16 + 7);
    big.write('SIZE');
    big.writeUInt32LE(7, 4);
    big.writeUInt32LE(1, 8);
    big.writeUInt32LE(7, 12);
    big.write('big.mp4', 16);
    last().reply(big);
    last().reply(Buffer.from('DONE'));
    last().end();
    assert.deepEqual([...(await sizes).value], [['big.mp4', 2 ** 32 + 7]]);

    const operations = [
        ['MKDR', () => service.mkdir('/sdcard/Trips')],
        ['MOVE', () => service.rename('/sdcard/a', '/sdcard/b')],
        ['MOVE', () => service.move('/sdcard/a', '/sdcard/b', true)],
        ['COPY', () => service.copy('/sdcard/a', '/sdcard/b')],
        ['DELE', () => service.remove(['/sdcard/a', '/sdcard/b'])],
    ];
    for (const [command, start] of operations) {
        const result = outcome(start());
        assert.equal(last().command, command);
        last().reply(Buffer.from('DONE'));
        last().end();
        assert.deepEqual(await result, { value: undefined }, command);
    }

    assert.equal(
        service.downloadLink('/sdcard/notes.txt'),
        'http://phones.test:8000/api/files/download?udid=PIXEL&path=%2Fsdcard%2Fnotes.txt',
    );
    const { FileService } = require('../src/app/googDevice/files/FileService');
    const proxied = new FileService(serviceSocket().socket, { serial: PHONE, remote: 'ws://phone.test:8000/?action=multiplex' });
    assert.match(proxied.downloadLink('/sdcard/a b'), /path=%2Fsdcard%2Fa\+b&remote=ws%3A%2F%2Fphone\.test%3A8000%2F%3Faction%3Dmultiplex$/);
});

test('FileService: errors are FileErrors that carry the phone\'s message', async () => {
    const { service, last } = fileService();
    const cases = [
        [() => service.list('/sdcard/Denied'), (channel) => channel.reply(failReply('Permission denied')), { kind: 'refused', message: 'Permission denied' }, 'client 1000'],
        [() => service.mkdir('/sdcard/Locked'), (channel) => channel.reply(failReply('Read-only file system')), { kind: 'refused', message: 'Read-only file system' }, 'client 1000'],
        [() => service.mkdir('/sdcard/x'), (channel) => channel.reply(failReply('')), { kind: 'refused', message: 'The phone refused it.' }, 'client 1000'],
        [() => service.stat('/sdcard/none'), (channel) => channel.reply(statReply(0)), { kind: 'missing', message: 'There is no such folder on the phone, or it cannot be read.' }, 'client 1000'],
        [() => service.stat('/dev/null'), (channel) => channel.reply(statReply(0o20666)), { kind: 'unsupported', message: 'This item is not a regular file or folder.' }, 'client 1000'],
        // The server ends a LIST that adb refused with the reason in the close.
        [() => service.list('/sdcard/x'), (channel) => channel.end(4000, 'No such file or directory'), { kind: 'interrupted', message: 'No such file or directory' }, null],
        [() => service.copy('/a', '/b'), (channel) => channel.end(), { kind: 'interrupted', message: 'The connection to the phone was interrupted.' }, null],
        [() => service.stat('/sdcard'), (channel) => channel.reply(Buffer.from('ST')), { kind: 'unreadable', message: 'The answer from the phone could not be read.' }, 'client 1000'],
    ];
    for (const [start, answer, expected, closedBy] of cases) {
        const result = outcome(start());
        const channel = last();
        answer(channel);
        assert.deepEqual(await result, { error: { ...expected, isFileError: true } }, expected.message);
        assert.equal(channel.closedBy, closedBy, `${expected.message}: ${closedBy ? 'the explorer closes the channel' : 'the phone closed it'}`);
    }
    // Without the connection nothing is sent.
    const offline = fileService();
    offline.socket.readyState = 3;
    assert.deepEqual(await outcome(offline.service.list('/sdcard')), {
        error: { kind: 'offline', message: 'The connection to the phone is closed.', isFileError: true },
    });
    assert.equal(offline.channels.length, 0);
});

test('FileService: each request can be cancelled, and a reply that comes after is ignored', async () => {
    const { service, last, channels } = fileService();
    const cancelled = { error: { kind: 'cancelled', message: 'The request was cancelled.', isFileError: true } };
    const heard = [];
    const starts = [
        () => service.list('/sdcard', (entry) => heard.push(entry.name)),
        () => service.stat('/sdcard'),
        () => service.largeSizes('/sdcard'),
        () => service.mkdir('/sdcard/a'),
        () => service.rename('/sdcard/a', '/sdcard/b'),
        () => service.move('/sdcard/a', '/sdcard/b'),
        () => service.copy('/sdcard/a', '/sdcard/b'),
        () => service.remove(['/sdcard/a']),
    ];
    for (const start of starts) {
        const request = start();
        const channel = last();
        request.cancel();
        assert.equal(channel.closedBy, 'client 1000', `${channel.command}: cancel closes its channel`);
        // The phone had already answered: what it says now reaches nobody.
        channel.reply(record('DENT', 'late.txt', 0o100644));
        channel.reply(statReply(0o40755));
        channel.reply(Buffer.from('DONE'));
        assert.deepEqual(await outcome(request), cancelled, channel.command);
    }
    assert.deepEqual(heard, [], 'no item of a cancelled listing is heard of');
    assert.equal(channels.length, starts.length);

    // Release closes every channel that is open, and its requests end as cancelled.
    const open = [service.list('/a'), service.stat('/b')].map(outcome);
    service.release();
    assert.deepEqual(channels.slice(-2).map((channel) => channel.closedBy), ['client 1000', 'client 1000']);
    assert.deepEqual(await Promise.all(open), [cancelled, cancelled]);
    assert.equal(service.connected(), false);
});

/**
 * The phone's side of one upload channel. `answer(upto)` answers what was sent since the last
 * answer, as far as the step `upto` (a FilePushState); `run(upto)` keeps answering while the
 * upload reads its file and sends more.
 */
function uploadPhone(channel, id) {
    const { FilePushState } = require('../src/app/controlMessage/CommandControlMessage');
    let answered = 0;
    const phone = {
        answer(upto = Infinity) {
            const pushes = channel.pushes();
            while (answered < pushes.length && channel.open) {
                const { state } = pushes[answered];
                if (state > upto) return;
                answered++;
                if (state === FilePushState.NEW) channel.reply(pushReply(id, 1));
                else if (state === FilePushState.START || state === FilePushState.APPEND) channel.reply(pushReply(id, 0));
                else if (state === FilePushState.FINISH) {
                    channel.reply(pushReply(id, 0));
                    channel.end();
                }
            }
        },
        async run(upto = Infinity, rounds = 20) {
            for (let round = 0; round < rounds && channel.open; round++) {
                phone.answer(upto);
                await later();
            }
        },
        states: () => channel.pushes().map(({ state }) => state),
    };
    return phone;
}

test('FileService: an upload sends NEW, START, its chunks and FINISH, and reports how far it is', async () => {
    const { service, last } = fileService();
    const progress = [];
    const contents = Buffer.alloc(200000, 7);
    const upload = outcome(
        service.upload(new File([contents], 'clip.bin'), {
            path: '/sdcard/Movies/clip.bin',
            overwrite: false,
            onProgress: (step) => progress.push(step),
        }),
    );
    const channel = last();
    assert.equal(channel.command, 'SEND');
    await uploadPhone(channel, 41).run();
    assert.deepEqual(await upload, { value: undefined });
    const pushes = channel.pushes();
    assert.deepEqual(pushes.map(({ state }) => state), [0, 1, 2, 2, 2, 2, 3], 'NEW, START, four chunks, FINISH');
    assert.deepEqual(pushes.slice(1).map(({ id }) => id), [41, 41, 41, 41, 41, 41], 'every message after NEW names the id');
    assert.deepEqual([pushes[1].fileName, pushes[1].fileSize, pushes[1].overwrite], ['/sdcard/Movies/clip.bin', 200000, false]);
    assert.deepEqual(Buffer.concat(pushes.slice(2, 6).map(({ chunk }) => chunk)), contents);
    assert.deepEqual(progress.at(0), { sent: 0, size: 200000, saving: false });
    assert.deepEqual(progress.at(-1), { sent: 200000, size: 200000, saving: true });
    assert.ok(progress.some(({ sent, saving }) => sent === 65536 && !saving), 'bytes are reported as the phone takes them');
    assert.equal(channel.closedBy, null, 'the phone ends a finished upload');

    // A refusal reads as the phone gives it: the close reason, or the meaning of its code.
    const refused = outcome(service.upload(new File(['x'], 'notes.txt'), { path: '/sdcard/notes.txt', overwrite: false }));
    await uploadPhone(last(), 42).run(0, 3);
    last().end(4013, 'An item with this name already exists.');
    assert.deepEqual(await refused, {
        error: { kind: 'refused', message: 'An item with this name already exists.', isFileError: true },
    });
    const full = outcome(service.upload(new File(['x'], 'notes.txt'), { path: '/sdcard/notes.txt', overwrite: false }));
    await uploadPhone(last(), 43).run(0, 3);
    last().reply(pushReply(43, -2));
    assert.deepEqual(await full, { error: { kind: 'refused', message: 'No space.', isFileError: true } });
});

test('FileService: an upload can be cancelled while it sends and while its id is on the way', async () => {
    const { service, last } = fileService();
    const { FilePushState } = require('../src/app/controlMessage/CommandControlMessage');
    const cancelled = { error: { kind: 'cancelled', message: 'The request was cancelled.', isFileError: true } };

    const sending = service.upload(new File([Buffer.alloc(200000)], 'a.bin'), { path: '/sdcard/a.bin', overwrite: false });
    const first = uploadPhone(last(), 50);
    await first.run(FilePushState.START, 6);
    assert.deepEqual(first.states(), [0, 1, 2, 2, 2, 2], 'the chunks are out, none acknowledged');
    const channel = last();
    sending.cancel();
    assert.deepEqual(first.states().slice(-1), [FilePushState.CANCEL], 'CANCEL names the upload');
    assert.equal(channel.closedBy, 'client 1000', 'then the channel closes');
    channel.reply(pushReply(50, 0));
    assert.deepEqual(await outcome(sending), cancelled);

    // Cancelled before the phone gave an id: CANCEL follows the id, then the close.
    const early = service.upload(new File(['x'], 'b.bin'), { path: '/sdcard/b.bin', overwrite: false });
    const second = last();
    early.cancel();
    assert.equal(second.closedBy, null, 'nothing to name yet');
    await uploadPhone(second, 51).run(FilePushState.NEW, 3);
    assert.deepEqual(second.pushes().map(({ state, id }) => [state, id]), [[FilePushState.NEW, 0], [FilePushState.CANCEL, 51]]);
    assert.equal(second.closedBy, 'client 1000');
    assert.deepEqual(await outcome(early), cancelled);

    // Once every byte is sent the phone is saving the file, and Cancel does nothing.
    const saving = service.upload(new File(['abc'], 'c.bin'), { path: '/sdcard/c.bin', overwrite: true });
    const third = uploadPhone(last(), 52);
    await third.run(FilePushState.APPEND, 6);
    assert.deepEqual(third.states(), [0, 1, 2, 3], 'FINISH is out');
    saving.cancel();
    assert.equal(last().closedBy, null, 'a file being saved is not cancelled');
    third.answer();
    assert.deepEqual(await outcome(saving), { value: undefined });
});

test('FileService: an upload in progress does not hold up a listing or a STAT', async () => {
    const { service, last } = fileService();
    const upload = outcome(service.upload(new File([Buffer.alloc(300000)], 'big.bin'), { path: '/sdcard/big.bin', overwrite: false }));
    const send = last();
    const phone = uploadPhone(send, 60);
    await phone.run(1, 6);
    assert.equal(phone.states().filter((state) => state === 2).length, 5, 'its chunks wait for their acknowledgement');
    // A listing goes out at once on a channel of its own and is answered while the upload waits.
    const listing = outcome(service.list('/sdcard'));
    const list = last();
    assert.equal(list.command, 'LIST');
    list.reply(record('DENT', 'notes.txt', 0o100644, 3));
    list.end(0);
    assert.deepEqual((await listing).value.map((entry) => entry.name), ['notes.txt']);
    const stat = outcome(service.stat('/sdcard'));
    last().reply(statReply(0o40755));
    assert.equal((await stat).value.isDirectory(), true);
    assert.equal(send.open, true, 'the upload is still sending');
    await phone.run();
    assert.deepEqual(await upload, { value: undefined });
});

test('an upload goes to the folder its name was checked against, whatever the explorer shows by then', async (t) => {
    const { client, dialog, settle } = openFiles(t);
    await settle();
    const plan = client.planUploads([{ name: 'notes.txt' }]);
    await settle();
    dialog.dispatch('submit', { submitter: Object.assign(new FakeButton('button'), { value: 'replace' }) });
    const [planned] = await plan;
    assert.deepEqual([planned.folder, planned.name, planned.overwrite], ['/sdcard', 'notes.txt', true]);
    client.navigate('/sdcard/Music');
    await settle();
    // The queue sends the planned upload to the planned folder.
    const FilePushHandler = require('../src/app/googDevice/filePush/FilePushHandler').default;
    const { service, last } = fileService();
    const handler = new FilePushHandler(new FakeElement('div'), service, async (files) => files.map((file) => ({ ...planned, file })));
    t.after(() => handler.release());
    handler.onFilesDrop([new File(['abc'], 'notes.txt')]);
    await later();
    await uploadPhone(last(), 70).run(0, 3);
    const start = last().pushes()[1];
    assert.deepEqual([start.fileName, start.overwrite], ['/sdcard/notes.txt', true]);
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
        Object.assign(this, { tagName: tag, dataset: {}, hidden: false, inert: false, open: false, returnValue: '' });
        this.style = { setProperty: (name, value) => (this.style[name] = value), removeProperty: (name) => delete this.style[name] };
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
    /** Before `reference` when it is one of the children, at the end otherwise. */
    insertBefore(child, reference) {
        child.remove();
        child.parentNode = this;
        const at = this.children.indexOf(reference);
        if (at < 0) this.children.push(child);
        else this.children.splice(at, 0, child);
        return child;
    }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
        this.parentNode = null;
    }
    get firstElementChild() {
        return this.children[0] ?? null;
    }
    get nextElementSibling() {
        const siblings = this.parentNode?.children || [];
        const at = siblings.indexOf(this);
        return at < 0 ? null : (siblings[at + 1] ?? null);
    }
    get isConnected() {
        let item = this;
        while (item.parentNode) item = item.parentNode;
        return item === global.document?.body;
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
    removeAttribute(name) {
        delete this.attributes[name];
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
    setSelectionRange() {}
    /**
     * Rows lie one under the other, 33px each, and a spacer is as tall as its style says. A test
     * can give another element a place with `layout`.
     */
    getBoundingClientRect() {
        const box = (top, height) => ({ left: 0, top, right: 0, bottom: top + height, width: 0, height });
        if (this.layout) return this.layout();
        if (this.tagName !== 'tr' || !this.parentNode) return box(0, 0);
        let top = this.parentNode.getBoundingClientRect().top;
        for (const sibling of this.parentNode.children) {
            if (sibling === this) break;
            top += sibling.rowHeight();
        }
        return box(top, this.rowHeight());
    }
    rowHeight() {
        return this.classes.has('fx-spacer') ? parseFloat(this.style.height) || 0 : 33;
    }
    /** A download is a link that is clicked. The links clicked are kept on the document. */
    click() {
        (global.document.clicked ||= []).push(this.href);
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

/**
 * A template that makes one element for each row in its markup, with the row's classes and
 * data attributes. That is all the explorer reads from the rows it builds.
 */
class FakeTemplate extends FakeElement {
    constructor() {
        super('template');
        this.content = new FakeElement('content');
    }
    set innerHTML(markup) {
        this.markup = markup;
        this.content.children = [];
        const unescape = (text) =>
            text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        for (const [, attributes] of markup.matchAll(/<tr\b([^>]*)>/g)) {
            const row = new FakeElement('tr');
            for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
                if (name === 'class') row.className = value;
                else if (name.startsWith('data-')) row.dataset[name.slice(5)] = unescape(value);
                else row.setAttribute(name, unescape(value));
            }
            this.content.appendChild(row);
        }
    }
    get innerHTML() {
        return this.markup || '';
    }
}

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
        matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
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
function openFiles(t, folder = '/sdcard', makePhone = fakePhone) {
    const tab = fakeTab('#!');
    const body = new FakeElement('body');
    const frames = [];
    const cancelledFrames = new Set();
    let frameIds = 0;
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
            createElement: (tag) => (tag === 'template' ? new FakeTemplate() : new FakeElement(tag)),
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        },
        HTMLElement: FakeElement,
        HTMLButtonElement: FakeButton,
        // The markup takes the kit's class names as values, which the template helper tells from a template.
        HTMLTemplateElement: class {},
        getComputedStyle: () => ({ opacity: '1', transform: 'none', paddingTop: '0px', getPropertyValue: () => '' }),
        // A frame that is cancelled does not run.
        requestAnimationFrame: (run) => {
            const id = ++frameIds;
            frames.push(() => cancelledFrames.has(id) || run());
            return id;
        },
        cancelAnimationFrame: (id) => cancelledFrames.add(id),
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
    const phone = makePhone(Multiplexer);
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
    wrapper.querySelector('.files-menu').hidden = true;
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
            fileName: 'clip.bin',
            folder: '/sdcard/DCIM',
            message: 'Waiting',
            error: false,
            finished: false,
            sent: 0,
            size: 10,
            cancellable: true,
            ...fields,
        });
    const dialog = wrapper.querySelector('.fx-dialog');
    return { tab, body, wrapper, client, phone, router, deviceRoute, toasts, settle, upload, dialog, frames };
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
    client.navigate('/sdcard/Download');
    upload({ sent: 5, message: '' });
    await settle();
    assert.equal(client.getPath(), '/sdcard/Download', 'a folder change does not wait for the upload');
    const requests = phone.channels.length;
    assert.equal(tab.writes.length, written, 'nothing is written to history while hidden');
    assert.equal(tab.location.hash, address('shell'));
    assert.equal(phone.socket.closed, 0, 'the connection stays open');
    assert.equal(phone.channels.some((channel) => channel.closedByClient), false, 'no request was cancelled');
    assert.equal(wrapper.querySelector('.fx-transfers').children.length, 1, 'the upload goes on');

    // A key that reaches a hidden explorer does nothing.
    const key = wrapper.dispatch('keydown', { key: 'F5', target: wrapper.querySelector('.fx-items') });
    assert.equal(key.defaultPrevented, false);
    assert.equal(phone.channels.length, requests, 'F5 lists nothing while hidden');

    // The upload ends while hidden. The folder shown stays, and nothing is written.
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

test('while a file uploads, folders open and folder operations run; the folder it went to is listed again when it ends', async (t) => {
    const { client, phone, settle, upload, dialog, wrapper } = openFiles(t);
    await settle();
    upload({ folder: '/sdcard' });
    assert.equal(wrapper.querySelector('.fx-transfers').children.length, 1, 'an upload to /sdcard runs');
    client.navigate('/sdcard/DCIM');
    await settle();
    assert.equal(client.getPath(), '/sdcard/DCIM', 'another folder opens');
    assert.equal(phone.asked('LIST').at(-1), '/sdcard/DCIM');
    client.runCommand('new-folder');
    await settle();
    assert.equal(dialog.open, true, 'New folder asks for a name');
    dialog.querySelector('input[name="value"]').value = 'Trips';
    dialog.dispatch('submit', { submitter: Object.assign(new FakeButton('button'), { value: 'confirm' }) });
    await settle();
    assert.deepEqual(phone.asked('MKDR'), ['/sdcard/DCIM/Trips'], 'and a folder operation goes out');
    await settle();
    const lists = phone.asked('LIST').length;
    upload({ folder: '/sdcard', finished: true, sent: 10, message: 'Uploaded' });
    await settle();
    assert.equal(phone.asked('LIST').length, lists, 'the end of an upload to another folder lists nothing');
    assert.equal(client.getPath(), '/sdcard/DCIM');
    // An upload to the folder that is shown lists it again when it ends.
    upload({ key: 2, folder: '/sdcard/DCIM' });
    upload({ key: 2, folder: '/sdcard/DCIM', finished: true, sent: 10, message: 'Uploaded' });
    await settle();
    assert.equal(phone.asked('LIST').length, lists + 1);
    assert.equal(phone.asked('LIST').at(-1), '/sdcard/DCIM');
});

test('files dropped while others upload are taken; a drop while a folder loads is refused and says why', async (t) => {
    const { client, settle, upload, toasts } = openFiles(t);
    await settle();
    upload({ folder: '/sdcard' });
    assert.equal(client.onDrop(), true, 'a drop during an upload is taken');
    assert.deepEqual(toasts, []);
    client.navigate('/sdcard/DCIM');
    assert.equal(client.onDrop(), false, 'a drop while a folder loads is not');
    assert.deepEqual(toasts.at(-1), { message: 'Wait for the current folder or operation to finish before adding files.', error: false });
});

test('an upload row shows the name, a bar, how much of how much is sent, and Cancel', async (t) => {
    const { settle, upload, wrapper } = openFiles(t);
    await settle();
    upload({ size: 2 * 1024 * 1024 });
    const row = wrapper.querySelector('.fx-transfers').children[0];
    assert.ok(row.innerHTML.includes('class="fx-upload-name">clip.bin</span>'));
    assert.ok(row.innerHTML.includes('role="progressbar" aria-label="Upload of clip.bin"'));
    assert.ok(row.innerHTML.includes('aria-label="Cancel the upload of clip.bin">Cancel</button>'));
    const bar = row.querySelector('.fx-upload-bar');
    const state = row.querySelector('.fx-upload-state');
    assert.equal(state.textContent, 'Waiting');
    assert.equal(bar.getAttribute('aria-valuetext'), '0 B of 2.0 MB');
    upload({ size: 2 * 1024 * 1024, sent: 512 * 1024, message: '' });
    assert.equal(state.textContent, '512 KB of 2.0 MB', 'bytes of total while it sends');
    assert.equal(bar.getAttribute('aria-valuenow'), '25');
    assert.equal(row.querySelector('.fx-upload-fill').style.width, '25%');
    assert.equal(row.querySelector('.fx-upload-cancel').hidden, false);
    upload({ size: 2 * 1024 * 1024, sent: 2 * 1024 * 1024, message: 'Saving', cancellable: false });
    assert.equal(state.textContent, 'Saving');
    assert.equal(bar.getAttribute('aria-valuenow'), '100');
    assert.equal(row.querySelector('.fx-upload-cancel').hidden, true, 'a file being saved cannot be stopped');
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

test('a question is written as the kit sheet, and Escape answers it at the key', async (t) => {
    const { tab, client, dialog, settle } = openFiles(t);
    await settle();
    tab.press();
    const plan = client.planUploads([{ name: 'notes.txt' }, { name: 'new.txt' }]);
    await settle();
    assert.equal(dialog.open, true);
    const markup = dialog.innerHTML;
    for (const part of ['backdrop', 'panel', 'header', 'handle', 'title', 'close', 'body', 'footer']) {
        assert.ok(markup.includes(`kit-sheet-${part}`), `the sheet has its ${part}`);
    }
    assert.equal(/fx-button|fx-primary|fx-danger/.test(markup), false, 'no button of the older kind');
    assert.ok(markup.includes('class="kit-button" value="keep"'), 'the answers are kit buttons');
    assert.ok(markup.includes('class="kit-button kit-button-danger-solid" value="replace"'), 'Replace, the answer that removes, is on the solid danger fill');
    assert.equal(/kit-confirm/.test(markup), false, 'and borrows nothing of the confirm prompt');
    assert.ok(markup.includes('aria-label="Close this question"'), 'the close button has a name');
    // Escape is answered at keydown, so the browser raises no close request of its own.
    let stopped = false;
    const key = dialog.dispatch('keydown', { key: 'Escape', isComposing: false, stopPropagation: () => (stopped = true) });
    assert.equal(key.defaultPrevented && stopped, true);
    await settle();
    assert.equal(dialog.open, false, 'Escape closes the question');
    assert.deepEqual((await plan).map((upload) => upload.name), ['new.txt'], 'which skips the file');
    // A second Escape while the dialog is closed answers nothing and throws nothing.
    dialog.dispatch('keydown', { key: 'Escape', isComposing: false, stopPropagation: () => undefined });
    // The closed question gives up its entry a task later.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await settle();
    assert.equal(tab.history.state.nav.overlay, undefined);
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

// ------------------------------------------------------------------ large folders

/** The order the explorer had before FolderEntries: filter, then sort with localeCompare. */
function referenceOrder(entries, { sort, ascending, showHidden, filter }) {
    const { typeLabel } = require('../src/app/googDevice/client/fileTypes');
    const direction = ascending ? 1 : -1;
    return entries
        .filter((entry) => (showHidden || !entry.name.startsWith('.')) && (!filter || entry.name.toLowerCase().includes(filter)))
        .sort((a, b) => {
            const folders = Number(b.isDirectory()) - Number(a.isDirectory());
            if (folders) return folders;
            let result = 0;
            if (sort === 'size') result = (a.isDirectory() ? -1 : a.size) - (b.isDirectory() ? -1 : b.size);
            else if (sort === 'modified') result = a.mtime.getTime() - b.mtime.getTime();
            else if (sort === 'type') result = typeLabel(a).localeCompare(typeLabel(b));
            return (result || a.name.localeCompare(b.name, undefined, { numeric: true })) * direction;
        })
        .map((entry) => entry.name);
}

test('the folder is sorted once per change, in the order it had before, however often the list is read', () => {
    const { FolderEntries } = require('../src/app/googDevice/files/FolderEntries');
    const { Entry } = require('../src/app/googDevice/Entry');
    const folder = new FolderEntries();
    const arrangement = { sort: 'name', ascending: true, showHidden: false, filter: '' };
    folder.arrange(arrangement);
    for (let batch = 0; batch < 10; batch++) {
        folder.add(
            ...Array.from({ length: 500 }, (_, index) => new Entry(`IMG_${batch * 500 + index}.jpg`, 0o100644, index, 1700000000 + index)),
        );
        for (let read = 0; read < 5; read++) {
            folder.visible();
            folder.isShown('IMG_1.jpg');
            folder.hiddenCount();
        }
        assert.equal(folder.sorts, batch + 1, 'one sort for each batch of items');
    }
    assert.equal(folder.visible().length, 5000);
    assert.deepEqual(folder.visible().slice(8, 12).map((entry) => entry.name), ['IMG_8.jpg', 'IMG_9.jpg', 'IMG_10.jpg', 'IMG_11.jpg'], 'numbers in names sort by value');
    // The filter and the dot names filter the sorted list; they do not sort it again.
    folder.arrange({ ...arrangement, filter: 'img_49' });
    assert.equal(folder.visible().length, 1 + 10 + 100);
    assert.equal(folder.isShown('IMG_4950.jpg'), true);
    assert.equal(folder.isShown('IMG_50.jpg'), false);
    folder.arrange({ ...arrangement, showHidden: true });
    folder.visible();
    assert.equal(folder.sorts, 10, 'the filter sorts nothing');
    folder.arrange({ ...arrangement, showHidden: true, ascending: false });
    folder.visible();
    folder.visible();
    assert.equal(folder.sorts, 11, 'a new order is one sort');
    assert.equal(folder.visible()[0].name, 'IMG_4999.jpg', 'and is what the list shows');
    folder.arrange({ ...arrangement, showHidden: true, ascending: false, sort: 'size' });
    assert.equal(folder.visible()[0].name, 'IMG_4999.jpg', 'the largest first');
    folder.arrange({ ...arrangement, showHidden: true, ascending: true, sort: 'size' });
    assert.equal(folder.visible()[0].name, 'IMG_0.jpg');
    assert.equal(folder.sorts, 13);

    // Every column and direction gives the order of before, folders first and dot names hidden.
    const mixed = new FolderEntries();
    const items = [
        new Entry('Camera', 0o40755, 0, 1700000300),
        new Entry('.thumbnails', 0o40755, 0, 1700000100),
        new Entry('file10.txt', 0o100644, 30, 1700000200),
        new Entry('file9.txt', 0o100644, 30, 1700000200),
        new Entry('File01.txt', 0o100644, 5, 1700000400),
        new Entry('clip.MP4', 0o100644, 9000, 1700000050),
        new Entry('.nomedia', 0o100644, 0, 1700000000),
        new Entry('archive.tar.gz', 0o100644, 70, 1700000600),
        new Entry('Notes', 0o120777, 0, 1700000500),
        new Entry('é.png', 0o100644, 1, 1700000700),
    ];
    mixed.add(...items);
    for (const filter of ['', 'file']) {
        for (const showHidden of [false, true]) {
            for (const sort of ['name', 'size', 'type', 'modified']) {
                for (const ascending of [true, false]) {
                    const order = { sort, ascending, showHidden, filter };
                    mixed.arrange(order);
                    assert.deepEqual(mixed.visible().map((entry) => entry.name), referenceOrder(items, order), JSON.stringify(order));
                    assert.equal(mixed.hiddenCount(), showHidden ? 0 : 2);
                }
            }
        }
    }
    // An item listed again (its true size, say) keeps its place among the items.
    mixed.add(new Entry('clip.MP4', 0o100644, 5 * 1024 ** 3, 1700000050));
    assert.equal(mixed.indexOf('clip.MP4'), 5);
    assert.equal(mixed.get('clip.MP4').size, 5 * 1024 ** 3);
    assert.equal(mixed.size, items.length);
});

test('a row is built once for its item: the filter and a new order move rows, and a changed item is built again', () => {
    const { KeyedRows } = require('../src/app/googDevice/files/KeyedRows');
    const body = new FakeElement('tbody');
    const rows = new KeyedRows(
        body,
        (item) => item.name,
        (items) => items.map((item) => Object.assign(new FakeElement('tr'), { dataset: { name: item.name } })),
        (before, after) => before.size === after.size,
    );
    const items = Array.from({ length: 1000 }, (_, index) => ({ name: `n${index}`, size: 1 }));
    rows.show(items);
    assert.equal(rows.built, 1000);
    const all = [...body.children];
    assert.deepEqual(all.map((row) => row.dataset.name), items.map((item) => item.name));
    const same = (expected) => body.children.length === expected.length && body.children.every((row, index) => row === expected[index]);

    rows.show(items.filter((_, index) => index % 7 === 0));
    assert.equal(rows.built, 1000, 'the filter builds no row');
    assert.ok(same(all.filter((_, index) => index % 7 === 0)), 'the rows that stay are the same rows');
    rows.show(items);
    assert.ok(same(all), 'and those that come back are the ones from before');
    rows.show([...items].reverse());
    assert.equal(rows.built, 1000, 'a new order builds no row');
    assert.ok(same([...all].reverse()));
    rows.show(items.map((item) => (item.name === 'n3' ? { ...item, size: 2 } : item)));
    assert.equal(rows.built, 1001, 'an item that changed gets a new row');
    assert.notEqual(body.children[3], all[3]);
    assert.ok(body.children.every((row, index) => index === 3 || row === all[index]));
    // With nothing to show, the body holds the line that says so.
    const empty = new FakeElement('tr');
    rows.show([], { after: empty });
    assert.deepEqual(body.children, [empty]);
    assert.deepEqual(rows.shown(), []);
});

/** A phone whose listings the test feeds by hand, one burst of items at a time. */
function streamPhone(Multiplexer) {
    const lists = [];
    const waiting = [];
    const socket = Object.assign(Object.create(Multiplexer.prototype), {
        OPEN: 1,
        readyState: 1,
        close: () => undefined,
        createChannel(payload) {
            const listeners = { message: new Set(), close: new Set() };
            const channel = {
                command: payload.subarray(0, 4).toString(),
                open: true,
                addEventListener: (type, listener) => listeners[type]?.add(listener),
                removeEventListener: (type, listener) => listeners[type]?.delete(listener),
                send: () => undefined,
                reply: (data) => [...listeners.message].forEach((listener) => listener({ data })),
                end(code = 1000) {
                    if (!channel.open) return;
                    channel.open = false;
                    [...listeners.close].forEach((listener) => listener({ code, reason: '' }));
                },
                close: (code) => channel.end(code),
            };
            (channel.command === 'LIST' ? lists : waiting).push(channel);
            return channel;
        },
    });
    return {
        socket,
        lists,
        serve() {
            waiting.splice(0).forEach((channel) => {
                if (channel.command === 'STAT') channel.reply(statReply(0o40755));
                if (channel.command === 'SIZE') channel.reply(Buffer.from('DONE'));
                channel.end();
            });
        },
    };
}

test('a folder of 5,000 items: sorted once per change, rows added at most every 250 ms, and the filter builds no row that stays', async (t) => {
    const { client, phone, wrapper, frames } = openFiles(t, '/sdcard/DCIM/Camera', streamPhone);
    // Frames come as they would in a browser. The list shows 20 rows of 33px at a time.
    const pump = setInterval(() => frames.splice(0).forEach((run) => run()), 16);
    t.after(() => clearInterval(pump));
    const items = wrapper.querySelector('.fx-items');
    const tbody = wrapper.querySelector('tbody');
    items.clientHeight = 660;
    items.scrollTop = 0;
    tbody.layout = () => ({ left: 0, top: -items.scrollTop, right: 0, bottom: 0, width: 0, height: 0 });
    for (let round = 0; round < 5 && !phone.lists.length; round++) {
        phone.serve();
        await later();
    }
    const [list] = phone.lists;
    assert.ok(list, 'the folder is listed');
    const renders = [];
    const render = client.renderItems.bind(client);
    client.renderItems = () => {
        renders.push(performance.now());
        render();
    };
    const sortsBefore = client.folder.sorts;
    // 5,000 items over about a second, in bursts of 250: the way a large folder arrives.
    for (let burst = 0; burst < 20; burst++) {
        for (let index = 0; index < 250; index++) list.reply(record('DENT', `IMG_${burst * 250 + index}.jpg`, 0o100644, 2048));
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const whileArriving = renders.length;
    const sortsWhileArriving = client.folder.sorts - sortsBefore;
    list.end(0);
    await later();
    phone.serve();
    await later();
    const gaps = renders.slice(1, whileArriving).map((at, index) => at - renders[index]);
    assert.ok(whileArriving >= 2 && whileArriving <= 6, `${whileArriving} renders while 5,000 items arrived over a second`);
    assert.ok(gaps.every((gap) => gap >= 245), `at least 250 ms apart: ${gaps.map(Math.round).join(', ')}`);
    assert.equal(renders.length, whileArriving + 1, 'and one at once when the listing ends');
    assert.ok(sortsWhileArriving <= whileArriving, `${sortsWhileArriving} sorts in ${whileArriving} renders, not one per frame`);
    assert.ok(client.folder.sorts - sortsBefore <= renders.length, 'at most one sort for each render');

    // Only the rows near the view are in the document; a spacer stands for the rest.
    const rows = () => tbody.children.filter((row) => !row.classes.has('fx-spacer'));
    const spacers = () => tbody.children.filter((row) => row.classes.has('fx-spacer')).map((row) => parseFloat(row.style.height));
    assert.deepEqual(rows().map((row) => row.dataset.name).slice(0, 3), ['IMG_0.jpg', 'IMG_1.jpg', 'IMG_2.jpg']);
    assert.ok(rows().length >= 20 && rows().length <= 40, `${rows().length} rows in the document`);
    assert.deepEqual(spacers(), [(5000 - rows().length) * 33], 'the spacer is as tall as the rows it stands for');
    const built = client.rows.built;
    assert.ok(built <= 200, `${built} rows built for 5,000 items`);

    // Scrolled half way down, the rows there are in the document, with a spacer on each side.
    items.scrollTop = 2500 * 33;
    items.dispatch('scroll');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const names = rows().map((row) => row.dataset.name);
    assert.ok(names.includes('IMG_2500.jpg') && names.includes('IMG_2519.jpg'), names.join(' '));
    const [before, after] = spacers();
    assert.equal(before + rows().length * 33 + after, 5000 * 33, 'the list keeps its height');
    assert.equal(tbody.children.length, rows().length + 2);

    // Typing in the filter: rows that stay in view are the same rows, and nothing is sorted.
    items.scrollTop = 0;
    items.dispatch('scroll');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const sorts = client.folder.sorts;
    const filter = wrapper.querySelector('.fx-filter-input');
    for (const text of ['IMG_1', 'IMG_1', 'IMG_19', 'IMG_1', '']) {
        const seen = new Map(rows().map((row) => [row.dataset.name, row]));
        filter.value = text;
        filter.dispatch('input');
        const now = rows();
        assert.ok(now.length > 0 && now.every((row) => row.dataset.name.toLowerCase().includes(text.toLowerCase())), text);
        const kept = now.filter((row) => seen.has(row.dataset.name));
        assert.ok(kept.every((row) => seen.get(row.dataset.name) === row), `"${text}": a row that stays is the row from before`);
    }
    assert.equal(client.folder.sorts, sorts, 'the filter sorted nothing');
    assert.ok(client.rows.built < built + 200, 'and built only rows that came into view');
});

/**
 * A list of 1,000 items, of which about one row in three is taller, in no regular order, as
 * tiles are where some names take two lines and folders have no size. `scrollTo` scrolls it as
 * the owner does and notes when a row in view where the scroll lands moves once the rows near
 * the view have changed.
 */
async function unevenList(t) {
    const rowHeight = FakeElement.prototype.rowHeight;
    const tall = (name) => (Number(/\d+/.exec(name)[0]) * 7919) % 13 < 4;
    t.mock.method(FakeElement.prototype, 'rowHeight', function () {
        return this.dataset?.name !== undefined && tall(this.dataset.name) ? 49 : rowHeight.call(this);
    });
    const { client, phone, wrapper, frames } = openFiles(t, '/sdcard/Download', streamPhone);
    const pump = setInterval(() => frames.splice(0).forEach((run) => run()), 16);
    t.after(() => clearInterval(pump));
    const items = wrapper.querySelector('.fx-items');
    const tbody = wrapper.querySelector('tbody');
    items.clientHeight = 660;
    items.clientWidth = 390;
    items.scrollTop = 0;
    tbody.layout = () => ({ left: 0, top: -items.scrollTop, right: 0, bottom: 0, width: 0, height: 0 });
    for (let round = 0; round < 5 && !phone.lists.length; round++) {
        phone.serve();
        await later();
    }
    const [list] = phone.lists;
    for (let index = 0; index < 1000; index++) list.reply(record('DENT', `IMG_${index}.jpg`, 0o100644, 2048));
    list.end(0);
    await later();
    phone.serve();
    await later();
    const length = () => tbody.children.reduce((total, row) => total + row.rowHeight(), 0);
    const inView = () =>
        tbody.children.filter((row) => {
            const box = row.getBoundingClientRect();
            return !row.classes.has('fx-spacer') && box.bottom > 0 && box.top < items.clientHeight;
        });
    const moved = [];
    /** Runs `change`, then the frame it asked for, and notes whether the first row in view moved. */
    const steady = (change) => {
        const [anchor] = inView();
        const before = anchor.getBoundingClientRect().top;
        change();
        frames.splice(0).forEach((run) => run());
        const row = client.rows.element(anchor.dataset.name);
        const after = row.isConnected ? row.getBoundingClientRect().top : NaN;
        if (!(Math.abs(after - before) < 1)) moved.push(`${anchor.dataset.name} ${before} to ${after}`);
    };
    const scrollTo = (top) => {
        items.scrollTop = Math.max(0, Math.min(top, length() - items.clientHeight));
        steady(() => items.dispatch('scroll'));
        assert.ok(inView().length >= 13, `the view is full of rows at ${items.scrollTop}`);
    };
    return { client, items, frames, length, tall, moved, inView, steady, scrollTo };
}

test('a long list whose lines differ in height: what is in view stays in place while it scrolls', async (t) => {
    const { items, length, tall, moved, scrollTo } = await unevenList(t);
    // The owner scrolls down to the end and back up, about eight lines at a time.
    while (items.scrollTop < length() - items.clientHeight) scrollTo(items.scrollTop + 300);
    while (items.scrollTop > 0) scrollTo(items.scrollTop - 300);
    assert.deepEqual(moved, [], 'nothing in view moved');
    // Every line has been in the document, so the spacers stand for the rows as tall as they
    // are. The last line was never followed by another and keeps the mean.
    const rows = Array.from({ length: 1000 }, (_, index) => (tall(`IMG_${index}`) ? 49 : 33));
    const total = rows.reduce((sum, height) => sum + height, 0);
    assert.ok(Math.abs(length() - total) <= 16, `the list is ${length()} px long, its rows ${total} px`);
});

test('a long list keeps the measures of its rows while its tab is hidden, and forgets them at a new width', async (t) => {
    const observers = [];
    global.ResizeObserver = class {
        constructor(callback) {
            observers.push(callback);
        }
        observe() {}
        disconnect() {}
    };
    t.after(() => delete global.ResizeObserver);
    const { client, items, frames, moved, inView, steady, scrollTo } = await unevenList(t);
    const resized = (width, height) => {
        items.clientWidth = width;
        items.clientHeight = height;
        observers.forEach((callback) => callback([]));
    };
    // The first report of a new observer.
    resized(390, 660);
    frames.splice(0).forEach((run) => run());
    while (items.scrollTop < 15000) scrollTo(items.scrollTop + 300);
    assert.deepEqual(moved, []);
    // Another tab of the phone is shown, then Files again: the list had no size meanwhile.
    resized(0, 0);
    steady(() => resized(390, 660));
    assert.deepEqual(moved, [], 'the rows in view are where they were');
    // A new height changes only which rows are in view.
    resized(390, 500);
    assert.ok(client.rowGeometry, 'a new height keeps the measures');
    // A new width can change how tall the rows are.
    resized(600, 500);
    assert.equal(client.rowGeometry, undefined, 'a new width forgets them');
    frames.splice(0).forEach((run) => run());
    assert.ok(inView().length >= 10, 'and the rows near the view are measured again');
});

// ------------------------------------------------------------------ what goes over the wire
//
// A fixed script of actions, and every frame the explorer sends for it: the payload that opens
// each channel, what it sends on it and whether it closes it. The phone answers the way the
// server does (a LIST ends with a close and no DONE, a STAT with its reply and a close). The
// frames were recorded from the explorer before its requests moved into FileService and must
// not change. FILES_WIRE_RECORD=1 writes the record again.

const WIRE_RECORD = path.join(__dirname, 'fixtures', 'files-wire.json');

/** A phone that answers the server's way and records every frame the explorer sends. */
function wirePhone(Multiplexer) {
    const DIR = 0o40755;
    const FILE = 0o100644;
    const GIB5 = 5 * 1024 ** 3 + 7;
    const folders = {
        '/sdcard': [['DCIM', DIR], ['Music', DIR], ['Movies', DIR], ['Denied', DIR], ['notes.txt', FILE, 12], ['photo.png', FILE, 2048]],
        '/sdcard/DCIM': [['Camera', DIR], ['big.mp4', FILE, GIB5 % 2 ** 32], ['notes.txt', FILE, 12]],
        '/sdcard/Music': [['notes.txt', FILE, 12], ['photo.png', FILE, 2048]],
        '/sdcard/Movies': [],
        '/sdcard/Denied': [],
    };
    const large = { '/sdcard/DCIM': [['big.mp4', GIB5]] };
    const describe = (data) => {
        const buffer = Buffer.from(data);
        if (buffer.length <= 48) return buffer.toString('hex');
        const digest = require('node:crypto').createHash('sha256').update(buffer).digest('hex').slice(0, 16);
        return `${buffer.subarray(0, 24).toString('hex')}... ${buffer.length} bytes, sha256 ${digest}`;
    };
    const record = { channels: [], rootClosed: 0 };
    const pending = [];
    let nextPushId = 40;
    const stringOf = (payload) => payload.subarray(8, 8 + payload.readUInt32LE(4)).toString();
    const socket = Object.assign(Object.create(Multiplexer.prototype), {
        OPEN: 1,
        readyState: 1,
        close: () => record.rootClosed++,
        createChannel(payload) {
            const listeners = { message: new Set(), close: new Set() };
            const seen = { open: describe(payload), sent: [], closed: null };
            record.channels.push(seen);
            const channel = {
                OPEN: 1,
                CLOSED: 3,
                readyState: 1,
                payload: Buffer.from(payload),
                inbox: [],
                addEventListener: (type, listener) => listeners[type]?.add(listener),
                removeEventListener: (type, listener) => listeners[type]?.delete(listener),
                send(data) {
                    if (channel.readyState !== 1) throw Error('Socket is already in CLOSING or CLOSED state.');
                    seen.sent.push(describe(data));
                    channel.inbox.push(Buffer.from(data));
                },
                reply: (data) => channel.readyState === 1 && [...listeners.message].forEach((listener) => listener({ data })),
                end(code = 1000, reason = '') {
                    if (channel.readyState !== 1) return;
                    channel.readyState = 3;
                    [...listeners.close].forEach((listener) => listener({ code, reason }));
                },
                close(code = 1000, reason) {
                    if (channel.readyState !== 1) return;
                    seen.closed = `client ${code}${reason ? ` ${reason}` : ''}`;
                    channel.end(code, reason);
                },
            };
            pending.push(channel);
            return channel;
        },
    });
    const dent = (name, mode, size = 0) => {
        const text = Buffer.from(name);
        const data = Buffer.alloc(20 + text.length);
        data.write('DENT');
        data.writeUInt32LE(mode, 4);
        data.writeUInt32LE(size, 8);
        data.writeUInt32LE(1700000000, 12);
        data.writeUInt32LE(text.length, 16);
        text.copy(data, 20);
        return data;
    };
    const fail = (message) => {
        const text = Buffer.from(message);
        const data = Buffer.alloc(8 + text.length);
        data.write('FAIL');
        data.writeUInt32LE(text.length, 4);
        text.copy(data, 8);
        return data;
    };
    const pushReply = (id, code) => {
        const data = Buffer.alloc(3);
        data.writeInt16BE(id);
        data.writeInt8(code, 2);
        return data;
    };
    const phone = {
        socket,
        record,
        /** While set, upload chunks are not acknowledged. */
        holdAppends: false,
        /** Answers what each channel has asked for, the way the server would. */
        serve() {
            for (const channel of [...pending]) {
                if (channel.readyState !== 1) {
                    pending.splice(pending.indexOf(channel), 1);
                    continue;
                }
                const command = channel.payload.subarray(0, 4).toString();
                if (command === 'SEND') {
                    while (channel.inbox.length && channel.readyState === 1) {
                        const message = CommandControlMessage.pushFileCommandFromBuffer(channel.inbox[0]);
                        if (message.state === FilePushState.APPEND && phone.holdAppends) break;
                        channel.inbox.shift();
                        if (message.state === FilePushState.NEW) {
                            channel.pushId = nextPushId++;
                            channel.reply(pushReply(channel.pushId, 1));
                        } else if (message.state === FilePushState.START || message.state === FilePushState.APPEND) {
                            channel.reply(pushReply(channel.pushId, 0));
                        } else if (message.state === FilePushState.FINISH) {
                            channel.reply(pushReply(channel.pushId, 0));
                            channel.end();
                        }
                    }
                    continue;
                }
                if (channel.answered) continue;
                channel.answered = true;
                const target = command === 'DELE' ? '' : stringOf(channel.payload);
                if (command === 'STAT') {
                    const name = path.posix.basename(target);
                    const parent = folders[path.posix.dirname(target)] || [];
                    const item = target in folders ? ['', DIR] : parent.find(([entry]) => entry === name);
                    const data = Buffer.alloc(16);
                    data.write('STAT');
                    data.writeUInt32LE(item ? item[1] : 0, 4);
                    data.writeUInt32LE(item?.[2] || 0, 8);
                    data.writeUInt32LE(1700000000, 12);
                    channel.reply(data);
                    channel.end();
                } else if (command === 'LIST') {
                    if (target.endsWith('/Denied')) {
                        channel.reply(fail('Permission denied'));
                        channel.end();
                        continue;
                    }
                    (folders[target] || []).forEach(([name, mode, size]) => channel.reply(dent(name, mode, size)));
                    channel.end(0);
                } else if (command === 'SIZE') {
                    (large[target] || []).forEach(([name, size]) => {
                        const text = Buffer.from(name);
                        const data = Buffer.alloc(16 + text.length);
                        data.write('SIZE');
                        data.writeUInt32LE(size % 2 ** 32, 4);
                        data.writeUInt32LE(Math.floor(size / 2 ** 32), 8);
                        data.writeUInt32LE(text.length, 12);
                        text.copy(data, 16);
                        channel.reply(data);
                    });
                    channel.reply(Buffer.from('DONE'));
                    channel.end();
                } else if (command === 'MKDR' && target.endsWith('/Locked')) {
                    channel.reply(fail('Read-only file system'));
                    channel.end();
                } else {
                    channel.reply(Buffer.from('DONE'));
                    channel.end();
                }
            }
        },
    };
    return phone;
}

/** Runs the fixed script and returns what the explorer sent and what it told the owner. */
async function wireScript(t) {
    const files = openFiles(t, '/sdcard', wirePhone);
    const { client, phone, dialog, toasts } = files;
    // Until nothing is left to answer: uploads read their file and wait for acknowledgements.
    const settle = async () => {
        for (let quiet = 0, round = 0; quiet < 3 && round < 200; round++) {
            const before = JSON.stringify(phone.record);
            await files.settle();
            quiet = JSON.stringify(phone.record) === before ? quiet + 1 : 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        await files.settle();
    };
    const answer = async (value, text) => {
        await settle();
        assert.equal(dialog.open, true, `a question is open for ${value}`);
        if (text !== undefined) dialog.querySelector('input[name="value"]').value = text;
        dialog.dispatch('submit', { submitter: Object.assign(new FakeButton('button'), { value }) });
        await settle();
    };
    await settle();
    client.navigate('/sdcard/DCIM');
    await settle();
    client.runCommand('new-folder');
    await answer('confirm', 'Trips');
    client.runCommand('rename', ['big.mp4']);
    await answer('confirm', 'clip.mp4');
    client.runCommand('delete', ['Camera', 'big.mp4']);
    await answer('confirm');
    client.runCommand('copy', ['notes.txt']);
    client.navigate('/sdcard/Music');
    await settle();
    client.runCommand('paste');
    await answer('replace');
    client.runCommand('cut', ['photo.png']);
    client.navigate('/sdcard');
    await settle();
    client.runCommand('paste');
    await answer('keep');
    client.runCommand('new-folder');
    await answer('confirm', 'Locked');
    // A folder step that a second one overtakes, a folder that is not there, one that refuses.
    client.navigate('/sdcard/Movies');
    client.navigate('/sdcard/Music');
    await settle();
    const failures = [];
    client.navigate('/sdcard/Nowhere');
    await settle();
    failures.push(client.listingError);
    client.navigate('/sdcard/Denied');
    await settle();
    failures.push(client.listingError);
    client.navigate('/sdcard');
    await settle();
    client.open('notes.txt');
    // Uploads: a new name, a replaced name, and one that is cancelled while it sends.
    client.filePushHandler.onFilesDrop([new File([Buffer.alloc(70000, 3)], 'clip.bin')]);
    await settle();
    client.filePushHandler.onFilesDrop([new File([Buffer.from('replaced')], 'notes.txt')]);
    await answer('replace');
    phone.holdAppends = true;
    client.filePushHandler.onFilesDrop([new File([Buffer.alloc(200000, 5)], 'cancelled.bin')]);
    await settle();
    client.filePushHandler.cancelAll();
    phone.holdAppends = false;
    await settle();
    client.stop();
    return {
        init: client.getChannelInitData().toString('hex'),
        ...phone.record,
        downloads: global.document.clicked || [],
        failures,
        toasts: toasts.map(({ message, error }) => `${error ? 'error' : 'result'}: ${message}`),
    };
}

test('the explorer sends the same frames for a fixed script of actions as before FileService', async (t) => {
    const seen = await wireScript(t);
    assert.ok(seen.channels.length > 30, `the script ran (${seen.channels.length} channels)`);
    if (process.env.FILES_WIRE_RECORD) {
        fs.writeFileSync(WIRE_RECORD, `${JSON.stringify(seen, null, 1)}\n`);
    }
    assert.deepEqual(seen, JSON.parse(fs.readFileSync(WIRE_RECORD, 'utf8')));
});
