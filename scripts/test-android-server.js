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
const { Device } = require('../src/server/goog-device/Device');
const { ControlCenter: AndroidControlCenter } = require('../src/server/goog-device/services/ControlCenter');
const { DeviceTracker: AndroidDeviceTracker } = require('../src/server/goog-device/mw/DeviceTracker');

// Nothing in this file may reach a real adb server. Every Device and ControlCenter built here
// gets this client in place of adbkit's, and it refuses every call. Tests that need adb to
// answer replace `createClient` themselves; when they end, this one is back.
const noAdb = new Proxy(
    {},
    {
        get: (_target, name) => {
            if (name === 'then') return undefined;
            return () => {
                throw Error(`adb must not be used in this test (${String(name)})`);
            };
        },
    },
);
AdbExtended.createClient = () => noAdb;

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

// Stands in for `adb shell`: records each command and answers with the status marker.
function shellFixture(t, answer = () => 0) {
    const commands = [];
    const client = {
        shell: async (_serial, command) => {
            commands.push(command);
            return { command, destroy() {} };
        },
    };
    t.mock.method(AdbExtended, 'createClient', () => client);
    t.mock.method(AdbExtended.util, 'readAll', async (stream) => {
        const code = answer(stream.command, commands.length);
        return Buffer.from(code === 0 ? '__rc=0\n' : `rm: refused\n__rc=${code}\n`);
    });
    return commands;
}

test('a large selection is deleted in batches that each fit in one adb request', async (t) => {
    const commands = shellFixture(t);
    // 1,200 Camera paths: one command would be about 69,600 bytes, and adb would cut it short.
    const paths = Array.from({ length: 1200 }, (_, index) => {
        return `/sdcard/DCIM/Camera/IMG_20261110_${String(index).padStart(6, '0')}_HDR_portrait.jpg`;
    });
    await AdbUtils.remove('serial', paths);
    assert.ok(commands.length > 1, 'more than one command is sent');
    const deleted = [];
    for (const command of commands) {
        assert.ok(Buffer.byteLength(command) < 33 * 1024, `a batch of ${Buffer.byteLength(command)} bytes`);
        const match = command.match(/^rm -rf -- (.*) 2>&1; echo "__rc=\$\?"$/);
        assert.ok(match, 'each batch is a complete rm command');
        deleted.push(...match[1].split(' ').map((item) => item.slice(1, -1)));
    }
    assert.deepEqual(deleted, paths, 'every path is deleted once, in order');
});

test('deleting stops at the first batch the device refuses', async (t) => {
    const commands = shellFixture(t, (_command, count) => (count === 2 ? 1 : 0));
    const paths = Array.from({ length: 1200 }, (_, index) => `/sdcard/DCIM/Camera/${'x'.repeat(40)}${index}.jpg`);
    await assert.rejects(AdbUtils.remove('serial', paths), /rm: refused/);
    assert.equal(commands.length, 2, 'no batch is sent after the failure');
});

test('a small selection is still one command, and names with quotes stay quoted', async (t) => {
    const commands = shellFixture(t);
    await AdbUtils.remove('serial', ['/sdcard/a b.txt', "/sdcard/it's.txt"]);
    assert.deepEqual(commands, [`rm -rf -- '/sdcard/a b.txt' '/sdcard/it'\\''s.txt' 2>&1; echo "__rc=$?"`]);
});

test('a shell command too long for one adb request is refused, not cut short', async (t) => {
    const commands = shellFixture(t);
    await assert.rejects(AdbUtils.shellExec('serial', `echo ${'x'.repeat(65001)}`), /too long/);
    assert.equal(commands.length, 0);
    assert.equal((await AdbUtils.shellExec('serial', `echo ${'x'.repeat(60000)}`)).code, 0);
});

// Stands in for the adb server's forward table.
function forwardFixture(t, { listDelay = () => tick(), refuse = () => false } = {}) {
    const adb = { forwards: [], requests: [] };
    const client = {
        listForwards: async () => {
            const snapshot = adb.forwards.map((item) => ({ ...item }));
            await listDelay();
            return snapshot;
        },
        forwardNoRebind: async (serial, local, remote) => {
            adb.requests.push({ serial, local, remote });
            await tick();
            if (refuse(local) || adb.forwards.some((item) => item.local === local)) {
                throw Error(`cannot rebind existing socket`);
            }
            adb.forwards.push({ serial, local, remote });
        },
        forward: async () => assert.fail('the rebinding form must not be used'),
    };
    t.mock.method(AdbExtended, 'createClient', () => client);
    // Only adb's own table decides which ports are taken here.
    t.mock.method(portfinder, 'getPortPromise', async (options = {}) => options.port || 8000);
    return adb;
}

test('two phones that start together get different forward ports', async (t) => {
    const adb = forwardFixture(t);
    const [first, second] = await Promise.all([
        AdbUtils.forward('phone-a', 'localabstract:scrcpy_0000aaaa'),
        AdbUtils.forward('phone-b', 'localabstract:scrcpy_0000aaaa'),
    ]);
    assert.notEqual(first, second);
    assert.deepEqual(
        adb.forwards.map((item) => `${item.serial} ${item.local}`),
        [`phone-a tcp:${first}`, `phone-b tcp:${second}`],
    );
    assert.equal(await AdbUtils.forward('phone-a', 'localabstract:scrcpy_0000aaaa'), first, 'a forward is reused');
    assert.equal(adb.requests.length, 2);
});

test('a port that another server took first is skipped, and its forward is left alone', async (t) => {
    // The other server's forward is made after this one listed the table.
    const adb = forwardFixture(t, { refuse: (local) => local === 'tcp:8000' });
    const port = await AdbUtils.forward('phone-a', 'localabstract:scrcpy_0000aaaa');
    assert.equal(port, 8001);
    assert.deepEqual(
        adb.requests.map((item) => item.local),
        ['tcp:8000', 'tcp:8001'],
    );
});

