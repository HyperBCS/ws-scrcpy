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

// Window and document take several listeners per event; `dispatch` calls them like the browser.
const windowListeners = new Map();
const documentListeners = new Map();
const bodyListeners = new Map();
const listenerApi = (map) => ({
    addEventListener(name, fn) {
        if (!map.has(name)) map.set(name, new Set());
        map.get(name).add(fn);
    },
    removeEventListener(name, fn) {
        map.get(name)?.delete(fn);
    },
});
const dispatch = (map, name, event = {}) => [...(map.get(name) ?? [])].forEach((fn) => fn({ type: name, ...event }));
// Every element made through document.createElement, so a test can find a button by its title.
const created = [];
// What `document.querySelector` finds for an open bottom sheet; a test sets it to open one.
let openSheet = null;
global.Element = class Element {};
global.VideoDecoder = MockDecoder;
global.EncodedVideoChunk = MockChunk;
global.requestAnimationFrame = () => 1;
global.cancelAnimationFrame = () => {};
global.document = {
    ...listenerApi(documentListeners),
    visibilityState: 'visible',
    hidden: false,
    createElement: () => {
        created.push(element());
        return created.at(-1);
    },
    querySelector: (selector) => (selector.includes('dialog.kit-sheet[open]') ? openSheet : element()),
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
/** A 2D context that takes the drawing of a pinch on the touch layer. */
const drawing = () => ({ drawImage() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, arc() {}, stroke() {}, moveTo() {}, lineTo() {} });

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
        getContext: drawing,
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
    // Horizontal is not mirrored: AXIS_HSCROLL is positive to the right, like deltaX.
    const [sideways] = wheel({ deltaX: 50 });
    assert.deepEqual([sideways.hScroll, sideways.vScroll], [0.5, 0], 'half a notch to the right');
    t.mock.timers.tick(500);
    const [left] = wheel({ deltaX: -3, deltaMode: 1 });
    assert.equal(left.hScroll, -1, 'one notch to the left');

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
    // The players log every decoder error; these tests cause them on purpose.
    t.mock.method(console, 'error', () => {});
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

test('a decoder error followed by a lost connection neither restarts the encoder nor blames the decoder', (t) => {
    const { player, decoders, events } = webCodecsPlayer(t);
    decoders[0].fail();
    // StreamClientScrcpy.onDisconnected pauses the player.
    player.pause();
    t.mock.timers.tick(10_000);
    assert.deepEqual(events, ['recovering'], 'no request that cannot be delivered, and no decoder notice');

    // The next connection starts with the parameter sets and a keyframe.
    player.play();
    player.pushFrame(packet(CONFIG));
    player.pushFrame(packet(IDR));
    assert.equal(decoders.at(-1).chunks.length, 1);
    t.mock.timers.tick(10_000);
    assert.deepEqual(events, ['recovering']);
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

    // RESET_VIDEO after a reset: the encoder's new parameter sets replace the cached copy.
    decoders[1].fail();
    player.pushFrame(packet(CONFIG));
    player.pushFrame(packet(IDR));
    assert.equal(decoders[2].configs.at(-1).codec, 'avc1.42C00A');
    assert.deepEqual(
        Buffer.from(decoders[2].chunks[0].data),
        Buffer.concat([CONFIG, IDR]),
        'one set of parameter sets in front of the keyframe, not the old and the new',
    );
});

test('the H264 Converter player reports a media error and starts again at the next SPS', (t) => {
    const { MsePlayer } = require('../src/app/player/MsePlayer');
    const { BasePlayer } = require('../src/app/player/BasePlayer');
    t.mock.method(console, 'error', () => {});
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
    t.mock.method(StreamClientScrcpy.prototype, 'setTouchListeners', () => {});
    const sent = [];
    const receiver = Object.assign(new EventEmitter(), {
        isReady: () => true,
        stop() {},
        sendEvent: (message) => sent.push(Buffer.from(message.toBuffer())),
        getDisplayInfo: () => undefined,
    });
    const params = { action: 'stream', udid: 'android-client', player: 'fixture', ws: 'ws://localhost:8000/', captureKeyboard: false };
    const client = StreamClientScrcpy.start(params, receiver, player, undefined, element());
    t.after(() => client.stop());
    return { client, receiver, sent };
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
    t.mock.method(CoreDeviceReceiver.prototype, 'openNewConnection', () => undefined);
    const sent = [];
    t.mock.method(CoreDeviceReceiver.prototype, 'send', (message) => sent.push(message));
    t.mock.method(console, 'error', () => {});
    MockDecoder.instances.length = 0;
    const client = StreamClientCoreDevice.start({ action: 'stream-coredevice', udid: 'iphone-decoder', captureKeyboard: false }, element());
    t.after(() => client.stop());
    client.attachPlayer('hevc');
    client.getPlayer().configure('hev1', new Uint8Array([1]));
    MockDecoder.instances[0].fail();
    assert.deepEqual(sent, [{ type: 'pli' }]);
});

// ---------------------------------------------------------------- picture size and fitting

test('a second scrcpy_initial after a rotation gives the player the new picture size', (t) => {
    const { DisplayInfo } = require('../src/app/DisplayInfo');
    const VideoSettings = require('../src/app/VideoSettings').default;
    const player = fakePlayer();
    const sizes = [];
    player.setScreenInfo = function (info) {
        this.screenInfo = info;
        sizes.push([info.videoSize.width, info.videoSize.height]);
    };
    const { client, receiver } = androidClient(t, player);
    const initial = (width, height, connectionCount) => [
        {
            displayInfo: new DisplayInfo(0, new Size(width, height), 0, 0, 0),
            screenInfo: screen(width, height),
            videoSettings: new VideoSettings({ bounds: new Size(width, height), bitrate: 7340032, maxFps: 60 }),
            connectionCount,
        },
    ];
    receiver.emit('displayInfo', initial(720, 1280, 0));
    assert.deepEqual(sizes, [[720, 1280]]);
    receiver.emit('displayInfo', initial(720, 1280, 1));
    assert.deepEqual(sizes, [[720, 1280]], 'the same size again does not reset the player');
    assert.equal(client.getClientsCount(), 1);
    receiver.emit('displayInfo', initial(1280, 720, 1));
    assert.deepEqual(sizes, [[720, 1280], [1280, 720]], 'touch mapping and the canvas follow the rotation');
});

test('the Android client has no fit-to-screen mode and stores nothing per window size', (t) => {
    const { StreamClientScrcpy } = require('../src/app/googDevice/client/StreamClientScrcpy');
    const { BasePlayer } = require('../src/app/player/BasePlayer');
    const query = new URLSearchParams({
        action: 'stream',
        udid: 'emulator-5554',
        player: 'webcodecs',
        ws: 'ws://localhost:8000/?action=proxy-adb',
        fitToScreen: '1',
    });
    const parsed = StreamClientScrcpy.parseParameters(query);
    assert.equal('fitToScreen' in parsed, false, 'an old link still opens; its fitToScreen parameter is ignored');
    assert.equal(parsed.captureKeyboard, true);

    // What earlier versions left behind, next to keys that belong to other features.
    const stored = new Map([
        ['MseDecoder:emulator-5554:1280x800', '{}'],
        ['MseDecoder:emulator-5554:1280x800:fit', 'true'],
        ['WebCodecsPlayer:emulator-5554:390x844:0:1080x2400', '{}'],
        ['WebCodecsPlayer:emulator-5554:390x844:0:1080x2400:fit', 'false'],
        ['WebCodecsPlayer:192.168.1.20:5555:1440x900:fit', 'true'],
        ['theme', 'dark'],
        ['ios-passcode:00008110', 'kept'],
    ]);
    const writes = [];
    const storage = {
        get length() {
            return stored.size;
        },
        key: (index) => [...stored.keys()][index] ?? null,
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key) => writes.push(key),
        removeItem: (key) => stored.delete(key),
    };
    const previous = global.localStorage;
    global.localStorage = storage;
    t.after(() => (global.localStorage = previous));
    BasePlayer.storedSettingsRemoved = false;

    const player = fakePlayer();
    const { client } = androidClient(t, player);
    assert.deepEqual([...stored.keys()], ['theme', 'ios-passcode:00008110'], 'stale keys are removed, others kept');
    assert.equal(typeof client.setFitToScreen, 'undefined');
    assert.equal(typeof client.isFitToScreen, 'undefined');

    const { WebCodecsPlayer } = require('../src/app/player/WebCodecsPlayer');
    const { MsePlayer } = require('../src/app/player/MsePlayer');
    const VideoSettings = require('../src/app/VideoSettings').default;
    for (const real of [new WebCodecsPlayer('emulator-5554'), new MsePlayer('emulator-5554')]) {
        real.setVideoSettings(new VideoSettings({ bounds: new Size(1080, 2400), bitrate: 7340032, maxFps: 60 }));
        real.stop();
    }
    assert.deepEqual(writes, [], 'no player writes video settings to storage');
    assert.deepEqual([...stored.keys()], ['theme', 'ios-passcode:00008110']);
});

