// Run with: node --test scripts/test-stream-clients.js
// Browser-side stream code against mocked browser APIs: the Android scroll encoding, decoder
// recovery, touch mapping beside the picture, player statistics and held keys and buttons.
// No server, browser or device is used.
const assert = require('node:assert/strict');
const { test } = require('node:test');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

// Static assets pulled in by the client modules (icons, touch-point images) are not code.
for (const ext of ['.svg', '.png', '.css']) {
    require.extensions[ext] = (module) => {
        module.exports = '';
    };
}

class MockDecoder {
    static instances = [];
    static isConfigSupported = async () => ({ supported: true });
    state = 'unconfigured';
    chunks = [];
    configs = [];
    constructor(init) {
        this.init = init;
        MockDecoder.instances.push(this);
    }
    configure(config) {
        this.state = 'configured';
        this.configs.push(config);
    }
    decode(chunk) {
        this.chunks.push(chunk);
    }
    close() {
        this.state = 'closed';
    }
    /** What a browser does when its decoder dies: close it, then report. */
    fail(message = 'decoder lost') {
        this.state = 'closed';
        this.init.error(Object.assign(new Error(message), { code: 0 }));
    }
}
class MockChunk {
    constructor(init) {
        Object.assign(this, init);
    }
}

/** A DOM element with only what the players and handlers touch. */
function element(overrides = {}) {
    const listeners = new Map();
    return {
        style: {},
        dataset: {},
        classList: { add() {}, remove() {} },
        width: 0,
        height: 0,
        clientWidth: 0,
        clientHeight: 0,
        parentElement: null,
        listeners,
        getContext: () => ({ drawImage() {}, clearRect() {}, save() {}, restore() {} }),
        setAttribute() {},
        removeAttribute() {},
        addEventListener(name, fn) {
            listeners.set(name, fn);
        },
        removeEventListener(name) {
            listeners.delete(name);
        },
        appendChild(child) {
            child.parentElement = this;
        },
        removeChild(child) {
            child.parentElement = null;
        },
        remove() {},
        getBoundingClientRect() {
            return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
        },
        setPointerCapture() {},
        play: async () => {},
        toDataURL: () => 'data:,',
        ...overrides,
    };
}

const windowListeners = new Map();
const documentListeners = new Map();
const bodyListeners = new Map();
const listenerApi = (map) => ({
    addEventListener(name, fn) {
        map.set(name, fn);
    },
    removeEventListener(name, fn) {
        if (map.get(name) === fn) map.delete(name);
    },
});
global.VideoDecoder = MockDecoder;
global.EncodedVideoChunk = MockChunk;
global.requestAnimationFrame = () => 1;
global.cancelAnimationFrame = () => {};
global.document = {
    ...listenerApi(documentListeners),
    visibilityState: 'visible',
    hidden: false,
    createElement: () => element(),
    querySelector: () => element(),
    body: { ...listenerApi(bodyListeners), classList: { add() {}, remove() {} }, clientWidth: 1000, clientHeight: 800 },
};
global.window = global;
Object.assign(global, listenerApi(windowListeners));
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
Object.defineProperty(global, 'navigator', { configurable: true, value: { userAgent: 'node', platform: 'Linux' } });
global.location = new URL('http://localhost:8000/');
global.Image = class {
    set src(_) {
        /* never loads */
    }
};
// The handlers tell the two event families apart with instanceof.
global.MouseEvent = class MouseEvent {
    constructor(type, init = {}) {
        Object.assign(this, { type, buttons: 0, button: 0, ctrlKey: false, shiftKey: false, cancelable: true }, init);
    }
    preventDefault() {
        this.defaultPrevented = true;
    }
    stopPropagation() {}
};
global.WheelEvent = class WheelEvent extends global.MouseEvent {
    constructor(type, init = {}) {
        super(type, { deltaX: 0, deltaY: 0, deltaMode: 0, ...init });
    }
};
global.TouchEvent = class TouchEvent {
    constructor(type, init = {}) {
        Object.assign(this, { type, cancelable: true }, init);
    }
    preventDefault() {
        this.defaultPrevented = true;
    }
    stopPropagation() {}
};

