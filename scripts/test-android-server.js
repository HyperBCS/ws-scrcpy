// Run with: node --test scripts/test-android-server.js
// Android server lifecycle: adb helpers, device tracking and the scrcpy process. No device needed.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { EventEmitter, once } = require('node:events');
const { createServer } = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

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
const { ScrcpyServer } = require('../src/server/goog-device/ScrcpyServer');
const { ScrcpyInstance } = require('../src/server/goog-device/ScrcpyInstance');
const { WebsocketProxyOverAdb } = require('../src/server/goog-device/mw/WebsocketProxyOverAdb');
const { broadcastManager } = require('../src/common/BroadcastManager');
const { STREAM_SERVICE_STOPPED } = require('../src/common/StreamCloseCode');
const { ControlCenterCommand } = require('../src/common/ControlCenterCommand');
const { wakeDevice } = require('../src/app/googDevice/client/wake');
const { streamConfig } = require('../src/server/goog-device/StreamConfig');
const { StreamReceiver } = require('../src/app/client/StreamReceiver');

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

const SCRCPY = ['app_process', '/', 'com.genymobile.scrcpy.Server', '4.1', 'tunnel_forward=true'];
const ownServer = () => [...SCRCPY, `scid=${ScrcpyInstance.getScid()}`];

// A Device whose phone is a table of processes. The adb calls a Device makes are all replaced:
// nothing in these tests reaches a real adb server or spawns the adb binary.
function deviceFixture(t, udid = 'phone') {
    const noStartup = t.mock.method(Device.prototype, 'setState', () => {});
    const device = new Device(udid, 'device');
    noStartup.mock.restore();
    const phone = { processes: new Map(), killed: [] };
    device.getPidOf = async () => [...phone.processes.keys()];
    device.runShellCommandAdbKit = async (command) => {
        const cmdline = command.match(/^cat \/proc\/(\d+)\/cmdline$/);
        if (cmdline) {
            return (phone.processes.get(Number(cmdline[1])) || []).join('\0');
        }
        const kill = command.match(/^kill (\d+)$/);
        if (kill) {
            phone.killed.push(Number(kill[1]));
            phone.processes.delete(Number(kill[1]));
            return '';
        }
        assert.fail(`unexpected device command: ${command}`);
    };
    device.listEncoders = async () => [];
    t.mock.method(AdbUtils, 'removeFileSocketForwards', async () => {});
    // The adb child of a launch. spawn is replaced, so no adb process is ever started.
    const children = [];
    t.mock.method(childProcess, 'spawn', (_command, args) => {
        const child = new EventEmitter();
        child.pid = 4000 + children.length;
        child.args = args;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.signals = [];
        child.kill = (signal) => {
            child.signals.push(signal);
            return true;
        };
        children.push(child);
        return child;
    });
    t.after(() => device.release());
    return { device, phone, children };
}

// Stands in for the launch: a started server is a new process on the phone with a live stream.
function streamFixture(t, phone) {
    const stream = { up: false, launches: 0 };
    t.mock.method(ScrcpyServer, 'run', async () => {
        stream.launches++;
        phone.processes.set(900 + stream.launches, ownServer());
        stream.up = true;
    });
    t.mock.method(broadcastManager, 'hasBroadcast', () => stream.up);
    t.mock.method(broadcastManager, 'stopBroadcast', () => {
        stream.up = false;
    });
    return stream;
}

function withTimings(t, timings) {
    const previous = {};
    for (const key of Object.keys(timings)) {
        previous[key] = Device[key];
        Device[key] = timings[key];
    }
    t.after(() => Object.assign(Device, previous));
}

const settle = async () => {
    for (let turn = 0; turn < 8; turn++) await tick();
};

