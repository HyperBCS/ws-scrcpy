/* eslint-disable */
// node scripts/test-browser.js screen-states
// The one screen view of both kinds of phone against socket fixtures: the same header with the
// same lines, the status line in the tone of its state, one banner slot under the header that
// stacks its messages and never lies over the picture, and one card on the stage for each state
// without a picture, with at most one main action. Every open of a screen is one stream socket,
// and a banner, a card or a tab change and return adds none of its own. At 390x844 and
// 1280x800, light and dark. No device, adb or pymobiledevice3 is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const { settleMotion } = require('./ui-motion');

// Only through test-browser.js, which serves the build on a port of its own. Without it this
// would open streams on the live server.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js screen-states');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-screen-states';
const NOW = Date.now();

const PIXEL = 'STATES-PIXEL-0001';
const IPHONE = 'STATES-IPHONE-0001';
const android = (extra = {}) => ({
    udid: PIXEL, state: 'device', pid: 123, interfaces: [], 'ro.product.model': 'Pixel 9', 'ro.product.manufacturer': 'Google',
    'ro.build.version.release': '16', 'ro.build.version.sdk': '36', 'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'on', 'device.awake': true, 'device.locked': false, 'keyguard.showing': false, 'keyguard.occluded': false,
    'battery.level': 80, 'battery.charging': false, ...extra,
});
const iphone = (extra = {}) => ({
    udid: IPHONE, name: 'Bench iPhone', model: 'iPhone 13 Pro Max', version: '27.2', state: 'Connected', paired: true,
    developerMode: true, session: 'ready', 'screen.power': 'on', 'device.locked': false, 'last.update.timestamp': NOW, ...extra,
});
const BUDGET = "This phone's screen session was started 3 times in the last 5 min. The next start is allowed in 2 min.";
const LOCKOUT = 'Device is password protected. Please unlock and retry.';
const LAYOUTS = [
    { name: 'phone', width: 390, height: 844, mobile: true, colorScheme: 'light' },
    { name: 'phone', width: 390, height: 844, mobile: true, colorScheme: 'dark' },
    { name: 'desktop', width: 1280, height: 800, mobile: false, colorScheme: 'light' },
    { name: 'desktop', width: 1280, height: 800, mobile: false, colorScheme: 'dark' },
];

function frame(type, id, data) {
    const body = Buffer.from(data);
    const packet = Buffer.alloc(5 + body.length);
    packet[0] = type; packet.writeUInt32LE(id, 1); body.copy(packet, 5);
    return packet;
}

/**
 * A page whose sockets are fixtures. `streams` lists every stream socket the page opened: one
 * entry is one session start on a phone. While `hold` is set a new Android stream socket gets no
 * first packet. `iphone` says what a new iPhone stream socket hears.
 */
async function start(browser, layout, hash, { hold = false, iphone: firstIphone = 'ready' } = {}) {
    const context = await browser.newContext({
        viewport: { width: layout.width, height: layout.height }, isMobile: layout.mobile, hasTouch: layout.mobile,
        colorScheme: layout.colorScheme, serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const test = { context, page, errors: [], streams: [], held: [], messages: [], lists: {}, hold, iphone: firstIphone };
    // The Android sockets held back get their first packet now, and new ones at once.
    test.release = () => {
        test.hold = false;
        test.held.splice(0).forEach((socket) => socket.send(initialStreamPacket()));
    };
    page.on('pageerror', (error) => test.errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => route.fulfill({ json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        const action = new URL(socket.url()).searchParams.get('action');
        if (action === 'proxy-adb') {
            test.streams.push(socket);
            if (test.hold) test.held.push(socket);
            else setTimeout(() => socket.send(initialStreamPacket()), 40);
            return;
        }
        if (action === 'proxy-coredevice') {
            test.streams.push(socket);
            socket.onMessage((data) => test.messages.push(String(data)));
            const mode = test.iphone;
            if (mode === 'ready') setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 30);
            if (mode === 'preparing') socket.send(JSON.stringify({ type: 'status', state: 'starting', message: 'Preparing the phone' }));
            return;
        }
        socket.onMessage((data) => {
            const packet = Buffer.from(data);
            if (packet.length < 5 || packet[0] !== 4) return;
            const id = packet.readUInt32LE(1), body = packet.subarray(5).toString();
            const send = (message) => socket.send(frame(32, id, JSON.stringify(message)));
            if (body === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } });
            const list = (type, found) => {
                test.lists[type] = (next) => send({ id: -1, type: 'devicelist', data: { id: type, name: 'Fixture host', list: next } });
                test.lists[type](found);
            };
            if (body === 'GTRC') list('android', [android()]);
            if (body === 'ATRC') list('ios', [iphone()]);
        });
    });
    await page.goto(`${BASE}#!${hash}`);
    return test;
}

