// No hardware: prove that idle late joins receive decodable video up to the latest picture.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { Socket } = require('node:net');
require('ts-node').register({ transpileOnly: true });
const { Broadcast } = require('../src/common/Broadcast');
const { broadcastManager } = require('../src/common/BroadcastManager');
const { WebsocketProxy } = require('../src/server/mw/WebsocketProxy');

const config = Buffer.from([0, 0, 0, 1, 0x67, 1]);
const key = Buffer.from([0, 0, 0, 1, 0x65, 2]);
const delta = (index) => Buffer.from([0, 0, 0, 1, 0x41, index]);

function wire(payload, kind = 'delta') {
    const header = Buffer.alloc(12);
    header.writeBigUInt64BE(kind === 'config' ? 1n << 62n : kind === 'key' ? 1n << 61n : 1000n);
    header.writeUInt32BE(payload.length, 8);
    return Buffer.concat([header, payload]);
}

// scrcpy 4.x: 12 bytes with the top bit set, then the size. Sent once per capture session.
function session(width, height) {
    const packet = Buffer.alloc(12);
    packet.writeUInt32BE(0x80000000, 0);
    packet.writeUInt32BE(width, 4);
    packet.writeUInt32BE(height, 8);
    return packet;
}

const CODEC_ID = Buffer.from([0x68, 0x32, 0x36, 0x34]);

function fixture(t, onTeardown) {
    const video = new Socket();
    const control = new Socket();
    const broadcast = new Broadcast(video, control, undefined, onTeardown);
    video.emit('data', Buffer.concat([CODEC_ID, session(720, 1280)]));
    t.after(() => broadcast.stop());
    t.mock.method(broadcastManager, 'getBroadcast', () => broadcast);
    return {
        broadcast,
        video,
        send: (payload, kind) => video.emit('data', wire(payload, kind)),
        rotate: (width, height) => video.emit('data', session(width, height)),
    };
}

// The size the synthetic scrcpy_initial packet announces (ScreenInfo's videoSize).
// Layout: magic(14) name(64) displayCount(4) displayInfo(24) connectionCount(4)
// screenInfoLength(4), then ScreenInfo: contentRect(16) videoSize(8).
const CONNECTION_COUNT_OFFSET = 14 + 64 + 4 + 24;
const SCREEN_INFO_OFFSET = CONNECTION_COUNT_OFFSET + 4 + 4;
function announcedSize(initial) {
    return [initial.readInt32BE(SCREEN_INFO_OFFSET + 16), initial.readInt32BE(SCREEN_INFO_OFFSET + 20)];
}

async function viewer(t) {
    class BrowserSocket extends EventEmitter {
        OPEN = 1; CLOSING = 2; CLOSED = 3; readyState = 1;
        sent = [];
        closes = 0;
        addEventListener(type, listener) { this.on(type, listener); }
        send(data) { this.sent.push(Buffer.from(data)); }
        close() { this.closes++; this.readyState = this.CLOSED; this.emit('close'); }
    }
    const socket = new BrowserSocket();
    const proxy = new WebsocketProxy(socket);
    t.after(() => proxy.release());
    await proxy.init('idle-video-fixture');
    assert.equal(socket.sent[0].subarray(0, 14).toString(), 'scrcpy_initial');
    assert.equal(socket.sent[1].subarray(0, 14).toString(), 'scrcpy_audio_2');
    return socket;
}

test('idle late join replays config, keyframe, and every dependent picture before live video', async (t) => {
    const { broadcast, send } = fixture(t);
    send(config, 'config');
    send(key, 'key');
    send(delta(3));
    send(delta(4));
    const socket = await viewer(t);
    assert.deepEqual(socket.sent.slice(2), [config, key, delta(3), delta(4)]);
    assert.equal(broadcast.hasCompleteVideoBootstrap(), true);
    send(delta(5));
    assert.deepEqual(socket.sent.at(-1), delta(5), 'live frame follows all its cached references');
    const nextKey = Buffer.from([0, 0, 0, 1, 0x65, 6]);
    send(nextKey, 'key');
    send(delta(7));
    assert.deepEqual(broadcast.getVideoBootstrapPackets(), [config, nextKey, delta(7)], 'a new keyframe releases the old GOP');
});

