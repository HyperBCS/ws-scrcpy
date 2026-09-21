// Audio regression checks without a device, speakers, or AudioDecoder browser support.
const assert = require('node:assert/strict');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

global.location = new URL('http://device-server.test:8000/');
const visibilityListeners = new Set();
global.document = {
    hidden: false,
    addEventListener: (_, listener) => visibilityListeners.add(listener),
    removeEventListener: (_, listener) => visibilityListeners.delete(listener),
};
class FakeAudioContext {
    static instances = [];
    constructor(options) {
        this.options = options;
        this.state = 'suspended';
        this.currentTime = 0;
        this.sampleRate = 44100;
        this.destination = {};
        this.buffers = [];
        this.sources = [];
        this.listeners = new Set();
        FakeAudioContext.instances.push(this);
    }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    createBuffer(channels, length, sampleRate) {
        const data = Array.from({ length: channels }, () => new Float32Array(length));
        const buffer = { length, sampleRate, duration: length / sampleRate, data, getChannelData: (channel) => data[channel], copyToChannel: (samples, channel) => data[channel].set(samples) };
        this.buffers.push(buffer);
        return buffer;
    }
    createBufferSource() {
        const source = { connect() {}, disconnect() { this.disconnected = true; }, start(time) { this.startTime = time; }, stop() { this.stopped = true; } };
        this.sources.push(source);
        return source;
    }
    addEventListener(_, listener) { this.listeners.add(listener); }
    removeEventListener(_, listener) { this.listeners.delete(listener); }
    changeState(state) { this.state = state; this.listeners.forEach((listener) => listener()); }
    resume() { this.changeState('running'); return Promise.resolve(); }
    suspend() { this.changeState('suspended'); return Promise.resolve(); }
    close() { this.changeState('closed'); return Promise.resolve(); }
}
global.AudioContext = FakeAudioContext;
global.AudioDecoder = undefined;
global.EncodedAudioChunk = undefined;
const { AudioPlayer, extractOpusHead } = require('../src/app/player/AudioPlayer');
const { StreamReceiver } = require('../src/app/client/StreamReceiver');
const metadata = { status: 'ready', codec: 'raw', sampleRate: 48000, channels: 2 };
const makePcm = (timestamp, frames = 480) => ({ config: false, timestamp, data: new Uint8Array(frames * 4) });

const player = new AudioPlayer();
assert.equal(player.isSupported(), true, 'PCM works when AudioDecoder is absent, including HTTP browsers');
player.setMetadata(metadata);
player.pushFrame(makePcm(0));
assert.equal(FakeAudioContext.instances.length, 0, 'No AudioContext or buffers are created before Listen');
player.play();
const context = FakeAudioContext.instances[0];
assert.equal(context.options.sampleRate, undefined, 'Use the output hardware rate and let Web Audio resample buffers');
const backing = Buffer.alloc(9);
[-32768, 32767, 16384, -16384].forEach((sample, index) => backing.writeInt16LE(sample, 1 + index * 2));
player.pushFrame({ config: false, timestamp: 100000, data: new Uint8Array(backing.buffer, backing.byteOffset + 1, 8) });
assert.deepEqual([...context.buffers[0].data[0]], [-1, 0.5], 'PCM left channel is deinterleaved and normalized');
assert.deepEqual([...context.buffers[0].data[1]], [32767 / 32768, -0.5], 'PCM right channel handles little-endian unaligned views');
assert.equal(context.buffers[0].sampleRate, 48000);
assert.equal(player.status.value.state, 'playing');
assert.equal(player.getStats().lastPeak, 1);
const firstSource = context.sources[0];
player.mute();
assert.equal(firstSource.stopped, true);
assert.equal(firstSource.disconnected, true);
assert.equal(player.getStats().bufferedMs, 0);
const previousBuffers = context.buffers.length;
for (let i = 0; i < 50; i++) player.pushFrame(makePcm(200000 + i * 10000));
assert.equal(context.buffers.length, previousBuffers, 'Muted samples are dropped before allocation');
player.play();
player.pushFrame(makePcm(2000000));
player.setConnected(false);
assert.equal(player.status.value.state, 'disconnected');
assert.equal(player.getStats().bufferedMs, 0);
player.pushFrame(makePcm(2100000));
assert.equal(player.status.value.state, 'disconnected', 'Late samples cannot replace reconnect status');
player.setConnected(true);
player.setMetadata(metadata);
player.pushFrame(makePcm(2200000));
assert.equal(player.status.value.state, 'playing', 'An unlocked listening session resumes at live audio after reconnect');

