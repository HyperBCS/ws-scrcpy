/* eslint-disable */
// node scripts/test-browser.js desktop-layout      (E2E_OUT=<dir> keeps a picture of each state)
// The screen of a phone in a desktop window (U-stream-10, owner decision D5), on the Android and
// the iPhone fixture, light and dark, at 1440x900 and 1366x650:
//   the rail of controls stands against the right edge of the picture and is as tall as it; the
//   picture and the rail are one group in the middle of the stage; one column where the height
//   allows and two at 650px; no control is cut off;
//   from 1024px Actions and Settings open as a panel at the right of the stage, as tall as it:
//   the picture keeps its size or shrinks and nothing covers or dims it, a press on the picture
//   closes the panel and reaches nothing, Escape and Back close it, focus stays inside and goes
//   back to the picture while keyboard capture is on;
//   Type text opens in the same place and is not modal: a press on the picture reaches the phone
//   and typing goes on; the rail is not cut off while it is open;
//   the panel follows the window across 1024px; Switch phone, and Settings from the list, stay
//   the centred dialog;
//   below 1024px the sheets are as before: Actions the centred dialog, Type text under the
//   picture;
//   a state card lies on the picture, centred on it and no wider than it, so the rail never
//   covers it, and its layer dims the stage evenly up to the edge or the docked panel;
//   the stage and the mount node are never built again, and each open of the screen is one
//   stream socket however often a panel opens and closes.
// Every socket is a fixture; nothing reaches a phone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const { settleMotion } = require('./ui-motion');

// Only through test-browser.js, which serves the build on a port of its own. Without it this
// would open streams on the live server.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js desktop-layout');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT;

const PIXEL = 'LAYOUT-PIXEL-0001';
const IPHONE = 'LAYOUT-IPHONE-0001';
// The fixture's iPhone decoder turns every key frame into a picture of this size.
const VIDEO = { width: 428, height: 926 };
const LARGE = { name: '1440x900', width: 1440, height: 900 };
const SHORT = { name: '1366x650', width: 1366, height: 650 };
const NARROW = { name: '1000x800', width: 1000, height: 800 };
// The gap the rail may leave beside the picture: the smallest spacing token.
const GAP = 4;
const DOCK_WIDTH = 380;
const DIALOG_WIDTH = 560;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (actual, expected, message, by = 1) =>
    assert.ok(Math.abs(actual - expected) <= by, `${message}: ${actual}, expected ${expected}`);

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

const ANDROID = {
    udid: PIXEL, state: 'device', pid: 123, interfaces: [], 'ro.product.model': 'Pixel 9', 'ro.product.manufacturer': 'Google',
    'ro.build.version.release': '16', 'ro.build.version.sdk': '36', 'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'on', 'device.awake': true, 'battery.level': 80, 'battery.charging': false,
};
const IOS = {
    udid: IPHONE, name: 'Bench iPhone', model: 'iPhone 13 Pro Max', version: '27.2', state: 'Connected', paired: true, developerMode: true,
    session: 'ready', 'screen.power': 'on', 'device.locked': false,
    unlockSchedule: { enabled: false, time: '03:00', hasPasscode: false, serverTimeZone: 'UTC' },
};
const ENCODER = 'c2.exynos.h264.encoder';
const STREAM_CONFIG = { bitrate: 3500000, maxFps: 60, maxSize: 1280, iFrameInterval: 10, videoCodec: 'h264', videoEncoder: ENCODER, audio: true, audioCodec: 'raw', audioSource: 'output' };

/**
 * A phone's screen on the fixture server, or the list with `list`. Android answers with the
 * 720x1280 picture of `initialStreamPacket`; the iPhone sends a codec and key frames that a
 * stub decoder turns into a 428x926 picture.
 */