const Size = require('../src/app/Size').default;
const Rect = require('../src/app/Rect').default;
const Point = require('../src/app/Point').default;
const Position = require('../src/app/Position').default;
const ScreenInfo = require('../src/app/ScreenInfo').default;

const screen = (width, height) => new ScreenInfo(new Rect(0, 0, width, height), new Size(width, height), 0);

// ---------------------------------------------------------------- Android mouse wheel

test('one wheel notch is encoded as one scrcpy notch, not sixteen', () => {
    const { ScrollControlMessage } = require('../src/app/controlMessage/ScrollControlMessage');
    const position = new Position(new Point(100, 200), new Size(720, 1280));
    const bytes = (h, v) => new ScrollControlMessage(position, h, v).toBuffer();
    const up = bytes(0, 1);
    assert.equal(up.length, 21);
    assert.equal(up[0], 3, 'INJECT_SCROLL_EVENT');
    assert.deepEqual([up.readUInt32BE(1), up.readUInt32BE(5), up.readUInt16BE(9), up.readUInt16BE(11)], [100, 200, 720, 1280]);
    // The server multiplies the decoded value by 16, so one notch is 1/16 of full scale (2^15).
    assert.equal(up.readInt16BE(13), 0);
    assert.equal(up.readInt16BE(15), 0x0800);
    assert.equal(bytes(0, -1).readInt16BE(15), -0x0800);
    assert.equal(bytes(-2, 0).readInt16BE(13), -0x1000);
    assert.equal(bytes(0, 0.5).readInt16BE(15), 0x0400, 'a fraction of a notch survives');
    assert.equal(bytes(0, 16).readInt16BE(15), 0x7fff, 'full scale is capped the way scrcpy caps it');
    assert.equal(bytes(0, -16).readInt16BE(15), -0x8000);
    assert.equal(bytes(0, 400).readInt16BE(15), 0x7fff, 'more than sixteen notches is clamped');
    assert.equal(up.readInt32BE(17), 0, 'no buttons');
});

function androidHandler(t, { width = 720, height = 1280, clientWidth = 360, clientHeight = 640 } = {}) {
    const { FeaturedInteractionHandler } = require('../src/app/interactionHandler/FeaturedInteractionHandler');
    const wrapper = element({ clientWidth: clientWidth + 60, clientHeight });
    const canvas = element({
        clientWidth,
        clientHeight,
        // The picture is centred in the wrapper, with a 30 px band on each side.
        getBoundingClientRect: () => ({ left: 30, top: 0, width: clientWidth, height: clientHeight }),
    });
    wrapper.appendChild(canvas);
    const player = { getTouchableElement: () => canvas, getScreenInfo: () => screen(width, height) };
    const sent = [];
    const handler = new FeaturedInteractionHandler(player, { sendMessage: (message) => sent.push(message) });
    t.after(() => handler.release());
    return { handler, canvas, wrapper, sent, info: screen(width, height) };
}

test('a mouse wheel notch scrolls one notch, and trackpad steps add up between messages', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const { handler, canvas, info } = androidHandler(t);
    const wheel = (init) =>
        handler.buildScrollEvent(new WheelEvent('wheel', { target: canvas, clientX: 210, clientY: 320, ...init }), info);

    const [down] = wheel({ deltaY: 100 });
    assert.deepEqual([down.hScroll, down.vScroll], [0, -1], 'one notch down in Chrome');
    assert.deepEqual([down.position.point.x, down.position.point.y], [360, 640]);

    t.mock.timers.tick(500);
    const [lines] = wheel({ deltaY: -3, deltaMode: 1 });
    assert.equal(lines.vScroll, 1, 'one notch up in Firefox, which reports lines');

    t.mock.timers.tick(500);
    const [sideways] = wheel({ deltaX: 50 });
    assert.deepEqual([sideways.hScroll, sideways.vScroll], [-0.5, 0]);

    // A trackpad: small steps every 8 ms. They are not sent one by one, and none is lost.
    t.mock.timers.tick(500);
    const messages = [];
    for (let i = 0; i < 10; i++) {
        messages.push(...wheel({ deltaY: 5 }));
        t.mock.timers.tick(8);
    }
    assert.ok(messages.length >= 2 && messages.length <= 4, `throttled, got ${messages.length}`);
    const total = messages.reduce((sum, message) => sum + message.vScroll, 0);
    assert.ok(total <= -0.35 && total >= -0.5, `ten 5 px steps scroll about half a notch, got ${total}`);
    assert.ok(
        messages.every((message) => Math.abs(message.vScroll) < 1),
        'a small step is never rounded up to a whole notch',
    );

    // What was left over from that scroll is not added to an unrelated one later.
    t.mock.timers.tick(1000);
    const [later] = wheel({ deltaY: -100 });
    assert.equal(later.vScroll, 1);

    t.mock.timers.tick(500);
    const [page] = wheel({ deltaY: 5, deltaMode: 2 });
    assert.equal(page.vScroll, -16, 'a large jump is capped at what one message can carry');
});