document.hidden = true;
visibilityListeners.forEach((listener) => listener());
const hiddenBuffers = context.buffers.length;
player.pushFrame(makePcm(2300000));
assert.equal(context.buffers.length, hiddenBuffers, 'Backgrounded audio cannot accumulate');
assert.equal(player.getStats().bufferedMs, 0);
document.hidden = false;
visibilityListeners.forEach((listener) => listener());
context.changeState('suspended');
assert.equal(player.status.value.state, 'blocked');
player.pushFrame(makePcm(2400000));
assert.equal(context.buffers.length, hiddenBuffers, 'Suspended contexts never receive scheduled buffers');
player.play();
for (let i = 0; i < 100; i++) player.pushFrame(makePcm(3000000 + i * 10000));
assert.ok(player.getStats().bufferedMs <= 200.01, 'Delivery bursts remain bounded near live instead of queueing seconds');
const queued = context.sources.filter((source) => !source.stopped);
assert.ok(queued.length <= 20, 'A bounded number of source nodes remain live');
player.pushFrame({ config: false, timestamp: 5000000, data: new Uint8Array(3) });
assert.equal(player.status.value.state, 'error', 'Incomplete channel frames fail clearly');
assert.equal(player.getStats().bufferedMs, 0);
player.setMetadata({ ...metadata, status: 'error', message: 'Device denied call capture' });
assert.equal(player.status.value.message, 'Device denied call capture');
player.stop();
assert.equal(context.state, 'closed');
assert.equal(visibilityListeners.size, 0);

// AudioRecord timestamps track the capture clock and can wobble around sample boundaries.
// Render the scheduled graph as a waveform: jitter must not insert silence or mix chunks.
function assertContinuousTone(context, label) {
    const firstStart = context.sources[0].startTime;
    const frameCount = context.sources.reduce((sum, source) => sum + source.buffer.length, 0);
    const output = new Float64Array(frameCount);
    for (const source of context.sources) {
        assert.equal(source.stopped, undefined, `${label}: ordinary jitter must not clear queued sound`);
        const offset = Math.round((source.startTime - firstStart) * 48000);
        source.buffer.data[0].forEach((sample, index) => {
            if (offset + index >= 0 && offset + index < output.length) output[offset + index] += sample;
        });
    }
    let maxError = 0;
    output.forEach((sample, index) => {
        const expected = Math.round(8192 * Math.sin(2 * Math.PI * 440 * index / 48000)) / 32768;
        maxError = Math.max(maxError, Math.abs(sample - expected));
    });
    assert(maxError < 1 / 32768, `${label}: clean 440 Hz input stays continuous, maximum sample error ${maxError}`);
}
function tonePacket(offset, frames, timestamp) {
    const data = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
        const sample = Math.round(8192 * Math.sin(2 * Math.PI * 440 * (offset + i) / 48000));
        data.writeInt16LE(sample, i * 4);
        data.writeInt16LE(sample, i * 4 + 2);
    }
    return { config: false, timestamp, data };
}
const continuousPcm = new AudioPlayer();
continuousPcm.setMetadata(metadata);
continuousPcm.play();
const continuousContext = FakeAudioContext.instances.at(-1);
let sampleOffset = 0;
for (let index = 0; index < 45; index++) {
    // Exercise variable packet sizes and a late packet followed by a burst, within the live buffer.
    const frames = [512, 480, 960][index % 3];
    continuousContext.currentTime = sampleOffset / 48000 + [0, .012, -.004][index % 3];
    // Pixel 8 capture showed approximately ±2242 microseconds between real packet clocks.
    const timestamp = 1_000_000 + Math.round(sampleOffset / 48000 * 1_000_000) + [0, 1604, -2242][index % 3];
    continuousPcm.pushFrame(tonePacket(sampleOffset, frames, timestamp));
    sampleOffset += frames;
}
assertContinuousTone(continuousContext, 'PCM capture timestamp jitter');
continuousContext.currentTime += 1;
continuousPcm.pushFrame(tonePacket(sampleOffset, 480, 3_000_000));
assert.equal(continuousContext.sources.filter((source) => !source.stopped).length, 1, 'A real delivery stall drops old queued sound');
assert(Math.abs(continuousContext.sources.at(-1).startTime - continuousContext.currentTime - .04) < 1e-9, 'After an underrun, playback restarts near live with a small jitter buffer');
assert(continuousPcm.getStats().bufferedMs <= 200, 'Underrun recovery stays within the live audio bound');
continuousPcm.stop();