async function start(browser, platform, viewport, colorScheme = 'light', { list = false } = {}) {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, colorScheme, serviceWorkers: 'block', reducedMotion: 'reduce',
    });
    if (platform === 'ios') {
        await context.addInitScript(({ width, height }) => {
            window.VideoDecoder = class {
                static async isConfigSupported() { return { supported: true }; }
                constructor({ output }) { this.output = output; this.state = 'unconfigured'; }
                configure() { this.state = 'configured'; }
                decode(chunk) {
                    const canvas = new window.OffscreenCanvas(width, height);
                    canvas.getContext('2d').fillRect(0, 0, width, height);
                    this.output(new window.VideoFrame(canvas, { timestamp: chunk.timestamp }));
                }
                close() { this.state = 'closed'; }
            };
        }, VIDEO);
    }
    const page = await context.newPage();
    const test = { context, page, platform, viewport, colorScheme, label: `${platform} ${viewport.name} ${colorScheme}`, errors: [], packets: [], messages: [], streams: 0 };
    page.on('pageerror', (error) => test.errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => route.fulfill({ json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        const action = new URL(socket.url()).searchParams.get('action');
        if (action === 'proxy-adb') {
            test.streams++;
            socket.onMessage((data) => typeof data !== 'string' && test.packets.push(Buffer.from(data)));
            setTimeout(() => socket.send(initialStreamPacket()), 50);
            return;
        }
        if (action === 'proxy-coredevice') {
            test.streams++;
            test.say = (message) => socket.send(JSON.stringify(message));
            let live = true;
            test.close = (code, reason) => {
                live = false;
                socket.close({ code, reason });
            };
            socket.onClose(() => { live = false; });
            socket.onMessage((data) => typeof data === 'string' && test.messages.push(JSON.parse(data)));
            setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 50);
            setTimeout(() => socket.send(JSON.stringify({ type: 'codec', codec: 'hev1.1.6.L150.B0', description: Buffer.from([1]).toString('base64') })), 80);
            // A key frame now and then: the first may come before the decoder is ready.
            const frame = () => {
                if (!live || page.isClosed()) return;
                socket.send(Buffer.from([0, 0, 0, 0, 1, 0x26]));
                setTimeout(frame, 250).unref();
            };
            setTimeout(frame, 150);
            return;
        }
        socket.onMessage((data) => {
            const packet = Buffer.from(data);
            if (packet.length < 5) return;
            const id = packet.readUInt32LE(1);
            const body = packet.subarray(5).toString();
            const reply = (message) => socket.send(channelJson(id, message));
            if (packet[0] === 4) {
                const code = body.slice(0, 4);
                if (code === 'HSTS') reply({ id: -1, type: 'hosts', data: { local: [{ type: platform }] } });
                if (code === 'GTRC') reply({ id: -1, type: 'devicelist', data: { id: 'android', name: 'Fixture host', list: [ANDROID] } });
                if (code === 'ATRC') reply({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Fixture host', list: [IOS] } });
            } else if (packet[0] === 32 && body.startsWith('{')) {
                const command = JSON.parse(body);
                if (command.type === 'list_encoders') {
                    reply({ id: command.id, type: command.type, data: { udid: PIXEL, encoders: [{ videoCodec: 'h264', encoderName: ENCODER, hardware: 'hw' }], config: STREAM_CONFIG } });
                }
            }
        });
    });
    const udid = platform === 'android' ? PIXEL : IPHONE;
    if (list) {
        await page.goto(BASE);
        await page.locator(`article.device[data-device-key="${platform}:${udid}"]`).waitFor();
        return test;
    }
    await page.goto(`${BASE}#!action=device&udid=${udid}&view=screen`);
    await page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.includes('Connected'));
    const width = platform === 'android' ? 720 : VIDEO.width;
    await page.waitForFunction((wanted) => document.querySelector('.stream-mount .touch-layer')?.width === wanted, width);
    await page.locator('.stream-controls-slot .control-buttons-list button').first().waitFor();
    await settle(page);
    // The stage and the mount node, to tell later that they were never built again.
    await page.evaluate(() => {
        window.__layoutStage = document.querySelector('.stream-stage');
        window.__layoutMount = document.querySelector('.stream-mount');
    });
    test.touches = () =>
        platform === 'android'
            ? test.packets.filter((packet) => packet.length === 32 && packet[0] === 2).length
            : test.messages.filter((message) => message.type === 'touch' || message.type === 'touch-frame').length;
    test.typed = () =>
        platform === 'android' ? test.packets.filter((packet) => packet[0] === 1).length : test.messages.filter((message) => message.type === 'key').length;
    return test;
}