// ---------------------------------------------------------------- player statistics

test('players keep about one second of frame statistics however long the stream runs', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
    // No animation frame ever runs here, as in a hidden tab or a player without a stats loop.
    const { WebCodecsHevcPlayer } = require('../src/app/player/WebCodecsHevcPlayer');
    const { MseHevcPlayer } = require('../src/app/player/MseHevcPlayer');
    const { MsePlayer } = require('../src/app/player/MsePlayer');

    MockDecoder.instances.length = 0;
    const hevc = new WebCodecsHevcPlayer('iphone-stats');
    hevc.configure('hev1', new Uint8Array([1]));
    hevc.play();
    const frame = { displayWidth: 100, displayHeight: 200, close() {} };
    // Ten minutes at 60 fps.
    for (let i = 0; i < 36_000; i++) {
        hevc.pushFrame(new Uint8Array([i === 0 ? 0 : 1, 0xaa]));
        MockDecoder.instances[0].init.output(frame);
        hevc.decodedFrames.length = 0;
        t.mock.timers.tick(16);
    }
    assert.equal(MockDecoder.instances[0].chunks.length, 36_000, 'every frame still reaches the decoder');
    assert.equal(hevc.inputBytes.length, 0, 'the WebCodecs HEVC player records no input it never reads');
    assert.ok(hevc.videoStats.length <= 64, `decoded-frame records are bounded, got ${hevc.videoStats.length}`);
    hevc.stop();

    for (const player of [new MseHevcPlayer('iphone-stats-mse'), new MsePlayer('android-stats')]) {
        // Neither has a source to feed in this test; only the accounting in BasePlayer runs.
        for (let i = 0; i < 36_000; i++) {
            player.pushFrame(new Uint8Array([1, 0xaa, 0xbb, 0xcc, 0xdd]));
            t.mock.timers.tick(16);
        }
        assert.ok(
            player.inputBytes.length <= 64,
            `${player.getName()} input records are bounded, got ${player.inputBytes.length}`,
        );
        assert.equal(player.inputBytes.at(-1).bytes, 5);
    }
});

// ---------------------------------------------------------------- Android decoder recovery

// Two real 32x32 frames encoded by libx264, as whole Annex-B packets the way scrcpy sends them.
// CONFIG holds the SPS and the PPS; scrcpy sends it once per encoder session.
const CONFIG = Buffer.from('000000016742c00ada25b011000003000100000300788f1226a00000000168ce0fc8', 'hex');
const IDR = Buffer.from('000000016588843a118a000218f1c00040f63800087949d75e', 'hex');
const DELTA = Buffer.from('00000001419a206a2c', 'hex');
// A fresh copy per push, like the receiver's one ArrayBuffer per WebSocket message.
const packet = (bytes) => new Uint8Array(bytes);

