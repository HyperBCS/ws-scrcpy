// Deterministic tracker lifecycle regressions; no server, browser, or device required.
const assert = require('node:assert/strict');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

global.location = new URL('http://localhost:8000/');
const { BaseDeviceTracker } = require('../src/app/client/BaseDeviceTracker');
const { ManagerClient } = require('../src/app/client/ManagerClient');
const { HostTracker } = require('../src/app/client/HostTracker');
const { DeviceTracker: AndroidTracker } = require('../src/app/googDevice/client/DeviceTracker');
const { DeviceTracker: IosTracker } = require('../src/app/applDevice/client/DeviceTracker');
const { devices } = require('../src/app/state/devices');
const { findDeviceForTool } = require('../src/app/state/toolDevice');
const { getStreamServiceStatus, hasRunningStreamService } = require('../src/app/state/streamService');
const { markStarting, clearStarting, isDeviceStarting } = require('../src/app/state/deviceStatus');

const timers = new Map();
let nextTimer = 0;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
global.setTimeout = (callback) => {
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
};
global.clearTimeout = (id) => timers.delete(id);
const connections = new WeakMap();
const originalOpen = ManagerClient.prototype.openNewConnection;
ManagerClient.prototype.openNewConnection = function () {
    connections.set(this, (connections.get(this) || 0) + 1);
    return undefined;
};

class TestTracker extends BaseDeviceTracker {
    getChannelCode() { return 'TEST'; }
    onSocketOpen() {}
}
const params = { hostname: 'localhost', port: 8000, pathname: '/', secure: false, type: 'android', action: 'test' };
const listMessage = (id, udid) => ({ data: JSON.stringify({ id: -1, type: 'devicelist', data: { id, name: 'Test host', list: [{ udid, state: 'device' }] } }) });

