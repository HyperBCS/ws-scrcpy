// ATLAS_OUT=/tmp/atlas-after ATLAS_COMPARE=/tmp/atlas-before node scripts/test-browser.js atlas
// A picture of every page and sheet, for changes that must not be visible. Each state is taken
// in both themes at 390x844 (touch) and 1440x900 (mouse), with motion reduced and the clock,
// zone and locale fixed. A state writes two files to ATLAS_OUT (a temporary directory, removed
// at the end, when it is not set): the screenshot, and one hash per element of what the browser
// computed for its style, custom properties aside. The hashes also cover what is hidden or
// scrolled out of view.
//   ATLAS_COMPARE=<dir>  fail on any pixel or computed style that differs from the atlas in <dir>.
//   ATLAS_ONLY=<regexp>  take only the states whose file name matches.
//   ATLAS_STYLES=full    write every computed property instead of a hash, to read a difference.
// Without ATLAS_COMPARE the suite fails when a state cannot be reached, a page throws, or a
// state does not come to rest.
// To compare two builds: take the atlas of the first into a directory, build the second, and
// run again with ATLAS_COMPARE set to that directory. Two runs of one build match exactly.
// Every socket is a fixture. No device, adb or pymobiledevice3 is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const { settleMotion } = require('./ui-motion');

// Only through test-browser.js, which serves the build on a port of its own. Without it this
// would open streams on the live server.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js atlas');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.ATLAS_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-atlas-'));
const COMPARE = process.env.ATLAS_COMPARE;
const ONLY = process.env.ATLAS_ONLY ? new RegExp(process.env.ATLAS_ONLY) : undefined;
const FULL_STYLES = process.env.ATLAS_STYLES === 'full';

// The clock of every page. Dates on the pages are fixed with it.
const NOW = Date.UTC(2026, 2, 14, 10, 0, 0);
const PIXEL = 'ATLAS-PIXEL-0001';
const PIXEL_2 = 'ATLAS-PIXEL-0002';
const PIXEL_3 = 'ATLAS-PIXEL-0003';
const IPHONE = 'ATLAS-IPHONE-0001';
const IPHONE_2 = 'ATLAS-IPHONE-0002';
// A phone that is in no list.
const MISSING = 'ATLAS-MISSING-0001';
const android = (udid, model, extra = {}) => ({
    udid, state: 'device', pid: 123, interfaces: [], 'ro.product.model': model, 'ro.product.manufacturer': 'Google',
    'ro.build.version.release': '16', 'ro.build.version.sdk': '36', 'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'on', 'device.awake': true, 'battery.level': 80, 'battery.charging': false, ...extra,
});
// The first Android phone shows its lock screen, so its page offers the Unlock sheet. The third
// has its screen off, so its card shows the asleep banner.
const ANDROIDS = [
    android(PIXEL, 'Pixel 9', { 'keyguard.showing': true, 'keyguard.occluded': false, 'device.locked': true }),
    android(PIXEL_2, 'Pixel 8', { 'battery.level': 35, 'battery.charging': true }),
    android(PIXEL_3, 'Pixel 7', { 'screen.power': 'off', 'device.awake': false }),
];
const iphone = (udid, name, unlockSchedule) => ({
    udid, name, model: 'iPhone 13 Pro Max', version: '27.2', state: 'Connected', paired: true, developerMode: true,
    session: 'ready', 'screen.power': 'on', 'device.locked': false, 'last.update.timestamp': NOW, unlockSchedule,
});
// The second iPhone has a schedule that cannot run, so its card shows the problem line.
const IPHONES = [
    iphone(IPHONE, 'Bench iPhone', { enabled: true, time: '03:00', timeZone: 'UTC', serverTimeZone: 'UTC', hasPasscode: true, nextRunAt: NOW + 5 * 3600000, lastUnlockedAt: NOW - 7 * 3600000 }),
    iphone(IPHONE_2, 'Spare iPhone', { enabled: true, time: '03:00', timeZone: 'UTC', serverTimeZone: 'UTC', hasPasscode: false }),
];
const SOURCES = [{ id: IPHONE, name: 'Bench iPhone', address: 'AA:BB:CC:DD:EE:01', apps: [], preview: true }];
const NOTIFICATIONS = [
    { key: 'chat', source: IPHONE, app: 'com.example.chat', appName: 'Messages', title: 'Coffee at four?', body: 'Meet me outside the station.', received: NOW - 34 * 60000, read: false, dismissed: false, active: true },
    { key: 'calendar', source: IPHONE, app: 'com.example.calendar', appName: 'Calendar', title: 'Design review', body: 'Starts in ten minutes.', received: NOW - 26 * 3600000, read: true, dismissed: false, active: true, canDismiss: true, negativeActionLabel: 'Decline' },
];
const ENCODER = 'c2.exynos.h264.encoder';
const STREAM_CONFIG = { bitrate: 3500000, maxFps: 60, maxSize: 1280, iFrameInterval: 10, videoCodec: 'h264', videoEncoder: ENCODER, audio: true, audioCodec: 'raw', audioSource: 'output' };

