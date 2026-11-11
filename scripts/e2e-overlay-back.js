/* eslint-disable */
// node scripts/test-browser.js overlay-back
// The browser's Back closes the top sheet, panel or overlay and leaves the page under it alone.
// On an Android stream, an iPhone stream, the list and Notifications, at 390x844 and 1280x800:
// every sheet, the controls panel and Type text get a history entry when they open; Back closes
// them and the page and its stream socket stay; their own ways of closing leave no entry behind,
// so the next Back leaves the page in one step; a sheet that takes the place of another keeps one
// entry; a reload with a sheet open shows the page without it; Forward after Back does not open
// a sheet again; a sheet never shows over another page.
// Every socket is a fixture. No device, adb or pymobiledevice3 is involved.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const { settleMotion } = require('./ui-motion');

// Only through test-browser.js, which serves the build on a port of its own. Without it this
// would open streams on the live server.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js overlay-back');
    process.exit(1);
}
const BASE = process.env.BASE;
const NOW = Date.now();

const PIXEL = 'BACK-PIXEL-0001';
const PIXEL_2 = 'BACK-PIXEL-0002';
const IPHONE = 'BACK-IPHONE-0001';
const android = (udid, model, extra = {}) => ({
    udid, state: 'device', pid: 123, interfaces: [], 'ro.product.model': model, 'ro.product.manufacturer': 'Google',
    'ro.build.version.release': '16', 'ro.build.version.sdk': '36', 'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'on', 'device.awake': true, 'battery.level': 80, 'battery.charging': false, ...extra,
});
// The first Android phone shows its lock screen, so its page offers the Unlock sheet.
const ANDROIDS = [
    android(PIXEL, 'Pixel 9', { 'keyguard.showing': true, 'keyguard.occluded': false, 'device.locked': true }),
    android(PIXEL_2, 'Pixel 8'),
];
const IPHONES = [{
    udid: IPHONE, name: 'Bench iPhone', model: 'iPhone 13 Pro Max', version: '27.2', state: 'Connected', paired: true,
    developerMode: true, session: 'ready', 'screen.power': 'on', 'device.locked': false, 'last.update.timestamp': NOW,
}];
const SOURCES = [{ id: IPHONE, name: 'Bench iPhone', address: 'AA:BB:CC:DD:EE:01', apps: [], preview: true }];
const NOTIFICATIONS = [
    { key: 'chat', source: IPHONE, app: 'com.example.chat', appName: 'Messages', title: 'Coffee at four?', body: 'Meet me outside the station.', received: NOW, read: false, dismissed: false, active: true },
    // An action on the phone that asks before it runs.
    { key: 'calendar', source: IPHONE, app: 'com.example.calendar', appName: 'Calendar', title: 'Design review', body: 'Starts in ten minutes.', received: NOW - 60000, read: false, dismissed: false, active: true, canDismiss: true, negativeActionLabel: 'Decline' },
];
const VIEWPORTS = [
    { name: 'phone', width: 390, height: 844, mobile: true, colorScheme: 'light' },
    { name: 'desktop', width: 1280, height: 800, mobile: false, colorScheme: 'dark' },
];

function frame(type, id, data) {
    const body = Buffer.from(data);
    const packet = Buffer.alloc(5 + body.length);
    packet[0] = type; packet.writeUInt32LE(id, 1); body.copy(packet, 5);
    return packet;
}

/**
 * A page on the fixture server. `streams` lists every stream socket the page opened, in order:
 * one entry is one session start on a phone. `closed` counts the ones that were closed again.
 */