// ---------------------------------------------------------------- swipes from beside the picture

// A browser keeps a touch's target for its whole life: the element it started on.
const touches = (type, target, ...points) =>
    new TouchEvent(type, {
        target,
        changedTouches: points.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY, target, force: 1 })),
    });
const ACTION = { DOWN: 0, UP: 1, MOVE: 2 };
const summary = (messages) => messages.map((m) => [m.action, m.position.point.x, m.position.point.y]);

test('Android: a swipe that starts beside the picture goes down on the nearest edge when it reaches the picture', (t) => {
    // The 360x640 picture sits at x 30..390 in a 420 px wide stream area; the video is 720x1280.
    const { handler, wrapper, canvas, sent } = androidHandler(t);

    // Back gesture: the finger lands on the 30 px band left of the picture and slides in.
    const start = touches('touchstart', wrapper, [1, 10, 300]);
    handler.onInteraction(start);
    assert.equal(start.defaultPrevented, true, 'the browser does not scroll or navigate instead');
    assert.deepEqual(sent, [], 'nothing is sent while the finger is beside the picture');
    handler.onInteraction(touches('touchmove', wrapper, [1, 25, 305]));
    assert.deepEqual(sent, []);
    handler.onInteraction(touches('touchmove', wrapper, [1, 60, 310]));
    assert.deepEqual(
        summary(sent),
        [
            [ACTION.DOWN, 0, 600],
            [ACTION.MOVE, 60, 620],
        ],
        'down on the left edge at the height it started, then the move',
    );
    handler.onInteraction(touches('touchmove', wrapper, [1, 130, 310]));
    handler.onInteraction(touches('touchend', wrapper, [1, 130, 310]));
    assert.deepEqual(summary(sent.slice(2)), [
        [ACTION.MOVE, 200, 620],
        [ACTION.UP, 200, 620],
    ]);
    assert.equal(sent.at(-1).pressure, 0);

    // A tap on the band is not a tap on the device.
    sent.length = 0;
    handler.onInteraction(touches('touchstart', wrapper, [2, 400, 300]));
    handler.onInteraction(touches('touchend', wrapper, [2, 400, 300]));
    assert.deepEqual(sent, []);

    // Home gesture from below the picture (a landscape layout leaves the band there).
    handler.onInteraction(touches('touchstart', wrapper, [3, 200, 660]));
    handler.onInteraction(touches('touchmove', wrapper, [3, 200, 600]));
    assert.deepEqual(summary(sent), [
        [ACTION.DOWN, 340, 1279],
        [ACTION.MOVE, 340, 1200],
    ]);
    handler.onInteraction(touches('touchend', wrapper, [3, 200, 500]));

    // A touch on the picture is unchanged, and sliding off it rides the edge instead of lifting.
    sent.length = 0;
    handler.onInteraction(touches('touchstart', canvas, [4, 380, 100]));
    handler.onInteraction(touches('touchmove', canvas, [4, 410, 100]));
    handler.onInteraction(touches('touchend', canvas, [4, 410, 100]));
    assert.deepEqual(summary(sent), [
        [ACTION.DOWN, 700, 200],
        [ACTION.MOVE, 719, 200],
        [ACTION.UP, 719, 200],
    ]);

    // Anything else on the page is not the remote screen.
    sent.length = 0;
    const toolbar = element();
    const elsewhere = touches('touchstart', toolbar, [5, 100, 100]);
    handler.onInteraction(elsewhere);
    handler.onInteraction(touches('touchmove', toolbar, [5, 120, 120]));
    assert.deepEqual(sent, []);
    assert.notEqual(elsewhere.defaultPrevented, true, 'other controls keep their own touch handling');
});

test('iPhone: a swipe from beside the picture starts on the edge, and a tap there sends nothing', (t) => {
    const { CoreDeviceInteractionHandler } = require('../src/app/applDevice/CoreDeviceInteractionHandler');
    const wrapper = element({ clientWidth: 384, clientHeight: 764 });
    // A 324x704 picture with a 30 px band on every side; the video is 1296x2816.
    const canvas = element({
        clientWidth: 324,
        clientHeight: 704,
        getBoundingClientRect: () => ({ left: 30, top: 30, width: 324, height: 704 }),
    });
    wrapper.appendChild(canvas);
    const frames = [];
    t.mock.method(global, 'requestAnimationFrame', (fn) => frames.push(fn));
    t.mock.method(global, 'cancelAnimationFrame', () => frames.splice(0));
    const flush = () => frames.splice(0).forEach((fn) => fn());
    const sent = [];
    const handler = new CoreDeviceInteractionHandler(
        { getTouchableElement: () => canvas, getScreenInfo: () => screen(1296, 2816) },
        { sendContacts: (contacts) => sent.push(contacts.map((c) => [c.id, c.touching, c.x, c.y])), sendTouch() {} },
    );
    t.after(() => handler.release());

    // Home gesture: the finger lands below the picture and slides up onto it.
    handler.onInteraction(touches('touchstart', wrapper, [1, 192, 750]));
    assert.deepEqual(sent, []);
    handler.onInteraction(touches('touchmove', wrapper, [1, 192, 740]));
    flush();
    assert.deepEqual(sent, [], 'still below the picture');
    handler.onInteraction(touches('touchmove', wrapper, [1, 192, 634]));
    assert.deepEqual(sent, [[[0, true, 648, 2816]]], 'the finger goes down on the bottom edge first');
    flush();
    assert.deepEqual(sent.at(-1), [[0, true, 648, 2416]], 'then moves to where it is');
    handler.onInteraction(touches('touchend', wrapper, [1, 192, 500]));
    assert.deepEqual(sent.at(-1), [[0, false, 648, 1880]]);

    sent.length = 0;
    handler.onInteraction(touches('touchstart', wrapper, [2, 10, 300]));
    handler.onInteraction(touches('touchend', wrapper, [2, 10, 300]));
    flush();
    assert.deepEqual(sent, [], 'a tap on the band is not a tap on the phone');

    handler.onInteraction(touches('touchstart', canvas, [3, 192, 382]));
    assert.deepEqual(sent, [[[0, true, 648, 1408]]], 'a touch on the picture goes down at once');
    handler.onInteraction(touches('touchend', canvas, [3, 192, 382]));

    sent.length = 0;
    handler.onInteraction(touches('touchstart', element(), [4, 192, 382]));
    assert.deepEqual(sent, [], 'a touch on another control is not passed on');
});

// ---------------------------------------------------------------- one mouse contract

/** A mouse event to what listens on window, as the browser sends the moves and the up of a drag. */
const windowMouse = (type, init = {}) => {
    const event = new MouseEvent(type, { target: element(), ...init });
    [...(windowListeners.get(type) ?? [])].forEach((fn) => fn(event));
    return event;
};
const blurWindow = () => dispatch(windowListeners, 'blur');
// A swipe sets each timer from the one before; a mocked tick runs only those already set when it
// began, so time is passed a millisecond at a time.
const elapse = (t, ms) => {
    for (let i = 0; i < ms; i++) t.mock.timers.tick(1);
};
/** Android touches as [action, pointer, x, y]; other messages as their type. */
const pointers = (messages) =>
    messages.map((m) => (m.type === 2 ? [m.action, m.pointerId, m.position.point.x, m.position.point.y] : m.type));

/** An iPhone handler: a 324x704 picture at (30, 30) in a 384x764 area; the video is 1296x2816. */
function iphoneHandler(t) {
    const { CoreDeviceInteractionHandler } = require('../src/app/applDevice/CoreDeviceInteractionHandler');
    const wrapper = element({ clientWidth: 384, clientHeight: 764 });
    const canvas = element({
        clientWidth: 324,
        clientHeight: 704,
        getContext: drawing,
        getBoundingClientRect: () => ({ left: 30, top: 30, width: 324, height: 704 }),
    });
    wrapper.appendChild(canvas);
    const frames = [];
    t.mock.method(global, 'requestAnimationFrame', (fn) => frames.push(fn));
    t.mock.method(global, 'cancelAnimationFrame', () => frames.splice(0));
    const sent = [];
    const handler = new CoreDeviceInteractionHandler(
        { getTouchableElement: () => canvas, getScreenInfo: () => screen(1296, 2816) },
        {
            sendTouch: (op, x, y) => sent.push([op, x, y]),
            sendContacts: (contacts) => sent.push(['frame', ...contacts.map((c) => [c.id, c.touching, c.x, c.y])]),
        },
    );
    t.after(() => handler.release());
    return { handler, canvas, sent, flush: () => frames.splice(0).forEach((fn) => fn()) };
}

