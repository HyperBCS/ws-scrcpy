/* eslint-disable */
// node scripts/test-browser.js navigation
// Routes and history against socket fixtures. The in-app back control goes back to the list and
// the browser's Back after it never shows a phone's stream again; every open of a screen makes
// exactly one stream socket, also from an older link and from a link that names only the phone;
// older links and delivered push links open the right page; a sheet closes with its page.
// No device, adb or pymobiledevice3 is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const { settleMotion } = require('./ui-motion');

// Only through test-browser.js, which serves the build on a port of its own. Without it this
// would open streams on the live server.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js navigation');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-navigation';
const NOW = Date.now();

const PIXEL = 'NAV-PIXEL-0001';
const PIXEL_2 = 'NAV-PIXEL-0002';
const IPHONE = 'NAV-IPHONE-0001';
const IPHONE_2 = 'NAV-IPHONE-0002';
const android = (udid, model) => ({
    udid, state: 'device', pid: 123, interfaces: [], 'ro.product.model': model, 'ro.product.manufacturer': 'Google',
    'ro.build.version.release': '16', 'ro.build.version.sdk': '36', 'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'on', 'device.awake': true, 'battery.level': 80, 'battery.charging': false,
});
const iphone = (udid, name) => ({
    udid, name, model: 'iPhone 13 Pro Max', version: '27.2', state: 'Connected', paired: true, developerMode: true,
    session: 'stopped', 'screen.power': 'on', 'device.locked': false, 'last.update.timestamp': NOW,
});
const ANDROIDS = [android(PIXEL, 'Pixel 9'), android(PIXEL_2, 'Pixel 8')];
const IPHONES = [iphone(IPHONE, 'Bench iPhone'), iphone(IPHONE_2, 'Spare iPhone')];
const SUMMARY = { unread: 2, unreadBySource: { [IPHONE]: 2 }, sources: [{ id: IPHONE, name: 'Bench iPhone' }] };
const VIEWPORTS = [
    { name: 'phone', width: 390, height: 844, mobile: true },
    { name: 'desktop', width: 1280, height: 800, mobile: false },
];

function frame(type, id, data) {
    const body = Buffer.from(data);
    const packet = Buffer.alloc(5 + body.length);
    packet[0] = type; packet.writeUInt32LE(id, 1); body.copy(packet, 5);
    return packet;
}

/**
 * A page on the fixture server. `streams` lists every stream socket the page opened, in order:
 * one entry is one session start on a phone. `listDelay` holds the phone lists back, as a slow
 * connection does; `lists: false` never sends them.
 */
async function start(browser, { viewport = VIEWPORTS[0], colorScheme = 'light', hash = '', listDelay = 0, lists = true, context } = {}) {
    context ||= await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile, colorScheme, serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const state = { context, page, errors: [], streams: [], channels: [], trackers: {} };
    page.on('pageerror', (error) => state.errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith('/summary')) return route.fulfill({ json: SUMMARY });
        return route.fulfill({ json: {
            ...SUMMARY, sources: SUMMARY.sources.map((source) => ({ ...source, address: '', apps: [], preview: true })),
            notifications: [], bluetooth: [], statuses: {}, pairing: null, pairingOpen: false, error: '',
            delivery: { sent: 0, failed: 0, lastError: '' }, publicKey: '', publicUrl: 'https://example.test',
        } });
    });
    await page.routeWebSocket('**', (socket) => {
        const url = new URL(socket.url());
        const action = url.searchParams.get('action');
        if (action === 'proxy-adb' || action === 'proxy-coredevice') {
            state.streams.push({ action, udid: url.searchParams.get('udid'), host: url.host });
            if (action === 'proxy-adb') setTimeout(() => socket.send(initialStreamPacket()), 40);
            return; // The iPhone stream stays on "Connecting".
        }
        socket.onMessage((data) => {
            const packet = Buffer.from(data);
            if (packet.length < 5) return;
            const id = packet.readUInt32LE(1), body = packet.subarray(5).toString();
            const send = (message) => socket.send(frame(32, id, JSON.stringify(message)));
            if (packet[0] !== 4) return;
            state.channels.push(body);
            if (body === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } });
            const list = (type, name, devices) => {
                state.trackers[type] = (found) => send({ id: -1, type: 'devicelist', data: { id: type, name: 'Fixture host', list: found } });
                if (lists) setTimeout(() => state.trackers[type](devices), listDelay);
            };
            if (body === 'GTRC') list('android', 'GTRC', ANDROIDS);
            if (body === 'ATRC') list('ios', 'ATRC', IPHONES);
        });
    });
    await page.goto(BASE + (hash ? `#!${hash}` : ''));
    return state;
}