async function start(browser, viewport) {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile,
        colorScheme: viewport.colorScheme, serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const test = { context, page, viewport, mobile: viewport.mobile, errors: [], streams: [], closed: 0, posted: [] };
    page.on('pageerror', (error) => test.errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (route.request().method() !== 'GET') test.posted.push(pathname);
        const unread = { unread: NOTIFICATIONS.length, unreadBySource: { [IPHONE]: NOTIFICATIONS.length } };
        if (pathname.endsWith('/summary')) return route.fulfill({ json: { sources: SOURCES, ...unread } });
        if (pathname.endsWith('/history')) return route.fulfill({ json: { revision: 'fixture', notifications: NOTIFICATIONS } });
        if (pathname.includes('/icons/')) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ json: {
            ...unread, sources: SOURCES, bluetooth: [], statuses: { [IPHONE]: 'Receiving notifications' }, pairing: null, pairingOpen: false,
            error: '', delivery: { sent: 0, failed: 0, lastError: '' }, publicKey: '', publicUrl: 'https://example.test',
            historyRevision: 'fixture', storedBySource: { [IPHONE]: NOTIFICATIONS.length }, retentionDays: 30,
        } });
    });
    await page.routeWebSocket('**', (socket) => {
        const url = new URL(socket.url());
        const action = url.searchParams.get('action');
        if (action === 'proxy-adb' || action === 'proxy-coredevice') {
            test.streams.push(url.searchParams.get('udid'));
            socket.onClose(() => test.closed++);
            if (action === 'proxy-adb') setTimeout(() => socket.send(initialStreamPacket()), 40);
            else setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 40);
            return;
        }
        socket.onMessage((data) => {
            const packet = Buffer.from(data);
            if (packet.length < 5 || packet[0] !== 4) return;
            const id = packet.readUInt32LE(1), body = packet.subarray(5).toString();
            const send = (message) => socket.send(frame(32, id, JSON.stringify(message)));
            if (body === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } });
            if (body === 'GTRC') send({ id: -1, type: 'devicelist', data: { id: 'android', name: 'Fixture host', list: ANDROIDS } });
            if (body === 'ATRC') send({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Fixture host', list: IPHONES } });
        });
    });
    await page.goto(BASE);
    await card(page, `android:${PIXEL}`).waitFor();
    return test;
}

const card = (page, key) => page.locator(`article.device[data-device-key="${key}"]`);
const sheet = (page) => page.locator('.bottom-sheet-root.open');
const at = (page) => page.evaluate(() => ({ index: history.state?.nav?.index, overlay: history.state?.nav?.overlay || 0, hash: location.hash }));
/** Waits until the tab is on the history entry `index`, with `overlay` overlay entries on the page. */
const untilAt = (page, index, overlay) =>
    page.waitForFunction(([i, o]) => history.state?.nav?.index === i && (history.state.nav.overlay || 0) === o, [index, overlay]);
const connected = (page) => page.waitForFunction(() => document.querySelector('.stream-header-status')?.textContent.includes('Connected'));

async function press(test, locator) {
    if (test.mobile) await locator.tap();
    else await locator.click();
}

/** A control of the stream toolbox. On a phone the controls panel is opened for it first. */
async function control(test, title) {
    const { page } = test;
    if (test.mobile) {
        await press(test, page.locator('.floating-toolbar-fab'));
        await page.locator('.floating-toolbar.open').waitFor();
        await settleMotion(page);
    }
    await press(test, page.locator(`.control-buttons-list [title="${title}"]`));
}

// Ways a sheet built on BottomSheet closes by itself.
const sheetWays = {
    'the close button': (test) => press(test, sheet(test.page).locator('.bottom-sheet-close')),
    Escape: (test) => test.page.keyboard.press('Escape'),
    // The sheet stops at the bottom edge on a phone and is centred on a desktop: the corner is backdrop.
    'the backdrop': (test) => (test.mobile ? test.page.touchscreen.tap(8, 8) : test.page.mouse.click(8, 8)),
};
const bottomSheet = (name, title, open) => ({ name, open, shown: (page) => sheet(page).filter({ has: page.locator('.bottom-sheet-title', { hasText: title }) }), ways: sheetWays });