const statusLine = (page) => page.locator('header.kit-bar .kit-bar-status');
const headerSays = (page, text, timeout = 15000) =>
    page.waitForFunction((wanted) => document.querySelector('header.kit-bar .kit-bar-status')?.textContent.trim() === wanted, text, { timeout });
const quiet = (page, ms = 350) => page.waitForTimeout(ms);

/** The colours of the tones, as this theme draws them. */
function toneColours(page) {
    return page.evaluate(() => {
        const probe = document.createElement('span');
        document.body.append(probe);
        const read = (token) => {
            probe.style.color = `var(${token})`;
            return getComputedStyle(probe).color;
        };
        const colours = { error: read('--danger-text'), warning: read('--warning-text'), muted: read('--text-muted'), text: read('--text') };
        probe.remove();
        return colours;
    });
}

/** The header's status line says `text`, in `colour`. */
async function lineIs(page, label, text, colour) {
    await headerSays(page, text);
    const colours = await toneColours(page);
    assert.equal(await statusLine(page).evaluate((line) => getComputedStyle(line).color), colours[colour], `${label}: "${text}" is drawn in the ${colour} colour`);
}

/** Every class in the header, in order: the same component draws the same parts. */
function headerParts(page) {
    return page.locator('header.kit-bar').evaluate((bar) =>
        [bar, ...bar.querySelectorAll('*')].map((element) => `${element.tagName.toLowerCase()}.${element.getAttribute('class') || ''}`),
    );
}

/** The boxes of the page's parts, at rest. */
async function boxes(page) {
    await settleMotion(page);
    return page.evaluate(() => {
        const rect = (element) => element && element.getBoundingClientRect().toJSON();
        return {
            header: rect(document.querySelector('header.kit-bar')),
            tabs: rect(document.querySelector('nav.kit-tabs')),
            slot: rect(document.querySelector('.stream-banners')),
            banners: [...document.querySelectorAll('.stream-banners > *')].map((banner) => ({ ...rect(banner), class: banner.className })),
            stage: rect(document.querySelector('.stream-stage')),
            mount: rect(document.querySelector('.stream-mount')),
            picture: rect(document.querySelector('.stream-mount .video > canvas:not(.touch-layer), .stream-mount .video > video')),
            cards: [...document.querySelectorAll('.stream-state-card')].map(rect),
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
        };
    });
}

const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** The banners are stacked in the slot under the header, in `order`, and none lies over the stage. */
async function bannersStack(page, label, order) {
    const box = await boxes(page);
    const above = box.tabs || box.header;
    assert.ok(Math.abs(box.slot.top - above.bottom) <= 1, `${label}: the slot is directly under the ${box.tabs ? 'tabs' : 'header'} (${box.slot.top}, ${above.bottom})`);
    assert.deepEqual(box.banners.map((banner) => order.find((name) => banner.class.split(' ').includes(name))), order, `${label}: the banners in their order`);
    let top = box.slot.top;
    for (const banner of box.banners) {
        assert.ok(Math.abs(banner.top - top) <= 1, `${label}: ${banner.class} is stacked under the one before`);
        assert.ok(banner.height > 0 && banner.left >= -0.5 && banner.right <= innerWidthOf(box) + 0.5, `${label}: ${banner.class} is in view`);
        assert.equal(overlaps(banner, box.stage), false, `${label}: ${banner.class} does not lie over the stage`);
        top = banner.bottom;
    }
    assert.ok(Math.abs(box.stage.top - box.slot.bottom) <= 1, `${label}: the stage starts under the slot (${box.stage.top}, ${box.slot.bottom})`);
    if (box.picture) {
        assert.ok(box.picture.top >= box.stage.top - 0.5 && box.picture.bottom <= box.stage.bottom + 0.5, `${label}: the picture is fitted to the stage`);
    }
    assert.equal(box.overflow, false, `${label}: no sideways scroll`);
    return box;
}
const innerWidthOf = (box) => box.header.right;