test('a drag that leaves the picture keeps going along its edge and ends with one up, on both', (t) => {
    // Android: the 360x640 picture is at x 30..390; the video is 720x1280.
    const android = androidHandler(t);
    android.handler.onInteraction(new MouseEvent('mousedown', { target: android.canvas, clientX: 210, clientY: 320, buttons: 1 }));
    android.canvas.listeners.get('mouseleave')();
    assert.deepEqual(pointers(android.sent), [[ACTION.DOWN, 0, 360, 640]], 'leaving the picture does not lift the finger');
    windowMouse('mousemove', { clientX: 600, clientY: 320, buttons: 1 });
    windowMouse('mousemove', { clientX: 700, clientY: 900, buttons: 1 });
    windowMouse('mouseup', { clientX: 650, clientY: 950, button: 2 });
    assert.equal(android.sent.length, 3, 'another button coming up does not end the drag');
    windowMouse('mouseup', { clientX: 650, clientY: 950 });
    assert.deepEqual(pointers(android.sent.slice(1)), [
        [ACTION.MOVE, 0, 719, 640],
        [ACTION.MOVE, 0, 719, 1279],
        [ACTION.UP, 0, 719, 1279],
    ], 'the finger rides the edge and lifts where the button came up');
    windowMouse('mousemove', { clientX: 300, clientY: 300 });
    android.handler.onInteraction(new MouseEvent('mousemove', { target: android.canvas, clientX: 210, clientY: 320 }));
    assert.equal(android.sent.length, 4, 'a plain move after the release sends nothing');

    // iPhone: the 324x704 picture is at (30, 30); the video is 1296x2816.
    const iphone = iphoneHandler(t);
    iphone.handler.onInteraction(new MouseEvent('mousedown', { target: iphone.canvas, clientX: 192, clientY: 382, buttons: 1 }));
    iphone.flush();
    windowMouse('mousemove', { clientX: 900, clientY: 382, buttons: 1 });
    iphone.flush();
    windowMouse('mouseup', { clientX: 900, clientY: 900 });
    assert.deepEqual(iphone.sent, [
        ['contact', 648, 1408],
        ['contact', 1296, 1408],
        ['release', 1296, 2816],
    ]);
});

test('the wheel scrolls Android and makes one short swipe on an iPhone, at a bounded rate', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const android = androidHandler(t);
    android.handler.onInteraction(new WheelEvent('wheel', { target: android.canvas, clientX: 210, clientY: 320, deltaY: 100 }));
    assert.deepEqual(android.sent.map((m) => [m.type, m.vScroll]), [[3, -1]], 'Android: one scroll message, no touch');

    const { handler, canvas, sent } = iphoneHandler(t);
    const wheel = (clientY, deltaY, deltaX = 0) => {
        const event = new WheelEvent('wheel', { target: canvas, clientX: 192, clientY, deltaX, deltaY });
        handler.onInteraction(event);
        return event;
    };
    // Scrolling down: the finger goes down at the pointer and moves up a fifth of the screen.
    assert.equal(wheel(382, 100).defaultPrevented, true);
    assert.deepEqual(sent, [['contact', 648, 1408]]);
    elapse(t, 100);
    assert.deepEqual(sent.slice(1), [
        ['contact', 648, 1295],
        ['contact', 648, 1183],
        ['contact', 648, 1070],
        ['contact', 648, 958],
        ['contact', 648, 845],
    ]);
    elapse(t, 99);
    assert.equal(sent.length, 6, 'the finger rests at the end before it lifts');
    elapse(t, 1);
    assert.deepEqual(sent.at(-1), ['release', 648, 845]);
    wheel(382, 100);
    assert.equal(sent.length, 7, 'a wheel right after a swipe does not start another');

    // 200 wheel events in two seconds start five swipes, one every 400 ms, and each lifts once.
    sent.length = 0;
    for (let i = 0; i < 200; i++) {
        wheel(382, 100);
        elapse(t, 10);
    }
    elapse(t, 1000);
    assert.equal(sent.filter(([op]) => op === 'release').length, 5);
    assert.equal(sent.length, 35, 'a down, five moves and an up each');

    // Up and sideways, and never from the edge: at the bottom of the picture a swipe up starts
    // a tenth of the screen above it, so it is not the Home gesture.
    sent.length = 0;
    wheel(382, -100);
    elapse(t, 1000);
    assert.deepEqual([sent[0], sent.at(-1)], [['contact', 648, 1408], ['release', 648, 1971]], 'scrolling up moves the finger down');
    sent.length = 0;
    wheel(382, 0, 100);
    elapse(t, 1000);
    assert.deepEqual([sent[0], sent.at(-1)], [['contact', 648, 1408], ['release', 389, 1408]], 'scrolling right moves it left');
    sent.length = 0;
    wheel(734, 100);
    elapse(t, 1000);
    assert.deepEqual([sent[0], sent.at(-1)], [['contact', 648, 2534], ['release', 648, 1971]]);
});

test('right-click is Back on Android and sends no touch; on an iPhone it sends nothing', (t) => {
    const android = androidHandler(t);
    const press = new MouseEvent('mousedown', { target: android.canvas, clientX: 210, clientY: 320, button: 2, buttons: 2 });
    android.handler.onInteraction(press);
    android.handler.onInteraction(new MouseEvent('mousemove', { target: android.canvas, clientX: 220, clientY: 320, buttons: 2 }));
    windowMouse('mouseup', { clientX: 220, clientY: 320, button: 2 });
    assert.deepEqual(
        android.sent.map((m) => [m.type, m.action, m.keycode]),
        [
            [0, 0, 4],
            [0, 1, 4],
        ],
        'KEYCODE_BACK down and up, as the Back control sends it',
    );
    assert.equal(press.defaultPrevented, true);

    const iphone = iphoneHandler(t);
    iphone.handler.onInteraction(new MouseEvent('mousedown', { target: iphone.canvas, clientX: 192, clientY: 382, button: 2, buttons: 2 }));
    iphone.flush();
    windowMouse('mouseup', { clientX: 192, clientY: 382, button: 2 });
    assert.deepEqual(iphone.sent, [], 'an iPhone has no Back');
});

test('Ctrl+drag pinches on both: a second finger mirrored through the middle of the picture', (t) => {
    const android = androidHandler(t);
    android.handler.onInteraction(new MouseEvent('mousedown', { target: android.canvas, clientX: 120, clientY: 160, buttons: 1, ctrlKey: true }));
    windowMouse('mousemove', { clientX: 300, clientY: 480, buttons: 1, ctrlKey: true });
    windowMouse('mouseup', { clientX: 300, clientY: 480, ctrlKey: true });
    assert.deepEqual(pointers(android.sent), [
        [ACTION.DOWN, 0, 180, 320],
        [ACTION.DOWN, 1, 540, 960],
        [ACTION.MOVE, 0, 540, 960],
        [ACTION.MOVE, 1, 180, 320],
        [ACTION.UP, 0, 540, 960],
        [ACTION.UP, 1, 180, 320],
    ], 'in video pixels, around 360x640');
    // With Shift too, around the point pressed.
    android.sent.length = 0;
    android.handler.onInteraction(new MouseEvent('mousedown', { target: android.canvas, clientX: 210, clientY: 320, buttons: 1, ctrlKey: true, shiftKey: true }));
    windowMouse('mousemove', { clientX: 255, clientY: 320, buttons: 1, ctrlKey: true, shiftKey: true });
    windowMouse('mouseup', { clientX: 255, clientY: 320, ctrlKey: true, shiftKey: true });
    assert.deepEqual(pointers(android.sent).slice(2, 4), [
        [ACTION.MOVE, 0, 450, 640],
        [ACTION.MOVE, 1, 270, 640],
    ]);

    const iphone = iphoneHandler(t);
    iphone.handler.onInteraction(new MouseEvent('mousedown', { target: iphone.canvas, clientX: 111, clientY: 206, buttons: 1, ctrlKey: true }));
    windowMouse('mousemove', { clientX: 273, clientY: 558, buttons: 1, ctrlKey: true });
    iphone.flush();
    windowMouse('mouseup', { clientX: 273, clientY: 558, ctrlKey: true });
    iphone.flush();
    assert.deepEqual(iphone.sent, [
        ['frame', [0, true, 324, 704], [1, true, 972, 2112]],
        ['frame', [0, true, 972, 2112], [1, true, 324, 704]],
        ['frame', [0, false, 972, 2112], [1, false, 324, 704]],
    ], 'two contacts in each frame, around 648x1408, and both lift together');
});

