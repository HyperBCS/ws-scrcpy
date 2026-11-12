/* eslint-disable */
// node scripts/test-browser.js phone-status
// The status words of a phone's page against socket fixtures, for an Android phone and an
// iPhone: after a drop the header and the card on the stage both say Reconnecting, in the
// warning tone and its amber; a phone that leaves the list keeps its name in the header and the
// tab title; a phone the list reports as disconnected is Offline, in the neutral tone and grey.
// At 390x844 and 1280x800, light and dark. No device, adb or pymobiledevice3 is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');

if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js phone-status');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-phone-status';
const NOW = Date.now();

const PIXEL = 'STATUS-PIXEL-0001';
const IPHONE = 'STATUS-IPHONE-0001';
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

function frame(type, id, data) {
    const body = Buffer.from(data);
    const packet = Buffer.alloc(5 + body.length);
    packet[0] = type; packet.writeUInt32LE(id, 1); body.copy(packet, 5);
    return packet;
}

/**
 * A page whose sockets are fixtures. While `hold` is set a new Android stream socket gets no
 * first packet (it is answered on `release`) and a new iPhone one is closed at once.
 */
async function start(browser, { width, height, mobile, colorScheme }) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, colorScheme, serviceWorkers: 'block' });
    const page = await context.newPage();
    const state = { context, page, errors: [], streams: [], trackers: {}, hold: false, held: [] };
    state.release = () => {
        state.hold = false;
        state.held.splice(0).forEach((socket) => socket.send(initialStreamPacket()));
    };
    page.on('pageerror', (error) => state.errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => route.fulfill({ json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        const action = new URL(socket.url()).searchParams.get('action');
        if (action === 'proxy-adb' || action === 'proxy-coredevice') {
            state.streams.push(socket);
            if (state.hold && action === 'proxy-adb') return void state.held.push(socket);
            if (state.hold) return void socket.close({ code: 4000, reason: 'Fixture away' });
            if (action === 'proxy-adb') setTimeout(() => socket.send(initialStreamPacket()), 40);
            else socket.send(JSON.stringify({ type: 'status', state: 'ready' }));
            return;
        }
        socket.onMessage((data) => {
            const packet = Buffer.from(data);
            if (packet.length < 5 || packet[0] !== 4) return;
            const id = packet.readUInt32LE(1), body = packet.subarray(5).toString();
            const send = (message) => socket.send(frame(32, id, JSON.stringify(message)));
            if (body === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } });
            const list = (type, found) => {
                state.trackers[type] = (next) => send({ id: -1, type: 'devicelist', data: { id: type, name: 'Fixture host', list: next } });
                state.trackers[type](found);
            };
            if (body === 'GTRC') list('android', [android()]);
            if (body === 'ATRC') list('ios', [iphone()]);
        });
    });
    return state;
}

const statusLine = (page) => page.locator('header.kit-bar .kit-bar-status').first();
const headerSays = (page, text) =>
    page.waitForFunction((wanted) => document.querySelector('header.kit-bar .kit-bar-status')?.textContent.trim() === wanted, text, { timeout: 15000 });

/** The colour a role token draws in this theme. */
const tokenColour = (page, token) =>
    page.evaluate((name) => {
        const probe = document.createElement('span');
        probe.style.color = `var(${name})`;
        document.body.append(probe);
        const colour = getComputedStyle(probe).color;
        probe.remove();
        return colour;
    }, token);
const TONE_TOKEN = { warning: '--warning-text', neutral: '--text-muted', success: '--text', error: '--danger-text' };

/**
 * The header and the card on the stage say `text` in the tone of `state`, and the header's line
 * is drawn in the colour of that tone.
 */
async function bothSay(page, label, text, state, tone) {
    await headerSays(page, text);
    const card = page.locator('.stream-state-card');
    await card.locator('.stream-state-title').getByText(text, { exact: true }).waitFor();
    assert.equal(await card.getAttribute('data-state'), state, `${label}: the card is ${state}`);
    assert.equal(await statusLine(page).getAttribute('data-tone'), tone, `${label}: the header has the ${tone} tone`);
    assert.equal(
        await statusLine(page).evaluate((line) => getComputedStyle(line).color),
        await tokenColour(page, TONE_TOKEN[tone]),
        `${label}: the header's line is in the ${tone} colour`,
    );
}

/**
 * The card of a phone whose session runs: its status in the one chip, and the session as the
 * In use mark on the platform line, the same on an iPhone and on an Android phone.
 */