const ROOT = '/data/local/tmp';
const DIR = 0o40755;
const FILE = 0o100644;
// The phone refuses to list `denied`.
const DENIED = `${ROOT}/denied`;
const FOLDERS = { [ROOT]: [['denied', DIR], ['photos', DIR], ['notes.txt', FILE], ['report.pdf', FILE]], [`${ROOT}/photos`]: [['holiday.jpg', FILE]], [DENIED]: [] };

const VIEWPORTS = [
    { name: 'phone', width: 390, height: 844, mobile: true },
    { name: 'desktop', width: 1440, height: 900, mobile: false },
];
const THEMES = ['light', 'dark'];
// One raster thread on the CPU. With the defaults, two runs of one build differed by one or two
// levels of a channel on a few pixels of rounded corners.
const RASTER_ARGS = ['--disable-gpu', '--num-raster-threads=1', '--disable-partial-raster', '--force-color-profile=srgb'];

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
function fail(message) {
    const text = Buffer.from(message);
    const data = Buffer.alloc(8 + text.length);
    data.write('FAIL'); data.writeUInt32LE(text.length, 4); text.copy(data, 8);
    return data;
}
function dent(name, mode) {
    const text = Buffer.from(name);
    const data = Buffer.alloc(20 + text.length);
    data.write('DENT'); data.writeUInt32LE(mode, 4); data.writeUInt32LE(mode === FILE ? 4096 : 0, 8);
    data.writeUInt32LE(1700000000, 12); data.writeUInt32LE(text.length, 16); text.copy(data, 20);
    return data;
}

