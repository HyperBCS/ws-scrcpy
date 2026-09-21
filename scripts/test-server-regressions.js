// Run with: node scripts/test-server-regressions.js
// Exercises lifecycle races against controlled sockets/processes; no attached device required.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { EventEmitter } = require('node:events');
const { Socket } = require('node:net');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-server-tests-'));
const previousConfigPath = process.env.WS_SCRCPY_STREAM_CONFIG_PATH;
process.env.WS_SCRCPY_STREAM_CONFIG_PATH = path.join(temporary, 'stream-config.json');
require('ts-node').register({ transpileOnly: true });
// Webpack treats these imports as assets. Node only needs the surrounding server classes.
require.extensions['.jar'] = () => {};
require.cache[require.resolve('../vendor/Genymobile/scrcpy/LICENSE')] = { exports: {} };

const { Broadcast } = require('../src/common/Broadcast');
const { broadcastManager } = require('../src/common/BroadcastManager');
const { ControlCenterCommand } = require('../src/common/ControlCenterCommand');
const { Config } = require('../src/server/Config');
const { Device } = require('../src/server/goog-device/Device');
const { ScrcpyServer } = require('../src/server/goog-device/ScrcpyServer');
const { streamConfig, validateStreamConfigPatch } = require('../src/server/goog-device/StreamConfig');
const { ControlCenter: AndroidControlCenter } = require('../src/server/goog-device/services/ControlCenter');
const { ControlCenter: IosControlCenter } = require('../src/server/appl-device/services/ControlCenter');
const { PyMobileDevice } = require('../src/server/appl-device/services/PyMobileDevice');
const { CoreDeviceRunner } = require('../src/server/appl-device/services/CoreDeviceRunner');
const { WebsocketProxy } = require('../src/server/mw/WebsocketProxy');
const { LOCK_STATE_COMMAND, parseLockState, unknownLockState } = require('../src/server/goog-device/LockState');
const { FilePushReader } = require('../src/server/goog-device/filePush/FilePushReader');
const { FileListing } = require('../src/server/goog-device/mw/FileListing');
const { AdbUtils } = require('../src/server/goog-device/AdbUtils');
const { AdbExtended } = require('../src/server/goog-device/adb');
const { CommandControlMessage, FilePushState } = require('../src/app/controlMessage/CommandControlMessage');
const { FilePushResponseStatus } = require('../src/app/googDevice/filePush/FilePushResponseStatus');

after(() => {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (previousConfigPath === undefined) delete process.env.WS_SCRCPY_STREAM_CONFIG_PATH;
    else process.env.WS_SCRCPY_STREAM_CONFIG_PATH = previousConfigPath;
});

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function lockDump({ user = 0, after = user, showing = true, occluded = false, locked = 1, screen = 'ON' } = {}) {
    return (
        `lock.currentUser=${user}\nkeyguard.showing=${showing}\nkeyguard.occluded=${occluded}\n` +
        `keyguard.screenState=SCREEN_STATE_${screen}\ntrust.user=${user} (current): deviceLocked=${locked}\n` +
        `lock.currentUserAfter=${after}`
    );
}

function lockDevice() {
    const device = Object.create(Device.prototype);
    Object.assign(device, {
        connected: true,
        connectionGeneration: 1,
        lockReadSequence: 0,
        lastAppliedLockRead: 0,
        servicePidRevision: 0,
        descriptor: { pid: 0, ...unknownLockState() },
        updates: 0,
    });
    device.emitUpdate = () => device.updates++;
    return device;
}

test('lock parser distinguishes authentication, swipe-only keyguard, occlusion, and screen power', () => {
    assert.deepEqual(
        parseLockState(lockDump({ screen: 'OFF' })),
        {
            'keyguard.showing': true,
            'keyguard.occluded': false,
            'device.locked': true,
            'screen.power': 'off',
        },
        'Pixel 8 locked policy/trust fields',
    );
    assert.deepEqual(
        parseLockState(lockDump({ showing: false, locked: 0 })),
        {
            'keyguard.showing': false,
            'keyguard.occluded': false,
            'device.locked': false,
            'screen.power': 'on',
        },
        'Xiaomi unlocked policy/trust fields',
    );
    assert.equal(
        parseLockState(lockDump({ locked: 0 }))['device.locked'],
        false,
        'Swipe/trusted dismissal is not authentication',
    );
    const occluded = parseLockState(lockDump({ occluded: true }));
    assert.equal(occluded['keyguard.showing'], true, 'Logical keyguard still shows underneath an activity');
    assert.equal(occluded['keyguard.occluded'], true, 'Call/camera occlusion must remain distinguishable');
    assert.equal(parseLockState(lockDump({ screen: 'TURNING_ON' }))['screen.power'], 'unknown');
});

