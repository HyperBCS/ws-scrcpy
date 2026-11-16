// node scripts/test-browser.js show-touches      (E2E_OUT=<dir> keeps screenshots)
// Show touches on the screen of both kinds of phone, against fixture sockets: nothing reaches a
// phone. For an Android phone and an iPhone, at 440x956 with touch and at 1440x900 with a mouse,
// light and dark, with motion reduced:
//   - off by default: no layer, no listener on the mount node, no circle during any press;
//   - on from Settings (Keyboard, Touch), at once, and kept in this browser;
//   - one circle under one pointer at the pointer's place within 1 px, following it;
//   - two circles for two fingers, and for the two fingers of a Ctrl+drag pinch;
//   - none after release, none for a press beside the picture, none for a right-click or for
//     Ctrl held over the picture without a press;
//   - a drag that leaves the picture keeps its circle on the edge, where the phone has the touch;
//   - the layer lies over the picture, takes no press (`pointer-events: none`) and is hidden from
//     assistive technology;
//   - the same messages on the stream socket with the switch on as with it off;
//   - one stream socket and the same mount node through all of it, and off again from Settings
//     takes the layer and its listeners away.
// Without reduced motion a circle fades when its pointer is let go. In light only: a pointer held
// while the window turns or gets smaller keeps its circle on its point of the picture; presses at
// 956x440, 320x956 (bands above and below) and 1024x700 and beside Type text docked; the controls'
// shield lies over a circle; Files takes the circles away. On a computer with a touch screen and a
// mouse: the circles follow what each kind of phone takes (`TOUCH_RULES`), and go on a lost
// window, a cancelled touch and a hidden page; the switch is also in the list card's Settings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { settleMotion } = require('./ui-motion');

// Only through test-browser.js, which serves the build on a port of its own. Without it this
// would open streams on the live server.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js show-touches');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT;

const PIXEL = 'SHOW-TOUCHES-PIXEL-0001';
const IPHONE = 'SHOW-TOUCHES-IPHONE-0001';
const KEY = 'ws-scrcpy.screen.show-touches';
const HINT = 'A circle where you touch the picture. This browser only.';
// Taller than the stage at both sizes, so the picture leaves a band on each side of it.
const VIDEO = { android: { width: 720, height: 1800 }, ios: { width: 400, height: 1000 } };
const ANDROID = {
    udid: PIXEL, state: 'device', pid: 123, interfaces: [], 'ro.product.model': 'Pixel 9', 'ro.product.manufacturer': 'Google',
    'ro.build.version.release': '16', 'ro.build.version.sdk': '36', 'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'on', 'device.awake': true, 'battery.level': 80, 'battery.charging': false,
};
const IOS = {
    udid: IPHONE, name: 'Bench iPhone', model: 'iPhone 17 Pro Max', version: '27.2', state: 'Connected', paired: true, developerMode: true,
    session: 'ready', 'screen.power': 'on', 'device.locked': false, 'last.update.timestamp': Date.now(),
    unlockSchedule: { enabled: false, time: '03:00', hasPasscode: false, serverTimeZone: 'UTC' },
};
const TOUCH = { name: 'touch', width: 440, height: 956, mobile: true };
const MOUSE = { name: 'mouse', width: 1440, height: 900, mobile: false };
// A computer with a touch screen and a mouse, with Show touches already on in this browser.
const BOTH = { name: 'touch and mouse', width: 1440, height: 900, mobile: false, touch: true, on: true };
const MOUNT_EVENTS = ['mousedown', 'touchcancel', 'touchend', 'touchmove', 'touchstart'];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const packet = Buffer.alloc(5 + body.length);
    packet[0] = 32;
    packet.writeUInt32LE(id, 1);
    body.copy(packet, 5);
    return packet;
}

// The synthetic packet WebsocketProxy sends: name, one display, ScreenInfo, VideoSettings, client id.
function initialPacket({ width, height }) {
    const packet = Buffer.alloc(186);
    packet.write('scrcpy_initial');
    packet.write('Show touches fixture', 14);
    for (const [at, value] of [[78, 1], [86, width], [90, height], [110, 25], [122, width], [126, height], [130, width], [134, height], [139, 35], [143, 4000000], [147, 60], [182, 1]]) {
        packet.writeInt32BE(value, at);
    }
    packet.writeInt8(1, 151);
    packet.writeInt8(-1, 165);
    return packet;
}

/**
 * What the page sent on the stream socket, less what the video asks for itself (a key frame:
 * Android's RESET_VIDEO, the iPhone's `pli`), which comes from the decoder and not from input.
 */
function input(test) {
    return test.sent.filter((message) => (test.platform === 'android' ? message !== '11' : !message.includes('"type":"pli"')));
}

