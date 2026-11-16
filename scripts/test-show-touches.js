// Run with: node --test scripts/test-show-touches.js
// Show touches without a browser: the switch (src/app/state/showTouches.ts) is off until this
// browser turns it on, is kept and read back, and blocked storage leaves it off without a fault;
// the dot looks like Android's "Show taps" dot in both themes and fades in --motion-fast;
// a pointer's circle (src/app/input/touchMarks.ts) lies where the phone receives the touch, also
// with bands beside the picture and beside it; and the pinch code of both kinds of phone tells the
// layer both fingers of a Ctrl+drag while sending exactly what it sends without it. No browser or
// phone is used.
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
        dispatch(name, event) {
            [...(map.get(name) || [])].forEach((fn) => fn(event));
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

const { clientPointToVideo } = require('../src/app/input/pointMapper');
const { TOUCH_RULES, videoPointToLayer } = require('../src/app/input/touchMarks');

/** Where the layer puts the circle of a pointer at a page point: the two steps of its `place`. */
function markPoint(clientX, clientY, box, video, layer) {
    const point = clientPointToVideo(clientX, clientY, box, video);
    return point && videoPointToLayer(point, box, video, layer);
}
const Size = require('../src/app/Size').default;
const Rect = require('../src/app/Rect').default;
const ScreenInfo = require('../src/app/ScreenInfo').default;

// ---------------------------------------------------------------- the switch

const STATE = require.resolve('../src/app/state/showTouches');
const KEY = 'ws-scrcpy.screen.show-touches';

/** This browser's storage, or one that refuses every access, as Safari's private browsing does. */
function storage({ blocked = false, values = {} } = {}) {
    const kept = new Map(Object.entries(values));
    const refuse = () => {
        throw new Error('The operation is insecure.');
    };
    global.localStorage = blocked
        ? { getItem: refuse, setItem: refuse, removeItem: refuse }
        : {
              getItem: (key) => (kept.has(key) ? kept.get(key) : null),
              setItem: (key, value) => kept.set(key, String(value)),
              removeItem: (key) => kept.delete(key),
          };
    return kept;
}

/** The state module as a new page loads it, with what the browser has kept. */
function load() {
    delete require.cache[STATE];
    return require(STATE);
}

test('Show touches is off until this browser turns it on, and is read back on the next load', () => {
    const kept = storage();
    let state = load();
    assert.equal(state.SHOW_TOUCHES_KEY, KEY);
    assert.equal(state.showTouches.value, false, 'off by default');
    state.setShowTouches(true);
    assert.equal(state.showTouches.value, true, 'on at once');
    assert.equal(kept.get(KEY), '1', 'kept in this browser');
    state = load();
    assert.equal(state.showTouches.value, true, 'read back');
    state.setShowTouches(false);
    assert.equal(state.showTouches.value, false);
    assert.equal(kept.has(KEY), false, 'off leaves nothing behind');
    assert.equal(load().showTouches.value, false);
    for (const value of ['0', 'true', 'on', '', ' 1']) {
        storage({ values: { [KEY]: value } });
        assert.equal(load().showTouches.value, false, `"${value}" is not on`);
    }
});

test('with storage blocked it starts off, still turns on for this page, and nothing throws', () => {
    storage({ blocked: true });
    const state = load();
    assert.equal(state.showTouches.value, false);
    state.setShowTouches(true);
    assert.equal(state.showTouches.value, true);
    state.setShowTouches(false);
    assert.equal(state.showTouches.value, false);
    storage();
});

// ---------------------------------------------------------------- the look of a dot

test("the dot is Android's: 32px of translucent white with a thin dark edge, the same in both themes, and a short fade", () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.touch-mark\s*\{([^}]*)\}/.exec(source('src/style/views/TouchMarks.css'))[1];
    const declared = Object.fromEntries(Array.from(rule.matchAll(/([\w-]+):\s*([^;]+);/g), (match) => [match[1], match[2].replace(/\s+/g, ' ').trim()]));
    assert.equal(declared.width, 'var(--control-height-compact)');
    assert.equal(declared.height, 'var(--control-height-compact)');
    assert.equal(declared.margin, 'calc(var(--control-height-compact) / -2) 0 0 calc(var(--control-height-compact) / -2)', 'centred on its point');
    assert.equal(declared['border-radius'], 'var(--radius-full)', 'round');
    assert.equal(declared['background-color'], 'var(--touch-mark-fill)');
    assert.equal(declared.border, '1px solid var(--touch-mark-edge)');
    assert.equal(declared['background-clip'], 'padding-box', 'the edge lies over the picture');
    assert.equal('box-shadow' in declared, false, 'no ring');
    assert.doesNotMatch(rule, /accent/, 'no accent colour');
    // Defined once, among the light values, so a dark system and Dark chosen have the same dot.
    const tokens = source('src/style/tokens.css');
    for (const [name, value] of [['--touch-mark-fill', 'rgba(255, 255, 255, 0.6)'], ['--touch-mark-edge', 'rgba(0, 0, 0, 0.3)']]) {
        assert.deepEqual(Array.from(tokens.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g')), (match) => match[1].trim()), [value], name);
        assert.ok(tokens.indexOf(name) < tokens.indexOf('@media (prefers-color-scheme: dark)'), `${name} is a value of both themes`);
    }
    // Let go, it fades in --motion-fast.
    assert.match(source('src/app/views/screen/TouchMarks.tsx'), /animate\(mark\.element, \[\{ opacity: 1 \}, \{ opacity: 0 \}\], \{\s*duration: MOTION\.quick,/);
    assert.equal(require('../src/app/ui/motion').MOTION.quick, 160);
    assert.match(tokens, /--motion-fast: 160ms;/);
});

// ---------------------------------------------------------------- a pointer on the layer

// The touch layer's box on the page and the video it shows. The Show touches layer lies at
// `layer`, the picture's box as `ScreenView` writes it on the stage, or anywhere else.
const GEOMETRIES = {
    'android portrait, picture fills the box': { box: { left: 40, top: 96, width: 360, height: 640 }, video: { width: 720, height: 1280 }, layer: { left: 40, top: 96 } },
    'android, bands beside the picture inside the box': { box: { left: 0, top: 100, width: 400, height: 640 }, video: { width: 720, height: 1280 }, layer: { left: 20, top: 100 } },
    'iphone, bands above and below inside the box': { box: { left: 12.5, top: 80.25, width: 324, height: 760 }, video: { width: 1290, height: 2796 }, layer: { left: 0, top: 0 } },
    'landscape, a picture larger than its video': { box: { left: 100, top: 50, width: 1280, height: 720 }, video: { width: 640, height: 360 }, layer: { left: 100.5, top: 49.5 } },
};
const ON_PICTURE = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.2], [0.33, 0.77], [0, 0], [1, 1], [0.999, 0.001]];

/** The picture inside the box, as the player centres it. */
function pictureOf({ box, video }) {
    const scale = Math.min(box.width / video.width, box.height / video.height);
    const width = video.width * scale;
    const height = video.height * scale;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height, scale };
}