test('lock parser selects the stable active user and rejects user switches or conflicting snapshots', () => {
    const other = 'trust.user=0: deviceLocked=0\n';
    assert.equal(parseLockState(other + lockDump({ user: 10 }))['device.locked'], true);
    assert.deepEqual(parseLockState(lockDump({ user: 0, after: 10 })), unknownLockState());
    assert.deepEqual(parseLockState(lockDump().replace('trust.user=0', 'trust.user=10')), unknownLockState());
    assert.equal(parseLockState(lockDump() + '\ntrust.user=10 (current): deviceLocked=0')['device.locked'], 'unknown');
    assert.equal(parseLockState(lockDump() + '\nkeyguard.showing=false')['keyguard.showing'], 'unknown');
});

test('missing, malformed, and permission-denied lock diagnostics never become unlocked evidence', () => {
    for (const output of [
        '',
        'Permission Denial: cannot dump trust',
        lockDump().replace('lock.currentUser=0', 'unknown'),
    ]) {
        assert.deepEqual(parseLockState(output), unknownLockState());
    }
    for (const output of [
        lockDump({ locked: 2 }),
        lockDump().replace(' (current)', ''),
        lockDump().replace('deviceLocked=1', 'secure=true inputRestricted=true'),
        lockDump().replace('deviceLocked=1', 'deviceLocked=10'),
    ]) {
        assert.equal(parseLockState(output)['device.locked'], 'unknown');
    }
});

test('GET_LOCK_STATE performs a fresh device read and returns the typed state without mutation commands', async () => {
    const center = Object.create(AndroidControlCenter.prototype);
    const state = parseLockState(lockDump());
    let reads = 0;
    center.getDevice = () => ({
        refreshLockState: async () => {
            reads++;
            return state;
        },
    });
    const command = ControlCenterCommand.fromJSON(JSON.stringify({ type: 'get_lock_state', data: { udid: 'test' } }));
    assert.deepEqual(JSON.parse(await center.runCommand(command)), { udid: 'test', ...state });
    assert.equal(reads, 1);
    assert.throws(() => ControlCenterCommand.fromJSON(JSON.stringify({ type: 'get_lock_state', data: {} })));
});

test('fresh lock reads update descriptors and replace stale success with unknown on diagnostic failure', async () => {
    const device = lockDevice();
    let calls = 0;
    device.runShellCommandAdbKit = async (command, timeout) => {
        calls++;
        assert.equal(command, LOCK_STATE_COMMAND);
        assert.equal(timeout, 6500);
        if (calls > 1) throw Error('USB diagnostic failed');
        return lockDump();
    };
    assert.equal((await device.refreshLockState())['device.locked'], true);
    assert.deepEqual(await device.refreshLockState(), unknownLockState());
    assert.equal(device.descriptor['device.locked'], 'unknown');
    assert.equal(calls, 2, 'Explicit checks cannot reuse periodic cached state');
    assert.equal(device.updates, 2);
});

test('out-of-order or disconnected lock replies cannot restore stale state or authorize a caller', async () => {
    const device = lockDevice();
    const first = deferred();
    let calls = 0;
    device.runShellCommandAdbKit = () =>
        ++calls === 1 ? first.promise : Promise.resolve(lockDump({ locked: 0, showing: false }));
    const old = device.refreshLockState();
    assert.equal((await device.refreshLockState())['device.locked'], false);
    first.resolve(lockDump());
    assert.deepEqual(await old, unknownLockState());
    assert.equal(device.descriptor['device.locked'], false);
    const pending = deferred();
    device.runShellCommandAdbKit = () => pending.promise;
    const disconnected = device.refreshLockState();
    device.fetchDeviceInfo = () => {};
    device.stopRuntimeStateUpdates = () => {};
    device.setState('offline');
    assert.equal(device.descriptor['device.locked'], 'unknown', 'Disconnect invalidates lock badges immediately');
    pending.resolve(lockDump());
    assert.deepEqual(await disconnected, unknownLockState());
    assert.equal(device.descriptor['device.locked'], 'unknown');
});

test('lock polling uses the fast cadence without overlapping reads or surviving disconnect', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const noStartup = t.mock.method(Device.prototype, 'setState', () => {});
    const device = new Device('lock-poll-fixture', 'device');
    noStartup.mock.restore();
    device.runtimeStatePollActive = true;
    const pending = deferred();
    let calls = 0;
    device.refreshLockState = () => {
        calls++;
        return pending.promise;
    };
    device.scheduleLockStateUpdate();
    t.mock.timers.tick(1999);
    assert.equal(calls, 0);
    t.mock.timers.tick(1);
    assert.equal(calls, 1);
    device.scheduleLockStateUpdate(true);
    t.mock.timers.tick(5000);
    assert.equal(calls, 1, 'Pending polls cannot overlap');
    device.connected = false;
    device.connectionGeneration++;
    pending.resolve(unknownLockState());
    await tick();
    t.mock.timers.tick(60000);
    assert.equal(calls, 1, 'An old poll cannot restart after disconnect');
});

