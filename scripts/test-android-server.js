// Run with: node --test scripts/test-android-server.js
// Android server lifecycle: adb helpers, device tracking and the scrcpy process. No device needed.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-android-server-'));
const previousConfigPath = process.env.WS_SCRCPY_STREAM_CONFIG_PATH;
process.env.WS_SCRCPY_STREAM_CONFIG_PATH = path.join(temporary, 'stream-config.json');
const previousDataDir = process.env.WS_NOTIFICATION_DATA;
process.env.WS_NOTIFICATION_DATA = path.join(temporary, 'data');
require('ts-node').register({ transpileOnly: true });
// Webpack treats these imports as assets. Node only needs the surrounding server classes.
require.extensions['.jar'] = () => {};
require.cache[require.resolve('../vendor/Genymobile/scrcpy/LICENSE')] = { exports: {} };

const portfinder = require('portfinder');
const { AdbUtils } = require('../src/server/goog-device/AdbUtils');
const { AdbExtended } = require('../src/server/goog-device/adb');
const { ExtendedClient } = require('../src/server/goog-device/adb/ExtendedClient');
const { ExtendedSync } = require('../src/server/goog-device/adb/ExtendedSync');

after(() => {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (previousConfigPath === undefined) delete process.env.WS_SCRCPY_STREAM_CONFIG_PATH;
    else process.env.WS_SCRCPY_STREAM_CONFIG_PATH = previousConfigPath;
    if (previousDataDir === undefined) delete process.env.WS_NOTIFICATION_DATA;
    else process.env.WS_NOTIFICATION_DATA = previousDataDir;
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// A multiplexer channel as the server sees it: sending on a closed one throws.
class Channel extends EventEmitter {
    OPEN = 1;
    CLOSED = 3;
    readyState = 1;
    sent = [];
    closes = [];
    send(data) {
        if (this.readyState !== this.OPEN) throw Error('Socket is already in CLOSING or CLOSED state.');
        this.sent.push(Buffer.from(data));
    }
    close(code, reason) {
        if (this.readyState === this.CLOSED) return;
        this.readyState = this.CLOSED;
        this.closes.push({ code, reason });
    }
}

// The adb sync connection: replies are served from a list, one read at a time.
function syncFixture(replies) {
    const connection = {
        ended: 0,
        written: [],
        write: (data) => connection.written.push(data),
        end: () => connection.ended++,
        parser: {
            readAscii: async () => {
                const next = replies.shift();
                if (next instanceof Error) throw next;
                return typeof next === 'function' ? next() : next;
            },
            readBytes: async () => {
                const next = replies.shift();
                return typeof next === 'function' ? next() : next;
            },
            unexpected: async (reply, expected) => {
                throw Error(`Unexpected '${reply}', was expecting ${expected}`);
            },
            end: async () => {},
        },
    };
    return connection;
}

function dirEntry(name) {
    const stat = Buffer.alloc(16);
    stat.writeUInt32LE(Buffer.byteLength(name), 12);
    return ['DENT', stat, Buffer.from(name)];
}

async function listFolder(t, replies, channel) {
    const connection = syncFixture(replies);
    const client = Object.create(ExtendedClient.prototype);
    client.pipeSyncService = async () => new ExtendedSync(connection);
    const result = await client.pipeReadDir('serial', '/sdcard/DCIM', channel).then(
        () => undefined,
        (error) => error,
    );
    return { connection, result };
}

test('a folder listing ends its adb connection when it completes', async (t) => {
    const channel = new Channel();
    const { connection, result } = await listFolder(
        t,
        [...dirEntry('a.jpg'), ...dirEntry('b.jpg'), 'DONE', Buffer.alloc(16)],
        channel,
    );
    assert.equal(result, undefined);
    assert.equal(channel.sent.length, 2);
    assert.deepEqual(channel.closes, [{ code: 0, reason: undefined }]);
    assert.equal(connection.ended, 1);
});

test('a folder listing ends its adb connection when the browser leaves before the list arrives', async (t) => {
    const channel = new Channel();
    const second = dirEntry('b.jpg');
    // The channel closes while the second entry is being read from the phone.
    second[2] = () => {
        channel.close(1000);
        return Buffer.from('b.jpg');
    };
    const replies = [...dirEntry('a.jpg'), ...second, ...dirEntry('c.jpg'), 'DONE', Buffer.alloc(16)];
    const { connection, result } = await listFolder(t, replies, channel);
    assert.equal(result, undefined, 'a closed channel is not an error');
    assert.equal(channel.sent.length, 1, 'nothing is sent on the closed channel');
    assert.equal(connection.ended, 1, 'the adb connection is closed');
    assert.equal(replies.length, 5, 'the rest of the listing is not read');
});

test('a folder listing ends its adb connection when the phone sends something unexpected', async (t) => {
    const channel = new Channel();
    const { connection, result } = await listFolder(t, [...dirEntry('a.jpg'), 'WHAT'], channel);
    assert.match(result.message, /Unexpected 'WHAT'/);
    assert.equal(connection.ended, 1);
    const broken = await listFolder(t, [Error('adb connection lost')], new Channel());
    assert.match(broken.result.message, /connection lost/);
    assert.equal(broken.connection.ended, 1);
});
