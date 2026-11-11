// Run with: node --test scripts/test-stream-config.js
// The stream settings of an Android phone without a browser (src/app/state/streamConfig.ts):
// loading them, the patch of changed values, applying it, and the two time limits. The tracker
// is a fake; nothing is sent anywhere.
const assert = require('node:assert/strict');
const { test } = require('node:test');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

const {
    StreamConfigSession,
    patchWith,
    normalized,
    APPLY_TIMEOUT_MS,
    LOAD_TIMEOUT_MS,
    APPLY_TIMED_OUT,
    LOAD_TIMED_OUT,
    WAITING_FOR_PHONE,
    SETTINGS_SAVED,
} = require('../src/app/state/streamConfig');
const { DEFAULT_SCRCPY_SERVER_CONFIG } = require('../src/common/Constants');

const UDID = 'PIXEL-0001';
const PHONE = { bitrate: 3500000, maxFps: 60, maxSize: 1280, iFrameInterval: 10, videoCodec: 'h264', videoEncoder: '', audio: true, audioCodec: 'raw', audioSource: 'output' };
const ENCODERS = [{ videoCodec: 'h264', encoderName: 'c2.exynos.h264.encoder', hardware: 'hw' }];

function fakeTracker() {
    const listeners = new Map();
    const sent = [];
    return {
        sent,
        listeners,
        on: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
        off: (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener)),
        sendCommand(type, data) {
            sent.push({ id: sent.length + 1, type, data });
            return sent.length;
        },
        reply: (type, data) => [...(listeners.get(type) ?? [])].forEach((listener) => listener(data)),
    };
}

/** A session that has loaded `PHONE`, with every state it went through. */
function loaded(tracker = fakeTracker()) {
    const states = [];
    const session = new StreamConfigSession(tracker, UDID, (state) => states.push(state));
    session.load();
    tracker.reply('list_encoders', { udid: UDID, requestId: tracker.sent.at(-1).id, encoders: ENCODERS, config: PHONE });
    return { tracker, session, states };
}

test('loading asks the phone once and takes only the reply to that request', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = fakeTracker();
    const session = new StreamConfigSession(tracker, UDID);
    assert.equal(session.state.loading, true);
    assert.equal(session.state.configKnown, false);
    assert.deepEqual(session.state.baseline, DEFAULT_SCRCPY_SERVER_CONFIG);
    session.load();
    assert.deepEqual(tracker.sent, [{ id: 1, type: 'list_encoders', data: { udid: UDID } }]);

    tracker.reply('list_encoders', { udid: 'another-phone', requestId: 1, encoders: ENCODERS, config: PHONE });
    tracker.reply('list_encoders', { udid: UDID, requestId: 7, encoders: ENCODERS, config: PHONE });
    assert.equal(session.state.loading, true, 'a reply for another phone or another request is not this one');

    tracker.reply('list_encoders', { udid: UDID, requestId: 1, encoders: ENCODERS, config: PHONE });
    assert.equal(session.state.loading, false);
    assert.equal(session.state.configKnown, true);
    assert.deepEqual(session.state.baseline, PHONE);
    assert.deepEqual(session.state.encoders, ENCODERS);
    assert.equal(session.state.loadError, undefined);

    // The reply cleared the time limit.
    t.mock.timers.tick(LOAD_TIMEOUT_MS);
    assert.equal(session.state.loadError, undefined);
    session.dispose();
});

test('a load that fails says why, and a phone without a tracker is waited for', () => {
    const tracker = fakeTracker();
    const failed = new StreamConfigSession(tracker, UDID);
    failed.load();
    tracker.reply('list_encoders', { udid: UDID, requestId: 1, error: 'adb is not running' });
    assert.equal(failed.state.loading, false);
    assert.equal(failed.state.loadError, 'Could not load stream settings: adb is not running');
    assert.equal(failed.state.configKnown, false);
    failed.dispose();

    // The phone answered without its settings: the encoders are listed and nothing is known.
    const partial = new StreamConfigSession(tracker, UDID);
    partial.load();
    tracker.reply('list_encoders', { udid: UDID, requestId: 2, encoders: 'none' });
    assert.equal(partial.state.loading, false);
    assert.equal(partial.state.configKnown, false);
    assert.deepEqual(partial.state.encoders, []);
    partial.dispose();

    const waiting = new StreamConfigSession(undefined, UDID);
    waiting.load();
    assert.equal(waiting.state.loading, false);
    assert.equal(waiting.state.loadError, WAITING_FOR_PHONE);
    assert.equal(waiting.apply({ bitrate: 1000000 }), false, 'nothing is sent without a tracker');
});

test('a load that gets no answer ends after its time limit, and a late answer is dropped', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = fakeTracker();
    const session = new StreamConfigSession(tracker, UDID);
    session.load();
    t.mock.timers.tick(LOAD_TIMEOUT_MS - 1);
    assert.equal(session.state.loading, true);
    t.mock.timers.tick(1);
    assert.equal(session.state.loading, false);
    assert.equal(session.state.loadError, LOAD_TIMED_OUT);
    tracker.reply('list_encoders', { udid: UDID, requestId: 1, encoders: ENCODERS, config: PHONE });
    assert.equal(session.state.loadError, LOAD_TIMED_OUT, 'the answer came after the sheet gave up');
    assert.equal(session.state.configKnown, false);
    session.dispose();
});