test('bounded diagnostics destroy sockets which arrive after the request already timed out', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = deferred();
    const device = Object.create(Device.prototype);
    device.client = { shell: () => pending.promise };
    const reading = device.runShellCommandAdbKit('read-only fixture', 10);
    const rejected = assert.rejects(reading, /timed out/);
    t.mock.timers.tick(10);
    await rejected;
    const socket = new Socket();
    pending.resolve(socket);
    await tick();
    assert.equal(socket.destroyed, true);
});

test('tracker service release cancels device polling and invalidates pending lock replies', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const noStartup = t.mock.method(Device.prototype, 'setState', () => {});
    const device = new Device('released-lock-fixture', 'device');
    noStartup.mock.restore();
    device.runtimeStatePollActive = true;
    const pending = deferred();
    device.runShellCommandAdbKit = () => pending.promise;
    device.scheduleLockStateUpdate();
    const read = device.refreshLockState();
    const center = Object.create(AndroidControlCenter.prototype);
    center.stopTracker = () => {};
    center.onDeviceUpdate = () => {};
    center.deviceMap = new Map([['test', device]]);
    center.descriptors = new Map([['test', device.descriptor]]);
    center.release();
    assert.equal(device.lockStateTimeoutId, undefined);
    assert.equal(device.isConnected(), false);
    assert.equal(center.deviceMap.size, 0);
    device.setState('device');
    assert.equal(device.isConnected(), false, 'A released descriptor cannot be revived by a late tracker callback');
    pending.resolve(lockDump());
    assert.deepEqual(await read, unknownLockState());
    t.mock.timers.tick(60000);
    assert.equal(device.lockStateTimeoutId, undefined);
});

test('read-only service discovery ignores enumeration helpers and never kills old versions', async () => {
    const argumentsByPid = new Map([
        [101, ['app_process', '/', 'com.genymobile.scrcpy.Server', '4.1', 'tunnel_forward=true']],
        [102, ['app_process', '/', 'com.genymobile.scrcpy.Server', '4.1', 'list_encoders=true']],
        [103, ['app_process', '/', 'com.genymobile.scrcpy.Server', '1.20-ws1', 'tunnel_forward=true']],
    ]);
    const device = {
        isConnected: () => true,
        getPidOf: async (_name, strict) => {
            assert.equal(strict, true);
            return [...argumentsByPid.keys()];
        },
        runShellCommandAdbKit: async (command, timeout) => {
            assert.equal(timeout, 6500);
            return argumentsByPid.get(Number(command.match(/proc\/(\d+)/)[1])).join('\0');
        },
        killProcess: () => assert.fail('Status discovery must never kill a device process'),
    };
    assert.deepEqual((await ScrcpyServer.getServerPid(device, false)).sort(), [101, 103]);
});

test('service PID polling reports running, confirmed stop, and failed-read unknown without launching', async (t) => {
    const device = lockDevice();
    let result = [321];
    let failure = false;
    device.startServer = () => assert.fail('Status polling must not launch a stream');
    t.mock.method(ScrcpyServer, 'getServerPid', async (_device, cleanUp) => {
        assert.equal(cleanUp, false);
        if (failure) throw Error('Device diagnostic failed');
        return result;
    });
    await device.refreshServicePid();
    assert.equal(device.descriptor.pid, 321);
    result = [];
    await device.refreshServicePid();
    assert.equal(device.descriptor.pid, -1);
    failure = true;
    await device.refreshServicePid();
    assert.equal(device.descriptor.pid, 0);
    assert.equal(device.updates, 3);
});

test('stale PID reads cannot restore a disconnected or replaced service', async (t) => {
    const device = lockDevice();
    let pending = deferred();
    t.mock.method(ScrcpyServer, 'getServerPid', () => pending.promise);
    const first = device.refreshServicePid();
    device.fetchDeviceInfo = () => {};
    device.stopRuntimeStateUpdates = () => {};
    device.setState('offline');
    pending.resolve([123]);
    await first;
    assert.equal(device.descriptor.pid, 0);
    device.connected = true;
    device.connectionGeneration++;
    pending = deferred();
    const old = device.refreshServicePid();
    device.setServerPid(456);
    pending.resolve([123]);
    await old;
    assert.equal(device.descriptor.pid, 456);
});

