/* eslint-disable */
// E2E_OUT=/tmp/ws-scrcpy-android-lifecycle node scripts/test-browser.js android-lifecycle
// What the browser shows for the Android server lifecycle: adb unavailable, Wake from the card
// while the stream service is stopped, a stream whose service the owner stopped, and the card
// over the picture of a phone whose screen is off.
// Every socket is a fixture: nothing reaches a server or a phone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-android-lifecycle';
const UDID = 'lifecycle-fixture-android';
const TRACKER = { id: 'lifecycle-fixture-tracker', name: 'Lifecycle test host' };
const STREAM_SERVICE_STOPPED = 4012;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

function phone(extra = {}) {
    return {
        udid: UDID,
        state: 'device',
        pid: -1,
        interfaces: [],
        'ro.product.model': 'Pixel fixture',
        'ro.product.manufacturer': 'Fixture',
        'ro.build.version.release': '16',
        'ro.build.version.sdk': '36',
        'ro.product.cpu.abi': 'arm64-v8a',
        'screen.power': 'off',
        'device.awake': false,
        'battery.level': 80,
        'battery.charging': false,
        ...extra,
    };
}

async function start(browser, { mobile, dark, device }) {
    const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme: dark ? 'dark' : 'light',
    });
    const page = await context.newPage();
    const state = { errors: [], commands: [], streams: [], keys: [], tracker: undefined, onCommand: undefined };
    page.on('pageerror', (error) => state.errors.push(error.message));
    await page.routeWebSocket('**', (socket) => {
        const target = new URL(socket.url());
        if (target.pathname === '/__lifecycle_fixture__' || target.searchParams.get('action') === 'proxy-adb') {
            state.streams.push(socket);
            // The key messages the page sends to the phone: type 0, action, key code.
            socket.onMessage((data) => {
                const bytes = Buffer.from(data);
                for (let offset = 0; bytes[offset] === 0 && offset + 14 <= bytes.length; offset += 14) {
                    state.keys.push({ action: bytes[offset + 1], code: bytes.readInt32BE(offset + 2) });
                }
            });
            setTimeout(() => socket.send(initialStreamPacket()), 100);
            return;
        }
        socket.onMessage((data) => {
            const frame = Buffer.from(data);
            if (frame.length < 5) return;
            const id = frame.readUInt32LE(1);
            const send = (message) => socket.send(channelJson(id, message));
            if (frame[0] === 4) {
                const code = frame.subarray(5).toString();
                if (code === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }] } });
                if (code === 'GTRC') {
                    state.tracker = {
                        list: (list) => send({ id: -1, type: 'devicelist', data: { ...TRACKER, list } }),
                        update: (next) => send({ id: -1, type: 'device', data: { ...TRACKER, device: next } }),
                        adb: (available) => send({ id: -1, type: 'tracker_status', data: { ...TRACKER, available } }),
                    };
                    state.tracker.list(device ? [device] : []);
                    state.tracker.adb(!!device);
                }
            } else if (frame[0] === 32) {
                const command = JSON.parse(frame.subarray(5).toString());
                state.commands.push(command);
                if (state.onCommand) state.onCommand(command, send);
            }
        });
    });
    return { context, page, state };
}

/** Nothing in `locator` reaches outside the viewport, and the page does not scroll sideways. */
async function fits(page, locator, label) {
    const box = await locator.boundingBox();
    const viewport = page.viewportSize();
    assert(box, `${label}: is rendered`);
    assert(box.x >= 0 && box.x + box.width <= viewport.width + 1, `${label}: stays inside the viewport`);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(sideways <= 1, `${label}: no horizontal page scroll`);
}

async function adbUnavailable(browser, layout, label) {
    const { context, page, state } = await start(browser, layout);
    await page.goto(BASE);
    const notice = page.locator('.devices-content > .kit-banner');
    await notice.waitFor();
    assert.match(await notice.textContent(), /Android devices are unavailable\. The server cannot reach adb/);
    assert.equal(await notice.getAttribute('role'), 'status');
    await fits(page, notice, `${label} adb notice`);
    await page.screenshot({ path: path.join(OUT, `${label}-adb-unavailable.png`) });

    // adb is back: the list that was already open gets the phone, and the notice goes.
    state.tracker.adb(true);
    state.tracker.update(phone({ 'screen.power': 'on', 'device.awake': true }));
    await page.locator(`.device[data-device-key$=":${UDID}"]`).waitFor();
    await notice.waitFor({ state: 'detached' });
    assert.deepEqual(state.errors, [], 'no browser runtime errors');
    await context.close();
}

