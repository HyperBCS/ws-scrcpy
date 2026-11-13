// Deterministic tracker lifecycle regressions; no server, browser, or device required.
const assert = require('node:assert/strict');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

global.location = new URL('http://localhost:8000/');
const { BaseDeviceTracker, STALE_LIST_LIMIT_MS } = require('../src/app/client/BaseDeviceTracker');
const { ManagerClient } = require('../src/app/client/ManagerClient');
const { HostTracker } = require('../src/app/client/HostTracker');
const { DeviceTracker: AndroidTracker } = require('../src/app/googDevice/client/DeviceTracker');
const { DeviceTracker: IosTracker } = require('../src/app/applDevice/client/DeviceTracker');
const { devices, findDeviceByUdid, isDeviceAvailable, listReceived } = require('../src/app/state/devices');
const { findDeviceForTool } = require('../src/app/state/toolDevice');
const { getStreamServiceStatus, hasRunningStreamService } = require('../src/app/state/streamService');
const { markStarting, clearStarting, isDeviceStarting, getDeviceStatusInfo } = require('../src/app/state/deviceStatus');

// Pending timers by id, each callback with the delay it was set for.
const timers = new Map();
let nextTimer = 0;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
global.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    // Fired by hand. Like a real timer, it is no longer pending once it has run.
    timers.set(id, Object.assign(() => { timers.delete(id); callback(); }, { delay }));
    return id;
};
global.clearTimeout = (id) => timers.delete(id);
const delays = () => [...timers.values()].map((timer) => timer.delay).sort((a, b) => a - b);
/** The one pending timer set for `delay`. */
const timerFor = (delay) => {
    const found = [...timers.entries()].filter(([, timer]) => timer.delay === delay);
    assert.equal(found.length, 1, `one timer of ${delay} ms`);
    return found[0];
};
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
const listMessage = (id, ...udids) => ({ data: JSON.stringify({ id: -1, type: 'devicelist', data: { id, name: 'Test host', list: udids.map((udid) => ({ udid, state: 'device' })) } }) });
const deviceMessage = (id, udid) => ({ data: JSON.stringify({ id: -1, type: 'device', data: { id, name: 'Test host', device: { udid, state: 'device' } } }) });
const listed = () => [...devices.value.values()].map((entry) => `${entry.descriptor.udid}${entry.stale ? ' (stale)' : ''}`).sort();