function streamOverlays(test, platform) {
    const { page } = test;
    const overlays = [
        bottomSheet('Actions', /^Actions$/, () => control(test, 'Actions')),
        bottomSheet('Settings', platform === 'android' ? /^Stream settings$/ : /^Scheduled unlock$/, () => control(test, 'Settings')),
        bottomSheet('Switch', /Switch/, () => press(test, page.locator('.stream-header-switch'))),
        {
            name: 'Type text', open: () => control(test, 'Type text'), shown: () => page.locator('.live-text-overlay'),
            ways: {
                Done: () => press(test, page.locator('.live-text-done')),
                Escape: () => page.keyboard.press('Escape'),
            },
        },
        platform === 'android'
            ? bottomSheet('Unlock', /^Unlock/, () => press(test, page.locator('.lock-screen-notice').getByRole('button', { name: 'Unlock', exact: true })))
            : bottomSheet('Unlock', /^Unlock/, async () => {
                // From the Actions sheet: one sheet takes the place of another.
                await control(test, 'Actions');
                await sheet(page).waitFor();
                await settleMotion(page);
                await press(test, sheet(page).getByRole('button', { name: 'Unlock', exact: true }));
            }),
    ];
    if (test.mobile) {
        overlays.unshift({
            name: 'the controls panel', open: () => press(test, page.locator('.floating-toolbar-fab')), shown: () => page.locator('.floating-toolbar-panel'),
            ways: {
                'its button': () => press(test, page.locator('.floating-toolbar-fab')),
                Escape: () => page.keyboard.press('Escape'),
                'a press on the picture': () => page.touchscreen.tap(40, 200),
            },
        });
    }
    return overlays;
}

/**
 * Every overlay of a page: it has one history entry while it is open, Back closes it and leaves
 * the page and its streams as they were, and each of its own ways of closing ends on the entry
 * of the page, with no entry added.
 */
async function backClosesEach(test, label, overlays, pageShown) {
    const { page } = test;
    const home = await at(page);
    const streams = test.streams.length;
    let entries;
    for (const overlay of overlays) {
        const shown = overlay.shown(page);
        const opened = async () => {
            await overlay.open();
            await shown.waitFor();
            await settleMotion(page);
            await untilAt(page, home.index + 1, 1);
        };
        await opened();
        entries ??= await page.evaluate(() => history.length);
        await page.goBack();
        await shown.waitFor({ state: 'hidden' });
        await settleMotion(page);
        assert.deepEqual(await at(page), home, `${label} ${overlay.name}: Back closes it and stays on the entry of the page`);
        assert.equal(await pageShown.count(), 1, `${label} ${overlay.name}: the page is still shown after Back`);
        for (const [way, close] of Object.entries(overlay.ways)) {
            await opened();
            await close(test);
            await shown.waitFor({ state: 'hidden' });
            await untilAt(page, home.index, 0);
            await settleMotion(page);
            assert.equal((await at(page)).hash, home.hash, `${label} ${overlay.name}: closed by ${way}, the address is the page's`);
        }
        assert.equal(await page.evaluate(() => history.length), entries, `${label} ${overlay.name}: opening it again adds no entry to the ones the tab has`);
        assert.deepEqual(test.streams.slice(streams), [], `${label} ${overlay.name}: no stream was started`);
        assert.equal(test.closed, 0, `${label} ${overlay.name}: the stream socket of the page is still open`);
    }
    return home;
}

