// node scripts/test-browser.js history-walk
// History walked by hand across the pages of redesign step 3b, at 390x844 and 1280x800: the
// list, an Android phone and each of its tabs, Switch to another phone, the bell, "Open iPhone
// screen" from a notification, and sheets and menus on each page. Back from the list never shows
// a phone's stream, no open starts two stream sockets, and no sheet shows over a page it was not
// opened on. Also the router rule the pages rely on: a change within the page made by code while
// an overlay is open (a Files listing that corrects the path, a search written to the address,
// a summary that refreshes) leaves the overlay open and ends on the page's own entry.
// Every socket is a fixture. No device, adb or pymobiledevice3 is involved.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const { settleMotion } = require('./ui-motion');

// Only through test-browser.js, which serves the build on a port of its own. Without it this
// would open streams on the live server.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js history-walk');
    process.exit(1);
}
const BASE = process.env.BASE;
const NOW = Date.now();

const PIXEL = 'WALK-PIXEL-0001';
const PIXEL_2 = 'WALK-PIXEL-0002';
const IPHONE = 'WALK-IPHONE-0001';
const android = (udid, model) => ({
    udid, state: 'device', pid: 123, interfaces: [], 'ro.product.model': model, 'ro.product.manufacturer': 'Google',
    'ro.build.version.release': '16', 'ro.build.version.sdk': '36', 'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'on', 'device.awake': true, 'battery.level': 80, 'battery.charging': false,
});
const ANDROIDS = [android(PIXEL, 'Pixel 9'), android(PIXEL_2, 'Pixel 8')];
const IPHONES = [{
    udid: IPHONE, name: 'Bench iPhone', model: 'iPhone 13 Pro Max', version: '27.2', state: 'Connected', paired: true,
    developerMode: true, session: 'ready', 'screen.power': 'on', 'device.locked': false, 'last.update.timestamp': NOW,
}];
const SOURCES = [{ id: IPHONE, name: 'Bench iPhone', address: 'AA:BB:CC:DD:EE:01', apps: [], preview: true }];
const NOTIFICATIONS = [
    { key: 'chat', source: IPHONE, app: 'com.example.chat', appName: 'Messages', title: 'Coffee at four?', body: 'Meet me outside the station.', received: NOW, read: false, dismissed: false, active: true },
    { key: 'calendar', source: IPHONE, app: 'com.example.calendar', appName: 'Calendar', title: 'Design review', body: 'Starts in ten minutes.', received: NOW - 60000, read: false, dismissed: false, active: true },
];
const VIEWPORTS = [
    { name: 'phone', width: 390, height: 844, mobile: true },
    { name: 'desktop', width: 1280, height: 800, mobile: false },
];

const ROOT = '/data/local/tmp';
const DIR = 0o40755;
const FILE = 0o100644;
const FOLDERS = { [ROOT]: [['photos', DIR], ['notes.txt', FILE]], [`${ROOT}/photos`]: [['holiday.jpg', FILE]] };

function frame(type, id, data = Buffer.alloc(0)) {
    const body = Buffer.from(data);
    const packet = Buffer.alloc(5 + body.length);
    packet[0] = type; packet.writeUInt32LE(id, 1); body.copy(packet, 5);
    return packet;
}
function closeFrame(id, code) {
    const data = Buffer.alloc(6);
    data.writeUInt16LE(code);
    return frame(8, id, data);
}
function stat(mode) {
    const data = Buffer.alloc(16);
    data.write('STAT'); data.writeUInt32LE(mode, 4); data.writeUInt32LE(1700000000, 12);
    return data;
}
function dent(name, mode) {
    const text = Buffer.from(name);
    const data = Buffer.alloc(20 + text.length);
    data.write('DENT'); data.writeUInt32LE(mode, 4); data.writeUInt32LE(mode === FILE ? 12 : 0, 8);
    data.writeUInt32LE(1700000000, 12); data.writeUInt32LE(text.length, 16); text.copy(data, 20);
    return data;
}