test('each server keeps its own scid per port, and every launch carries it', (t) => {
    const { Config } = require('../src/server/Config');
    let port = 8000;
    t.mock.method(Config, 'getInstance', () => ({ servers: [{ port }] }));
    const file = path.join(process.env.WS_NOTIFICATION_DATA, 'scrcpy-instance.json');
    const restart = () => {
        ScrcpyInstance.scid = undefined;
        return ScrcpyInstance.getScid();
    };
    const main = restart();
    t.after(() => {
        ScrcpyInstance.scid = main;
    });
    assert.match(main, /^[0-7][0-9a-f]{7}$/, 'eight hex digits that fit in 31 bits, as scrcpy requires');
    assert.equal(ScrcpyInstance.socketName(), `localabstract:scrcpy_${main}`);
    const args = ScrcpyServer.buildLaunchArgs(streamConfig.get('any-phone'));
    assert.match(args, /^4\.1 .*tunnel_forward=true/);
    assert.ok(args.split(' ').includes(`scid=${main}`));
    assert.ok(args.split(' ').includes('power_on=false'), 'a start does not wake the screen');
    assert.equal(restart(), main, 'a restarted server finds its scid again');

    port = 8010;
    const test = restart();
    assert.notEqual(test, main, 'a test server on another port is a different instance');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 8000: main, 8010: test });
    port = 8000;
    assert.equal(restart(), main);

    assert.equal(ScrcpyServer.isOwnServer(ownServer()), true);
    assert.equal(ScrcpyServer.isOwnServer([...SCRCPY, `scid=${test}`]), false);
    assert.equal(ScrcpyServer.isOwnServer(SCRCPY), false, 'a scrcpy with no scid is not ours either');
    assert.equal(ScrcpyServer.isOwnServer([...ownServer(), 'list_encoders=true']), false);
});

test('a scrcpy that another server or desktop scrcpy started is never reported or stopped', async (t) => {
    const { device, phone } = deviceFixture(t);
    const stream = streamFixture(t, phone);
    phone.processes.set(301, [...SCRCPY, 'scid=0badc0de']); // a test server on another port
    phone.processes.set(302, SCRCPY); // a scrcpy started without an scid
    await device.refreshServicePid();
    assert.equal(device.descriptor.pid, -1, 'their pids are not reported as this server’s');

    device.addViewer({ close() {} });
    await device.ensureServer();
    assert.equal(stream.launches, 1, 'this server starts its own');
    assert.deepEqual(phone.killed, [], 'and replaces nobody');
    assert.equal(device.descriptor.pid, 901);

    await device.killServer(301);
    assert.deepEqual(phone.killed, [901], 'Stop ends only this server’s process, whatever pid was asked for');
    assert.deepEqual([...phone.processes.keys()], [301, 302]);
});

test('a server left behind by this server’s previous run is replaced', async (t) => {
    const { device, phone } = deviceFixture(t);
    const stream = streamFixture(t, phone);
    phone.processes.set(555, ownServer());
    device.addViewer({ close() {} });
    await device.ensureServer();
    assert.deepEqual(phone.killed, [555]);
    assert.equal(stream.launches, 1);
    assert.equal(device.descriptor.pid, 901);
});

test('starting waits for the launch itself and never polls for a PID file', async () => {
    const launches = [];
    const device = {
        udid: 'phone',
        TAG: '[phone]',
        isConnected: () => true,
        push: async () => {
            const transfer = new EventEmitter();
            setImmediate(() => transfer.emit('end'));
            return transfer;
        },
        getLaunchStreamConfig: () => streamConfig.get('phone'),
        launchServer: async (command, audio) => launches.push({ command, audio }),
        runShellCommandAdbKit: () => assert.fail('the start must not poll the phone'),
        getPidOf: () => assert.fail('the start must not poll the phone'),
    };
    await ScrcpyServer.run(device);
    assert.equal(launches.length, 1);
    assert.match(
        launches[0].command,
        /^CLASSPATH=\/data\/local\/tmp\/scrcpy-server\.jar app_process \/ com\.genymobile\.scrcpy\.Server 4\.1 /,
    );
    assert.ok(launches[0].command.endsWith(` scid=${ScrcpyInstance.getScid()} power_on=false`));
    assert.equal(launches[0].audio, true);

    device.launchServer = async () => {
        throw Error('The stream service did not start in time.');
    };
    await assert.rejects(ScrcpyServer.run(device), /did not start in time/);
});

