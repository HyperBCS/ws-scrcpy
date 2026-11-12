// Run with: node --test scripts/test-point-mapper.js
// The one point mapper of both kinds of phone (src/app/input/pointMapper.ts): a point on the
// page to a point on the phone's picture, for every rotation, for a picture with bands beside or
// above it, at the edges, outside the picture and at any device pixel ratio. Then both
// interaction handlers against what they sent before they shared it. No browser or phone is used.
const assert = require('node:assert/strict');
const { test } = require('node:test');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

for (const ext of ['.svg', '.png', '.css']) {
    require.extensions[ext] = (module) => {
        module.exports = '';
    };
}

// Only what the handlers touch: listeners on window, document and body, and animation frames.
const listenerApi = () => {
    const map = new Map();
    return {
        addEventListener(name, fn) {
            if (!map.has(name)) map.set(name, new Set());
            map.get(name).add(fn);
        },
        removeEventListener(name, fn) {
            map.get(name)?.delete(fn);
        },
    };
};
global.window = global;
Object.assign(global, listenerApi());
global.document = {
    ...listenerApi(),
    hidden: false,
    visibilityState: 'visible',
    body: { ...listenerApi(), classList: { add() {}, remove() {} } },
};
global.Image = class {
    set src(_) {
        /* never loads */
    }
};
let frames = [];
global.requestAnimationFrame = (fn) => frames.push(fn);
global.cancelAnimationFrame = () => (frames = []);
const flush = () => frames.splice(0).forEach((fn) => fn());
global.MouseEvent = class MouseEvent {
    constructor(type, init = {}) {
        Object.assign(this, { type, buttons: 0, button: 0, ctrlKey: false, shiftKey: false, cancelable: true }, init);
    }
    preventDefault() {}
    stopPropagation() {}
};
global.WheelEvent = class WheelEvent extends global.MouseEvent {};
global.TouchEvent = class TouchEvent {
    constructor(type, init = {}) {
        Object.assign(this, { type, cancelable: true }, init);
    }
    preventDefault() {}
    stopPropagation() {}
};

const { clientPointToVideo, elementBox, isInside, lastPixel, mirrorPoint, pictureCentre } = require('../src/app/input/pointMapper');
const Size = require('../src/app/Size').default;
const Rect = require('../src/app/Rect').default;
const ScreenInfo = require('../src/app/ScreenInfo').default;

// ---------------------------------------------------------------- the mapper

test('a rotation is a new video size, and the point is read against it', () => {
    // Both phones send their video turned the way the phone is: 0 and 180 degrees are portrait,
    // 90 and 270 landscape. The layer is sized to the picture in each case.
    const portrait = { size: { width: 720, height: 1280 }, box: { left: 30, top: 0, width: 360, height: 640 } };
    const landscape = { size: { width: 1280, height: 720 }, box: { left: 0, top: 100, width: 640, height: 360 } };
    for (const rotation of [0, 1, 2, 3]) {
        const { size, box } = rotation % 2 ? landscape : portrait;
        const at = (fx, fy) => clientPointToVideo(box.left + fx * box.width, box.top + fy * box.height, box, size);
        assert.deepEqual(at(0.5, 0.5), { x: size.width / 2, y: size.height / 2 }, `rotation ${rotation}: the middle`);
        assert.deepEqual(at(0.25, 0.75), { x: size.width / 4, y: (size.height * 3) / 4 }, `rotation ${rotation}`);
        assert.deepEqual(at(0, 0), { x: 0, y: 0 }, `rotation ${rotation}: top left`);
        assert.deepEqual(at(1, 1), { x: size.width, y: size.height }, `rotation ${rotation}: bottom right`);
    }
});

test('a picture with bands beside it or above it: the bands clamp onto the nearest edge', () => {
    const size = { width: 720, height: 1280 };
    // Pillarbox: the layer is wider than the picture. The picture is 360 wide, centred at 20..380.
    const wide = { left: 0, top: 0, width: 400, height: 640 };
    assert.deepEqual(clientPointToVideo(200, 320, wide, size), { x: 360, y: 640 }, 'the middle');
    assert.deepEqual(clientPointToVideo(20, 320, wide, size), { x: 0, y: 640 }, 'the left edge of the picture');
    assert.deepEqual(clientPointToVideo(5, 320, wide, size), { x: 0, y: 640 }, 'the band on the left');
    assert.deepEqual(clientPointToVideo(395, 320, wide, size), { x: 720, y: 640 }, 'the band on the right');
    // Letterbox: the layer is taller. The picture is 640 high, centred at 30..670.
    const tall = { left: 0, top: 0, width: 360, height: 700 };
    assert.deepEqual(clientPointToVideo(180, 350, tall, size), { x: 360, y: 640 });
    assert.deepEqual(clientPointToVideo(180, 30, tall, size), { x: 360, y: 0 });
    assert.deepEqual(clientPointToVideo(180, 10, tall, size), { x: 360, y: 0 }, 'the band above');
    assert.deepEqual(clientPointToVideo(180, 690, tall, size), { x: 360, y: 1280 }, 'the band below');
});

