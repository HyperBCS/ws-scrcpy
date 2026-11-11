/* eslint-disable */
// node scripts/test-browser.js navigation
// Routes and history against socket fixtures. The in-app back control goes back to the list and
// the browser's Back after it never shows a phone's stream again; every open of a screen makes
// exactly one stream socket, also from an older link and from a link that names only the phone;
// older links and delivered push links open the right page; a sheet closes with its page; the
// history entries of overlays behave in a real browser as in scripts/test-routes.js.
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
            name: 'Files', route: `action=device&udid=${PIXEL}&view=files`,
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
    let test = await start(browser, { hash: oldAndroid, listDelay: 3000 });
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

    // What the browser remembers can be wrong (a link edited by hand). The page keeps the screen
    // it opened with instead of starting a second stream when the list disagrees, and the next
    // visit is right.
    test = await start(browser);
    try {
        await card(test.page, `ios:${IPHONE_2}`).waitFor();
        await test.page.evaluate((udid) => localStorage.setItem('ws-scrcpy.phones', JSON.stringify({ [udid]: { platform: 'android' } })), IPHONE_2);
        const wrong = await start(browser, { hash: `action=device&udid=${IPHONE_2}&view=screen`, listDelay: 500, context: test.context });
        await wrong.page.locator('.stream-view').waitFor();
        await wrong.page.waitForFunction((udid) => JSON.parse(localStorage.getItem('ws-scrcpy.phones'))[udid].platform === 'ios', IPHONE_2);
        await quiet(wrong.page, 500);
        assert.deepEqual(wrong.streams.map((stream) => stream.action), ['proxy-adb'], 'one stream for the visit, also when the list says otherwise');
        const next = await start(browser, { hash: `action=device&udid=${IPHONE_2}&view=screen`, lists: false, context: test.context });
        await next.page.locator('.stream-view').waitFor();
        await quiet(next.page, 500);
        assert.deepEqual(next.streams.map((stream) => stream.action), ['proxy-coredevice'], 'the next visit opens the iPhone screen');
    } finally { await test.context.close(); }

    // Older tool links, the new form of them, and the links in delivered push banners.
    for (const [link, address, title, selector, channel] of [
        [`action=shell&udid=${PIXEL}`, `#!action=device&udid=${PIXEL}&view=shell`, 'Google Pixel 9 · Shell · ws-scrcpy', '.tool-view-shell', 'SHEL'],
        [`action=device&udid=${PIXEL}&view=shell`, `#!action=device&udid=${PIXEL}&view=shell`, 'Google Pixel 9 · Shell · ws-scrcpy', '.tool-view-shell', 'SHEL'],
        [`action=list-files&udid=${PIXEL}&path=sdcard`, `#!action=device&udid=${PIXEL}&view=files&path=`, 'Google Pixel 9 · Files · ws-scrcpy', '.tool-view-list-files', 'FSLS'],
        [`action=device&udid=${PIXEL}&view=files&path=sdcard`, `#!action=device&udid=${PIXEL}&view=files&path=`, 'Google Pixel 9 · Files · ws-scrcpy', '.tool-view-list-files', 'FSLS'],
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

/** A link for a phone that is in no list and that this browser has never opened. */
async function phoneNotListed(browser) {
    const GONE = 'NAV-GONE-0009';
    for (const viewport of VIEWPORTS) {
        for (const colorScheme of ['light', 'dark']) {
            const test = await start(browser, { viewport, colorScheme, hash: `action=device&udid=${GONE}&view=screen` });
            const label = `${viewport.name}-${colorScheme}`;
            try {
                const { page } = test;
                await page.getByRole('heading', { name: 'This phone is not connected', exact: true }).waitFor();
                await page.getByText('It is not in the list of phones. This page shows its screen when it is connected.', { exact: true }).waitFor();
                assert.deepEqual(test.streams, [], 'no stream is started for a phone of an unknown kind');
                // The header is the stream header: same classes, same size, same back control.
                const header = page.locator('header.stream-header');
                assert.equal(await header.locator('.stream-header-device > strong').textContent(), GONE);
                const bar = await header.boundingBox();
                assert.ok(bar.height >= 48 && bar.height <= 50, `${label}: the bar is as tall as the stream header (${bar.height})`);
                const back = header.locator('button.stream-header-back');
                assert.equal(await back.getAttribute('aria-label'), 'Phones');
                const target = await back.boundingBox();
                assert.ok(target.width >= 44 && target.height >= 44, `${label}: the back control is a 44px target`);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${label}: nothing overflows`);
                await page.screenshot({ path: path.join(OUT, `phone-not-listed-${label}.png`) });

                if (viewport.name === 'phone' && colorScheme === 'light') {
                    // The phone is connected while the page is open: its screen opens, once.
                    await test.trackers.android([...ANDROIDS, android(GONE, 'Pixel 7')]);
                    await page.getByText('Connected', { exact: true }).first().waitFor();
                    await quiet(page);
                    assert.deepEqual(test.streams.map((stream) => stream.udid), [GONE]);
                    await backControl(page).click();
                } else if (colorScheme === 'dark') {
                    await page.getByRole('button', { name: 'Phones', exact: true }).last().click();
                } else {
                    await back.click();
                }
                await page.locator('#devices').waitFor();
                assert.equal(await hash(page), '#!');
                assert.deepEqual(await backOutOfApp(test, `not listed ${label}`), []);
                assert.deepEqual(test.errors, []);
            } finally { await test.context.close(); }
        }
    }
    console.log('PASS a link for a phone that is not connected says so under the shared header, on a phone and a desktop, light and dark');
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
        // The sheet has a history entry, so nothing is ahead for Forward. The address arrives
        // from outside the app instead, as when a push alert is opened.
        await page.evaluate(() => { location.hash = '#!action=notifications'; });
        await page.locator('.notifications-page').waitFor();
        await sheet.waitFor({ state: 'hidden' });
        await settleMotion(page);
        assert.equal(await page.locator('.bottom-sheet-root.open').count(), 0, 'the settings sheet does not stay open over Notifications');
        assert.deepEqual(test.errors, []);
        console.log('PASS a sheet opened from the list closes when the browser moves to another page');
    } finally { await test.context.close(); }
}

/**
 * The history entries of overlays against a real session history. No view uses the hook until
 * step 3b, so the router is loaded on its own, from source, into a page of this origin; what
 * is under test is how the browser orders Back, Forward, `history.go` and their events.
 */
async function overlayEntries(browser) {
    const ts = require('typescript');
    const source = (file) =>
        ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
    const sources = {
        router: source('app/state/router.ts'), './routes': source('app/state/routes.ts'),
        '../ui/storage': source('app/ui/storage.ts'), '../../common/Action': source('common/Action.ts'),
    };
    const context = await browser.newContext({ serviceWorkers: 'block' });
    // Runs in every document of the context, so also after a reload.
    await context.addInitScript((modules) => {
        const signal = (value) => {
            const listeners = new Set();
            return {
                get value() { return value; },
                set value(next) { value = next; listeners.forEach((listener) => listener(next)); },
                subscribe(listener) { listeners.add(listener); listener(value); },
            };
        };
        const loaded = {};
        const load = (name) => {
            if (name === '@preact/signals') return { signal };
            if (!loaded[name]) {
                loaded[name] = { exports: {} };
                new Function('require', 'module', 'exports', modules[name])(load, loaded[name], loaded[name].exports);
            }
            return loaded[name].exports;
        };
        window.router = load('router');
        window.overlaysClosed = [];
        window.routes = [];
        window.router.route.subscribe((value) => window.routes.push(value.toString()));
        window.openOverlay = (name) => { window.overlay = window.router.pushOverlay(() => window.overlaysClosed.push(name)); };
    }, sources);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
        await page.goto(BASE + 'manifest.json');
        const at = () => page.evaluate(() => ({ index: history.state?.nav?.index, overlay: history.state?.nav?.overlay || 0, hash: location.hash, entries: history.length, closed: [...overlaysClosed] }));
        const until = (check, arg) => page.waitForFunction(check, arg);
        const phone = (udid) => `#!action=device&udid=${udid}&view=screen`;
        const start = (await at()).entries;

        await page.evaluate(() => router.openRoute({ action: 'device', udid: 'A', view: 'screen' }));
        await page.evaluate(() => openOverlay('sheet'));
        assert.deepEqual(await at(), { index: 2, overlay: 1, hash: phone('A'), entries: start + 2, closed: [] }, 'an open overlay has an entry under the address of its page');
        const shown = await page.evaluate(() => routes.length);

        // Back closes the overlay and stays on the page.
        await page.goBack();
        await until(() => overlaysClosed.length === 1);
        assert.deepEqual(await at(), { index: 1, overlay: 0, hash: phone('A'), entries: start + 2, closed: ['sheet'] });
        assert.equal(await page.evaluate(() => routes.length), shown, 'the route did not change: a stream under the sheet is not touched');
        // Forward lands on the entry of an overlay that is gone, and is taken back to the page.
        await page.goForward();
        await until(() => history.state?.nav?.index === 1);
        await page.waitForTimeout(150);
        assert.deepEqual(await at(), { index: 1, overlay: 0, hash: phone('A'), entries: start + 2, closed: ['sheet'] });

        // An overlay that closes by itself (close button, backdrop, Escape) steps back over its entry.
        await page.evaluate(() => openOverlay('menu'));
        assert.equal((await at()).index, 2);
        await page.evaluate(() => overlay.release());
        await until(() => history.state?.nav?.index === 1);
        // One sheet replaces another in the same task.
        await page.evaluate(() => { openOverlay('first'); overlay.release(); openOverlay('second'); });
        await until(() => history.state?.nav?.index === 2 && history.state.nav.overlay === 1);
        assert.deepEqual((await at()).closed, ['sheet'], 'an overlay that closed by itself is not told to close');

        // Switch from inside an overlay (Switch phone is a sheet): the page's entry changes, not the sheet's.
        await page.evaluate(() => router.switchRoute({ action: 'device', udid: 'B', view: 'screen' }));
        await until((hash) => location.hash === hash, phone('B'));
        assert.deepEqual(await at(), { index: 1, overlay: 0, hash: phone('B'), entries: start + 2, closed: ['sheet', 'second'] }, 'the entry at the page is the one that changed; the overlay entry is ahead of it now');
        assert.deepEqual(await page.evaluate(() => routes.slice(-2)), ['action=device&udid=A&view=screen', 'action=device&udid=B&view=screen']);

        // A page reloaded with an overlay open starts on the overlay's entry and goes back to the page's.
        await page.evaluate(() => openOverlay('settings'));
        assert.equal((await at()).overlay, 1);
        await page.reload();
        await until(() => window.router && history.state?.nav?.index === 1);
        assert.deepEqual(await at(), { index: 1, overlay: 0, hash: phone('B'), entries: start + 2, closed: [] }, 'Back is not spent on an overlay that is no longer open');

        // Up from inside an overlay: the list, and nothing of phone A or B behind it.
        await page.evaluate(() => openOverlay('actions'));
        await page.evaluate(() => router.goUp());
        await until(() => history.state?.nav?.index === 0 && overlaysClosed.length === 1);
        assert.equal((await at()).hash, '');
        assert.deepEqual(await page.evaluate(() => routes.slice(-1)), ['']);
        await page.goBack();
        assert.equal(page.url(), 'about:blank', 'Back from the list leaves the app');
        assert.deepEqual(errors, []);
        console.log('PASS overlay entries in a real session history: Back closes, Forward is undone, release steps back, a route change lands on the page entry, a reload recovers');
    } finally { await context.close(); }
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
        await phoneNotListed(browser);
        await sheetsCloseWithTheRoute(browser);
        await overlayEntries(browser);
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