const streamHeader = () => {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(0x68323634, 0);
    header.writeUInt32BE(720, 8);
    header.writeUInt32BE(1280, 12);
    return header;
};

test('a slow start is not given up on: the stream connects once scrcpy listens', { timeout: 10000 }, async (t) => {
    const { device, children } = deviceFixture(t, 'slow-phone');
    withTimings(t, { STREAM_CONNECT_DELAY_MS: 5, STREAM_RETRY_DELAY_MS: 5 });
    // The adb forward port. Until scrcpy listens on the phone, adb accepts and closes at once.
    let listening = false;
    let refused = 0;
    const peers = [];
    const server = createServer((socket) => {
        socket.on('error', () => {});
        if (!listening) {
            refused++;
            socket.destroy();
            return;
        }
        peers.push(socket);
        if (peers.length === 1) socket.write(streamHeader());
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        broadcastManager.stopBroadcast('slow-phone');
        peers.forEach((socket) => socket.destroy());
        server.close();
    });
    const forwards = [];
    t.mock.method(AdbUtils, 'forward', async (serial, remote) => {
        forwards.push(`${serial} ${remote}`);
        return server.address().port;
    });

    let ready = false;
    const starting = device.launchServer('scrcpy fixture', false).then(() => (ready = true));
    assert.deepEqual(children[0].args, ['-s', 'slow-phone', 'shell', 'scrcpy fixture']);
    children[0].stdout.emit('data', Buffer.from('[server] INFO: Device: fixture\n'));
    await wait(80);
    assert.ok(refused >= 2, 'the stream was tried while scrcpy was not listening yet');
    assert.equal(ready, false, 'the start is still in progress');
    assert.deepEqual(children[0].signals, [], 'and the server is not stopped for being slow');
    assert.equal(broadcastManager.hasBroadcast('slow-phone'), false);

    listening = true;
    await starting;
    assert.deepEqual(forwards, [`slow-phone ${ScrcpyInstance.socketName()}`], 'the socket is this server’s own');
    assert.equal(await broadcastManager.getBroadcast('slow-phone').whenReady(), true);
    assert.equal(device.launch.child, children[0], 'the adb child is kept for shutdown');

    // The server ends by itself later: its stream goes with it.
    children[0].emit('close', 0);
    assert.equal(broadcastManager.hasBroadcast('slow-phone'), false);
    assert.equal(device.launch, undefined);
});

test('a server that exits while starting fails the launch at once, with its last output', async (t) => {
    const { device, children } = deviceFixture(t, 'broken-phone');
    const starting = device.launchServer('scrcpy fixture', true);
    children[0].stderr.emit('data', Buffer.from('Error: Could not find or load main class\n'));
    children[0].emit('close', 1);
    await assert.rejects(starting, /exited before it was ready: Error: Could not find or load main class/);
    assert.deepEqual(children[0].signals, [], 'a process that is gone is not signalled');
    assert.equal(device.launch, undefined);
});

test('a start that takes too long is stopped and reported once', async (t) => {
    const { device, children } = deviceFixture(t, 'stuck-phone');
    withTimings(t, { SERVER_START_TIMEOUT_MS: 30 });
    await assert.rejects(device.launchServer('scrcpy fixture', false), /did not start in time/);
    assert.deepEqual(children[0].signals, ['SIGTERM'], 'the adb child is stopped, so nothing is left starting');
    children[0].emit('close', null);
    assert.equal(device.launch, undefined);
});

test('attaching a phone reads the service status and starts nothing', async (t) => {
    const { device, phone } = deviceFixture(t);
    t.mock.method(ScrcpyServer, 'run', () => assert.fail('scrcpy must not start when a phone is attached'));
    device.startServer = () => assert.fail('scrcpy must not start when a phone is attached');
    device.getProperties = async () => ({});
    device.updateInterfaces = async () => [{ name: 'wlan0', ipv4: '192.0.2.10' }];
    device.fetchDeviceInfo();
    await settle();
    assert.equal(device.descriptor.pid, -1, 'the service is reported as stopped');
    assert.deepEqual(phone.killed, []);
    assert.equal(device.updateTimeoutId, undefined, 'and a stopped service is not retried as a failure');
});