test('Shift+Ctrl+drag pinches around the point pressed on both, wherever the pointer was before', (t) => {
    const keys = { ctrlKey: true, shiftKey: true };
    const android = androidHandler(t);
    // The keys are held while the pointer hovers elsewhere first; the press sets the centre.
    android.handler.onInteraction(new MouseEvent('mousemove', { target: android.canvas, clientX: 120, clientY: 160, ...keys }));
    android.handler.onInteraction(new MouseEvent('mousemove', { target: android.canvas, clientX: 210, clientY: 320, ...keys }));
    android.handler.onInteraction(new MouseEvent('mousedown', { target: android.canvas, clientX: 210, clientY: 320, buttons: 1, ...keys }));
    windowMouse('mousemove', { clientX: 255, clientY: 320, buttons: 1, ...keys });
    windowMouse('mouseup', { clientX: 255, clientY: 320, ...keys });
    assert.deepEqual(pointers(android.sent), [
        [ACTION.DOWN, 0, 360, 640],
        [ACTION.DOWN, 1, 360, 640],
        [ACTION.MOVE, 0, 450, 640],
        [ACTION.MOVE, 1, 270, 640],
        [ACTION.UP, 0, 450, 640],
        [ACTION.UP, 1, 270, 640],
    ], 'around 360x640, where the button went down');
    // The keys are still held: the next pinch is around its own press, not the last one's.
    android.sent.length = 0;
    android.handler.onInteraction(new MouseEvent('mousedown', { target: android.canvas, clientX: 120, clientY: 160, buttons: 1, ...keys }));
    assert.deepEqual(pointers(android.sent), [
        [ACTION.DOWN, 0, 180, 320],
        [ACTION.DOWN, 1, 180, 320],
    ]);
    windowMouse('mouseup', { clientX: 120, clientY: 160, ...keys });

    const iphone = iphoneHandler(t);
    iphone.handler.onInteraction(new MouseEvent('mousedown', { target: iphone.canvas, clientX: 192, clientY: 382, buttons: 1, ...keys }));
    windowMouse('mousemove', { clientX: 273, clientY: 382, buttons: 1, ...keys });
    iphone.flush();
    windowMouse('mouseup', { clientX: 273, clientY: 382, ...keys });
    assert.deepEqual(iphone.sent, [
        ['frame', [0, true, 648, 1408], [1, true, 648, 1408]],
        ['frame', [0, true, 972, 1408], [1, true, 324, 1408]],
        ['frame', [0, false, 972, 1408], [1, false, 324, 1408]],
    ], 'around 648x1408, where the button went down');
});

test('a pointer cancel, a blur, a hidden page and unmount release every touch once, on both', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const android = androidHandler(t);
    const { handler, canvas, sent } = android;
    // Pointer cancel.
    handler.onInteraction(touches('touchstart', canvas, [11, 210, 320]));
    handler.onInteraction(touches('touchcancel', canvas, [11, 210, 320]));
    assert.deepEqual(pointers(sent).map(([action]) => action), [ACTION.DOWN, ACTION.UP]);
    // Blur during a drag: one up, and the button coming up later sends nothing.
    sent.length = 0;
    handler.onInteraction(new MouseEvent('mousedown', { target: canvas, clientX: 210, clientY: 320, buttons: 1 }));
    windowMouse('mousemove', { clientX: 250, clientY: 320, buttons: 1 });
    blurWindow();
    windowMouse('mouseup', { clientX: 250, clientY: 320 });
    blurWindow();
    assert.deepEqual(pointers(sent), [
        [ACTION.DOWN, 0, 360, 640],
        [ACTION.MOVE, 0, 440, 640],
        [ACTION.UP, 0, 440, 640],
    ]);
    // A hidden page during a touch: one up, and the browser's own end of it sends nothing.
    sent.length = 0;
    handler.onInteraction(touches('touchstart', canvas, [12, 210, 320]));
    hidePage();
    hidePage();
    handler.onInteraction(touches('touchend', canvas, [12, 210, 320]));
    assert.deepEqual(pointers(sent).map(([action]) => action), [ACTION.DOWN, ACTION.UP]);
    // Unmount during a pinch: one up for each finger.
    sent.length = 0;
    handler.onInteraction(new MouseEvent('mousedown', { target: canvas, clientX: 120, clientY: 160, buttons: 1, ctrlKey: true }));
    handler.release();
    windowMouse('mouseup', { clientX: 120, clientY: 160 });
    assert.deepEqual(pointers(sent).map(([action, pointer]) => [action, pointer]), [
        [ACTION.DOWN, 0],
        [ACTION.DOWN, 1],
        [ACTION.UP, 0],
        [ACTION.UP, 1],
    ]);

    const iphone = iphoneHandler(t);
    // Pointer cancel.
    iphone.handler.onInteraction(touches('touchstart', iphone.canvas, [21, 192, 382]));
    iphone.handler.onInteraction(touches('touchcancel', iphone.canvas, [21, 192, 382]));
    assert.deepEqual(iphone.sent, [['frame', [0, true, 648, 1408]], ['frame', [0, false, 648, 1408]]]);
    // Blur during a drag: the finger lifts where it is, once, not at a corner.
    iphone.sent.length = 0;
    iphone.handler.onInteraction(new MouseEvent('mousedown', { target: iphone.canvas, clientX: 192, clientY: 382, buttons: 1 }));
    iphone.flush();
    windowMouse('mousemove', { clientX: 273, clientY: 382, buttons: 1 });
    iphone.flush();
    blurWindow();
    windowMouse('mouseup', { clientX: 273, clientY: 382 });
    blurWindow();
    assert.deepEqual(iphone.sent, [['contact', 648, 1408], ['contact', 972, 1408], ['release', 972, 1408]]);
    // A hidden page during a pinch: both fingers lift together, once.
    iphone.sent.length = 0;
    iphone.handler.onInteraction(new MouseEvent('mousedown', { target: iphone.canvas, clientX: 111, clientY: 206, buttons: 1, ctrlKey: true }));
    hidePage();
    hidePage();
    assert.deepEqual(iphone.sent, [
        ['frame', [0, true, 324, 704], [1, true, 972, 2112]],
        ['frame', [0, false, 324, 704], [1, false, 972, 2112]],
    ]);
    // Blur during a wheel swipe: it lifts where it is and goes no further.
    iphone.sent.length = 0;
    iphone.handler.onInteraction(new WheelEvent('wheel', { target: iphone.canvas, clientX: 192, clientY: 382, deltaY: 100 }));
    elapse(t, 40);
    blurWindow();
    elapse(t, 1000);
    assert.deepEqual(iphone.sent.map(([op]) => op), ['contact', 'contact', 'contact', 'release']);
    assert.deepEqual(iphone.sent.at(-1), ['release', 648, 1183]);
    // A press during a swipe ends the swipe first.
    iphone.sent.length = 0;
    iphone.handler.onInteraction(new WheelEvent('wheel', { target: iphone.canvas, clientX: 192, clientY: 382, deltaY: 100 }));
    elapse(t, 20);
    iphone.handler.onInteraction(new MouseEvent('mousedown', { target: iphone.canvas, clientX: 192, clientY: 382, buttons: 1 }));
    iphone.flush();
    assert.deepEqual(iphone.sent, [['contact', 648, 1408], ['contact', 648, 1295], ['release', 648, 1295], ['contact', 648, 1408]]);
    // Unmount during that drag: one release.
    iphone.handler.release();
    elapse(t, 1000);
    assert.deepEqual(iphone.sent.slice(4), [['release', 648, 1408]]);
});

test('both stream clients let go of touches when the stream disconnects, without sending', (t) => {
    const calls = [];
    const { client: android, receiver } = androidClient(t, fakePlayer());
    android.touchHandler = { forgetActiveTouch: () => calls.push('android forgets'), release() {} };
    receiver.emit('disconnected', { code: 1006 });
    // The iPhone's socket is closed by then, so its release sends nothing (`CoreDeviceReceiver.send`).
    const { client: iphone } = iphoneClient(t, 'iphone-touch-drop');
    iphone.touchHandler = { releaseActiveTouch: () => calls.push('iphone releases'), release() {} };
    iphone.receiver.emit('disconnected', { code: 1006 });
    assert.deepEqual(calls, ['android forgets', 'iphone releases']);

    // What forgetting means on Android: nothing is sent, and the drag does not go on.
    const { handler, canvas, sent } = androidHandler(t);
    handler.onInteraction(new MouseEvent('mousedown', { target: canvas, clientX: 210, clientY: 320, buttons: 1 }));
    handler.forgetActiveTouch();
    windowMouse('mousemove', { clientX: 250, clientY: 320, buttons: 1 });
    windowMouse('mouseup', { clientX: 250, clientY: 320 });
    handler.release();
    assert.deepEqual(pointers(sent).map(([action]) => action), [ACTION.DOWN]);
});