test('a circle lies under its pointer, within half a video pixel, with or without bands', () => {
    for (const [name, geometry] of Object.entries(GEOMETRIES)) {
        const { box, video, layer } = geometry;
        const picture = pictureOf(geometry);
        // The input rounds to a video pixel, which is `scale` CSS pixels; the circle is on it.
        const slack = 0.5 * picture.scale + 1e-9;
        for (const [fx, fy] of ON_PICTURE) {
            const clientX = picture.left + fx * picture.width;
            const clientY = picture.top + fy * picture.height;
            const at = markPoint(clientX, clientY, box, video, layer);
            const label = `${name} at ${fx},${fy}`;
            assert.ok(Math.abs(layer.left + at.x - clientX) <= slack, `${label}: x ${layer.left + at.x} for ${clientX}`);
            assert.ok(Math.abs(layer.top + at.y - clientY) <= slack, `${label}: y ${layer.top + at.y} for ${clientY}`);
        }
    }
});

test('the circle is where the phone receives the touch: its place maps to the same phone point', () => {
    for (const [name, geometry] of Object.entries(GEOMETRIES)) {
        const { box, video, layer } = geometry;
        for (let fx = -0.2; fx <= 1.2; fx += 0.1) {
            for (let fy = -0.2; fy <= 1.2; fy += 0.1) {
                const clientX = box.left + fx * box.width;
                const clientY = box.top + fy * box.height;
                const sent = clientPointToVideo(clientX, clientY, box, video);
                const at = markPoint(clientX, clientY, box, video, layer);
                assert.deepEqual(
                    clientPointToVideo(layer.left + at.x, layer.top + at.y, box, video),
                    sent,
                    `${name} at ${fx.toFixed(1)},${fy.toFixed(1)}`,
                );
            }
        }
    }
});