test('outside the picture a point is clamped to the edge, never dropped', () => {
    const size = { width: 1296, height: 2816 };
    const box = { left: 30, top: 30, width: 324, height: 704 };
    assert.deepEqual(clientPointToVideo(-500, 382, box, size), { x: 0, y: 1408 }, 'left');
    assert.deepEqual(clientPointToVideo(2000, 382, box, size), { x: 1296, y: 1408 }, 'right');
    assert.deepEqual(clientPointToVideo(192, -500, box, size), { x: 648, y: 0 }, 'above');
    assert.deepEqual(clientPointToVideo(192, 5000, box, size), { x: 648, y: 2816 }, 'below');
    assert.deepEqual(clientPointToVideo(-1, -1, box, size), { x: 0, y: 0 }, 'a corner');
    assert.equal(isInside(box, 29, 382), false);
    assert.equal(isInside(box, 30, 382), true, 'the edge is on the picture');
    assert.equal(isInside(box, 354, 734), true);
    assert.equal(isInside(box, 354.5, 734), false);
    // No picture yet, or a point that is not a number.
    assert.equal(clientPointToVideo(NaN, 10, box, size), undefined);
    assert.equal(clientPointToVideo(10, 10, { ...box, width: 0 }, size), undefined);
    assert.equal(clientPointToVideo(10, 10, box, { width: 0, height: 0 }), undefined);
});

test('the device pixel ratio changes nothing: the box is read in CSS pixels', () => {
    const previous = global.devicePixelRatio;
    try {
        const results = [1, 2, 3].map((ratio) => {
            global.devicePixelRatio = ratio;
            // The canvas's bitmap is the video size (and could be scaled by the ratio); the
            // mapper reads the layout's box only.
            const canvas = {
                width: 1296 * ratio,
                height: 2816 * ratio,
                clientWidth: 324,
                clientHeight: 704,
                getBoundingClientRect: () => ({ left: 30.5, top: 30.25, width: 324.33, height: 704.66 }),
            };
            const box = elementBox(canvas);
            assert.deepEqual(box, { left: 30.5, top: 30.25, width: 324, height: 704 }, `ratio ${ratio}: CSS pixels`);
            return clientPointToVideo(30.5 + 81, 30.25 + 176, box, { width: 1296, height: 2816 });
        });
        assert.deepEqual(results, [{ x: 324, y: 704 }, { x: 324, y: 704 }, { x: 324, y: 704 }]);
    } finally {
        global.devicePixelRatio = previous;
    }
});

test("Android's last pixel, the middle and the mirror of a pinch", () => {
    const size = { width: 720, height: 1280 };
    assert.deepEqual(lastPixel({ x: 720, y: 1280 }, size), { x: 719, y: 1279 });
    assert.deepEqual(lastPixel({ x: 0, y: 5 }, size), { x: 0, y: 5 });
    assert.deepEqual(pictureCentre(size), { x: 360, y: 640 });
    assert.deepEqual(mirrorPoint({ x: 100, y: 200 }, pictureCentre(size), size), { x: 620, y: 1080 });
    assert.deepEqual(mirrorPoint({ x: 0, y: 0 }, pictureCentre(size), size), { x: 720, y: 1280 }, 'the far corner');
    // Around another centre the mirror can fall off the picture.
    assert.equal(mirrorPoint({ x: 600, y: 640 }, { x: 200, y: 640 }, size), undefined);
    assert.deepEqual(mirrorPoint({ x: 250, y: 640 }, { x: 200, y: 640 }, size), { x: 150, y: 640 });
});

// ---------------------------------------------------------------- both handlers, before and after

