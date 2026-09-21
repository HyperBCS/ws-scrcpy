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

function fixture(t) {
    const video = new Socket();
    const control = new Socket();
    const broadcast = new Broadcast(video, control);
    const header = Buffer.alloc(16);
    header.writeUInt32BE(0x68323634, 0);
    header.writeUInt32BE(720, 8);
    header.writeUInt32BE(1280, 12);
    video.emit('data', header);
    t.after(() => broadcast.stop());
    t.mock.method(broadcastManager, 'getBroadcast', () => broadcast);
    return { broadcast, send: (payload, kind) => video.emit('data', wire(payload, kind)) };
}

async function viewer(t) {
    class BrowserSocket extends EventEmitter {
        OPEN = 1; CLOSING = 2; CLOSED = 3; readyState = 1;
        sent = [];
        addEventListener(type, listener) { this.on(type, listener); }
        send(data) { this.sent.push(Buffer.from(data)); }
        close() { this.readyState = this.CLOSED; this.emit('close'); }
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
