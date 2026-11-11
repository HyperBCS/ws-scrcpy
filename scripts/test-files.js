// Files tool: the upload wire format, upload ids and downloads. No device is touched.
const assert = require('node:assert/strict');
const { test } = require('node:test');
global.__PATHNAME__ = '/';
require('ts-node').register({ transpileOnly: true });
require.extensions['.jar'] = () => {};
require.cache[require.resolve('../vendor/Genymobile/scrcpy/LICENSE')] = { exports: {} };

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