test('owned process exit clears stale PID while an old close cannot overwrite the replacement', async (t) => {
    const device = lockDevice();
    device.udid = 'process-status-fixture';
    device.TAG = '[process-status-test]';
    device.audioLaunchGeneration = 0;
    const children = [];
    t.mock.method(childProcess, 'spawn', () => {
        const child = new EventEmitter();
        child.pid = 500 + children.length;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        children.push(child);
        return child;
    });
    t.mock.method(ScrcpyServer, 'getServerPid', async () => []);
    const first = device.runShellCommandAdbSpecial('fixture one', device.udid, false);
    device.setServerPid(123);
    const second = device.runShellCommandAdbSpecial('fixture two', device.udid, false);
    device.setServerPid(456);
    children[0].emit('close', 0);
    await first;
    assert.equal(device.descriptor.pid, 456);
    children[1].emit('close', 0);
    assert.equal(device.descriptor.pid, 0, 'Invalidate immediately before checking remaining processes');
    await second;
    await tick();
    assert.equal(device.descriptor.pid, -1);
});

test('strict process discovery propagates adb failures instead of claiming no service exists', async () => {
    const device = lockDevice();
    device.pidDetectionVariant = 1; // pidof supported.
    device.runShellCommandAdbKit = async () => {
        throw Error('USB gone');
    };
    await assert.rejects(device.getPidOf('app_process', true), /USB gone/);
    assert.deepEqual(await device.getPidOf('app_process'), [], 'Existing launch probing keeps its fallback behavior');
    device.pidDetectionVariant = 0; // The initial capability probe must be bounded and truthful too.
    device.runShellCommandAdbKit = async (_command, timeout) => {
        assert.equal(timeout, 6500);
        throw Error('USB gone during capability probe');
    };
    await assert.rejects(device.getPidOf('app_process', true), /capability probe/);
});

function uploadFixture(t, push) {
    class UploadChannel extends EventEmitter {
        OPEN = 1;
        CLOSING = 2;
        CLOSED = 3;
        readyState = 1;
        responses = [];
        closes = [];
        addEventListener(name, listener) {
            this.on(name, listener);
        }
        removeEventListener(name, listener) {
            this.off(name, listener);
        }
        send(data) {
            this.responses.push(Buffer.from(data));
        }
        close(code = 1000) {
            this.closes.push(code);
            this.readyState = this.CLOSED;
            this.emit('close');
        }
    }
    const client = new EventEmitter();
    client.push = push;
    t.mock.method(AdbExtended, 'createClient', () => client);
    const channel = new UploadChannel();
    const reader = new FilePushReader('upload-fixture', channel);
    const send = (state, fields = {}) =>
        reader.onMessage({
            data: CommandControlMessage.createPushFileCommand({
                id: reader.pushId,
                state,
                ...fields,
            }).toBuffer(),
        });
    return { reader, channel, send };
}

test('empty and regular uploads drain EOF and wait for adb completion before acknowledging FINISH', async (t) => {
    for (const contents of [Buffer.alloc(0), Buffer.from('abc')]) {
        const transfer = new EventEmitter();
        transfer.cancel = () => assert.fail('Successful uploads must not be cancelled');
        let input;
        let ended = false;
        const received = [];
        const { reader, channel, send } = uploadFixture(t, async (_serial, stream, destination) => {
            assert.equal(destination, '/sdcard/upload.txt');
            input = stream;
            stream.on('data', (chunk) => received.push(chunk));
            stream.on('end', () => {
                ended = true;
            });
            return transfer;
        });
        await send(FilePushState.NEW);
        await send(FilePushState.START, { fileName: '/sdcard/upload.txt', fileSize: contents.length });
        if (contents.length) {
            await send(FilePushState.APPEND, { chunk: contents });
            await tick();
        }
        const responsesBeforeFinish = channel.responses.length;
        await send(FilePushState.FINISH);
        assert.equal(input.destroyed, false, 'EOF must drain before the readable is destroyed');
        assert.equal(channel.responses.length, responsesBeforeFinish, 'No success until adb has acknowledged DONE');
        await tick();
        assert.equal(ended, true, 'adb receives a real end event even for an empty file');
        assert.deepEqual(Buffer.concat(received), contents);
        transfer.emit('end');
        assert.equal(channel.responses.length, responsesBeforeFinish + 1);
        assert.equal(channel.responses.at(-1).readInt8(2), FilePushResponseStatus.NO_ERROR);
        assert.deepEqual(channel.closes, [1000]);
        assert.equal(reader.disposed, true);
        assert.equal(channel.listenerCount('message'), 0);
    }
});