test('the mouse table says what each phone does, the handlers do it, and the help row lists it', (t) => {
    const { MOUSE_CONTRACT } = require('../src/app/input/mouseContract');
    const { mouseHelp } = require('../src/app/views/actions/actionRows');
    const pinchFingers = (messages) => new Set(messages.filter((m) => m.type === 2).map((m) => m.pointerId)).size;

    const android = androidHandler(t);
    const press = (init) => android.handler.onInteraction(new MouseEvent('mousedown', { target: android.canvas, clientX: 210, clientY: 320, buttons: 1, ...init }));
    android.handler.onInteraction(new WheelEvent('wheel', { target: android.canvas, clientX: 210, clientY: 320, deltaY: 100 }));
    const wheel = android.sent.splice(0);
    press({ button: 2 });
    const rightClick = android.sent.splice(0);
    press({ ctrlKey: true });
    windowMouse('mouseup', { clientX: 210, clientY: 320, ctrlKey: true });
    const pinch = android.sent.splice(0);
    assert.deepEqual(
        {
            wheel: wheel.every((m) => m.type === 3) ? 'scroll' : 'other',
            rightClick: rightClick.length && rightClick.every((m) => m.keycode === 4) ? 'back' : rightClick.length ? 'other' : 'nothing',
            pinch: pinchFingers(pinch) === 2,
        },
        MOUSE_CONTRACT.android,
    );

    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const iphone = iphoneHandler(t);
    const at = { target: iphone.canvas, clientX: 192, clientY: 382 };
    iphone.handler.onInteraction(new WheelEvent('wheel', { ...at, deltaY: 100 }));
    elapse(t, 1000);
    const swipe = iphone.sent.splice(0);
    iphone.handler.onInteraction(new MouseEvent('mousedown', { ...at, button: 2, buttons: 2 }));
    iphone.flush();
    const nothing = iphone.sent.splice(0);
    iphone.handler.onInteraction(new MouseEvent('mousedown', { ...at, buttons: 1, ctrlKey: true }));
    windowMouse('mouseup', { clientX: 192, clientY: 382, ctrlKey: true });
    const frames = iphone.sent.splice(0);
    assert.deepEqual(
        {
            wheel: swipe[0][0] === 'contact' && swipe.at(-1)[0] === 'release' ? 'swipe' : 'other',
            rightClick: nothing.length ? 'other' : 'nothing',
            pinch: frames.every((frame) => frame[0] === 'frame' && frame.length === 3),
        },
        MOUSE_CONTRACT.ios,
    );

    const drag = 'Drag: swipes, and keeps going past the edge of the picture.';
    const pinchLine = 'Ctrl+drag: pinches around the middle. With Shift too, around where you pressed.';
    assert.deepEqual(mouseHelp(MOUSE_CONTRACT.android), ['Wheel: scrolls.', drag, 'Right-click: Back.', pinchLine]);
    assert.deepEqual(mouseHelp(MOUSE_CONTRACT.ios), [
        'Wheel: scrolls with a short swipe.',
        drag,
        'Right-click: nothing. This phone has no Back button.',
        pinchLine,
    ]);
    assert.match(mouseHelp({ ...MOUSE_CONTRACT.ios, pinch: false })[3], /^Ctrl\+drag: nothing/, 'no pinch is claimed where there is none');
});

// ---------------------------------------------------------------- held keys and buttons

test('iPhone: a key event that lands on a local control releases the keys held on the phone', (t) => {
    const { StreamClientCoreDevice } = require('../src/app/applDevice/client/StreamClientCoreDevice');
    const { CoreDeviceReceiver } = require('../src/app/applDevice/client/CoreDeviceReceiver');
    t.mock.method(CoreDeviceReceiver.prototype, 'openNewConnection', () => undefined);
    const sent = [];
    t.mock.method(CoreDeviceReceiver.prototype, 'send', (message) => sent.push(message));
    t.mock.method(CoreDeviceReceiver.prototype, 'isReady', () => true);
    const client = StreamClientCoreDevice.start({ action: 'stream-coredevice', udid: 'iphone-keys' }, element());
    t.after(() => {
        openSheet = null;
        client.stop();
    });
    const key = (type, code, target) => dispatch(windowListeners, type, { code, target, preventDefault() {} });
    const keyReports = () => sent.filter((message) => message.type === 'key').map((message) => message.usages);
    const screenTarget = element();

    key('keydown', 'ShiftLeft', screenTarget);
    key('keydown', 'KeyA', screenTarget);
    assert.deepEqual(keyReports(), [[0xe1], [0xe1, 0x04]], 'Shift and A are held on the phone');

    // The owner taps Type text with Shift still down: the sheet opens and takes the keyboard.
    openSheet = element();
    key('keyup', 'KeyA', element());
    assert.deepEqual(keyReports().at(-1), [], 'the first local key event lets go of everything');
    const reports = keyReports().length;
    key('keyup', 'ShiftLeft', element());
    key('keydown', 'KeyB', element());
    assert.equal(keyReports().length, reports, 'local typing sends nothing to the phone');

    // Back on the stream, typing is not shifted.
    openSheet = null;
    key('keydown', 'KeyC', screenTarget);
    assert.deepEqual(keyReports().at(-1), [0x06]);
});

/**
 * A control as `ControlButton` draws it: `press(type, init)` calls its handler for that event the
 * way the browser would. The props are on `press.props`. `change` replaces fields of its definition.
 */
function controlOf(controls, id, change = {}) {
    const { ControlButton } = require('../src/app/controls/ControlButton');
    const { shownControls } = require('../src/app/controls/definition');
    const shown = shownControls(controls).find((control) => control.definition.id === id);
    assert.ok(shown, `control ${id}`);
    const { props } = ControlButton({ ...shown, definition: { ...shown.definition, ...change }, held: controls.held, style: {} });
    const target = { setPointerCapture() {} };
    const HANDLERS = { pointerdown: 'onPointerDown', pointerup: 'onPointerUp', pointercancel: 'onPointerCancel', lostpointercapture: 'onLostPointerCapture', click: 'onClick' };
    const press = (type, init = {}) => props[HANDLERS[type]]?.({ type, button: 0, pointerId: 1, detail: 1, preventDefault() {}, currentTarget: target, ...init });
    press.props = props;
    return press;
}

function iphoneClient(t, udid) {
    const { StreamClientCoreDevice } = require('../src/app/applDevice/client/StreamClientCoreDevice');
    const { CoreDeviceReceiver } = require('../src/app/applDevice/client/CoreDeviceReceiver');
    t.mock.method(CoreDeviceReceiver.prototype, 'openNewConnection', () => undefined);
    const sent = [];
    t.mock.method(CoreDeviceReceiver.prototype, 'send', (message) => sent.push(message));
    const client = StreamClientCoreDevice.start({ action: 'stream-coredevice', udid, captureKeyboard: false }, element());
    t.after(() => client.stop());
    return { client, sent };
}

const hidePage = () => {
    document.visibilityState = 'hidden';
    dispatch(documentListeners, 'visibilitychange');
    document.visibilityState = 'visible';
};

test('Android controls: every key goes through the one helper, a tap is a down and an up, and a hold ends once', (t) => {
    const { client, receiver, sent } = androidClient(t, fakePlayer());
    const keys = () => sent.filter((packet) => packet[0] === 0).map((packet) => [packet[1], packet.readInt32BE(2)]);
    const [DOWN, UP, POWER] = [0, 1, 26];
    const lock = controlOf(client.getControls(), 'lock');

    lock('pointerdown');
    lock('pointerup');
    lock('lostpointercapture');
    assert.deepEqual(keys(), [[DOWN, POWER], [UP, POWER]], 'a tap; the lost capture after it sends nothing');

    sent.length = 0;
    lock('pointerdown');
    lock('pointerdown', { pointerId: 2 });
    assert.deepEqual(keys(), [[DOWN, POWER]], 'held down; a second finger on the key is not a second press');
    lock('pointercancel');
    lock('pointerup');
    assert.deepEqual(keys(), [[DOWN, POWER], [UP, POWER]], 'a cancelled pointer lets go, once');

    sent.length = 0;
    lock('pointerdown');
    dispatch(windowListeners, 'blur');
    lock('pointerup');
    assert.deepEqual(keys(), [[DOWN, POWER], [UP, POWER]], 'Lock does not stay down while the owner is in another window');

    sent.length = 0;
    lock('pointerdown');
    hidePage();
    lock('pointerup');
    assert.deepEqual(keys(), [[DOWN, POWER], [UP, POWER]], 'nor while the page is hidden');

    // `ControlPanel` lets go when it closes.
    sent.length = 0;
    lock('pointerdown');
    client.getControls().held.releaseAll();
    lock('pointerup');
    assert.deepEqual(keys(), [[DOWN, POWER], [UP, POWER]], 'nor after the panel closed');

    // After a disconnect the release cannot be delivered. Sending it would queue it for the
    // next connection, where a lone Lock release could act on a different session.
    sent.length = 0;
    lock('pointerdown');
    receiver.emit('disconnected', { code: 1006 });
    lock('pointerup');
    dispatch(windowListeners, 'blur');
    assert.deepEqual(keys(), [[DOWN, POWER]], 'the server releases the key; the client sends nothing later');

    sent.length = 0;
    lock('pointerdown', { button: 2 });
    assert.deepEqual(keys(), [], 'only the main button presses');
    lock('click', { detail: 0 });
    lock('click');
    assert.deepEqual(keys(), [[DOWN, POWER], [UP, POWER]], 'the keyboard taps; a pointer click sent its pair already');

    for (const [id, code] of [['back', 4], ['home', 3], ['overview', 187], ['volumeDown', 25], ['mute', 164], ['volumeUp', 24]]) {
        sent.length = 0;
        const control = controlOf(client.getControls(), id);
        control('pointerdown');
        control('pointerup');
        assert.deepEqual(keys(), [[DOWN, code], [UP, code]], `${id} sends key code ${code}`);
    }

    sent.length = 0;
    lock('pointerdown');
    client.stop();
    assert.deepEqual(keys(), [[DOWN, POWER], [UP, POWER]], 'closing the stream lets go as well');
    dispatch(windowListeners, 'blur');
    assert.equal(keys().length, 2, 'and stops listening');
});