/**
 * The motion, then the layout at rest: a sheet that changes the stage's height, and a change of
 * columns, each take a frame or two. Three frames in a row with the same boxes.
 */
async function settle(page) {
    await settleMotion(page);
    await page.evaluate(async () => {
        const boxes = () =>
            ['.stream-stage', '.stream-mount .touch-layer', '.stream-controls-slot', 'dialog.kit-sheet[open] > .kit-sheet-panel']
                .map((selector) => JSON.stringify(document.querySelector(selector)?.getBoundingClientRect()))
                .join();
        let last = boxes();
        for (let frame = 0, still = 0; frame < 60 && still < 3; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const now = boxes();
            still = now === last ? still + 1 : 0;
            last = now;
        }
    });
}

async function shot(test, name) {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    // The fixture draws no frame on Android: tint the picture's box so it can be seen.
    await test.page.addStyleTag({ content: '.stream-mount .touch-layer { background: rgba(90, 130, 210, 0.45); }' });
    await settle(test.page);
    await test.page.screenshot({ path: path.join(OUT, `${test.platform}-${name}-${test.viewport.name}-${test.colorScheme}.png`), animations: 'disabled' });
}

/** The boxes of the stage, the picture, the rail and its controls, and the open sheet's panel. */
function geometry(page) {
    return page.evaluate(() => {
        const rect = (node) => {
            if (!node) return null;
            const box = node.getBoundingClientRect();
            return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
        };
        const panel = document.querySelector('.stream-controls-slot .floating-toolbar-panel');
        const dialog = document.querySelector('dialog.kit-sheet[open]:not([data-exiting])');
        const inner = panel && { left: panel.getBoundingClientRect().left + panel.clientLeft, top: panel.getBoundingClientRect().top + panel.clientTop };
        return {
            window: { width: innerWidth, height: innerHeight },
            stage: rect(document.querySelector('.stream-stage')),
            mount: rect(document.querySelector('.stream-mount')),
            picture: rect(document.querySelector('.stream-mount .touch-layer')),
            rail: rect(panel),
            railClient: panel && { ...inner, right: inner.left + panel.clientWidth, bottom: inner.top + panel.clientHeight },
            scrolls: !!panel && panel.scrollHeight > panel.clientHeight + 1,
            columns: document.querySelector('.floating-toolbar.desktop')?.getAttribute('data-columns'),
            controls: [...document.querySelectorAll('.stream-controls-slot .control-buttons-list > button')].map((button) => ({ name: button.getAttribute('aria-label'), ...rect(button) })),
            docked: document.querySelector('.stream-stage')?.hasAttribute('data-sheet-docked'),
            sheet: dialog && {
                title: dialog.querySelector('.kit-sheet-title')?.textContent,
                docked: dialog.classList.contains('kit-sheet-docked'),
                modal: dialog.matches(':modal'),
                backdrop: dialog.querySelector(':scope > .kit-sheet-backdrop') ? getComputedStyle(dialog.querySelector(':scope > .kit-sheet-backdrop')).backgroundColor : null,
                panel: rect(dialog.querySelector(':scope > .kit-sheet-panel')),
            },
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            same: document.querySelector('.stream-stage') === window.__layoutStage && document.querySelector('.stream-mount') === window.__layoutMount,
        };
    });
}

/**
 * The rail stands against the picture's right edge and is as tall as it, and no control is cut
 * off: each is inside the rail's box and the window. `free` is the right edge of what a docked
 * sheet leaves of the stage, the middle of which is the middle of the picture and the rail.
 */