function webCodecsPlayer(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 3_000_000 });
    const { WebCodecsPlayer } = require('../src/app/player/WebCodecsPlayer');
    const { BasePlayer } = require('../src/app/player/BasePlayer');
    MockDecoder.instances.length = 0;
    const player = new WebCodecsPlayer('android-recovery');
    t.after(() => player.stop());
    const events = [];
    player.on('decoder-error', (event) => events.push(event.recovering ? 'recovering' : 'stopped'));
    player.on('keyframe-request', () => events.push('keyframe-request'));
    player.play();
    player.pushFrame(packet(CONFIG));
    player.pushFrame(packet(IDR));
    player.pushFrame(packet(DELTA));
    const decoders = MockDecoder.instances;
    assert.equal(decoders.length, 1);
    assert.equal(decoders[0].chunks.length, 2);
    return { player, decoders, events, STATE: BasePlayer.STATE };
}

test('the WebCodecs player recovers from a decoder error without a new SPS from the stream', (t) => {
    const { player, decoders, events, STATE } = webCodecsPlayer(t);
    const codec = decoders[0].configs[0].codec;
    assert.match(codec, /^avc1\.42C00A$/);

    // For example a GPU process restart: the decoder dies, the socket and the stream carry on.
    decoders[0].fail();
    assert.equal(decoders.length, 2, 'a new decoder replaces the failed one');
    assert.deepEqual(decoders[1].configs, [{ codec, optimizeForLatency: true }], 'configured from the cached SPS');
    assert.equal(player.getState(), STATE.PLAYING, 'the player keeps running');
    assert.deepEqual(events, ['recovering']);

    player.pushFrame(packet(DELTA));
    player.pushFrame(packet(DELTA));
    assert.equal(decoders[1].chunks.length, 0, 'pictures that depend on the lost keyframe are dropped');

    player.pushFrame(packet(IDR));
    assert.equal(decoders[1].chunks.length, 1, 'decoding resumes at the next keyframe');
    assert.deepEqual(
        Buffer.from(decoders[1].chunks[0].data),
        Buffer.concat([CONFIG, IDR]),
        'the keyframe is sent with the cached parameter sets and nothing stale in front',
    );
    player.pushFrame(packet(DELTA));
    assert.equal(decoders[1].chunks.length, 2);

    t.mock.timers.tick(60_000);
    assert.deepEqual(events, ['recovering'], 'a keyframe that arrived by itself needs no request and no notice');
});

test('the WebCodecs player asks for a keyframe when none arrives, then reports that it is stuck', (t) => {
    const { player, decoders, events } = webCodecsPlayer(t);
    decoders[0].fail();
    player.pushFrame(packet(DELTA));
    t.mock.timers.tick(1999);
    assert.deepEqual(events, ['recovering']);
    t.mock.timers.tick(1);
    assert.deepEqual(events, ['recovering', 'keyframe-request'], 'a still screen sends no keyframe unasked');
    t.mock.timers.tick(4000);
    assert.deepEqual(events, ['recovering', 'keyframe-request', 'stopped'], 'one request, then a visible report');
    t.mock.timers.tick(60_000);
    assert.equal(events.length, 3, 'the encoder is not restarted again and again');

    // The keyframe the request produced still recovers the picture.
    player.pushFrame(packet(IDR));
    assert.equal(decoders[1].chunks.length, 1);
});

test('a decoder that keeps failing is paused with a report, then tried again instead of stopped for good', (t) => {
    const { player, decoders, events, STATE } = webCodecsPlayer(t);
    for (let i = 0; i < 4; i++) {
        decoders.at(-1).fail();
        t.mock.timers.tick(100);
        player.pushFrame(packet(IDR));
    }
    assert.deepEqual(events, ['recovering', 'recovering', 'recovering', 'stopped']);
    assert.notEqual(player.getState(), STATE.STOPPED, 'the fourth error used to stop the player for good');
    const created = decoders.length;
    const decoded = decoders.reduce((sum, decoder) => sum + decoder.chunks.length, 0);
    player.pushFrame(packet(IDR));
    player.pushFrame(packet(DELTA));
    assert.equal(decoders.length, created);
    assert.equal(decoders.reduce((sum, decoder) => sum + decoder.chunks.length, 0), decoded, 'nothing is decoded while paused');

    t.mock.timers.tick(5000);
    assert.equal(decoders.length, created + 1, 'a fresh decoder is tried after the pause');
    assert.equal(decoders.at(-1).state, 'configured');
    assert.equal(events.at(-1), 'keyframe-request');
    player.pushFrame(packet(IDR));
    player.pushFrame(packet(DELTA));
    assert.equal(decoders.at(-1).chunks.length, 2, 'and the picture comes back');
});