test('a failed forward is reported and does not block the next one', async (t) => {
    const adb = forwardFixture(t);
    const failing = AdbExtended.createClient();
    const forwardNoRebind = failing.forwardNoRebind;
    failing.forwardNoRebind = async () => {
        throw Error("device 'phone-a' not found");
    };
    await assert.rejects(AdbUtils.forward('phone-a', 'localabstract:scrcpy_0000aaaa'), /not found/);
    failing.forwardNoRebind = forwardNoRebind;
    assert.equal(await AdbUtils.forward('phone-b', 'localabstract:scrcpy_0000aaaa'), 8000);
    assert.equal(adb.forwards.length, 1);
});

// A browser socket as a middleware sees it.
class BrowserSocket extends EventEmitter {
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 1;
    sent = [];
    closes = [];
    addEventListener(name, listener) {
        this.on(name, listener);
    }
    removeEventListener(name, listener) {
        this.off(name, listener);
    }
    send(data) {
        assert.equal(this.readyState, this.OPEN, 'never send after close');
        this.sent.push(data);
    }
    close(code = 1000, reason = '') {
        if (this.readyState === this.CLOSED) return;
        this.closes.push({ code, reason });
        this.readyState = this.CLOSED;
        this.emit('close', { code, reason });
    }
    messages() {
        return this.sent.filter((item) => typeof item === 'string').map((item) => JSON.parse(item));
    }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The adb server as ControlCenter sees it. No Device here ever reaches a real adb: the state
// change that would start its polling is replaced.
function trackerFixture(t) {
    const adb = { down: false, devices: [], trackers: [], opened: 0 };
    t.mock.method(Device.prototype, 'setState', function (state) {
        this.descriptor.state = state;
        this.connected = state === 'device';
        this.emit('update', this);
    });
    // An open device list switches new devices to fast polling, which would read from adb.
    t.mock.method(Device.prototype, 'setRuntimeStatePollActive', () => {});
    const center = new AndroidControlCenter();
    center.waitAfterError = 5;
    center.client = {
        trackDevices: async () => {
            adb.opened++;
            await tick();
            if (adb.down) throw Error('connect ECONNREFUSED 127.0.0.1:5037');
            const tracker = new EventEmitter();
            tracker.ended = false;
            tracker.end = () => (tracker.ended = true);
            adb.trackers.push(tracker);
            return tracker;
        },
        listDevices: async () => {
            await tick();
            if (adb.down) throw Error('connect ECONNREFUSED 127.0.0.1:5037');
            return adb.devices.map((id) => ({ id, type: 'device' }));
        },
    };
    t.after(() => center.release());
    return { adb, center };
}

test('a phone that is gone after the adb tracker restarts becomes disconnected', async (t) => {
    const { adb, center } = trackerFixture(t);
    adb.devices = ['usb-phone', 'wifi-phone'];
    await center.start();
    assert.equal(center.getDevice('usb-phone').descriptor.state, 'device');
    assert.equal(center.getDevice('wifi-phone').descriptor.state, 'device');
    // adb restarts. The new tracker never saw the Wi-Fi phone, so it cannot report it removed.
    adb.devices = ['usb-phone'];
    adb.trackers[0].emit('end');
    await wait(40);
    assert.equal(adb.trackers.length, 2, 'the tracker was restarted');
    assert.equal(adb.trackers[0].ended, true);
    assert.equal(center.getDevice('wifi-phone').descriptor.state, 'disconnected');
    assert.equal(center.getDevice('wifi-phone').isConnected(), false);
    assert.equal(center.getDevice('usb-phone').descriptor.state, 'device');
});

test('callers that start the tracker together open one adb tracker', async (t) => {
    const { adb, center } = trackerFixture(t);
    await Promise.all([center.init(), center.init(), center.init()]);
    assert.equal(adb.opened, 1);
    assert.equal(adb.trackers.length, 1);
    assert.equal(adb.trackers[0].listenerCount('changeSet'), 1);
    await center.init();
    assert.equal(adb.opened, 1, 'a running tracker is not started again');
});

test('a device list opened while adb is down receives the phones when adb returns', async (t) => {
    const { adb, center } = trackerFixture(t);
    t.mock.method(AndroidControlCenter, 'getInstance', () => center);
    adb.down = true;
    await center.start();
    assert.equal(center.isAdbAvailable(), false);

    const socket = new BrowserSocket();
    const list = new AndroidDeviceTracker(socket);
    assert.deepEqual(
        socket.messages().map((message) => message.type),
        ['devicelist', 'tracker_status'],
        'the list answers at once',
    );
    assert.deepEqual(socket.messages()[0].data.list, []);
    assert.equal(socket.messages()[1].data.available, false, 'and says that adb is unavailable');

    adb.down = false;
    adb.devices = ['usb-phone'];
    await wait(80);
    // The first update of a new device is sent before the list can hear it; any later one is.
    center.getDevice('usb-phone').emit('update', center.getDevice('usb-phone'));
    const later = socket.messages().slice(2);
    assert.ok(
        later.some((message) => message.type === 'device' && message.data.device.udid === 'usb-phone'),
        'the phone reaches the list that was already open',
    );
    assert.equal(later.filter((message) => message.type === 'tracker_status').at(-1).data.available, true);
    assert.equal(adb.trackers.length, 1, 'recovery opened one tracker');

    socket.close();
    list.release();
    adb.trackers[0].emit('end');
    await tick();
    assert.equal(
        socket.messages().filter((message) => message.type === 'tracker_status').length,
        2,
        'a closed list is no longer told about adb',
    );
});