// The touch layer's box on the page and the video size.
const GEOMETRIES = {
    'portrait fit': { box: { left: 30, top: 0, width: 360, height: 640 }, video: [720, 1280] },
    'landscape fit': { box: { left: 0, top: 100, width: 640, height: 360 }, video: [1280, 720] },
    'pillarbox inside layer': { box: { left: 10, top: 20, width: 400, height: 640 }, video: [720, 1280] },
    'letterbox inside layer': { box: { left: 10, top: 20, width: 360, height: 700 }, video: [720, 1280] },
    'iphone portrait': { box: { left: 30, top: 30, width: 324, height: 704 }, video: [1296, 2816] },
    'iphone landscape': { box: { left: 12.5, top: 40.25, width: 704, height: 324 }, video: [2816, 1296] },
};
// Points as shares of the box; the last six are outside it.
const FRACTIONS = [
    [0.5, 0.5], [0, 0], [1, 1], [1, 0], [0, 1], [0.25, 0.75], [0.333, 0.667],
    [-0.2, 0.5], [1.2, 0.5], [0.5, -0.3], [0.5, 1.4], [-1, -1], [2, 2],
];
// What both handlers sent for each point at 58f690c, before they shared the mapper, one row per
// point of FRACTIONS: Android's touch-down x and y in video pixels; the iPhone's mouse contact
// and its touch frame in 0..65535 (`null`: a touch that starts beside the picture sends nothing).
const RECORDED = {
    'portrait fit': [
        [360, 640, 32768, 32768, [32768, 32768]], [0, 0, 0, 0, [0, 0]], [719, 1279, 65535, 65535, [65535, 65535]],
        [719, 0, 65535, 0, [65535, 0]], [0, 1279, 0, 65535, [0, 65535]], [180, 960, 16384, 49151, [16384, 49151]],
        [240, 854, 21845, 43724, [21845, 43724]], [0, 640, 0, 32768, null], [719, 640, 65535, 32768, null],
        [360, 0, 32768, 0, null], [360, 1279, 32768, 65535, null], [0, 0, 0, 0, null], [719, 1279, 65535, 65535, null],
    ],
    'landscape fit': [
        [640, 360, 32768, 32768, [32768, 32768]], [0, 0, 0, 0, [0, 0]], [1279, 719, 65535, 65535, [65535, 65535]],
        [1279, 0, 65535, 0, [65535, 0]], [0, 719, 0, 65535, [0, 65535]], [320, 540, 16384, 49151, [16384, 49151]],
        [426, 480, 21811, 43690, [21811, 43690]], [0, 360, 0, 32768, null], [1279, 360, 65535, 32768, null],
        [640, 0, 32768, 0, null], [640, 719, 32768, 65535, null], [0, 0, 0, 0, null], [1279, 719, 65535, 65535, null],
    ],
    'pillarbox inside layer': [
        [360, 640, 32768, 32768, [32768, 32768]], [0, 0, 0, 0, [0, 0]], [719, 1279, 65535, 65535, [65535, 65535]],
        [719, 0, 65535, 0, [65535, 0]], [0, 1279, 0, 65535, [0, 65535]], [160, 960, 14563, 49151, [14563, 49151]],
        [226, 854, 20571, 43724, [20571, 43724]], [0, 640, 0, 32768, null], [719, 640, 65535, 32768, null],
        [360, 0, 32768, 0, null], [360, 1279, 32768, 65535, null], [0, 0, 0, 0, null], [719, 1279, 65535, 65535, null],
    ],
    'letterbox inside layer': [
        [360, 640, 32768, 32768, [32768, 32768]], [0, 0, 0, 0, [0, 0]], [719, 1279, 65535, 65535, [65535, 65535]],
        [719, 0, 65535, 0, [65535, 0]], [0, 1279, 0, 65535, [0, 65535]], [180, 990, 16384, 50687, [16384, 50687]],
        [240, 874, 21845, 44748, [21845, 44748]], [0, 640, 0, 32768, null], [719, 640, 65535, 32768, null],
        [360, 0, 32768, 0, null], [360, 1279, 32768, 65535, null], [0, 0, 0, 0, null], [719, 1279, 65535, 65535, null],
    ],
    'iphone portrait': [
        [648, 1408, 32768, 32768, [32768, 32768]], [0, 0, 0, 0, [0, 0]], [1295, 2815, 65535, 65535, [65535, 65535]],
        [1295, 0, 65535, 0, [65535, 0]], [0, 2815, 0, 65535, [0, 65535]], [324, 2112, 16384, 49151, [16384, 49151]],
        [432, 1878, 21845, 43706, [21845, 43706]], [0, 1408, 0, 32768, null], [1295, 1408, 65535, 32768, null],
        [648, 0, 32768, 0, null], [648, 2815, 32768, 65535, null], [0, 0, 0, 0, null], [1295, 2815, 65535, 65535, null],
    ],
    'iphone landscape': [
        [1408, 648, 32768, 32768, [32768, 32768]], [0, 0, 0, 0, [0, 0]], [2815, 1295, 65535, 65535, [65535, 65535]],
        [2815, 0, 65535, 0, [65535, 0]], [0, 1295, 0, 65535, [0, 65535]], [704, 972, 16384, 49151, [16384, 49151]],
        [938, 864, 21829, 43690, [21829, 43690]], [0, 648, 0, 32768, null], [2815, 648, 65535, 32768, null],
        [1408, 0, 32768, 0, null], [1408, 1295, 32768, 65535, null], [0, 0, 0, 0, null], [2815, 1295, 65535, 65535, null],
    ],
};

