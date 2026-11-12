/* eslint-disable */
// Run with: node scripts/test-browser.js android-stream
// The Android stream page in a real browser, with every socket mocked: recovery from a real
// decoder error, a second scrcpy_initial (rotation), a swipe that starts beside the picture, the
// mouse (wheel, a drag that leaves the picture, right-click Back, Ctrl+drag pinch, also at a
// device pixel ratio of 2), the Settings sheet without the Fit screen toggle, and the Mouse and
// keyboard row of the Actions sheet.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { fixture, UDID } = require('./e2e-settings');
const { settleMotion } = require('./ui-motion');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-android-stream';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The synthetic packet WebsocketProxy sends: name, one display, ScreenInfo, VideoSettings, client id.
function initialPacket(width, height) {
    const packet = Buffer.alloc(186);
    packet.write('scrcpy_initial');
    packet.write('Android stream fixture', 14);
    packet.writeInt32BE(1, 78);
    packet.writeInt32BE(width, 86);
    packet.writeInt32BE(height, 90);
    packet.writeInt32BE(25, 110);
    packet.writeInt32BE(width, 122);
    packet.writeInt32BE(height, 126);
    packet.writeInt32BE(width, 130);
    packet.writeInt32BE(height, 134);
    packet.writeInt32BE(35, 139);
    packet.writeInt32BE(4000000, 143);
    packet.writeInt32BE(60, 147);
    packet.writeInt8(1, 151);
    packet.writeInt8(-1, 165);
    packet.writeInt32BE(1, 182);
    return packet;
}

// INJECT_TOUCH: type 2, action, pointerId(8), x(4), y(4), width(2), height(2), ...
const touchMessages = (packets) =>
    packets
        .filter((packet) => packet[0] === 2 && packet.length === 32)
        .map((packet) => ({
            action: packet[1],
            pointer: packet.readUInt32BE(6),
            x: packet.readUInt32BE(10),
            y: packet.readUInt32BE(14),
            width: packet.readUInt16BE(18),
            height: packet.readUInt16BE(20),
        }));
// INJECT_SCROLL: type 3, x(4), y(4), width(2), height(2), hscroll(2), vscroll(2), buttons(4)
const scrollMessages = (packets) =>
    packets
        .filter((packet) => packet[0] === 3 && packet.length === 21)
        .map((packet) => ({ hscroll: packet.readInt16BE(13), vscroll: packet.readInt16BE(15) }));
// INJECT_KEYCODE: type 0, action, keycode(4), repeat(4), meta(4)
const keyMessages = (packets) =>
    packets.filter((packet) => packet[0] === 0 && packet.length === 14).map((packet) => [packet[1], packet.readInt32BE(2)]);
const [DOWN, UP, MOVE] = [0, 1, 2];
const KEYCODE_BACK = 4;
// What the Mouse and keyboard row lists for an Android phone.
const MOUSE_HELP = [
    'Wheel: scrolls.',
    'Drag: swipes, and keeps going past the edge of the picture.',
    'Right-click: Back.',
    'Ctrl+drag: pinches around the middle. With Shift too, around where you pressed.',
];

async function touch(cdp, points) {
    for (const [index, [x, y]] of points.entries()) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: index === 0 ? 'touchStart' : 'touchMove',
            touchPoints: [{ id: 1, x, y, force: 1 }],
        });
        await pause(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await pause(50);
}

// Two real 32x32 red frames encoded by libx264, as whole Annex-B packets the way scrcpy sends them.
const CONFIG = Buffer.from('000000016742c00ada25b011000003000100000300788f1226a00000000168ce0fc8', 'hex');
const IDR = Buffer.from('000000016588843a118a000218f1c00040f63800087949d75e', 'hex');
// Starts like a keyframe and is not one: the browser's decoder fails on it.
const BROKEN = Buffer.concat([Buffer.from('0000000165', 'hex'), Buffer.alloc(40, 0xff)]);

