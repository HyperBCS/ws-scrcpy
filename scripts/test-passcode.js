/* eslint-disable */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
require('ts-node').register({ transpileOnly: true });
const { passcodeMessages, MAX_PASSCODE_LENGTH, UnlockRequestError } = require('../src/app/googDevice/client/passcode');
const { TextControlMessage } = require('../src/app/controlMessage/TextControlMessage');
const { submitDevicePasscode, requestLockState } = require('../src/app/state/unlockDevice');
const { activeStream, unlockSheetOpen } = require('../src/app/state/stream');
const { devices } = require('../src/app/state/devices');
const { findDeviceForStream } = require('../src/app/state/streamDevice');

const locked = {
    'device.locked': true,
    'keyguard.showing': true,
    'keyguard.occluded': false,
    'screen.power': 'on',
};

function fixture(t, states = [locked, locked]) {
    const tracker = new EventEmitter();
    const requests = [];
    const sent = [];
    let id = 0;
    let ready = true;
    let clientId = 7;
    tracker.sendCommand = (type, data) => {
        const requestId = ++id;
        requests.push({ type, data });
        const state = states[requestId - 1];
        if (state) queueMicrotask(() => tracker.emit(type, { ...state, udid: 'test', requestId }));
        return requestId;
    };
    const client = {
        getClientId: () => clientId,
        isControlReady: () => ready,
        sendImmediateMessages: (messages) => {
            if (!ready) return false;
            sent.push(messages.map((message) => message.toBuffer()));
            return true;
        },
    };
    const params = {
        action: 'stream',
        udid: 'test',
        player: 'mse',
        ws: 'ws://127.0.0.1:8000/?action=proxy-adb&remote=tcp%3A8886&udid=test',
    };
    const previousLocation = global.location;
    global.location = { hash: '#!' + new URLSearchParams(params), pathname: '/' };
    devices.value = new Map([
        [
            'test',
            {
                tracker,
                params: { type: 'android', hostname: '127.0.0.1', port: 8000, pathname: '/' },
                descriptor: { udid: 'test', interfaces: [] },
            },
        ],
    ]);
    activeStream.value = { client, params };
    unlockSheetOpen.value = true;
    t.after(() => {
        devices.value = new Map();
        activeStream.value = undefined;
        unlockSheetOpen.value = false;
        global.location = previousLocation;
    });
    return {
        tracker,
        requests,
        sent,
        client,
        disconnect: () => {
            ready = false;
        },
        replace: () => {
            clientId++;
        },
    };
}

test('passcode batch clears partial input, types once, and submits once without clipboard commands', () => {
    const messages = passcodeMessages('0427');
    assert.equal(messages.length, MAX_PASSCODE_LENGTH * 2 + 3);
    const packets = messages.map((message) => message.toBuffer());
    for (let index = 0; index < MAX_PASSCODE_LENGTH * 2; index++) {
        assert.equal(packets[index][0], 0);
        assert.equal(packets[index][1], index % 2);
        assert.equal(packets[index].readInt32BE(2), 67);
    }
    assert.equal(packets.at(-3)[0], 1);
    assert.equal(packets.at(-3).subarray(5).toString(), '0427');
    assert.equal(packets.at(-2).readInt32BE(2), 66);
    assert.equal(packets.at(-1)[1], 1);
    for (const invalid of ['', 'a'.repeat(129), '12\n34', '🔒', '12\u000034']) {
        assert.throws(() => passcodeMessages(invalid), UnlockRequestError);
    }
    assert.equal(passcodeMessages(' A!%+$"\\').at(-3).getText(), ' A!%+$"\\');
});

test('text frames use UTF-8 byte length so non-ASCII input cannot corrupt following control messages', () => {
    const text = 'café🔒';
    const packet = new TextControlMessage(text).toBuffer();
    assert.equal(packet.readUInt32BE(1), Buffer.byteLength(text));
    assert.equal(packet.subarray(5).toString(), text);
});