test('leaving or cancelling while upload setup is pending cancels the late adb transfer without reviving it', async (t) => {
    for (const cancel of [false, true]) {
        const pending = deferred();
        let input;
        const { reader, channel, send } = uploadFixture(t, (_serial, stream) => {
            input = stream;
            return pending.promise;
        });
        await send(FilePushState.NEW);
        await send(FilePushState.START, { fileName: '/sdcard/upload.txt', fileSize: 3 });
        const appending = send(FilePushState.APPEND, { chunk: Buffer.from('abc') });
        if (cancel) await send(FilePushState.CANCEL);
        else channel.close();
        const responseCount = channel.responses.length;
        const transfer = new EventEmitter();
        let cancels = 0;
        transfer.cancel = () => {
            cancels++;
            transfer.emit('cancel');
        };
        pending.resolve(transfer);
        await appending;
        assert.equal(cancels, 1);
        assert.equal(input.destroyed, true);
        assert.equal(reader.pushTransfer, undefined);
        assert.equal(reader.readStream, undefined);
        assert.equal(reader.createStreamPromiseMap.size, 0);
        assert.equal(channel.listenerCount('message'), 0);
        transfer.emit('end');
        transfer.emit('error', Error('late cancelled transfer error'));
        assert.equal(channel.responses.length, responseCount);
        assert.equal(channel.closes.length, 1);
    }
});

test('closing an active upload cancels its adb transfer and ignores late events', async (t) => {
    const transfer = new EventEmitter();
    let cancels = 0;
    transfer.cancel = () => {
        cancels++;
        transfer.emit('cancel');
    };
    const { reader, channel, send } = uploadFixture(t, async () => transfer);
    await send(FilePushState.NEW);
    await send(FilePushState.START, { fileName: '/sdcard/upload.txt', fileSize: 3 });
    await send(FilePushState.APPEND, { chunk: Buffer.from('abc') });
    channel.close();
    const responseCount = channel.responses.length;
    assert.equal(cancels, 1);
    assert.equal(reader.pushTransfer, undefined);
    transfer.emit('end');
    transfer.emit('error', Error('cancelled transfer'));
    assert.equal(channel.responses.length, responseCount);
    assert.equal(channel.closes.length, 1);
});

test('stream config rejects invalid values before changing stored settings', () => {
    const baseline = streamConfig.set('settings-device', { bitrate: 5000000, videoEncoder: 'c2.vendor.avc' });
    for (const patch of [
        null,
        [],
        { audio: 'false' },
        { bitrate: 0 },
        { maxSize: -1 },
        { maxFps: Infinity },
        { displayId: 0.5 },
        { videoCodec: 'invalid' },
        { videoEncoder: 'encoder; exit' },
        { missingOption: true },
        { audioCodec: 'aac' },
        { audioSource: 'mic' },
    ]) {
        assert.throws(() => streamConfig.set('settings-device', patch));
        assert.deepEqual(streamConfig.get('settings-device'), baseline);
    }
    assert.deepEqual(validateStreamConfigPatch({ videoEncoder: '', audio: false, maxSize: 0 }), {
        videoEncoder: undefined,
        audio: false,
        maxSize: 0,
    });
    assert.equal(streamConfig.set('__proto__', { maxFps: 30 }).maxFps, 30);
    assert.equal(streamConfig.get('other-device').maxFps, 60);
});

test('malformed control command payloads and invalid PIDs are rejected', () => {
    for (const data of [null, undefined, [], { pid: '1' }, { pid: -1 }, { pid: 1.5 }]) {
        assert.throws(() => ControlCenterCommand.fromJSON(JSON.stringify({ type: 'kill_server', data })));
    }
    for (const config of [null, []]) {
        assert.throws(() =>
            ControlCenterCommand.fromJSON(
                JSON.stringify({
                    type: 'update_stream_config',
                    data: { udid: 'test', config },
                }),
            ),
        );
    }
});

test('tracker announcement flags are independent of running local trackers', () => {
    const config = Object.create(Config.prototype);
    config.fullConfig = {
        runGoogTracker: true,
        runApplTracker: true,
        announceGoogTracker: false,
        announceApplTracker: false,
    };
    assert.equal(config.runLocalGoogTracker, true);
    assert.equal(config.runLocalApplTracker, true);
    assert.equal(config.announceLocalGoogTracker, false);
    assert.equal(config.announceLocalApplTracker, false);
});

test('encoder read returns current quality settings without restarting', async () => {
    const center = Object.create(AndroidControlCenter.prototype);
    center.getDevice = () => ({ listEncoders: async () => [] });
    const reply = await center.runCommand(
        ControlCenterCommand.fromJSON(
            JSON.stringify({
                type: 'list_encoders',
                data: { udid: 'settings-device' },
            }),
        ),
    );
    assert.equal(JSON.parse(reply).config.bitrate, 5000000);
});