const opusHead = Buffer.alloc(19);
opusHead.write('OpusHead');
opusHead[8] = 1;
opusHead[9] = 2;
opusHead.writeUInt32LE(48000, 12);
const wrapper = Buffer.alloc(16 + opusHead.length + 16);
wrapper.write('AOPUSHDR');
wrapper.writeBigUInt64LE(BigInt(opusHead.length), 8);
opusHead.copy(wrapper, 16);
assert.deepEqual(extractOpusHead(wrapper), new Uint8Array(opusHead));
assert.deepEqual(extractOpusHead(opusHead), new Uint8Array(opusHead));
assert.equal(extractOpusHead(new Uint8Array(7)), undefined);
class FakeAudioDecoder {
    static instances = [];
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = []; FakeAudioDecoder.instances.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) { this.chunks.push(chunk); }
    close() { this.state = 'closed'; }
}
global.AudioDecoder = FakeAudioDecoder;
global.EncodedAudioChunk = class { constructor(init) { Object.assign(this, init); } };
const opusPlayer = new AudioPlayer();
opusPlayer.setMetadata({ ...metadata, codec: 'opus' });
opusPlayer.pushFrame({ config: true, data: wrapper });
assert.equal(FakeAudioDecoder.instances.length, 0, 'Muted Opus is not decoded');
opusPlayer.play();
opusPlayer.pushFrame({ config: false, timestamp: 987654321, data: new Uint8Array([0xf8, 0xff, 0xfe]) });
const firstDecoder = FakeAudioDecoder.instances[0];
assert.deepEqual(firstDecoder.config.description, new Uint8Array(opusHead));
assert.equal(firstDecoder.chunks[0].timestamp, 987654321, 'Encoded samples retain scrcpy presentation timestamps');
firstDecoder.decodeQueueSize = 8;
opusPlayer.pushFrame({ config: false, timestamp: 987674321, data: new Uint8Array([0xf8, 0xff, 0xfe]) });
assert.equal(firstDecoder.state, 'closed', 'Decoder backpressure discards stale pending audio');
let staleClosed = false;
firstDecoder.callbacks.output({ close() { staleClosed = true; } });
assert.equal(staleClosed, true, 'Stale decoder output still releases its AudioData');
opusPlayer.stop();

const continuousOpus = new AudioPlayer();
continuousOpus.setMetadata({ ...metadata, codec: 'opus' });
continuousOpus.pushFrame({ config: true, data: opusHead });
continuousOpus.play();
const opusContext = FakeAudioContext.instances.at(-1);
let outputsClosed = 0;
for (let index = 0; index < 25; index++) {
    const timestamp = 8_000_000 + index * 20000 + [0, 1604, -2242][index % 3];
    opusContext.currentTime = index * .02;
    continuousOpus.pushFrame({ config: false, timestamp, data: new Uint8Array([0xf8, 0xff, 0xfe]) });
    const tone = tonePacket(index * 960, 960, timestamp);
    FakeAudioDecoder.instances.at(-1).callbacks.output({
        timestamp, numberOfFrames: 960, numberOfChannels: 2, sampleRate: 48000,
        copyTo(target) { for (let i = 0; i < 960; i++) target[i] = tone.data.readInt16LE(i * 4) / 32768; },
        close() { outputsClosed++; },
    });
}
assertContinuousTone(opusContext, 'Decoded Opus capture timestamp jitter');
assert.equal(outputsClosed, 25, 'Continuous playback releases every decoded AudioData');
continuousOpus.stop();