/**
 * A page on the fixture server. `streams` lists the phone of every stream socket the page
 * opened, `streamsClosed` the phone of every one it closed: one entry is one session start or end
 * on a phone. `held` holds the answers to STAT requests while `holdStat` is set.
 */
async function start(browser, viewport, hash = '', { holdStat = false } = {}) {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile, serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const test = {
        context, page, mobile: viewport.mobile, errors: [], streams: [], streamsClosed: [], opened: [], shells: 0,
        polls: 0, unread: NOTIFICATIONS.length, holdStat, held: [],
    };
    page.on('pageerror', (error) => test.errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const unread = { unread: test.unread, unreadBySource: { [IPHONE]: test.unread } };
        if (pathname.endsWith('/summary')) return route.fulfill({ json: { sources: SOURCES, ...unread } });
        if (pathname.endsWith('/history')) return route.fulfill({ json: { revision: 'fixture', notifications: NOTIFICATIONS } });
        if (pathname.includes('/icons/')) return route.fulfill({ status: 404, body: '' });
        test.polls++;
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
            const udid = url.searchParams.get('udid');
            test.streams.push(udid);
            socket.onClose(() => test.streamsClosed.push(udid));
            if (action === 'proxy-adb') setTimeout(() => socket.send(initialStreamPacket()), 40);
            else setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 40);
            return;
        }
        const channels = new Map();
        socket.onMessage((data) => {
            const packet = Buffer.from(data);
            if (packet.length < 5) return;
            const type = packet[0], id = packet.readUInt32LE(1), payload = packet.subarray(5), body = payload.toString();
            const send = (message) => socket.send(frame(32, id, JSON.stringify(message)));
            if (type === 4) {
                const code = body.slice(0, 4);
                channels.set(id, code);
                test.opened.push(code);
                if (code === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } });
                if (code === 'GTRC') send({ id: -1, type: 'devicelist', data: { id: 'android', name: 'Fixture host', list: ANDROIDS } });
                if (code === 'ATRC') send({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Fixture host', list: IPHONES } });
            } else if (type === 32 && channels.get(id) === 'SHEL' && body.startsWith('{')) {
                if (JSON.parse(body).data?.type === 'start') {
                    test.shells++;
                    socket.send(frame(32, id, `Fixture terminal ${test.shells} ready\r\n$ `));
                }
            } else if (type === 64 && channels.get(id) === 'FSLS') {
                const inner = payload[0], channel = payload.readUInt32LE(1), request = payload.subarray(5);
                if (inner !== 4) return;
                const reply = (answer) => socket.send(frame(64, id, frame(16, channel, answer)));
                const end = (code) => socket.send(frame(64, id, closeFrame(channel, code)));
                const command = request.subarray(0, 4).toString();
                const target = request.subarray(8, 8 + request.readUInt32LE(4)).toString();
                if (command === 'STAT') {
                    const answer = () => {
                        reply(stat(FOLDERS[target] || ['/', '/data', '/data/local'].includes(target) ? DIR : 0));
                        end(1000);
                    };
                    if (test.holdStat) test.held.push(answer);
                    else answer();
                } else if (command === 'LIST') {
                    (FOLDERS[target] || []).forEach(([name, mode]) => reply(dent(name, mode)));
                    end(0);
                } else {
                    reply(Buffer.from('DONE'));
                    end(1000);
                }
            }
        });
    });
    await page.goto(BASE + hash);
    return test;
}