/** A phone's screen on the fixture server. `sent` is every message on its stream socket. */
async function start(browser, platform, viewport, theme) {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile || !!viewport.touch,
        colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block',
    });
    // Once for the tab: a change made later in the page is kept through a reload.
    if (viewport.on) {
        await context.addInitScript((key) => {
            if (!sessionStorage.getItem(key)) {
                sessionStorage.setItem(key, 'seeded');
                localStorage.setItem(key, '1');
            }
        }, KEY);
    }
    // A picture for the iPhone: the socket announces a codec and sends key frames, and this
    // decoder turns each into a frame of the phone's size.
    await context.addInitScript(({ width, height }) => {
        window.VideoDecoder = class {
            static async isConfigSupported() {
                return { supported: true };
            }
            constructor({ output }) {
                this.output = output;
                this.state = 'unconfigured';
            }
            configure() {
                this.state = 'configured';
            }
            decode(chunk) {
                const canvas = new window.OffscreenCanvas(width, height);
                canvas.getContext('2d').fillRect(0, 0, width, height);
                this.output(new window.VideoFrame(canvas, { timestamp: chunk.timestamp }));
            }
            close() {
                this.state = 'closed';
            }
        };
    }, VIDEO.ios);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const test = { context, page, cdp, platform, mobile: viewport.mobile, label: `${platform} ${viewport.name} ${theme}`, errors: [], sent: [], streams: 0, on: !!viewport.on };
    page.on('pageerror', (error) => test.errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => route.fulfill({ json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        const action = new URL(socket.url()).searchParams.get('action');
        if (action === 'proxy-adb') {
            test.streams++;
            socket.onMessage((data) => test.sent.push(Buffer.from(data).toString('hex')));
            setTimeout(() => socket.send(initialPacket(VIDEO.android)), 40);
            return;
        }
        if (action === 'proxy-coredevice') {
            test.streams++;
            let live = true;
            socket.onClose(() => {
                live = false;
            });
            socket.onMessage((data) => {
                if (typeof data === 'string') test.sent.push(data);
            });
            setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 40);
            setTimeout(() => socket.send(JSON.stringify({ type: 'codec', codec: 'hev1.1.6.L150.B0', description: Buffer.from([1]).toString('base64') })), 70);
            // A key frame now and then: the first may come before the decoder is ready.
            const keyFrame = () => {
                if (!live || page.isClosed()) return;
                socket.send(Buffer.from([0, 0, 0, 0, 1, 0x26]));
                setTimeout(keyFrame, 250).unref();
            };
            setTimeout(keyFrame, 120);
            return;
        }
        socket.onMessage((data) => {
            const packet = Buffer.from(data);
            if (packet.length < 5 || packet[0] !== 4) return;
            const id = packet.readUInt32LE(1);
            const code = packet.subarray(5, 9).toString();
            const send = (message) => socket.send(channelJson(id, message));
            if (code === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } });
            if (code === 'GTRC') send({ id: -1, type: 'devicelist', data: { id: 'android', name: 'Fixture host', list: [ANDROID] } });
            if (code === 'ATRC') send({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Fixture host', list: [IOS] } });
        });
    });
    await page.goto(`${BASE}#!action=device&udid=${platform === 'android' ? PIXEL : IPHONE}&view=screen`);
    await page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.includes('Connected'));
    await page.waitForFunction(
        ({ width, height }) => {
            const canvas = document.querySelector('.stream-mount canvas.touch-layer');
            return canvas?.width === width && canvas?.height === height;
        },
        VIDEO[platform],
    );
    await settleMotion(page);
    await page.evaluate(() => {
        window.__showTouches = { mount: document.querySelector('.stream-mount'), canvas: document.querySelector('.stream-mount canvas.touch-layer') };
    });
    return test;
}

/** The picture on the page: the touch layer's box, and the width of the band beside it. */
function picture(page) {
    return page.evaluate(() => {
        const canvas = document.querySelector('.stream-mount canvas.touch-layer');
        const box = canvas.getBoundingClientRect();
        const area = canvas.parentElement.getBoundingClientRect();
        return { left: box.left, top: box.top, width: canvas.clientWidth, height: canvas.clientHeight, band: box.left - area.left };
    });
}
const at = (box, fx, fy) => ({ x: Math.round(box.left + fx * box.width), y: Math.round(box.top + fy * box.height) });
/** Where a Ctrl+drag puts its second finger: the pointer mirrored through the middle of the picture. */
const mirror = (box, point) => ({ x: 2 * box.left + box.width - point.x, y: 2 * box.top + box.height - point.y });
const left = (box, y) => ({ x: Math.round(box.left - box.band / 2), y });

/** Waits two frames, so a move the input sends on the next frame has been sent and drawn. */
const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** What the press lands on: the picture, or the band beside it. Nothing else may be in the way. */
async function landsOn(test, point, what) {
    const target = await test.page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        const canvas = window.__showTouches.canvas;
        return hit === canvas ? 'picture' : hit === canvas.parentElement ? 'band' : hit?.className || String(hit);
    }, point);
    assert.equal(target, what, `${test.label}: the press at ${point.x},${point.y} lands on the ${what}`);
}

/**
 * The circles on the page now. With the switch off there must be none, and no layer at all. With
 * it on, one within 1 px of each point, and no other.
 */