/** One browser context for a viewport and a theme, with every request answered by a fixture. */
async function start(browser, viewport, theme) {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile,
        colorScheme: theme, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'UTC', serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const test = { context, page, mobile: viewport.mobile, label: `${viewport.name}--${theme}`, errors: [], shots: 0 };
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
        if (action === 'proxy-adb') return void setTimeout(() => socket.send(initialStreamPacket()), 40);
        if (action === 'proxy-coredevice') return void setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 40);
        const channels = new Map();
        socket.onMessage((data) => {
            const packet = Buffer.from(data);
            if (packet.length < 5) return;
            const type = packet[0], id = packet.readUInt32LE(1), payload = packet.subarray(5), body = payload.toString();
            const send = (message) => socket.send(frame(32, id, JSON.stringify(message)));
            if (type === 4) {
                const code = body.slice(0, 4);
                channels.set(id, code);
                if (code === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } });
                if (code === 'GTRC') send({ id: -1, type: 'devicelist', data: { id: 'android', name: 'Fixture host', list: ANDROIDS } });
                if (code === 'ATRC') send({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Fixture host', list: IPHONES } });
            } else if (type === 32 && channels.get(id) === 'SHEL' && body.startsWith('{')) {
                if (JSON.parse(body).data?.type === 'start') socket.send(frame(32, id, 'Fixture terminal ready\r\n$ '));
            } else if (type === 32 && channels.get(id) === 'GTRC' && body.startsWith('{')) {
                const command = JSON.parse(body);
                if (command.type === 'list_encoders') {
                    send({ id: command.id, type: command.type, data: { udid: command.data.udid, encoders: [{ videoCodec: 'h264', encoderName: ENCODER, hardware: 'hw' }], config: STREAM_CONFIG } });
                }
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
                } else if (command === 'LIST' && target === DENIED) {
                    reply(fail('Permission denied by fixture'));
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
    return test;
}

const card = (page, key) => page.locator(`article.device[data-device-key="${key}"]`);
const sheet = (page) => page.locator('.bottom-sheet-root.open');
const sheetTitled = (page, title) => sheet(page).filter({ has: page.locator('.bottom-sheet-title', { hasText: title }) });
const tab = (page, name) => page.locator('.tool-tabs').getByRole('button', { name, exact: true });
const connected = (page) => page.waitForFunction(() => document.querySelector('.stream-header-status')?.textContent.includes('Connected'));
const screenOf = (udid) => `#!action=device&udid=${udid}&view=screen`;

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

/** Closes what is open with Escape and waits until it is gone. */
async function dismiss(test, shown) {
    await test.page.keyboard.press('Escape');
    await shown.waitFor({ state: 'hidden' });
    await settleMotion(test.page);
}

/**
 * Takes the confirm prompt inside `container` as the state `name`, then cancels it. The prompt
 * holds its action back for a moment after it opens; the picture is taken once it is ready.
 */
async function shootPrompt(test, container, name) {
    const prompt = container.locator('.confirm-prompt, .kit-confirm');
    await prompt.waitFor();
    await prompt.locator('.confirm-prompt-button:not([aria-disabled]), .kit-confirm-actions > .kit-button:not([aria-disabled])').nth(1).waitFor();
    await shoot(test, name);
    await test.page.keyboard.press('Escape');
    await prompt.waitFor({ state: 'detached' });
    await settleMotion(test.page);
}

/**
 * A hash of every computed property, custom properties aside, of each element of the body and of
 * its ::before and ::after, in document order. With `full`, the properties themselves.
 */
function computedStyles(full) {
    const digest = (text) => {
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
        return (hash >>> 0).toString(16);
    };
    const read = (element, pseudo) => {
        const style = getComputedStyle(element, pseudo);
        if (pseudo && (style.content === 'none' || style.content === 'normal')) return undefined;
        // Custom properties are left out: one shows only through a property that uses it, which
        // is listed, and a token that is added and not yet used changes nothing on the page.
        const names = Array.from(style).filter((property) => !property.startsWith('--')).sort();
        const text = names.map((property) => `${property}:${style.getPropertyValue(property)};`).join('');
        return full ? text : digest(text);
    };
    const rows = [];
    for (const element of [document.body, ...document.body.querySelectorAll('*')]) {
        if (['SCRIPT', 'STYLE', 'TEMPLATE'].includes(element.tagName)) continue;
        // The one element left out. The terminal's script sets its height, to 0 in some runs of
        // one build and to the height of the rows in others. It is never painted, and no rule
        // of the app names it.
        if (element.classList.contains('xterm-scroll-area')) continue;
        const classes = typeof element.className === 'string' ? element.className : element.getAttribute('class') || '';
        // An id from Preact's useId (`P0-11`) counts the components drawn before it, which differs
        // from run to run, so it does not name the element.
        const id = element.id && !/^P\d+-\d+$/.test(element.id) ? `#${element.id}` : '';
        const name = element.tagName.toLowerCase() + id + classes.split(/\s+/).filter(Boolean).map((c) => `.${c}`).join('');
        rows.push([name, read(element), read(element, '::before'), read(element, '::after')].map((value) => value || ''));
    }
    return rows;
}

/** Takes the state `name` once the page is still. A state left out by ATLAS_ONLY is skipped. */
async function shoot(test, name) {
    const file = `${name}--${test.label}`;
    if (ONLY && !ONLY.test(file)) return;
    const { page } = test;
    await settleMotion(page);
    const take = () => page.screenshot({ animations: 'disabled', caret: 'hide' });
    let png = await take();
    // The picture is the page at rest: two in a row are the same.
    for (let attempt = 0; ; attempt++) {
        await page.waitForTimeout(100);
        const again = await take();
        if (again.equals(png)) break;
        assert.ok(attempt < 5, `${file}: the page does not come to rest`);
        png = again;
    }
    fs.writeFileSync(path.join(OUT, `${file}.png`), png);
    fs.writeFileSync(path.join(OUT, `${file}.json`), JSON.stringify(await page.evaluate(computedStyles, FULL_STYLES)));
    test.shots++;
}

/** The list, with a card's details open and with each phone's settings sheet. */
async function listStates(test) {
    const { page } = test;
    await page.goto(BASE);
    await card(page, `android:${PIXEL}`).waitFor();
    await card(page, `ios:${IPHONE}`).waitFor();
    await card(page, `ios:${IPHONE_2}`).locator('.device-problem .device-unlock-schedule.problem').waitFor();
    await card(page, `android:${PIXEL_3}`).locator('.device-asleep-banner .wake-button').waitFor();
    await shoot(test, 'list');

    await press(test, card(page, `android:${PIXEL_2}`).locator('.device-details > summary'));
    await press(test, card(page, `ios:${IPHONE}`).locator('.device-details > summary'));
    await card(page, `ios:${IPHONE}`).locator('.device-trouble-heading').waitFor();
    await shoot(test, 'list-details');

    // A question on a card before an action that ends the stream.
    await press(test, card(page, `android:${PIXEL_2}`).getByRole('button', { name: 'Stop stream service', exact: true }));
    await shootPrompt(test, card(page, `android:${PIXEL_2}`), 'list-confirm');

    await press(test, card(page, `android:${PIXEL_2}`).locator('button.stream-settings-button'));
    await sheetTitled(page, /^Stream settings$/).waitFor();
    await sheet(page).getByText(ENCODER).first().waitFor({ state: 'attached' });
    await shoot(test, 'list-android-settings');
    await dismiss(test, sheet(page));

    await press(test, card(page, `ios:${IPHONE}`).locator('button[title="Scheduled unlock"]'));
    await sheetTitled(page, /^Scheduled unlock$/).waitFor();
    await shoot(test, 'list-iphone-settings');
    await dismiss(test, sheet(page));
}

/** The sheets and overlays of a phone's screen. They are the same components for both kinds. */
async function screenOverlays(test, kind) {
    const { page } = test;
    if (test.mobile) {
        await press(test, page.locator('.floating-toolbar-fab'));
        await page.locator('.floating-toolbar.open').waitFor();
        await shoot(test, `${kind}-controls`);
        await dismiss(test, page.locator('.floating-toolbar.open'));
    }
    await control(test, 'Actions');
    await sheetTitled(page, /^Actions$/).waitFor();
    await shoot(test, `${kind}-actions`);
    // Unlock takes the place of Actions.
    await press(test, sheet(page).getByRole('button', { name: 'Unlock', exact: true }));
    await sheetTitled(page, /^Unlock/).waitFor();
    await shoot(test, `${kind}-unlock`);
    await dismiss(test, sheet(page));

    await control(test, 'Settings');
    await sheetTitled(page, kind === 'android' ? /^Stream settings$/ : /^Scheduled unlock$/).waitFor();
    if (kind === 'android') await sheet(page).getByText(ENCODER).first().waitFor({ state: 'attached' });
    await shoot(test, `${kind}-settings`);
    await dismiss(test, sheet(page));

    await press(test, page.locator('.stream-header-switch'));
    await sheetTitled(page, /Switch/).waitFor();
    await shoot(test, `${kind}-switcher`);
    await dismiss(test, sheet(page));

    await control(test, 'Type text');
    await page.locator('.live-text-overlay').waitFor();
    await shoot(test, `${kind}-type-text`);
    await dismiss(test, page.locator('.live-text-overlay'));
}

/** An Android phone: Screen with its overlays, Files with a menu and a dialog, and Shell. */
async function androidStates(test) {
    const { page } = test;
    await page.goto(BASE + screenOf(PIXEL));
    await connected(page);
    await page.locator('.lock-screen-notice').waitFor();
    await shoot(test, 'android-screen');
    await screenOverlays(test, 'android');

    await tab(page, 'Files').click();
    await page.locator('.file-explorer[data-listing="ready"] .fx-row[data-name="notes.txt"]').waitFor();
    await shoot(test, 'android-files');
    const menu = page.locator('.fx-menu:not([hidden])');
    const openMenu = async () => {
        await press(test, page.getByRole('button', { name: test.mobile ? 'Actions' : 'View', exact: true }));
        await menu.waitFor();
    };
    await openMenu();
    await shoot(test, 'android-files-menu');
    // The layout choices: in the View menu on a desktop, one step further on a phone.
    if (test.mobile) {
        await press(test, page.getByRole('menuitem', { name: 'View options…', exact: true }));
        await page.getByRole('menuitemradio', { name: 'Tiles', exact: true }).waitFor();
        await shoot(test, 'android-files-view-menu');
    }
    await press(test, page.getByRole('menuitemradio', { name: 'Tiles', exact: true }));
    await page.locator('.file-explorer[data-view="tiles"][data-listing="ready"]').waitFor();
    if (await menu.count()) await dismiss(test, menu);
    await shoot(test, 'android-files-tiles');

    if (test.mobile) {
        await openMenu();
        await press(test, page.getByRole('menuitem', { name: 'New folder', exact: true }));
    } else {
        await press(test, page.locator('.fx-commands').getByRole('button', { name: 'New folder', exact: true }));
    }
    await page.locator('.fx-dialog[open]').waitFor();
    await shoot(test, 'android-files-dialog');
    await dismiss(test, page.locator('.fx-dialog[open]'));

    // A folder the phone refuses to list.
    const denied = page.locator('.fx-row[data-name="denied"] .entry-name a');
    if (test.mobile) await denied.click();
    else await denied.dblclick();
    await page.locator('.fx-failed-box').waitFor();
    await shoot(test, 'android-files-failed');

    await tab(page, 'Shell').click();
    await page.locator('.tool-view-shell:not([hidden])').waitFor();
    await page.waitForFunction(() => document.querySelector('.terminal-container .xterm-rows')?.innerText.includes('Fixture terminal ready'));
    await shoot(test, 'android-shell');
}

/** An iPhone's screen with its overlays. */
async function iphoneStates(test) {
    const { page } = test;
    await page.goto(BASE + screenOf(IPHONE));
    await connected(page);
    await shoot(test, 'iphone-screen');
    await screenOverlays(test, 'iphone');
}

/** The pages a phone's address can lead to besides its tools, and a screen that is off. */
async function otherStates(test) {
    const { page } = test;
    await page.goto(`${BASE}#!action=device&udid=${IPHONE}&view=shell`);
    await page.getByRole('heading', { name: 'Shell is not available for this device', exact: true }).waitFor();
    await shoot(test, 'tool-unavailable');

    await page.goto(`${BASE}#!action=device&udid=${MISSING}&view=screen`);
    await page.getByRole('heading', { name: 'This phone is not connected', exact: true }).waitFor();
    await shoot(test, 'phone-not-listed');

    await page.goto(BASE + screenOf(PIXEL_3));
    await connected(page);
    await page.locator('.sleep-overlay .sleep-overlay-button').waitFor();
    await shoot(test, 'android-asleep');
}

/** Notifications: the inbox, the sheets it opens, and Setup. */
async function notificationStates(test) {
    const { page } = test;
    const dialog = page.locator('dialog.kit-sheet[open]');
    await page.goto(`${BASE}#!action=notifications&source=${IPHONE}`);
    await page.locator('article.notification-history-item').first().waitFor();
    await shoot(test, 'notifications-inbox');

    for (const [state, name] of [['notifications-card-actions', 'Actions for Design review'], ['notifications-page-actions', 'Notification actions'], ['notifications-filters', /^Filters/]]) {
        await press(test, page.getByRole('button', { name, exact: true }));
        await dialog.waitFor();
        await shoot(test, state);
        if (state === 'notifications-card-actions') {
            // An action on the phone asks first, inside the sheet.
            await press(test, dialog.getByRole('button', { name: 'Decline on iPhone', exact: true }));
            await shootPrompt(test, dialog, 'notifications-confirm');
        }
        await dismiss(test, dialog);
    }

    // Archive answers with a notice at the foot of the page. It is closed before the next state:
    // it would leave by itself after a time that no picture should depend on.
    await press(test, page.getByRole('button', { name: 'Actions for Design review', exact: true }));
    await dialog.waitFor();
    await settleMotion(page);
    await press(test, dialog.getByRole('button', { name: 'Archive', exact: true }));
    const toast = page.locator('.kit-toast');
    await toast.first().waitFor();
    await dialog.waitFor({ state: 'hidden' });
    await shoot(test, 'notifications-toast');
    while (await toast.count()) {
        await press(test, toast.first().locator('.kit-toast-close'));
        await settleMotion(page);
    }

    await press(test, page.getByRole('radio', { name: 'Setup & delivery', exact: true }));
    await page.getByRole('heading', { name: 'Send from an iPhone', exact: true }).waitFor();
    await shoot(test, 'notifications-setup');
    await press(test, page.locator('summary').filter({ hasText: 'Settings for Bench iPhone' }));
    await page.getByText('Comma-separated. Leave empty for all apps.').waitFor({ state: 'attached' });
    await shoot(test, 'notifications-setup-details');
    await press(test, page.getByRole('button', { name: 'Remove iPhone', exact: true }));
    await shootPrompt(test, page.locator('.notifications-page'), 'notifications-setup-confirm');
}

/** A PNG as rows of RGBA pixels. Playwright writes 8-bit RGB or RGBA without interlacing. */
function decodePng(buffer) {
    let offset = 8, width = 0, height = 0, channels = 0;
    const data = [];
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset), type = buffer.toString('latin1', offset + 4, offset + 8);
        const chunk = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
            assert.ok(chunk[8] === 8 && (chunk[9] === 2 || chunk[9] === 6) && chunk[12] === 0, 'an 8-bit RGB or RGBA PNG without interlacing');
            channels = chunk[9] === 6 ? 4 : 3;
        } else if (type === 'IDAT') data.push(chunk);
        offset += 12 + length;
    }
    const raw = zlib.inflateSync(Buffer.concat(data));
    const stride = width * channels;
    const pixels = Buffer.alloc(width * height * 4, 255);
    const line = Buffer.alloc(stride), above = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        for (let x = 0; x < stride; x++) {
            const left = x >= channels ? line[x - channels] : 0, up = above[x], corner = x >= channels ? above[x - channels] : 0;
            let predicted = 0;
            if (filter === 1) predicted = left;
            else if (filter === 2) predicted = up;
            else if (filter === 3) predicted = (left + up) >> 1;
            else if (filter === 4) {
                const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
                predicted = a <= b && a <= c ? left : b <= c ? up : corner;
            }
            line[x] = (raw[y * (stride + 1) + 1 + x] + predicted) & 255;
        }
        for (let x = 0; x < width; x++) line.copy(pixels, (y * width + x) * 4, x * channels, x * channels + channels);
        line.copy(above);
    }
    return { width, height, pixels };
}