const card = (page, key) => page.locator(`article.device[data-device-key="${key}"]`);
const tab = (page, name) => page.locator('.kit-tabs-list').getByRole('button', { name, exact: true });
const crumb = (page, name) => page.locator('.file-explorer[data-listing="ready"] .fx-crumb[aria-current="page"]').filter({ hasText: name });
const article = (page, title) => page.locator('article.notification-history-item').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const at = (page) => page.evaluate(() => ({ index: history.state?.nav?.index, overlay: history.state?.nav?.overlay || 0, hash: location.hash }));
const quiet = (page, ms = 400) => page.waitForTimeout(ms);
const connected = (page) => page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.includes('Connected'));
const hashIs = (page, expected) => page.waitForFunction((value) => location.hash === value, expected);
/** Waits until the tab is on the history entry `index`, with `overlay` overlay entries on the page. */
const untilAt = (page, index, overlay) =>
    page.waitForFunction(([i, o]) => history.state?.nav?.index === i && (history.state.nav.overlay || 0) === o, [index, overlay]);
/** Every overlay a page can show: the sheets, Type text, the controls panel, a Files menu or dialog, a notification sheet. */
const OVERLAYS = '.live-text-overlay, .floating-toolbar.mobile.open, .files-menu:not([hidden]), dialog[open]';
const screenOf = (udid) => `#!action=device&udid=${udid}&view=screen`;
const filesOf = (udid, folder) => `#!action=device&udid=${udid}&view=files${folder ? `&path=${encodeURIComponent(folder)}` : ''}`;