function layer({ box, video }) {
    const canvas = {
        clientWidth: box.width,
        clientHeight: box.height,
        parentElement: null,
        addEventListener() {},
        removeEventListener() {},
        getContext: () => null,
        getBoundingClientRect: () => ({ ...box }),
    };
    const info = new ScreenInfo(new Rect(0, 0, video[0], video[1]), new Size(video[0], video[1]), 0);
    return { canvas, player: { getTouchableElement: () => canvas, getScreenInfo: () => info } };
}

/** Android: a mouse press at the point. Returns the touch-down message and the point it carries. */
function androidPress(geometry, clientX, clientY) {
    const { FeaturedInteractionHandler } = require('../src/app/interactionHandler/FeaturedInteractionHandler');
    const { canvas, player } = layer(geometry);
    const sent = [];
    const handler = new FeaturedInteractionHandler(player, { sendMessage: (message) => sent.push(message) });
    handler.onInteraction(new MouseEvent('mousedown', { target: canvas, clientX, clientY, buttons: 1 }));
    const pressed = sent.splice(0);
    handler.release();
    return pressed;
}

/** iPhone: a mouse press, then a touch, on the wire as the client sends them, and in video pixels. */
function iphonePress(geometry, clientX, clientY) {
    const { CoreDeviceInteractionHandler } = require('../src/app/applDevice/CoreDeviceInteractionHandler');
    const { StreamClientCoreDevice } = require('../src/app/applDevice/client/StreamClientCoreDevice');
    const { canvas, player } = layer(geometry);
    const wire = [];
    const points = [];
    const client = { receiver: { send: (message) => (wire.push(message), true) } };
    const handler = new CoreDeviceInteractionHandler(player, {
        sendTouch: (op, x, y, size) => {
            points.push({ x, y });
            StreamClientCoreDevice.prototype.sendTouch.call(client, op, x, y, size);
        },
        sendContacts: (contacts, size) => StreamClientCoreDevice.prototype.sendContacts.call(client, contacts, size),
    });
    handler.onInteraction(new MouseEvent('mousedown', { target: canvas, clientX, clientY, buttons: 1 }));
    flush();
    const mouse = wire.splice(0);
    const point = points[0];
    handler.releaseActiveTouch();
    wire.length = 0;
    handler.onInteraction(new TouchEvent('touchstart', { target: canvas, changedTouches: [{ identifier: 1, clientX, clientY, target: canvas }] }));
    const touch = wire.splice(0);
    handler.release();
    return { mouse, touch, point };
}

test('both handlers send what they sent before they shared the mapper', () => {
    const { TouchControlMessage } = require('../src/app/controlMessage/TouchControlMessage');
    const Point = require('../src/app/Point').default;
    const Position = require('../src/app/Position').default;
    for (const [name, geometry] of Object.entries(GEOMETRIES)) {
        const { box, video } = geometry;
        FRACTIONS.forEach(([fx, fy], index) => {
            const clientX = box.left + fx * box.width;
            const clientY = box.top + fy * box.height;
            const [ax, ay, mx, my, touch] = RECORDED[name][index];
            const label = `${name} at ${fx},${fy}`;
            // The whole Android message: touch-down, pointer 0, full pressure, primary button.
            const expected = new TouchControlMessage(0, 0, new Position(new Point(ax, ay), new Size(video[0], video[1])), 1, 1);
            const android = androidPress(geometry, clientX, clientY);
            assert.equal(android.length, 1, label);
            assert.deepEqual(Buffer.from(android[0].toBuffer()), Buffer.from(expected.toBuffer()), `${label}: Android`);
            const iphone = iphonePress(geometry, clientX, clientY);
            assert.deepEqual(iphone.mouse, [{ type: 'touch', op: 'contact', x: mx, y: my }], `${label}: iPhone mouse`);
            assert.deepEqual(
                iphone.touch,
                touch ? [{ type: 'touch-frame', contacts: [{ id: 0, touching: true, x: touch[0], y: touch[1] }] }] : [],
                `${label}: iPhone touch`,
            );
        });
    }
});

test('the same input gives the same phone point on both platforms', () => {
    for (const geometry of Object.values(GEOMETRIES)) {
        const { box, video } = geometry;
        for (const [fx, fy] of FRACTIONS) {
            const clientX = box.left + fx * box.width;
            const clientY = box.top + fy * box.height;
            const [android] = androidPress(geometry, clientX, clientY);
            const { point } = iphonePress(geometry, clientX, clientY);
            // Android's own form only differs on the far edge: its last pixel is width - 1.
            assert.deepEqual(
                { x: android.position.point.x, y: android.position.point.y },
                lastPixel(point, { width: video[0], height: video[1] }),
                `${fx},${fy} in a ${video.join('x')} picture`,
            );
        }
    }
});
