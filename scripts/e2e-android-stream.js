/* eslint-disable */
// Run with: node scripts/test-browser.js android-stream
// The Android stream page in a real browser, with every socket mocked: a second scrcpy_initial
// (rotation), a swipe that starts beside the picture, the mouse wheel, and the Settings sheet
// without the Fit screen toggle. No frame is decoded: the bundled Chromium has no H.264.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { fixture, UDID } = require('./e2e-settings');
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
const [DOWN, UP, MOVE] = [0, 1, 2];

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

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        for (const [label, width, height, mobile, colorScheme] of [
            ['phone-light', 390, 844, true, 'light'],
            ['phone-dark', 390, 844, true, 'dark'],
            ['desktop-light', 1280, 800, false, 'light'],
            ['desktop-dark', 1280, 800, false, 'dark'],
        ]) {
            const context = await browser.newContext({
                viewport: { width, height },
                hasTouch: mobile,
                isMobile: mobile,
                colorScheme,
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
                // One wheel notch over the picture.
                await page.mouse.move(picture.x + picture.width / 2, middle);
                await page.mouse.wheel(0, 100);
                await pause(150);
                const scrolls = scrollMessages(packets);
                assert.equal(scrolls.length, 1, label + ': one wheel notch is one message');
                assert.deepEqual(scrolls[0], { hscroll: 0, vscroll: -0x0800 }, label + ': one notch, not sixteen');
                // A click on the black area beside the picture is not a tap on the device.
                packets.length = 0;
                await page.mouse.click(picture.x - band / 2, middle);
                await pause(50);
                assert.deepEqual(touchMessages(packets), [], label + ': a click beside the picture sends nothing');
            }

            // The device rotates: the server sends scrcpy_initial again with the new size.
            packets.length = 0;
            stream.send(initialPacket(1800, 720));
            await page.waitForFunction(() => {
                const canvas = document.querySelector('.video .touch-layer');
                return canvas?.width === 1800 && canvas?.height === 720;
            });
            await page.getByText('Connected', { exact: true }).waitFor();
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
            if (mobile) await page.getByRole('button', { name: 'Show controls', exact: true }).click();
            await page.getByRole('button', { name: 'Settings', exact: true }).click();
            const dialog = page.locator('.bottom-sheet-root.open [role="dialog"]');
            await dialog.waitFor();
            await dialog.locator('.settings-playback summary').click();
            await dialog.getByText('Show quality stats').waitFor();
            await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
            const playback = await dialog.locator('.settings-playback').textContent();
            assert(!/Fit screen/i.test(playback), label + ': no Fit screen toggle');
            await dialog.locator('.settings-playback').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(OUT, label + '-settings.png') });

            assert.deepEqual(errors, [], label + ': no browser runtime errors');
            await context.close();
            console.log(`PASS ${label}: rotation, input beside the picture, ${mobile ? 'edge swipe' : 'wheel'}, settings without Fit screen`);
        }
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