test('the patch holds only values that differ from what the phone runs with', () => {
    assert.deepEqual(patchWith({}, { bitrate: 8000000 }, PHONE, true), { bitrate: 8000000 });
    assert.deepEqual(patchWith({ bitrate: 8000000 }, { maxFps: 30 }, PHONE, true), { bitrate: 8000000, maxFps: 30 });
    assert.deepEqual(patchWith({ bitrate: 8000000, maxFps: 30 }, { bitrate: 3500000 }, PHONE, true), { maxFps: 30 }, 'a value set back leaves the patch');
    assert.deepEqual(patchWith({}, { ...PHONE }, PHONE, true), {}, 'choosing what is already set is no change');
    // A phone that reports no codec runs H.264, and no encoder is the automatic one.
    const bare = { ...PHONE, videoCodec: undefined, videoEncoder: undefined };
    assert.equal(normalized(bare, 'videoCodec'), 'h264');
    assert.equal(normalized(bare, 'videoEncoder'), '');
    assert.equal(normalized({}, 'bitrate'), DEFAULT_SCRCPY_SERVER_CONFIG.bitrate);
    assert.deepEqual(patchWith({}, { videoCodec: 'h264', videoEncoder: '' }, bare, true), {});
    // Until the phone has reported its settings there is nothing to compare with.
    assert.deepEqual(patchWith({}, { bitrate: DEFAULT_SCRCPY_SERVER_CONFIG.bitrate }, DEFAULT_SCRCPY_SERVER_CONFIG, false), { bitrate: DEFAULT_SCRCPY_SERVER_CONFIG.bitrate });

    const { session } = loaded();
    session.setFields({ bitrate: 1000000, maxFps: 30 });
    assert.deepEqual(session.state.patch, { bitrate: 1000000, maxFps: 30 });
    session.setFields({ bitrate: PHONE.bitrate });
    assert.deepEqual(session.state.patch, { maxFps: 30 });
    session.discard();
    assert.deepEqual(session.state.patch, {});
    session.dispose();
});

test('apply sends the patch once, and the reply to that request moves it into the baseline', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { tracker, session } = loaded();
    assert.equal(session.apply(), false, 'an empty patch is not sent');
    session.setFields({ bitrate: 1000000, maxFps: 30 });
    assert.equal(session.apply(), true);
    assert.deepEqual(tracker.sent.at(-1), { id: 2, type: 'update_stream_config', data: { udid: UDID, config: { bitrate: 1000000, maxFps: 30 } } });
    assert.equal(session.state.applying, true);
    assert.equal(session.apply(), false, 'a second apply waits for the first');
    assert.equal(tracker.sent.length, 2);

    tracker.reply('update_stream_config', { udid: UDID, requestId: 9, config: PHONE });
    tracker.reply('update_stream_config', { udid: 'another-phone', requestId: 2, config: PHONE });
    assert.equal(session.state.applying, true, 'a reply to another request does not end this one');

    // The phone answers without its settings: what was sent is taken as applied.
    tracker.reply('update_stream_config', { udid: UDID, requestId: 2 });
    assert.equal(session.state.applying, false);
    assert.deepEqual(session.state.baseline, { ...PHONE, bitrate: 1000000, maxFps: 30 });
    assert.deepEqual(session.state.patch, {});
    assert.equal(session.state.appliedNote, SETTINGS_SAVED);
    t.mock.timers.tick(APPLY_TIMEOUT_MS);
    assert.equal(session.state.applyError, undefined, 'the reply cleared the time limit');

    // A change after the save withdraws "saved".
    session.setFields({ audio: false });
    assert.equal(session.state.appliedNote, undefined);
    // Sound can be retried with a patch of its own, whatever the form holds.
    session.discard();
    assert.equal(session.apply({ audio: true }), true);
    assert.deepEqual(tracker.sent.at(-1).data.config, { audio: true });
    tracker.reply('update_stream_config', { udid: UDID, requestId: 3, error: 'encoder failed' });
    assert.equal(session.state.applying, false);
    assert.equal(session.state.applyError, 'Could not apply changes: encoder failed');
    assert.equal(session.state.appliedNote, undefined);
    session.dispose();
});

test('an apply that gets no answer ends after its time limit and keeps the changes', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { tracker, session } = loaded();
    session.setFields({ maxSize: 720 });
    session.apply();
    t.mock.timers.tick(APPLY_TIMEOUT_MS - 1);
    assert.equal(session.state.applying, true);
    t.mock.timers.tick(1);
    assert.equal(session.state.applying, false);
    assert.equal(session.state.applyError, APPLY_TIMED_OUT);
    assert.deepEqual(session.state.patch, { maxSize: 720 }, 'the changes are still there to try again');
    tracker.reply('update_stream_config', { udid: UDID, requestId: 2, config: { ...PHONE, maxSize: 720 } });
    assert.deepEqual(session.state.baseline, PHONE, 'a reply after the limit does not claim the change was applied');
    assert.equal(session.state.applyError, APPLY_TIMED_OUT);
    assert.equal(session.apply(), true, 'the apply can be sent again');
    assert.equal(tracker.sent.at(-1).id, 3);
    session.dispose();
});

test('a closed sheet leaves no listener or timer, and later replies change nothing', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { tracker, session, states } = loaded();
    session.setFields({ maxSize: 720 });
    session.apply();
    const before = states.length;
    const state = session.state;
    session.dispose();
    assert.deepEqual([...tracker.listeners.values()].flat(), []);
    t.mock.timers.tick(APPLY_TIMEOUT_MS + LOAD_TIMEOUT_MS);
    tracker.reply('update_stream_config', { udid: UDID, requestId: 2, config: PHONE });
    session.setFields({ bitrate: 1 });
    assert.equal(session.apply({ bitrate: 1 }), false);
    assert.equal(states.length, before);
    assert.equal(session.state, state);
});