/**
 * The stage shows exactly one card, inside the stage and under the banners: `title`, a spinner
 * or not, and at most one main action, `primary`.
 */
async function oneCard(page, label, { title, primary = [], spinner = false, buttons }) {
    await page.locator('.stream-state:not([data-exiting]) .stream-state-card').filter({ has: page.locator('.stream-state-title', { hasText: title }) }).waitFor({ timeout: 15000 });
    const box = await boxes(page);
    const cards = await page.locator('.stream-state-card').evaluateAll((list) =>
        list.map((card) => ({
            title: card.querySelector('.stream-state-title')?.textContent,
            primary: [...card.querySelectorAll('.kit-button-primary')].map((button) => button.textContent),
            buttons: [...card.querySelectorAll('button')].map((button) => button.textContent),
            spinner: !!card.querySelector('.stream-state-spinner'),
        })),
    );
    assert.equal(cards.length, 1, `${label}: one card (${cards.map((card) => card.title).join(', ')})`);
    const [card] = cards;
    assert.equal(card.title, title, `${label}: the card says ${title}`);
    assert.ok(card.primary.length <= 1, `${label}: at most one main action`);
    assert.deepEqual(card.primary, primary, `${label}: the main action`);
    if (buttons) assert.deepEqual(card.buttons, buttons, `${label}: the card's buttons`);
    assert.equal(card.spinner, spinner, `${label}: ${spinner ? 'a spinner' : 'no spinner'}`);
    const [rect] = box.cards;
    assert.ok(rect.top >= box.stage.top - 0.5 && rect.bottom <= box.stage.bottom + 0.5 && rect.left >= box.stage.left - 0.5 && rect.right <= box.stage.right + 0.5, `${label}: the card is inside the stage`);
    assert.ok(rect.top >= box.slot.bottom - 0.5, `${label}: the card is under the banners`);
    // Centred on the picture's part of the stage: under a mouse the rail of controls is beside it.
    const mount = box.mount;
    assert.ok(Math.abs((rect.left + rect.right) / 2 - (mount.left + mount.right) / 2) <= 1, `${label}: the card is centred on the picture's part of the stage`);
    assert.equal(box.overflow, false, `${label}: no sideways scroll`);
    return box;
}

async function noCard(page) {
    await page.locator('.stream-state').waitFor({ state: 'detached' });
}

/** A file dropped on the picture: Android answers with the stream notice. */
function dropFile(page) {
    return page.locator('.stream-mount').evaluate((mount) => {
        const data = new DataTransfer();
        data.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }));
        mount.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
}

