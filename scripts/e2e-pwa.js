/* eslint-disable */
// BASE=http://127.0.0.1:8000 SERIAL=<optional serial> node scripts/e2e-pwa.js
// Reads the device list/settings only. Remote gestures use an intercepted WebSocket and never
// reach hardware. Inert cloned cards make list scrolling independent of attached-device count.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SERIAL = process.env.SERIAL;

async function settle(page) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function shellPosition(page) {
    return page.evaluate(() => ({
        scale: visualViewport.scale,
        x: scrollX,
        y: scrollY,
        pageLeft: visualViewport.pageLeft,
        pageTop: visualViewport.pageTop,
        documentX: document.scrollingElement.scrollLeft,
        documentY: document.scrollingElement.scrollTop,
    }));
}

async function assertFixedShell(page, label) {
    const position = await shellPosition(page);
    assert(Math.abs(position.scale - 1) < 0.001, `${label}: browser zoomed ${JSON.stringify(position)}`);
    for (const key of ['x', 'y', 'pageLeft', 'pageTop', 'documentX', 'documentY']) {
        assert(Math.abs(position[key]) < 1, `${label}: shell moved ${JSON.stringify(position)}`);
    }
}

async function swipe(cdp, x, y, xDistance, yDistance) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y, force: 1 }] });
    for (let step = 1; step <= 12; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ id: 1, x: x + (xDistance * step) / 12, y: y + (yDistance * step) / 12, force: 1 }],
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// One display with a real 720×1280 screen description, sufficient to initialize both canvases.
// No encoded video is needed to verify touch geometry and outgoing protocol messages.
function initialStreamPacket() {
    const packet = Buffer.alloc(186);
    packet.write('scrcpy_initial');
    packet.write('PWA touch fixture', 14);
    packet.writeInt32BE(1, 78); // Display count.
    packet.writeInt32BE(720, 86);
    packet.writeInt32BE(1280, 90);
    packet.writeInt32BE(25, 110); // ScreenInfo length.
    packet.writeInt32BE(720, 122);
    packet.writeInt32BE(1280, 126);
    packet.writeInt32BE(720, 130);
    packet.writeInt32BE(1280, 134);
    packet.writeInt32BE(35, 139); // VideoSettings length.
    packet.writeInt32BE(4000000, 143);
    packet.writeInt32BE(60, 147);
    packet.writeInt8(1, 151);
    packet.writeInt8(-1, 165);
    packet.writeInt32BE(1, 182); // Client ID.
    return packet;
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({
            viewport: { width: 440, height: 956 },
            isMobile: true,
            hasTouch: true,
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => {
            errors.push(error.message);
            console.error('Browser error:', error.message);
        });
        const cdp = await context.newCDPSession(page);
        await page.goto(BASE);
        const original = SERIAL
            ? page.locator('.device').filter({ hasText: SERIAL }).first()
            : page.locator('.device').first();
        await original.waitFor();
        await original.evaluate((card) => {
            card.setAttribute('data-pwa-target', 'true');
            for (let i = 0; i < 12; i++) {
                const filler = card.cloneNode(true);
                filler.removeAttribute('data-pwa-target');
                filler.setAttribute('data-pwa-filler', 'true');
                filler.setAttribute('aria-hidden', 'true');
                filler.inert = true;
                filler.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
                card.parentElement.insertBefore(filler, card);
            }
        });
        const list = page.locator('#devices');
        assert(
            await list.evaluate((el) => el.scrollHeight > el.clientHeight + 1000),
            'fixture creates a long internal device list',
        );
        await list.evaluate((el) => {
            el.scrollTop = 0;
        });
        await swipe(cdp, 195, 680, 0, -360);
        await settle(page);
        assert(await list.evaluate((el) => el.scrollTop > 100), 'one-finger swipe scrolls the device list');
        await assertFixedShell(page, 'internal list scroll');
        await swipe(cdp, 190, 400, 120, 0);
        await settle(page);
        await assertFixedShell(page, 'horizontal swipe');
        await list.evaluate((el) => {
            el.scrollTop = 0;
        });
        await swipe(cdp, 195, 250, 0, 260);
        await settle(page);
        assert.equal(await list.evaluate((el) => el.scrollTop), 0, 'pull gesture stays at the list boundary');
        await assertFixedShell(page, 'pull beyond top boundary');
        // Direct touch events exercise browser zoom in headless Chromium; its synthetic pinch
        // helper can finish successfully without actually generating a gesture.
        const pinchPoints = (distance) => [
            { id: 1, x: 195 - distance, y: 350 - distance, force: 1 },
            { id: 2, x: 195 + distance, y: 350 + distance, force: 1 },
        ];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pinchPoints(25) });
        for (let step = 1; step <= 12; step++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pinchPoints(25 + step * 5) });
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await settle(page);
        await assertFixedShell(page, 'native browser pinch');
        const safariGestures = await page.evaluate(() =>
            ['gesturestart', 'gesturechange'].map((name) => {
                const event = new Event(name, { bubbles: true, cancelable: true });
                document.dispatchEvent(event);
                return event.defaultPrevented;
            }),
        );
        assert.deepEqual(safariGestures, [true, true], 'Safari gesture handlers cancel browser zoom');

        const settings = page.locator('[data-pwa-target] button').filter({ hasText: 'Settings' });
        await settings.scrollIntoViewIfNeeded();
        const savedTop = await list.evaluate((el) => el.scrollTop);
        assert(savedTop > 500, 'settings opens from a genuinely scrolled actual device card');
        await settings.click();
        const dialog = page.locator('.bottom-sheet-root.open [role="dialog"]');
        await dialog.waitFor();
        await dialog.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
        assert.equal(await list.evaluate((el) => el.scrollTop), savedTop, 'opening settings preserves list position');
        assert(
            await page.locator('body').evaluate((el) => el.classList.contains('sheet-open')),
            'opening sheet locks the list scroller',
        );
        await dialog.getByText('Advanced quality settings', { exact: true }).click();
        const body = page.locator('.bottom-sheet-root.open .bottom-sheet-body');
        assert(
            await body.evaluate((el) => el.scrollHeight > el.clientHeight),
            'settings body is independently scrollable',
        );
        const dialogBox = await dialog.boundingBox();
        const backdropPoint = { x: 4, y: Math.max(2, Math.min(40, dialogBox.y / 2)) };
        assert(
            await page.evaluate(
                ({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('bottom-sheet-backdrop'),
                backdropPoint,
            ),
            'backdrop gesture starts outside the sheet',
        );
        await page.mouse.move(backdropPoint.x, backdropPoint.y);
        await page.mouse.wheel(0, 500);
        await swipe(cdp, backdropPoint.x, backdropPoint.y, 0, 150);
        await settle(page);
        assert.equal(await list.evaluate((el) => el.scrollTop), savedTop, 'backdrop wheel/swipe cannot move the list');
        await assertFixedShell(page, 'backdrop gestures');
        await body.evaluate((el) => {
            el.scrollTop = 0;
        });
        const bodyBox = await body.boundingBox();
        await page.mouse.move(bodyBox.x + 4, bodyBox.y + bodyBox.height / 2);
        await page.mouse.wheel(0, 350);
        await settle(page);
        assert(await body.evaluate((el) => el.scrollTop > 50), 'wheel scrolls sheet content');
        await body.evaluate((el) => {
            el.scrollTop = 0;
        });
        await swipe(cdp, bodyBox.x + 4, bodyBox.y + bodyBox.height - 35, 0, -Math.min(300, bodyBox.height - 70));
        await settle(page);
        assert(await body.evaluate((el) => el.scrollTop > 50), 'one-finger swipe scrolls sheet content');
        assert.equal(
            await list.evaluate((el) => el.scrollTop),
            savedTop,
            'sheet body scroll leaves the list untouched',
        );
        await dialog.getByRole('button', { name: /^Close / }).click();
        await page.locator('.bottom-sheet-root.open').waitFor({ state: 'detached' });
        assert.equal(
            await list.evaluate((el) => el.scrollTop),
            savedTop,
            'closing settings restores the exact list position',
        );
        assert(
            await settings.evaluate((el) => el === document.activeElement),
            'closing settings restores the actual card button focus',
        );
        await assertFixedShell(page, 'sheet closed');

        console.log('PASS: fixed shell, native pinch, internal list scrolling, and sheet scroll isolation/restoration');
        // Install the socket fixture before a fresh document loads; hash-only navigation keeps
        // an existing document whose WebSocket constructor may predate Playwright routing.
        await page.goto('about:blank');
        const messages = [];
        const mockUrl = new URL(BASE);
        mockUrl.protocol = mockUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        mockUrl.pathname = '/__pwa_mock_stream__';
        mockUrl.search = '';
        mockUrl.hash = '';
        await page.routeWebSocket(mockUrl.toString(), (socket) => {
            socket.onMessage((message) => messages.push(Buffer.from(message)));
            setTimeout(() => socket.send(initialStreamPacket()), 50);
        });
        const streamUrl = new URL(BASE);
        streamUrl.hash = `!${new URLSearchParams({ action: 'stream', udid: 'pwa-gesture-fixture', player: 'webcodecs', ws: mockUrl.toString(), captureKeyboard: '0', fitToScreen: '1' })}`;
        await page.goto(streamUrl.toString());
        await page.getByText('Connected', { exact: true }).waitFor();
        const canvas = page.locator('.touch-layer');
        await canvas.waitFor({ state: 'visible' });
        const screen = await canvas.boundingBox();
        const middleX = screen.x + screen.width / 2;
        const middleY = screen.y + screen.height / 2;
        messages.length = 0;
        const points = (distance) => [
            { id: 11, x: middleX - distance, y: middleY - distance, radiusX: 2, radiusY: 2, force: 1 },
            { id: 22, x: middleX + distance, y: middleY + distance, radiusX: 2, radiusY: 2, force: 1 },
        ];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(30) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(50) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(70) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await settle(page);
        const touches = messages.filter((message) => message.length === 32 && message[0] === 2);
        const pointers = new Set(touches.map((message) => message.readBigUInt64BE(2).toString()));
        assert.equal(pointers.size, 2, 'both remote fingers survive browser zoom prevention');
        for (const pointer of pointers) {
            const actions = touches
                .filter((message) => message.readBigUInt64BE(2).toString() === pointer)
                .map((message) => message[1]);
            for (const action of [0, 2, 1])
                assert(actions.includes(action), `remote pointer ${pointer} gets down/move/up: ${actions}`);
        }
        await assertFixedShell(page, 'remote two-finger gesture');
        assert.deepEqual(errors, [], 'no browser runtime errors');
        console.log(
            `PASS: fixed PWA shell, native pinch prevention, internal list scrolling, sheet scroll isolation/restoration, and two remote fingers (${touches.length} touch messages; no hardware input)`,
        );
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
