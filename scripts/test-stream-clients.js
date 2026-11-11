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