async function wakeFromCard(browser, layout, label) {
    const { context, page, state } = await start(browser, { ...layout, device: phone() });
    await page.goto(BASE);
    const card = page.locator(`.device[data-device-key$=":${UDID}"]`);
    await card.waitFor();
    // Asleep is the status, with Wake beside it. The stream service is stopped, which does not
    // keep Wake from working, and no banner repeats the status.
    // Wake and its outcome are on the card: the button in the head, the outcome under it.
    const banner = card;
    const head = card.locator('.phone-row-status');
    await head.locator('.kit-chip').getByText('Asleep', { exact: true }).waitFor();
    const wake = head.getByRole('button', { name: 'Wake', exact: true });
    await wake.waitFor();
    assert.equal(await card.getByText('Screen is asleep').count(), 0, 'no banner says the status again');

    // The reply is held back so the pending state can be seen.
    let answer;
    state.onCommand = (command, send) => {
        if (command.type === 'wake_device') answer = (data) => send({ id: command.id, type: command.type, data });
    };
    await wake.click();
    const waking = head.getByRole('button', { name: 'Waking…', exact: true });
    await waking.waitFor();
    assert.equal(await waking.isDisabled(), true, 'the button cannot be pressed twice while waking');
    const sent = state.commands.filter((command) => command.type === 'wake_device');
    assert.deepEqual(
        sent.map((command) => command.data),
        [{ udid: UDID }],
        'Wake is one tracker command',
    );
    assert.equal(state.streams.length, 0, 'and opens no stream connection');

    answer({ udid: UDID });
    await banner.getByText('Wake sent. Waiting for the screen.').waitFor();
    await fits(page, banner, `${label} wake sent`);
    await card.screenshot({ path: path.join(OUT, `${label}-wake-sent.png`) });

    await banner.getByRole('button', { name: 'Wake', exact: true }).click();
    await banner.getByRole('button', { name: 'Waking…', exact: true }).waitFor();
    answer({ udid: UDID, error: 'The device is not connected.' });
    await banner.getByText('Could not wake the screen. The device is not connected.').waitFor();
    await fits(page, banner, `${label} wake failed`);
    const button = await banner.getByRole('button', { name: 'Wake', exact: true }).boundingBox();
    // The kit's compact button: 44px under a finger, 32px under a mouse.
    assert(button.height >= (layout.mobile ? 44 : 32) && button.width >= 44, 'the Wake button keeps a touch-sized target');
    await card.screenshot({ path: path.join(OUT, `${label}-wake-failed.png`) });

    // The screen came on: Wake and its outcome go with the asleep state.
    state.tracker.update(phone({ 'screen.power': 'on', 'device.awake': true }));
    await head.locator('.kit-chip').getByText('Ready', { exact: true }).waitFor();
    await head.getByRole('button', { name: 'Wake', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await card.getByText('Could not wake the screen', { exact: false }).count(), 0, 'the outcome went with the sleep');
    assert.equal(state.commands.filter((command) => command.type === 'wake_device').length, 2, 'one wake per press');
    assert.equal(state.streams.length, 0);
    assert.deepEqual(state.errors, [], 'no browser runtime errors');
    await context.close();
}

async function stoppedStream(browser, layout, label) {
    const device = phone({ pid: 123, 'screen.power': 'on', 'device.awake': true });
    const { context, page, state } = await start(browser, { ...layout, device });
    const ws = new URL('/__lifecycle_fixture__', BASE);
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(BASE);
    url.hash = `!${new URLSearchParams({ action: 'stream', udid: UDID, player: 'webcodecs', ws: ws.toString(), captureKeyboard: '0', fitToScreen: '1' })}`;
    await page.goto(url.toString());
    const status = page.locator('.kit-bar-status');
    await status.getByText('Connected', { exact: true }).waitFor();
    assert.equal(state.streams.length, 1);

    // The owner stops the stream service from another page.
    state.tracker.update({ ...device, pid: -1 });
    state.streams[0].close({ code: STREAM_SERVICE_STOPPED, reason: 'Stream service stopped' });
    const panel = page.locator('.stream-service-stopped');
    await panel.waitFor();
    await status.getByText('Stopped', { exact: true }).waitFor();
    assert.equal(await status.getAttribute('data-tone'), 'neutral');
    assert.match(await panel.textContent(), /Stream service stopped/);
    // Longer than the first reconnect delays of the stream receiver (1 s, then 1.5 s).
    await pause(3500);
    assert.equal(state.streams.length, 1, 'the viewer does not reconnect, which would start the service again');
    // One card on the stage: no Reconnecting spinner under the stopped card.
    assert.equal(await page.locator('.stream-state-card').count(), 1, `${label}: the stopped card is the one card`);
    assert.equal(await page.locator('.stream-state-spinner').count(), 0, `${label}: and it has no spinner`);
    await fits(page, panel, `${label} stopped panel`);
    for (const name of ['Start again', 'Phones']) {
        const box = await panel.getByRole('button', { name, exact: true }).boundingBox();
        assert(box.height >= 44, `${name} is a 44px target`);
    }
    // The card's actions are the kit's buttons: Start again is the one primary.
    assert.deepEqual(await panel.locator('button').evaluateAll((buttons) => buttons.map((button) => button.className)), ['kit-button kit-button-primary', 'kit-button'], `${label}: the card's buttons`);
    await page.screenshot({ path: path.join(OUT, `${label}-stream-stopped.png`) });

    await panel.getByRole('button', { name: 'Start again', exact: true }).click();
    await status.getByText('Connected', { exact: true }).waitFor();
    await panel.waitFor({ state: 'detached' });
    assert.equal(state.streams.length, 2, 'Start again opens a new connection, which starts the service');

    // Any other close still reconnects by itself. A page that was connected says Reconnecting,
    // in the header and on the card over the picture alike.
    state.streams[1].close({ code: 4007, reason: 'Stream restarted' });
    await page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.trim() !== 'Connected');
    await status.getByText('Reconnecting…', { exact: true }).waitFor();
    await page.locator('.stream-state-card .stream-state-title').getByText('Reconnecting…', { exact: true }).waitFor();
    assert.equal(await status.getAttribute('data-tone'), 'warning');
    await status.getByText('Connected', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(state.streams.length, 3);
    assert.equal(await panel.count(), 0);
    assert.deepEqual(state.errors, [], 'no browser runtime errors');
    await context.close();
}

/**
 * A phone whose screen is off, on its page: the card on the stage has the kit's Wake button,
 * which sends one wake key to the phone and hides the card. The card covers neither the header
 * nor the tabs, which take a press.
 */
async function sleepCard(browser, layout, label) {
    const device = phone({ pid: 123 });
    const { context, page, state } = await start(browser, { ...layout, device });
    await page.goto(`${BASE}#!action=device&udid=${UDID}&view=screen`);
    await page.locator('.kit-bar-status').getByText('Connected', { exact: true }).waitFor();
    const overlay = page.locator('.stream-state');
    const card = overlay.locator('.stream-state-card');
    await card.getByText('Screen is asleep', { exact: true }).waitFor();
    const wake = card.getByRole('button', { name: 'Wake', exact: true });
    assert.deepEqual(
        await card.locator('button').evaluateAll((buttons) => buttons.map((button) => button.className)),
        ['kit-button kit-button-primary'],
        `${label}: the card has one action, the kit's primary button`,
    );
    assert.equal(await card.locator('svg.kit-icon').count(), 1, `${label}: the moon is an icon of the set`);
    assert.equal((await card.textContent()).trim(), 'Screen is asleepWake', `${label}: no character stands in for an icon`);
    const box = await wake.boundingBox();
    assert(box.height >= 44 && box.width >= 44, `${label}: Wake is a 44px target`);
    await fits(page, card, `${label} sleep card`);
    // The card lies on the stage only.
    const above = await page.evaluate(() => {
        const hits = (element) => {
            const rect = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
        };
        const header = document.querySelector('header.kit-bar');
        return {
            back: hits(header.querySelector('.kit-bar-back')),
            switch: hits([...header.querySelectorAll('button')].find((button) => button.textContent === 'Switch')),
            tabs: [...document.querySelectorAll('nav.kit-tabs .kit-tab')].every(hits),
        };
    });
    assert.deepEqual(above, { back: true, switch: true, tabs: true }, `${label}: the header and the tabs take a press beside the card`);
    await page.screenshot({ path: path.join(OUT, `${label}-sleep-card.png`) });

    state.keys.length = 0;
    await wake.click();
    await overlay.waitFor({ state: 'detached' });
    for (let waited = 0; state.keys.length < 2 && waited < 2000; waited += 50) await pause(50);
    const WAKEUP = 224;
    assert.deepEqual(state.keys, [{ action: 0, code: WAKEUP }, { action: 1, code: WAKEUP }], `${label}: Wake sends one wake key`);
    assert.equal(state.streams.length, 1, `${label}: one stream for the page`);
    assert.deepEqual(state.errors, [], 'no browser runtime errors');
    await context.close();
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [true, false]) {
            for (const dark of [false, true]) {
                const layout = { mobile, dark };
                const label = `${mobile ? 'phone' : 'desktop'}-${dark ? 'dark' : 'light'}`;
                await adbUnavailable(browser, layout, label);
                await wakeFromCard(browser, layout, label);
                await stoppedStream(browser, layout, label);
                await sleepCard(browser, layout, label);
            }
        }
        console.log('PASS: adb notice, Wake from the card, the stopped stream service state, and Wake on the screen');
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