function railAttached(g, label, { columns, free = g.stage.right } = {}) {
    const { picture, rail } = g;
    assert.ok(rail.left >= picture.right - 0.5 && rail.left - picture.right <= GAP, `${label}: the rail touches the picture (${picture.right} to ${rail.left})`);
    near(rail.top, picture.top, `${label}: the rail starts with the picture`);
    near(rail.height, picture.height, `${label}: the rail is as tall as the picture`);
    near((picture.left + rail.right) / 2, (g.stage.left + free) / 2, `${label}: the picture and the rail are centred together`);
    if (columns) assert.equal(g.columns, String(columns), `${label}: ${columns} column${columns > 1 ? 's' : ''} of controls`);
    assert.equal(g.scrolls, false, `${label}: every control fits in the rail`);
    const cut = g.controls.filter((control) =>
        control.top < g.railClient.top - 0.5 || control.bottom > g.railClient.bottom + 0.5 || control.left < g.railClient.left - 0.5 || control.right > g.railClient.right + 0.5 ||
        control.top < 0 || control.bottom > g.window.height + 0.5 || control.right > g.window.width + 0.5);
    assert.deepEqual(cut.map((control) => control.name), [], `${label}: no control is cut off`);
    assert.ok(g.controls.length >= 11, `${label}: the controls are shown (${g.controls.length})`);
    assert.equal(g.overflow, false, `${label}: nothing overflows sideways`);
    assert.equal(g.same, true, `${label}: the stage and the mount node were not built again`);
}

/** Nothing covers the picture at its middle: a press there reaches what is named. */
const under = (page, picture) => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, { x: picture.left + picture.width / 2, y: picture.top + picture.height / 2 });
const railButton = (page, name) => page.locator(`.stream-controls-slot .control-buttons-list [aria-label="${name}"]`);
const at = (page) => page.evaluate(() => ({ hash: location.hash, index: history.state?.nav?.index ?? 0, overlay: history.state?.nav?.overlay || 0 }));
const activeName = (page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.className || document.activeElement?.tagName);

async function openFromRail(test, name, title) {
    const { page } = test;
    await railButton(page, name).click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await dialog.waitFor();
    await settle(page);
    return dialog;
}

/** The screen alone: the rail against the picture, in one or two columns. */
async function screen(test) {
    const { label, viewport } = test;
    const g = await geometry(test.page);
    railAttached(g, `${label} screen`, { columns: viewport.height >= 900 ? 1 : 2 });
    // A portrait picture as tall as the stage: the rail is too, and the stage's height decides.
    near(g.picture.height, g.mount.height, `${label}: the picture takes the stage's height`);
    assert.equal(g.docked, false);
    await shot(test, 'screen');
}

/**
 * Actions and Settings as a panel beside the picture: the picture is not covered and keeps its
 * size here, a press on it closes the panel and reaches nothing, Escape and Back close it, and
 * focus stays inside it and goes back to the rail.
 */
