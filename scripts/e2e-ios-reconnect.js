// node scripts/test-browser.js ios-reconnect
// The iPhone stream page when the session will not start. Fixture sockets close the way
// CoreDeviceProxy does (4009 a start failed, 4011 the start budget is used up); nothing reaches a
// phone. Covers the growing delay between tries, stopping after three failed starts, the Retry
// button and the header status, at phone and desktop width in both themes. Every state without a
// picture (failed, stopped, no decoder in this browser) is one card on the stage.
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
    const notice = page.locator('.stream-start-error');
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
        // No spinner claiming a reconnect, and nothing lying over the card and its buttons.
        await page.locator('.sleep-overlay').waitFor({ state: 'hidden' });
        await page.locator('.stream-notice').waitFor({ state: 'hidden' });
        assert.equal(await notice.count(), 1, `${label}: the error is shown once`);
        assert.equal(await notice.getAttribute('data-stream-problem'), 'error');
        assert.equal(await notice.getByRole('heading').textContent(), 'Stream unavailable');
        assert.equal(await notice.locator('.stream-start-error-note').count(), 0, `${label}: no retry is promised`);
        const retry = notice.getByRole('button', { name: 'Retry', exact: true });
        assert.ok(await retry.isVisible());
        const box = await retry.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width, `${label}: Retry is inside the viewport`);
        for (const name of ['Retry', 'Phones']) {
            assert.ok(await reachable(page, notice.getByRole('button', { name, exact: true })), `${label}: ${name} can be pressed`);
        }
        const stage = await page.locator('.stream-stage').boundingBox();
        const card = await notice.boundingBox();
        assert.ok(
            Math.abs(card.x + card.width / 2 - width / 2) <= 2 && card.y >= stage.y && card.y + card.height <= stage.y + stage.height,
            `${label}: the card is centred on the stage`,
        );
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
        assert.equal(await notice.locator('p').first().textContent(), BUDGET, `${label}: the server's wording is kept`);
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

/** Whether a click at the middle of `locator` lands on it, not on something lying over it. */
function reachable(page, locator) {
    return locator.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !!hit && (hit === element || element.contains(hit));
    });
}