test('only two fresh matching lock replies permit a single credential submission', async (t) => {
    const f = fixture(t);
    assert.equal(await submitDevicePasscode(f.client, 'test', '0427', new AbortController().signal), true);
    assert.deepEqual(
        f.requests,
        [
            { type: 'get_lock_state', data: { udid: 'test' } },
            { type: 'get_lock_state', data: { udid: 'test' } },
        ],
        'tracker receives no credential',
    );
    assert.equal(f.sent.length, 3, 'wake, keypad, credential batch');
    assert.equal(f.sent[0][0].readInt32BE(2), 224);
    assert.equal(f.sent[1][0].readInt32BE(2), 82);
    assert.equal(f.sent.flat().filter((packet) => packet[0] === 1).length, 1);
    assert.equal(f.tracker.listenerCount('get_lock_state'), 0);
});

test('unknown, unlocked, or occluded lock state never receives credential input', async (t) => {
    for (const state of [
        { ...locked, 'device.locked': false },
        { ...locked, 'device.locked': 'unknown' },
        { ...locked, 'keyguard.showing': false },
        { ...locked, 'keyguard.occluded': true },
        { ...locked, 'keyguard.occluded': 'unknown' },
    ]) {
        const f = fixture(t, [state]);
        await assert.rejects(
            submitDevicePasscode(f.client, 'test', '0427', new AbortController().signal),
            UnlockRequestError,
        );
        assert.deepEqual(f.sent, []);
    }
});

test('waking into an unlocked screen cancels credential submission', async (t) => {
    const f = fixture(t, [locked, { ...locked, 'device.locked': false, 'keyguard.showing': false }]);
    await assert.rejects(
        submitDevicePasscode(f.client, 'test', '0427', new AbortController().signal),
        /already unlocked/,
    );
    assert.equal(f.sent.length, 2);
    assert.equal(
        f.sent.flat().some((packet) => packet[0] === 1),
        false,
    );
});

test('abort while waiting for lock reply removes listeners and cannot send after a late reply', async (t) => {
    const f = fixture(t, []);
    const controller = new AbortController();
    const pending = submitDevicePasscode(f.client, 'test', '0427', controller.signal);
    controller.abort();
    await assert.rejects(pending, /canceled/);
    f.tracker.emit('get_lock_state', { ...locked, udid: 'test', requestId: 1 });
    assert.deepEqual(f.sent, []);
    assert.equal(f.tracker.listenerCount('get_lock_state'), 0);
});

test('closed sheet, replaced stream, and disconnected control all cancel a pending submission', async (t) => {
    for (const mutate of [
        () => {
            unlockSheetOpen.value = false;
        },
        (f) => f.replace(),
        (f) => f.disconnect(),
        () => {
            global.location.hash = '#!action=stream&udid=test&player=webcodecs&ws=other';
        },
    ]) {
        const f = fixture(t, []);
        const pending = submitDevicePasscode(f.client, 'test', '0427', new AbortController().signal);
        mutate(f);
        f.tracker.emit('get_lock_state', { ...locked, udid: 'test', requestId: 1 });
        await assert.rejects(pending, /connection changed/);
        assert.deepEqual(f.sent, []);
    }
});

test('duplicate serials bind lock telemetry to the exact stream endpoint and reject ambiguous matches', (t) => {
    const f = fixture(t);
    const original = devices.value.get('test');
    const other = { ...original, tracker: new EventEmitter(), params: { ...original.params, hostname: '10.10.10.20' } };
    devices.value = new Map([
        ['other', other],
        ['test', original],
    ]);
    assert.equal(findDeviceForStream(activeStream.value.params).tracker, f.tracker);
    const reordered = {
        ...activeStream.value.params,
        ws: 'ws://127.0.0.1:8000/?udid=test&remote=tcp%3A8886&action=proxy-adb',
    };
    assert.equal(findDeviceForStream(reordered).tracker, f.tracker);
    assert.equal(findDeviceForStream({ ...reordered, ws: 'ws://10.10.10.99:8000/' }), undefined);
    devices.value = new Map([
        ['test', original],
        ['ambiguous', { ...original, tracker: new EventEmitter() }],
    ]);
    assert.equal(findDeviceForStream(activeStream.value.params), undefined);
});

test('lock requests ignore replies for another request or device and have a bounded timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, []);
    let settled = false;
    const pending = requestLockState(f.tracker, 'test', new AbortController().signal);
    pending.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    f.tracker.emit('get_lock_state', { ...locked, udid: 'other', requestId: 1 });
    f.tracker.emit('get_lock_state', { ...locked, udid: 'test', requestId: 9 });
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(8000);
    await assert.rejects(pending, /timed out/);
    assert.equal(f.tracker.listenerCount('get_lock_state'), 0);
});