test('scrcpy starts with the first viewer and stops a grace period after the last one leaves', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { device, phone } = deviceFixture(t);
    const stream = streamFixture(t, phone);
    const viewer = () => ({ close() {} });

    const leaveFirst = device.addViewer(viewer());
    await device.ensureServer();
    const leaveSecond = device.addViewer(viewer());
    await device.ensureServer();
    assert.equal(stream.launches, 1, 'two viewers share one server');

    leaveFirst();
    t.mock.timers.tick(120000);
    await settle();
    assert.deepEqual(phone.killed, [], 'it keeps running while someone is watching');

    leaveSecond();
    t.mock.timers.tick(29000);
    await settle();
    assert.deepEqual(phone.killed, [], 'it survives a reload');
    const leaveReloaded = device.addViewer(viewer());
    await device.ensureServer();
    t.mock.timers.tick(120000);
    await settle();
    assert.equal(stream.launches, 1, 'and the reloaded page reuses it');
    assert.deepEqual(phone.killed, []);

    leaveReloaded();
    leaveReloaded();
    t.mock.timers.tick(30000);
    await settle();
    assert.deepEqual(phone.killed, [901], 'with nobody watching it is stopped');
    assert.equal(stream.up, false);
    assert.equal(device.descriptor.pid, -1);

    device.addViewer(viewer());
    await device.ensureServer();
    assert.equal(stream.launches, 2, 'the next viewer starts it again');
});

test('a service started from the card is stopped again when nobody opens the screen', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { device, phone } = deviceFixture(t);
    const stream = streamFixture(t, phone);
    assert.equal(await device.startServer(), 901);
    t.mock.timers.tick(30000);
    await settle();
    assert.deepEqual(phone.killed, [901]);
    assert.equal(stream.up, false);
});

test('the owner’s Stop closes every viewer with the code that tells it not to reconnect', async (t) => {
    const { device, phone } = deviceFixture(t);
    const stream = streamFixture(t, phone);
    const closes = [];
    const viewer = () => ({ close: (code, reason) => closes.push({ code, reason, streamUp: stream.up }) });
    device.addViewer(viewer());
    device.addViewer(viewer());
    await device.ensureServer();
    await device.killServer(901);
    assert.equal(STREAM_SERVICE_STOPPED, 4012);
    assert.deepEqual(
        closes.map((close) => close.code),
        [4012, 4012],
    );
    assert.ok(
        closes.every((close) => close.streamUp),
        'before the stream is torn down, so this is the close the browser sees',
    );
    assert.deepEqual(phone.killed, [901]);
    assert.equal(stream.up, false);
});

test('a settings change restarts a watched stream and only stops an unwatched one', async (t) => {
    const { device, phone } = deviceFixture(t, 'settings-phone');
    const stream = streamFixture(t, phone);
    const leave = device.addViewer({ close() {} });
    await device.ensureServer();
    await device.updateStreamConfig({ maxFps: 30 });
    assert.deepEqual(phone.killed, [901]);
    assert.equal(stream.launches, 2, 'a watched stream comes back with the new settings');

    leave();
    await device.updateStreamConfig({ maxFps: 60 });
    assert.deepEqual(phone.killed, [901, 902]);
    assert.equal(stream.launches, 2, 'with nobody watching, the next viewer gets the new settings');
    assert.equal(stream.up, false);
    assert.equal(streamConfig.get('settings-phone').maxFps, 60);
});

