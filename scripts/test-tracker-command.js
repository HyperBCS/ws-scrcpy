const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
require('ts-node').register({ transpileOnly: true });
const {
    observeTrackerCommandErrors,
    TrackerCommandAborted,
    TRACKER_CONNECTION_LOST,
    TRACKER_UNREACHABLE,
} = require('../src/app/client/trackerCommand');

function fixture() {
    const tracker = new EventEmitter();
    const sent = [];
    const closers = new Set();
    let nextId = 0;
    tracker.open = true;
    tracker.isOpen = () => tracker.open;
    tracker.sendCommand = (type, data) => {
        sent.push({ type, data, id: ++nextId });
        return nextId;
    };
    tracker.onceClosed = (listener) => {
        closers.add(listener);
        return () => closers.delete(listener);
    };
    tracker.close = () => {
        tracker.open = false;
        [...closers].forEach((listener) => listener());
    };
    return { tracker, sent, closers };
}

function clean(f, type = 'start_server') {
    assert.equal(f.tracker.listenerCount(type), 0, 'command listener removed');
    assert.equal(f.closers.size, 0, 'socket-close listener removed');
}

test('error observation sends once and matches command type, phone and request id', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const action = observeTrackerCommandErrors(f.tracker, 'start_server', 'about-phone', {}, 30000);
    let outcome;
    const done = action.settled.catch((error) => { outcome = error.message; });
    assert.deepEqual(f.sent, [{ type: 'start_server', data: { udid: 'about-phone' }, id: 1 }]);
    f.tracker.emit('kill_server', { udid: 'about-phone', requestId: 1, error: 'wrong type' });
    f.tracker.emit('start_server', { udid: 'other-phone', requestId: 1, error: 'other phone' });
    f.tracker.emit('start_server', { udid: 'about-phone', requestId: 2, error: 'other action' });
    f.tracker.emit('start_server', { udid: 'about-phone', error: 'no id' });
    await Promise.resolve();
    assert.equal(outcome, undefined);
    assert.equal(f.tracker.listenerCount('start_server'), 1);
    f.tracker.emit('start_server', { udid: 'about-phone', requestId: 1, error: 'Synthetic Start refused.' });
    await Promise.resolve();
    t.mock.timers.tick(30000);
    await done;
    assert.equal(outcome, 'Synthetic Start refused.');
    clean(f);
    t.mock.timers.tick(60000);
    assert.equal(f.sent.length, 1, 'no retry');
});

test('error-only expiry is silent, independent of the eight-second Starting fallback', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const action = observeTrackerCommandErrors(f.tracker, 'start_server', 'about-phone', {}, 30000);
    let settled = false;
    const done = action.settled.then(() => { settled = true; });
    t.mock.timers.tick(8000);
    await Promise.resolve();
    assert.equal(settled, false, 'the shared Starting limit is not the listener expiry');
    t.mock.timers.tick(21999);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await done;
    clean(f);
    assert.equal(f.sent.length, 1);
    f.tracker.emit('start_server', { udid: 'about-phone', requestId: 1, error: 'late refusal' });
    assert.equal(settled, true);
});

test('descriptor success and an optional Stop acknowledgment end observation without success words', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const ending of ['explicit-stop', 'late-error', 'late-drop', 'ack']) {
        const f = fixture();
        let confirmed = false;
        const action = observeTrackerCommandErrors(f.tracker, 'kill_server', 'about-phone', { pid: 17 },
            30000, undefined, () => confirmed);
        let result = 'not settled';
        const done = action.settled.then((value) => { result = value; });
        if (ending === 'ack') {
            f.tracker.emit('kill_server', { udid: 'about-phone', requestId: 1, result: null });
        } else {
            confirmed = true;
            if (ending === 'explicit-stop') action.stop();
            if (ending === 'late-error') f.tracker.emit('kill_server', { udid: 'about-phone', requestId: 1, error: 'late' });
            if (ending === 'late-drop') f.tracker.close();
        }
        await Promise.resolve();
        t.mock.timers.tick(30000);
        await done;
        assert.equal(result, undefined, ending + ': no claim that physical shutdown finished');
        clean(f, 'kill_server');
        t.mock.timers.tick(60000);
        assert.deepEqual(f.sent, [{ type: 'kill_server', data: { udid: 'about-phone', pid: 17 }, id: 1 }]);
    }
});

test('a stopped descriptor must be confirmed before a real Stop refusal is suppressed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const action = observeTrackerCommandErrors(f.tracker, 'kill_server', 'about-phone', { pid: 17 },
        30000, undefined, () => false);
    f.tracker.emit('kill_server', { udid: 'about-phone', requestId: 1, error: 'Synthetic Stop refused.' });
    const done = assert.rejects(action.settled, /Synthetic Stop refused\./);
    t.mock.timers.tick(30000);
    await done;
    clean(f, 'kill_server');
});

test('closed, dropped and throwing trackers end error observation and release every listener', async () => {
    const closed = fixture();
    closed.tracker.open = false;
    await assert.rejects(observeTrackerCommandErrors(closed.tracker, 'start_server', 'about-phone', {}, 30000).settled,
        { message: TRACKER_UNREACHABLE });
    assert.deepEqual(closed.sent, []);
    clean(closed);

    const dropped = fixture();
    const action = observeTrackerCommandErrors(dropped.tracker, 'start_server', 'about-phone', {}, 30000);
    dropped.tracker.close();
    await assert.rejects(action.settled, { message: TRACKER_CONNECTION_LOST });
    clean(dropped);

    const throwing = fixture();
    throwing.tracker.sendCommand = () => { throw Error('synthetic send failure'); };
    await assert.rejects(observeTrackerCommandErrors(throwing.tracker, 'start_server', 'about-phone', {}, 30000).settled,
        { message: TRACKER_UNREACHABLE });
    clean(throwing);
});

test('opening/action cancellation removes old listeners and cannot consume the next action reply', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const firstScope = new AbortController();
    const first = observeTrackerCommandErrors(f.tracker, 'start_server', 'about-phone', {}, 30000, firstScope.signal);
    firstScope.abort();
    await assert.rejects(first.settled, (error) => error instanceof TrackerCommandAborted);
    clean(f);
    const second = observeTrackerCommandErrors(f.tracker, 'start_server', 'about-phone', {}, 30000);
    let outcome;
    const done = second.settled.catch((error) => { outcome = error.message; });
    f.tracker.emit('start_server', { udid: 'about-phone', requestId: 1, error: 'old refusal' });
    await Promise.resolve();
    assert.equal(outcome, undefined);
    f.tracker.emit('start_server', { udid: 'about-phone', requestId: 2, error: 'current refusal' });
    await Promise.resolve();
    t.mock.timers.tick(30000);
    await done;
    assert.equal(outcome, 'current refusal');
    clean(f);
    const alreadyGone = new AbortController();
    alreadyGone.abort();
    await assert.rejects(observeTrackerCommandErrors(f.tracker, 'start_server', 'about-phone', {}, 30000,
        alreadyGone.signal).settled, (error) => error instanceof TrackerCommandAborted);
    assert.equal(f.sent.length, 2);
    clean(f);
});
