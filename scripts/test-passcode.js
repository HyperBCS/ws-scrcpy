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
const { readSavedPasscode, savePasscode, forgetPasscode, purgeLegacyPasscodes } = require('../src/app/state/savedPasscode');
const { sendUnlockCommand, runUnlockNow, unlockCardLine, formatUnlockMoment } = require('../src/app/state/unlockSchedule');
const {
    sendTrackerCommand,
    sendServiceCommand,
    serviceCommandTimeoutMs,
    replyText,
    TrackerCommandAborted,
} = require('../src/app/client/trackerCommand');

function fakeStorage(t) {
    const previous = Object.getOwnPropertyDescriptor(global, 'localStorage');
    const values = new Map();
    Object.defineProperty(global, 'localStorage', { configurable: true, value: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
        key: index => [...values.keys()][index] ?? null,
        get length() { return values.size; },
    } });
    t.after(() => { if (previous) Object.defineProperty(global, 'localStorage', previous); else delete global.localStorage; });
    return values;
}

test('passcodes saved by an earlier version are removed once, whatever the device; remembered ones and other keys stay', (t) => {
    const values = fakeStorage(t);
    values.set('ws-scrcpy:passcode:android-a', '{"value":"000719","mode":"pin"}');
    values.set('ws-scrcpy:passcode:iphone-b', '{"value":"246810","mode":"pin"}');
    values.set('ws-scrcpy:remembered-passcode:android-a', '{"value":"1234","mode":"pin"}');
    values.set('ws-scrcpy:theme', 'dark');
    assert.equal(readSavedPasscode('iphone-b'), undefined, 'the old copies are not read any more');
    assert.equal(purgeLegacyPasscodes(), 2);
    assert.deepEqual([...values.keys()].sort(), ['ws-scrcpy:remembered-passcode:android-a', 'ws-scrcpy:theme']);
    assert.equal(purgeLegacyPasscodes(), 0, 'nothing left for a second run');
    assert.deepEqual(readSavedPasscode('android-a'), { value: '1234', mode: 'pin' });
    Object.defineProperty(global, 'localStorage', { configurable: true, get() { throw Error('Storage blocked'); } });
    assert.equal(purgeLegacyPasscodes(), 0, 'blocked storage is not an error');
});

test('remembered passcodes preserve leading zeros and password mode, stay per device, and can be forgotten', (t) => {
    const values = fakeStorage(t);
    assert.equal(readSavedPasscode('phone-a'), undefined);
    assert.equal(savePasscode('phone-a', '000719', 'pin'), true);
    assert.equal(savePasscode('phone-b', 'Fixture 7!', 'password'), true);
    assert.deepEqual(readSavedPasscode('phone-a'), { value: '000719', mode: 'pin' });
    assert.deepEqual(readSavedPasscode('phone-b'), { value: 'Fixture 7!', mode: 'password' });
    assert.equal(forgetPasscode('phone-a'), true);
    assert.equal(readSavedPasscode('phone-a'), undefined);
    assert.equal(readSavedPasscode('phone-b').value, 'Fixture 7!');
    for (const value of ['invalid json', 'null', '{"value":4,"mode":"pin"}', '{"value":"bad","mode":"pin"}']) {
        values.set('ws-scrcpy:remembered-passcode:phone-a', value);
        assert.equal(readSavedPasscode('phone-a'), undefined);
    }
    Object.defineProperty(global, 'localStorage', { configurable: true, get() { throw Error('Storage blocked'); } });
    assert.equal(readSavedPasscode('phone-a'), undefined);
    assert.equal(savePasscode('phone-a', '000719', 'pin'), false);
    assert.equal(forgetPasscode('phone-a'), false);
});

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

// The iOS scheduled-unlock commands share the tracker request/reply shape above; `queued` replies
// arrive on the next microtask with the request's own id, as the real tracker would deliver them.
function unlockTracker(queued = []) {
    const tracker = new EventEmitter();
    const sent = [];
    let id = 0;
    tracker.sendCommand = (type, data) => {
        const requestId = ++id;
        sent.push({ type, data });
        const reply = queued.shift();
        if (reply) queueMicrotask(() => tracker.emit(type, { udid: 'test', requestId, ...reply }));
        return requestId;
    };
    return { tracker, sent };
}