test('iPhone controls: a tap is one press and a hold is down and up, through the same helper', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, sent } = iphoneClient(t, 'iphone-held');
    const buttons = () => sent.filter((message) => message.type === 'button').map((message) => [message.name, message.state]);
    const siri = controlOf(client.getControls(), 'siri');

    siri('pointerdown');
    t.mock.timers.tick(100);
    siri('pointerup');
    siri('lostpointercapture');
    assert.deepEqual(buttons(), [['siri', 'press']], 'a tap is one press, sent once');

    sent.length = 0;
    siri('pointerdown');
    t.mock.timers.tick(699);
    assert.deepEqual(buttons(), [], 'not yet a hold');
    t.mock.timers.tick(1);
    assert.deepEqual(buttons(), [['siri', 'down']]);
    siri('pointerup');
    siri('lostpointercapture');
    assert.deepEqual(buttons(), [['siri', 'down'], ['siri', 'up']], 'a hold is let go when the pointer comes up');

    sent.length = 0;
    siri('pointerdown');
    t.mock.timers.tick(700);
    siri('pointercancel');
    assert.deepEqual(buttons(), [['siri', 'down'], ['siri', 'up']], 'and when the pointer is cancelled');

    sent.length = 0;
    siri('pointerdown');
    t.mock.timers.tick(700);
    dispatch(windowListeners, 'blur');
    siri('pointerup');
    assert.deepEqual(buttons(), [['siri', 'down'], ['siri', 'up']], 'and when the window loses focus');

    sent.length = 0;
    siri('pointerdown');
    t.mock.timers.tick(700);
    hidePage();
    client.getControls().held.releaseAll();
    assert.deepEqual(buttons(), [['siri', 'down'], ['siri', 'up']], 'and when the page is hidden, once');

    sent.length = 0;
    siri('pointerdown');
    t.mock.timers.tick(300);
    dispatch(windowListeners, 'blur');
    t.mock.timers.tick(1000);
    siri('pointerup');
    assert.deepEqual(buttons(), [], 'a press cut short before it became a hold sends nothing');

    siri('pointerdown');
    t.mock.timers.tick(700);
    client.receiver.emit('disconnected', { code: 1006 });
    siri('pointerup');
    assert.deepEqual(buttons(), [['siri', 'down']], 'after a disconnect the proxy releases it; the client sends nothing');

    sent.length = 0;
    siri('click', { detail: 0 });
    siri('click');
    assert.deepEqual(buttons(), [['siri', 'press']], 'the keyboard taps once');

    for (const [id, name] of [['home', 'home'], ['volumeDown', 'volume-down'], ['mute', 'mute'], ['volumeUp', 'volume-up'], ['lock', 'lock']]) {
        sent.length = 0;
        const control = controlOf(client.getControls(), id);
        control('pointerdown');
        control('pointerup');
        assert.deepEqual(buttons(), [[name, 'press']], `${id} presses ${name}`);
    }
});

test('a slot map for each kind of phone: Android cells, and full rows of its own on an iPhone', (t) => {
    const { CONTROLS, shownControls } = require('../src/app/controls/definition');
    const { streamConnected } = require('../src/app/state/stream');
    const android = androidClient(t, Object.assign(fakePlayer(), { supportsScreenshot: true })).client.getControls();
    const iphone = iphoneClient(t, 'iphone-slots').client.getControls();
    const slots = (controls) => Object.fromEntries(shownControls(controls).map(({ definition: { id }, slot }) => [id, `${slot.row}.${slot.column}`]));
    const SHARED = { volumeDown: '2.1', mute: '2.2', volumeUp: '2.3', lock: '3.1', listen: '3.2', screenshot: '3.3', typeText: '4.1', actions: '4.2', settings: '4.3' };
    assert.deepEqual(slots(android), { back: '1.1', home: '1.2', overview: '1.3', ...SHARED });
    assert.deepEqual(slots(iphone), { home: '1.1', siri: '1.2', lock: '1.3', volumeDown: '2.1', mute: '2.2', volumeUp: '2.3', listen: '3.1', screenshot: '3.2', typeText: '3.3', actions: '4.1', settings: '4.2' }, 'the iPhone buttons first; no row before the last has an empty cell');
    const cells = CONTROLS.map(({ slot }) => `${slot.row}.${slot.column}`);
    assert.equal(new Set(cells).size, cells.length, 'one control per slot');
    const names = (controls) => shownControls(controls).map(({ definition }) => definition.label);
    assert.deepEqual(names(android), ['Back', 'Home', 'Overview', 'Volume down', 'Mute phone', 'Volume up', 'Lock', 'Listen', 'Take screenshot', 'Type text', 'Actions', 'Settings']);
    assert.deepEqual(names(iphone), ['Home', 'Siri', 'Lock', 'Volume down', 'Mute phone', 'Volume up', 'Listen', 'Take screenshot', 'Type text', 'Actions', 'Settings'], 'the side button has one name');

    // An Android player without screenshots leaves its slot empty.
    const plain = androidClient(t, fakePlayer()).client.getControls();
    assert.equal(slots(plain).screenshot, undefined);
    assert.equal(slots(plain).typeText, '4.1');

    // Disabled by the definition: the keys of the phone need a connection, the rest do not.
    t.after(() => (streamConnected.value = false));
    for (const controls of [android, iphone]) {
        const disabled = (connected) => {
            streamConnected.value = connected;
            return shownControls(controls).filter(({ definition }) => controlOf(controls, definition.id).props.disabled).map(({ definition }) => definition.id);
        };
        const keys = shownControls(controls).filter(({ action }) => action.kind === 'key').map(({ definition }) => definition.id);
        assert.deepEqual(disabled(false), keys, `${controls.platform}: every key, and only the keys, while there is no connection`);
        assert.deepEqual(disabled(true), [], `${controls.platform}: none once connected`);
    }
    assert.deepEqual(CONTROLS.filter((control) => control.needsConnection).map(({ id }) => id), CONTROLS.filter((control) => control.hold).map(({ id }) => id));
});

test('whether a key can be held comes from its definition', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client: android, sent: packets } = androidClient(t, fakePlayer());
    const { client: iphone, sent: messages } = iphoneClient(t, 'iphone-no-hold');
    const keys = () => packets.filter((packet) => packet[0] === 0).map((packet) => [packet[1], packet.readInt32BE(2)]);
    const buttons = () => messages.filter((message) => message.type === 'button').map((message) => [message.name, message.state]);

    // Without `hold`, a press is one tap when the click comes, however long it lasts.
    const lock = controlOf(android.getControls(), 'lock', { hold: false });
    lock('pointerdown');
    assert.deepEqual(keys(), [], 'Android: nothing goes down while the pointer is down');
    lock('pointerup');
    lock('click');
    assert.deepEqual(keys(), [[0, 26], [1, 26]], 'Android: the click is one down and one up');

    const siri = controlOf(iphone.getControls(), 'siri', { hold: false });
    siri('pointerdown');
    t.mock.timers.tick(1000);
    siri('pointerup');
    assert.deepEqual(buttons(), [], 'iPhone: no hold after the hold time');
    siri('click');
    assert.deepEqual(buttons(), [['siri', 'press']], 'iPhone: the click is one press');
});