async function streamPage(browser, viewport, platform) {
    const test = await start(browser, viewport);
    const { page } = test;
    const label = `${viewport.name} ${platform} stream`;
    const udid = platform === 'android' ? PIXEL : IPHONE;
    const route = `#!action=device&udid=${udid}&view=screen`;
    try {
        await card(page, `${platform}:${udid}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        await connected(page);
        assert.ok((await at(page)).hash.startsWith(route));
        const stream = page.locator('.stream-view');
        const overlays = streamOverlays(test, platform);
        const home = await backClosesEach(test, label, overlays, stream);
        assert.deepEqual(test.streams, [udid], `${label}: one stream socket for the whole visit`);

        // One sheet takes the place of another: the sheet that is open has the one entry.
        const title = (text) => sheet(page).locator('.bottom-sheet-title', { hasText: text });
        const swaps = [
            ['Actions to Settings', async () => {
                await control(test, 'Actions');
                await title(/^Actions$/).waitFor();
                await settleMotion(page);
                await press(test, sheet(page).getByRole('button', { name: /^Open (Stream settings|Scheduled unlock)$/ }));
            }, title(/^(Stream settings|Scheduled unlock)$/)],
            ['Actions to Unlock', async () => {
                await control(test, 'Actions');
                await title(/^Actions$/).waitFor();
                await settleMotion(page);
                await press(test, sheet(page).getByRole('button', { name: 'Unlock', exact: true }));
            }, title(/^Unlock/)],
        ];
        if (platform === 'ios') {
            swaps.push(['Actions to Type text', async () => {
                await control(test, 'Actions');
                await title(/^Actions$/).waitFor();
                await settleMotion(page);
                await press(test, sheet(page).getByRole('button', { name: 'Open', exact: true }));
            }, page.locator('.live-text-overlay')]);
        }
        for (const [name, swap, shown] of swaps) {
            await swap();
            await shown.waitFor();
            await settleMotion(page);
            await untilAt(page, home.index + 1, 1);
            assert.equal(await page.locator('.bottom-sheet-root.open, .live-text-overlay, .floating-toolbar.mobile.open').count(), 1, `${label} ${name}: one overlay is open`);
            await page.goBack();
            await shown.waitFor({ state: 'hidden' });
            await settleMotion(page);
            assert.deepEqual(await at(page), home, `${label} ${name}: Back closes the sheet that took its place, not the page`);
            assert.equal(await page.locator('.bottom-sheet-root.open, .live-text-overlay').count(), 0, `${label} ${name}: nothing is open after Back`);
            assert.equal(await stream.count(), 1);
        }
        assert.deepEqual(test.streams, [udid]);
        assert.equal(test.closed, 0);

        // Back with nothing open leaves the page in one step. Forward shows the page again
        // (the one new stream of that visit) and no sheet, also from the entry a sheet had.
        await control(test, 'Actions');
        await title(/^Actions$/).waitFor();
        await settleMotion(page);
        await page.goBack();
        await sheet(page).waitFor({ state: 'hidden' });
        await page.goBack();
        await page.locator('#devices').waitFor();
        assert.equal(await stream.count(), 0, `${label}: the second Back leaves the page`);
        assert.equal((await at(page)).index, home.index - 1);
        await page.goForward();
        await stream.waitFor();
        await connected(page);
        await page.goForward();
        await untilAt(page, home.index, 0);
        await page.waitForTimeout(300);
        assert.deepEqual(await at(page), home, `${label}: Forward onto the entry of a sheet that is gone is stepped back to the page`);
        assert.equal(await page.locator('.bottom-sheet-root.open, .live-text-overlay').count(), 0, `${label}: Forward does not open a sheet again`);
        assert.deepEqual(test.streams, [udid, udid], `${label}: Forward opened the page once`);

        // An address from outside the app (a push alert that is opened) while a sheet is open.
        // Back from there passes the entry the sheet had and shows the page, once, without it.
        await control(test, 'Actions');
        await title(/^Actions$/).waitFor();
        await settleMotion(page);
        await page.evaluate(() => { location.hash = '#!action=notifications'; });
        await page.locator('.notifications-page').waitFor();
        await sheet(page).waitFor({ state: 'hidden' });
        assert.equal(await page.locator('.bottom-sheet-root.open, .live-text-overlay').count(), 0, `${label}: the sheet does not show over Notifications`);
        assert.deepEqual(test.streams, [udid, udid], `${label}: leaving for another page started no stream`);
        await page.goBack();
        await stream.waitFor();
        await connected(page);
        await untilAt(page, home.index, 0);
        await page.waitForTimeout(300);
        assert.equal(await page.locator('.bottom-sheet-root.open, .live-text-overlay').count(), 0, `${label}: Back to the page does not open the sheet again`);
        assert.deepEqual(test.streams, [udid, udid, udid], `${label}: Back to the page opened it once`);

        // A reload with a sheet open: the page without the sheet, and Back leaves it in one step.
        await press(test, page.locator('.stream-header-switch'));
        await sheet(page).waitFor();
        await settleMotion(page);
        await untilAt(page, home.index + 1, 1);
        await page.reload();
        await stream.waitFor();
        await connected(page);
        await untilAt(page, home.index, 0);
        await page.waitForTimeout(300);
        assert.equal(await sheet(page).count(), 0, `${label}: no sheet after a reload`);
        assert.deepEqual(test.streams, [udid, udid, udid, udid], `${label}: the reloaded page started one stream`);
        await page.goBack();
        await page.locator('#devices').waitFor();
        assert.equal(await stream.count(), 0, `${label}: one Back after the reload leaves the page`);
        assert.equal((await at(page)).index, home.index - 1);
        await page.waitForTimeout(300);
        assert.equal(test.streams.length, 4, `${label}: leaving started no stream`);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label}: Back closes ${overlays.map((overlay) => overlay.name).join(', ')}; the page and its socket stay; swaps, Forward, reload and another page`);
    } finally {
        await test.context.close();
    }
}