async function sidePanel(test, name, title) {
    const { page, label } = test;
    const before = await geometry(page);
    const home = await at(page);
    const dialog = await openFromRail(test, name, title);
    const g = await geometry(page);
    const where = `${label} ${title}`;
    assert.deepEqual(
        { docked: g.sheet.docked, modal: g.sheet.modal, backdrop: g.sheet.backdrop, stage: g.docked },
        { docked: true, modal: true, backdrop: 'rgba(0, 0, 0, 0)', stage: true },
        `${where}: a modal panel with a backdrop that dims nothing`,
    );
    near(g.sheet.panel.width, DOCK_WIDTH, `${where}: the panel's width`);
    near(g.sheet.panel.right, g.stage.right, `${where}: the panel is at the right edge of the stage`);
    near(g.sheet.panel.top, g.stage.top, `${where}: the panel starts with the stage`);
    near(g.sheet.panel.height, g.stage.height, `${where}: the panel is as tall as the stage`);
    assert.ok(g.picture.right <= g.sheet.panel.left + 0.5 && g.rail.right <= g.sheet.panel.left + 0.5, `${where}: the panel covers neither the picture nor the rail`);
    assert.ok(g.picture.height <= before.picture.height + 0.5, `${where}: the picture keeps its size or shrinks`);
    // A portrait picture with the rail and the panel fits the width of both windows.
    near(g.picture.height, before.picture.height, `${where}: the picture keeps its size`);
    railAttached(g, where, { columns: before.columns, free: g.sheet.panel.left });
    assert.equal(await under(page, g.picture), 'kit-sheet-backdrop', `${where}: a press on the picture reaches the backdrop`);
    // The panel is as narrow as a phone and its rows are laid out as on a phone: a title is never
    // squeezed beside its control, and two buttons or a select go under their text.
    const rows = await dialog.locator('.kit-row').evaluateAll((list) =>
        list.filter((row) => row.getClientRects().length).map((row) => {
            const title = row.querySelector('.kit-row-title')?.getBoundingClientRect();
            const control = row.querySelector(':scope > .kit-row-control')?.getBoundingClientRect();
            return { name: row.querySelector('.kit-row-title')?.textContent, pair: row.classList.contains('kit-row-pair'), title: title?.width, below: !control || !title || control.top >= title.bottom - 1 };
        }),
    );
    assert.ok(rows.length > 3, `${where}: the panel has rows`);
    assert.deepEqual(rows.filter((row) => row.name && row.title < 120).map((row) => row.name), [], `${where}: no title is squeezed`);
    assert.deepEqual(rows.filter((row) => row.pair && !row.below).map((row) => row.name), [], `${where}: a pair row puts its control under the text`);
    await shot(test, name.toLowerCase());

    // Focus stays inside the panel.
    for (let step = 0; step < 12; step++) {
        await page.keyboard.press('Tab');
        assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, `${where}: Tab ${step + 1} stays in the panel`);
    }

    // A press on the picture closes the panel and reaches nothing.
    const touches = test.touches();
    await page.mouse.click(g.picture.left + g.picture.width / 2, g.picture.top + g.picture.height / 2);
    await dialog.waitFor({ state: 'hidden' });
    await settle(page);
    await pause(150);
    assert.equal(test.touches(), touches, `${where}: the press that closes the panel does not reach the phone`);
    assert.deepEqual(await at(page), home, `${where}: the press leaves no history entry`);
    assert.equal(await page.locator('.touch-layer').evaluate(node => node === document.activeElement), true, `${where}: active keyboard capture returns focus to the picture`);
    const after = await geometry(page);
    assert.equal(after.docked, false, `${where}: the stage has its width again`);
    near(after.picture.left, before.picture.left, `${where}: the picture is back where it was`);
    railAttached(after, `${where} closed`, { columns: before.columns });

    // Escape and Back close it.
    await openFromRail(test, name, title);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await settle(page);
    assert.deepEqual(await at(page), home, `${where}: Escape closes it`);
    await openFromRail(test, name, title);
    await page.goBack();
    await dialog.waitFor({ state: 'hidden' });
    await settle(page);
    assert.deepEqual(await at(page), home, `${where}: Back closes it and stays on the page`);
    assert.equal(await page.locator('.touch-layer').evaluate(node => node === document.activeElement), true, `${where}: Back returns active keyboard capture to the picture`);
}

/**
 * Type text in the place of the panel, not modal: a press on the picture reaches the phone and
 * typing goes on into the field. The picture keeps its height, so the rail is not cut off.
 */