test('a new SPS mid-stream still reconfigures the decoder and replaces the cached one', (t) => {
    const { player, decoders } = webCodecsPlayer(t);
    // The same parameter sets with another level byte stand in for a rotated stream.
    const rotated = Buffer.from(CONFIG);
    rotated[7] = 0x0b;
    player.pushFrame(packet(rotated));
    assert.equal(decoders[0].configs.at(-1).codec, 'avc1.42C00B');
    player.pushFrame(packet(DELTA));
    assert.equal(decoders[0].chunks.length, 2, 'a picture of the old session is not decoded with the new SPS');
    decoders[0].fail();
    assert.equal(decoders[1].configs[0].codec, 'avc1.42C00B', 'recovery uses the latest SPS');
    player.pushFrame(packet(IDR));
    assert.deepEqual(Buffer.from(decoders[1].chunks[0].data), Buffer.concat([rotated, IDR]));
});

test('the H264 Converter player reports a media error and starts again at the next SPS', (t) => {
    const { MsePlayer } = require('../src/app/player/MsePlayer');
    const { BasePlayer } = require('../src/app/player/BasePlayer');
    const tag = element({ buffered: { length: 0 }, currentTime: 0 });
    const player = new MsePlayer('android-mse-error', undefined, 'H264 Converter', tag);
    t.after(() => player.stop());
    const appended = [];
    // Stands in for h264-converter, which needs a MediaSource.
    const converters = [];
    t.mock.method(MsePlayer, 'createConverter', () => {
        converters.push({ play() {}, pause() {}, appendRawData: (data) => appended.push(Buffer.from(data)) });
        return converters.at(-1);
    });
    const events = [];
    player.on('decoder-error', (event) => events.push(event.recovering ? 'recovering' : 'stopped'));
    player.on('keyframe-request', () => events.push('keyframe-request'));
    player.setScreenInfo(screen(32, 32));
    player.play();
    player.pushFrame(packet(CONFIG));
    assert.equal(appended.length, 2, 'the packet and its delimiter');

    tag.listeners.get('error')({ type: 'error' });
    assert.deepEqual(events, [], 'an error event without a media error is ignored');
    tag.error = { code: 3, message: 'PIPELINE_ERROR_DECODE' };
    tag.listeners.get('error')({ type: 'error' });
    assert.deepEqual(events, ['stopped', 'keyframe-request']);
    assert.equal(player.getState(), BasePlayer.STATE.PAUSED, 'the next frame builds a new MediaSource');

    // What StreamClientScrcpy.onVideo does with the next frames.
    player.play();
    assert.equal(converters.length, 2);
    appended.length = 0;
    player.pushFrame(packet(DELTA));
    player.pushFrame(packet(IDR));
    assert.equal(appended.length, 0, 'nothing is appended before parameter sets');
    player.pushFrame(packet(CONFIG));
    player.pushFrame(packet(IDR));
    assert.deepEqual(appended.filter((data) => data.length > 6), [CONFIG, IDR]);
});

function androidClient(t, player) {
    const { EventEmitter } = require('node:events');
    const { StreamClientScrcpy } = require('../src/app/googDevice/client/StreamClientScrcpy');
    const { GoogToolBox } = require('../src/app/googDevice/toolbox/GoogToolBox');
    const toolbox = { getHolderElement: () => element(), release() {}, releaseHeldButtons() {} };
    t.mock.method(GoogToolBox, 'createToolBox', () => toolbox);
    t.mock.method(StreamClientScrcpy.prototype, 'setTouchListeners', () => {});
    const sent = [];
    const receiver = Object.assign(new EventEmitter(), {
        isReady: () => true,
        stop() {},
        sendEvent: (message) => sent.push(Buffer.from(message.toBuffer())),
        getDisplayInfo: () => undefined,
    });
    const params = { action: 'stream', udid: 'android-client', player: 'fixture', ws: 'ws://localhost:8000/', captureKeyboard: false };
    const client = StreamClientScrcpy.start(params, receiver, player, undefined, undefined, element());
    t.after(() => client.stop());
    return { client, receiver, sent, toolbox };
}