test('a pointer beside the picture puts its circle on the nearest edge, as the input does', () => {
    const geometry = GEOMETRIES['android, bands beside the picture inside the box'];
    const { box, video, layer } = geometry;
    const picture = pictureOf(geometry);
    const middle = picture.top + picture.height / 2;
    const page = (at) => ({ x: layer.left + at.x, y: layer.top + at.y });
    // The bands inside the box are 20 px wide.
    assert.deepEqual(page(markPoint(box.left + 5, middle, box, video, layer)), { x: picture.left, y: middle }, 'the band on the left');
    assert.deepEqual(page(markPoint(box.left + box.width - 5, middle, box, video, layer)), { x: picture.left + picture.width, y: middle }, 'the band on the right');
    assert.deepEqual(page(markPoint(picture.left + 90, -300, box, video, layer)), { x: picture.left + 90, y: picture.top }, 'above the picture');
    assert.deepEqual(page(markPoint(5000, 5000, box, video, layer)), { x: picture.left + picture.width, y: picture.top + picture.height }, 'a corner');
});

test('no picture yet, or no point, is no circle', () => {
    const { box, video, layer } = GEOMETRIES['android portrait, picture fills the box'];
    assert.equal(markPoint(100, 100, { ...box, width: 0 }, video, layer), undefined);
    assert.equal(markPoint(100, 100, box, { width: 0, height: 0 }, layer), undefined);
    assert.equal(markPoint(NaN, 100, box, video, layer), undefined);
    assert.equal(videoPointToLayer({ x: 1, y: 1 }, box, { width: 0, height: 0 }, layer), undefined);
    assert.deepEqual(videoPointToLayer({ x: 360, y: 640 }, box, video, { left: 0, top: 0 }), { x: 220, y: 416 }, 'the middle, from the page origin');
});

// ---------------------------------------------------------------- the second finger of a pinch

const PINCH_BOX = { left: 30, top: 60, width: 360, height: 640 };
const PINCH_VIDEO = [720, 1280];

function player() {
    const canvas = {
        clientWidth: PINCH_BOX.width,
        clientHeight: PINCH_BOX.height,
        parentElement: null,
        addEventListener() {},
        removeEventListener() {},
        getContext: () => null,
        getBoundingClientRect: () => ({ ...PINCH_BOX }),
    };
    const info = new ScreenInfo(new Rect(0, 0, PINCH_VIDEO[0], PINCH_VIDEO[1]), new Size(PINCH_VIDEO[0], PINCH_VIDEO[1]), 0);
    return { canvas, player: { getTouchableElement: () => canvas, getScreenInfo: () => info } };
}