function redPicture() {
    const canvas = document.querySelector('canvas.video-layer');
    if (!canvas || !canvas.width) return false;
    const probe = document.createElement('canvas');
    probe.width = probe.height = 16;
    const context = probe.getContext('2d');
    context.drawImage(canvas, 0, 0, 16, 16);
    const [r, g, b] = context.getImageData(8, 8, 1, 1).data;
    return r > 200 && g < 50 && b < 50;
}

// A real WebCodecs decoder error with the socket still up: the player rebuilds its decoder from
// the cached SPS and PPS, asks for a keyframe when none comes, and shows the picture again.
async function decoderRecovery(browser) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    const decoderErrors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error' && message.text().includes('[WebCodecs]')) decoderErrors.push(message.text());
    });
    const socketUrl = new URL('/__decoder_fixture__', BASE);
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const received = [];
    let stream;
    await page.routeWebSocket(socketUrl.toString(), (socket) => {
        stream = socket;
        socket.onMessage((data) => {
            const message = Buffer.from(data);
            received.push(message);
            if (message.length === 1 && message[0] === 17) {
                // RESET_VIDEO: scrcpy starts a new capture session. The size is announced again,
                // then the parameter sets and a keyframe follow.
                socket.send(initialPacket(32, 32));
                socket.send(CONFIG);
                socket.send(IDR);
            }
        });
        setTimeout(() => {
            socket.send(initialPacket(32, 32));
            socket.send(CONFIG);
            socket.send(IDR);
        }, 100);
    });
    const url = new URL(BASE);
    url.hash = `!${new URLSearchParams({ action: 'stream', udid: 'decoder-fixture', player: 'webcodecs', ws: socketUrl.toString(), captureKeyboard: '0' })}`;
    try {
        await page.goto(url.toString());
        await page.getByText('Connected', { exact: true }).waitFor();
        await page.waitForFunction(redPicture, undefined, { timeout: 5000 });

        stream.send(BROKEN);
        const started = Date.now();
        while (!decoderErrors.length && Date.now() - started < 3000) await pause(50);
        assert(decoderErrors.length > 0, 'the broken packet produced a real decoder error');
        assert(await page.evaluate(redPicture), 'the last picture stays on screen while the decoder is rebuilt');
        await page.getByText('Connected', { exact: true }).waitFor();

        // The stream is silent, like a still screen. Wipe the canvas so that only a newly
        // decoded frame can make it red again.
        await page.evaluate(() => {
            const canvas = document.querySelector('canvas.video-layer');
            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        });
        assert.equal(await page.evaluate(redPicture), false);
        await page.waitForFunction(redPicture, undefined, { timeout: 6000 });
        assert.deepEqual(
            received.filter((message) => message.length === 1).map((message) => message[0]),
            [17],
            'one RESET_VIDEO was sent for the missing keyframe',
        );
        assert.equal(await page.locator('.stream-notice').count(), 0, 'a failure the player recovered from shows no notice');
        assert.deepEqual(errors, [], 'no browser runtime errors');
        console.log(`PASS decoder recovery: picture back ${Date.now() - started} ms after a real WebCodecs error`);
    } finally {
        await context.close();
    }
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        await decoderRecovery(browser);
        for (const [label, width, height, mobile, colorScheme, deviceScaleFactor] of [
            ['phone-light', 390, 844, true, 'light', 1],
            ['phone-dark', 390, 844, true, 'dark', 1],
            ['desktop-light', 1280, 800, false, 'light', 1],
            // A pointer lands in the same place at another pixel ratio.
            ['desktop-dark', 1280, 800, false, 'dark', 2],
        ]) {
            const context = await browser.newContext({
                viewport: { width, height },
                hasTouch: mobile,
                isMobile: mobile,
                colorScheme,
                deviceScaleFactor,
            });
            const page = await context.newPage();
            const cdp = await context.newCDPSession(page);
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            const packets = [];
            let stream;
            // Taller than the stream area, so the picture is limited by height and leaves a
            // band on each side, as a phone does on a phone.
            await fixture(page, {
                initialPacket: initialPacket(720, 1800),
                onStreamMessage: (packet) => packets.push(Buffer.from(packet)),
                onStreamReady: (controls) => {
                    stream = controls;
                },
            });
            const socket = new URL('/__settings_fixture__', BASE);
            socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = new URL(BASE);
            url.hash = `!${new URLSearchParams({ action: 'stream', udid: UDID, player: 'webcodecs', ws: socket.toString(), captureKeyboard: '0', fitToScreen: 'true' })}`;
            await page.goto(url.toString());
            await page.getByText('Connected', { exact: true }).waitFor();
            const layer = page.locator('.video .touch-layer');
            await page.waitForFunction(() => document.querySelector('.video .touch-layer')?.width === 720);
            const stored = await page.evaluate(() => Object.keys(localStorage).filter((key) => /:\d+x\d+/.test(key)));
            assert.deepEqual(stored, [], label + ': nothing is stored per window size');

            const picture = await layer.boundingBox();
            const area = await page.locator('.video').boundingBox();
            const band = picture.x - area.x;
            const middle = picture.y + picture.height / 2;
            assert(band > 8, `${label}: the fixture leaves a band beside the picture (${band.toFixed(1)} px)`);
            assert(Math.abs(picture.width / picture.height - 720 / 1800) < 0.01, label + ': the picture keeps its shape');

            if (mobile) {
                // A tap on the band is not a tap on the device.
                await touch(cdp, [[picture.x - band / 2, middle]]);
                assert.deepEqual(touchMessages(packets), [], label + ': a tap beside the picture sends nothing');

                // Back gesture: from the band onto the picture.
                await touch(cdp, [
                    [picture.x - band / 2, middle],
                    [picture.x + 20, middle],
                    [picture.x + 60, middle],
                    [picture.x + 120, middle],
                ]);
                const swipe = touchMessages(packets);
                assert(swipe.length >= 3, `${label}: the edge swipe reaches the device (${swipe.length} messages)`);
                assert.equal(swipe[0].action, DOWN, label + ': it starts with a touch-down');
                assert.equal(swipe[0].x, 0, label + ': on the left edge of the screen');
                assert(Math.abs(swipe[0].y - 900) <= 6, `${label}: at the height the finger started (${swipe[0].y})`);
                assert.equal(swipe[1].action, MOVE);
                assert(swipe[1].x > 0 && swipe.at(-2).x > swipe[1].x, label + ': then moves inwards');
                assert.equal(swipe.at(-1).action, UP);
                assert.deepEqual([swipe[0].width, swipe[0].height], [720, 1800]);

                // A touch on the picture is unchanged, and sliding off it ends on the edge.
                packets.length = 0;
                await touch(cdp, [
                    [picture.x + picture.width - 30, middle],
                    [picture.x + picture.width + band / 2, middle],
                ]);
                const off = touchMessages(packets);
                assert.equal(off[0].action, DOWN);
                assert.equal(off.at(-1).action, UP);
                assert.equal(off.at(-1).x, 719, label + ': a finger that slides off rides the right edge');
            } else {
                // One wheel notch over the picture. At a pixel ratio of 2 Playwright's wheel
                // reports half the pixels, so the notch is read from what the browser reported.
                await page.evaluate(() => {
                    window.__wheel = [];
                    addEventListener('wheel', (event) => window.__wheel.push(event.deltaY), { capture: true, passive: true });
                });
                await page.mouse.move(picture.x + picture.width / 2, middle);
                await page.mouse.wheel(0, 100);
                await pause(150);
                const scrolls = scrollMessages(packets);
                const [deltaY] = await page.evaluate(() => window.__wheel);
                assert.equal(scrolls.length, 1, label + ': one wheel notch is one message');
                assert.deepEqual(scrolls[0], { hscroll: 0, vscroll: Math.round((-deltaY / 100) * 0x0800) }, label + ': one notch, not sixteen');
                if (deviceScaleFactor === 1) assert.equal(scrolls[0].vscroll, -0x0800);
                // A click on the black area beside the picture is not a tap on the device.
                packets.length = 0;
                await page.mouse.click(picture.x - band / 2, middle);
                await pause(50);
                assert.deepEqual(touchMessages(packets), [], label + ': a click beside the picture sends nothing');

                // A drag that leaves the picture rides its right edge, then goes up over the bar
                // above it, and lifts where the button comes up: the top right corner.
                packets.length = 0;
                const right = picture.x + picture.width + band / 2;
                await page.mouse.move(picture.x + picture.width / 2, middle);
                await page.mouse.down();
                await page.mouse.move(right, middle, { steps: 4 });
                await page.mouse.move(right, picture.y - 10, { steps: 4 });
                await page.mouse.up();
                await pause(50);
                const drag = touchMessages(packets);
                assert.equal(drag[0].action, DOWN, label + ': the drag starts with a touch-down');
                assert.deepEqual(
                    drag.filter((message) => message.action === UP).map(({ x, y }) => [x, y]),
                    [[719, 0]],
                    label + ': one touch-up, where the button came up, clamped to the corner',
                );
                assert.equal(drag.at(-1).action, UP);
                assert(drag.some((message) => message.action === MOVE && message.x === 719 && message.y > 0), label + ': it rode the right edge');

                // Right-click is Back, sends no touch and opens no browser menu.
                packets.length = 0;
                await page.evaluate(() => {
                    window.__menus = [];
                    document.addEventListener('contextmenu', (event) => window.__menus.push(event.defaultPrevented));
                });
                await page.mouse.click(picture.x + picture.width / 2, middle, { button: 'right' });
                await pause(50);
                assert.deepEqual(touchMessages(packets), [], label + ': right-click sends no touch');
                assert.deepEqual(keyMessages(packets), [[DOWN, KEYCODE_BACK], [UP, KEYCODE_BACK]], label + ': right-click is Back');
                assert.deepEqual(await page.evaluate(() => window.__menus), [true], label + ': the browser menu stays shut');

                // Ctrl+drag: a second finger mirrored through the middle of the 720x1800 screen.
                packets.length = 0;
                await page.keyboard.down('Control');
                await page.mouse.move(picture.x + picture.width * 0.25, picture.y + picture.height * 0.25);
                await page.mouse.down();
                await page.mouse.move(picture.x + picture.width * 0.4, picture.y + picture.height * 0.3, { steps: 3 });
                await page.mouse.up();
                await page.keyboard.up('Control');
                await pause(50);
                const pinch = touchMessages(packets);
                const fingers = [0, 1].map((pointer) => pinch.filter((message) => message.pointer === pointer));
                assert.deepEqual(
                    fingers.map((finger) => [finger[0].action, finger.at(-1).action]),
                    [[DOWN, UP], [DOWN, UP]],
                    label + ': two fingers go down and come up',
                );
                fingers[0].forEach((finger, index) => {
                    const mirror = fingers[1][index];
                    assert(
                        Math.abs(finger.x + mirror.x - 720) <= 2 && Math.abs(finger.y + mirror.y - 1800) <= 2,
                        `${label}: the second finger mirrors the first (${finger.x},${finger.y} and ${mirror.x},${mirror.y})`,
                    );
                });
                assert(Math.abs(fingers[0][0].x - 180) <= 4 && Math.abs(fingers[0][0].y - 450) <= 4, `${label}: and lands where it was aimed`);
            }

            // The device rotates: the server sends scrcpy_initial again with the new size.
            packets.length = 0;
            stream.send(initialPacket(1800, 720));
            await page.waitForFunction(() => {
                const canvas = document.querySelector('.video .touch-layer');
                return canvas?.width === 1800 && canvas?.height === 720;
            });
            await page.getByText('Connected', { exact: true }).waitFor();
            // With a mouse, the rail beside the picture takes a second column for the shorter
            // picture a frame later (`controls/ControlRail.tsx`), and the picture moves again.
            // Its box is read once it has stayed the same for three frames.
            await page.evaluate(async () => {
                const box = () => JSON.stringify(document.querySelector('.video .touch-layer')?.getBoundingClientRect());
                let last = box();
                for (let frame = 0, still = 0; frame < 60 && still < 3; frame++) {
                    await new Promise((resolve) => requestAnimationFrame(resolve));
                    const now = box();
                    still = now === last ? still + 1 : 0;
                    last = now;
                }
            });
            const rotated = await layer.boundingBox();
            assert(rotated.width > rotated.height, label + ': the touch layer follows the rotation');
            const centre = [rotated.x + rotated.width / 2, rotated.y + rotated.height / 2];
            if (mobile) {
                await touch(cdp, [centre]);
            } else {
                await page.mouse.click(centre[0], centre[1]);
                await pause(50);
            }
            const tap = touchMessages(packets);
            assert.equal(tap[0].action, DOWN);
            assert.deepEqual([tap[0].width, tap[0].height], [1800, 720], label + ': input uses the new screen size');
            assert(Math.abs(tap[0].x - 900) <= 6 && Math.abs(tap[0].y - 360) <= 6, label + ': and lands where it was aimed');
            await page.screenshot({ path: path.join(OUT, label + '-rotated.png') });

            // Settings: playback options without the Fit screen toggle.
            if (mobile) await page.getByRole('button', { name: 'Phone controls', exact: true }).click();
            await page.getByRole('button', { name: 'Settings', exact: true }).click();
            const dialog = page.locator('dialog.kit-sheet[open]');
            await dialog.waitFor();
            await dialog.locator('.settings-playback summary').click();
            await dialog.getByText('Show quality stats').waitFor();
            await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
            const playback = await dialog.locator('.settings-playback').textContent();
            assert(!/Fit screen/i.test(playback), label + ': no Fit screen toggle');
            await dialog.locator('.settings-playback').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(OUT, label + '-settings.png') });

            // The Mouse and keyboard row of the Actions sheet lists what the mouse does here.
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'hidden' });
            const actionsControl = page.locator('.control-buttons-list [title="Actions"]');
            if (mobile && !(await actionsControl.isVisible())) {
                await page.getByRole('button', { name: 'Phone controls', exact: true }).click();
            }
            await actionsControl.click();
            const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
            await actions.waitFor();
            const help = actions.locator('.kit-row[data-mouse-help]');
            await help.scrollIntoViewIfNeeded();
            await help.getByRole('button', { name: 'Show', exact: true }).click();
            const hide = help.getByRole('button', { name: 'Hide', exact: true });
            await hide.waitFor();
            assert.equal(await hide.getAttribute('aria-expanded'), 'true');
            assert.deepEqual((await help.locator('.kit-row-desc').innerText()).split('\n'), MOUSE_HELP, label + ': the lines for an Android phone');
            assert(await actions.locator('.kit-sheet-body').evaluate((body) => body.scrollWidth <= body.clientWidth + 1), label + ': the lines fit the sheet');
            // The card grows to hold them.
            await page.waitForFunction(() => {
                const row = document.querySelector('[data-mouse-help]');
                return row && row.getBoundingClientRect().bottom <= row.closest('.auto-height').getBoundingClientRect().bottom + 1;
            });
            await settleMotion(page);
            await help.scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(OUT, label + '-mouse-help.png') });
            await hide.click();
            await help.getByRole('button', { name: 'Show', exact: true }).waitFor();
            await page.keyboard.press('Escape');
            await actions.waitFor({ state: 'hidden' });

            assert.deepEqual(errors, [], label + ': no browser runtime errors');
            await context.close();
            console.log(`PASS ${label}: rotation, input beside the picture, ${mobile ? 'edge swipe' : 'wheel, drag off the picture, right-click Back, Ctrl+drag pinch'}, settings without Fit screen, mouse help`);
        }
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
