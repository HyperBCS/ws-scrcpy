// node scripts/test-browser.js device-page
// One phone's page against socket fixtures. An Android phone has the tabs Screen, Files and Shell
// on every view, and a tab change replaces the history entry. The stream socket closes when
// another tab is shown and one opens on return. Files and Shell stay mounted behind the other
// tabs and stop when the page is left. An iPhone has no tabs. Switch replaces the entry. No link
// in the page carries an older action, a player or a socket.
// No device, adb or pymobiledevice3 is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const { settleMotion } = require('./ui-motion');
// The one icon set, to tell which icon a control shows.
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const { ICONS } = require('../src/app/ui/icons');

// Only through test-browser.js, which serves the build on a port of its own. Without it this
// would open streams on the live server.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js device-page');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-device-page';
const NOW = Date.now();

const PIXEL = 'PAGE-PIXEL-0001';
const PIXEL_2 = 'PAGE-PIXEL-0002';
const IPHONE = 'PAGE-IPHONE-0001';
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
const IPHONES = [iphone(IPHONE, 'Bench iPhone')];
const SUMMARY = { unread: 2, unreadBySource: { [IPHONE]: 2 }, sources: [{ id: IPHONE, name: 'Bench iPhone' }] };
const PHONE = { name: 'phone', width: 390, height: 844, mobile: true };
const DESKTOP = { name: 'desktop', width: 1280, height: 800, mobile: false };
const TABS = ['Screen', 'Files', 'Shell'];

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
 * A page on the fixture server. `streams` lists every stream socket the page opened and
 * `streamsClosed` every one it closed, in order: one entry is one session start or end on a
 * phone. `opened` lists the channels of every kind, `closed` the tool channels the page closed.
 */
async function start(browser, { viewport = PHONE, colorScheme = 'light', hash = '' } = {}) {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile, colorScheme, serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const state = { context, page, errors: [], streams: [], streamsClosed: [], opened: [], closed: [], shells: [], input: [], resizes: [], lists: [], trackers: {} };
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
            const udid = url.searchParams.get('udid');
            state.streams.push({ action, udid });
            socket.onClose(() => state.streamsClosed.push(udid));
            if (action === 'proxy-adb') setTimeout(() => socket.send(initialStreamPacket()), 40);
            return; // The iPhone stream stays on "Connecting".
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
                state.opened.push(code);
                if (code === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } });
                const list = (kind, devices) => {
                    state.trackers[kind] = (found) => send({ id: -1, type: 'devicelist', data: { id: kind, name: 'Fixture host', list: found } });
                    state.trackers[kind](devices);
                };
                if (code === 'GTRC') list('android', ANDROIDS);
                if (code === 'ATRC') list('ios', IPHONES);
            } else if (type === 8) {
                if (channels.get(id) === 'SHEL' || channels.get(id) === 'FSLS') state.closed.push(channels.get(id));
            } else if (type === 32 && channels.get(id) === 'SHEL') {
                if (body.startsWith('{')) {
                    const message = JSON.parse(body);
                    if (message.data?.type === 'start') {
                        state.shells.push(message.data.udid);
                        socket.send(frame(32, id, `Fixture terminal ${state.shells.length} ready\r\n$ `));
                    }
                } else {
                    // Typed input is echoed, as a shell does.
                    state.input.push(body);
                    socket.send(frame(32, id, body));
                }
            } else if (type === 16 && channels.get(id) === 'SHEL') {
                // After the start, the terminal size travels in binary frames.
                const message = JSON.parse(payload.toString());
                if (message.data?.type === 'resize') state.resizes.push(`${message.data.cols}x${message.data.rows}`);
            } else if (type === 64 && channels.get(id) === 'FSLS') {
                const inner = payload[0], channel = payload.readUInt32LE(1), request = payload.subarray(5);
                if (inner !== 4) return;
                const reply = (answer) => socket.send(frame(64, id, frame(16, channel, answer)));
                const end = (code) => socket.send(frame(64, id, closeFrame(channel, code)));
                const command = request.subarray(0, 4).toString();
                const target = request.subarray(8, 8 + request.readUInt32LE(4)).toString();
                if (command === 'STAT') {
                    reply(stat(FOLDERS[target] || ['/', '/data', '/data/local'].includes(target) ? DIR : 0));
                    end(1000);
                } else if (command === 'LIST') {
                    state.lists.push(target);
                    (FOLDERS[target] || []).forEach(([name, mode]) => reply(dent(name, mode)));
                    end(0);
                } else {
                    reply(Buffer.from('DONE'));
                    end(1000);
                }
            }
        });
    });
    await page.goto(BASE + (hash ? `#!${hash}` : ''));
    return state;
}

const card = (page, key) => page.locator(`article.device[data-device-key="${key}"]`);
const hash = (page) => page.evaluate(() => location.hash);
const entries = (page) => page.evaluate(() => history.length);
/**
 * Where the tab is in its history. A sheet's entry stays ahead of the page once the sheet has
 * closed, so `history.length` counts it; the back stack does not.
 */
const place = (page) => page.evaluate(() => history.state?.nav?.index);
const quiet = (page, ms = 350) => page.waitForTimeout(ms);
const streamsOf = (test, udid) => test.streams.filter((stream) => stream.udid === udid).length;
const count = (list, value) => list.filter((item) => item === value).length;
const tab = (page, name) => page.locator('.kit-tabs-list').getByRole('button', { name, exact: true });
const crumb = (page, name) => page.locator('.file-explorer[data-listing="ready"] .fx-crumb[aria-current="page"]').filter({ hasText: name });
const terminalText = (page) => page.locator('.terminal-container .xterm-rows').innerText();
const terminalRows = (page) => page.locator('.terminal-container .xterm-rows > div').count();