/** A Ctrl+drag from a quarter of the picture towards its middle, as the browser delivers it. */
function ctrlDrag(handler, canvas) {
    const at = (fx, fy) => ({ clientX: PINCH_BOX.left + fx * PINCH_BOX.width, clientY: PINCH_BOX.top + fy * PINCH_BOX.height });
    const held = { target: canvas, buttons: 1, ctrlKey: true };
    handler.onInteraction(new MouseEvent('mousedown', { ...held, ...at(0.25, 0.25) }));
    flush();
    for (const step of [0.3, 0.35, 0.4]) {
        window.dispatch('mousemove', new MouseEvent('mousemove', { ...held, ...at(step, step) }));
        flush();
    }
    window.dispatch('mouseup', new MouseEvent('mouseup', { ...held, buttons: 0, ...at(0.4, 0.4) }));
    flush();
}

/** What a Ctrl+drag sends on each kind of phone, and the fingers the pinch code shows meanwhile. */
function pinchOn(platform, watcher) {
    const { InteractionHandler } = require('../src/app/interactionHandler/InteractionHandler');
    const { canvas, player: phone } = player();
    const sent = [];
    const seen = [];
    const unwatch = watcher ? InteractionHandler.watchPinch((picture, fingers) => watcher(picture, fingers, seen, canvas)) : () => undefined;
    let handler;
    if (platform === 'android') {
        const { FeaturedInteractionHandler } = require('../src/app/interactionHandler/FeaturedInteractionHandler');
        handler = new FeaturedInteractionHandler(phone, { sendMessage: (message) => sent.push(Buffer.from(message.toBuffer()).toString('hex')) });
    } else {
        const { CoreDeviceInteractionHandler } = require('../src/app/applDevice/CoreDeviceInteractionHandler');
        handler = new CoreDeviceInteractionHandler(phone, {
            sendTouch: (op, x, y) => sent.push(JSON.stringify({ op, x, y })),
            sendContacts: (contacts) => sent.push(JSON.stringify(contacts)),
        });
    }
    try {
        ctrlDrag(handler, canvas);
    } finally {
        handler.release();
        unwatch();
    }
    return { sent, seen };
}

test('the pinch code tells the layer both fingers, in video pixels, mirrored through the middle', () => {
    for (const platform of ['android', 'ios']) {
        const { sent, seen } = pinchOn(platform, (picture, fingers, seen, canvas) => {
            assert.equal(picture, canvas, `${platform}: the picture the pinch is on`);
            seen.push(fingers.map(({ x, y }) => [x, y]));
        });
        assert.ok(sent.length >= 2, `${platform}: the pinch reached the phone`);
        assert.ok(seen.length >= 2, `${platform}: the layer heard it as it moved (${seen.length})`);
        for (const [finger, mirror] of seen) {
            assert.ok(Math.abs(finger[0] + mirror[0] - PINCH_VIDEO[0]) <= 2 && Math.abs(finger[1] + mirror[1] - PINCH_VIDEO[1]) <= 2, `${platform}: ${finger} and ${mirror} are mirrored`);
        }
        assert.ok(Math.abs(seen[0][0][0] - 180) <= 1 && Math.abs(seen[0][0][1] - 320) <= 1, `${platform}: the first finger is where the press was (${seen[0][0]})`);
    }
});

test('the pinch sends the same with a watcher as without one, even one that fails', () => {
    const errors = console.error;
    console.error = () => undefined;
    try {
        for (const platform of ['android', 'ios']) {
            const alone = pinchOn(platform).sent;
            const watched = pinchOn(platform, (picture, fingers, seen) => seen.push(fingers.length)).sent;
            const failing = pinchOn(platform, () => {
                throw new Error('a watcher that fails');
            }).sent;
            assert.ok(alone.length >= 2);
            assert.deepEqual(watched, alone, `${platform}: a watcher changes nothing that is sent`);
            assert.deepEqual(failing, alone, `${platform}: nor does one that fails`);
        }
    } finally {
        console.error = errors;
    }
});

// ---------------------------------------------------------------- which pointers the phone gets

