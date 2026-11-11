/* eslint-disable */
// E2E_OUT=/tmp/ws-scrcpy-android-lifecycle node scripts/test-browser.js android-lifecycle
// What the browser shows for the Android server lifecycle: adb unavailable, Wake from the card
// while the stream service is stopped, and a stream whose service the owner stopped.
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
    const state = { errors: [], commands: [], streams: [], tracker: undefined, onCommand: undefined };
    page.on('pageerror', (error) => state.errors.push(error.message));
    await page.routeWebSocket('**', (socket) => {
        const target = new URL(socket.url());
        if (target.pathname === '/__lifecycle_fixture__' || target.searchParams.get('action') === 'proxy-adb') {
            state.streams.push(socket);
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
    const notice = page.locator('.tracker-status-notice');
    await notice.waitFor();
    assert.match(await notice.textContent(), /Android devices are unavailable\. The server cannot reach adb/);
    assert.equal(await notice.getAttribute('role'), 'status');
    await fits(page, notice, `${label} adb notice`);
    await page.screenshot({ path: path.join(OUT, `${label}-adb-unavailable.png`) });

    // adb is back: the list that was already open gets the phone, and the notice goes.
    state.tracker.adb(true);
    state.tracker.update(phone({ 'screen.power': 'on', 'device.awake': true }));
    await page.locator('.device').filter({ hasText: UDID }).waitFor();
    await notice.waitFor({ state: 'detached' });
    assert.deepEqual(state.errors, [], 'no browser runtime errors');
    await context.close();
}

async function wakeFromCard(browser, layout, label) {
    const { context, page, state } = await start(browser, { ...layout, device: phone() });
    await page.goto(BASE);
    const card = page.locator('.device').filter({ hasText: UDID });
    await card.waitFor();
    await card.locator('.stream-service-status[data-stream-service="stopped"]').waitFor();
    const banner = card.locator('.device-asleep-banner');
    const wake = banner.getByRole('button', { name: 'Wake', exact: true });
    await wake.waitFor();
    assert.match(await banner.textContent(), /Screen is asleep\./);

    // The reply is held back so the pending state can be seen.
    let answer;
    state.onCommand = (command, send) => {
        if (command.type === 'wake_device') answer = (data) => send({ id: command.id, type: command.type, data });
    };
    await wake.click();
    const waking = banner.getByRole('button', { name: 'Waking…', exact: true });
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
    assert(button.height >= 44 && button.width >= 44, 'the Wake button keeps a touch-sized target');
    await card.screenshot({ path: path.join(OUT, `${label}-wake-failed.png`) });

    // The screen came on: the banner goes with the asleep state.
    state.tracker.update(phone({ 'screen.power': 'on', 'device.awake': true }));
    await banner.waitFor({ state: 'detached' });
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
    assert.match(await panel.textContent(), /Stream service stopped/);
    // Longer than the first reconnect delays of the stream receiver (1 s, then 1.5 s).
    await pause(3500);
    assert.equal(state.streams.length, 1, 'the viewer does not reconnect, which would start the service again');
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

    // Any other close still reconnects by itself.
    state.streams[1].close({ code: 4007, reason: 'Stream restarted' });
    await page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.trim() !== 'Connected');
    await status.getByText('Connected', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(state.streams.length, 3);
    assert.equal(await panel.count(), 0);
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
            }
        }
        console.log('PASS: adb notice, Wake from the card, and the stopped stream service state');
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