async function expectMarks(test, points, what) {
    const { page } = test;
    await frames(page);
    const found = await page.evaluate(() =>
        [...document.querySelectorAll('.touch-mark')].map((mark) => {
            const box = mark.getBoundingClientRect();
            return { x: box.left + box.width / 2, y: box.top + box.height / 2, pointerEvents: getComputedStyle(mark).pointerEvents };
        }),
    );
    const label = `${test.label} (${test.on ? 'on' : 'off'}): ${what}`;
    if (!test.on) {
        assert.deepEqual(found, [], `${label}: no circle while the switch is off`);
        assert.equal(await page.locator('.touch-marks').count(), 0, `${label}: no layer while the switch is off`);
        return;
    }
    assert.equal(found.length, points.length, `${label}: ${points.length} circle(s), found ${JSON.stringify(found)}`);
    for (const point of points) {
        assert.ok(
            found.some((mark) => Math.abs(mark.x - point.x) <= 1 && Math.abs(mark.y - point.y) <= 1),
            `${label}: a circle within 1 px of ${point.x},${point.y} (found ${JSON.stringify(found)})`,
        );
    }
    assert.ok(found.every((mark) => mark.pointerEvents === 'none'), `${label}: a circle takes no press`);
}

/** Runs one gesture and returns what it sent on the stream socket, once the page has gone quiet. */
async function gesture(test, name, steps) {
    const before = test.sent.length;
    for (const step of steps) {
        await step();
        await pause(40);
    }
    await pause(150);
    return [name, input({ ...test, sent: test.sent.slice(before) })];
}

/** Every touch gesture, with the circles each step must show. */
async function touchGestures(test) {
    const { page, cdp } = test;
    const box = await picture(page);
    assert.ok(box.band > 8, `${test.label}: the picture has a band beside it (${box.band.toFixed(1)} px)`);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(({ x, y }, id) => ({ id: id + 1, x, y, force: 1 })) });
    const sent = [];
    const one = at(box, 0.3, 0.35);
    const moved = at(box, 0.6, 0.55);
    await landsOn(test, one, 'picture');
    sent.push(await gesture(test, 'one finger', [
        () => touch('touchStart', [one]),
        () => expectMarks(test, [one], 'one finger down'),
        async () => {
            if (test.on) await landsOn(test, one, 'picture');
        },
        () => touch('touchMove', [moved]),
        () => expectMarks(test, [moved], 'the finger moved'),
        () => touch('touchEnd', []),
        () => expectMarks(test, [], 'the finger let go'),
    ]));
    const a = at(box, 0.25, 0.3);
    const b = at(box, 0.7, 0.65);
    const a2 = at(box, 0.3, 0.35);
    const b2 = at(box, 0.65, 0.6);
    await landsOn(test, a, 'picture');
    await landsOn(test, b, 'picture');
    sent.push(await gesture(test, 'two fingers', [
        () => touch('touchStart', [a, b]),
        () => expectMarks(test, [a, b], 'two fingers down'),
        () => touch('touchMove', [a2, b2]),
        () => expectMarks(test, [a2, b2], 'two fingers moved'),
        () => touch('touchEnd', []),
        () => expectMarks(test, [], 'two fingers let go'),
    ]));
    const middle = at(box, 0.5, 0.5).y;
    const beside = left(box, middle);
    await landsOn(test, beside, 'band');
    sent.push(await gesture(test, 'a tap beside the picture', [
        () => touch('touchStart', [beside]),
        () => expectMarks(test, [], 'a finger beside the picture'),
        () => touch('touchEnd', []),
        () => expectMarks(test, [], 'let go beside the picture'),
    ]));
    const onto = at(box, 0.15, 0.5);
    const further = at(box, 0.3, 0.5);
    sent.push(await gesture(test, 'an edge swipe', [
        () => touch('touchStart', [beside]),
        () => expectMarks(test, [], 'an edge swipe starts beside the picture'),
        () => touch('touchMove', [onto]),
        () => expectMarks(test, [onto], 'the swipe reaches the picture'),
        () => touch('touchMove', [further]),
        () => expectMarks(test, [further], 'the swipe goes on'),
        () => touch('touchEnd', []),
        () => expectMarks(test, [], 'the swipe let go'),
    ]));
    const inside = at(box, 0.15, 0.7);
    const off = left(box, inside.y);
    await landsOn(test, inside, 'picture');
    sent.push(await gesture(test, 'a finger that slides off the picture', [
        () => touch('touchStart', [inside]),
        () => expectMarks(test, [inside], 'near the left edge'),
        () => touch('touchMove', [off]),
        () => expectMarks(test, [{ x: box.left, y: inside.y }], 'slid off: on the left edge'),
        () => touch('touchEnd', []),
        () => expectMarks(test, [], 'let go beside the picture'),
    ]));
    return sent;
}