const card = (page, key) => page.locator(`article.device[data-device-key="${key}"]`);
const hash = (page) => page.evaluate(() => location.hash);
const streamsOf = (test, udid) => test.streams.filter((stream) => stream.udid === udid).length;
const quiet = (page, ms = 350) => page.waitForTimeout(ms);
const backControl = (page) => page.getByRole('button', { name: 'Back to devices', exact: true }).first();

/**
 * Presses the browser's Back until the app is left. No step may show a stream page or open a
 * stream socket: that is a session start on a phone nobody asked for.
 */
async function backOutOfApp(test, label) {
    const { page } = test;
    const before = test.streams.length;
    const seen = [];
    for (let step = 0; step < 12; step++) {
        await page.goBack().catch(() => undefined);
        if (!page.url().startsWith(BASE)) break;
        await quiet(page, 200);
        seen.push(await hash(page));
        assert.equal(await page.locator('.stream-view').count(), 0, `${label}: Back step ${step + 1} shows no stream page (${seen.at(-1)})`);
    }
    assert.ok(!page.url().startsWith(BASE), `${label}: Back leaves the app in the end (${seen.join(' , ')})`);
    assert.equal(test.streams.length, before, `${label}: Back opened no stream socket`);
    return seen;
}

/** From the list to each page and back by its header control. The browser's Back then leaves the app. */
async function backFromEveryPage(browser, viewport) {
    const pages = [
        {
            name: 'Android screen', udid: PIXEL, route: `action=device&udid=${PIXEL}&view=screen`,
            open: (page) => card(page, `android:${PIXEL}`).getByRole('link', { name: 'Open screen', exact: true }).click(),
            shown: (page) => page.getByText('Connected', { exact: true }).first().waitFor(),
        },
        {
            name: 'iPhone screen', udid: IPHONE, route: `action=device&udid=${IPHONE}&view=screen`,
            open: (page) => card(page, `ios:${IPHONE}`).getByRole('link', { name: 'Open screen', exact: true }).click(),
            shown: (page) => page.locator('.stream-view').waitFor(),
        },
        {
            name: 'Files', route: `action=list-files&udid=${PIXEL}`,
            open: (page) => card(page, `android:${PIXEL}`).getByRole('link', { name: 'Files', exact: true }).click(),
            shown: (page) => page.locator('.tool-view-list-files').waitFor(),
        },
        {
            name: 'Shell', route: `action=device&udid=${PIXEL}&view=shell`,
            open: (page) => card(page, `android:${PIXEL}`).getByRole('link', { name: 'Shell', exact: true }).click(),
            shown: (page) => page.locator('.tool-view-shell').waitFor(),
        },
    ];
    for (const target of pages) {
        const test = await start(browser, { viewport });
        const { page } = test;
        const label = `${viewport.name} ${target.name}`;
        try {
            await card(page, `android:${PIXEL}`).waitFor();
            const entries = await page.evaluate(() => history.length);
            await target.open(page);
            await target.shown(page);
            assert.ok((await hash(page)).startsWith(`#!${target.route}`), `${label}: the address is ${target.route} (${await hash(page)})`);
            assert.equal(await page.evaluate(() => history.length), entries + 1, `${label}: opening from the list adds one entry`);
            await quiet(page);
            if (target.udid) assert.equal(streamsOf(test, target.udid), 1, `${label}: one stream socket for one open`);
            await backControl(page).click();
            await page.locator('#devices').waitFor();
            assert.equal(await page.locator('.stream-view, .tool-view').count(), 0);
            assert.equal(await page.evaluate(() => history.length), entries + 1, `${label}: the back control adds no entry`);
            assert.equal(await page.evaluate(() => history.state.nav.index), 0, `${label}: the list is the entry the tab started on`);
            assert.deepEqual(await backOutOfApp(test, label), [], `${label}: the first Back from the list leaves the app`);
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    console.log(`PASS ${viewport.name} the back control of the screen, Files and Shell goes back to the list; Back from the list never shows a stream`);
}

/** Several phones and views in a row. The views still push an entry for each; the back control still ends on the list. */
async function backAfterSwitching(browser, viewport) {
    const test = await start(browser, { viewport });
    const { page } = test;
    const label = `${viewport.name} switching`;
    try {
        await card(page, `android:${PIXEL}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.getByText('Connected', { exact: true }).first().waitFor();
        const pick = async (name) => {
            await page.getByRole('button', { name: 'Switch', exact: true }).click();
            const sheet = page.locator('.bottom-sheet-root.open');
            await sheet.waitFor();
            await settleMotion(page);
            await sheet.getByRole('button', { name }).click();
            await sheet.waitFor({ state: 'hidden' });
        };
        await pick(/Bench iPhone/);
        await page.waitForFunction((udid) => location.hash === `#!action=device&udid=${udid}&view=screen`, IPHONE);
        await page.waitForFunction(() => document.title === 'Bench iPhone · Screen · ws-scrcpy');
        await pick(/Pixel 8/);
        await page.getByText('Connected', { exact: true }).first().waitFor();
        await page.waitForFunction(() => document.title === 'Google Pixel 8 · Screen · ws-scrcpy');
        await quiet(page);
        assert.deepEqual(test.streams.map((stream) => stream.udid), [PIXEL, IPHONE, PIXEL_2], `${label}: one stream socket per phone opened`);
        await backControl(page).click();
        await page.locator('#devices').waitFor();
        assert.equal(await page.evaluate(() => history.state.nav.index), 0, `${label}: the back control goes to the list entry, past the phones between`);
        await quiet(page);
        assert.equal(test.streams.length, 3, `${label}: going back to the list showed no phone on the way`);
        assert.deepEqual(await backOutOfApp(test, label), []);

        // Files, Shell, Files, then a screen from a notification's phone: the same holds.
        const tools = await start(browser, { viewport });
        try {
            const tool = tools.page;
            await card(tool, `android:${PIXEL}`).getByRole('link', { name: 'Files', exact: true }).click();
            await tool.locator('.tool-view-list-files').waitFor();
            await tool.locator('.tool-tabs').getByRole('button', { name: 'Shell', exact: true }).click();
            await tool.locator('.tool-view-shell').waitFor();
            assert.equal(await hash(tool), `#!action=device&udid=${PIXEL}&view=shell`);
            await tool.locator('.tool-tabs').getByRole('button', { name: 'Files', exact: true }).click();
            await tool.locator('.tool-view-list-files').waitFor();
            await tool.locator('.stream-header .notifications-link').click();
            await tool.locator('.notifications-page').waitFor();
            // "Open screen" in the inbox is a link in the older form.
            await tool.evaluate((udid) => { location.hash = `#!action=stream-coredevice&udid=${udid}`; }, IPHONE);
            await tool.locator('.stream-view').waitFor();
            await tool.waitForFunction((udid) => location.hash === `#!action=device&udid=${udid}&view=screen`, IPHONE);
            await quiet(tool);
            assert.equal(streamsOf(tools, IPHONE), 1);
            await backControl(tool).click();
            await tool.locator('#devices').waitFor();
            assert.equal(await tool.evaluate(() => history.state.nav.index), 0);
            assert.deepEqual(await backOutOfApp(tools, `${viewport.name} tools and inbox`), []);
            assert.deepEqual(tools.errors, []);
        } finally {
            await tools.context.close();
        }
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${viewport.name} after Switch, tool tabs and a screen opened from Notifications, the back control still ends on the list and Back shows no stream`);
    } finally {
        await test.context.close();
    }
}

/** Links that arrive from outside: a bookmark, a reload, a banner. One mount, one socket, the right page. */
async function linksOpenOnce(browser) {
    const socket = new URL(BASE);
    socket.protocol = 'ws:';
    socket.search = `?action=proxy-adb&remote=tcp%3A8886&udid=${PIXEL}`;
    const oldAndroid = new URLSearchParams({ action: 'stream', udid: PIXEL, player: 'webcodecs', ws: socket.toString(), captureKeyboard: '0', fitToScreen: 'true' });
    const rewritten = new URLSearchParams({ action: 'device', udid: PIXEL, view: 'screen', player: 'webcodecs', ws: socket.toString(), captureKeyboard: '0', fitToScreen: 'true' });

    // An older Android link, with the phone list arriving after the stream has started.
    let test = await start(browser, { hash: oldAndroid, listDelay: 1500 });
    try {
        const { page } = test;
        await page.getByText('Connected', { exact: true }).first().waitFor();
        assert.equal(await hash(page), `#!${rewritten}`, 'the older address is rewritten to the phone and its view');
        assert.equal(await page.evaluate(() => history.length), 2, 'in place: the tab has the blank page and this one');
        assert.equal(await page.locator('.stream-header-device > strong').textContent(), PIXEL, 'the list has not arrived yet');
        await page.waitForFunction(() => document.querySelector('.stream-header-device > strong')?.textContent === 'Google Pixel 9');
        await quiet(page, 500);
        assert.deepEqual(test.streams.map((stream) => stream.udid), [PIXEL], 'one socket: the list arriving does not start the stream again');
        // Tab opened on a phone: the back control turns this entry into the list.
        await backControl(page).click();
        await page.locator('#devices').waitFor();
        assert.equal(await hash(page), '#!');
        assert.equal(await page.evaluate(() => history.length), 2);
        assert.deepEqual(await backOutOfApp(test, 'older Android link'), []);
        assert.deepEqual(test.errors, []);
    } finally { await test.context.close(); }

    // An older iPhone link. The address no longer says it is an iPhone; the browser remembers,
    // so a reload of the new address starts at once, before the list.
    test = await start(browser, { hash: new URLSearchParams({ action: 'stream-coredevice', udid: IPHONE }), listDelay: 700 });
    try {
        const { page } = test;
        await page.locator('.stream-view').waitFor();
        assert.equal(await hash(page), `#!action=device&udid=${IPHONE}&view=screen`);
        await page.waitForFunction(() => document.title === 'Bench iPhone · Screen · ws-scrcpy');
        await quiet(page, 500);
        assert.deepEqual(test.streams, [{ action: 'proxy-coredevice', udid: IPHONE, host: new URL(BASE).host }], 'one iPhone session for one open');
        assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('ws-scrcpy.phones')))[IPHONE], { platform: 'ios', name: 'Bench iPhone' });

        const reloaded = await start(browser, { hash: `action=device&udid=${IPHONE}&view=screen`, lists: false, context: test.context });
        await reloaded.page.locator('.stream-view').waitFor();
        await quiet(reloaded.page, 500);
        assert.deepEqual(reloaded.streams.map((stream) => stream.action), ['proxy-coredevice'], 'the new address opens the iPhone screen with no list at all');
        assert.deepEqual(reloaded.errors, []);
        assert.deepEqual(test.errors, []);
    } finally { await test.context.close(); }

    // A link that names only the phone, in a browser that has never seen it: nothing starts
    // until the list says what kind of phone it is, and then one stream does, on this server.
    for (const [udid, action, title] of [[PIXEL, 'proxy-adb', 'Google Pixel 9 · Screen · ws-scrcpy'], [IPHONE_2, 'proxy-coredevice', 'Spare iPhone · Screen · ws-scrcpy']]) {
        test = await start(browser, { hash: `action=device&udid=${udid}&view=screen`, listDelay: 600 });
        try {
            const { page } = test;
            await page.locator('main.tool-unavailable[aria-busy="true"]').waitFor();
            assert.deepEqual(test.streams, [], 'no stream before the phone is identified');
            await page.locator('.stream-view').waitFor();
            await page.waitForFunction((expected) => document.title === expected, title);
            await quiet(page, 500);
            assert.deepEqual(test.streams, [{ action, udid, host: new URL(BASE).host }], `${udid}: one socket, to this server`);
            assert.equal(await hash(page), `#!action=device&udid=${udid}&view=screen`, 'the link stays as short as it was');
            assert.equal(await page.locator('main.tool-unavailable').count(), 0);
            if (action === 'proxy-adb') {
                await page.getByText('Connected', { exact: true }).first().waitFor();
                // The header finds the phone by its socket: the one found here is the tracker's own.
                assert.equal(await page.locator('.stream-header-device > strong').textContent(), 'Google Pixel 9');
            }
            assert.deepEqual(test.errors, []);
        } finally { await test.context.close(); }
    }

    // Older tool links, the new form of them, and the links in delivered push banners.
    for (const [link, address, title, selector, channel] of [
        [`action=shell&udid=${PIXEL}`, `#!action=device&udid=${PIXEL}&view=shell`, 'Google Pixel 9 · Shell · ws-scrcpy', '.tool-view-shell', 'SHEL'],
        [`action=device&udid=${PIXEL}&view=shell`, `#!action=device&udid=${PIXEL}&view=shell`, 'Google Pixel 9 · Shell · ws-scrcpy', '.tool-view-shell', 'SHEL'],
        [`action=list-files&udid=${PIXEL}&path=sdcard`, `#!action=list-files&udid=${PIXEL}&path=`, 'Google Pixel 9 · Files · ws-scrcpy', '.tool-view-list-files', 'FSLS'],
        [`action=device&udid=${PIXEL}&view=files&path=sdcard`, `#!action=list-files&udid=${PIXEL}&path=`, 'Google Pixel 9 · Files · ws-scrcpy', '.tool-view-list-files', 'FSLS'],
        [`action=notifications&source=${IPHONE}&notification=history-key`, `#!action=notifications&source=${IPHONE}&notification=history-key`, 'Notifications · ws-scrcpy', '.notifications-page'],
        ['action=', '#!action=', 'Devices · ws-scrcpy', '#devices'],
    ]) {
        test = await start(browser, { hash: link });
        try {
            const { page } = test;
            await page.locator(selector).waitFor();
            await page.waitForFunction((expected) => document.title === expected, title);
            if (channel) await page.waitForFunction(() => document.querySelector('.tool-mount')?.childElementCount > 0);
            await quiet(page);
            assert.ok((await hash(page)).startsWith(address), `${link} opens as ${address} (${await hash(page)})`);
            assert.deepEqual(test.streams, [], `${link} opens no stream`);
            if (channel) assert.equal(test.channels.filter((code) => code.startsWith(channel)).length, 1, `${link}: the tool is mounted once`);
            assert.deepEqual(test.errors, []);
        } finally { await test.context.close(); }
    }
    console.log('PASS older links, short links and push links open the right page, with one stream socket per screen');
}