async function androidScreen(browser, layout) {
    const label = `android ${layout.name}-${layout.colorScheme}`;
    const test = await start(browser, layout, `action=device&udid=${PIXEL}&view=screen`, { hold: true });
    const { page } = test;
    const shot = (name) => page.screenshot({ path: path.join(OUT, `android-${name}-${layout.name}-${layout.colorScheme}.png`) });
    try {
        // The first connection: the word and a spinner, nothing to press.
        await lineIs(page, label, 'Connecting…', 'warning');
        await oneCard(page, `${label} connecting`, { title: 'Connecting…', spinner: true, buttons: [] });
        test.release();
        await lineIs(page, label, 'Connected', 'text');
        await noCard(page);
        await quiet(page);
        assert.equal(test.streams.length, 1, `${label}: one stream socket for one open`);
        assert.equal(await page.locator('header.kit-bar .stream-service-status').count(), 0, `${label}: a running stream service has no line in the header`);
        assert.equal(await page.locator('h1.kit-bar-name').textContent(), 'Google Pixel 9');
        const parts = await headerParts(page);

        // The lock notice and a stream notice, stacked under the tabs, the stage under them.
        test.lists.android([android({ 'device.locked': true, 'keyguard.showing': true })]);
        await page.locator('.lock-screen-notice').waitFor();
        await dropFile(page);
        await page.locator('.stream-notice').waitFor();
        const stacked = await bannersStack(page, `${label} lock and notice`, ['lock-screen-notice', 'stream-notice']);
        await shot('banners');
        await page.getByRole('button', { name: 'Dismiss message', exact: true }).click();
        await page.locator('.stream-notice').waitFor({ state: 'detached' });
        const one = await bannersStack(page, `${label} lock notice`, ['lock-screen-notice']);
        assert.ok(one.stage.top < stacked.stage.top - 10, `${label}: the stage takes the place of a banner that goes`);
        assert.ok(one.stage.height > stacked.stage.height + 10, `${label}: and grows by it`);

        // Asleep: the card with Wake, and the lock notice waits until the screen is on.
        test.lists.android([android({ 'device.locked': true, 'keyguard.showing': true, 'screen.power': 'off', 'device.awake': false })]);
        await oneCard(page, `${label} asleep`, { title: 'Screen is asleep', primary: ['Wake'], buttons: ['Wake'] });
        await page.locator('.lock-screen-notice').waitFor({ state: 'detached' });
        await shot('asleep');
        test.lists.android([android({ 'device.locked': true, 'keyguard.showing': true })]);
        await noCard(page);
        await page.locator('.lock-screen-notice').waitFor();
        test.lists.android([android()]);
        await page.locator('.lock-screen-notice').waitFor({ state: 'detached' });
        await quiet(page);
        assert.equal(test.streams.length, 1, `${label}: no banner and no card opened a stream socket`);

        // The stream drops: Reconnecting, with a spinner and nothing to press.
        test.hold = true;
        test.streams.at(-1).close({ code: 4000, reason: 'Fixture drop' });
        await lineIs(page, label, 'Reconnecting…', 'warning');
        await oneCard(page, `${label} reconnecting`, { title: 'Reconnecting…', spinner: true, buttons: [] });
        // The list reports it offline, then untrusted: a card without a spinner, Offline in grey.
        test.lists.android([android({ state: 'disconnected' })]);
        await lineIs(page, label, 'Offline', 'muted');
        await oneCard(page, `${label} offline`, { title: 'Offline', buttons: [] });
        await shot('offline');
        test.lists.android([{ udid: PIXEL, state: 'unauthorized', pid: -1, interfaces: [] }]);
        await oneCard(page, `${label} unauthorized`, { title: 'Unauthorized', buttons: [] });
        assert.equal(await page.locator('.stream-state-message').textContent(), 'Unlock this phone and approve the USB debugging or trust prompt to connect.');
        await lineIs(page, label, 'Offline', 'muted');
        // Unplugged: it leaves the list and keeps its name.
        test.lists.android([]);
        await oneCard(page, `${label} not listed`, { title: 'Reconnecting…', spinner: true, buttons: [] });
        assert.equal(await page.locator('h1.kit-bar-name').textContent(), 'Google Pixel 9', `${label}: an unplugged phone keeps its name`);
        test.lists.android([android()]);
        test.release();
        await headerSays(page, 'Connected', 30000);
        await noCard(page);

        // The owner stops the stream service: one card with Start again, and no spinner under it.
        test.lists.android([android({ pid: -1 })]);
        test.streams.at(-1).close({ code: 4012, reason: 'Stream service stopped' });
        await lineIs(page, label, 'Stopped', 'muted');
        await oneCard(page, `${label} service stopped`, { title: 'Stream service stopped', primary: ['Start again'], buttons: ['Start again', 'Phones'] });
        assert.equal(await page.locator('.stream-service-stopped').count(), 1);
        assert.equal(await page.locator('header.kit-bar .stream-service-status[data-stream-service="stopped"]').count(), 1, `${label}: the header says the service is stopped`);
        await shot('service-stopped');
        let before = test.streams.length;
        await page.waitForTimeout(2600);
        assert.equal(test.streams.length, before, `${label}: a stopped service is not started again by itself`);
        test.lists.android([android()]);
        await page.getByRole('button', { name: 'Start again', exact: true }).click();
        await headerSays(page, 'Connected');
        await noCard(page);
        await quiet(page);
        assert.equal(test.streams.length, before + 1, `${label}: Start again opens one stream socket`);

        // Another tab and back: the stream stops and one socket opens on return.
        before = test.streams.length;
        await page.locator('.kit-tabs-list').getByRole('button', { name: 'Files', exact: true }).click();
        await page.locator('.tool-view-list-files').waitFor();
        await page.locator('.kit-tabs-list').getByRole('button', { name: 'Screen', exact: true }).click();
        await headerSays(page, 'Connected');
        await quiet(page, 500);
        assert.equal(test.streams.length, before + 1, `${label}: a tab change and return opens one stream socket`);
        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'one banner slot, one card per state, the line in the tone of its state, one socket per open');
        return parts;
    } finally {
        await test.context.close();
    }
}

