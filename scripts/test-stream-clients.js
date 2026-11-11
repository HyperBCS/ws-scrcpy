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
    querySelector: (selector) => (selector.includes('.bottom-sheet-root') ? openSheet : element()),
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
    const { GoogToolBox } = require('../src/app/googDevice/toolbox/GoogToolBox');
    const toolbox = { getHolderElement: () => element(), release() {}, forgetHeldButtons() {} };
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
    const client = StreamClientScrcpy.start(params, receiver, player, undefined, element());
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
    t.mock.method(ApplToolBox, 'createToolBox', () => ({ getHolderElement: () => element(), release() {}, forgetHeldButtons() {} }));
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

// ---------------------------------------------------------------- held keys and buttons

test('iPhone: a key event that lands on a local control releases the keys held on the phone', (t) => {
    const { StreamClientCoreDevice } = require('../src/app/applDevice/client/StreamClientCoreDevice');
    const { CoreDeviceReceiver } = require('../src/app/applDevice/client/CoreDeviceReceiver');
    const { ApplToolBox } = require('../src/app/applDevice/toolbox/ApplToolBox');
    t.mock.method(CoreDeviceReceiver.prototype, 'openNewConnection', () => undefined);
    t.mock.method(ApplToolBox, 'createToolBox', () => ({ getHolderElement: () => element(), release() {}, forgetHeldButtons() {} }));
    const sent = [];
    t.mock.method(CoreDeviceReceiver.prototype, 'send', (message) => sent.push(message));
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

function buttonByTitle(title, since) {
    const button = created.slice(since).find((item) => item.title === title);
    assert.ok(button, `toolbar button ${title}`);
    return (type, init = {}) => button.listeners.get(type)({ type, button: 0, pointerId: 1, detail: 1, preventDefault() {}, ...init });
}

test('Android toolbar: a held button is released when the window loses focus or the page is hidden', (t) => {
    const SvgImage = require('../src/app/ui/SvgImage').default;
    t.mock.method(SvgImage, 'create', () => element());
    const { GoogToolBox } = require('../src/app/googDevice/toolbox/GoogToolBox');
    const sent = [];
    const client = { sendMessage: (message) => sent.push([message.action, message.keycode]), getDeviceName: () => 'Pixel' };
    const since = created.length;
    const toolbox = GoogToolBox.createToolBox('android-held', { supportsScreenshot: false }, client, { captureKeyboard: false });
    t.after(() => toolbox.release());
    const power = buttonByTitle('Power', since);
    const POWER = 26;
    const [DOWN, UP] = [0, 1];

    power('pointerdown');
    assert.deepEqual(sent, [[DOWN, POWER]]);
    dispatch(windowListeners, 'blur');
    assert.deepEqual(sent, [[DOWN, POWER], [UP, POWER]], 'Power does not stay down while the owner is in another window');
    power('pointerup');
    assert.equal(sent.length, 2, 'the late pointer end sends no second release');

    sent.length = 0;
    power('pointerdown');
    document.visibilityState = 'hidden';
    dispatch(documentListeners, 'visibilitychange');
    document.visibilityState = 'visible';
    assert.deepEqual(sent, [[DOWN, POWER], [UP, POWER]], 'nor while the page is hidden');

    // After a disconnect the release cannot be delivered. Sending it would queue it for the
    // next connection, where a lone Power release could act on a different session.
    sent.length = 0;
    power('pointerdown');
    toolbox.forgetHeldButtons();
    power('pointerup');
    dispatch(windowListeners, 'blur');
    assert.deepEqual(sent, [[DOWN, POWER]], 'the server releases the key; the client sends nothing later');

    // An ordinary press is unchanged.
    sent.length = 0;
    power('pointerdown');
    power('pointerup');
    assert.deepEqual(sent, [[DOWN, POWER], [UP, POWER]]);

    sent.length = 0;
    power('pointerdown');
    toolbox.release();
    assert.deepEqual(sent, [[DOWN, POWER], [UP, POWER]], 'closing the stream lets go as well');
    dispatch(windowListeners, 'blur');
    assert.equal(sent.length, 2, 'and stops listening');
});

test('iPhone toolbar: a held button is released on blur, and a press cut short is not sent', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const SvgImage = require('../src/app/ui/SvgImage').default;
    t.mock.method(SvgImage, 'create', () => element());
    const { ApplToolBox } = require('../src/app/applDevice/toolbox/ApplToolBox');
    const sent = [];
    const client = { pressButton: (name, state) => sent.push([name, state]), getPlayer: () => undefined, getDeviceName: () => 'iPhone' };
    const since = created.length;
    const toolbox = ApplToolBox.createToolBox(client);
    t.after(() => toolbox.release());
    const siri = buttonByTitle('Siri', since);

    siri('pointerdown');
    t.mock.timers.tick(700);
    assert.deepEqual(sent, [['siri', 'down']]);
    dispatch(windowListeners, 'blur');
    assert.deepEqual(sent, [['siri', 'down'], ['siri', 'up']], 'Siri is let go when the window loses focus');
    siri('pointerup');
    assert.equal(sent.length, 2);

    sent.length = 0;
    siri('pointerdown');
    t.mock.timers.tick(300);
    dispatch(windowListeners, 'blur');
    t.mock.timers.tick(1000);
    siri('pointerup');
    assert.deepEqual(sent, [], 'a press interrupted before it became a hold does nothing');

    siri('pointerdown');
    t.mock.timers.tick(700);
    toolbox.forgetHeldButtons();
    siri('pointerup');
    assert.deepEqual(sent, [['siri', 'down']], 'after a disconnect the proxy releases it; the client sends nothing');

    sent.length = 0;
    siri('pointerdown');
    t.mock.timers.tick(100);
    siri('pointerup');
    assert.deepEqual(sent, [['siri', 'press']], 'an ordinary tap is unchanged');
});

test('both stream clients drop their toolbar holds when the stream disconnects', (t) => {
    const forgotten = [];
    const player = fakePlayer();
    const { receiver, toolbox } = androidClient(t, player);
    toolbox.forgetHeldButtons = () => forgotten.push('android');
    receiver.emit('disconnected', { code: 1006 });
    assert.deepEqual(forgotten, ['android']);

    const { StreamClientCoreDevice } = require('../src/app/applDevice/client/StreamClientCoreDevice');
    const { CoreDeviceReceiver } = require('../src/app/applDevice/client/CoreDeviceReceiver');
    const { ApplToolBox } = require('../src/app/applDevice/toolbox/ApplToolBox');
    t.mock.method(CoreDeviceReceiver.prototype, 'openNewConnection', () => undefined);
    t.mock.method(ApplToolBox, 'createToolBox', () => ({
        getHolderElement: () => element(),
        release() {},
        forgetHeldButtons: () => forgotten.push('iphone'),
    }));
    const client = StreamClientCoreDevice.start({ action: 'stream-coredevice', udid: 'iphone-drop', captureKeyboard: false }, element());
    t.after(() => client.stop());
    client.receiver.emit('disconnected', { code: 1006 });
    assert.deepEqual(forgotten, ['android', 'iphone']);
});

// ---------------------------------------------------------------- stream settings target

test('stream settings resolve the device through the stream socket when two hosts share a serial', (t) => {
    const { devices } = require('../src/app/state/devices');
    const { findDeviceForSettings } = require('../src/app/state/streamDevice');
    const { buildInterfaceOptions } = require('../src/app/googDevice/client/deviceInterfaces');
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
        ws: buildInterfaceOptions(item.descriptor, item.params).find((option) => option.name === 'proxy').url,
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
