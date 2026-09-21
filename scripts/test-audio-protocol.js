// Run with: node scripts/test-audio-protocol.js
// Wire fixtures follow stock scrcpy v4.1 Streamer.java and AudioConfig.java.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Socket } = require('node:net');
require('ts-node').register({ transpileOnly: true });
const { Broadcast } = require('../src/common/Broadcast');
const { AUDIO_MAGIC, AUDIO_PACKET_HEADER_SIZE, AudioPacketKind } = require('../src/common/AudioProtocol');
const { DEFAULT_SCRCPY_SERVER_CONFIG, buildScrcpyArgs } = require('../src/common/Constants');

function codec(id) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(id);
    return bytes;
}

function frame(payload, flags = 1000n) {
    const header = Buffer.alloc(12);
    header.writeBigUInt64BE(flags);
    header.writeUInt32BE(payload.length, 8);
    return Buffer.concat([header, payload]);
}

function unpack(packet) {
    assert.equal(packet.subarray(0, 14).toString(), AUDIO_MAGIC);
    return {
        kind: packet[14],
        timestamp: packet.readBigUInt64BE(15),
        payload: packet.subarray(AUDIO_PACKET_HEADER_SIZE),
    };
}

function metadata(packet) {
    const parsed = unpack(packet);
    assert.equal(parsed.kind, AudioPacketKind.METADATA);
    return JSON.parse(parsed.payload);
}

function session(t, enabled = true, options) {
    const video = new Socket();
    const control = new Socket();
    const audio = enabled ? new Socket() : undefined;
    const broadcast = new Broadcast(video, control, audio, undefined, options);
    t.after(() => broadcast.stop());
    const header = Buffer.alloc(16);
    header.writeUInt32BE(0x68323634);
    header.writeUInt32BE(0x80000000, 4);
    header.writeUInt32BE(720, 8);
    header.writeUInt32BE(1280, 12);
    video.emit('data', header);
    const packets = [];
    broadcast.addListener((packet) => packets.push(packet));
    return { video, control, audio, broadcast, packets };
}

test('audio defaults to browser-compatible PCM output and disabled mode omits source options', () => {
    const args = buildScrcpyArgs(DEFAULT_SCRCPY_SERVER_CONFIG);
    assert.match(args, /audio=true/);
    assert.match(args, /audio_codec=raw/);
    assert.match(args, /audio_source=output/);
    const disabled = buildScrcpyArgs({ ...DEFAULT_SCRCPY_SERVER_CONFIG, audio: false });
    assert.match(disabled, /audio=false/);
    assert.doesNotMatch(disabled, /audio_source|audio_codec=/);
    assert.match(buildScrcpyArgs({ ...DEFAULT_SCRCPY_SERVER_CONFIG, audioCodec: 'opus', audioSource: 'voice-call-downlink' }), /audio_codec=opus audio_source=voice-call-downlink/);
});

test('fragmented raw audio preserves PCM bytes and timestamps, stripping packet flags', (t) => {
    const { audio, broadcast, packets } = session(t);
    assert.equal(metadata(broadcast.getAudioBootstrapPackets()[0]).status, 'pending');
    const pcm = Buffer.from([1, 0, 255, 255, 0, 128, 255, 127]);
    const timestamp = 123456789012n;
    const bytes = Buffer.concat([codec(0x00726177), frame(pcm, timestamp | (1n << 61n))]);
    for (const byte of bytes) audio.emit('data', Buffer.from([byte]));
    assert.deepEqual(metadata(packets[0]), { status: 'ready', codec: 'raw', sampleRate: 48000, channels: 2 });
    const sample = unpack(packets[1]);
    assert.equal(sample.kind, AudioPacketKind.SAMPLE);
    assert.equal(sample.timestamp, timestamp);
    assert.deepEqual(sample.payload, pcm);
});

test('late Opus viewers receive codec metadata then the exact cached OpusHead', (t) => {
    const { audio, broadcast, packets } = session(t);
    const opusHead = Buffer.from('4f707573486561640102380180bb0000000000', 'hex');
    const opusPacket = Buffer.from([0xf8, 0xff, 0xfe]);
    audio.emit('data', Buffer.concat([
        codec(0x6f707573), frame(opusHead, 1n << 62n), frame(opusPacket, 90000n),
    ]));
    const bootstrap = broadcast.getAudioBootstrapPackets();
    assert.equal(metadata(bootstrap[0]).codec, 'opus');
    const config = unpack(bootstrap[1]);
    assert.equal(config.kind, AudioPacketKind.CONFIG);
    assert.equal(config.timestamp, 0n);
    assert.deepEqual(config.payload, opusHead);
    assert.deepEqual(unpack(packets.at(-1)).payload, opusPacket);
    assert.equal(bootstrap.length, 2, 'late viewers must not replay old audio samples');
});

for (const [id, status] of [[0, 'disabled'], [1, 'error'], [0x00616163, 'error']]) {
    test(`audio codec response ${id} disables only audio (${status})`, async (t) => {
        const failures = [];
        const { audio, video, control, broadcast, packets } = session(t, true, {
            onFailure: (failure) => failures.push(failure),
        });
        audio.emit('data', codec(id));
        assert.equal(metadata(packets[0]).status, status);
        assert.equal(audio.destroyed, true);
        assert.equal(video.destroyed, false);
        assert.equal(control.destroyed, false);
        assert.equal(await broadcast.whenReady(), true);
        assert.equal(broadcast.hasAudio(), false);
        assert.equal(failures.length, 1);
        const picture = Buffer.from([0, 0, 0, 1, 0x65]);
        video.emit('data', frame(picture, 1n << 61n));
        assert.deepEqual(packets.at(-1), picture, 'video remains live after audio failure');
    });
}

test('audio EOF clears config and reports an error without disconnecting video', (t) => {
    const { audio, video, control, broadcast } = session(t);
    audio.emit('data', Buffer.concat([codec(0x6f707573), frame(Buffer.from('OpusHead'), 1n << 62n)]));
    audio.emit('end');
    const bootstrap = broadcast.getAudioBootstrapPackets();
    assert.equal(bootstrap.length, 1);
    assert.equal(metadata(bootstrap[0]).status, 'error');
    assert.equal(video.destroyed, false);
    assert.equal(control.destroyed, false);
});

test('malformed packet sizes and partial PCM samples fail only the audio parser', (t) => {
    for (const payload of [Buffer.alloc(0), Buffer.alloc(3)]) {
        const { audio, video, control, broadcast } = session(t);
        audio.emit('data', Buffer.concat([codec(0x00726177), frame(payload)]));
        assert.equal(metadata(broadcast.getAudioBootstrapPackets()[0]).status, 'error');
        assert.equal(video.destroyed, false);
        assert.equal(control.destroyed, false);
    }
    const { audio, broadcast } = session(t);
    const oversized = Buffer.alloc(12);
    oversized.writeUInt32BE(0xffffffff, 8);
    audio.emit('data', Buffer.concat([codec(0x00726177), oversized]));
    assert.equal(metadata(broadcast.getAudioBootstrapPackets()[0]).status, 'error');
});

test('video-only fallback replays the capture failure instead of claiming audio was switched off', (t) => {
    const failure = { status: 'error', sampleRate: 48000, channels: 2, message: 'Call capture was rejected' };
    const { broadcast } = session(t, false, { failure });
    assert.deepEqual(metadata(broadcast.getAudioBootstrapPackets()[0]), failure);
    const disabled = session(t, false);
    assert.equal(metadata(disabled.broadcast.getAudioBootstrapPackets()[0]).status, 'disabled');
});