test('a stopped broadcast never advertises its stale header as ready', async () => {
    const video = new Socket();
    const control = new Socket();
    const broadcast = new Broadcast(video, control);
    const header = Buffer.alloc(16);
    header.writeUInt32BE(0x68323634, 0);
    header.writeUInt32BE(720, 8);
    header.writeUInt32BE(1280, 12);
    video.emit('data', header);
    assert.equal(await broadcast.whenReady(), true);
    broadcast.stop();
    assert.equal(await broadcast.whenReady(), false);
});

test('leaving a stream while its header is pending does not leak proxy listeners', async (t) => {
    const ready = deferred();
    const control = new EventEmitter();
    let attached = 0;
    const broadcast = {
        whenReady: () => ready.promise,
        getControlSocket: () => control,
        addListener: () => attached++,
        removeListener: () => attached--,
    };
    t.mock.method(broadcastManager, 'getBroadcast', () => broadcast);
    class BrowserSocket extends EventEmitter {
        OPEN = 1;
        CLOSING = 2;
        CLOSED = 3;
        readyState = 1;
        addEventListener(name, listener) {
            this.on(name, listener);
        }
        close() {
            this.readyState = this.CLOSED;
            this.emit('close');
        }
    }
    const socket = new BrowserSocket();
    const proxy = new WebsocketProxy(socket);
    const connecting = proxy.init('test');
    socket.close();
    ready.resolve(true);
    await connecting;
    assert.equal(attached, 0);
    assert.equal(control.listenerCount('close'), 0);
});

test('simultaneous viewers launch only one scrcpy process', async (t) => {
    const launch = deferred();
    const device = Object.create(Device.prototype);
    device.restartChain = Promise.resolve();
    device.TAG = '[test]';
    let pid;
    device.getServerPid = async () => pid;
    device.listEncoders = async () => [];
    // A real launch registers the broadcast; the mock only reports the pid.
    t.mock.method(broadcastManager, 'hasBroadcast', () => pid !== undefined);
    let launches = 0;
    t.mock.method(ScrcpyServer, 'run', async () => {
        launches++;
        await launch.promise;
        pid = 123;
    });
    const first = device.startServer();
    const second = device.startServer();
    await tick();
    assert.equal(launches, 1);
    launch.resolve();
    assert.deepEqual(await Promise.all([first, second]), [123, 123]);
    assert.equal(launches, 1);
});

test('a scrcpy server left behind by a previous ws-scrcpy process is replaced, not reused', async (t) => {
    // Killing ws-scrcpy does not always kill the on-device servers. The next instance then finds
    // a pid but owns no broadcast for it, and without this every viewer is closed with
    // "No active stream for this device yet" until someone kills the phone-side process by hand.
    const device = Object.create(Device.prototype);
    device.restartChain = Promise.resolve();
    device.TAG = '[test]';
    device.udid = 'orphaned';
    let pid = 4242;
    device.getServerPid = async () => pid;
    device.listEncoders = async () => [];
    const killed = [];
    device.killServerNow = async (value) => {
        killed.push(value);
        pid = undefined;
    };
    t.mock.method(broadcastManager, 'hasBroadcast', () => pid === 777);
    t.mock.method(ScrcpyServer, 'run', async () => {
        pid = 777;
    });
    assert.equal(await device.startServer(), 777);
    assert.deepEqual(killed, [4242], 'the orphan is killed before a fresh server is launched');
    assert.equal(device.spawnServer, true, 'the replacement keeps auto-restart semantics');
    assert.equal(await device.startServer(), 777, 'a server with a live broadcast is reused as before');
    assert.deepEqual(killed, [4242]);
});