try {
    const pending = new TestTracker(params, 'ws://localhost:8000/?action=pending');
    let pendingCloses = 0;
    pending.ws = { readyState: 0, CONNECTING: 0, OPEN: 1, close() { pendingCloses++; } };
    pending.destroy();
    assert.equal(pendingCloses, 1, 'Navigating away cancels a tool or tracker that is still connecting');
    const tracker = new TestTracker(params, 'ws://localhost:8000/?action=test');
    tracker.onSocketMessage(listMessage('tracker-a', 'phone-a'));
    assert.equal(devices.value.size, 1);
    const commands = [];
    tracker.ws = { readyState: 1, OPEN: 1, send: (data) => commands.push(JSON.parse(data)), close() {} };
    const requestId = tracker.sendCommand('update_stream_config', { udid: 'phone-a', config: { maxFps: 30 } });
    let reply;
    tracker.on('update_stream_config', (data) => { reply = data; });
    tracker.onSocketMessage({ data: JSON.stringify({ id: requestId, type: 'update_stream_config', data: { udid: 'phone-a', config: { maxFps: 30 } } }) });
    assert.equal(commands[0].id, requestId);
    assert.equal(reply.requestId, requestId, 'Command replies retain their request ID for stale-reply filtering');
    tracker.onSocketClose({ reason: 'Network lost' });
    tracker.onSocketClose({ reason: 'Duplicate close notification' });
    assert.equal(devices.value.size, 0, 'Disconnected devices must not remain available');
    assert.equal(tracker.getDescriptorByUdid('phone-a'), undefined);
    assert.equal(timers.size, 1, 'Close notifications share one reconnect timer');
    const delayedReconnect = [...timers.values()][0];
    tracker.destroy();
    assert.equal(timers.size, 0, 'Destroy cancels the reconnect timer');
    delayedReconnect();
    assert.equal(connections.get(tracker) || 0, 0, 'A callback already queued before destroy must not resurrect the tracker');
    tracker.onSocketMessage(listMessage('tracker-a', 'late-phone'));
    assert.equal(devices.value.size, 0, 'Late messages cannot republish destroyed devices');

    const survivor = new TestTracker(params, 'ws://localhost:8000/?action=survivor');
    survivor.onSocketMessage(listMessage('shared-id', 'surviving-phone'));
    const duplicate = new TestTracker(params, 'ws://localhost:8000/?action=duplicate');
    duplicate.setIdAndHostName('shared-id', 'Test host');
    duplicate.destroy();
    assert.equal(devices.value.size, 1, 'Destroying a duplicate URL must preserve the surviving tracker cards');
    survivor.destroy();
    assert.equal(devices.value.size, 0);

    const host = new HostTracker();
    let connected = 0;
    host.on('connected', () => connected++);
    const hostMessage = { data: JSON.stringify({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } }) };
    host.onSocketMessage(hostMessage);
    host.onSocketMessage(hostMessage);
    assert.equal(host.trackers.size, 2, 'Repeated host lists do not duplicate owned trackers');
    assert.equal(connected, 2, 'A successful host list clears disconnected UI state');
    const removedIos = [...host.trackers].find((child) => child instanceof IosTracker);
    host.onSocketMessage({ data: JSON.stringify({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }] } }) });
    assert.equal(host.trackers.size, 1);
    assert.equal(removedIos.destroyed, true, 'Removed hosts release their child tracker');
    const freshIos = IosTracker.start({ ...params, type: 'ios' });
    assert.notEqual(freshIos, removedIos, 'Destroyed iOS trackers are removed from their direct URL cache');
    freshIos.destroy();
    const oldAndroid = [...host.trackers][0];
    host.onSocketClose({ reason: 'Network lost' });
    assert.equal(timers.size, 1, 'Host discovery retries after a lost connection');
    const retry = [...timers.values()][0];
    timers.clear();
    retry();
    assert.equal(connections.get(host), 2);
    host.onSocketClose({ reason: 'Lost again' });
    const staleRetry = [...timers.values()][0];
    host.destroy();
    assert.equal(timers.size, 0);
    staleRetry();
    assert.equal(connections.get(host), 2, 'Destroyed host discovery cannot restart');
    const freshAndroid = AndroidTracker.start(params);
    assert.notEqual(freshAndroid, oldAndroid, 'Destroyed Android trackers are removed from their direct URL cache');
    freshAndroid.destroy();
    const localToolTracker = new TestTracker(params, 'ws://localhost:8000/?action=tool-local');
    const remoteToolTracker = new TestTracker({ ...params, hostname: 'remote.test' }, 'ws://remote.test:8000/?action=tool-remote');
    localToolTracker.onSocketMessage(listMessage('tool-local', 'same-serial'));
    remoteToolTracker.onSocketMessage(listMessage('tool-remote', 'same-serial'));
    assert.equal(findDeviceForTool({ action: 'shell', udid: 'same-serial' }).trackerId, 'tool-local', 'Local tool status uses its own server');
    assert.equal(findDeviceForTool({ action: 'shell', udid: 'same-serial', hostname: 'remote.test', port: 8000, useProxy: true }).trackerId, 'tool-remote', 'Proxied tool status binds to the remote host with the same serial');
    assert.equal(findDeviceForTool({ action: 'shell', udid: 'same-serial', hostname: 'remote.test', port: 8000, pathname: '/another-server/' }), undefined, 'A different server path cannot borrow telemetry');
    localToolTracker.destroy();
    remoteToolTracker.destroy();
    assert.equal(getStreamServiceStatus(undefined).state, 'unknown');
    for (const pid of [undefined, null, 0, -2, 1.5, NaN, Infinity, '123']) {
        assert.equal(hasRunningStreamService(pid), false);
        assert.equal(getStreamServiceStatus({ state: 'device', pid }).state, 'unknown');
    }
    assert.equal(getStreamServiceStatus({ state: 'device', pid: -1 }).state, 'stopped');
    assert.equal(getStreamServiceStatus({ state: 'device', pid: 123 }).state, 'running');
    assert.equal(getStreamServiceStatus({ state: 'offline', pid: 123 }).state, 'offline');
    assert.equal(getStreamServiceStatus({ state: 'disconnected', pid: 123 }).state, 'offline');
    assert.equal(getStreamServiceStatus({ state: 'unauthorized', pid: 123 }).state, 'unauthorized');
    assert.equal(getStreamServiceStatus({ state: 'recovery', pid: 123 }).state, 'unknown');
    const serviceKey = 'tracker-a:phone-a';
    markStarting(serviceKey);
    assert.equal(isDeviceStarting(serviceKey), true);
    assert.equal(getStreamServiceStatus({ state: 'device', pid: 0 }, isDeviceStarting(serviceKey)).state, 'starting');
    assert.equal(getStreamServiceStatus({ state: 'device', pid: 123 }, true).state, 'running', 'Observed process wins over optimistic starting');
    assert.equal(getStreamServiceStatus({ state: 'offline', pid: -1 }, true).state, 'offline');
    clearStarting(serviceKey);
    assert.equal(isDeviceStarting(serviceKey), false);
    assert.equal(getStreamServiceStatus({ state: 'device', pid: -1 }, isDeviceStarting(serviceKey)).state, 'stopped');
    console.log('PASS: tracker cleanup, reconnect ownership, cache eviction, host recovery, and command request IDs');
    console.log('PASS: stream-service running/stopped/starting/offline/unauthorized/unknown status transitions');
} finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    ManagerClient.prototype.openNewConnection = originalOpen;
}