/** Every mouse gesture, with the circles each step must show. */
async function mouseGestures(test) {
    const { page } = test;
    const box = await picture(page);
    assert.ok(box.band > 8, `${test.label}: the picture has a band beside it (${box.band.toFixed(1)} px)`);
    const { mouse, keyboard } = page;
    const move = ({ x, y }) => mouse.move(x, y);
    const sent = [];
    const one = at(box, 0.3, 0.35);
    const moved = at(box, 0.6, 0.55);
    await landsOn(test, one, 'picture');
    sent.push(await gesture(test, 'a press and a drag', [
        () => move(one),
        () => expectMarks(test, [], 'the pointer over the picture, no button'),
        () => mouse.down(),
        () => expectMarks(test, [one], 'the button down'),
        async () => {
            if (test.on) await landsOn(test, one, 'picture');
        },
        () => move(moved),
        () => expectMarks(test, [moved], 'the pointer moved'),
        () => mouse.up(),
        () => expectMarks(test, [], 'the button let go'),
    ]));
    const middle = at(box, 0.5, 0.5).y;
    const beside = left(box, middle);
    await landsOn(test, beside, 'band');
    sent.push(await gesture(test, 'a press beside the picture', [
        () => move(beside),
        () => mouse.down(),
        () => expectMarks(test, [], 'the button down beside the picture'),
        () => move(at(box, 0.3, 0.5)),
        () => expectMarks(test, [], 'moved onto the picture: still nothing'),
        () => mouse.up(),
        () => expectMarks(test, [], 'let go'),
    ]));
    const inside = at(box, 0.15, 0.7);
    const off = left(box, inside.y);
    const above = { x: off.x, y: Math.round(box.top - 10) };
    sent.push(await gesture(test, 'a drag that leaves the picture', [
        () => move(inside),
        () => mouse.down(),
        () => expectMarks(test, [inside], 'near the left edge'),
        () => move(off),
        () => expectMarks(test, [{ x: box.left, y: inside.y }], 'on the left edge'),
        () => move(above),
        () => expectMarks(test, [{ x: box.left, y: box.top }], 'in the top left corner'),
        () => mouse.up(),
        () => expectMarks(test, [], 'let go above the picture'),
    ]));
    const pinch = at(box, 0.25, 0.25);
    const pinched = at(box, 0.4, 0.35);
    sent.push(await gesture(test, 'a Ctrl+drag pinch', [
        () => keyboard.down('Control'),
        () => move(pinch),
        () => expectMarks(test, [], 'Ctrl held over the picture, no button'),
        () => mouse.down(),
        () => expectMarks(test, [pinch, mirror(box, pinch)], 'both fingers of the pinch'),
        () => move(pinched),
        () => expectMarks(test, [pinched, mirror(box, pinched)], 'both fingers moved'),
        () => mouse.up(),
        () => expectMarks(test, [], 'both fingers let go'),
        () => keyboard.up('Control'),
    ]));
    // A scroll on Android, a short swipe on an iPhone. It is not a pointer that is down, so no circle.
    sent.push(await gesture(test, 'a wheel', [
        () => move(one),
        () => mouse.wheel(0, 120),
        () => expectMarks(test, [], 'the wheel'),
        // The iPhone's swipe takes five moves of 20 ms and a rest of 100 ms before it lifts.
        () => pause(300),
    ]));
    sent.push(await gesture(test, 'a right-click', [
        () => move(one),
        () => mouse.down({ button: 'right' }),
        () => expectMarks(test, [], 'the right button down'),
        () => mouse.up({ button: 'right' }),
        () => expectMarks(test, [], 'let go'),
    ]));
    return sent;
}

/** The types of the listeners on the mount node that Show touches would add. */
async function mountListeners(test) {
    const { result } = await test.cdp.send('Runtime.evaluate', { expression: 'document.querySelector(".stream-mount")' });
    const { listeners } = await test.cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    await test.cdp.send('Runtime.releaseObject', { objectId: result.objectId });
    return listeners.map((listener) => listener.type).filter((type) => MOUNT_EVENTS.includes(type)).sort();
}

async function openSettings(test) {
    const { page } = test;
    const press = (locator) => (test.mobile ? locator.tap() : locator.click());
    if (test.mobile) {
        await press(page.locator('.floating-toolbar-fab'));
        await page.locator('.floating-toolbar.open').waitFor();
        await settleMotion(page);
    }
    await press(page.locator('.control-buttons-list [title="Settings"]'));
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.waitFor();
    await settleMotion(page);
    return dialog;
}

async function closeSettings(test) {
    const { page } = test;
    await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
    await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' });
    await settleMotion(page);
    if (await page.locator('.floating-toolbar.open').count()) {
        await page.keyboard.press('Escape');
        await page.locator('.floating-toolbar.open').waitFor({ state: 'detached' });
        await settleMotion(page);
    }
}