test('new codec config invalidates stale pictures and a joining viewer waits for the next keyframe', async (t) => {
    const { broadcast, send } = fixture(t);
    send(config, 'config');
    send(key, 'key');
    send(delta(3));
    const nextConfig = Buffer.from([0, 0, 0, 1, 0x67, 4]);
    send(nextConfig, 'config');
    send(delta(5));
    assert.deepEqual(broadcast.getVideoBootstrapPackets(), [nextConfig]);
    const socket = await viewer(t);
    assert.deepEqual(socket.sent.slice(2), [nextConfig]);
    send(delta(6));
    assert.equal(socket.sent.length, 3, 'undecodable live deltas are suppressed');
    send(key, 'key');
    send(delta(7));
    assert.deepEqual(socket.sent.slice(2), [nextConfig, key, delta(7)]);
    broadcast.stop();
    assert.deepEqual(broadcast.getVideoBootstrapPackets(), [], 'stopped broadcasts release all cached video');
});

test('packet-count overflow keeps an idle preview but waits for a keyframe before joining live deltas', async (t) => {
    const { broadcast, send } = fixture(t);
    send(config, 'config');
    send(key, 'key');
    const existing = await viewer(t);
    for (let index = 0; index < 1030; index++) send(delta(index));
    const cached = broadcast.getVideoBootstrapPackets();
    assert.equal(cached.length, 1025, 'config plus a bounded 1024-frame decodable prefix');
    assert.deepEqual(cached[1], key);
    assert.equal(broadcast.hasCompleteVideoBootstrap(), false);
    assert.equal(existing.sent.length, 1034, 'existing decoders retain uninterrupted live video');
    const joined = await viewer(t);
    assert.deepEqual(joined.sent.slice(2), cached, 'an idle viewer still has a decodable preview');
    const before = joined.sent.length;
    send(delta(8));
    assert.equal(joined.sent.length, before, 'missing references must not be spliced into the live stream');
    send(key, 'key');
    send(delta(9));
    assert.deepEqual(joined.sent.slice(before), [key, delta(9)]);
    assert.equal(broadcast.hasCompleteVideoBootstrap(), true);
});

test('byte-size overflow bounds retained video even for maximum-size packets', (t) => {
    const { broadcast, send } = fixture(t);
    send(config, 'config');
    const large = Buffer.alloc(4 * 1024 * 1024);
    send(large, 'key');
    for (let index = 0; index < 10; index++) send(large);
    const cached = broadcast.getVideoBootstrapPackets();
    assert.equal(cached.length, 5, 'config plus at most sixteen MiB of pictures');
    assert.equal(cached.slice(1).reduce((bytes, packet) => bytes + packet.length, 0), 16 * 1024 * 1024);
    assert.equal(broadcast.hasCompleteVideoBootstrap(), false);
});

test('a session packet mid-stream changes the size without losing framing or closing viewers', async (t) => {
    let teardowns = 0;
    const { broadcast, send, rotate } = fixture(t, () => teardowns++);
    send(config, 'config');
    send(key, 'key');
    send(delta(3));
    const socket = await viewer(t);
    assert.deepEqual(announcedSize(socket.sent[0]), [720, 1280]);
    const before = socket.sent.length;

    // The device rotates: scrcpy starts a new capture session at the new size.
    rotate(1280, 720);
    assert.equal(teardowns, 0, 'a session packet is not a frame header');
    assert.equal(socket.closes, 0);
    assert.deepEqual([broadcast.getVideoWidth(), broadcast.getVideoHeight()], [1280, 720]);
    assert.deepEqual(broadcast.getVideoBootstrapPackets(), [], 'pictures of the old size are not replayed');
    assert.equal(socket.sent.length, before + 1);
    const initial = socket.sent.at(-1);
    assert.equal(initial.subarray(0, 14).toString(), 'scrcpy_initial');
    assert.deepEqual(announcedSize(initial), [1280, 720], 'the viewer is told the new size');
    assert.equal(initial.readInt32BE(CONNECTION_COUNT_OFFSET), 0, 'a viewer does not count itself as another client');

    send(delta(4));
    assert.equal(socket.sent.length, before + 1, 'a delta without its keyframe is not sent after the size change');
    const nextConfig = Buffer.from([0, 0, 0, 1, 0x67, 9]);
    const nextKey = Buffer.from([0, 0, 0, 1, 0x65, 9]);
    send(nextConfig, 'config');
    send(nextKey, 'key');
    send(delta(5));
    assert.deepEqual(socket.sent.slice(before + 1), [nextConfig, nextKey, delta(5)]);
    assert.deepEqual(broadcast.getVideoBootstrapPackets(), [nextConfig, nextKey, delta(5)]);

    const late = await viewer(t);
    assert.deepEqual(announcedSize(late.sent[0]), [1280, 720], 'a later viewer joins at the new size');
    assert.equal(late.sent[0].readInt32BE(CONNECTION_COUNT_OFFSET), 1);
    assert.equal(teardowns, 0);
});

