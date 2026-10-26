/* eslint-disable */
// BASE=http://127.0.0.1:8010/ BROWSER=chromium node scripts/e2e-android-keyboard.js
// All sockets/APIs are fixtures. No Android device, ADB command, or real input is used.
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const browserName = process.env.BROWSER || 'chromium';

function initial(clientId) {
    const packet = Buffer.alloc(186);
    packet.write('scrcpy_initial');
    packet.write('Android keyboard fixture', 14);
    packet.writeInt32BE(1, 78);
    packet.writeInt32BE(720, 86);
    packet.writeInt32BE(1280, 90);
    packet.writeInt32BE(25, 110);
    packet.writeInt32BE(720, 122);
    packet.writeInt32BE(1280, 126);
    packet.writeInt32BE(720, 130);
    packet.writeInt32BE(1280, 134);
    packet.writeInt32BE(35, 139);
    packet.writeInt32BE(4000000, 143);
    packet.writeInt32BE(60, 147);
    packet.writeInt8(1, 151);
    packet.writeInt8(-1, 165);
    packet.writeInt32BE(clientId, 182);
    return packet;
}

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

async function settle(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function waitUntil(page, ready, label) {
    for (let tries = 0; tries < 150 && !ready(); tries++) await page.waitForTimeout(20);
    assert.ok(ready(), label);
}

async function start(browser, { clientId = 31, mobile = false } = {}) {
    const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 900 },
        isMobile: mobile, hasTouch: mobile,
    });
    const page = await context.newPage();
    const errors = [];
    const messages = [];
    const messageTimes = [];
    const connections = [];
    let holdHandshake = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', socket => {
        if (new URL(socket.url()).pathname === '/__android_keyboard_fixture__') {
            const connection = { socket, id: clientId + connections.length, messages: [] };
            connections.push(connection);
            socket.onMessage(data => {
                const message = Buffer.from(data);
                messages.push(message);
                messageTimes.push({ type: message[0], at: Date.now() });
                connection.messages.push(message);
            });
            if (!holdHandshake) setTimeout(() => socket.send(initial(connection.id)), 50);
            return;
        }
        socket.onMessage(data => {
            const frame = Buffer.from(data);
            if (frame[0] === 4 && frame.subarray(5).toString() === 'HSTS') {
                socket.send(channelJson(frame.readUInt32LE(1), { id: -1, type: 'hosts', data: { local: [] } }));
            }
        });
    });
    const socketUrl = new URL('/__android_keyboard_fixture__', BASE);
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(BASE);
    url.hash = `!${new URLSearchParams({ action: 'stream', udid: 'android-keyboard-fixture', player: browserName === 'webkit' ? 'mse' : 'webcodecs', ws: socketUrl.toString(), fitToScreen: '1' })}`;
    await page.goto(url.toString());
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.locator('.touch-layer').waitFor({ state: 'visible' });
    await settle(page);
    const uhid = () => messages.filter(message => message[0] >= 12 && message[0] <= 14);
    return { context, page, errors, messages, messageTimes, connections, uhid, hold: next => { holdHandshake = next; } };
}

async function focusScreen(page) {
    await page.locator('.touch-layer').focus();
}

async function pressKey(page, code, down = true) {
    await page.locator('.touch-layer').evaluate((target, { code, down }) => {
        target.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, bubbles: true, cancelable: true }));
    }, { code, down });
    await settle(page);
}

