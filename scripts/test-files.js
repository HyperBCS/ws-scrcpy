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