/**
 * Type text leaves the controls button in reach when the owner has moved it above the bar. The
 * panel opened from it while typing is on top: Back closes the panel first, then Type text.
 */
async function panelOverTyping(browser, platform) {
    const test = await start(browser, VIEWPORTS[0]);
    const { page } = test;
    const label = `phone ${platform} stream`;
    const udid = platform === 'android' ? PIXEL : IPHONE;
    try {
        // Where the owner left the button, kept by this browser.
        await test.context.addInitScript(() => localStorage.setItem('floating_toolbar_position', JSON.stringify({ x: 318, y: 300 })));
        await page.reload();
        await card(page, `${platform}:${udid}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        await connected(page);
        const home = await at(page);
        const typing = page.locator('.live-text-overlay');
        const panel = page.locator('.floating-toolbar-panel');
        await control(test, 'Type text');
        await typing.waitFor();
        await settleMotion(page);
        await untilAt(page, home.index + 1, 1);
        await press(test, page.locator('.floating-toolbar-fab'));
        await page.locator('.floating-toolbar.open').waitFor();
        await settleMotion(page);
        await untilAt(page, home.index + 2, 2);
        await page.goBack();
        await panel.waitFor({ state: 'hidden' });
        await settleMotion(page);
        assert.deepEqual(await at(page), { ...home, index: home.index + 1, overlay: 1 }, `${label}: Back closes the panel opened over Type text first`);
        assert.equal(await typing.count(), 1, `${label}: Type text is still open`);
        await page.goBack();
        await typing.waitFor({ state: 'hidden' });
        await settleMotion(page);
        assert.deepEqual(await at(page), home, `${label}: the next Back closes Type text`);
        assert.equal(await page.locator('.stream-view').count(), 1);
        assert.deepEqual(test.streams, [udid]);
        assert.equal(test.closed, 0);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label}: the controls panel opened over Type text closes first on Back`);
    } finally {
        await test.context.close();
    }
}