class TestReceiver extends StreamReceiver { openNewConnection() { return undefined; } }
const receiver = new TestReceiver({ action: 'stream', udid: 'test', player: 'test' });
const audioEvents = [];
const metadataEvents = [];
const videoEvents = [];
receiver.on('audio', (frame) => audioEvents.push(frame));
receiver.on('audioMetadata', (value) => metadataEvents.push(value));
receiver.on('video', (value) => videoEvents.push(value));
const packet = (kind, timestamp, payload) => {
    const bytes = Buffer.alloc(23 + payload.length);
    bytes.write('scrcpy_audio_2');
    bytes[14] = kind;
    bytes.writeBigUInt64BE(BigInt(timestamp), 15);
    bytes.set(payload, 23);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
receiver.onSocketMessage({ data: packet(2, 0, Buffer.from(JSON.stringify(metadata))) });
assert.deepEqual(metadataEvents[0], metadata);
receiver.onSocketMessage({ data: packet(0, 1234567890123, Buffer.from([0, 0, 255, 127])) });
assert.equal(audioEvents[0].timestamp, 1234567890123);
assert.deepEqual([...audioEvents[0].data], [0, 0, 255, 127]);
receiver.onSocketMessage({ data: packet(2, 0, Buffer.from('{invalid')) });
assert.equal(metadataEvents.at(-1).status, 'error');
const truncated = new TextEncoder().encode('scrcpy_audio_2');
receiver.onSocketMessage({ data: truncated.buffer });
assert.equal(metadataEvents.at(-1).message, 'Truncated audio packet.');
assert.equal(videoEvents.length, 0, 'Malformed audio is never forwarded into the video decoder');
console.log('PASS: PCM conversion, sample-contiguous PCM/Opus waveforms under capture jitter, unlock/mute/background/reconnect, bounded buffering/underrun recovery, Opus configuration/timestamps, and audio wire parsing');

// The browser category API is optional and shared by all players in this page.
(async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
    const previousContext = global.AudioContext;
    const setNavigator = (value) => Object.defineProperty(global, 'navigator', { configurable: true, value });
    const session = { type: 'ambient' };
    try {
        setNavigator({ audioSession: session });
        global.AudioContext = class extends FakeAudioContext {
            constructor(options) {
                assert.equal(session.type, 'playback', 'Select the media category before creating AudioContext');
                super(options);
            }
            resume() {
                assert.equal(session.type, 'playback', 'Select the media category before resuming AudioContext');
                return super.resume();
            }
        };
        const listener = new AudioPlayer();
        assert.equal(session.type, 'ambient', 'Opening a stream alone must not claim the media category');
        listener.play();
        listener.play();
        assert.equal(session.type, 'playback');
        listener.mute();
        assert.equal(session.type, 'ambient', 'Mute releases an idempotent Listen claim');
        listener.play();
        listener.stop();
        assert.equal(session.type, 'ambient', 'Stop restores the previous category');
        global.AudioContext = previousContext;

        const first = new AudioPlayer();
        const second = new AudioPlayer();
        first.play();
        second.play();
        first.stop();
        assert.equal(session.type, 'playback', 'Stopping an old player must not reset the new player category');
        second.stop();
        assert.equal(session.type, 'ambient', 'The last player restores the original category');

        session.type = 'playback';
        const preexisting = new AudioPlayer();
        preexisting.play();
        preexisting.stop();
        assert.equal(session.type, 'playback', 'Preexisting playback ownership is left intact');
        session.type = 'auto';
        const overridden = new AudioPlayer();
        overridden.play();
        session.type = 'play-and-record';
        overridden.stop();
        assert.equal(session.type, 'play-and-record', 'A later category choice by another caller must not be overwritten');

        const throwingProperty = {};
        Object.defineProperty(throwingProperty, 'audioSession', { get() { throw Error('API getter denied'); } });
        const throwingType = {};
        Object.defineProperty(throwingType, 'type', { get() { throw Error('Category getter denied'); } });
        const throwingSetter = {};
        Object.defineProperty(throwingSetter, 'type', { get() { return 'auto'; }, set() { throw Error('Category setter denied'); } });
        const ignoredSetter = {};
        Object.defineProperty(ignoredSetter, 'type', { get() { return 'auto'; }, set() {} });
        for (const navigatorValue of [undefined, {}, throwingProperty, { audioSession: throwingType }, { audioSession: throwingSetter }, { audioSession: ignoredSetter }]) {
            setNavigator(navigatorValue);
            const fallback = new AudioPlayer();
            fallback.setMetadata(metadata);
            assert.doesNotThrow(() => fallback.play());
            fallback.pushFrame(makePcm(0));
            assert.equal(fallback.status.value.state, 'playing', 'Unavailable or rejected category APIs cannot break ordinary PCM playback');
            assert.doesNotThrow(() => fallback.mute());
            assert.doesNotThrow(() => fallback.stop());
        }

        let restoreCategory = 'auto';
        const restoreThrows = {};
        Object.defineProperty(restoreThrows, 'type', { get() { return restoreCategory; }, set(value) { if (value !== 'playback') throw Error('Restore denied'); restoreCategory = value; } });
        setNavigator({ audioSession: restoreThrows });
        const cannotRestore = new AudioPlayer();
        cannotRestore.play();
        assert.doesNotThrow(() => cannotRestore.mute(), 'Restore failures must not break mute');
        assert.doesNotThrow(() => cannotRestore.stop());

        session.type = 'auto';
        setNavigator({ audioSession: session });
        global.AudioContext = class { constructor() { throw Error('No audio output'); } };
        const failedContext = new AudioPlayer();
        failedContext.play();
        assert.equal(session.type, 'auto', 'Context startup failure immediately releases the category');
        failedContext.stop();

        let rejectResume;
        global.AudioContext = class extends FakeAudioContext {
            resume() { return new Promise((_, reject) => { rejectResume = reject; }); }
        };
        const failedResume = new AudioPlayer();
        failedResume.play();
        assert.equal(session.type, 'playback');
        rejectResume(Error('Autoplay denied'));
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(session.type, 'auto', 'Resume rejection releases the category until another Listen tap');
        assert.equal(failedResume.status.value.state, 'blocked', 'Autoplay refusal keeps Listen available without a device restart');
        FakeAudioContext.instances.at(-1).resume = FakeAudioContext.prototype.resume;
        failedResume.setMetadata(metadata);
        failedResume.play();
        failedResume.pushFrame(makePcm(0));
        assert.equal(failedResume.status.value.state, 'playing', 'A fresh Listen gesture recovers from a rejected resume');
        failedResume.stop();

        const staleRejections = [];
        global.AudioContext = class extends FakeAudioContext {
            resume() {
                if (!staleRejections.length) return new Promise((_, reject) => staleRejections.push(reject));
                return super.resume();
            }
        };
        const retried = new AudioPlayer();
        retried.play();
        retried.play();
        staleRejections[0](Error('Old resume failure'));
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(session.type, 'playback', 'An older failed Listen attempt cannot release a newer successful claim');
        assert.notEqual(retried.status.value.state, 'error');
        retried.stop();
        assert.equal(session.type, 'auto');
        console.log('PASS: optional iOS playback category activation, ownership, restore, property failures, and resume races');
    } finally {
        global.AudioContext = previousContext;
        if (navigatorDescriptor) Object.defineProperty(global, 'navigator', navigatorDescriptor);
        else delete global.navigator;
    }
})()
    .then(() => volumeAndBufferTests())
    .catch((error) => { console.error(error); process.exitCode = 1; });