async function typeText(test) {
    const { page, label } = test;
    const before = await geometry(page);
    const home = await at(page);
    const dialog = await openFromRail(test, 'Type text', 'Type text');
    const where = `${label} Type text`;
    const g = await geometry(page);
    assert.deepEqual(
        { docked: g.sheet.docked, modal: g.sheet.modal, backdrop: g.sheet.backdrop },
        { docked: true, modal: false, backdrop: null },
        `${where}: docked, not modal, no backdrop`,
    );
    near(g.sheet.panel.width, DOCK_WIDTH, `${where}: the panel's width`);
    near(g.sheet.panel.right, g.stage.right, `${where}: at the right edge of the stage`);
    near(g.sheet.panel.top, g.stage.top, `${where}: the panel starts with the stage`);
    near(g.sheet.panel.height, g.stage.height, `${where}: the panel is as tall as the stage`);
    near(g.stage.height, before.stage.height, `${where}: the stage keeps its height`);
    near(g.picture.height, before.picture.height, `${where}: the picture keeps its size`);
    assert.ok(g.picture.right <= g.sheet.panel.left + 0.5 && g.rail.right <= g.sheet.panel.left + 0.5, `${where}: the panel covers neither the picture nor the rail`);
    railAttached(g, where, { columns: before.columns, free: g.sheet.panel.left });
    assert.equal(await under(page, g.picture), 'touch-layer', `${where}: nothing covers the picture`);
    assert.equal(await activeName(page), 'Text to send to the phone', `${where}: the field has focus`);
    await shot(test, 'type-text');

    const touches = test.touches();
    for (let count = 0; count < 2; count++) {
        await page.mouse.click(g.picture.left + g.picture.width / 2, g.picture.top + g.picture.height / 2);
        await pause(80);
    }
    for (let tries = 0; tries < 50 && test.touches() < touches + 2; tries++) await pause(20);
    assert.ok(test.touches() >= touches + 2, `${where}: a press on the picture reaches the phone`);
    assert.equal(await dialog.evaluate((node) => node.open && !node.hasAttribute('data-exiting')), true, `${where}: Type text stays open`);
    assert.equal(await activeName(page), 'Text to send to the phone', `${where}: the field keeps focus`);
    const typed = test.typed();
    await page.keyboard.type('a');
    for (let tries = 0; tries < 50 && test.typed() === typed; tries++) await pause(20);
    await pause(150);
    // Android: one text message. iPhone: the key down and the release.
    assert.equal(test.typed() - typed, test.platform === 'android' ? 1 : 2, `${where}: typing goes on, once`);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await settle(page);
    assert.deepEqual(await at(page), home, `${where}: Escape closes it`);
    railAttached(await geometry(page), `${where} closed`, { columns: before.columns });
}

/** Switch phone is not one of the three: it stays the centred dialog. */
async function switcherCentred(test) {
    const { page, label, viewport } = test;
    await page.locator('.kit-bar').getByRole('button', { name: 'Switch', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Switch/ });
    await dialog.waitFor();
    await settle(page);
    const g = await geometry(page);
    assert.equal(g.sheet.docked, false, `${label}: Switch phone is not docked`);
    near(g.sheet.panel.width, DIALOG_WIDTH, `${label}: Switch phone is the dialog`);
    near(g.sheet.panel.left + g.sheet.panel.width / 2, viewport.width / 2, `${label}: centred`);
    assert.equal(g.docked, false);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await settle(page);
}

/** The panel follows the window across 1024px, open as it is. */
async function acrossTheBreakpoint(test) {
    const { page, label, viewport } = test;
    const dialog = await openFromRail(test, 'Actions', 'Actions');
    await page.setViewportSize({ width: 1000, height: viewport.height });
    await settle(page);
    let g = await geometry(page);
    assert.equal(g.sheet.docked, false, `${label}: below 1024px Actions is the dialog again`);
    near(g.sheet.panel.width, DIALOG_WIDTH, `${label}: the dialog's width`);
    assert.equal(g.docked, false, `${label}: the stage has its width again`);
    railAttached(g, `${label} at 1000px`);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await settle(page);
    g = await geometry(page);
    assert.equal(g.sheet.docked, true, `${label}: from 1024px it is docked again`);
    railAttached(g, `${label} docked again`, { free: g.sheet.panel.left });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await settle(page);
}