/** Turns the switch in Settings, checks its place and words, and that it applies at once. */
async function turn(test, on) {
    const { page } = test;
    const dialog = await openSettings(test);
    const group = dialog.locator('[data-section="keyboard"] section.kit-group.settings-touches');
    await group.scrollIntoViewIfNeeded();
    const titles = await dialog
        .locator('[data-section="keyboard"] > section.kit-group')
        .evaluateAll((groups) => groups.map((node) => node.querySelector(':scope > .kit-group-title')?.textContent ?? ''));
    assert.deepEqual(titles.slice(-2), ['Keyboard shortcuts', 'Touch'], `${test.label}: a group of its own after the shortcuts`);
    assert.equal(await group.locator('.kit-group-hint').textContent(), HINT);
    const toggle = group.getByRole('switch', { name: 'Show touches', exact: true });
    assert.equal(await toggle.isChecked(), !on, `${test.label}: the switch shows the current state`);
    if (OUT && on) {
        fs.mkdirSync(OUT, { recursive: true });
        await page.screenshot({ path: path.join(OUT, `${test.label.replace(/ /g, '-')}-settings.png`) });
    }
    if (test.mobile) await toggle.tap();
    else await toggle.click();
    assert.equal(await toggle.isChecked(), on);
    // At once, with the sheet still open.
    await page.locator('.touch-marks').waitFor({ state: on ? 'attached' : 'detached' });
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), on ? '1' : null, `${test.label}: kept in this browser`);
    await closeSettings(test);
    test.on = on;
}

/** The layer: over the picture, takes no press, hidden from assistive technology, with `circles` in it. */
async function checkLayer(test, circles = 0) {
    const layer = await test.page.evaluate(() => {
        const node = document.querySelector('.touch-marks');
        const canvas = window.__showTouches.canvas;
        const own = node.getBoundingClientRect();
        const box = canvas.getBoundingClientRect();
        return {
            pointerEvents: getComputedStyle(node).pointerEvents,
            hidden: node.getAttribute('aria-hidden'),
            tabindex: node.getAttribute('tabindex'),
            focusable: node.tabIndex >= 0,
            children: node.children.length,
            stage: node.parentElement.classList.contains('stream-stage'),
            offsets: [own.left - box.left, own.top - box.top, own.width - box.width, own.height - box.height],
        };
    });
    assert.equal(layer.pointerEvents, 'none', `${test.label}: the layer takes no press`);
    assert.equal(layer.hidden, 'true', `${test.label}: hidden from assistive technology`);
    assert.equal(layer.tabindex, null);
    assert.equal(layer.focusable, false, `${test.label}: never takes focus`);
    assert.equal(layer.children, circles, `${test.label}: ${circles} circle(s) in the layer`);
    assert.equal(layer.stage, true, `${test.label}: on the stage, beside the mount node`);
    assert.ok(layer.offsets.every((offset) => Math.abs(offset) <= 1), `${test.label}: over the picture (${layer.offsets})`);
}

/** Without reduced motion, a circle fades where it was let go and is then gone. */
async function fades(test) {
    const { page, cdp } = test;
    const box = await picture(page);
    const point = at(box, 0.4, 0.4);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    try {
        if (test.mobile) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...point, force: 1 }] });
            await frames(page);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
            await page.mouse.move(point.x, point.y);
            await page.mouse.down();
            await frames(page);
            await page.mouse.up();
        }
        await pause(60);
        const fading = await page.evaluate(() => [...document.querySelectorAll('.touch-mark')].map((mark) => Number(getComputedStyle(mark).opacity)));
        assert.equal(fading.length, 1, `${test.label}: the circle is still there just after it was let go`);
        assert.ok(fading[0] > 0 && fading[0] < 1, `${test.label}: and fading (${fading[0]})`);
        await page.waitForFunction(() => !document.querySelector('.touch-mark'), undefined, { timeout: 2000 });
    } finally {
        await page.emulateMedia({ reducedMotion: 'reduce' });
    }
}

/** Pictures of the circles over a white and over a black picture, for a person to look at. */
async function pictures(test) {
    if (!OUT) return;
    const { page, cdp } = test;
    fs.mkdirSync(OUT, { recursive: true });
    const box = await picture(page);
    const points = [at(box, 0.3, 0.3), at(box, 0.6, 0.5)];
    const style = await page.addStyleTag({ content: '/* the picture in one colour */' });
    for (const [name, colour] of [['white', '255, 255, 255'], ['black', '0, 0, 0']]) {
        await style.evaluate((node, colour) => {
            node.textContent = `.stream-mount canvas.touch-layer { background-color: rgb(${colour}) !important; } .stream-mount .video-layer { visibility: hidden; }`;
        }, colour);
        if (test.mobile) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points.map((point, id) => ({ id: id + 1, ...point, force: 1 })) });
        } else {
            await page.keyboard.down('Control');
            await page.mouse.move(points[0].x, points[0].y);
            await page.mouse.down();
        }
        await frames(page);
        await page.screenshot({ path: path.join(OUT, `${test.label.replace(/ /g, '-')}-over-${name}.png`) });
        if (test.mobile) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
            await page.mouse.up();
            await page.keyboard.up('Control');
        }
        await frames(page);
    }
    await style.evaluate((node) => node.remove());
}

/** Waits until the picture has its place after the window changed; the players lay out again after a wait of their own. */
async function settled(page) {
    let last = '';
    for (let tries = 0; tries < 30; tries++) {
        await pause(150);
        const box = JSON.stringify(await picture(page));
        if (box === last) return;
        last = box;
    }
    throw new Error('The picture did not settle');
}