/**
 * One kind of phone's input on a picture, with what it sends. `fingers()` is the number of
 * fingers the phone has after the last message; `record.sent` counts every message.
 */
function phoneInput(platform) {
    const { canvas, player: phone } = player();
    const record = { sent: 0, frames: [], touches: new Set() };
    let handler;
    if (platform === 'android') {
        const { FeaturedInteractionHandler } = require('../src/app/interactionHandler/FeaturedInteractionHandler');
        handler = new FeaturedInteractionHandler(phone, {
            sendMessage: (message) => {
                record.sent++;
                // A touch's pointer: down (0) puts it on the phone, up (1) lifts it.
                if (message.action === 0) record.touches.add(message.pointerId);
                if (message.action === 1) record.touches.delete(message.pointerId);
            },
        });
    } else {
        const { CoreDeviceInteractionHandler } = require('../src/app/applDevice/CoreDeviceInteractionHandler');
        handler = new CoreDeviceInteractionHandler(phone, {
            sendTouch: () => record.sent++,
            sendContacts: (contacts) => {
                record.sent++;
                record.frames.push(contacts.filter((contact) => contact.touching).length);
            },
        });
    }
    const point = (index) => ({ clientX: PINCH_BOX.left + 20 + 30 * index, clientY: PINCH_BOX.top + 40 + 50 * index });
    const touches = (ids) => ids.map((identifier, index) => ({ identifier, target: canvas, force: 1, ...point(index) }));
    return {
        record,
        fingers: () => (platform === 'android' ? record.touches.size : (record.frames.at(-1) ?? 0)),
        touch: (type, ids) => {
            handler.onInteraction(new TouchEvent(type, { target: canvas, changedTouches: touches(ids) }));
            flush();
        },
        mouse: (type) => {
            const event = new MouseEvent(type, { target: canvas, button: 0, buttons: type === 'mouseup' ? 0 : 1, ...point(0) });
            if (type === 'mousedown') handler.onInteraction(event);
            else window.dispatch(type, event);
            flush();
        },
        release: () => handler.release(),
    };
}

test('each handler takes the fingers and presses that TOUCH_RULES says the layer draws', () => {
    const warn = console.warn;
    console.warn = () => undefined;
    try {
        let next = 100;
        const ids = (count) => Array.from({ length: count }, () => next++);
        for (const platform of ['android', 'ios']) {
            const rules = TOUCH_RULES[platform];

            // Six fingers at once: the phone gets as many as it holds.
            let input = phoneInput(platform);
            const six = ids(6);
            input.touch('touchstart', six);
            assert.equal(input.fingers(), Math.min(6, rules.fingers), `${platform}: six fingers down`);
            input.touch('touchend', six);
            input.release();

            // A finger while the mouse's button is held.
            input = phoneInput(platform);
            input.mouse('mousedown');
            let before = input.record.sent;
            const one = ids(1);
            input.touch('touchstart', one);
            assert.equal(input.record.sent > before, rules.fingersWithMouse, `${platform}: a finger with the button held`);
            input.touch('touchend', one);
            input.mouse('mouseup');
            input.release();

            // A press of the mouse while a finger is down.
            input = phoneInput(platform);
            const finger = ids(1);
            input.touch('touchstart', finger);
            before = input.record.sent;
            input.mouse('mousedown');
            assert.equal(input.record.sent > before, rules.fingersWithMouse, `${platform}: a press with a finger down`);
            input.mouse('mouseup');
            input.touch('touchend', finger);
            input.release();

            // A finger that moves on the picture while the phone has no touch of it.
            input = phoneInput(platform);
            const moving = ids(1);
            input.touch('touchmove', moving);
            assert.equal(input.fingers() > 0, rules.moveStartsTouch, `${platform}: a move without a down`);
            input.touch('touchend', moving);
            input.release();
        }
    } finally {
        console.warn = warn;
    }
});