async function until(condition, label, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (!(await condition())) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/** The phone and the view an address shows. */
function viewOf(address) {
    const params = new URLSearchParams(address.replace(/^#!/, ''));
    return { udid: params.get('udid'), view: params.get('action') === 'device' ? params.get('view') : undefined };
}

/**
 * Every link in the page chrome, and the address. None names an older action, a player or a
 * socket. The rows inside a mounted tool are that tool's own. `allowPlayer` is for the list,
 * whose "Open with" links name their player on purpose.
 */
async function checkLinks(page, label, { allowPlayer = false } = {}) {
    const links = await page.evaluate(() =>
        [...document.querySelectorAll('[href]')]
            .filter((element) => element.matches('a, area') && !element.closest('.tool-mount'))
            .map((element) => ({ text: element.textContent.trim(), href: element.getAttribute('href'), hash: element.hash })),
    );
    const older = /action=(stream|stream-coredevice|shell|list-files)(&|$)/;
    for (const link of [...links, { text: 'the address', href: await hash(page), hash: await hash(page) }]) {
        for (const value of [link.href, link.hash]) {
            assert.doesNotMatch(value, older, `${label}: "${link.text}" names no older action (${value})`);
            assert.doesNotMatch(value, /[?&#!]ws=/, `${label}: "${link.text}" carries no socket (${value})`);
            if (!(allowPlayer && link.text.startsWith('Open with'))) {
                assert.doesNotMatch(value, /[?&#!]player=/, `${label}: "${link.text}" carries no player (${value})`);
            }
        }
    }
    return links;
}

/** The header and the tab strip of the view that is shown: one of each, the strip under the header. */
async function checkChrome(page, label, current, viewport, { entered = false } = {}) {
    // The strip slides in when the page is entered. A tab change draws it in place, at rest.
    assert.equal(
        await page.locator('nav.kit-tabs').evaluate((strip) => getComputedStyle(strip).animationName),
        entered ? 'surface-enter' : 'none',
        `${label}: the strip ${entered ? 'enters with the page' : 'does not enter again on a tab change'}`,
    );
    await settleMotion(page);
    // The header and the tabs are the kit's: one bar whose title is the page's one h1, and
    // none of the header or the tab row from before the kit.
    assert.equal(await page.locator('header.kit-bar').count(), 1, `${label}: one header`);
    assert.equal(await page.locator('nav.kit-tabs').count(), 1, `${label}: one tab strip`);
    assert.equal(await page.locator('.stream-header, .tool-navigation').count(), 0, `${label}: no header or tabs of the older look`);
    assert.deepEqual(await page.locator('h1').evaluateAll((list) => list.map((h1) => h1.className)), ['kit-bar-name'], `${label}: one h1, the name in the bar`);
    assert.deepEqual(await page.locator('.kit-tabs-list .kit-tab').allInnerTexts(), TABS, `${label}: the tabs`);
    assert.deepEqual(await page.locator('.kit-tabs-list .kit-tab[aria-current="page"]').allInnerTexts(), [current], `${label}: ${current} is the current tab`);
    assert.equal(await page.locator('.kit-bar-back').getAttribute('aria-label'), 'Phones', `${label}: the back control is named after the list`);
    assert.equal(await page.locator('.kit-bar .notifications-link').count(), 1, `${label}: the bell`);
    assert.equal(await page.locator('.kit-bar').getByRole('button', { name: 'Switch', exact: true }).innerText(), 'Switch');
    const boxes = await page.evaluate(() => {
        const rect = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
        return {
            header: rect('.kit-bar'), strip: rect('nav.kit-tabs'),
            tabs: [...document.querySelectorAll('.kit-tabs-list .kit-tab')].map((button) => button.getBoundingClientRect().toJSON()),
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
        };
    });
    assert.ok(Math.abs(boxes.strip.top - boxes.header.bottom) <= 1, `${label}: the strip sits under the header (${boxes.header.bottom}, ${boxes.strip.top})`);
    assert.ok(boxes.strip.height >= 44 && boxes.strip.height <= 46, `${label}: the strip is the kit's row, 44px tabs over a line (${boxes.strip.height})`);
    assert.ok(boxes.tabs.every((box) => box.height >= 44 && box.width >= 44 && box.left >= 0 && box.right <= viewport.width + 1), `${label}: every tab is a 44px target on screen`);
    assert.equal(boxes.overflow, false, `${label}: nothing overflows sideways`);
    return boxes;
}

/** The icon of the one set each control of the screen shows, by the control's title. */
const CONTROL_ICONS = {
    Back: 'navBack', Home: 'home', Overview: 'square', 'Volume down': 'volDown', 'Mute phone': 'volMute', 'Volume up': 'volUp',
    Lock: 'power', Siri: 'mic', Listen: 'headphones', 'Take screenshot': 'camera', Actions: 'bolt', Settings: 'sliders', 'Type text': 'text',
};

/**
 * The controls of a phone's screen, in the panel on a phone and in the rail on a desktop: each
 * is the kit's icon button with a name, one icon of the one set and a caption, and nothing is
 * drawn with a character. Listen says whether it is on. The controls button is one too.
 */
async function checkControls(page, label, viewport, titles) {
    const fab = page.locator('.floating-toolbar-fab');
    if (viewport.mobile) {
        assert.equal(await fab.evaluate((button) => button.matches('button.kit-icon-button')), true, `${label}: the controls button is the kit's icon button`);
        assert.equal(await fab.getAttribute('aria-label'), 'Show controls');
        assert.equal(await fab.locator('svg.kit-icon > path').getAttribute('d'), ICONS.grid, `${label}: the controls button shows the grid`);
        await fab.click();
        await page.locator('.floating-toolbar.open').waitFor();
        await settleMotion(page);
        assert.equal(await fab.locator('svg.kit-icon > path').getAttribute('d'), ICONS.close, `${label}: and the cross while the panel is open`);
    } else {
        assert.equal(await fab.count(), 0, `${label}: the rail has no controls button`);
    }
    const controls = await page.locator('.control-buttons-list > *').evaluateAll((list) =>
        list.map((control) => {
            const caption = control.querySelector('.kit-icon-button-caption');
            const box = control.getBoundingClientRect();
            return {
                title: control.title, name: control.getAttribute('aria-label'), kit: control.matches('button.kit-icon-button.kit-icon-button-captioned'),
                svgs: control.querySelectorAll('svg').length, images: control.querySelectorAll('img').length,
                path: control.querySelector(':scope > svg.kit-icon > path')?.getAttribute('d'),
                caption: caption?.textContent, captionHidden: caption?.getAttribute('aria-hidden'), text: control.textContent,
                size: parseFloat(getComputedStyle(caption || control).fontSize), pressed: control.getAttribute('aria-pressed'),
                width: box.width, height: box.height,
            };
        }),
    );
    assert.deepEqual(controls.map((control) => control.title), titles, `${label}: the controls, in their order`);
    for (const control of controls) {
        const name = `${label} ${control.title}`;
        assert.equal(control.kit, true, `${name}: the kit's icon button with a caption`);
        assert.equal(control.name, control.title, `${name}: named`);
        assert.equal(control.svgs, 1, `${name}: one icon`);
        assert.equal(control.images, 0, `${name}: no picture file`);
        assert.equal(control.path, ICONS[CONTROL_ICONS[control.title]], `${name}: the ${CONTROL_ICONS[control.title]} icon of the set`);
        assert.equal(control.text, control.caption, `${name}: no text beside the caption`);
        assert.match(control.caption, /^[A-Za-z ]+$/, `${name}: the caption is words (${control.caption})`);
        assert.equal(control.captionHidden, 'true', `${name}: the caption is not read out after the name`);
        assert.equal(control.size, 12, `${name}: a 12px caption`);
        assert.ok(control.width >= 44 && control.height >= 44, `${name}: a 44px target (${control.width} by ${control.height})`);
        assert.equal(control.pressed, control.title === 'Listen' ? 'false' : null, `${name}: only Listen is a control that stays on`);
    }
    assert.notEqual(ICONS.headphones, ICONS.volMute, 'Listen and the mute key of the phone are different icons');
    if (!viewport.mobile) {
        // The rail scrolls and its controls take its full width: the focus ring of each one is
        // drawn where the rail does not cut it. A disabled key takes no focus.
        const rings = await page.locator('.control-buttons-list > :not(:disabled)').evaluateAll((list) =>
            list.map((control) => {
                control.focus();
                const style = getComputedStyle(control);
                const reach = Math.max(0, parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth));
                const box = control.getBoundingClientRect();
                const panel = control.closest('.floating-toolbar-panel');
                const left = panel.getBoundingClientRect().left + panel.clientLeft;
                const inside = box.left - reach >= left - 0.5 && box.right + reach <= left + panel.clientWidth + 0.5;
                return { title: control.title, ring: control.matches(':focus-visible') && style.outlineStyle === 'solid', inside };
            }),
        );
        await page.evaluate(() => document.activeElement?.blur());
        assert.deepEqual(rings.filter((ring) => !ring.ring || !ring.inside).map((ring) => ring.title), [], `${label}: every control of the rail shows its whole focus ring`);
    }
    if (viewport.mobile) {
        await fab.click();
        await page.locator('.floating-toolbar.open').waitFor({ state: 'detached' });
        await settleMotion(page);
    }
}

/** The controls of both kinds of phone, in a page of their own: opening the panel adds a history entry. */
async function screenControls(browser, viewport) {
    for (const [udid, titles] of [
        [PIXEL, ['Back', 'Home', 'Overview', 'Volume down', 'Mute phone', 'Volume up', 'Lock', 'Listen', 'Take screenshot', 'Type text', 'Actions', 'Settings']],
        [IPHONE, ['Home', 'Volume down', 'Mute phone', 'Volume up', 'Lock', 'Listen', 'Take screenshot', 'Type text', 'Actions', 'Settings', 'Siri']],
    ]) {
        const test = await start(browser, { viewport, hash: `action=device&udid=${udid}&view=screen` });
        try {
            await test.page.locator('.control-buttons-list').waitFor({ state: 'attached' });
            await checkControls(test.page, `${viewport.name} ${udid}`, viewport, titles);
            await quiet(test.page);
            assert.equal(test.streams.length, 1, `${viewport.name} ${udid}: one stream socket for the open`);
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    console.log(`PASS ${viewport.name} every control of the screen is a kit icon button with a name, an icon of the set and a caption`);
}

/** Screen, Files, Shell and back on one Android phone, with one history entry for all of it. */
async function androidTabs(browser, viewport, colorScheme) {
    const test = await start(browser, { viewport, colorScheme });
    const { page } = test;
    const label = `${viewport.name}-${colorScheme}`;
    const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}-${label}.png`) });
    try {
        await card(page, `android:${PIXEL}`).waitFor();
        assert.equal(await page.getByRole('heading', { name: 'Phones', exact: true }).count(), 1, 'the list is named Phones');
        assert.equal(await page.title(), 'Phones · ws-scrcpy');
        const listLinks = await checkLinks(page, `${label} list`, { allowPlayer: true });
        assert.ok(listLinks.some((link) => link.text === 'Open screen' && link.hash === `#!action=device&udid=${PIXEL}&view=screen`), 'the card link names the phone and the view only');
        const before = await entries(page);

        // Screen: the stream, with the tabs under the header.
        await card(page, `android:${PIXEL}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.getByText('Connected', { exact: true }).first().waitFor();
        assert.equal(await hash(page), `#!action=device&udid=${PIXEL}&view=screen`);
        assert.equal(await entries(page), before + 1, 'the list to a phone adds one entry');
        const screen = await checkChrome(page, `${label} Screen`, 'Screen', viewport, { entered: true });
        const stage = await page.locator('.stream-stage').boundingBox();
        assert.ok(stage.y >= screen.strip.bottom - 1, `${label}: the picture starts below the tabs`);
        await quiet(page);
        assert.equal(streamsOf(test, PIXEL), 1, 'one stream socket for one open');
        assert.deepEqual(test.opened.filter((code) => code === 'FSLS' || code === 'SHEL'), [], 'a tool that has not been shown is not connected');
        assert.equal(await page.locator('.tool-view, .file-explorer, .terminal-container').count(), 0, 'and not mounted');
        assert.equal(await page.evaluate(() => document.body.className), 'stream');
        await checkLinks(page, `${label} Screen`);
        // What is laid over the picture starts below the tabs, not over them, and takes no
        // room from the picture: a notice hangs from a place without height above the stage.
        const notice = await page.evaluate(() => {
            const stage = document.querySelector('.stream-stage');
            const before = stage.getBoundingClientRect().top;
            const probe = document.createElement('div');
            probe.className = 'stream-notice-anchor';
            probe.innerHTML = '<div class="kit-banner stream-notice">A notice</div>';
            stage.before(probe);
            const result = { top: probe.firstChild.getBoundingClientRect().top, moved: stage.getBoundingClientRect().top - before };
            probe.remove();
            return result;
        });
        assert.ok(notice.top >= screen.strip.bottom, `${label}: a notice shows below the tabs (${notice.top})`);
        assert.equal(notice.moved, 0, `${label}: a notice does not move the picture`);
        await shot('screen');

        // Files: the stream stops at once. The entry is replaced.
        await tab(page, 'Files').click();
        await page.locator('.tool-view-list-files').waitFor();
        await crumb(page, 'tmp').waitFor();
        await until(() => test.streamsClosed.length === 1, 'the stream socket closes when Files is shown');
        assert.equal(await page.locator('.stream-view').count(), 0, 'the stream view is gone');
        assert.deepEqual(viewOf(await hash(page)), { udid: PIXEL, view: 'files' });
        assert.equal(await entries(page), before + 1, 'a tab change adds no entry');
        await checkChrome(page, `${label} Files`, 'Files', viewport);
        assert.equal(count(test.opened, 'FSLS'), 1);
        assert.equal(count(test.opened, 'SHEL'), 0, 'Shell is not connected by a visit to Files');
        assert.equal(await page.evaluate(() => document.body.className), 'file-listing');
        await page.waitForFunction(() => document.title === 'Google Pixel 9 · Files · ws-scrcpy');
        await checkLinks(page, `${label} Files`);
        const folder = page.locator('.fx-row[data-name="photos"] .entry-name a');
        if (viewport.mobile) await folder.click();
        else await folder.dblclick();
        await crumb(page, 'photos').waitFor();
        await page.locator('.fx-row[data-name="holiday.jpg"]').waitFor();
        const afterFolder = await entries(page);
        await shot('files');

        // Shell: Files stays mounted behind it.
        await tab(page, 'Shell').click();
        await page.locator('.tool-view-shell').waitFor();
        await page.locator('.tool-connection.connected').waitFor();
        await until(async () => (await terminalText(page)).includes('Fixture terminal 1 ready'), 'the shell starts');
        const rows = await terminalRows(page);
        assert.equal(await hash(page), `#!action=device&udid=${PIXEL}&view=shell`);
        assert.equal(await entries(page), afterFolder, 'a tab change adds no entry');
        await checkChrome(page, `${label} Shell`, 'Shell', viewport);
        assert.equal(await page.locator('.file-explorer').count(), 1, 'Files is still mounted');
        assert.equal(await page.locator('.file-explorer').isVisible(), false, 'and hidden');
        assert.deepEqual(test.closed, [], 'a tab change closes no tool channel');
        assert.equal(await page.evaluate(() => document.body.className), 'shell');
        await checkLinks(page, `${label} Shell`);
        await page.getByRole('button', { name: 'Show keyboard', exact: true }).click();
        await page.keyboard.type('kept');
        await until(async () => (await terminalText(page)).includes('$ kept'), 'typed input is echoed');
        await shot('shell');

        // Back to Files: the same client, in the folder it was left in. The tab link names no
        // folder, so Files writes the one it shows into the address, in the same entry.
        await tab(page, 'Files').click();
        await crumb(page, 'photos').waitFor();
        await page.locator('.fx-row[data-name="holiday.jpg"]').waitFor();
        await page.waitForFunction(
            (expected) => location.hash === expected,
            `#!action=device&udid=${PIXEL}&view=files&path=${encodeURIComponent(`${ROOT}/photos`)}`,
        );
        assert.equal(await entries(page), afterFolder, 'Files writes its folder without a new entry');
        assert.equal(count(test.opened, 'FSLS'), 1, 'Files is not connected a second time');
        assert.equal(await page.locator('.terminal-container').isVisible(), false, 'the shell is hidden behind Files');
        assert.equal(await page.evaluate(() => document.body.className), 'file-listing');
        await page.keyboard.type('x');
        await quiet(page, 150);
        assert.deepEqual(test.input.join(''), 'kept', 'typing does not reach a hidden shell');

        // Back to Screen: exactly one new stream socket. Both tools stay behind it.
        await tab(page, 'Screen').click();
        await page.locator('.stream-view').waitFor();
        await page.getByText('Connected', { exact: true }).first().waitFor();
        await quiet(page, 500);
        assert.equal(streamsOf(test, PIXEL), 2, 'one stream socket opens on return to Screen');
        assert.equal(test.streamsClosed.length, 1);
        assert.equal(await hash(page), `#!action=device&udid=${PIXEL}&view=screen`);
        await checkChrome(page, `${label} Screen again`, 'Screen', viewport);
        assert.equal(await page.locator('.tool-view').count(), 2, 'Files and Shell are still mounted');
        assert.equal(await page.locator('.tool-view:visible').count(), 0, 'and hidden');
        assert.equal(await page.evaluate(() => document.body.className), 'stream');
        assert.deepEqual(test.closed, []);
        // A question a hidden tool has to put (Files, before uploads are dropped) still shows.
        await page.evaluate(() => {
            const dialog = document.createElement('dialog');
            dialog.id = 'page-probe-dialog';
            dialog.innerHTML = '<form method="dialog"><button>Probe</button></form>';
            document.querySelector('.tool-view-list-files .tool-mount').append(dialog);
            dialog.showModal();
        });
        await page.locator('#page-probe-dialog').getByRole('button', { name: 'Probe', exact: true }).click();
        assert.equal(await page.locator('#page-probe-dialog').evaluate((dialog) => dialog.open), false, 'a modal dialog of a hidden tool can be seen and answered');
        await page.evaluate(() => document.getElementById('page-probe-dialog').remove());

        // Shell again: the same session, with what was typed.
        await tab(page, 'Shell').click();
        await page.locator('.tool-view-shell').waitFor();
        await until(() => test.streamsClosed.length === 2, 'the stream socket closes when Shell is shown');
        assert.deepEqual(test.shells, [PIXEL], 'the shell session was not started again');
        const text = await terminalText(page);
        assert.ok(text.includes('$ kept') && !text.includes('Fixture terminal 2'), 'the terminal shows the session it had');
        // Hidden, the terminal kept its size: the phone's terminal was never resized.
        await quiet(page, 300);
        assert.equal(await terminalRows(page), rows, 'the terminal has the rows it had');
        assert.deepEqual(test.resizes, [], 'a tab change does not resize the terminal on the phone');
        await page.getByRole('button', { name: 'Show keyboard', exact: true }).click();
        await page.keyboard.type('!');
        await until(() => test.input.join('') === 'kept!', 'input reaches the same session');
        assert.equal(await entries(page), afterFolder, 'six tab changes added no entry');

        // The header's back control leaves the page: both tools stop. Back then leaves the app.
        await page.getByRole('button', { name: 'Phones', exact: true }).click();
        await page.locator('#devices').waitFor();
        await until(() => count(test.closed, 'SHEL') === 1 && count(test.closed, 'FSLS') === 1, 'leaving the page closes Files and Shell');
        assert.equal(await page.locator('.tool-view, .terminal-container, .file-explorer, .stream-view').count(), 0);
        assert.equal(await page.evaluate(() => document.body.className), 'list');
        await quiet(page);
        assert.equal(test.streams.length, 2, 'going back to the list starts no stream');
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label} Android tabs: Screen, Files and Shell on every view, one entry, the stream stops and starts once, the tools keep their state`);
    } finally {
        await test.context.close();
    }
}

/** From each tab, one press of the browser's Back shows the list, and the next leaves the app. */
async function oneBackFromAnyTab(browser, viewport) {
    for (const name of TABS) {
        const test = await start(browser, { viewport });
        const { page } = test;
        try {
            await card(page, `android:${PIXEL}`).getByRole('link', { name: 'Open screen', exact: true }).click();
            await page.getByText('Connected', { exact: true }).first().waitFor();
            // Through the other tabs first, so the entry has been replaced more than once.
            for (const step of TABS.filter((other) => other !== name).concat(name)) {
                await tab(page, step).click();
                await page.locator(`.kit-tabs-list .kit-tab[aria-current="page"]`, { hasText: step }).waitFor();
            }
            if (name === 'Screen') await page.getByText('Connected', { exact: true }).first().waitFor();
            await quiet(page);
            const streams = test.streams.length;
            await page.goBack();
            await page.locator('#devices').waitFor();
            assert.equal(await hash(page), '', `${name}: one Back reaches the list`);
            assert.equal(await page.locator('.stream-view, .tool-view').count(), 0);
            await quiet(page);
            assert.equal(test.streams.length, streams, `${name}: Back started no stream`);
            await page.goBack().catch(() => undefined);
            assert.ok(!page.url().startsWith(BASE), `${name}: the next Back leaves the app (${page.url()})`);
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    console.log(`PASS ${viewport.name} one Back from Screen, Files or Shell reaches the list`);
}

/** Switch shows another phone in the same entry, and the tools of the phone before stop. */
async function switchReplaces(browser, viewport) {
    const test = await start(browser, { viewport });
    const { page } = test;
    const label = `${viewport.name} switch`;
    const pick = async (name) => {
        await page.getByRole('button', { name: 'Switch', exact: true }).click();
        const sheet = page.locator('dialog.kit-sheet[open]');
        await sheet.waitFor();
        await settleMotion(page);
        await sheet.getByRole('button', { name }).click();
        await sheet.waitFor({ state: 'hidden' });
    };
    try {
        await card(page, `android:${PIXEL}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.getByText('Connected', { exact: true }).first().waitFor();
        const opened = await place(page);

        await pick(/Pixel 8/);
        await page.waitForFunction((udid) => location.hash === `#!action=device&udid=${udid}&view=screen`, PIXEL_2);
        await page.getByText('Connected', { exact: true }).first().waitFor();
        await quiet(page);
        assert.deepEqual(test.streams.map((stream) => stream.udid), [PIXEL, PIXEL_2], `${label}: one stream socket per phone`);
        assert.deepEqual(test.streamsClosed, [PIXEL]);
        assert.equal(await place(page), opened, `${label}: Switch adds no entry`);
        // Forward reaches the entry the switcher had, which still has the address of the phone
        // before. It is stepped back over without showing that phone, so no stream starts for it.
        await page.goForward();
        await quiet(page, 500);
        assert.equal(await hash(page), `#!action=device&udid=${PIXEL_2}&view=screen`, `${label}: Forward stays on this phone`);
        assert.equal(await place(page), opened);
        assert.deepEqual(test.streams.map((stream) => stream.udid), [PIXEL, PIXEL_2], `${label}: Forward starts no stream`);
        assert.deepEqual(test.streamsClosed, [PIXEL]);

        // Files of this phone, in a folder; then the same tool on the other phone.
        await tab(page, 'Files').click();
        await crumb(page, 'tmp').waitFor();
        const folder = page.locator('.fx-row[data-name="photos"] .entry-name a');
        if (viewport.mobile) await folder.click();
        else await folder.dblclick();
        await crumb(page, 'photos').waitFor();
        const inFolder = await place(page);
        await pick(/Pixel 9/);
        await page.waitForFunction((udid) => location.hash.includes(udid), PIXEL);
        await page.waitForFunction(() => document.title === 'Google Pixel 9 · Files · ws-scrcpy');
        await crumb(page, 'tmp').waitFor();
        assert.deepEqual(viewOf(await hash(page)), { udid: PIXEL, view: 'files' });
        assert.equal(await place(page), inFolder, `${label}: Switch from a tool adds no entry`);
        await until(() => count(test.closed, 'FSLS') === 1, 'the Files of the phone before is closed');
        assert.equal(count(test.opened, 'FSLS'), 2);
        assert.equal(await page.locator('.tool-view').count(), 1, 'only this phone has a tool mounted');
        await checkLinks(page, label);

        // An iPhone from the switcher: the screen, and no tabs.
        await tab(page, 'Screen').click();
        await page.getByText('Connected', { exact: true }).first().waitFor();
        await pick(/Bench iPhone/);
        await page.waitForFunction((udid) => location.hash === `#!action=device&udid=${udid}&view=screen`, IPHONE);
        await page.locator('.stream-view').waitFor();
        await until(() => count(test.closed, 'FSLS') === 2, 'the tools of the Android phone stop when an iPhone is shown');
        assert.equal(await page.locator('nav.kit-tabs, .tool-view').count(), 0, `${label}: an iPhone has no tabs`);
        assert.equal(await place(page), inFolder);
        await quiet(page);
        assert.deepEqual(test.streams.map((stream) => stream.udid), [PIXEL, PIXEL_2, PIXEL, IPHONE]);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${viewport.name} Switch replaces the entry on the screen and in a tool, and the tools of the phone before stop`);
    } finally {
        await test.context.close();
    }
}

/** An iPhone's page: the shared header with the bell, no tab strip, no exit row in its Actions sheet. */
async function iphonePage(browser, viewport, colorScheme) {
    const test = await start(browser, { viewport, colorScheme });
    const { page } = test;
    const label = `${viewport.name}-${colorScheme} iPhone`;
    try {
        await card(page, `ios:${IPHONE}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        assert.equal(await hash(page), `#!action=device&udid=${IPHONE}&view=screen`);
        assert.equal(await page.locator('nav.kit-tabs').count(), 0, `${label}: no tab strip`);
        const header = page.locator('header.kit-bar');
        assert.equal(await header.count(), 1);
        assert.equal(await header.locator('h1.kit-bar-name').textContent(), 'Bench iPhone');
        assert.equal(await page.locator('h1').count(), 1, `${label}: the name in the bar is the page's one h1`);
        assert.equal(await header.locator('.kit-bar-back').getAttribute('aria-label'), 'Phones');
        // The fixture's socket opens and says nothing more, so the session never starts.
        assert.match(await header.locator('.kit-bar-status').innerText(), /^(Connecting…|Starting the phone stream…)$/);
        const bell = header.locator('.notifications-link');
        assert.equal(await bell.getAttribute('href'), `#!action=notifications&source=${IPHONE}`, `${label}: the bell opens this iPhone's inbox`);
        assert.equal(await bell.getAttribute('aria-label'), 'Notifications, 2 unread');
        assert.equal(await header.getByRole('button', { name: 'Switch', exact: true }).innerText(), 'Switch');
        const stage = await page.locator('.stream-stage').boundingBox();
        const bar = await header.boundingBox();
        assert.ok(Math.abs(stage.y - (bar.y + bar.height)) <= 1, `${label}: the picture starts under the header`);
        await quiet(page);
        assert.deepEqual(test.streams, [{ action: 'proxy-coredevice', udid: IPHONE }], 'one iPhone session for one open');
        assert.deepEqual(test.opened.filter((code) => code === 'FSLS' || code === 'SHEL'), []);
        await checkLinks(page, label);
        await page.screenshot({ path: path.join(OUT, `iphone-${label.replace(' iPhone', '')}.png`) });

        // The Actions sheet has no way out of the page: the header's back control is the one.
        if (viewport.mobile) await page.locator('.floating-toolbar-fab').click();
        await page.locator('.control-buttons-list [title="Actions"]').click();
        const sheet = page.getByRole('dialog', { name: 'Actions', exact: true });
        await sheet.waitFor();
        await settleMotion(page);
        assert.equal(await sheet.locator('.sheet-footer').count(), 0);
        assert.equal(await sheet.getByRole('button', { name: /Back to devices|Phones|Disconnect/ }).count(), 0, `${label}: no exit row in the Actions sheet`);
        await sheet.getByRole('button', { name: /^Close/ }).click();
        await sheet.waitFor({ state: 'hidden' });

        await header.locator('.kit-bar-back').click();
        await page.locator('#devices').waitFor();
        await page.goBack().catch(() => undefined);
        assert.ok(!page.url().startsWith(BASE), `${label}: Back from the list leaves the app`);
        await quiet(page);
        assert.equal(test.streams.length, 1);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label}: the shared header with the bell, no tabs, no exit row in the Actions sheet`);
    } finally {
        await test.context.close();
    }
}

/** The Android Actions sheet lost its Disconnect row. */
async function androidActionsSheet(browser) {
    const test = await start(browser, { viewport: DESKTOP });
    const { page } = test;
    try {
        await card(page, `android:${PIXEL}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.getByText('Connected', { exact: true }).first().waitFor();
        await page.locator('.control-buttons-list [title="Actions"]').click();
        const sheet = page.getByRole('dialog', { name: 'Actions', exact: true });
        await sheet.waitFor();
        await settleMotion(page);
        assert.ok((await sheet.getByRole('button').count()) > 2, 'the other rows are still there');
        assert.equal(await sheet.getByRole('button', { name: /Disconnect|Back to devices|Phones/ }).count(), 0, 'no Disconnect row');
        assert.equal(await sheet.getByText('Return to devices.', { exact: true }).count(), 0);
        assert.deepEqual(test.errors, []);
        console.log('PASS the Android Actions sheet has no Disconnect row');
    } finally {
        await test.context.close();
    }
}

/** Another player from the settings sheet: the same entry, one new stream, and the choice survives a look at a tab. */
async function playerChangeReplaces(browser) {
    const test = await start(browser, { viewport: DESKTOP });
    const { page } = test;
    try {
        await card(page, `android:${PIXEL}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.getByText('Connected', { exact: true }).first().waitFor();
        const opened = await place(page);
        await page.locator('.control-buttons-list [title="Settings"]').click();
        const sheet = page.locator('dialog.kit-sheet[open]');
        await sheet.waitFor();
        await settleMotion(page);
        await sheet.locator('.settings-playback > summary').click();
        await settleMotion(page);
        await sheet.locator('.settings-playback select').first().selectOption('mse');
        await page.waitForFunction((udid) => location.hash.startsWith(`#!action=device&udid=${udid}&view=screen&player=mse`), PIXEL);
        await sheet.waitFor({ state: 'hidden' });
        await page.getByText('Connected', { exact: true }).first().waitFor();
        await quiet(page, 500);
        assert.equal(await place(page), opened, 'a player change adds no entry');
        assert.equal(streamsOf(test, PIXEL), 2, 'one new stream socket for the new player');
        assert.doesNotMatch(await hash(page), /[&!]ws=/, 'the address still names no socket');

        await tab(page, 'Shell').click();
        await page.locator('.tool-view-shell').waitFor();
        await tab(page, 'Screen').click();
        await page.getByText('Connected', { exact: true }).first().waitFor();
        assert.match(await hash(page), /&player=mse/, 'the player chosen for this visit is kept across the tabs');
        await quiet(page, 500);
        assert.equal(streamsOf(test, PIXEL), 3);
        await page.goBack();
        await page.locator('#devices').waitFor();
        assert.deepEqual(test.errors, []);
        console.log('PASS a player change replaces the entry, restarts the stream once and is kept across the tabs');
    } finally {
        await test.context.close();
    }
}

/** The keyboard stays on the tabs across a tab change, and a hidden tool holds no focus. */
async function focusFollowsTheTabs(browser) {
    const test = await start(browser, { viewport: DESKTOP });
    const { page } = test;
    const focused = () => page.evaluate(() => ({
        text: document.activeElement?.textContent, current: document.activeElement?.getAttribute('aria-current'),
        inStrip: !!document.activeElement?.closest('.kit-tabs-list'), inHiddenTool: !!document.activeElement?.closest('.tool-view[hidden]'),
    }));
    try {
        await card(page, `android:${PIXEL}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.getByText('Connected', { exact: true }).first().waitFor();
        await tab(page, 'Shell').focus();
        await page.keyboard.press('Enter');
        await page.locator('.tool-view-shell').waitFor();
        assert.deepEqual(await focused(), { text: 'Shell', current: 'page', inStrip: true, inHiddenTool: false }, 'the tab that was pressed keeps the focus in the next view');
        // The terminal takes the focus when it is created on a desktop, and when it is clicked.
        await page.locator('.tool-connection.connected').waitFor();
        await page.locator('.terminal-container .xterm').click();
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.terminal-container')), true);
        // A tab change that does not move the focus itself: the terminal must give it up.
        await page.evaluate(() => [...document.querySelectorAll('.kit-tabs-list .kit-tab')].find((button) => button.textContent === 'Files').click());
        await page.locator('.tool-view-list-files').waitFor();
        assert.equal((await focused()).inHiddenTool, false, 'a hidden shell does not keep the focus');
        await page.keyboard.type('lost');
        await quiet(page, 150);
        assert.deepEqual(test.input, [], 'typing does not reach the hidden shell');
        assert.deepEqual(test.errors, []);
        console.log('PASS the focus follows the tabs, and a hidden tool gives it up');
    } finally {
        await test.context.close();
    }
}

/** After a deploy the Shell chunk is gone. The Shell tab still offers Reload, and the other tabs work. */
async function reloadOfferOnATab(browser) {
    const test = await start(browser);
    const { page } = test;
    try {
        let blocked = false;
        await page.route('**/*.js', async (route) => {
            const response = await route.fetch();
            // The Shell chunk is the one that builds the terminal container.
            if (!route.request().url().endsWith('/bundle.js') && (await response.text()).includes('terminal-container')) {
                blocked = true;
                return route.fulfill({ status: 404, body: 'gone' });
            }
            return route.fulfill({ response });
        });
        await card(page, `android:${PIXEL}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.getByText('Connected', { exact: true }).first().waitFor();
        await tab(page, 'Shell').click();
        const banner = page.locator('.tool-error');
        await banner.getByText('Shell could not be loaded. Reload the page to try again.', { exact: true }).waitFor();
        assert.ok(blocked, 'the fixture refused the Shell chunk');
        assert.equal(await banner.getByRole('button').innerText(), 'Reload');
        await checkChrome(page, 'missing code', 'Shell', PHONE);
        await tab(page, 'Screen').click();
        await page.getByText('Connected', { exact: true }).first().waitFor();
        assert.equal(await page.locator('.tool-error:visible').count(), 0, 'the banner belongs to the Shell tab');
        await tab(page, 'Shell').click();
        await banner.waitFor();
        await page.unroute('**/*.js');
        await Promise.all([page.waitForEvent('load'), banner.getByRole('button', { name: 'Reload', exact: true }).click()]);
        await page.locator('.terminal-container .xterm').waitFor();
        assert.equal(await hash(page), `#!action=device&udid=${PIXEL}&view=shell`);
        assert.deepEqual(test.errors, []);
        console.log('PASS a tool tab whose code is gone offers Reload, which opens it');
    } finally {
        await test.context.close();
    }
}

/** A Files or Shell address for an iPhone: the reason under the shared header, and links through the router. */
async function toolAddressForIphone(browser) {
    const test = await start(browser, { hash: `action=device&udid=${IPHONE}&view=shell` });
    const { page } = test;
    try {
        await page.getByRole('heading', { name: 'Shell is not available for this device', exact: true }).waitFor();
        assert.equal(await page.locator('.kit-bar-back').getAttribute('aria-label'), 'Phones');
        assert.equal(await page.locator('nav.kit-tabs').count(), 0);
        assert.deepEqual(await page.locator('h1').evaluateAll((list) => list.map((h1) => h1.className)), ['kit-bar-name'], 'refused tool: one h1, the name in the bar');
        // Both actions of the page are the kit's buttons: Open screen, a link, is the primary one.
        assert.deepEqual(
            await page.locator('.tool-unavailable-actions > *').evaluateAll((list) => list.map((item) => `${item.tagName.toLowerCase()}.${item.className}`)),
            ['a.kit-button kit-button-primary', 'button.kit-button'],
            'refused tool: the kit buttons',
        );
        const links = await checkLinks(page, 'refused tool');
        assert.deepEqual(links.map((link) => [link.text, link.hash]), [['Open screen', `#!action=device&udid=${IPHONE}&view=screen`]]);
        const before = await entries(page);
        await page.getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        await quiet(page);
        assert.deepEqual(test.streams.map((stream) => stream.action), ['proxy-coredevice']);
        assert.deepEqual(test.opened.filter((code) => code === 'FSLS' || code === 'SHEL'), [], 'no tool channel for an iPhone');
        // Another view of the same phone, like a tab: the entry is replaced, so Back does not
        // lead to the refused page, from which Forward would start the iPhone again.
        assert.equal(await entries(page), before, 'Open screen adds no entry');
        await page.goBack().catch(() => undefined);
        assert.ok(!page.url().startsWith(BASE), `Back from the screen leaves the app (${page.url()})`);
        assert.equal(test.streams.length, 1);
        assert.deepEqual(test.errors, []);
        console.log('PASS a tool address for an iPhone is refused under the shared header; its screen link names the phone and the view and replaces the entry');
    } finally {
        await test.context.close();
    }
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch();
    try {
        for (const viewport of [PHONE, DESKTOP]) {
            for (const colorScheme of ['light', 'dark']) {
                await androidTabs(browser, viewport, colorScheme);
                await iphonePage(browser, viewport, colorScheme);
            }
            await screenControls(browser, viewport);
            await oneBackFromAnyTab(browser, viewport);
            await switchReplaces(browser, viewport);
        }
        await androidActionsSheet(browser);
        await playerChangeReplaces(browser);
        await focusFollowsTheTabs(browser);
        await reloadOfferOnATab(browser);
        await toolAddressForIphone(browser);
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