/** Where a point of the picture, as a share of its width and height, is on the page now. */
async function sharePoint(page, share) {
    const box = await picture(page);
    return { x: box.left + share.fx * box.width, y: box.top + share.fy * box.height };
}
const shareOf = (box, point) => ({ fx: (point.x - box.left) / box.width, fy: (point.y - box.top) / box.height });

/**
 * What lies at a point, top first, among the picture, the layer, a circle and the controls'
 * shield. The layer takes no press, so it is made to take them for this one look.
 */
function stackAt(page, point) {
    return page.evaluate(({ x, y }) => {
        const style = document.createElement('style');
        style.textContent = '.touch-marks, .touch-mark { pointer-events: auto !important; }';
        document.head.append(style);
        const names = { 'touch-mark': 'circle', 'touch-marks': 'layer', 'touch-layer': 'picture', 'floating-toolbar-shield': 'shield' };
        const stack = document.elementsFromPoint(x, y).flatMap((node) => Object.keys(names).filter((name) => node.classList.contains(name)).map((name) => names[name]));
        style.remove();
        return stack;
    }, point);
}

/**
 * Touch, light only: a finger held while the window turns, bands above and below the picture in a
 * narrow window, and the controls' shield over a circle.
 */
async function touchPlaces(test) {
    const { page, cdp } = test;
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(({ x, y }, id) => ({ id: id + 1, x, y, force: 1 })) });
    const sentBefore = test.sent.length;

    // The window turns with a finger held: the phone keeps the touch where it was on the picture.
    let box = await picture(page);
    const held = at(box, 0.3, 0.4);
    const share = shareOf(box, held);
    await touch('touchStart', [held]);
    await expectMarks(test, [held], 'a finger held');
    await page.setViewportSize({ width: TOUCH.height, height: TOUCH.width });
    await settled(page);
    await expectMarks(test, [await sharePoint(page, share)], 'the window turned with the finger held: on the same point of the picture');
    await checkLayer(test, 1);
    await touch('touchEnd', []);
    await expectMarks(test, [], 'let go after the turn');
    box = await picture(page);
    assert.ok(box.band > 8, `${test.label}: bands beside the picture in landscape (${box.band.toFixed(1)} px)`);
    const landscape = at(box, 0.7, 0.3);
    await landsOn(test, landscape, 'picture');
    await touch('touchStart', [landscape]);
    await expectMarks(test, [landscape], 'a finger in landscape');
    await touch('touchEnd', []);
    await landsOn(test, left(box, landscape.y), 'band');
    await touch('touchStart', [left(box, landscape.y)]);
    await expectMarks(test, [], 'a finger beside the picture in landscape');
    await touch('touchEnd', []);

    // A window narrower than the picture's shape: the bands are above and below it.
    await page.setViewportSize({ width: 320, height: TOUCH.height });
    await settled(page);
    box = await picture(page);
    const top = await page.evaluate(() => {
        const canvas = window.__showTouches.canvas;
        return canvas.getBoundingClientRect().top - canvas.parentElement.getBoundingClientRect().top;
    });
    assert.ok(top > 8 && box.band < 1, `${test.label}: bands above and below the picture (${top.toFixed(1)} px)`);
    const above = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top - top / 2) };
    await landsOn(test, above, 'band');
    await touch('touchStart', [above]);
    await expectMarks(test, [], 'a finger above the picture');
    await touch('touchEnd', []);
    const narrow = at(box, 0.4, 0.1);
    await touch('touchStart', [narrow]);
    await expectMarks(test, [narrow], 'a finger near the top of the picture');
    await touch('touchEnd', []);
    await page.setViewportSize({ width: TOUCH.width, height: TOUCH.height });
    await settled(page);

    // The controls open over a held finger: their shield lies over the circle, the circle over the picture.
    box = await picture(page);
    const under = at(box, 0.5, 0.5);
    await touch('touchStart', [under]);
    await expectMarks(test, [under], 'a finger held before the controls open');
    assert.deepEqual(await stackAt(page, under), ['circle', 'layer', 'picture'], `${test.label}: the circle lies over the picture`);
    await page.locator('.floating-toolbar-fab').click();
    await page.locator('.floating-toolbar.open').waitFor();
    await settleMotion(page);
    assert.deepEqual(await stackAt(page, under), ['shield', 'circle', 'layer', 'picture'], `${test.label}: the controls' shield lies over the circle`);
    await page.keyboard.press('Escape');
    await page.locator('.floating-toolbar.open').waitFor({ state: 'detached' });
    await settleMotion(page);
    await touch('touchEnd', []);
    await expectMarks(test, [], 'let go after the controls closed');
    assert.ok(test.sent.length > sentBefore, `${test.label}: the held fingers reached the phone`);
}

/**
 * Mouse, light only: the button held while the window gets smaller, a press at 1024x700, and a
 * press with Type text docked beside the picture.
 */