try {
    const pending = new TestTracker(params, 'ws://localhost:8000/?action=pending');
    let pendingCloses = 0;
    pending.ws = { readyState: 0, CONNECTING: 0, OPEN: 1, close() { pendingCloses++; } };
    pending.destroy();
    assert.equal(pendingCloses, 1, 'Navigating away cancels a tool or tracker that is still connecting');
    const tracker = new TestTracker(params, 'ws://localhost:8000/?action=test');
    assert.equal(listReceived.value, false, 'Before the first list the Phones list is loading');
    tracker.onSocketMessage(listMessage('tracker-a', 'phone-a'));
    assert.equal(devices.value.size, 1);
    assert.equal(listReceived.value, true);
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
    // U-home-8: the phone stays on the list, marked stale. It is not available, its status is
    // the one it last had and not Offline, and the pages of one phone do not find it.
    assert.deepEqual(listed(), ['phone-a (stale)'], 'A closed tracker keeps its phones, marked stale');
    const kept = [...devices.value.values()][0];
    assert.equal(isDeviceAvailable(kept), false, 'A stale phone is not available');
    assert.equal(getDeviceStatusInfo(kept).status, 'ready', 'A stale phone is not called Offline');
    assert.equal(findDeviceByUdid('phone-a'), undefined, "A phone's page does not take a stale entry");
    assert.equal(tracker.getDescriptorByUdid('phone-a'), undefined);
    assert.deepEqual(delays(), [2000, STALE_LIST_LIMIT_MS], 'Close notifications share one reconnect timer and one limit');
    assert.equal(STALE_LIST_LIMIT_MS, 30000);
    const delayedReconnect = timerFor(2000)[1];
    tracker.destroy();
    assert.equal(timers.size, 0, 'Destroy cancels the reconnect timer and the limit');
    assert.equal(devices.value.size, 0, 'Destroy removes the stale phones');
    delayedReconnect();
    assert.equal(connections.get(tracker) || 0, 0, 'A callback already queued before destroy must not resurrect the tracker');
    tracker.onSocketMessage(listMessage('tracker-a', 'late-phone'));
    assert.equal(devices.value.size, 0, 'Late messages cannot republish destroyed devices');

    // A reconnect: the next list replaces the stale phones, and a phone it does not name goes.
    const restarted = new TestTracker(params, 'ws://localhost:8000/?action=restarted');
    restarted.onSocketMessage(listMessage('tracker-r', 'phone-a', 'phone-b'));
    restarted.onSocketClose({ reason: 'Server restart' });
    assert.deepEqual(listed(), ['phone-a (stale)', 'phone-b (stale)']);
    assert.equal(listReceived.value, true, 'A stale list is still a list: the page is not loading');
    const [limitId] = timerFor(STALE_LIST_LIMIT_MS);
    // A reconnect that fails closes again. The limit counts from the first close.
    timerFor(2000)[1]();
    assert.equal(connections.get(restarted), 1, 'The reconnect keeps its 2 s timer');
    restarted.onSocketClose({ reason: 'Still down' });
    assert.equal(timerFor(STALE_LIST_LIMIT_MS)[0], limitId, 'A second close does not restart the limit');
    timerFor(2000)[1]();
    restarted.onSocketMessage(listMessage('tracker-r', 'phone-a'));
    assert.deepEqual(listed(), ['phone-a'], 'The new list replaces the stale phones; phone-b is gone');
    assert.deepEqual(delays(), [], 'The list ends the limit');
    // A tracker that stays closed past the limit takes its phones off the list.
    restarted.onSocketClose({ reason: 'Server gone' });
    assert.deepEqual(listed(), ['phone-a (stale)']);
    timerFor(2000)[1]();
    restarted.onSocketClose({ reason: 'Still gone' });
    timerFor(STALE_LIST_LIMIT_MS)[1]();
    assert.deepEqual(listed(), [], 'Past the limit the stale phones are cleared');
    assert.equal(listReceived.value, false, 'and the list loads again when the server is back');
    // With two servers, one that stays away does not put the other's list back to loading.
    const other = new TestTracker({ ...params, hostname: 'other.test' }, 'ws://other.test:8000/?action=other');
    other.onSocketMessage(listMessage('tracker-o'));
    restarted.onSocketMessage(listMessage('tracker-r', 'phone-a'));
    restarted.onSocketClose({ reason: 'Server gone again' });
    timerFor(STALE_LIST_LIMIT_MS)[1]();
    assert.deepEqual([listed(), listReceived.value], [[], true], 'An empty list from a live server is still the empty state');
    other.destroy();
    assert.equal(listReceived.value, false);
    restarted.destroy();
    timers.clear();

    // An individual update ends only that phone's stale generation. Its siblings retain their
    // original deadline, even when the tracker closes again before the first deadline fires.
    const partial = new TestTracker(params, 'ws://localhost:8000/?action=partial');
    partial.onSocketMessage(listMessage('partial-old', 'fresh-phone', 'stale-sibling'));
    partial.onSocketClose({ reason: 'First drop' });
    const [, olderLimit] = timerFor(STALE_LIST_LIMIT_MS);
    partial.onSocketMessage(deviceMessage('partial-old', 'fresh-phone'));
    assert.deepEqual(listed(), ['fresh-phone', 'stale-sibling (stale)']);
    assert.equal(findDeviceByUdid('fresh-phone')?.tracker, partial);
    olderLimit();
    assert.deepEqual(listed(), ['fresh-phone'], 'A fresh individual update survives the older limit; stale siblings expire');
    assert.equal(listReceived.value, true, 'The individual update is still a current list report');
    partial.onSocketMessage(listMessage('partial-old', 'fresh-phone', 'stale-sibling'));
    partial.onSocketClose({ reason: 'Another drop' });
    const [, siblingLimit] = timerFor(STALE_LIST_LIMIT_MS);
    partial.onSocketMessage(deviceMessage('partial-old', 'fresh-phone'));
    partial.onSocketClose({ reason: 'Fresh phone dropped later' });
    assert.equal([...timers.values()].filter((timer) => timer.delay === STALE_LIST_LIMIT_MS).length, 2);
    siblingLimit();
    assert.deepEqual(listed(), ['fresh-phone (stale)'], 'An older close cannot expire a newer stale generation');
    const [newLimitId, newLimit] = timerFor(STALE_LIST_LIMIT_MS);
    partial.onSocketClose({ reason: 'Repeated failure' });
    assert.equal(timerFor(STALE_LIST_LIMIT_MS)[0], newLimitId, 'Repeated close keeps the newer generation bounded');
    newLimit();
    assert.deepEqual([listed(), listReceived.value], [[], false], 'The newer stale generation also expires');
    partial.onSocketMessage(listMessage('partial-old', 'old-phone'));
    partial.onSocketClose({ reason: 'Server restart' });
    const [, oldIdLimit] = timerFor(STALE_LIST_LIMIT_MS);
    partial.onSocketMessage(deviceMessage('partial-new', 'new-phone'));
    oldIdLimit();
    assert.deepEqual([listed(), listReceived.value], [['new-phone'], true], 'A tracker-id change and fresh individual report survive the old timer');
    partial.onSocketMessage(listMessage('partial-new'));
    assert.deepEqual(listed(), [], 'A full list remains authoritative over individual updates');
    partial.onSocketMessage(listMessage('partial-new', 'release-phone'));
    partial.onSocketClose({ reason: 'Release' });
    const queued = [...timers.values()];
    partial.destroy();
    partial.destroy();
    assert.equal(timers.size, 0, 'Release clears every reconnect and stale-generation timer');
    queued.forEach((callback) => callback());
    assert.deepEqual([listed(), listReceived.value], [[], false], 'Callbacks queued before release cannot publish or remove phones');

    const survivor = new TestTracker(params, 'ws://localhost:8000/?action=survivor');
    survivor.onSocketMessage(listMessage('shared-id', 'surviving-phone'));
    const duplicate = new TestTracker(params, 'ws://localhost:8000/?action=duplicate');
    duplicate.setIdAndHostName('shared-id', 'Test host');
    duplicate.destroy();
    assert.equal(devices.value.size, 1, 'Destroying a duplicate URL must preserve the surviving tracker cards');
    survivor.destroy();
    assert.equal(devices.value.size, 0);

    // A server that tracks no phones sends no list: the Phones list is empty, not loading.
    assert.equal(listReceived.value, false);
    const bare = new HostTracker();
    bare.onSocketMessage({ data: JSON.stringify({ id: -1, type: 'hosts', data: { local: [] } }) });
    assert.equal(listReceived.value, true, 'A host list with no trackers ends the loading state');
    bare.destroy();
    assert.equal(listReceived.value, false);

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
    localToolTracker.onSocketClose({ reason: 'Network lost' });
    assert.equal(findDeviceForTool({ action: 'shell', udid: 'same-serial' }), undefined, 'A tool does not take a stale entry for its status');
    localToolTracker.onSocketMessage(listMessage('tool-local', 'same-serial'));
    timers.clear();
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
    console.log('PASS: a closed tracker keeps its phones stale until the next list, and clears them past the limit');
    console.log('PASS: stream-service running/stopped/starting/offline/unauthorized/unknown status transitions');
} finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    ManagerClient.prototype.openNewConnection = originalOpen;
}
