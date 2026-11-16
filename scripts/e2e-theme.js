// node scripts/test-browser.js theme      (E2E_OUT=<dir> keeps screenshots)
// The theme option against fixture sockets: nothing reaches a phone. At 440x956 with touch and at
// 1440x900 with a mouse:
//   - Theme in the bar of the Phones page, after the bell and before Reload, opens the kit's menu
//     with System, Light and Dark as radio items, the one in use checked; a choice applies at
//     once, is kept in this browser, and the menu stays open;
//   - Dark chosen under a light system gives the Phones page, a phone's Settings sheet, Files and
//     the Notifications inbox the same computed styles as System under a dark system, and Light
//     under a dark system the same as System under a light one (every element and its ::before
//     and ::after, custom properties aside, as scripts/e2e-atlas.js reads them);
//   - the choice survives a reload and is there in the first frame: the page's background in the
//     first animation frame is the chosen theme's. Without public/theme.js that frame is in the
//     system's theme, and the app still applies the choice once it runs;
//   - System follows a change of the system's theme without a reload, and a choice does not;
//   - the theme-color in effect for each choice under each system theme;
//   - on a phone's screen with the stream open, a change of the system's theme and a choice made
//     in another tab change the page at once, open no socket and keep the mount node;
//   - with storage blocked the page works, follows the system, and a choice applies to that page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const { settleMotion } = require('./ui-motion');
// The one icon set, to know the Theme button by its icon.
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const { ICONS } = require('../src/app/ui/icons');

// Only through test-browser.js, which serves the build on a port of its own. Without it this
// would open streams on the live server.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js theme');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT;

const KEY = 'ws-scrcpy.theme';
const NOW = Date.UTC(2026, 2, 14, 10, 0, 0);
const PIXEL = 'THEME-PIXEL-0001';
const IPHONE = 'THEME-IPHONE-0001';
const ANDROID = {
    udid: PIXEL, state: 'device', pid: 123, interfaces: [], 'ro.product.model': 'Pixel 9', 'ro.product.manufacturer': 'Google',
    'ro.build.version.release': '16', 'ro.build.version.sdk': '36', 'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'on', 'device.awake': true, 'battery.level': 80, 'battery.charging': false,
};
// One iPhone, linked to Notifications, so no list of Setup waits for one that is not.
const IOS = {
    udid: IPHONE, name: 'Bench iPhone', model: 'iPhone 17 Pro Max', version: '27.2', state: 'Connected', paired: true, developerMode: true,
    session: 'ready', 'screen.power': 'on', 'device.locked': false, 'last.update.timestamp': NOW,
    unlockSchedule: { enabled: false, time: '03:00', hasPasscode: false, serverTimeZone: 'UTC' },
};
const SOURCES = [{ id: IPHONE, name: 'Bench iPhone', address: 'AA:BB:CC:DD:EE:01', apps: [], preview: true }];
const NOTIFICATIONS = [
    { key: 'chat', source: IPHONE, app: 'com.example.chat', appName: 'Messages', title: 'Coffee at four?', body: 'Meet me outside the station.', received: NOW - 34 * 60000, read: false, dismissed: false, active: true },
    { key: 'calendar', source: IPHONE, app: 'com.example.calendar', appName: 'Calendar', title: 'Design review', body: 'Starts in ten minutes.', received: NOW - 26 * 3600000, read: true, dismissed: false, active: true, canDismiss: true },
];
const ENCODER = 'c2.exynos.h264.encoder';
const STREAM_CONFIG = { bitrate: 3500000, maxFps: 60, maxSize: 1280, iFrameInterval: 10, videoCodec: 'h264', videoEncoder: ENCODER, audio: true, audioCodec: 'raw', audioSource: 'output' };
const ROOT = '/data/local/tmp';
const DIR = 0o40755;
const FILE = 0o100644;
const FOLDERS = { [ROOT]: [['photos', DIR], ['notes.txt', FILE], ['report.pdf', FILE]], [`${ROOT}/photos`]: [['holiday.jpg', FILE]] };

const TOUCH = { name: 'touch', width: 440, height: 956, mobile: true };
const MOUSE = { name: 'mouse', width: 1440, height: 900, mobile: false };
// The page's background, `--surface`, and the bar colour of each theme.
const SURFACE = { light: 'rgb(245, 246, 248)', dark: 'rgb(23, 25, 29)' };
// Behind a phone's screen the page is `--surface-sunken`.
const SUNKEN = { light: 'rgb(236, 238, 242)', dark: 'rgb(42, 46, 54)' };
const BAR = { light: '#f5f6f8', dark: '#17191d' };
const other = (scheme) => (scheme === 'dark' ? 'light' : 'dark');