function fakePlayer() {
    const { EventEmitter } = require('node:events');
    const VideoSettings = require('../src/app/VideoSettings').default;
    const { BasePlayer } = require('../src/app/player/BasePlayer');
    const settings = new VideoSettings({ bounds: new Size(720, 1280), bitrate: 4000000, maxFps: 60 });
    return Object.assign(new EventEmitter(), {
        state: BasePlayer.STATE.PAUSED,
        screenInfo: undefined,
        frames: [],
        getName: () => 'Fixture',
        getState() {
            return this.state;
        },
        play() {
            this.state = BasePlayer.STATE.PLAYING;
        },
        pause() {
            this.state = BasePlayer.STATE.PAUSED;
        },
        stop() {
            this.state = BasePlayer.STATE.STOPPED;
        },
        pushFrame(frame) {
            this.frames.push(frame);
        },
        getVideoSettings: () => settings,
        setVideoSettings() {},
        getScreenInfo() {
            return this.screenInfo;
        },
        setScreenInfo(info) {
            this.screenInfo = info;
        },
        setDisplayInfo() {},
        getTouchableElement: () => element(),
        setParent() {},
    });
}

test('the Android client restarts the encoder for a stuck decoder, a few times at most, and says when decoding stopped', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 4_000_000 });
    const { streamNotice } = require('../src/app/state/stream');
    streamNotice.value = '';
    const player = fakePlayer();
    const { client, sent } = androidClient(t, player);

    player.emit('decoder-error', { message: 'lost', recovering: true });
    assert.equal(streamNotice.value, '', 'a failure the player recovers from is not announced');
    player.emit('keyframe-request');
    assert.deepEqual(sent, [Buffer.from([17])], 'RESET_VIDEO, one byte');
    for (let i = 0; i < 5; i++) {
        t.mock.timers.tick(10_000);
        player.emit('keyframe-request');
    }
    assert.equal(sent.length, 3, 'the other viewers are not interrupted without limit');
    t.mock.timers.tick(5 * 60_000);
    player.emit('keyframe-request');
    assert.equal(sent.length, 4, 'a later failure can ask again');

    player.emit('decoder-error', { message: 'lost', recovering: false });
    assert.match(streamNotice.value, /video decoder in this browser stopped/);
    streamNotice.value = '';

    client.stop();
    player.emit('keyframe-request');
    player.emit('decoder-error', { message: 'late', recovering: false });
    assert.equal(sent.length, 4, 'a stopped client no longer listens to its player');
    assert.equal(streamNotice.value, '');
});

test('the iPhone client asks for a key frame when its decoder reports an error', (t) => {
    const { StreamClientCoreDevice } = require('../src/app/applDevice/client/StreamClientCoreDevice');
    const { CoreDeviceReceiver } = require('../src/app/applDevice/client/CoreDeviceReceiver');
    const { ApplToolBox } = require('../src/app/applDevice/toolbox/ApplToolBox');
    t.mock.method(CoreDeviceReceiver.prototype, 'openNewConnection', () => undefined);
    t.mock.method(ApplToolBox, 'createToolBox', () => ({ getHolderElement: () => element(), release() {}, releaseHeldButtons() {} }));
    const sent = [];
    t.mock.method(CoreDeviceReceiver.prototype, 'send', (message) => sent.push(message));
    MockDecoder.instances.length = 0;
    const client = StreamClientCoreDevice.start({ action: 'stream-coredevice', udid: 'iphone-decoder', captureKeyboard: false }, element());
    t.after(() => client.stop());
    client.attachPlayer('hevc');
    client.getPlayer().configure('hev1', new Uint8Array([1]));
    MockDecoder.instances[0].fail();
    assert.deepEqual(sent, [{ type: 'pli' }]);
});