async function lazyLifecycle(browser) {
    const fixture = await start(browser, { mobile: true });
    const { page, uhid } = fixture;
    try {
        assert.deepEqual(uhid(), [], 'opening a touch stream must not attach a hardware keyboard');
        await page.locator('.touch-layer').tap({ position: { x: 20, y: 20 } });
        assert.deepEqual(uhid(), [], 'remote touches keep the software keyboard available');
        await pressKey(page, 'KeyA', false);
        await pressKey(page, 'Unidentified');
        assert.deepEqual(uhid(), [], 'stray keyup and unsupported keys do not register UHID');
        await focusScreen(page);
        await page.keyboard.down('Shift');
        await page.keyboard.down('a');
        await page.keyboard.up('a');
        await page.keyboard.up('Shift');
        await waitUntil(page, () => uhid().filter(message => message[0] === 13).length === 4, 'the initial queued keys finish after registration warmup');
        assert.deepEqual(uhid().map(message => message[0]), [12, 13, 13, 13, 13], 'one physical typing session creates once and sends its reports');
        const createdAt = fixture.messageTimes.find(message => message.type === 12).at;
        const firstInputAt = fixture.messageTimes.find(message => message.type === 13).at;
        assert.ok(firstInputAt - createdAt >= 450, 'first key reports wait for the registration compatibility warmup');
        assert.equal(uhid()[1][5], 2, 'physical shift is preserved');
        assert.equal(uhid()[2][7], 4, 'the letter uses its HID code');
        assert.equal(uhid()[3][7], 0, 'the early key release is retained in order');
        assert.equal(uhid()[4][5], 0, 'the early modifier release is retained in order');
        assert.ok(uhid().every(message => message.readUInt16BE(1) === 31), 'all messages use the assigned viewer id');
        await page.locator('.touch-layer').tap({ position: { x: 20, y: 20 } });
        await settle(page);
        assert.equal(uhid().at(-1)[0], 14, 'returning to remote touch removes the physical keyboard');
        const detached = uhid().length;
        await pressKey(page, 'ShiftLeft', false);
        assert.equal(uhid().length, detached, 'late keyup cannot reattach after touch');

        for (const trigger of ['blur', 'hidden', 'pagehide', 'local-focus']) {
            await focusScreen(page);
            await pressKey(page, 'KeyB');
            const previous = uhid().length;
            await page.evaluate(trigger => {
                if (trigger === 'hidden') {
                    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
                    document.dispatchEvent(new Event('visibilitychange'));
                    delete document.visibilityState;
                } else if (trigger === 'local-focus') {
                    const input = document.createElement('input');
                    input.id = 'keyboard-local-fixture';
                    document.body.append(input);
                    input.focus();
                } else window.dispatchEvent(new Event(trigger));
            }, trigger);
            await settle(page);
            assert.deepEqual(uhid().slice(previous).map(message => message[0]), [14], `${trigger} removes the keyboard even with a held key`);
            await page.evaluate(() => document.querySelector('#keyboard-local-fixture')?.remove());
            await pressKey(page, 'KeyB', false);
            assert.equal(uhid().length, previous + 1, `${trigger} late release stays detached`);
        }
        const afterCancellations = uhid().length;
        await page.waitForTimeout(550);
        assert.equal(uhid().length, afterCancellations, 'cancelled registration timers cannot deliver buffered keys later');

        await focusScreen(page);
        await pressKey(page, 'KeyC');
        await page.locator('.floating-toolbar-fab').click();
        await page.locator('.control-buttons-list [title="Type text"]').click();
        await page.locator('.live-text-input').waitFor();
        await settle(page);
        assert.equal(uhid().at(-1)[0], 14, 'opening Live Text releases an existing UHID keyboard');
        const beforeLiveText = uhid().length;
        const beforeMessages = fixture.messages.length;
        await page.keyboard.insertText('hello');
        await page.getByRole('button', { name: 'Send Enter', exact: true }).click();
        await settle(page);
        assert.equal(uhid().length, beforeLiveText, 'Android Live Text injects text without hardware keyboard registration');
        const localMessages = fixture.messages.slice(beforeMessages);
        assert.ok(localMessages.some(message => message[0] === 1 && message.subarray(5).toString() === 'hello'), 'the committed text uses injectText');
        assert.equal(localMessages.filter(message => message[0] === 0).length, 2, 'Enter uses the normal Android down/up key events');
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        await page.locator('.live-text-overlay').waitFor({ state: 'detached' });
        assert.equal(uhid().length, beforeLiveText, 'Done leaves the Android software keyboard available');
        assert.deepEqual(fixture.errors, []);
        console.log('PASS: lazy UHID, touch/blur/background/local-control detach, and Live Text without UHID');
    } finally { await fixture.context.close(); }
}

async function reconnect(browser) {
    const fixture = await start(browser, { clientId: 81 });
    const { page, uhid } = fixture;
    try {
        await focusScreen(page);
        await pressKey(page, 'ShiftLeft');
        assert.equal(uhid()[0].readUInt16BE(1), 81);
        fixture.hold(true);
        fixture.connections[0].socket.close({ code: 1011, reason: 'Fixture restart' });
        await page.getByText('Connecting…', { exact: true }).waitFor();
        await pressKey(page, 'KeyA');
        await waitUntil(page, () => fixture.connections.length === 2, 'the stream reconnects');
        const next = fixture.connections[1];
        assert.equal(next.messages.filter(message => message[0] >= 12 && message[0] <= 14).length, 0, 'offline keys do not register before handshake');
        next.socket.send(initial(next.id));
        await page.getByText('Connected', { exact: true }).waitFor();
        await pressKey(page, 'KeyA', false);
        await pressKey(page, 'ShiftLeft', false);
        assert.equal(next.messages.filter(message => message[0] >= 12 && message[0] <= 14).length, 0, 'reconnect and stale keyups remain detached');
        await focusScreen(page);
        await page.keyboard.press('b');
        await waitUntil(page, () => next.messages.filter(message => message[0] === 13).length === 2, 'fresh input drains after its new registration warmup');
        const fresh = next.messages.filter(message => message[0] >= 12 && message[0] <= 14);
        assert.deepEqual(fresh.map(message => message[0]), [12, 13, 13]);
        assert.ok(fresh.every(message => message.readUInt16BE(1) === 82), 'reconnection uses the new viewer id');
        assert.equal(fresh[1][5], 0, 'old held modifiers do not survive a reconnect');
        assert.equal(fresh[1][7], 5, 'only the fresh B key is sent');
        assert.deepEqual(fixture.errors, []);
        console.log('PASS: reconnect waits for fresh physical input and uses its new viewer namespace');
    } finally { await fixture.context.close(); }
}

(async () => {
    const browser = await ({ chromium, webkit }[browserName] || chromium).launch({ headless: true });
    try {
        const scenarios = [lazyLifecycle, reconnect];
        const selected = process.env.SCENARIO ? scenarios.filter(run => run.name === process.env.SCENARIO) : scenarios;
        assert.ok(selected.length, 'SCENARIO names a known keyboard fixture');
        for (const run of selected) await run(browser);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