// A session that was stopped on the phone's side, and a browser that cannot decode the video.
// The fixture drives each state by hand; the socket stays open until it says otherwise.
async function noPicture(browser, { width, height, colorScheme }) {
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
    const sockets = [];
    await page.route('**/api/notifications/**', (route) =>
        route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }),
    );
    await page.routeWebSocket('**', (socket) => {
        const target = new URL(socket.url());
        if (target.searchParams.get('action') === 'proxy-coredevice') {
            sockets.push(socket);
            socket.send(JSON.stringify({ type: 'status', state: 'starting', message: 'Preparing the device' }));
            return;
        }
        socket.onMessage((data) => {
            const frame = Buffer.from(data);
            if (frame.length < 5 || frame[0] !== 4) return;
            if (frame.subarray(5).toString() === 'HSTS') {
                socket.send(channelJson(frame.readUInt32LE(1), { id: -1, type: 'hosts', data: { local: [{ type: 'ios' }] } }));
            } else if (frame.subarray(5).toString() === 'ATRC') {
                socket.send(channelJson(frame.readUInt32LE(1), { id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [{ udid: UDID, name: 'iPhone fixture', state: 'Connected', model: 'iPhone', version: '27', paired: true, developerMode: true, session: 'ready', 'screen.power': 'on', 'device.locked': false }] } }));
            }
        });
    });
    const header = page.locator('.stream-header-status');
    const card = page.locator('.stream-start-error');
    const say = (message) => sockets.at(-1).send(JSON.stringify(message));
    const headerIs = (text) => page.waitForFunction((wanted) => document.querySelector('.stream-header-status')?.textContent.trim() === wanted, text);
    // The hardware buttons sit in the rail on a desktop and behind the controls button on a phone.
    // The toolbar applies the state in an effect, a moment after the header text changes.
    const hardwareDisabled = (disabled) =>
        page.waitForFunction(
            (wanted) =>
                ['Home', 'Lock', 'Volume up', 'Volume down', 'Mute device', 'Siri'].every(
                    (title) => document.querySelector(`button.control-button[title="${title}"]`)?.disabled === wanted,
                ),
            disabled,
            { timeout: 5000 },
        );
    try {
        const url = new URL(BASE);
        url.hash = `!${new URLSearchParams({ action: 'stream-coredevice', udid: UDID })}`;
        await page.goto(url.toString());
        // A first start is progress, not a problem: the notice, no card.
        await page.locator('.stream-notice').filter({ hasText: 'Preparing the device' }).waitFor();
        await headerIs('Starting the phone stream…');
        assert.equal(await card.count(), 0);
        await hardwareDisabled(true); // no controls before the stream is up
        say({ type: 'status', state: 'ready' });
        await headerIs('Connected');
        await hardwareDisabled(false);

        // The session is stopped while the socket stays open.
        say({ type: 'status', state: 'stopped', message: 'Device is rebooting' });
        await card.waitFor();
        assert.equal(await card.getAttribute('data-stream-problem'), 'stopped');
        assert.equal(await card.getByRole('heading').textContent(), 'Stream stopped');
        assert.equal(await card.locator('p').first().textContent(), 'Device is rebooting');
        await headerIs('Stream stopped');
        assert.equal(await header.evaluate((el) => el.classList.contains('connected')), false);
        await hardwareDisabled(true); // no controls for a stopped stream
        for (const name of ['Retry', 'Phones']) {
            assert.ok(await reachable(page, card.getByRole('button', { name, exact: true })), `${label}: ${name} can be pressed`);
        }
        await page.locator('.stream-notice').waitFor({ state: 'hidden' });
        await page.screenshot({ path: path.join(SCREENSHOTS, `ios-stream-stopped-${width}-${colorScheme}.png`) });

        // The server closes the socket and the page connects again: the card stays, with what is happening.
        sockets.at(-1).close({ code: 4007, reason: 'Device is rebooting' });
        await page.waitForFunction(() => document.querySelector('.stream-start-error-note')?.textContent === 'Trying again…', undefined, { timeout: 10000 });
        assert.equal(sockets.length, 2);
        await headerIs('Trying again…');
        assert.equal(await card.locator('p').first().textContent(), 'Device is rebooting', `${label}: the reason stays while it tries again`);
        assert.equal(await page.locator('.stream-notice:visible').count(), 0, `${label}: the progress notice does not cover the card`);
        say({ type: 'status', state: 'ready' });
        await card.waitFor({ state: 'hidden' });
        await headerIs('Connected');

        // The phone's video arrives in a codec this browser has no decoder for.
        say({ type: 'codec', codec: 'hev1.9.9.L999.B0', description: Buffer.from([1, 2, 3, 4]).toString('base64') });
        await card.waitFor();
        assert.equal(await card.getAttribute('data-stream-problem'), 'decoder');
        assert.equal(await card.getByRole('heading').textContent(), 'This browser cannot show the stream');
        assert.match(await card.locator('p').first().textContent(), /cannot decode the phone's HEVC stream \(hev1\.9\.9\.L999\.B0\)/);
        await headerIs('No picture');
        assert.equal(await header.evaluate((el) => el.classList.contains('connected')), false, `${label}: not Connected without a picture`);
        assert.equal(await card.getByRole('button', { name: 'Retry', exact: true }).count(), 0, `${label}: a retry cannot add a decoder`);
        assert.equal(await page.locator('.stream-notice:visible').count(), 0, `${label}: the reason is not a dismissible notice as well`);
        await hardwareDisabled(true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${label}: no sideways scroll`);
        await page.screenshot({ path: path.join(SCREENSHOTS, `ios-stream-no-decoder-${width}-${colorScheme}.png`) });
        // The Actions sheet gives the same reason for its paused rows, not "Reconnecting".
        if (width < 600) await page.locator('.floating-toolbar-fab').click();
        await page.locator('button.control-button[title="Actions"]').click();
        const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
        await actions.getByText('This browser cannot show the phone’s video. Actions that need the stream are off.', { exact: true }).waitFor();
        assert.equal(await actions.getByText(/Reconnecting to the phone/).count(), 0, `${label}: no reconnect is claimed`);
        await page.getByRole('button', { name: 'Close Actions', exact: true }).click();
        await actions.waitFor({ state: 'hidden' });
        const back = card.getByRole('button', { name: 'Phones', exact: true });
        assert.ok(await reachable(page, back));
        await back.click();
        await page.locator(`[data-device-key="ios:${UDID}"]`).waitFor();
        assert.deepEqual(errors, []);
        console.log('PASS iOS stream without a picture', label);
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
        await noPicture(browser, { width: 390, height: 844, colorScheme: 'light' });
        await noPicture(browser, { width: 390, height: 844, colorScheme: 'dark' });
        await noPicture(browser, { width: 1280, height: 800, colorScheme: 'light' });
        await noPicture(browser, { width: 1280, height: 800, colorScheme: 'dark' });
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