// Runs after the playback-category tests above: both swap the AudioContext class.
function volumeAndBufferTests() {
    // Volume: remembered per browser, applied on top of mute, ramped rather than stepped.
    {
        const store = new Map();
        global.localStorage = { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, value) };
        const gainCalls = [];
        const gainContext = class extends FakeAudioContext {
            createGain() {
                return {
                    gain: {
                        value: 0,
                        cancelScheduledValues: (at) => gainCalls.push(['cancel', at]),
                        setTargetAtTime: (value, at, constant) => gainCalls.push(['target', value, at, constant]),
                    },
                    connect() {},
                    disconnect() {},
                };
            }
        };
        global.AudioContext = gainContext;
        const loud = new AudioPlayer();
        assert.equal(loud.getVolume(), 1, 'Full volume until the viewer chooses otherwise');
        loud.setVolume(0.3);
        assert.equal(store.get('ws_scrcpy_audio_volume'), '0.3', 'The level is remembered for the next stream');
        loud.setVolume(7);
        assert.equal(loud.getVolume(), 1, 'Levels clamp to 0..1');
        loud.setVolume(0.3);
        const remembered = new AudioPlayer();
        assert.equal(remembered.getVolume(), 0.3, 'A new player starts at the remembered level');
        remembered.setMetadata(metadata);
        remembered.play();
        const gainNode = gainContext.instances[gainContext.instances.length - 1];
        assert.equal(gainCalls.length, 0, 'Listen sets the gain directly (nothing is playing yet to click)');
        remembered.setVolume(0.6);
        assert.deepEqual(gainCalls[gainCalls.length - 1].slice(0, 2), ['target', 0.6], 'A change while playing ramps the gain');
        remembered.mute();
        gainCalls.length = 0;
        remembered.setVolume(0.9);
        assert.equal(gainCalls.length, 0, 'Changing the level while muted stays silent until Listen');
        assert.equal(remembered.getVolume(), 0.9);
        remembered.stop();
        loud.stop();
        void gainNode;
        global.AudioContext = FakeAudioContext;
        delete global.localStorage;
    }

    // Buffer profile: a source that delivers ~80 ms bursts underruns with the 40 ms default and
    // plays through with the profile the iOS receiver asks for.
    function burstyDelivery(player, bursts = 40, periodSeconds = 0.082) {
        player.setMetadata(metadata);
        player.play();
        const context = FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
        let timestamp = 0;
        for (let burst = 0; burst < bursts; burst++) {
            context.currentTime = burst * periodSeconds;
            for (let packet = 0; packet < 4; packet++) {
                player.pushFrame(makePcm(timestamp, 960));
                timestamp += 20000;
            }
        }
        const stats = player.getStats();
        player.stop();
        return stats;
    }
    const defaultProfile = burstyDelivery(new AudioPlayer());
    assert.ok(defaultProfile.underruns >= 1, `The 40 ms default runs dry on burst delivery (underruns=${defaultProfile.underruns})`);
    const tolerant = burstyDelivery(new AudioPlayer({ targetSeconds: 0.16, maxSeconds: 0.5 }));
    assert.equal(tolerant.underruns, 0, 'A 160 ms target rides out 80 ms bursts without a gap');
    assert.ok(tolerant.bufferedMs > 0 && tolerant.bufferedMs <= 500, `Buffering stays bounded (${tolerant.bufferedMs} ms)`);
    const clamped = new AudioPlayer({ targetSeconds: 0.3, maxSeconds: 0.1 });
    clamped.setMetadata(metadata);
    clamped.play();
    for (let i = 0; i < 30; i++) clamped.pushFrame(makePcm(i * 20000, 960));
    assert.ok(clamped.getStats().bufferedMs <= 600.01, 'A max below the target is raised to twice the target rather than starving playback');
    clamped.stop();
    console.log('audio player: volume and buffer profile ok');
}