function frame(type, id, data = Buffer.alloc(0)) {
    const body = Buffer.from(data);
    const packet = Buffer.alloc(5 + body.length);
    packet[0] = type;
    packet.writeUInt32LE(id, 1);
    body.copy(packet, 5);
    return packet;
}
function closeFrame(id, code) {
    const data = Buffer.alloc(6);
    data.writeUInt16LE(code);
    return frame(8, id, data);
}
function stat(mode) {
    const data = Buffer.alloc(16);
    data.write('STAT');
    data.writeUInt32LE(mode, 4);
    data.writeUInt32LE(1700000000, 12);
    return data;
}
function dent(name, mode) {
    const text = Buffer.from(name);
    const data = Buffer.alloc(20 + text.length);
    data.write('DENT');
    data.writeUInt32LE(mode, 4);
    data.writeUInt32LE(mode === FILE ? 4096 : 0, 8);
    data.writeUInt32LE(1700000000, 12);
    data.writeUInt32LE(text.length, 16);
    text.copy(data, 20);
    return data;
}

/** Answers every request and socket of one page with the fixture. `test.sockets` lists each socket it opened. */
async function serve(page, test) {
    page.on('pageerror', (error) => test.errors.push(error.message));
    await page.clock.setFixedTime(NOW);
    await page.route('**/api/notifications/**', (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const unread = { unread: 1, unreadBySource: { [IPHONE]: 1 } };
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
        test.sockets.push(action || 'list');
        if (action === 'proxy-adb') return void setTimeout(() => socket.send(initialStreamPacket()), 40);
        if (action === 'proxy-coredevice') return void setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 40);
        const channels = new Map();
        socket.onMessage((data) => {
            const packet = Buffer.from(data);
            if (packet.length < 5) return;
            const type = packet[0];
            const id = packet.readUInt32LE(1);
            const payload = packet.subarray(5);
            const body = payload.toString();
            const send = (message) => socket.send(frame(32, id, JSON.stringify(message)));
            if (type === 4) {
                const code = body.slice(0, 4);
                channels.set(id, code);
                if (code === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } });
                if (code === 'GTRC') send({ id: -1, type: 'devicelist', data: { id: 'android', name: 'Fixture host', list: [ANDROID] } });
                if (code === 'ATRC') send({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Fixture host', list: [IOS] } });
            } else if (type === 32 && channels.get(id) === 'GTRC' && body.startsWith('{')) {
                const command = JSON.parse(body);
                if (command.type === 'list_encoders') {
                    send({ id: command.id, type: command.type, data: { udid: command.data.udid, encoders: [{ videoCodec: 'h264', encoderName: ENCODER, hardware: 'hw' }], config: STREAM_CONFIG } });
                }
            } else if (type === 64 && channels.get(id) === 'FSLS') {
                const inner = payload[0];
                const channel = payload.readUInt32LE(1);
                const request = payload.subarray(5);
                if (inner !== 4) return;
                const reply = (answer) => socket.send(frame(64, id, frame(16, channel, answer)));
                const end = (code) => socket.send(frame(64, id, closeFrame(channel, code)));
                const command = request.subarray(0, 4).toString();
                const target = request.subarray(8, 8 + request.readUInt32LE(4)).toString();
                if (command === 'STAT') {
                    reply(stat(FOLDERS[target] || ['/', '/data', '/data/local'].includes(target) ? DIR : 0));
                    end(1000);
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
}

/**
 * A browser context with the system in `system`. `choice` is put in storage once for the tab, as
 * if it had been chosen earlier; `blocked` makes every access to storage throw. Every page records
 * what its first animation frame showed.
 */
async function start(browser, viewport, system, { choice, blocked = false } = {}) {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile,
        colorScheme: system, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'UTC', serviceWorkers: 'block',
    });
    if (choice) {
        await context.addInitScript(([key, value]) => {
            if (!sessionStorage.getItem(key)) {
                sessionStorage.setItem(key, 'seeded');
                localStorage.setItem(key, value);
            }
        }, [KEY, choice]);
    }
    if (blocked) {
        await context.addInitScript(() => {
            Object.defineProperty(window, 'localStorage', {
                configurable: true,
                get() {
                    throw new DOMException('The operation is insecure.', 'SecurityError');
                },
            });
        });
    }
    // The first frame: the page's background, the attribute and the scheme the browser drew with.
    await context.addInitScript(() => {
        requestAnimationFrame(() => {
            const root = document.documentElement;
            window.__firstFrame = {
                body: document.body ? getComputedStyle(document.body).backgroundColor : null,
                theme: root.getAttribute('data-theme'),
                scheme: getComputedStyle(root).colorScheme,
                styled: document.styleSheets.length > 0,
            };
        });
    });
    const page = await context.newPage();
    const test = { context, page, mobile: viewport.mobile, label: `${viewport.name} ${system}${choice ? ` ${choice} chosen` : ''}`, errors: [], sockets: [] };
    await serve(page, test);
    return test;
}

const card = (page, key) => page.locator(`article.device[data-device-key="${key}"]`);
const bar = (page) => page.locator('header.kit-bar.kit-bar-root');
const themeButton = (page) => bar(page).getByRole('button', { name: 'Theme', exact: true });
const themeMenu = (page) => page.getByRole('menu', { name: 'Theme', exact: true });
const press = (test, locator) => (test.mobile ? locator.tap() : locator.click());

async function phones(test) {
    await test.page.goto(BASE);
    await card(test.page, `android:${PIXEL}`).waitFor();
    await card(test.page, `ios:${IPHONE}`).waitFor();
    await settleMotion(test.page);
}

/** What the page shows now: the theme on the root, the page's background, and the theme-color in effect. */
function shown(page) {
    return page.evaluate(() => {
        const bars = [...document.querySelectorAll('meta[name="theme-color"]')];
        const bar = bars.find((meta) => !meta.media || matchMedia(meta.media).matches);
        return {
            theme: document.documentElement.getAttribute('data-theme'),
            background: getComputedStyle(document.body).backgroundColor,
            scheme: getComputedStyle(document.documentElement).colorScheme,
            bar: bar ? bar.content : null,
        };
    });
}
const looks = (scheme, fill = SURFACE) => ({ background: fill[scheme], scheme, bar: BAR[scheme] });
async function expectLooks(page, scheme, theme, what, fill = SURFACE) {
    // A colour that changed is read once its transition (0.01ms with motion reduced) has ended.
    await settleMotion(page);
    const now = await shown(page);
    assert.deepEqual(now, { theme, ...looks(scheme, fill) }, what);
}

/** The menu's items as they are now: name and whether it is checked. */
function items(page) {
    return themeMenu(page).locator('.kit-menu-item').evaluateAll((list) => list.map((item) => [item.getAttribute('role'), item.textContent, item.getAttribute('aria-checked')]));
}
const expectedItems = (checked) => ['System', 'Light', 'Dark'].map((name) => ['menuitemradio', name, String(name === checked)]);

/** Chooses `name` in the Theme menu of the Phones page, opening the menu first if it is closed. */
async function choose(test, name) {
    const { page } = test;
    if (!(await themeMenu(page).isVisible())) {
        await press(test, themeButton(page));
        await themeMenu(page).waitFor();
        await settleMotion(page);
    }
    await press(test, themeMenu(page).getByRole('menuitemradio', { name, exact: true }));
}

/** The bar's Theme button and its menu; each choice at once, kept, and the menu open after it. */
async function menu(browser, viewport) {
    const test = await start(browser, viewport, 'light');
    const { page } = test;
    try {
        await phones(test);
        const controls = await bar(page).evaluate((header) =>
            [...header.children].filter((child) => child.matches('a, button')).map((child) => child.getAttribute('aria-label')));
        assert.deepEqual(controls, ['Notifications, 1 unread', 'Theme', 'Reload'], `${test.label}: Theme after the bell and before Reload`);
        const button = themeButton(page);
        assert.deepEqual(
            await button.evaluate((element) => ({
                kit: element.matches('button.kit-icon-button'), popup: element.getAttribute('aria-haspopup'), expanded: element.getAttribute('aria-expanded'),
                title: element.getAttribute('title'), icon: element.querySelector('svg.kit-icon path')?.getAttribute('d'),
            })),
            { kit: true, popup: 'menu', expanded: 'false', title: 'Theme', icon: ICONS.theme },
            `${test.label}: a kit icon button with the theme icon that opens a menu`,
        );
        const box = await button.boundingBox();
        assert.ok(box.width === 44 && box.height === 44, `${test.label}: a 44px target (${box.width}x${box.height})`);
        await expectLooks(page, 'light', null, `${test.label}: System by default, no attribute`);

        await press(test, button);
        const list = themeMenu(page);
        await list.waitFor();
        await settleMotion(page);
        assert.equal(await list.evaluate((element) => element.matches('.kit-menu:popover-open')), true, `${test.label}: the kit's menu in the top layer`);
        assert.equal(await button.getAttribute('aria-expanded'), 'true');
        assert.deepEqual(await items(page), expectedItems('System'), `${test.label}: three radio items, System checked`);
        if (OUT) await page.screenshot({ path: path.join(OUT, `theme-menu-${viewport.name}-light.png`) });

        for (const [name, theme, scheme] of [['Dark', 'dark', 'dark'], ['Light', 'light', 'light'], ['System', null, 'light']]) {
            await choose(test, name);
            await settleMotion(page);
            await expectLooks(page, scheme, theme, `${test.label}: ${name} at once`);
            assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), theme, `${test.label}: ${name} kept in this browser`);
            assert.equal(await list.isVisible(), true, `${test.label}: the menu stays open after ${name}`);
            assert.deepEqual(await items(page), expectedItems(name), `${test.label}: ${name} checked`);
            if (OUT && name === 'Dark') await page.screenshot({ path: path.join(OUT, `theme-menu-${viewport.name}-dark.png`) });
        }
        await page.keyboard.press('Escape');
        await list.waitFor({ state: 'hidden' });
        assert.equal(await button.getAttribute('aria-expanded'), 'false');
        assert.equal(await button.evaluate((element) => element === document.activeElement), true, `${test.label}: Escape returns focus to Theme`);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${test.label}: Theme in the bar, its menu, and each choice at once and kept`);
    } finally {
        await test.context.close();
    }
}

/**
 * A hash-free record of what the browser computed for each element of the page, the root
 * included, and for its ::before and ::after, custom properties aside: the atlas's reading
 * (scripts/e2e-atlas.js), in full so that a difference can be named.
 */
function computedStyles() {
    const read = (element, pseudo) => {
        const style = getComputedStyle(element, pseudo);
        if (pseudo && (style.content === 'none' || style.content === 'normal')) return '';
        return Array.from(style).filter((property) => !property.startsWith('--')).sort()
            .map((property) => `${property}:${style.getPropertyValue(property)}`).join(';');
    };
    const rows = [];
    for (const element of [document.documentElement, document.body, ...document.body.querySelectorAll('*')]) {
        if (['SCRIPT', 'STYLE', 'TEMPLATE'].includes(element.tagName)) continue;
        if (element.classList.contains('xterm-scroll-area')) continue;
        const classes = typeof element.className === 'string' ? element.className : element.getAttribute('class') || '';
        const name = element.tagName.toLowerCase() + classes.split(/\s+/).filter(Boolean).map((c) => `.${c}`).join('');
        rows.push([name, read(element), read(element, '::before'), read(element, '::after')]);
    }
    return rows;
}

/** The first element whose computed style differs between two records, and how. */
function difference(before, after) {
    if (before.length !== after.length) return `${before.length} elements against ${after.length}`;
    for (let index = 0; index < before.length; index++) {
        if (before[index].join('\n') === after[index].join('\n')) continue;
        const [name] = before[index];
        for (const part of [1, 2, 3]) {
            const a = new Map(before[index][part].split(';').map((entry) => entry.split(/:(.*)/s).slice(0, 2)));
            const b = new Map(after[index][part].split(';').map((entry) => entry.split(/:(.*)/s).slice(0, 2)));
            const changed = [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key));
            if (changed.length) return `${name}${['', '', '::before', '::after'][part]}: ${changed.slice(0, 6).map((key) => `${key} ${a.get(key)} / ${b.get(key)}`).join(', ')}`;
        }
        return `${name}: ${before[index][0]} / ${after[index][0]}`;
    }
    return '';
}

/** The four pages of the comparison, each at rest: the Phones page, a phone's Settings, Files and the inbox. */
async function record(test) {
    const { page } = test;
    const states = {};
    await phones(test);
    states.phones = await page.evaluate(computedStyles);
    await press(test, card(page, `android:${PIXEL}`).locator('button.stream-settings-button'));
    const sheet = page.locator('dialog.kit-sheet[open]');
    await sheet.waitFor();
    await sheet.getByText(ENCODER).first().waitFor({ state: 'attached' });
    await settleMotion(page);
    states.settings = await page.evaluate(computedStyles);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    await page.goto(`${BASE}#!action=device&udid=${PIXEL}&view=files&path=${encodeURIComponent(ROOT)}`);
    await page.locator('.file-explorer[data-listing="ready"] .fx-row[data-name="notes.txt"]').waitFor();
    await settleMotion(page);
    states.files = await page.evaluate(computedStyles);
    await page.goto(`${BASE}#!action=notifications&source=${IPHONE}`);
    await page.locator('article.notification-history-item').first().waitFor();
    await settleMotion(page);
    states.inbox = await page.evaluate(computedStyles);
    assert.deepEqual(test.errors, [], `${test.label}: no page error`);
    return states;
}

/** A choice against the other system theme gives what System gives under the chosen one. */
async function sameStyles(browser, viewport) {
    for (const scheme of ['dark', 'light']) {
        const chosen = await start(browser, viewport, other(scheme), { choice: scheme });
        const system = await start(browser, viewport, scheme);
        try {
            const a = await record(chosen);
            const b = await record(system);
            for (const state of Object.keys(a)) {
                assert.ok(a[state].length > 50, `${chosen.label}: ${state} is on screen`);
                assert.equal(difference(a[state], b[state]), '', `${viewport.name}: ${state} with ${scheme} chosen under a ${other(scheme)} system against System under a ${scheme} one`);
            }
            await expectLooks(chosen.page, scheme, scheme, `${chosen.label}: in ${scheme}`);
            console.log(`PASS ${viewport.name}: ${scheme} chosen under a ${other(scheme)} system computes the same styles as System under a ${scheme} one (Phones, Settings, Files, inbox)`);
        } finally {
            await chosen.context.close();
            await system.context.close();
        }
    }
}

/** The choice survives a reload and is in the first frame; without public/theme.js it is not, until the app runs. */
async function firstFrame(browser, viewport) {
    for (const scheme of ['dark', 'light']) {
        const test = await start(browser, viewport, other(scheme));
        const { page } = test;
        try {
            await phones(test);
            await choose(test, scheme === 'dark' ? 'Dark' : 'Light');
            // The app's bundle comes late, so the first frame is drawn before the app runs and
            // only public/theme.js can have put the choice on it.
            await page.route('**/bundle.js*', async (route) => {
                await new Promise((resolve) => setTimeout(resolve, 600));
                await route.continue();
            });
            await page.reload();
            await card(page, `android:${PIXEL}`).waitFor();
            assert.deepEqual(
                await page.evaluate(() => window.__firstFrame),
                { body: SURFACE[scheme], theme: scheme, scheme, styled: true },
                `${test.label}: ${scheme} chosen is in the first frame after a reload`,
            );
            await expectLooks(page, scheme, scheme, `${test.label}: ${scheme} after the reload`);

            // The check sees a flash: the same reload without the boot script starts in the
            // system's theme. The app applies the choice once it runs.
            await page.route('**/theme.js*', (route) => route.fulfill({ status: 404, body: '' }));
            await page.reload();
            await card(page, `android:${PIXEL}`).waitFor();
            assert.deepEqual(
                await page.evaluate(() => window.__firstFrame),
                { body: SURFACE[other(scheme)], theme: null, scheme: other(scheme), styled: true },
                `${test.label}: without public/theme.js the first frame is in the system's theme`,
            );
            await expectLooks(page, scheme, scheme, `${test.label}: and the app applies ${scheme} when it runs`);
            await page.unroute('**/theme.js*');
            await page.unroute('**/bundle.js*');
            assert.deepEqual(test.errors, []);
            console.log(`PASS ${test.label}: ${scheme} chosen survives a reload and is in the first frame`);
        } finally {
            await test.context.close();
        }
    }
}

/** System follows the system's theme at once; a choice does not; the theme-color for each. */
async function followsSystem(browser, viewport) {
    const test = await start(browser, viewport, 'light');
    const { page } = test;
    try {
        await phones(test);
        for (const [name, theme] of [['System', null], ['Light', 'light'], ['Dark', 'dark']]) {
            await choose(test, name);
            for (const system of ['dark', 'light']) {
                await page.emulateMedia({ colorScheme: system });
                await settleMotion(page);
                await expectLooks(page, theme || system, theme, `${viewport.name}: ${name} under a ${system} system, without a reload`);
            }
        }
        await choose(test, 'System');
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${viewport.name}: System follows the system at once, Light and Dark do not; the theme-color of each`);
    } finally {
        await test.context.close();
    }
}

/** A phone's screen with its stream open: a theme change is styles only. */
async function streamKept(browser, viewport) {
    const test = await start(browser, viewport, 'light');
    const { page } = test;
    const phonesTab = { ...test, page: await test.context.newPage(), errors: [], sockets: [] };
    try {
        await page.goto(`${BASE}#!action=device&udid=${PIXEL}&view=screen`);
        await page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.includes('Connected'));
        await page.waitForFunction(() => document.querySelector('.stream-mount canvas.touch-layer')?.hasAttribute('width'));
        await settleMotion(page);
        await page.evaluate(() => {
            window.__mount = document.querySelector('.stream-mount');
        });
        const kept = async (what) => {
            await settleMotion(page);
            assert.deepEqual(test.sockets.filter((action) => action === 'proxy-adb'), ['proxy-adb'], `${test.label}: one stream socket after ${what}`);
            assert.equal(test.sockets.length, socketsAtOpen, `${test.label}: no socket opened by ${what}`);
            assert.equal(await page.evaluate(() => window.__mount === document.querySelector('.stream-mount') && window.__mount.isConnected), true, `${test.label}: the same mount node after ${what}`);
        };
        const socketsAtOpen = test.sockets.length;
        await expectLooks(page, 'light', null, `${test.label}: the screen in the system's theme`, SUNKEN);
        await page.emulateMedia({ colorScheme: 'dark' });
        await expectLooks(page, 'dark', null, `${test.label}: the screen follows the system at once`, SUNKEN);
        await kept('a change of the system theme');
        await page.emulateMedia({ colorScheme: 'light' });
        await kept('the change back');

        // The choice made on the Phones page of another tab reaches the screen at once.
        await serve(phonesTab.page, phonesTab);
        await phones(phonesTab);
        await choose(phonesTab, 'Dark');
        await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
        await expectLooks(page, 'dark', 'dark', `${test.label}: Dark chosen in another tab`, SUNKEN);
        await kept('Dark chosen in another tab');
        await choose(phonesTab, 'System');
        await page.waitForFunction(() => !document.documentElement.hasAttribute('data-theme'));
        await expectLooks(page, 'light', null, `${test.label}: System chosen in another tab`, SUNKEN);
        await kept('System chosen in another tab');
        assert.deepEqual([...test.errors, ...phonesTab.errors], []);
        console.log(`PASS ${test.label}: a theme change on a phone's screen opens no socket and keeps the mount node`);
    } finally {
        await test.context.close();
    }
}

/** Storage that throws on every access: the page works, follows the system, and takes a choice for itself. */
async function blockedStorage(browser, viewport) {
    for (const system of ['dark', 'light']) {
        const test = await start(browser, viewport, system, { blocked: true });
        const { page } = test;
        try {
            await phones(test);
            assert.deepEqual(await page.evaluate(() => window.__firstFrame), { body: SURFACE[system], theme: null, scheme: system, styled: true }, `${test.label}: the first frame follows the system`);
            await expectLooks(page, system, null, `${test.label}: storage blocked follows the system`);
            await choose(test, other(system) === 'dark' ? 'Dark' : 'Light');
            await expectLooks(page, other(system), other(system), `${test.label}: a choice applies to this page`);
            assert.deepEqual(await items(page), expectedItems(other(system) === 'dark' ? 'Dark' : 'Light'));
            await page.keyboard.press('Escape');
            await page.reload();
            await card(page, `android:${PIXEL}`).waitFor();
            await expectLooks(page, system, null, `${test.label}: and is not kept`);
            assert.deepEqual(test.errors, [], `${test.label}: nothing throws`);
            console.log(`PASS ${test.label}: storage blocked: the page works and follows the system`);
        } finally {
            await test.context.close();
        }
    }
}

async function main() {
    if (OUT) fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        for (const viewport of [TOUCH, MOUSE]) {
            await menu(browser, viewport);
            await sameStyles(browser, viewport);
            await firstFrame(browser, viewport);
            await followsSystem(browser, viewport);
            await streamKept(browser, viewport);
            await blockedStorage(browser, viewport);
        }
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