async function listPage(browser, viewport) {
    const test = await start(browser, viewport);
    const { page } = test;
    const label = `${viewport.name} list`;
    try {
        const overlays = [
            bottomSheet('Settings of an Android phone', /^Stream settings$/, () => press(test, card(page, `android:${PIXEL_2}`).locator('button.stream-settings-button'))),
            bottomSheet('Settings of an iPhone', /^Scheduled unlock$/, () => press(test, card(page, `ios:${IPHONE}`).locator('button[title="Scheduled unlock"]'))),
        ];
        const home = await backClosesEach(test, label, overlays, page.locator('#devices'));
        assert.equal(home.index, 0);

        // A reload with a sheet open, then one Back: the app is left. Before, Back with a sheet
        // open on the list left the app and Back on a stream left the stream.
        await overlays[0].open();
        await sheet(page).waitFor();
        await settleMotion(page);
        await untilAt(page, 1, 1);
        await page.reload();
        await card(page, `android:${PIXEL}`).waitFor();
        await untilAt(page, 0, 0);
        await page.waitForTimeout(300);
        assert.equal(await sheet(page).count(), 0, `${label}: no sheet after a reload`);
        await page.goBack().catch(() => undefined);
        assert.ok(!page.url().startsWith(BASE), `${label}: one Back from the list leaves the app (${page.url()})`);
        assert.deepEqual(test.streams, []);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label}: Back closes both Settings sheets and stays on the list; one more Back leaves the app`);
    } finally {
        await test.context.close();
    }
}

async function notificationsPage(browser, viewport) {
    const test = await start(browser, viewport);
    const { page } = test;
    const label = `${viewport.name} Notifications`;
    try {
        await page.locator('.device-list-header .notifications-link').click();
        await page.locator('.notifications-page').waitFor();
        await page.locator('article.notification-history-item').first().waitFor();
        const dialog = () => page.locator('dialog.kit-sheet[open]');
        const ways = {
            'the close button': () => press(test, dialog().locator('.kit-sheet-close')),
            Escape: () => page.keyboard.press('Escape'),
            'the backdrop': () => (test.mobile ? page.touchscreen.tap(8, 8) : page.mouse.click(8, 8)),
        };
        const overlays = [
            { name: 'the actions of a notification', open: () => press(test, page.getByRole('button', { name: 'Actions for Coffee at four?', exact: true })), shown: dialog, ways },
            { name: 'Notification actions', open: () => press(test, page.getByRole('button', { name: 'Notification actions', exact: true })), shown: dialog, ways },
            { name: 'Filters', open: () => press(test, page.getByRole('button', { name: /^Filters/ })), shown: dialog, ways },
        ];
        const home = await backClosesEach(test, label, overlays, page.locator('.notifications-page'));
        assert.equal(home.index, 1);

        // A confirm prompt in the sheet: the first Back cancels it, as Escape does, the next
        // one closes the sheet. Nothing is sent to the phone.
        await press(test, page.getByRole('button', { name: 'Actions for Design review', exact: true }));
        await dialog().waitFor();
        await settleMotion(page);
        await press(test, dialog().getByRole('button', { name: 'Decline on iPhone', exact: true }));
        await dialog().locator('.kit-confirm').waitFor();
        await page.goBack();
        await dialog().locator('.kit-confirm').waitFor({ state: 'detached' });
        await untilAt(page, home.index + 1, 1);
        await page.waitForTimeout(150);
        assert.equal(await dialog().isVisible(), true, `${label}: Back with a prompt open leaves the sheet open`);
        await page.goBack();
        await dialog().waitFor({ state: 'hidden' });
        assert.deepEqual(await at(page), home);
        assert.deepEqual(test.posted, [], `${label}: Back sent nothing to the phone`);

        // Chrome on Android sends Back to an open modal dialog as a close request: a cancel
        // event, and no step through history. The prompt goes first there too.
        const closeRequest = () => page.evaluate(() => {
            const node = document.querySelector('dialog.kit-sheet[open]');
            node.dispatchEvent(new Event('cancel', { cancelable: true }));
        });
        await press(test, page.getByRole('button', { name: 'Actions for Design review', exact: true }));
        await dialog().waitFor();
        await settleMotion(page);
        await press(test, dialog().getByRole('button', { name: 'Decline on iPhone', exact: true }));
        await dialog().locator('.kit-confirm').waitFor();
        await closeRequest();
        await dialog().locator('.kit-confirm').waitFor({ state: 'detached' });
        await page.waitForTimeout(150);
        assert.equal(await dialog().isVisible(), true, `${label}: a close request with a prompt open leaves the sheet open`);
        assert.deepEqual(await at(page), { ...home, index: home.index + 1, overlay: 1 }, `${label}: and its entry`);
        await closeRequest();
        await dialog().waitFor({ state: 'hidden' });
        await untilAt(page, home.index, 0);
        assert.deepEqual(await at(page), home, `${label}: the next close request closes the sheet and steps back over its entry`);
        assert.deepEqual(test.posted, [], `${label}: close requests sent nothing to the phone`);

        // Another page while the sheet is open: it does not show there.
        await overlays[0].open();
        await dialog().waitFor();
        await settleMotion(page);
        await page.evaluate((udid) => { location.hash = `#!action=device&udid=${udid}&view=shell`; }, PIXEL);
        await page.locator('.tool-view-shell').waitFor();
        await dialog().waitFor({ state: 'hidden' });
        assert.equal(await dialog().count(), 0, `${label}: the sheet does not show over Shell`);
        await page.locator('.stream-header-back').first().click();
        await page.locator('#devices').waitFor();

        // Back from Notifications with nothing open is the list, in one step.
        await page.locator('.device-list-header .notifications-link').click();
        await page.locator('.notifications-page').waitFor();
        await overlays[1].open();
        await dialog().waitFor();
        await settleMotion(page);
        await ways.Escape();
        await dialog().waitFor({ state: 'hidden' });
        const here = await at(page);
        assert.equal(here.overlay, 0);
        await page.goBack();
        await page.locator('#devices').waitFor();
        assert.equal((await at(page)).index, here.index - 1, `${label}: one Back leaves Notifications`);
        assert.deepEqual(test.streams, []);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label}: Back closes the action sheets and stays on Notifications; the next Back is the list`);
    } finally {
        await test.context.close();
    }
}

/**
 * A step through history that the browser never reports. The entry of the page says the list is
 * five entries back when the tab has only two (an entry left from an earlier version of the app):
 * `history.go(-5)` does nothing and fires nothing. The router gives up after a second, the list
 * is shown in place, and history is in use again: a phone opens and a sheet gets its entry.
 */
async function stepNeverReported(browser) {
    const test = await start(browser, VIEWPORTS[1]);
    const { page } = test;
    try {
        await card(page, `ios:${IPHONE}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        await connected(page);
        const entries = await page.evaluate(() => history.length);
        await page.evaluate(() => history.replaceState({ ...history.state, nav: { index: 6, below: 1 } }, ''));
        const pressed = Date.now();
        await page.locator('.stream-header-back').first().click();
        await page.waitForTimeout(500);
        assert.equal(await page.locator('.stream-view').count(), 1, 'the page waits for the step it asked for');
        await page.locator('#devices').waitFor({ timeout: 5000 });
        assert.ok(Date.now() - pressed >= 900, 'the list is shown once the wait is over');
        assert.equal(await page.evaluate(() => location.hash), '#!', 'the entry of the page is the list now');
        assert.equal(await page.evaluate(() => history.length), entries, 'no entry was added');
        assert.equal(test.closed, 1, 'the stream of the page that was left is closed');

        // History is not held up after that.
        await card(page, `android:${PIXEL_2}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        await connected(page);
        const home = await at(page);
        await control(test, 'Actions');
        await sheet(page).waitFor();
        await untilAt(page, home.index + 1, 1);
        await page.goBack();
        await sheet(page).waitFor({ state: 'hidden' });
        assert.deepEqual(await at(page), home);
        assert.deepEqual(test.streams, [IPHONE, PIXEL_2]);
        assert.deepEqual(test.errors, []);
        console.log('PASS a step the browser never reports: the list is shown after the wait, and history works again');
    } finally {
        await test.context.close();
    }
}

async function main() {
    const browser = await chromium.launch();
    try {
        // Side by side, each in a context of its own: the suite has four minutes.
        await Promise.all([
            ...VIEWPORTS.flatMap((viewport) => [streamPage(browser, viewport, 'android'), streamPage(browser, viewport, 'ios')]),
            (async () => {
                for (const viewport of VIEWPORTS) {
                    await listPage(browser, viewport);
                    await notificationsPage(browser, viewport);
                }
                await stepNeverReported(browser);
                await panelOverTyping(browser, 'android');
                await panelOverTyping(browser, 'ios');
            })(),
        ]);
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