test('scheduled-unlock commands resolve on the matching reply only, parse the result and reject errors', async () => {
    const { tracker, sent } = unlockTracker();
    const pending = sendUnlockCommand(tracker, 'update_unlock_schedule', 'test', { schedule: { enabled: true } }, 1000);
    assert.deepEqual(sent, [{ type: 'update_unlock_schedule', data: { udid: 'test', schedule: { enabled: true } } }]);
    tracker.emit('update_unlock_schedule', { udid: 'other', requestId: 1, result: '{"enabled":false}' });
    tracker.emit('update_unlock_schedule', { udid: 'test', requestId: 2, result: '{"enabled":false}' });
    tracker.emit('update_unlock_schedule', { udid: 'test', requestId: 1, result: JSON.stringify({ enabled: true, time: '03:00', hasPasscode: true }) });
    assert.deepEqual(await pending, { enabled: true, time: '03:00', hasPasscode: true }, 'another device or request id is ignored');
    assert.equal(tracker.listenerCount('update_unlock_schedule'), 0, 'the listener is removed once settled');

    const failing = unlockTracker([{ error: 'Invalid passcode: use 4 to 10 digits' }]);
    await assert.rejects(sendUnlockCommand(failing.tracker, 'set_unlock_passcode', 'test', { passcode: '12' }, 1000), /Invalid passcode: use 4 to 10 digits/);
    assert.equal(failing.tracker.listenerCount('set_unlock_passcode'), 0);
    assert.deepEqual(failing.sent, [{ type: 'set_unlock_passcode', data: { udid: 'test', passcode: '12' } }], 'the passcode travels in the command and nowhere else');

    const unreadable = unlockTracker([{ result: '{not json' }]);
    await assert.rejects(sendUnlockCommand(unreadable.tracker, 'run_unlock_now', 'test', {}, 1000), /unreadable reply/);

    const closed = unlockTracker();
    closed.tracker.sendCommand = () => { throw Error('socket closed'); };
    await assert.rejects(sendUnlockCommand(closed.tracker, 'run_unlock_now', 'test', {}, 1000), /Could not reach the server/);
    assert.equal(closed.tracker.listenerCount('run_unlock_now'), 0);
});

// C-ios-unlock-11 and C-client-ui-9: `BaseDeviceTracker.sendCommand` sends nothing on a closed
// socket and does not throw, and the server answers only on the socket a command came in on.
function socketTracker() {
    const { tracker, sent } = unlockTracker();
    const closers = new Set();
    tracker.open = true;
    tracker.isOpen = () => tracker.open;
    tracker.onceClosed = (listener) => {
        closers.add(listener);
        return () => closers.delete(listener);
    };
    tracker.close = () => {
        tracker.open = false;
        const listeners = [...closers];
        closers.clear();
        listeners.forEach((listener) => listener());
    };
    return { tracker, sent, closers };
}

test('a tracker command on a closed socket is refused at once, and one in flight ends when the socket closes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const closed = socketTracker();
    closed.tracker.open = false;
    await assert.rejects(sendUnlockCommand(closed.tracker, 'run_unlock_now', 'test', {}, 180000), /Could not reach the server/);
    assert.deepEqual(closed.sent, [], 'nothing is sent, so nothing is waited for');
    assert.equal(closed.tracker.listenerCount('run_unlock_now'), 0);
    assert.equal(closed.closers.size, 0);

    const dropped = socketTracker();
    let outcome;
    const pending = sendUnlockCommand(dropped.tracker, 'run_unlock_now', 'test', {}, 180000).catch((error) => (outcome = error.message));
    assert.equal(dropped.sent.length, 1);
    assert.equal(dropped.closers.size, 1);
    dropped.tracker.close();
    await pending;
    assert.match(outcome, /connection to the server dropped before it answered/);
    assert.equal(dropped.tracker.listenerCount('run_unlock_now'), 0, 'the listener goes with the socket');
    // The reply to the lost command, delivered after a reconnect, has no one waiting for it.
    dropped.tracker.emit('run_unlock_now', { udid: 'test', requestId: 1, result: '{"outcome":"unlocked"}' });

    const answered = socketTracker();
    const done = sendTrackerCommand(answered.tracker, 'restart_session', 'test', {}, 1000);
    answered.tracker.emit('restart_session', { udid: 'test', requestId: 1, result: 'Services restarted. Open the screen again.' });
    assert.equal(await done, 'Services restarted. Open the screen again.', 'a service reply is plain text, not JSON');
    assert.equal(answered.closers.size, 0, 'a settled command stops watching the socket');
});