test('a stream connection counts as a viewer until its socket closes', async (t) => {
    const calls = [];
    const device = {
        addViewer: (viewer) => {
            calls.push('add');
            device.viewer = viewer;
            return () => calls.push('leave');
        },
        ensureServer: async () => calls.push('ensure'),
        getDeviceName: () => 'Fixture phone',
        getCachedEncoders: () => [],
    };
    t.mock.method(AndroidControlCenter, 'hasInstance', () => true);
    t.mock.method(AndroidControlCenter, 'getInstance', () => ({
        getDevice: (udid) => (udid === 'phone' ? device : undefined),
    }));

    const socket = new BrowserSocket();
    WebsocketProxyOverAdb.createProxyOverAdb(socket, 'phone', 'tcp:8886');
    assert.deepEqual(calls, ['add', 'ensure'], 'the viewer is registered before the server is started');
    await settle();
    // No stream came up in this fixture, so the proxy closes the socket for a retry.
    assert.deepEqual(
        socket.closes.map((close) => close.code),
        [4008],
    );
    assert.deepEqual(calls, ['add', 'ensure', 'leave']);

    const second = new BrowserSocket();
    WebsocketProxyOverAdb.createProxyOverAdb(second, 'phone', 'tcp:8886');
    device.viewer.close(STREAM_SERVICE_STOPPED, 'Stream service stopped');
    assert.deepEqual(second.closes, [{ code: 4012, reason: 'Stream service stopped' }]);
    await settle();
});

test('a viewer closed by Stop stays closed, and any other close reconnects', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    class ViewerSocket extends EventEmitter {
        static instances = [];
        CONNECTING = 0;
        OPEN = 1;
        CLOSING = 2;
        CLOSED = 3;
        readyState = 0;
        constructor() {
            super();
            ViewerSocket.instances.push(this);
        }
        addEventListener(type, listener) {
            this.on(type, listener);
        }
        send() {}
        open() {
            this.readyState = this.OPEN;
            this.emit('open', {});
        }
        close(code = 1000, reason = '') {
            this.readyState = this.CLOSED;
            this.emit('close', { code, reason });
        }
    }
    const previous = global.WebSocket;
    global.WebSocket = ViewerSocket;
    t.after(() => {
        global.WebSocket = previous;
    });
    // The socket is the class above: this address is never contacted.
    const receiver = new StreamReceiver({
        udid: 'phone',
        action: 'proxy_adb',
        hostname: 'viewer.invalid',
        port: 1,
        pathname: '/',
    });
    t.after(() => receiver.stop());
    const sockets = ViewerSocket.instances;
    const seen = [];
    receiver.on('disconnected', (event) => seen.push(event.code));

    sockets[0].open();
    sockets[0].close(4007, 'Stream restarted');
    t.mock.timers.tick(10000);
    assert.equal(sockets.length, 2, 'a settings restart is followed by a reconnect');

    sockets[1].open();
    sockets[1].close(STREAM_SERVICE_STOPPED, 'Stream service stopped');
    t.mock.timers.tick(120000);
    assert.equal(sockets.length, 2, 'Stop is not: reconnecting would start the service again');
    assert.deepEqual(seen, [4007, 4012]);
});

test('shutdown stops the stream and the adb child of every phone', async (t) => {
    const { device, children } = deviceFixture(t, 'shutdown-phone');
    const stopped = [];
    t.mock.method(broadcastManager, 'stopBroadcast', (udid) => stopped.push(udid));
    const launching = device.launchServer('scrcpy fixture', false).catch((error) => error);
    device.addViewer({ close() {} })();
    assert.ok(device.idleStopTimeoutId, 'an idle stop is pending');

    const center = new AndroidControlCenter();
    center.deviceMap.set('shutdown-phone', device);
    center.release();
    assert.deepEqual(children[0].signals, ['SIGTERM'], 'the adb child is told to stop');
    assert.deepEqual(stopped, ['shutdown-phone'], 'the stream sockets are closed');
    assert.equal(device.idleStopTimeoutId, undefined);
    children[0].emit('close', null);
    assert.match((await launching).message, /exited before it was ready/);
});