async function mousePlaces(test) {
    const { page } = test;
    let box = await picture(page);
    const held = at(box, 0.35, 0.45);
    const share = shareOf(box, held);
    await page.mouse.move(held.x, held.y);
    await page.mouse.down();
    await expectMarks(test, [held], 'the button held');
    await page.setViewportSize({ width: 1024, height: 700 });
    await settled(page);
    await expectMarks(test, [await sharePoint(page, share)], 'the window got smaller with the button held: on the same point of the picture');
    await checkLayer(test, 1);
    await page.mouse.up();
    await expectMarks(test, [], 'let go after the resize');
    box = await picture(page);
    assert.ok(box.band > 8, `${test.label}: bands beside the picture at 1024x700 (${box.band.toFixed(1)} px)`);
    const small = at(box, 0.65, 0.75);
    await landsOn(test, small, 'picture');
    await page.mouse.move(small.x, small.y);
    await page.mouse.down();
    await expectMarks(test, [small], 'a press at 1024x700');
    await page.mouse.up();
    await page.setViewportSize({ width: MOUSE.width, height: MOUSE.height });
    await settled(page);

    // Type text stands beside the picture and leaves it in use.
    await page.locator('.control-buttons-list [title="Type text"]').click();
    await page.locator('.stream-stage[data-sheet-docked]').waitFor();
    await settleMotion(page);
    await settled(page);
    await checkLayer(test);
    box = await picture(page);
    const docked = at(box, 0.6, 0.4);
    await landsOn(test, docked, 'picture');
    await page.mouse.move(docked.x, docked.y);
    await page.mouse.down();
    await expectMarks(test, [docked], 'a press with Type text docked');
    await page.mouse.up();
    await expectMarks(test, [], 'let go with Type text docked');
    await page.getByRole('button', { name: 'Close Type text', exact: true }).click();
    await page.locator('.stream-stage[data-sheet-docked]').waitFor({ state: 'detached' });
    await settleMotion(page);
    await settled(page);
}

/**
 * A computer with a touch screen and a mouse, where the two kinds of phone take different
 * pointers (`TOUCH_RULES` in src/app/input/touchMarks.ts): a circle for each pointer the phone
 * gets and none for one it does not. Then a lost window, a cancelled touch and a hidden page,
 * and the switch in the Settings of the list's card.
 */
async function rulesRun(browser, platform) {
    const test = await start(browser, platform, BOTH, 'light');
    const { page, cdp } = test;
    const android = platform === 'android';
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(({ x, y }, id) => ({ id: id + 1, x, y, force: 1 })) });
    try {
        await page.locator('.touch-marks').waitFor({ state: 'attached' });
        await checkLayer(test);
        const box = await picture(page);
        const fingers = [0.2, 0.35, 0.5, 0.65, 0.8, 0.5].map((fx, index) => at(box, fx, 0.15 + index * 0.13));
        const mouse = at(box, 0.3, 0.3);
        const finger = at(box, 0.7, 0.7);
        const moved = at(box, 0.6, 0.6);

        // Six fingers: an iPhone takes five.
        let before = test.sent.length;
        await touch('touchStart', fingers);
        await expectMarks(test, android ? fingers : fingers.slice(0, 5), 'six fingers');
        if (!android) {
            await pause(100);
            const frames = input({ ...test, sent: test.sent.slice(before) }).filter((message) => message.includes('"touch-frame"'));
            assert.equal(JSON.parse(frames.at(-1)).contacts.filter((contact) => contact.touching).length, 5, `${test.label}: the phone has five fingers`);
        }
        await touch('touchEnd', []);
        await expectMarks(test, [], 'six fingers let go');

        // A finger while the button is held: an iPhone takes the one that came first.
        await page.mouse.move(mouse.x, mouse.y);
        await page.mouse.down();
        await expectMarks(test, [mouse], 'the button held');
        before = test.sent.length;
        await touch('touchStart', [finger]);
        await expectMarks(test, android ? [mouse, finger] : [mouse], 'a finger with the button held');
        if (!android) {
            await pause(100);
            assert.ok(!input({ ...test, sent: test.sent.slice(before) }).some((message) => message.includes('"touch-frame"')), `${test.label}: the finger did not reach the phone`);
        }
        await touch('touchEnd', []);
        await page.mouse.up();
        await expectMarks(test, [], 'both let go');

        // A press of the button while a finger is down.
        await touch('touchStart', [finger]);
        await page.mouse.move(mouse.x, mouse.y);
        await page.mouse.down();
        await expectMarks(test, android ? [finger, mouse] : [finger], 'a press with a finger down');
        await page.mouse.up();
        await touch('touchEnd', []);
        await expectMarks(test, [], 'both let go');

        // The window loses focus with a finger down: the input lets go. When the finger moves on,
        // Android puts it down again and an iPhone does not.
        await touch('touchStart', [finger]);
        await expectMarks(test, [finger], 'a finger');
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await expectMarks(test, [], 'the window lost focus');
        await touch('touchMove', [moved]);
        await expectMarks(test, android ? [moved] : [], 'the finger moved on after the window lost focus');
        await touch('touchEnd', []);
        await expectMarks(test, [], 'let go');

        // A touch the browser cancels.
        await touch('touchStart', [finger]);
        await expectMarks(test, [finger], 'a finger');
        await touch('touchCancel', []);
        await expectMarks(test, [], 'the touch cancelled');

        assert.equal(test.streams, 1, `${test.label}: one stream socket`);
        assert.deepEqual(test.errors, [], `${test.label}: no page error`);

        // The page is hidden with a finger down.
        await touch('touchStart', [finger]);
        await expectMarks(test, [finger], 'a finger');
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await expectMarks(test, [], 'the page hidden');
        await page.evaluate(() => {
            delete document.visibilityState;
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await touch('touchEnd', []);

        // The list's card: the same switch in Settings, turned off there.
        await page.goto(`${BASE}#!`);
        const settings = page.getByRole('button', { name: `Settings for ${android ? 'Google Pixel 9' : IOS.name}`, exact: true });
        await settings.click();
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
        await dialog.waitFor();
        await settleMotion(page);
        const group = dialog.locator('[data-section="keyboard"] section.kit-group.settings-touches');
        await group.scrollIntoViewIfNeeded();
        assert.equal(await group.locator('.kit-group-hint').textContent(), HINT);
        const toggle = group.getByRole('switch', { name: 'Show touches', exact: true });
        assert.equal(await toggle.isChecked(), true, `${test.label}: on in the list's Settings`);
        await toggle.click();
        assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), null, `${test.label}: off from the list's card`);
        await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
        await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' });
        await page.goto(`${BASE}#!action=device&udid=${android ? PIXEL : IPHONE}&view=screen`);
        await page.waitForFunction(() => document.querySelector('.stream-mount canvas.touch-layer')?.hasAttribute('width'));
        assert.equal(await page.locator('.touch-marks').count(), 0, `${test.label}: off on the screen too`);
        assert.deepEqual(test.errors, [], `${test.label}: no page error`);
        console.log(`PASS ${test.label}: circles for the pointers the phone gets, none after a lost window, a cancel or a hidden page; the switch on the list's card`);
    } finally {
        await test.context.close();
    }
}