test('service commands match by request id, have their own time limits and can be withdrawn', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Two cards, or a card and the Actions sheet, asking the same phone for the same thing.
    const { tracker, sent } = socketTracker();
    const first = sendServiceCommand(tracker, 'refresh_device', 'test');
    const second = sendServiceCommand(tracker, 'refresh_device', 'test');
    assert.deepEqual(sent.map((message) => message.data), [{ udid: 'test' }, { udid: 'test' }]);
    tracker.emit('refresh_device', { udid: 'test', requestId: 2, error: 'Device with udid:"test" not found' });
    await assert.rejects(second, /not found/);
    tracker.emit('refresh_device', { udid: 'test', requestId: 1, result: null });
    assert.equal(replyText(await first, 'Device info refreshed.'), 'Device info refreshed.');
    assert.equal(replyText('Developer image mounted.', 'unused'), 'Developer image mounted.');

    // A server that restarts mid-command never answers: the button must not stay disabled.
    assert.ok(serviceCommandTimeoutMs('remount_ddi') > 250000, 'a remount may wait for the old session and then mount');
    assert.ok(serviceCommandTimeoutMs('restart_session') < serviceCommandTimeoutMs('remount_ddi'));
    let settled;
    const remount = sendServiceCommand(tracker, 'remount_ddi', 'test').catch((error) => (settled = error.message));
    t.mock.timers.tick(serviceCommandTimeoutMs('remount_ddi') - 1);
    await Promise.resolve();
    assert.equal(settled, undefined);
    t.mock.timers.tick(1);
    await remount;
    assert.match(settled, /No answer from the server/);
    assert.equal(tracker.listenerCount('remount_ddi'), 0);

    // The view that asked has gone.
    const leaving = new AbortController();
    const withdrawn = sendServiceCommand(tracker, 'reboot_device', 'test', leaving.signal);
    leaving.abort();
    await assert.rejects(withdrawn, (error) => error instanceof TrackerCommandAborted);
    assert.equal(tracker.listenerCount('reboot_device'), 0);
    await assert.rejects(sendServiceCommand(tracker, 'reboot_device', 'test', leaving.signal), TrackerCommandAborted);
    assert.equal(sent.filter((message) => message.type === 'reboot_device').length, 1, 'nothing is sent for a view that already left');
});

test('Run now sends keepUnlocked only for the stream page, and a refusal rejects with the server message', async () => {
    const plain = unlockTracker([{ result: '{"outcome":"unlocked"}' }]);
    assert.deepEqual(await runUnlockNow(plain.tracker, 'test'), { outcome: 'unlocked' });
    assert.deepEqual(plain.sent, [{ type: 'run_unlock_now', data: { udid: 'test' } }]);
    const kept = unlockTracker([{ result: '{"outcome":"unlocked"}' }]);
    await runUnlockNow(kept.tracker, 'test', { keepUnlocked: true });
    assert.deepEqual(kept.sent, [{ type: 'run_unlock_now', data: { udid: 'test', keepUnlocked: true } }]);
    const refused = unlockTracker([{ error: 'A screen session was opened for this phone a moment ago. Try again in 90 s.' }]);
    await assert.rejects(runUnlockNow(refused.tracker, 'test'), /Try again in 90 s\.$/);
});