test('Node exits soon after shutdown even when something was left open', { timeout: 20000 }, async () => {
    const child = childProcess.spawn(process.execPath, [path.join(__dirname, 'fixtures', 'shutdown-open-handle.js')], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let signalled = 0;
    child.stdout.on('data', (data) => {
        stdout += data;
        if (!signalled && stdout.includes('harness ready')) {
            signalled = Date.now();
            child.kill('SIGTERM');
        }
    });
    child.stderr.on('data', (data) => (stderr += data));
    // Without the backstop the process never exits. A second SIGTERM is its "force exit".
    const stuck = setTimeout(() => child.kill('SIGTERM'), 8000);
    const [code] = await once(child, 'exit');
    clearTimeout(stuck);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Stopping fixture service/);
    assert.match(stderr, /Still running after shutdown; exiting/);
    assert.ok(Date.now() - signalled < 6000, 'it did not wait for a second signal');
});

const wakeCommand = (data) => ControlCenterCommand.fromJSON(JSON.stringify({ id: 7, type: 'wake_device', data }));

test('Wake from the card sends the wake key through adb and starts no stream', async (t) => {
    const { device, phone, children } = deviceFixture(t, 'sleeping-phone');
    withTimings(t, { WAKE_SETTLE_MS: 1 });
    t.mock.method(ScrcpyServer, 'run', () => assert.fail('Wake must not start the stream service'));
    t.mock.method(broadcastManager, 'startBroadcast', () => assert.fail('Wake must not open a stream'));
    const sent = [];
    let result = { code: 0, output: '' };
    t.mock.method(AdbUtils, 'shellExec', async (serial, command) => {
        sent.push(`${serial}: ${command}`);
        return result;
    });
    let refreshed = 0;
    device.fetchRuntimeState = () => refreshed++;
    const center = new AndroidControlCenter();
    center.deviceMap.set('sleeping-phone', device);

    const reply = await center.runCommand(wakeCommand({ udid: 'sleeping-phone' }));
    assert.deepEqual(JSON.parse(reply), { udid: 'sleeping-phone' });
    assert.deepEqual(sent, ['sleeping-phone: input keyevent 224'], 'KEYCODE_WAKEUP');
    assert.equal(children.length, 0);
    assert.deepEqual(phone.killed, []);
    await wait(20);
    assert.equal(refreshed, 1, 'the screen state is read again, so the card shows the result');

    result = { code: 255, output: 'java.lang.SecurityException: Injecting input events requires permission' };
    await assert.rejects(center.runCommand(wakeCommand({ udid: 'sleeping-phone' })), /SecurityException/);
    device.connected = false;
    await assert.rejects(center.runCommand(wakeCommand({ udid: 'sleeping-phone' })), /not connected/);
    assert.equal(sent.length, 2, 'a disconnected phone is not sent anything');
    assert.throws(() => wakeCommand({}), /Missing device id/);
});

test('the card’s Wake request resolves on its own reply and reports a refusal or silence', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new EventEmitter();
    const commands = [];
    tracker.sendCommand = (type, data) => {
        commands.push({ type, data });
        return 40 + commands.length;
    };
    const outcome = (promise) =>
        promise.then(
            () => 'woken',
            (error) => error.message,
        );

    const first = outcome(wakeDevice(tracker, 'phone'));
    assert.deepEqual(commands, [{ type: 'wake_device', data: { udid: 'phone' } }]);
    tracker.emit('wake_device', { udid: 'other-phone', requestId: 41 });
    tracker.emit('wake_device', { udid: 'phone', requestId: 12 });
    tracker.emit('wake_device', { udid: 'phone', requestId: 41 });
    assert.equal(await first, 'woken');
    assert.equal(tracker.listenerCount('wake_device'), 0);

    const refused = outcome(wakeDevice(tracker, 'phone'));
    tracker.emit('wake_device', { udid: 'phone', requestId: 42, error: 'The device is not connected.' });
    assert.equal(await refused, 'The device is not connected.');

    const silent = outcome(wakeDevice(tracker, 'phone'));
    t.mock.timers.tick(8000);
    assert.match(await silent, /did not answer/);
    assert.equal(tracker.listenerCount('wake_device'), 0);
});