/** A link whose socket is another server: the start error, and a Switch that looks disabled. */
async function androidStartError(browser, layout) {
    const label = `android start error ${layout.name}-${layout.colorScheme}`;
    const link = new URLSearchParams({ action: 'stream', udid: PIXEL, player: 'mse', ws: `wss://attacker.example/?action=proxy-adb&udid=${PIXEL}` });
    const test = await start(browser, layout, link.toString());
    const { page } = test;
    try {
        await oneCard(page, label, { title: 'Unable to start this stream', buttons: ['Phones'] });
        await lineIs(page, label, 'Unable to connect', 'error');
        const switcher = page.locator('header.kit-bar').getByRole('button', { name: 'Switch', exact: true });
        assert.equal(await switcher.isDisabled(), true);
        const look = await switcher.evaluate((button) => ({ opacity: getComputedStyle(button).opacity, kit: getComputedStyle(document.documentElement).getPropertyValue('--disabled-opacity').trim() }));
        assert.equal(look.opacity, look.kit, `${label}: a disabled Switch has the kit's disabled look`);
        assert.equal(test.streams.length, 0);
        await page.screenshot({ path: path.join(OUT, `android-start-error-${layout.name}-${layout.colorScheme}.png`) });
        assert.deepEqual(test.errors, []);
        console.log('PASS', label);
    } finally {
        await test.context.close();
    }
}