/** Android, touch: a tab change to Files with a finger down takes the screen and its circles away. */
async function toFiles(test) {
    const { page, cdp } = test;
    const box = await picture(page);
    const point = at(box, 0.5, 0.5);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...point, force: 1 }] });
    await expectMarks(test, [point], 'a finger before Files');
    await page.locator('.kit-tab', { hasText: 'Files' }).click();
    await page.locator('.stream-mount').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.touch-mark, .touch-marks').count(), 0, `${test.label}: no circle on Files`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function run(browser, platform, viewport, theme) {
    const test = await start(browser, platform, viewport, theme);
    const { page } = test;
    const gestures = viewport.mobile ? touchGestures : mouseGestures;
    try {
        // Off by default: nothing on the page and nothing listening.
        test.on = false;
        assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), null);
        assert.equal(await page.locator('.touch-marks').count(), 0, `${test.label}: off by default`);
        assert.deepEqual(await mountListeners(test), [], `${test.label}: nothing listens while it is off`);
        const off = await gestures(test);

        await turn(test, true);
        await checkLayer(test);
        assert.deepEqual(await mountListeners(test), MOUNT_EVENTS, `${test.label}: the layer listens on the mount node, once each`);
        const on = await gestures(test);
        for (const [index, [name, messages]] of on.entries()) {
            assert.ok(!['a press and a drag', 'a wheel', 'a Ctrl+drag pinch'].includes(name) || messages.length > 0, `${test.label}: ${name} reaches the phone`);
            assert.deepEqual(messages, off[index][1], `${test.label}: ${name} sends the same with the switch on as off`);
        }
        await checkLayer(test);
        await fades(test);
        await pictures(test);
        if (theme === 'light') {
            await (viewport.mobile ? touchPlaces : mousePlaces)(test);
            await checkLayer(test);
        }

        await turn(test, false);
        assert.deepEqual(await mountListeners(test), [], `${test.label}: off again, nothing listens`);
        const again = await gestures(test);
        assert.deepEqual(again.map(([, messages]) => messages), off.map(([, messages]) => messages), `${test.label}: off again, the same messages`);

        assert.equal(test.streams, 1, `${test.label}: one stream socket through all of it`);
        assert.equal(
            await page.evaluate(() => document.querySelector('.stream-mount') === window.__showTouches.mount && window.__showTouches.canvas.isConnected),
            true,
            `${test.label}: the same mount node and picture throughout`,
        );
        assert.deepEqual(test.errors, [], `${test.label}: no page error`);
        if (platform === 'android' && viewport.mobile && theme === 'light') {
            await turn(test, true);
            await toFiles(test);
        }
        console.log(`PASS ${test.label}: off by default, on from Settings, circles under ${viewport.mobile ? 'fingers' : 'the mouse'}, none beside the picture or after release, same messages, one stream`);
    } finally {
        await test.context.close();
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const platform of ['android', 'ios']) {
            for (const viewport of [TOUCH, MOUSE]) {
                for (const theme of ['light', 'dark']) await run(browser, platform, viewport, theme);
            }
            await rulesRun(browser, platform);
        }
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