async function desktop(browser, platform, viewport, colorScheme) {
    const test = await start(browser, platform, viewport, colorScheme);
    try {
        await screen(test);
        await sidePanel(test, 'Actions', 'Actions');
        await sidePanel(test, 'Settings', 'Settings');
        await typeText(test);
        await switcherCentred(test);
        if (viewport === LARGE) await acrossTheBreakpoint(test);
        // Settings, then Actions, opened and closed again: still the one stream.
        for (let round = 0; round < 3; round++) {
            for (const name of ['Settings', 'Actions']) {
                const dialog = await openFromRail(test, name, name);
                await test.page.keyboard.press('Escape');
                await dialog.waitFor({ state: 'hidden' });
            }
        }
        await settle(test.page);
        railAttached(await geometry(test.page), `${test.label} after the panels`, { columns: viewport.height >= 900 ? 1 : 2 });
        assert.equal(test.streams, 1, `${test.label}: one stream socket for the open of the screen`);
        assert.deepEqual(test.errors, [], `${test.label}: no page error`);
        console.log(`PASS ${test.label}: the rail against the picture, Actions, Settings and Type text beside it, one stream`);
    } finally {
        await test.context.close();
    }
}

/** Below 1024px the sheets are where they were: Actions the centred dialog, Type text under the picture. */
async function narrow(browser, platform) {
    const test = await start(browser, platform, NARROW);
    const { page, label } = test;
    try {
        railAttached(await geometry(page), `${label} screen`);
        let dialog = await openFromRail(test, 'Actions', 'Actions');
        let g = await geometry(page);
        assert.equal(g.sheet.docked, false, `${label}: Actions is not docked`);
        assert.equal(g.docked, false, `${label}: the stage keeps its width`);
        near(g.sheet.panel.width, DIALOG_WIDTH, `${label}: Actions is the dialog`);
        near(g.sheet.panel.left + g.sheet.panel.width / 2, NARROW.width / 2, `${label}: centred`);
        await shot(test, 'actions');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        await settle(page);

        dialog = await openFromRail(test, 'Type text', 'Type text');
        g = await geometry(page);
        assert.equal(g.sheet.docked, false, `${label}: Type text is not docked`);
        near(g.sheet.panel.width, DIALOG_WIDTH, `${label}: Type text is the dialog`);
        assert.ok(g.picture.bottom <= g.sheet.panel.top + 1, `${label}: the picture is above Type text (${g.picture.bottom} <= ${g.sheet.panel.top})`);
        assert.ok(g.sheet.panel.bottom < NARROW.height && g.sheet.panel.bottom > NARROW.height - 40, `${label}: Type text stands a little above the bottom edge`);
        // The rail follows the picture above Type text, so it is not cut off by it.
        railAttached(g, `${label} Type text`);
        assert.ok(g.rail.bottom <= g.sheet.panel.top + 1, `${label}: the rail ends above Type text`);
        await shot(test, 'type-text');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        await settle(page);
        assert.equal(test.streams, 1);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label}: below 1024px Actions is the centred dialog and Type text stands under the picture`);
    } finally {
        await test.context.close();
    }
}

/**
 * A state card with a long message on a narrow picture (the iPhone at 1366x650): the card lies on
 * the picture, centred on it and no wider than it, so the rail beside the picture never covers it;
 * the layer under the card dims the stage evenly up to its right edge, or up to a docked panel.
 */
async function stateCard(browser) {
    const test = await start(browser, 'ios', SHORT);
    const { page, label } = test;
    try {
        // 4011, as the server ends a start that the budget refuses: no try without Retry.
        test.say({ type: 'status', state: 'error', message: "This phone's screen session was started 3 times in the last 5 min. The next start is allowed in 2 min." });
        test.close(4011, 'Stream unavailable');
        await page.locator('.stream-state:not([data-exiting]) .stream-state-card').filter({ hasText: 'Stream unavailable' }).waitFor();
        await settle(page);
        const facts = () => page.evaluate(() => {
            const rect = (node) => node && node.getBoundingClientRect().toJSON();
            const card = document.querySelector('.stream-state:not([data-exiting]) .stream-state-card');
            const box = rect(card);
            const covered = [];
            // Clear of the rounded corners, which take no press.
            for (let y = box.top + 16; y < box.bottom - 15; y += 6) {
                for (let x = box.left + 2; x < box.right - 1; x += 6) {
                    const hit = document.elementFromPoint(x, y);
                    if (!card.contains(hit)) covered.push(`${Math.round(x)},${Math.round(y)} ${hit?.className}`);
                }
            }
            return {
                card: box,
                covered: covered.slice(0, 3),
                layer: rect(document.querySelector('.stream-state:not([data-exiting])')),
                picture: rect(document.querySelector('.stream-mount .touch-layer')),
                rail: rect(document.querySelector('.stream-controls-slot .floating-toolbar-panel')),
                stage: rect(document.querySelector('.stream-stage')),
                panel: rect(document.querySelector('dialog.kit-sheet[open]:not([data-exiting]) > .kit-sheet-panel')),
            };
        });
        let g = await facts();
        assert.ok(g.card.width > 200 && g.card.width <= g.picture.width + 0.5, `${label}: the card is no wider than the picture (${g.card.width}, ${g.picture.width})`);
        near(g.card.left + g.card.width / 2, g.picture.left + g.picture.width / 2, `${label}: the card is centred on the picture`);
        assert.ok(g.card.right <= g.rail.left + 0.5, `${label}: the card ends before the rail (${g.card.right} <= ${g.rail.left})`);
        assert.deepEqual(g.covered, [], `${label}: nothing covers the card`);
        near(g.layer.right, g.stage.right, `${label}: the layer dims the stage up to its right edge`);
        near(g.layer.left, g.stage.left, `${label}: and from its left edge`);
        await shot(test, 'failed');

        // With Settings docked beside the stage, the layer ends at the panel.
        const dialog = await openFromRail(test, 'Settings', 'Settings');
        g = await facts();
        assert.ok(g.panel, `${label}: Settings is open`);
        near(g.layer.right, g.panel.left, `${label}: the layer ends at the docked panel`);
        near(g.card.left + g.card.width / 2, g.picture.left + g.picture.width / 2, `${label}: the card stays centred on the picture`);
        assert.ok(g.card.right <= g.rail.left + 0.5, `${label}: the card still ends before the rail`);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(test.streams, 1, `${label}: no stream opened by the card or the panel`);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label}: a state card lies on the picture, centred and not covered by the rail, on an evenly dimmed stage`);
    } finally {
        await test.context.close();
    }
}