async function until(condition, label, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (!(await condition())) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function press(test, locator) {
    if (test.mobile) await locator.tap();
    else await locator.click();
}

/** A Files menu: Actions on a touch screen, View on a desktop. */
async function openFilesMenu(test) {
    await press(test, test.page.getByRole('button', { name: test.mobile ? 'Actions' : 'View', exact: true }));
    await test.page.locator('.files-menu:not([hidden])').waitFor();
    await settleMotion(test.page);
}

/** No overlay is open, and the page is the one named. */
async function nothingOver(page, label) {
    await settleMotion(page);
    assert.equal(await page.locator(OVERLAYS).count(), 0, `${label}: no sheet, menu or dialog shows over the page`);
}

/**
 * The list, an Android phone through its tabs, Switch, the bell, a notification's iPhone screen,
 * and the whole way back. One press of each, one stream socket per open.
 */
async function walk(browser, viewport) {
    const test = await start(browser, viewport);
    const { page } = test;
    const label = viewport.name;
    try {
        await card(page, `android:${PIXEL}`).waitFor();
        const list = await at(page);
        assert.equal(list.hash, '');

        // A phone's screen from the list: one new entry, one stream.
        await card(page, `android:${PIXEL}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await connected(page);
        assert.deepEqual(await at(page), { index: list.index + 1, overlay: 0, hash: screenOf(PIXEL) });
        await quiet(page);
        assert.deepEqual(test.streams, [PIXEL], `${label}: one stream for the open`);
        // A sheet on the screen: Back closes it, and the stream stays.
        await press(test, page.locator('.kit-bar').getByRole('button', { name: 'Switch', exact: true }));
        await page.locator('dialog.kit-sheet[open]').waitFor();
        await untilAt(page, list.index + 2, 1);
        await page.goBack();
        await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'hidden' });
        await untilAt(page, list.index + 1, 0);
        await nothingOver(page, `${label} screen`);
        assert.deepEqual(test.streamsClosed, [], `${label}: Back with the switcher open keeps the stream`);

        // Files: the stream stops. A menu has an entry; Back closes it and keeps the folder.
        await tab(page, 'Files').click();
        await crumb(page, 'tmp').waitFor();
        await until(() => test.streamsClosed.length === 1, 'the stream closes when Files is shown');
        assert.deepEqual(await at(page), { index: list.index + 1, overlay: 0, hash: filesOf(PIXEL, ROOT) });
        await openFilesMenu(test);
        await untilAt(page, list.index + 2, 1);
        await page.goBack();
        await page.locator('.files-menu:not([hidden])').waitFor({ state: 'hidden' });
        await untilAt(page, list.index + 1, 0);
        assert.equal((await at(page)).hash, filesOf(PIXEL, ROOT), `${label}: Back with a Files menu open keeps the folder`);

        // One tap on a tab with a Files menu open closes the menu and shows the tab.
        await openFilesMenu(test);
        await tab(page, 'Shell').click({ force: true });
        await page.locator('.tool-view-shell:not([hidden])').waitFor();
        await hashIs(page, `#!action=device&udid=${PIXEL}&view=shell`);
        await until(async () => (await page.locator('.terminal-container .xterm-rows').innerText()).includes('Fixture terminal 1 ready'), 'the shell starts');
        await untilAt(page, list.index + 1, 0);
        await nothingOver(page, `${label} Shell`);
        assert.equal(await page.locator('.file-explorer').isVisible(), false, `${label}: Files is hidden behind Shell`);

        // Back to Files, then the bell with a Files menu open: one tap shows Notifications.
        await tab(page, 'Files').click();
        await crumb(page, 'tmp').waitFor();
        await hashIs(page, filesOf(PIXEL, ROOT));
        await openFilesMenu(test);
        await page.locator('.kit-bar .notifications-link').click({ force: true });
        await page.locator('.notifications-page').waitFor();
        await untilAt(page, list.index + 2, 0);
        await nothingOver(page, `${label} Notifications from Files`);
        assert.equal(await page.locator('.tool-view, .stream-view').count(), 0, `${label}: the phone's page is gone`);
        // Back returns to Files of that phone: a new explorer, no stream.
        await page.goBack();
        await crumb(page, 'tmp').waitFor();
        await untilAt(page, list.index + 1, 0);
        await nothingOver(page, `${label} Files again`);
        await quiet(page);
        assert.equal(test.streams.length, 1, `${label}: Back to Files starts no stream`);

        // Screen again: one new stream. Switch replaces the entry, with one stream for the phone.
        await tab(page, 'Screen').click();
        await connected(page);
        await quiet(page);
        assert.deepEqual(test.streams, [PIXEL, PIXEL], `${label}: Screen opens one stream`);
        await press(test, page.locator('.kit-bar').getByRole('button', { name: 'Switch', exact: true }));
        const sheet = page.locator('dialog.kit-sheet[open]');
        await sheet.waitFor();
        await settleMotion(page);
        await press(test, sheet.getByRole('button', { name: /Pixel 8/ }));
        await hashIs(page, screenOf(PIXEL_2));
        await connected(page);
        await untilAt(page, list.index + 1, 0);
        await nothingOver(page, `${label} after Switch`);
        await quiet(page);
        assert.deepEqual(test.streams, [PIXEL, PIXEL, PIXEL_2], `${label}: Switch opens one stream`);
        // Forward passes the switcher's entry without showing the phone before.
        await page.goForward();
        await quiet(page, 500);
        assert.deepEqual(await at(page), { index: list.index + 1, overlay: 0, hash: screenOf(PIXEL_2) }, `${label}: Forward stays on Pixel 8`);
        assert.equal(test.streams.length, 3, `${label}: Forward starts no stream`);

        // The bell: Notifications as a new entry. The stream of Pixel 8 stops.
        await page.locator('.kit-bar .notifications-link').click();
        await page.locator('.notifications-page').waitFor();
        await article(page, 'Coffee at four?').waitFor();
        await untilAt(page, list.index + 2, 0);
        const inbox = (await at(page)).hash;
        await until(() => test.streamsClosed.filter((udid) => udid === PIXEL_2).length === 1, 'the stream of Pixel 8 closes');
        await nothingOver(page, `${label} Notifications`);

        // A search written to the address while a notification's sheet is open: the sheet stays,
        // and the text ends on the entry of the page.
        await page.getByRole('searchbox', { name: 'Search notifications', exact: true }).fill('Coffee');
        const actions = page.getByRole('button', { name: 'Actions for Coffee at four?', exact: true });
        await press(test, actions);
        const cardSheet = page.getByRole('dialog');
        await cardSheet.waitFor();
        await hashIs(page, `${inbox}&q=Coffee`);
        await quiet(page, 300);
        assert.equal(await cardSheet.count(), 1, `${label}: the sheet stays open when the search is written`);
        assert.deepEqual(await at(page), { index: list.index + 3, overlay: 1, hash: `${inbox}&q=Coffee` });
        // A summary that refreshes under the sheet leaves it open.
        test.unread = 1;
        const polls = test.polls;
        await until(() => test.polls > polls, 'the next poll of Notifications', 8000);
        await quiet(page, 300);
        assert.equal(await cardSheet.count(), 1, `${label}: a refresh leaves the sheet open`);
        await page.goBack();
        await cardSheet.waitFor({ state: 'detached' });
        assert.deepEqual(await at(page), { index: list.index + 2, overlay: 0, hash: `${inbox}&q=Coffee` }, `${label}: Back closes the sheet; the search is on the page's entry`);

        // "Open iPhone screen" from the sheet: one new entry, one iPhone session.
        await press(test, actions);
        await cardSheet.waitFor();
        await settleMotion(page);
        await press(test, cardSheet.getByRole('link', { name: 'Open iPhone screen', exact: true }));
        await page.locator('.stream-view').waitFor();
        await hashIs(page, screenOf(IPHONE));
        await untilAt(page, list.index + 3, 0);
        await nothingOver(page, `${label} iPhone screen`);
        await quiet(page, 500);
        assert.deepEqual(test.streams, [PIXEL, PIXEL, PIXEL_2, IPHONE], `${label}: one iPhone session for the open`);

        // Back: Notifications with the search, then Pixel 8's screen (its one stream), then the
        // back control to the list, and Back leaves the app with no stream on the way.
        await page.goBack();
        await article(page, 'Coffee at four?').waitFor();
        assert.deepEqual(await at(page), { index: list.index + 2, overlay: 0, hash: `${inbox}&q=Coffee` });
        await until(() => test.streamsClosed.includes(IPHONE), 'the iPhone session ends');
        await nothingOver(page, `${label} Notifications after Back`);
        await quiet(page);
        assert.equal(test.streams.length, 4, `${label}: Back to Notifications starts no stream`);
        await page.goBack();
        await connected(page);
        assert.deepEqual(await at(page), { index: list.index + 1, overlay: 0, hash: screenOf(PIXEL_2) });
        await nothingOver(page, `${label} Pixel 8 after Back`);
        await quiet(page);
        assert.deepEqual(test.streams.slice(4), [PIXEL_2], `${label}: Back to a phone's screen opens its one stream`);
        await page.locator('.kit-bar-back').click();
        await page.locator('#devices').waitFor();
        assert.deepEqual(await at(page), list, `${label}: the back control ends on the list entry`);
        await nothingOver(page, `${label} list`);
        await quiet(page);
        assert.equal(test.streams.length, 5, `${label}: the list starts no stream`);
        await page.goBack().catch(() => undefined);
        assert.ok(!page.url().startsWith(BASE), `${label}: Back from the list leaves the app (${page.url()})`);
        await quiet(page);
        assert.equal(test.streams.length, 5, `${label}: leaving the app starts no stream`);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label} walk: list, a phone and its tabs, Switch, the bell, an iPhone from a notification and back; one stream per open, no sheet over another page, Back from the list leaves the app`);
    } finally {
        await test.context.close();
    }
}

/**
 * Switch open on Files while a listing arrives. A corrected path is written on the switcher's
 * entry, the switcher stays open, and the path is on the page's entry once it closes. A folder
 * step that arrives under the switcher is a new entry, so the switcher closes first.
 */
async function switcherOverListing(browser, viewport) {
    const label = `${viewport.name} switcher over a listing`;
    // The address names the folder with a trailing slash, which Files corrects once it is listed.
    const test = await start(browser, viewport, filesOf(PIXEL, `${ROOT}/`), { holdStat: true });
    const { page } = test;
    try {
        await page.locator('.tool-view-list-files').waitFor();
        await until(() => test.held.length === 1, 'Files asks for the folder');
        const opened = await at(page);
        await press(test, page.locator('.kit-bar').getByRole('button', { name: 'Switch', exact: true }));
        const sheet = page.locator('dialog.kit-sheet[open]');
        await sheet.waitFor();
        await untilAt(page, opened.index + 1, 1);
        test.holdStat = false;
        test.held.splice(0).forEach((answer) => answer());
        await crumb(page, 'tmp').waitFor();
        await hashIs(page, filesOf(PIXEL, ROOT));
        await quiet(page, 300);
        assert.equal(await sheet.count(), 1, `${label}: the switcher stays open when the path is corrected`);
        assert.equal((await at(page)).overlay, 1, `${label}: the tab is still on the switcher's entry`);
        await page.goBack();
        await sheet.waitFor({ state: 'hidden' });
        assert.deepEqual(await at(page), { index: opened.index, overlay: 0, hash: filesOf(PIXEL, ROOT) }, `${label}: the corrected path is on the page's entry`);

        // A folder step that is still being checked when the switcher opens.
        test.holdStat = true;
        const folder = page.locator('.fx-row[data-name="photos"] .entry-name a');
        if (viewport.mobile) await folder.click();
        else await folder.dblclick();
        await until(() => test.held.length === 1, 'Files asks for the folder');
        await press(test, page.locator('.kit-bar').getByRole('button', { name: 'Switch', exact: true }));
        await sheet.waitFor();
        await untilAt(page, opened.index + 1, 1);
        test.holdStat = false;
        test.held.splice(0).forEach((answer) => answer());
        await crumb(page, 'photos').waitFor();
        await sheet.waitFor({ state: 'hidden' });
        await untilAt(page, opened.index + 1, 0);
        assert.equal((await at(page)).hash, filesOf(PIXEL, `${ROOT}/photos`), `${label}: the folder step is one new entry`);
        await page.goBack();
        await crumb(page, 'tmp').waitFor();
        assert.deepEqual(await at(page), { index: opened.index, overlay: 0, hash: filesOf(PIXEL, ROOT) }, `${label}: Back is the folder before`);
        await nothingOver(page, label);
        assert.deepEqual(test.streams, [], `${label}: no stream`);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label}: a corrected path keeps the switcher open and ends on the page's entry; a folder step closes it first`);
    } finally {
        await test.context.close();
    }
}