async function listCard(browser, layout) {
    const label = `list ${layout.width}-${layout.colorScheme}`;
    const test = await start(browser, layout);
    const { page } = test;
    try {
        await page.goto(BASE);
        const card = page.locator(`article.device[data-device-key="ios:${IPHONE}"]`);
        await card.waitFor();
        const pixel = page.locator(`article.device[data-device-key="android:${PIXEL}"]`);
        for (const [platform, item] of [['iPhone', card], ['Android', pixel]]) {
            const chips = await item.locator('.kit-chip').evaluateAll((list) => list.map((chip) => [chip.textContent, chip.className]));
            assert.deepEqual(chips, [['Ready', 'kit-chip kit-chip-success phone-row-chip device-status']], `${label} ${platform}: one chip, the status`);
            assert.equal(await item.locator('.phone-row-meta .phone-row-in-use').textContent(), 'In use', `${label} ${platform}: the session mark`);
        }
        assert.equal(await pixel.locator('.stream-service-status, [data-line="stream-service"]').count(), 0, `${label}: no stream service line while it runs`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${label}: no sideways scroll`);
        fs.writeFileSync(path.join(OUT, `iphone-card-${layout.width}-${layout.colorScheme}.png`), await card.screenshot());
        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'a phone with a running session is Ready, with In use on its platform line');
    } finally {
        await test.context.close();
    }
}

async function phonePage(browser, layout, kind) {
    const label = `${kind} ${layout.width}-${layout.colorScheme}`;
    const test = await start(browser, layout);
    const { page } = test;
    const udid = kind === 'android' ? PIXEL : IPHONE;
    const name = kind === 'android' ? 'Google Pixel 9' : 'Bench iPhone';
    const listed = kind === 'android' ? android : iphone;
    try {
        await page.goto(`${BASE}#!action=device&udid=${udid}&view=screen`);
        await headerSays(page, 'Connected');
        assert.equal(await statusLine(page).getAttribute('data-tone'), 'success');
        assert.equal(await statusLine(page).evaluate((line) => getComputedStyle(line).color), await tokenColour(page, '--text'), `${label}: Connected is in the text colour`);
        assert.equal(await page.locator('h1.kit-bar-name').textContent(), name);

        // The card on the stage follows the screen fact of the list, on both platforms.
        const sleepCard = page.locator('.stream-state-card[data-state="asleep"]');
        test.trackers[kind]([listed(kind === 'android' ? { 'screen.power': 'off', 'device.awake': false } : { 'screen.power': 'off' })]);
        await sleepCard.getByText('Screen is asleep', { exact: true }).waitFor();
        test.trackers[kind]([listed()]);
        await page.locator('.stream-state').waitFor({ state: 'hidden' });

        // The lock notice. Its swipe text is only for a phone that reports no passcode lock.
        const notice = page.locator('.lock-screen-notice .kit-banner-text');
        const lockStates = kind === 'android'
            ? [
                [{ 'device.locked': true, 'keyguard.showing': true }, 'Phone locked'],
                [{ 'device.locked': 'unknown', 'keyguard.showing': true }, 'Phone locked'],
                [{ 'device.locked': false, 'keyguard.showing': true }, 'Swipe up to unlock'],
            ]
            : [[{ 'device.locked': true }, 'Phone locked']];
        for (const [extra, text] of lockStates) {
            test.trackers[kind]([listed(extra)]);
            await page.waitForFunction((wanted) => document.querySelector('.lock-screen-notice .kit-banner-text')?.textContent === wanted, text);
            assert.equal(await notice.textContent(), text, `${label}: ${JSON.stringify(extra)}`);
        }
        test.trackers[kind]([listed()]);
        await page.locator('.lock-screen-notice').waitFor({ state: 'detached' });

        // The stream drops: a page that was connected says Reconnecting, in both places.
        test.hold = true;
        test.streams.at(-1).close({ code: 4000, reason: 'Fixture drop' });
        await bothSay(page, label, 'Reconnecting…', 'reconnecting', 'warning');

        // The phone leaves the list while its page is open: the name stays.
        test.trackers[kind]([]);
        await page.waitForTimeout(300);
        assert.equal(await page.locator('h1.kit-bar-name').textContent(), name, `${label}: the header keeps the name`);
        assert.equal(await page.title(), `${name} · Screen · ws-scrcpy`, `${label}: the tab title keeps the name`);
        await bothSay(page, label, 'Reconnecting…', 'reconnecting', 'warning');

        // The list reports it as disconnected: Offline, in grey, still with its name.
        test.trackers[kind]([listed({ state: 'disconnected' })]);
        await bothSay(page, label, 'Offline', 'offline', 'neutral');
        assert.equal(await page.locator('h1.kit-bar-name').textContent(), name);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${label}: no sideways scroll`);
        fs.writeFileSync(path.join(OUT, `${kind}-offline-${layout.width}-${layout.colorScheme}.png`), await page.screenshot());

        // Connected again, and the page connects once more on its own.
        test.trackers[kind]([listed()]);
        test.release();
        await page.waitForFunction(() => document.querySelector('header.kit-bar .kit-bar-status')?.textContent.trim() === 'Connected', undefined, { timeout: 30000 });
        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'Reconnecting in the header and on the card, the name kept, Offline in grey');
    } finally {
        await test.context.close();
    }
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        for (const layout of [
            { width: 390, height: 844, mobile: true, colorScheme: 'light' },
            { width: 390, height: 844, mobile: true, colorScheme: 'dark' },
            { width: 1280, height: 800, mobile: false, colorScheme: 'light' },
            { width: 1280, height: 800, mobile: false, colorScheme: 'dark' },
        ]) {
            await listCard(browser, layout);
            await phonePage(browser, layout, 'android');
            await phonePage(browser, layout, 'ios');
        }
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