async function iphoneScreen(browser, layout) {
    const label = `iphone ${layout.name}-${layout.colorScheme}`;
    const test = await start(browser, layout, `action=device&udid=${IPHONE}&view=screen`, { iphone: 'preparing' });
    const { page } = test;
    const say = (message) => test.streams.at(-1).send(JSON.stringify(message));
    const opened = async (count) => {
        for (let waited = 0; test.streams.length < count; waited += 25) {
            assert.ok(waited < 5000, `${label}: stream socket ${count} opens`);
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    };
    const shot = (name) => page.screenshot({ path: path.join(OUT, `iphone-${name}-${layout.name}-${layout.colorScheme}.png`) });
    try {
        // A first start: its progress in the slot, and the card with the word and a spinner.
        await page.locator('.stream-notice', { hasText: 'Preparing the phone' }).waitFor();
        await bannersStack(page, `${label} first start`, ['stream-notice']);
        await oneCard(page, `${label} starting`, { title: 'Starting the phone stream…', spinner: true, buttons: [] });
        await lineIs(page, label, 'Starting the phone stream…', 'warning');
        say({ type: 'status', state: 'ready' });
        await lineIs(page, label, 'Connected', 'text');
        await noCard(page);
        await quiet(page);
        assert.equal(test.streams.length, 1, `${label}: one stream socket for one open`);
        const parts = await headerParts(page);
        assert.equal(await page.locator('nav.kit-tabs').count(), 0);

        // A start after a drop: the progress line in the slot, the card with its spinner.
        test.iphone = 'preparing';
        test.streams.at(-1).close({ code: 4000, reason: 'Fixture drop' });
        await page.locator('.stream-notice', { hasText: 'Preparing the phone' }).waitFor();
        await bannersStack(page, `${label} progress`, ['stream-notice']);
        await oneCard(page, `${label} reconnecting`, { title: 'Reconnecting…', spinner: true, buttons: [] });
        await lineIs(page, label, 'Reconnecting…', 'warning');
        say({ type: 'status', state: 'ready' });
        await headerSays(page, 'Connected');
        await noCard(page);
        await page.locator('.stream-notice').waitFor({ state: 'detached' });
        assert.equal(test.streams.length, 2);

        // A stream notice, and the lock notice above it; asleep, only the card with Wake.
        test.lists.ios([iphone({ 'device.locked': true })]);
        await page.locator('.lock-screen-notice').waitFor();
        say({ type: 'clipboard', text: null, error: 'The pasteboard did not answer.' });
        await page.locator('.stream-notice', { hasText: 'Clipboard: The pasteboard did not answer.' }).waitFor();
        await bannersStack(page, `${label} lock and notice`, ['lock-screen-notice', 'stream-notice']);
        await shot('banners');
        await page.getByRole('button', { name: 'Dismiss message', exact: true }).click();
        test.lists.ios([iphone({ 'device.locked': true, 'screen.power': 'off' })]);
        await oneCard(page, `${label} asleep`, { title: 'Screen is asleep', primary: ['Wake'], buttons: ['Wake'] });
        await page.locator('.lock-screen-notice').waitFor({ state: 'detached' });
        await page.getByRole('button', { name: 'Wake', exact: true }).click();
        await noCard(page);
        assert.ok(test.messages.some((message) => message.includes('"type":"button"') && message.includes('"lock"')), `${label}: Wake taps the side button`);
        test.lists.ios([iphone({ 'device.locked': true })]);
        await page.locator('.lock-screen-notice').waitFor();
        test.lists.ios([iphone()]);
        await page.locator('.lock-screen-notice').waitFor({ state: 'detached' });
        await quiet(page);
        assert.equal(test.streams.length, 2, `${label}: no banner and no card opened a stream socket`);

        // 4010: nothing was started. The page tries again by itself, once.
        test.iphone = 'ready';
        test.streams.at(-1).close({ code: 4010, reason: 'Try later' });
        await opened(3);
        await headerSays(page, 'Connected');
        await quiet(page);
        assert.equal(test.streams.length, 3, `${label}: 4010 is tried again by itself, once`);

        // 4011: the start budget is used up. One card with Retry, and no try without it.
        test.iphone = 'none';
        say({ type: 'status', state: 'error', message: BUDGET });
        test.streams.at(-1).close({ code: 4011, reason: 'Stream unavailable' });
        await oneCard(page, `${label} budget`, { title: 'Stream unavailable', primary: ['Retry'], buttons: ['Retry', 'Phones'] });
        await lineIs(page, label, 'Stream unavailable', 'error');
        assert.equal(await page.locator('.stream-state-message').textContent(), BUDGET);
        await shot('failed');
        await page.waitForTimeout(2600);
        assert.equal(test.streams.length, 3, `${label}: a used-up budget is not tried again by itself`);

        // Retry, and the phone is locked out: unlock it by hand, with Retry again.
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await opened(4);
        say({ type: 'status', state: 'error', message: LOCKOUT });
        test.streams.at(-1).close({ code: 4011, reason: 'Stream unavailable' });
        await oneCard(page, `${label} by hand`, { title: 'Unlock the iPhone by hand', primary: ['Retry'], buttons: ['Retry', 'Phones'] });
        await quiet(page);
        assert.equal(test.streams.length, 4, `${label}: Retry opened one stream socket`);

        // Retry: the session starts, then stops on the phone's side.
        test.iphone = 'ready';
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await opened(5);
        await headerSays(page, 'Connected');
        await noCard(page);
        say({ type: 'status', state: 'stopped', message: 'Device is rebooting' });
        await oneCard(page, `${label} stopped`, { title: 'Stream stopped', primary: ['Retry'], buttons: ['Retry', 'Phones'] });
        await lineIs(page, label, 'Stream stopped', 'muted');
        say({ type: 'status', state: 'ready' });
        await headerSays(page, 'Connected');
        await noCard(page);

        // A codec this browser cannot decode: no Retry, which cannot add a decoder.
        say({ type: 'codec', codec: 'hev1.9.9.L999.B0', description: Buffer.from([1, 2, 3, 4]).toString('base64') });
        await oneCard(page, `${label} no decoder`, { title: 'This browser cannot show the stream', buttons: ['Phones'] });
        await lineIs(page, label, 'No picture', 'error');

        // Unplugged: it leaves the list and keeps its name.
        test.lists.ios([]);
        await quiet(page);
        assert.equal(await page.locator('h1.kit-bar-name').textContent(), 'Bench iPhone', `${label}: an unplugged phone keeps its name`);
        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'one banner slot, one card per state with Retry where it helps, 4010 and 4011 as before');
        return parts;
    } finally {
        await test.context.close();
    }
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        for (const layout of LAYOUTS) {
            const androidParts = await androidScreen(browser, layout);
            const iphoneParts = await iphoneScreen(browser, layout);
            assert.deepEqual(iphoneParts, androidParts, `${layout.name}: the header is the same component with the same lines on both kinds of phone`);
            await androidStartError(browser, layout);
        }
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