test('active stream proxies advertise distinct ids and stale releases cannot free a reused id', async (t) => {
    const video = new Socket();
    const control = new Socket();
    const writes = [];
    // No real device is needed to assert the exact cleanup command delivered to the control pipe.
    Object.defineProperty(control, 'readyState', { value: 'open' });
    t.mock.method(control, 'write', (data) => {
        writes.push(Buffer.from(data));
        return true;
    });
    const broadcast = new Broadcast(video, control);
    const header = Buffer.alloc(16);
    header.writeUInt32BE(0x68323634, 0);
    header.writeUInt32BE(720, 8);
    header.writeUInt32BE(1280, 12);
    video.emit('data', header);
    t.mock.method(broadcastManager, 'getBroadcast', () => broadcast);
    class BrowserSocket extends EventEmitter {
        OPEN = 1;
        CLOSING = 2;
        CLOSED = 3;
        readyState = 1;
        sent = [];
        addEventListener(type, listener) {
            this.on(type, listener);
        }
        send(data) {
            this.sent.push(data);
        }
        close() {
            this.readyState = this.CLOSED;
            this.emit('close');
        }
    }
    const proxies = [];
    const nextId = WebsocketProxy.nextClientId;
    t.after(() => {
        proxies.forEach((proxy) => proxy.release());
        broadcast.stop();
        WebsocketProxy.nextClientId = nextId;
    });
    async function join() {
        const socket = new BrowserSocket();
        const proxy = new WebsocketProxy(socket);
        proxies.push(proxy);
        await proxy.init('shared-device');
        const initial = socket.sent[0];
        assert.equal(initial.subarray(0, 14).toString(), 'scrcpy_initial');
        return { proxy, id: initial.readInt32BE(initial.length - 4) };
    }
    const first = await join();
    const second = await join();
    assert.ok(first.id >= 1 && first.id <= 65535);
    assert.notEqual(first.id, second.id);
    const create = Buffer.alloc(3);
    create[0] = 12;
    create.writeUInt16BE(first.id, 1);
    first.proxy.onSocketMessage({ data: create, type: 'message' });
    first.proxy.release();
    assert.equal(writes.at(-1)[0], 14);
    assert.equal(writes.at(-1).readUInt16BE(1), first.id);
    WebsocketProxy.nextClientId = first.id - 1;
    const replacement = await join();
    assert.equal(replacement.id, first.id);
    first.proxy.release();
    assert.equal(writes.length, 2, 'releasing an old proxy again must not destroy the replacement keyboard');
    WebsocketProxy.nextClientId = first.id - 1;
    const fourth = await join();
    assert.notEqual(fourth.id, second.id);
    assert.notEqual(fourth.id, replacement.id);
});

test('scrcpy waits for its jar upload to finish and propagates transfer errors', async () => {
    const transfer = new EventEmitter();
    const device = { push: async () => transfer };
    let completed = false;
    const uploading = ScrcpyServer.copyServer(device).then(() => {
        completed = true;
    });
    await tick();
    assert.equal(completed, false);
    transfer.emit('end');
    await uploading;
    assert.equal(completed, true);
    const failedTransfer = new EventEmitter();
    const failure = ScrcpyServer.copyServer({ push: async () => failedTransfer });
    await tick();
    failedTransfer.emit('error', new Error('USB disconnected'));
    await assert.rejects(failure, /USB disconnected/);
});

test('queued Applies keep each launch config stable and reconnects wait for restart', async () => {
    const restarting = deferred();
    const device = Object.create(Device.prototype);
    device.restartChain = Promise.resolve();
    device.udid = 'queued-device';
    const seen = [];
    device.restartWithCurrentConfig = async () => {
        seen.push(streamConfig.get(device.udid).audio);
        if (seen.length === 1) await restarting.promise;
    };
    device.startServerNow = async () => {
        seen.push('connect');
        return 123;
    };
    const first = device.updateStreamConfig({ audio: false });
    const second = device.updateStreamConfig({ audio: true });
    const connect = device.startServer();
    await tick();
    assert.equal(streamConfig.get(device.udid).audio, false);
    assert.deepEqual(seen, [false]);
    restarting.resolve();
    await Promise.all([first, second, connect]);
    assert.deepEqual(seen, [false, true, 'connect']);
});

test('a failed server operation does not block later reconnects', async () => {
    const device = Object.create(Device.prototype);
    device.restartChain = Promise.resolve();
    let attempts = 0;
    device.startServerNow = async () => {
        if (++attempts === 1) throw new Error('temporary failure');
        return 123;
    };
    await assert.rejects(device.startServer(), /temporary failure/);
    assert.equal(await device.startServer(), 123);
});

test('audio failure changes only launch config and a deliberate Apply retries saved audio settings', async () => {
    const device = Object.create(Device.prototype);
    device.restartChain = Promise.resolve();
    device.udid = 'audio-fallback-device';
    streamConfig.set(device.udid, { audio: true, audioCodec: 'raw', audioSource: 'voice-call-downlink' });
    device.audioFailure = { status: 'error', sampleRate: 48000, channels: 2, message: 'Capture rejected' };
    assert.equal(device.getLaunchStreamConfig().audio, false);
    assert.equal(streamConfig.get(device.udid).audio, true);
    assert.equal(streamConfig.get(device.udid).audioSource, 'voice-call-downlink');
    device.restartWithCurrentConfig = async () => {
        assert.equal(device.getLaunchStreamConfig().audio, true);
    };
    await device.updateStreamConfig({ audioSource: 'output' });
    assert.equal(device.audioFailure, undefined);
    assert.equal(device.getLaunchStreamConfig().audioSource, 'output');
});

