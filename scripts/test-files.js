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