test('a session packet split across socket chunks is read as one packet', (t) => {
    let teardowns = 0;
    const { broadcast, video, send } = fixture(t, () => teardowns++);
    const packet = session(1920, 1080);
    video.emit('data', packet.subarray(0, 5));
    assert.equal(broadcast.getVideoWidth(), 720);
    video.emit('data', Buffer.concat([packet.subarray(5), wire(config, 'config')]));
    assert.deepEqual([broadcast.getVideoWidth(), broadcast.getVideoHeight()], [1920, 1080]);
    assert.deepEqual(broadcast.getVideoBootstrapPackets(), [config]);
    send(key, 'key');
    assert.equal(broadcast.hasCompleteVideoBootstrap(), true);
    assert.equal(teardowns, 0);
});

test('viewers wait for the first session packet, and video without one ends the broadcast', async (t) => {
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const waitingVideo = new Socket();
    const waiting = new Broadcast(waitingVideo, new Socket());
    t.after(() => waiting.stop());
    let ready;
    waiting.whenReady().then((ok) => (ready = ok));
    waitingVideo.emit('data', CODEC_ID);
    await tick();
    assert.equal(ready, undefined, 'the codec id alone carries no size');
    waitingVideo.emit('data', session(720, 1280));
    await tick();
    assert.equal(ready, true);

    let teardowns = 0;
    const legacyVideo = new Socket();
    const legacy = new Broadcast(legacyVideo, new Socket(), undefined, () => teardowns++);
    legacyVideo.emit('data', Buffer.concat([CODEC_ID, wire(config, 'config')]));
    assert.equal(teardowns, 1, 'a stream without session packets is refused, not guessed at');
    assert.equal(await legacy.whenReady(), false);
});

test('a viewer that goes away with a key down has it released on the device', async (t) => {
    const { broadcast } = fixture(t);
    const control = broadcast.getControlSocket();
    // No device is needed to see what reaches the control socket.
    Object.defineProperty(control, 'readyState', { value: 'open' });
    const writes = [];
    t.mock.method(control, 'write', (data) => {
        writes.push(Buffer.from(data));
        return true;
    });
    // scrcpy INJECT_KEYCODE: type 0, action, keycode, repeat, meta state.
    const keycode = (action, code) => {
        const message = Buffer.alloc(14);
        message[1] = action;
        message.writeInt32BE(code, 2);
        return message;
    };
    const [DOWN, UP, POWER, VOLUME_UP, HOME] = [0, 1, 26, 24, 3];
    const first = await viewer(t);
    const second = await viewer(t);
    const send = (socket, data) => socket.emit('message', { data, type: 'message' });

    // A toolbar button sends its down and its up as separate messages.
    send(first, keycode(DOWN, VOLUME_UP));
    send(first, keycode(UP, VOLUME_UP));
    send(first, keycode(DOWN, POWER));
    send(second, keycode(DOWN, HOME));
    // Typed text arrives as complete down/up pairs in one frame and leaves nothing held.
    send(first, Buffer.concat([keycode(DOWN, 7), keycode(UP, 7)]));
    assert.equal(writes.length, 5, 'everything is passed on unchanged');

    // The network drops while Power is held: the browser's release never arrives.
    first.close();
    assert.deepEqual(writes.slice(5), [keycode(UP, POWER)], 'the key this viewer held is released, and only that one');
    second.close();
    assert.deepEqual(writes.slice(6), [keycode(UP, HOME)]);
    first.emit('close');
    assert.equal(writes.length, 7, 'a second close releases nothing twice');
});