test('no code picks a control by its name or title', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '../src/app/controls');
    const files = [...fs.readdirSync(dir).map((name) => path.join(dir, name)), path.join(__dirname, '../src/app/views/FloatingToolbar.tsx')];
    const NAMES = /'(Back|Home|Overview|Volume down|Mute phone|Volume up|Lock|Power|Listen|Take screenshot|Screenshot|Type text|Actions|Settings|Siri)'/;
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(source, /\.title\b|getAttribute\('(title|aria-label)'\)/, `${path.basename(file)} reads no title or name`);
        if (path.basename(file) !== 'definition.ts') assert.doesNotMatch(source, NAMES, `${path.basename(file)} names no control`);
    }
});

test('both stream clients drop their held keys when the stream disconnects', (t) => {
    const forgotten = [];
    const { client: android, receiver } = androidClient(t, fakePlayer());
    t.mock.method(android.getControls(), 'forgetHeldButtons', () => forgotten.push('android'));
    receiver.emit('disconnected', { code: 1006 });
    assert.deepEqual(forgotten, ['android']);

    const { client: iphone } = iphoneClient(t, 'iphone-drop');
    t.mock.method(iphone.getControls(), 'forgetHeldButtons', () => forgotten.push('iphone'));
    iphone.receiver.emit('disconnected', { code: 1006 });
    assert.deepEqual(forgotten, ['android', 'iphone']);
});

// ---------------------------------------------------------------- stream settings target

test('stream settings resolve the device through the stream socket when two hosts share a serial', (t) => {
    const { devices } = require('../src/app/state/devices');
    const { findDeviceForSettings } = require('../src/app/state/streamDevice');
    const { streamSocketUrl } = require('../src/app/googDevice/client/deviceInterfaces');
    const previous = devices.value;
    t.after(() => (devices.value = previous));
    const entry = (trackerId, hostname, udid) => ({
        key: `${trackerId}:${udid}`,
        trackerId,
        trackerName: hostname,
        params: { type: 'android', hostname, port: 8000, pathname: '/', secure: false },
        descriptor: { udid, state: 'device', interfaces: [] },
        tracker: { id: trackerId },
    });
    const first = entry('host-a', 'host-a.test', 'emulator-5554');
    const second = entry('host-b', 'host-b.test', 'emulator-5554');
    const other = entry('host-a', 'host-a.test', 'pixel-serial');
    devices.value = new Map([first, second, other].map((item) => [item.key, item]));
    const streamOf = (item) => ({
        action: 'stream',
        udid: item.descriptor.udid,
        player: 'webcodecs',
        ws: streamSocketUrl(item.descriptor.udid, item.params),
    });

    // The toolbar and the Actions sheet open the sheet with the serial alone.
    const target = { udid: 'emulator-5554' };
    assert.equal(
        findDeviceForSettings(target, streamOf(second)),
        second,
        "the second host's stream gets the second host's device, not the first match in the list",
    );
    assert.equal(findDeviceForSettings(target, streamOf(first)), first);
    assert.equal(findDeviceForSettings(target, streamOf(second)).tracker.id, 'host-b', 'so Apply restarts the right stream');

    // A device card names its device outright.
    assert.equal(findDeviceForSettings({ udid: 'emulator-5554', deviceKey: second.key }, streamOf(first)), second);

    // Without a stream to bind to, a serial that two hosts share names neither of them.
    assert.equal(findDeviceForSettings(target), undefined);
    assert.equal(findDeviceForSettings(target, streamOf(other)), undefined);
    assert.equal(findDeviceForSettings(target, { ...streamOf(second), ws: 'ws://elsewhere.test:8000/' }), undefined);

    // A serial only one host has still resolves while the stream's own entry cannot be matched.
    assert.equal(findDeviceForSettings({ udid: 'pixel-serial' }), other);
    assert.equal(findDeviceForSettings({ udid: 'pixel-serial' }, { ...streamOf(other), ws: 'not a url' }), other);
    assert.equal(findDeviceForSettings({ udid: 'unknown-serial' }), undefined);
});

// ---------------------------------------------------------------- one keyboard target

function captureFixture(t, { enabled = true, paste = () => {}, controls = () => undefined, requestClipboard = () => {} } = {}) {
    const { KeyboardCapture, keyboardCapture } = require('../src/app/state/keyboardCapture');
    const sent = [];
    let ready = true, releases = 0;
    const capture = new KeyboardCapture({
        container: element(), enabled, connected: () => ready,
        key: event => sent.push([event.type, event.code]),
        release: () => releases++, controls, paste, requestClipboard,
    });
    t.after(() => { openSheet = null; capture.stop(); });
    const key = (type, code, extra = {}) => capture.onKey({
        type, code, target: element(), key: code.startsWith('Key') ? code.slice(3) : code,
        ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        preventDefault() {}, stopImmediatePropagation() {}, ...extra,
    });
    const chord = code => {
        key('keydown', 'ControlLeft', { ctrlKey: true });
        key('keydown', 'AltLeft', { ctrlKey: true, altKey: true });
        key('keydown', code, { ctrlKey: true, altKey: true });
        key('keyup', code, { ctrlKey: true, altKey: true });
        key('keyup', 'AltLeft', { ctrlKey: true });
        key('keyup', 'ControlLeft');
    };
    return { capture, state: keyboardCapture, sent, key, chord, ready: value => { ready = value; }, releases: () => releases };
}

test('the keyboard release chord sends no key or modifier, and its letter works after recapture', t => {
    const f = captureFixture(t);
    f.chord('KeyK');
    assert.equal(f.state.value.enabled, false);
    assert.deepEqual(f.sent, []);
    f.chord('KeyK');
    assert.equal(f.state.value.enabled, true);
    f.key('keydown', 'KeyK'); f.key('keyup', 'KeyK');
    assert.deepEqual(f.sent, [['keydown', 'KeyK'], ['keyup', 'KeyK']], 'shortcut keyup does not swallow the next ordinary K');
});

test('ordinary modifier shortcuts retain their down/up order while native paste sends none', t => {
    const f = captureFixture(t);
    f.key('keydown', 'ControlLeft', { ctrlKey: true });
    assert.deepEqual(f.sent, [], 'a modifier waits until the next key identifies the chord');
    f.key('keydown', 'KeyA', { ctrlKey: true });
    f.key('keyup', 'KeyA', { ctrlKey: true });
    f.key('keyup', 'ControlLeft');
    assert.deepEqual(f.sent, [['keydown', 'ControlLeft'], ['keydown', 'KeyA'], ['keyup', 'KeyA'], ['keyup', 'ControlLeft']]);
    f.sent.length = 0;
    f.key('keydown', 'MetaLeft', { metaKey: true });
    f.key('keydown', 'KeyV', { metaKey: true });
    f.key('keyup', 'KeyV', { metaKey: true });
    f.key('keyup', 'MetaLeft');
    assert.deepEqual(f.sent, [], 'Cmd+V waits for the browser paste event');
});

test('offline key presses and local sheets leave no modifier for a later phone connection', t => {
    const f = captureFixture(t);
    f.ready(false);
    f.key('keydown', 'ControlLeft', { ctrlKey: true });
    f.key('keydown', 'KeyA', { ctrlKey: true });
    f.ready(true);
    f.key('keyup', 'KeyA', { ctrlKey: true }); f.key('keyup', 'ControlLeft');
    assert.deepEqual(f.sent, []);
    f.key('keydown', 'ShiftLeft');
    openSheet = element();
    f.key('keydown', 'KeyB');
    assert.equal(f.state.value.phone, false);
    assert.deepEqual(f.sent, [['keydown', 'ShiftLeft']]);
    assert.ok(f.releases() > 0, 'a local sheet releases keys immediately');
});

test('a paste cancelled before its asynchronous send never reaches the replacement target', async t => {
    const pasted = [];
    const f = captureFixture(t, { paste: text => pasted.push(text) });
    const paste = text => f.capture.onPaste({
        target: element(), clipboardData: { getData: () => text }, preventDefault() {}, stopImmediatePropagation() {},
    });
    paste('first');
    f.capture.invalidate();
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(pasted, []);
    await new Promise(resolve => setImmediate(resolve));
    paste('second');
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(pasted, ['second']);
});

test('iPhone direct paste waits for the matching clipboard confirmation before Cmd+V', async t => {
    const { client, sent } = iphoneClient(t, 'paste-ack');
    const pasted = client.pasteText('browser text', () => true);
    assert.deepEqual(sent, [{ type: 'clipboard', op: 'set', text: 'browser text', id: 1 }]);
    client.emit('result', { id: 99, ok: true });
    await Promise.resolve();
    assert.equal(sent.length, 1, 'another command reply cannot paste');
    client.emit('result', { id: 1, ok: true });
    await pasted;
    assert.deepEqual(sent.slice(1), [
        { type: 'key', usages: [0xe3] }, { type: 'key', usages: [0xe3, 0x19] },
        { type: 'key', usages: [0xe3] }, { type: 'key', usages: [] },
    ]);
});

