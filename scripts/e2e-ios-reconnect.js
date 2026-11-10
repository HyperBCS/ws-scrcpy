/* eslint-disable */
// node scripts/test-browser.js ios-reconnect
// The iPhone stream page when the session will not start. Fixture sockets close the way
// CoreDeviceProxy does (4009 a start failed, 4011 the start budget is used up); nothing reaches a
// phone. Covers the growing delay between tries, stopping after three failed starts, the Retry
// button and the header status, at phone and desktop width in both themes.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
const SCREENSHOTS = process.env.SCREENSHOTS || '/tmp';
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const UDID = 'fixture-iphone-reconnect';
const FAILURE = 'The screen stream exited (3)';
const BUDGET =
    "This phone's screen session was started 3 times in the last 5 min. The next start is allowed in 2 min.";

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

async function run(browser, { width, height, colorScheme, checkTiming }) {
    const label = `${width}x${height} ${colorScheme}`;
    const context = await browser.newContext({
        viewport: { width, height },
        isMobile: width < 600,
        hasTouch: width < 600,
        colorScheme,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // What the fixture server does with the next stream socket.
    let mode = 'fail';
    const opened = [];
    let live;
    await page.route('**/api/notifications/**', (route) =>
        route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }),
    );
    await page.routeWebSocket('**', (socket) => {
        const target = new URL(socket.url());
        if (target.searchParams.get('action') === 'proxy-coredevice') {
            opened.push(Date.now());
            live = socket;
            socket.send(JSON.stringify({ type: 'status', state: 'starting' }));
            if (mode === 'ready') {
                setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 30);
                return;
            }
            setTimeout(() => {
                socket.send(JSON.stringify({ type: 'status', state: 'error', message: mode === 'budget' ? BUDGET : FAILURE }));
                socket.close({ code: mode === 'budget' ? 4011 : 4009, reason: 'Stream unavailable' });
            }, 30);
            return;
        }
        socket.onMessage((data) => {
            const frame = Buffer.from(data);
            if (frame.length < 5 || frame[0] !== 4) return;
            if (frame.subarray(5).toString() === 'HSTS') {
                socket.send(channelJson(frame.readUInt32LE(1), { id: -1, type: 'hosts', data: { local: [{ type: 'ios' }] } }));
            } else if (frame.subarray(5).toString() === 'ATRC') {
                socket.send(channelJson(frame.readUInt32LE(1), { id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [{ udid: UDID, name: 'iPhone fixture', state: 'Connected', model: 'iPhone', version: '27', paired: true, developerMode: true, session: 'error', 'screen.power': 'on', 'device.locked': false }] } }));
            }
        });
    });
    const header = page.locator('.stream-header-status');
    const notice = page.locator('.stream-notice.error');
    const noOverflow = async () =>
        assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            `${label}: the page does not scroll sideways`,
        );
    try {
        const url = new URL(BASE);
        url.hash = `!${new URLSearchParams({ action: 'stream-coredevice', udid: UDID })}`;
        await page.goto(url.toString());

        // Three failed starts, each try later than the one before, then no more.
        await notice.filter({ hasText: 'Stopped retrying after 3 failed starts.' }).waitFor({ timeout: 15000 });
        assert.equal(opened.length, 3, `${label}: three starts were tried`);
        assert.ok(opened[1] - opened[0] >= 900, `${label}: the second try waits about 1 s`);
        assert.ok(opened[2] - opened[1] >= 1900, `${label}: the third try waits about 2 s`);
        assert.match(await notice.textContent(), /The screen stream exited \(3\)\. Stopped retrying after 3 failed starts\./);
        assert.match(await header.textContent(), /Stream unavailable/, `${label}: the header does not say Connecting`);
        // No spinner claiming a reconnect, and nothing lying over the notice and its button.
        await page.locator('.sleep-overlay').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('.stream-notice').count(), 1, `${label}: the error is shown once`);
        const retry = notice.getByRole('button', { name: 'Retry', exact: true });
        assert.ok(await retry.isVisible());
        const box = await retry.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width, `${label}: Retry is inside the viewport`);
        await noOverflow();
        if (checkTiming) {
            // The next try would have come 4 s after the third.
            await page.waitForTimeout(4600);
            assert.equal(opened.length, 3, `${label}: no fourth start without Retry`);
        }
        await page.screenshot({ path: path.join(SCREENSHOTS, `ios-reconnect-stopped-${width}-${colorScheme}.png`) });

        // Retry connects at once.
        mode = 'ready';
        await retry.click();
        await page.waitForFunction(() => document.querySelector('.stream-header-status')?.textContent.includes('Connected'));
        assert.equal(opened.length, 4);
        // The error notice goes once the stream is up.
        await notice.waitFor({ state: 'hidden' });

        // The session drops and the phone's start budget is used up: one refusal, then no more tries.
        mode = 'budget';
        live.close({ code: 4007, reason: 'Session stopped' });
        await notice.filter({ hasText: 'The next start is allowed in 2 min.' }).waitFor({ timeout: 15000 });
        const before = opened.length;
        assert.equal(await notice.locator('span').textContent(), BUDGET, `${label}: the server's wording is kept`);
        assert.match(await header.textContent(), /Stream unavailable/);
        await noOverflow();
        await page.waitForTimeout(1500);
        assert.equal(opened.length, before, `${label}: a budget refusal is not retried`);
        await page.screenshot({ path: path.join(SCREENSHOTS, `ios-reconnect-budget-${width}-${colorScheme}.png`) });
        assert.deepEqual(errors, []);
        console.log('PASS iOS reconnect', label);
    } finally {
        await context.close();
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        await run(browser, { width: 390, height: 844, colorScheme: 'dark', checkTiming: true });
        await run(browser, { width: 390, height: 844, colorScheme: 'light' });
        await run(browser, { width: 1280, height: 800, colorScheme: 'dark' });
        await run(browser, { width: 1280, height: 800, colorScheme: 'light' });
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