/** From the list, Settings is the centred dialog at every width. */
async function settingsFromTheList(browser, platform) {
    const test = await start(browser, platform, LARGE, 'light', { list: true });
    const { page } = test;
    try {
        const udid = platform === 'android' ? PIXEL : IPHONE;
        await page.locator(`article.device[data-device-key="${platform}:${udid}"] button.stream-settings-button`).click();
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
        await dialog.waitFor();
        await settle(page);
        const facts = await dialog.evaluate((node) => ({ docked: node.classList.contains('kit-sheet-docked'), width: node.querySelector('.kit-sheet-panel').getBoundingClientRect().width }));
        assert.deepEqual(facts, { docked: false, width: DIALOG_WIDTH }, `${platform}: Settings from the list is the centred dialog`);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(test.streams, 0, `${platform}: the list opens no stream`);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${platform}: Settings from the list is the centred dialog`);
    } finally {
        await test.context.close();
    }
}

async function main() {
    const browser = await chromium.launch();
    try {
        const runs = [];
        for (const platform of ['android', 'ios']) {
            for (const viewport of [LARGE, SHORT]) {
                for (const colorScheme of ['light', 'dark']) runs.push(() => desktop(browser, platform, viewport, colorScheme));
            }
            runs.push(() => narrow(browser, platform));
            runs.push(() => settingsFromTheList(browser, platform));
        }
        runs.push(() => stateCard(browser));
        // Four at a time, each in a context of its own: the suite has four minutes.
        for (let index = 0; index < runs.length; index += 4) await Promise.all(runs.slice(index, index + 4).map((run) => run()));
    } finally {
        await browser.close();
    }
}

module.exports = { start, settle };
if (require.main === module) main().catch((error) => {
    console.error(error);
    process.exit(1);
});