test('iPhone clipboard failure, disconnect and a changed target never send the paste chord', async t => {
    const { client, sent } = iphoneClient(t, 'paste-cancel');
    let pasted = client.pasteText('refused', () => true);
    client.emit('result', { id: 1, ok: false, error: 'Clipboard refused' });
    await assert.rejects(pasted, /Clipboard refused/);
    pasted = client.pasteText('changed target', () => false);
    client.emit('result', { id: 2, ok: true });
    await pasted;
    pasted = client.pasteText('disconnected', () => true);
    client.onDisconnected();
    await assert.rejects(pasted, /disconnected/);
    client.emit('result', { id: 3, ok: true });
    assert.deepEqual(sent.filter(message => message.type === 'key'), []);
});


test('reserved phone shortcuts use the offered controls and skip keys absent from an iPhone', t => {
    const { createPhoneControls } = require('../src/app/controls/definition');
    const calls = [];
    const key = name => ({ kind: 'key', down: () => calls.push(`${name} down`), up: () => calls.push(`${name} up`) });
    const actions = { home: key('home'), back: key('back'), overview: key('overview'),
        typeText: { kind: 'run', run: () => calls.push('typeText') },
        screenshot: { kind: 'run', run: () => calls.push('screenshot') } };
    const android = createPhoneControls('android', actions);
    const f = captureFixture(t, { controls: () => android });
    for (const code of ['KeyH', 'KeyB', 'KeyO', 'KeyT', 'KeyP']) f.chord(code);
    assert.deepEqual(calls, ['home down', 'home up', 'back down', 'back up', 'overview down', 'overview up', 'typeText', 'screenshot']);
    assert.deepEqual(f.sent, [], 'the browser chord is never a phone key report');
    f.capture.stop(); android.release(); calls.length = 0;
    const iphone = createPhoneControls('ios', actions);
    const ios = captureFixture(t, { controls: () => iphone });
    ios.chord('KeyB'); ios.chord('KeyO'); ios.chord('KeyH');
    assert.deepEqual(calls, ['home down', 'home up'], 'capabilities omit Back and Overview on an iPhone');
    t.after(() => iphone.release());
});


test('iPhone direct paste rechecks its target inside the queued reports and lifts sent modifiers', async t => {
    const { client, sent } = iphoneClient(t, 'paste-report-cancel');
    let current = true;
    const original = client.sendKeyboardReport.bind(client);
    t.mock.method(client, 'sendKeyboardReport', usages => {
        original(usages);
        if ([...usages].includes(0xe3)) current = false;
    });
    const pasted = client.pasteText('cancel after modifier', () => current);
    client.emit('result', { id: 1, ok: true });
    await pasted;
    assert.deepEqual(sent.filter(m => m.type === 'key').map(m => m.usages), [[0xe3], []],
        'a target change after Cmd goes down releases it and never presses V');
});

test('a changed keyboard target cancels the clipboard write wait and permits the next paste', async t => {
    const writes = [];
    const f = captureFixture(t, { paste: (_text, _current, signal) => new Promise(resolve => {
        writes.push(signal);
        signal?.addEventListener('abort', resolve, { once: true });
    }) });
    const paste = () => f.capture.onPaste({ target: element(), clipboardData: { getData: () => 'text' },
        preventDefault() {}, stopImmediatePropagation() {} });
    paste(); await Promise.resolve();
    f.capture.invalidate();
    assert.equal(writes[0]?.aborted, true, 'focus change aborts the waiting clipboard operation');
    paste(); await Promise.resolve();
    assert.equal(writes.length, 2, 'a cancelled clipboard operation does not block the new target');
});

test('iPhone paste cancellation removes pending clipboard listeners without waiting for a reply', async t => {
    const { client } = iphoneClient(t, 'paste-abort');
    const abort = new AbortController();
    const pasted = client.pasteText('cancel pending ack', () => true, abort.signal);
    abort.abort();
    // A late reply is sent so the old implementation also settles; it must have rejected first.
    client.emit('result', { id: 1, ok: true });
    await assert.rejects(pasted, /cancel/i);
    assert.equal(client.listenerCount('result'), 0);
    assert.equal(client.listenerCount('link'), 0);
});

test('decoder loss lifts iPhone contacts and blocks new touches while keeping commands ready', t => {
    const { client, sent } = iphoneClient(t, 'decoder-touch-release');
    const { streamConnected } = require('../src/app/state/stream');
    client.socketOpen = true; client.sessionState = 'ready';
    const size = new Size(100, 200);
    client.touchHandler = { releaseActiveTouch() {
        client.sendTouch('release', 25, 40, size);
        client.sendContacts([{ id: 1, x: 25, y: 40, touching: false }], size);
    }, release() {} };
    client.setDecoderProblem('decoder unavailable');
    assert.equal(streamConnected.value, true, 'session commands stay ready without decoding');
    assert.deepEqual(sent.filter(m => m.type.startsWith('touch')).map(m => m.type), ['touch', 'touch-frame'],
        'losing the picture lifts the active drag and all fingers');
    sent.length = 0;
    client.sendTouch('contact', 25, 40, size);
    client.sendTouch('tap', 25, 40, size);
    client.sendContacts([{ id: 1, x: 25, y: 40, touching: true }], size);
    assert.deepEqual(sent, [], 'no new touch is sent without a usable picture');
    client.sendTouch('release', 25, 40, size);
    client.sendContacts([{ id: 1, x: 25, y: 40, touching: false }], size);
    assert.equal(sent.length, 2, 'release remains possible after decoding fails');
});


test('a late browser clipboard completion does not replace the new screen notice', async t => {
    const { deviceClipboard, deviceClipboardError, streamNotice } = require('../src/app/state/stream');
    deviceClipboard.value = undefined; deviceClipboardError.value = '';
    let finish;
    const before = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise(resolve => { finish = resolve; }) } });
    t.after(() => { if (before) Object.defineProperty(navigator, 'clipboard', before); else delete navigator.clipboard; });
    const f = captureFixture(t);
    const copied = f.capture.copy();
    deviceClipboard.value = 'phone text';
    await Promise.resolve(); await Promise.resolve();
    assert.equal(typeof finish, 'function', 'the browser copy is in flight');
    f.capture.invalidate();
    streamNotice.value = 'New screen notice';
    finish(); await copied;
    assert.equal(streamNotice.value, 'New screen notice');
});


test('a repeated native paste chord keeps the outstanding clipboard action busy', async t => {
    const writes = [];
    const f = captureFixture(t, { paste: (_text, _current, signal) => {
        writes.push(signal); return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } });
    const paste = () => f.capture.onPaste({ target: element(), clipboardData: { getData: () => 'text' },
        preventDefault() {}, stopImmediatePropagation() {} });
    paste(); await Promise.resolve();
    f.key('keydown', 'ControlLeft', { ctrlKey: true });
    f.key('keydown', 'KeyV', { ctrlKey: true });
    paste(); await Promise.resolve();
    assert.equal(writes.length, 1, 'the repeated paste waits for the first action');
    assert.equal(writes[0].aborted, false, 'its native chord does not cancel the first action');
});


test('unmount rejects a pending iPhone paste and ignores a late clipboard acknowledgement', async t => {
    const { client, sent } = iphoneClient(t, 'paste-unmount');
    const pasted = client.pasteText('pending on unmount', () => true);
    client.stop();
    client.emit('result', { id: 1, ok: true });
    await assert.rejects(pasted, /disconnected/);
    assert.deepEqual(sent.filter(m => m.type === 'key'), []);
    assert.equal(client.listenerCount('result'), 0);
    assert.equal(client.listenerCount('link'), 0);
});


test('a stale rejected browser copy never focuses the fallback textarea', async t => {
    const { copyTextToClipboard } = require('../src/app/ui/copyText');
    let fail, current = true;
    const before = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: () => new Promise((_resolve, reject) => { fail = reject; }),
    } });
    t.after(() => { if (before) Object.defineProperty(navigator, 'clipboard', before); else delete navigator.clipboard; });
    t.mock.method(document, 'createElement', () => { throw Error('A stale copy tried to focus a fallback textarea'); });
    const copied = copyTextToClipboard('old phone text', () => current);
    current = false;
    fail(Error('Browser denied copying'));
    assert.equal(await copied, false, 'the stale copy ends without creating or focusing a field');
});


test('repeating Copy from phone keeps one outstanding read until its reply', async t => {
    const { deviceClipboard, deviceClipboardError } = require('../src/app/state/stream');
    deviceClipboard.value = undefined; deviceClipboardError.value = '';
    let reads = 0;
    const f = captureFixture(t, { requestClipboard: () => { reads++; deviceClipboard.value = undefined; } });
    f.chord('KeyC');
    f.chord('KeyC');
    assert.equal(reads, 1, 'a repeated copy chord keeps the read already in progress');
    deviceClipboard.value = '';
    await new Promise(resolve => setImmediate(resolve));
});