/** A sheet opened from the list is mounted above the pages. It closes when the page under it changes. */
async function sheetsCloseWithTheRoute(browser) {
    const test = await start(browser);
    const { page } = test;
    try {
        await card(page, `android:${PIXEL}`).waitFor();
        await page.locator('.device-list-header .notifications-link').click();
        await page.locator('.notifications-page').waitFor();
        await page.goBack();
        await page.locator('#devices').waitFor();
        await card(page, `android:${PIXEL}`).getByRole('button', { name: 'Settings for Google Pixel 9', exact: true }).click();
        const sheet = page.locator('.bottom-sheet-root.open');
        await sheet.waitFor();
        await settleMotion(page);
        await page.goForward();
        await page.locator('.notifications-page').waitFor();
        await sheet.waitFor({ state: 'hidden' });
        await settleMotion(page);
        assert.equal(await page.locator('.bottom-sheet-root.open').count(), 0, 'the settings sheet does not stay open over Notifications');
        assert.deepEqual(test.errors, []);
        console.log('PASS a sheet opened from the list closes when the browser moves to another page');
    } finally { await test.context.close(); }
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch();
    try {
        for (const viewport of VIEWPORTS) {
            await backFromEveryPage(browser, viewport);
            await backAfterSwitching(browser, viewport);
        }
        await linksOpenOnce(browser);
        await sheetsCloseWithTheRoute(browser);
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