test('fatal audio startup logs trigger fallback, while late errors from an intentional restart are ignored', async (t) => {
    const device = Object.create(Device.prototype);
    device.udid = 'audio-log-device';
    device.TAG = '[audio-test]';
    device.descriptor = { pid: 0 };
    device.servicePidRevision = 0;
    device.audioLaunchGeneration = 0;
    device.getServerPid = async () => undefined;
    streamConfig.set(device.udid, { audio: true });
    const child = new EventEmitter();
    child.pid = 123;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    t.mock.method(childProcess, 'spawn', () => child);
    const running = device.runShellCommandAdbSpecial('scrcpy test fixture', device.udid, true);
    child.stderr.emit('data', Buffer.from('[server] ERROR: Audio recording error'));
    assert.equal(device.getLaunchStreamConfig().audio, false);
    await device.killServerNow(123);
    device.audioFailure = undefined;
    child.stderr.emit('data', Buffer.from('[server] ERROR: Audio recording error during old shutdown'));
    assert.equal(device.audioFailure, undefined);
    assert.equal(device.getLaunchStreamConfig().audio, true);
    child.emit('close', 0);
    await running;
});

test('iOS tracking: an attached phone is unauthorized until lockdown answers, then trusted with Developer Mode', async (t) => {
    const calls = [];
    t.mock.method(PyMobileDevice, 'runJson', async (args) => {
        calls.push(args.join(' '));
        if (args[0] === 'usbmux') return ['iphone-1'];
        if (args[0] === 'lockdown') {
            if (calls.filter((call) => call.startsWith('lockdown')).length === 1) {
                throw new Error('PairingDialogResponsePendingError: user needs to trust');
            }
            return { DeviceName: 'Bench iPhone', ProductType: 'iPhone14,5', ProductVersion: '27.0' };
        }
        if (args[0] === 'amfi') return false;
        throw new Error(`unexpected ${args.join(' ')}`);
    });
    const tracker = new IosControlCenter();
    const seen = [];
    tracker.on('device', (device) => seen.push({ ...device }));
    await tracker.init();
    await tick();
    await tick();
    const first = seen.find((d) => d.state === 'unauthorized');
    assert(first, 'an untrusted phone shows as unauthorized rather than being hidden');
    assert.equal(first.paired, false);
    // The Trust prompt was answered: force the next details refresh.
    tracker.tracked.get('iphone-1').detailsAt = 0;
    await tracker.poll();
    await tick();
    await tick();
    const trusted = seen[seen.length - 1];
    assert.equal(trusted.state, 'Connected');
    assert.equal(trusted.name, 'Bench iPhone');
    assert.equal(trusted.version, '27.0');
    assert.equal(trusted.developerMode, false, 'Developer Mode off is reported, not assumed');
    assert.equal(trusted.session, 'stopped');
    tracker.release();
});

test('iOS tracking: unplugging stops the screen session and releasing stops polling', async (t) => {
    let listed = ['iphone-2'];
    t.mock.method(PyMobileDevice, 'runJson', async (args) => {
        if (args[0] === 'usbmux') return listed;
        if (args[0] === 'lockdown') return { DeviceName: 'Two', ProductType: 'iPhone14,5', ProductVersion: '27.0' };
        if (args[0] === 'amfi') return true;
        throw new Error(`unexpected ${args.join(' ')}`);
    });
    const stopped = [];
    t.mock.method(CoreDeviceRunner.getInstance(), 'stopSession', (udid, reason) => stopped.push({ udid, reason }));
    const tracker = new IosControlCenter();
    await tracker.init();
    await tick();
    await tick();
    listed = [];
    await tracker.poll();
    assert.deepEqual(stopped, [{ udid: 'iphone-2', reason: 'Device disconnected' }]);
    assert.equal(tracker.getDevices()[0].state, 'disconnected');
    // A viewer still on that phone's page keeps retrying, and every attempt fails with
    // "usbmux has no device matching udid". That must not stamp an error on a card whose real
    // story is simply "unplugged".
    CoreDeviceRunner.getInstance().emit('status', {
        udid: 'iphone-2',
        state: 'error',
        message: 'Could not mount the Developer Disk Image: Device not found',
    });
    const offline = tracker.getDevices()[0];
    assert.equal(offline.session, 'stopped');
    assert.equal(offline.sessionMessage, undefined, 'an unplugged phone shows no stale session error');
    tracker.release();
    let polls = 0;
    t.mock.method(PyMobileDevice, 'runJson', async () => {
        polls++;
        return [];
    });
    await tracker.poll();
    assert.equal(polls, 0, 'a released tracker never spawns another pymobiledevice3 process');
    CoreDeviceRunner.getInstance().release();
});