/** What differs between two pictures of one state, as text, or nothing. */
function pixelDifference(before, after) {
    if (before.equals(after)) return undefined;
    const a = decodePng(before), b = decodePng(after);
    if (a.width !== b.width || a.height !== b.height) return `the size was ${a.width}x${a.height} and is ${b.width}x${b.height}`;
    let count = 0, left = a.width, top = a.height, right = -1, bottom = -1;
    for (let i = 0; i < a.pixels.length; i += 4) {
        if (a.pixels.readUInt32LE(i) === b.pixels.readUInt32LE(i)) continue;
        const x = (i / 4) % a.width, y = Math.floor(i / 4 / a.width);
        count++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    return count ? `${count} pixels differ, within x ${left} to ${right} and y ${top} to ${bottom}` : undefined;
}

/** The elements whose computed style differs between two atlases of one state, as text, or nothing. */
function styleDifference(before, after) {
    if (before.length !== after.length) return `the page had ${before.length} elements and has ${after.length}`;
    const changed = [];
    before.forEach((row, index) => {
        if (row[0] !== after[index][0]) changed.push(`${row[0]} is now ${after[index][0]}`);
        else if (row.join('|') !== after[index].join('|')) {
            const parts = ['', '', '::before', '::after'].filter((_, part) => part > 0 && row[part] !== after[index][part]);
            changed.push(`${row[0]}${parts.join(' and ')}`);
        }
    });
    if (!changed.length) return undefined;
    return `the computed style differs on ${changed.length} elements: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ', ...' : ''}`;
}

function compare() {
    const names = (dir) => fs.readdirSync(dir).filter((name) => /\.(png|json)$/.test(name) && (!ONLY || ONLY.test(name))).sort();
    const before = names(COMPARE), after = names(OUT);
    const failures = [];
    for (const name of before) if (!after.includes(name)) failures.push(`${name}: missing from ${OUT}`);
    for (const name of after) {
        if (!before.includes(name)) {
            failures.push(`${name}: missing from ${COMPARE}`);
            continue;
        }
        const read = (dir) => fs.readFileSync(path.join(dir, name));
        const difference = name.endsWith('.png')
            ? pixelDifference(read(COMPARE), read(OUT))
            : styleDifference(JSON.parse(read(COMPARE)), JSON.parse(read(OUT)));
        if (difference) failures.push(`${name}: ${difference}`);
    }
    assert.equal(failures.length, 0, `The atlas in ${OUT} differs from ${COMPARE}:\n${failures.join('\n')}`);
    console.log(`PASS ${after.length} files match ${COMPARE}: no pixel and no computed style differs`);
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    try {
        const browser = await chromium.launch({ args: RASTER_ARGS });
        try {
            for (const viewport of VIEWPORTS) {
                for (const theme of THEMES) {
                    const test = await start(browser, viewport, theme);
                    try {
                        await listStates(test);
                        await androidStates(test);
                        await iphoneStates(test);
                        await notificationStates(test);
                        await otherStates(test);
                        assert.deepEqual(test.errors, [], `${test.label}: no page error`);
                        console.log(`PASS ${test.label}: ${test.shots} states written to ${OUT}`);
                    } finally {
                        await test.context.close();
                    }
                }
            }
        } finally {
            await browser.close();
        }
        if (COMPARE) compare();
    } finally {
        // An atlas nobody asked to keep is not left behind. Set ATLAS_OUT to look at the files.
        if (!process.env.ATLAS_OUT) fs.rmSync(OUT, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