test('the card line shows a schedule that cannot run or failed as a problem, and nothing while it is off', () => {
    const now = 1800000000000;
    // 15:00 in Berlin that day: the second of the two daily times is the next run.
    const nextRunAt = Date.UTC(2027, 0, 15, 14, 0);
    const on = { enabled: true, time: '03:00', hasPasscode: true, timeZone: 'Europe/Berlin', lastUnlockedAt: now - 2 * 3600000, nextRunAt };
    assert.equal(unlockCardLine({ ...on, enabled: false }, now), undefined);
    assert.deepEqual(unlockCardLine(on, now), {
        text: 'Scheduled unlock · next 15:00 · last 2 h ago',
        title: 'Scheduled unlock at 03:00 and 15:00, Europe/Berlin',
        problem: false,
    });
    const server = unlockCardLine({ ...on, timeZone: undefined, serverTimeZone: 'UTC' }, now);
    assert.equal(server.title, 'Scheduled unlock at 03:00 and 15:00, server time (UTC)');
    assert.equal(server.text, 'Scheduled unlock · next 14:00 · last 2 h ago', 'the next run is shown in the zone the title names');
    assert.equal(unlockCardLine({ ...on, time: '14:30' }, now).title, 'Scheduled unlock at 14:30 and 02:30, Europe/Berlin');
    // A status without a next run names the two times instead.
    assert.equal(unlockCardLine({ ...on, nextRunAt: undefined }, now).text, 'Scheduled unlock 03:00 and 15:00 · last 2 h ago');
    const refused = { at: now, trigger: 'schedule', outcome: 'needs-manual-unlock', message: 'Enter the passcode on the phone.' };
    assert.deepEqual(
        [
            { ...on, lastRun: { at: now, trigger: 'schedule', outcome: 'failed-wake' } },
            { ...on, lastRun: { at: now, trigger: 'schedule', outcome: 'left-unlocked' } },
            { ...on, lastRun: { at: now, trigger: 'schedule', outcome: 'skipped-recent' } },
            { ...on, passcodeRejected: true, nextRunAt: undefined },
            { ...on, hasPasscode: false, nextRunAt: undefined },
            // The phone refuses connections: the one sentence, before anything else that is wrong.
            { ...on, needsManualUnlock: true, lastRun: refused },
            { ...on, needsManualUnlock: true, passcodeRejected: true, lastRun: refused },
            // Reachable again: the last run is history, not a problem.
            { ...on, lastRun: refused },
            { ...on, waitingForLock: true },
            // A retry is the next run: 03:10 in Berlin.
            { ...on, nextRunAt: Date.UTC(2027, 0, 16, 2, 10), lastRun: { at: now, trigger: 'schedule', outcome: 'failed-session' } },
            { ...on, nextRunAt: undefined, lastRun: { at: now, trigger: 'schedule', outcome: 'failed-wake' } },
        ].map((status) => { const line = unlockCardLine(status, now); return [line.text, line.problem]; }),
        [
            ['Scheduled unlock · Failed: the screen did not wake · next 15:00', true],
            ['Scheduled unlock · Unlocked, but the phone did not lock again · next 15:00', true],
            ['Scheduled unlock · next 15:00 · last 2 h ago', false],
            ['Scheduled unlock paused: passcode rejected', true],
            ['Scheduled unlock cannot run: no passcode', true],
            ['The iPhone stopped accepting connections. Enter the passcode on the phone.', true],
            ['The iPhone stopped accepting connections. Enter the passcode on the phone.', true],
            ['Scheduled unlock · next 15:00 · last 2 h ago', false],
            ['Scheduled unlock · runs when the phone is locked', false],
            ['Scheduled unlock · Failed: the screen session failed · next 03:10', true],
            ['Scheduled unlock 03:00 and 15:00 · Failed: the screen did not wake', true],
        ],
    );
    // Times are shown in the schedule's zone, not the browser's.
    const at = Date.UTC(2026, 10, 11, 8, 0);
    assert.match(formatUnlockMoment(at, 'America/New_York'), /03:00/);
    assert.match(formatUnlockMoment(at, 'Asia/Kolkata'), /13:30|01:30/);
    assert.equal(typeof formatUnlockMoment(at, 'Not/A_Zone'), 'string', 'an unknown zone falls back instead of throwing');
});

test('scheduled-unlock commands time out, clean up, and ignore a late reply', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { tracker } = unlockTracker();
    let settled = false;
    const pending = sendUnlockCommand(tracker, 'run_unlock_now', 'test', {}, 180000).finally(() => { settled = true; });
    t.mock.timers.tick(179999);
    await Promise.resolve();
    assert.equal(settled, false, 'still waiting one millisecond before the deadline');
    t.mock.timers.tick(1);
    await assert.rejects(pending, /No answer from the server/);
    assert.equal(tracker.listenerCount('run_unlock_now'), 0, 'the listener is removed on timeout');
    tracker.emit('run_unlock_now', { udid: 'test', requestId: 1, result: '{"outcome":"unlocked"}' });
});