/** An older Files link opens Files once, in the new address, as one entry. */
async function olderFilesLink(browser, viewport) {
    const test = await start(browser, viewport, `#!action=list-files&udid=${PIXEL}&path=${encodeURIComponent(`${ROOT}/photos/`)}`);
    const { page } = test;
    try {
        await crumb(page, 'photos').waitFor();
        await hashIs(page, filesOf(PIXEL, `${ROOT}/photos`));
        await quiet(page);
        assert.equal(await page.locator('.file-explorer').count(), 1, 'one explorer');
        assert.equal(test.opened.filter((code) => code === 'FSLS').length, 1, 'one Files channel');
        assert.equal(await page.evaluate(() => history.length), 2, 'the blank page and this one: the link is rewritten in place');
        const tabs = await page.locator('.kit-tabs-list .kit-tab').allInnerTexts();
        assert.deepEqual(tabs, ['Screen', 'Files', 'Shell']);
        assert.deepEqual(test.streams, []);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${viewport.name} an older Files link opens Files once under the new address`);
    } finally {
        await test.context.close();
    }
}

async function main() {
    const browser = await chromium.launch();
    try {
        for (const viewport of VIEWPORTS) {
            await walk(browser, viewport);
            await switcherOverListing(browser, viewport);
            await olderFilesLink(browser, viewport);
        }
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
