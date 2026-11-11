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
