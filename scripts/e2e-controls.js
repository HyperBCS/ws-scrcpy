// node scripts/test-browser.js controls      (E2E_OUT=/tmp/ws-scrcpy-controls for screenshots)
// The controls of a phone's screen, on an Android phone and an iPhone, against socket fixtures:
//   - the touch grid of each kind of phone (390x844): the Android cells, and four rows of its own on an iPhone;
//     the mouse rail (1280x800) uses consecutive slots, light and dark;
//   - the mouse rail at 1440x900 (one column) and 1366x650 (two), light and dark: every caption
//     on one line and every tile one height, the rail as wide as its resting captions need and
//     as wide in every state of Listen, against the picture and as tall as it;
//   - what each control sends or opens, found by its icon, not its name;
//   - a key of the phone is disabled while there is no connection, and only the keys;
//   - holding Lock sends one down and one up, and a key held when the panel closes or the
//     window loses focus is let go once;
//   - the controls button on a touch screen (390x844 and 844x390): named Phone controls with
//     aria-expanded, translucent when idle and opaque on a touch, while open and with focus, on
//     the nearer edge after a drag that opens nothing and sends no touch, kept after a reload, a
//     rotation and a resize, never over the header, the tabs or the banner slot, inside the
//     safe-area insets, without motion when motion is reduced, and 3:1 against a white and a
//     black picture when idle, light and dark; with Type text open, the button and the panel
//     beside it stay above its sheet, and the button keeps its place on the stage when the
//     keyboard shrinks the part in view and the browser pans it; on a touch screen 1180px wide,
//     where Type text docks beside the stage, the button and its panel keep to the part of the
//     stage the sheet leaves.
// CONTROLS_ONLY=button runs only the checks of the controls button.
// CONTROLS_ONLY=rail runs only the check of the rail's captions.
// CONTROLS_ONLY=sends runs only the check of what each control sends. It finds the controls by
// their icons, so it also runs on a build from before the slot map; that is how the sends were
// compared with the base of step 5b (5cab921).
// No device, adb or pymobiledevice3 is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const { settleMotion } = require('./ui-motion');
// The one icon set, to find a control by its icon.
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const { ICONS } = require('../src/app/ui/icons');

// Only through test-browser.js, which serves the build on a port of its own. Without it this
// would open streams on the live server.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js controls');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-controls';
const ONLY = process.env.CONTROLS_ONLY;

const PIXEL = 'CONTROLS-PIXEL-0001';
const IPHONE = 'CONTROLS-IPHONE-0001';
const ANDROID = {
    udid: PIXEL, state: 'device', pid: 123, interfaces: [], 'ro.product.model': 'Pixel 9', 'ro.product.manufacturer': 'Google',
    'ro.build.version.release': '16', 'ro.build.version.sdk': '36', 'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'on', 'device.awake': true, 'battery.level': 80, 'battery.charging': false,
};
const IOS = {
    udid: IPHONE, name: 'Bench iPhone', model: 'iPhone 13 Pro Max', version: '27.2', state: 'Connected', paired: true, developerMode: true,
    session: 'ready', 'screen.power': 'on', 'device.locked': false, 'last.update.timestamp': Date.now(),
    unlockSchedule: { enabled: false, time: '03:00', hasPasscode: false, serverTimeZone: 'UTC' },
};
const PHONE = { name: 'phone', width: 390, height: 844, mobile: true };
const DESKTOP = { name: 'desktop', width: 1280, height: 800, mobile: false };
// A tablet on its side: wide enough for a docked sheet (`ui/Sheet.tsx`, from 1024px).
const TABLET = { name: 'tablet', width: 1180, height: 820, mobile: true };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The cells of the slot map: row and column in the grid of three. */
const SHARED = {
    'Volume down': [2, 1], 'Mute phone': [2, 2], 'Volume up': [2, 3],
    Lock: [3, 1], Listen: [3, 2], 'Take screenshot': [3, 3],
    'Type text': [4, 1], Actions: [4, 2], Settings: [4, 3],
};
const SLOTS = {
    android: { Back: [1, 1], Home: [1, 2], Overview: [1, 3], ...SHARED },
    // The iPhone's own buttons first; every row before the last is full.
    ios: {
        Home: [1, 1], Siri: [1, 2], Lock: [1, 3],
        'Volume down': [2, 1], 'Mute phone': [2, 2], 'Volume up': [2, 3],
        Listen: [3, 1], 'Take screenshot': [3, 2], 'Type text': [3, 3],
        Actions: [4, 1], Settings: [4, 2],
    },
};
/** The keys of the phone: they need a connection. */
const KEYS = {
    android: ['Back', 'Home', 'Overview', 'Volume down', 'Mute phone', 'Volume up', 'Lock'],
    ios: ['Home', 'Siri', 'Lock', 'Volume down', 'Mute phone', 'Volume up'],
};

/**
 * What a click on each control sent on the stream socket and which sheet it opened, by icon.
 * Android: a key is a key code message down and up (`[0, action, keycode]`). iPhone: a button is
 * one press. Taken from the base build (5cab921) and the same after the change.
 */
const SENDS = {
    android: {
        navBack: { sent: [[0, 0, 4], [0, 1, 4]], sheet: null, download: false, pressed: null },
        home: { sent: [[0, 0, 3], [0, 1, 3]], sheet: null, download: false, pressed: null },
        square: { sent: [[0, 0, 187], [0, 1, 187]], sheet: null, download: false, pressed: null },
        volDown: { sent: [[0, 0, 25], [0, 1, 25]], sheet: null, download: false, pressed: null },
        volMute: { sent: [[0, 0, 164], [0, 1, 164]], sheet: null, download: false, pressed: null },
        volUp: { sent: [[0, 0, 24], [0, 1, 24]], sheet: null, download: false, pressed: null },
        power: { sent: [[0, 0, 26], [0, 1, 26]], sheet: null, download: false, pressed: null },
        headphones: { sent: [], sheet: null, download: false, pressed: 'true' },
        camera: { sent: [], sheet: null, download: true, pressed: null },
        text: { sent: [], sheet: 'Type text', download: false, pressed: null },
        bolt: { sent: [], sheet: 'Actions', download: false, pressed: null },
        sliders: { sent: [], sheet: 'Settings', download: false, pressed: null },
    },
    ios: {
        home: { sent: [{ type: 'button', name: 'home', state: 'press' }], sheet: null, download: false, pressed: null },
        volDown: { sent: [{ type: 'button', name: 'volume-down', state: 'press' }], sheet: null, download: false, pressed: null },
        volMute: { sent: [{ type: 'button', name: 'mute', state: 'press' }], sheet: null, download: false, pressed: null },
        volUp: { sent: [{ type: 'button', name: 'volume-up', state: 'press' }], sheet: null, download: false, pressed: null },
        power: { sent: [{ type: 'button', name: 'lock', state: 'press' }], sheet: null, download: false, pressed: null },
        mic: { sent: [{ type: 'button', name: 'siri', state: 'press' }], sheet: null, download: false, pressed: null },
        headphones: { sent: [], sheet: null, download: false, pressed: 'true' },
        camera: { sent: [], sheet: null, download: false, pressed: null },
        text: { sent: [], sheet: 'Type text', download: false, pressed: null },
        bolt: { sent: [], sheet: 'Actions', download: false, pressed: null },
        sliders: { sent: [], sheet: 'Settings', download: false, pressed: null },
    },
};

/**
 * The Settings sheet of each kind of phone was named by its content at the base of step 5b. Step
 * 5b makes it one sheet named Settings (p5-settings-sheet); either name is the Settings sheet of
 * that phone.
 */
const SETTINGS_TITLES = { android: ['Stream settings', 'Settings'], ios: ['Scheduled unlock', 'Settings'] };
const sheetName = (platform, title) => (SETTINGS_TITLES[platform].includes(title) ? 'Settings' : title);

function frame(type, id, data) {
    const body = Buffer.from(data);
    const packet = Buffer.alloc(5 + body.length);
    packet[0] = type;
    packet.writeUInt32LE(id, 1);
    body.copy(packet, 5);
    return packet;
}

/**
 * A phone's screen on the fixture server. `sent()` is what the page sent on the stream socket.
 * With `held` set, a new stream socket is not answered, so the stream stays disconnected until
 * `answer()`.
 */
async function start(browser, platform, { viewport = DESKTOP, colorScheme = 'light', reducedMotion = 'no-preference', deviceScaleFactor = 1 } = {}) {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile,
        colorScheme, reducedMotion, deviceScaleFactor, serviceWorkers: 'block', acceptDownloads: true,
    });
    const page = await context.newPage();
    const test = { context, page, mobile: viewport.mobile, errors: [], packets: [], messages: [], streams: 0, held: false, socket: undefined, downloads: 0 };
    page.on('pageerror', (error) => test.errors.push(error.message));
    page.on('download', () => test.downloads++);
    const ready = (socket) => (platform === 'android' ? socket.send(initialStreamPacket()) : socket.send(JSON.stringify({ type: 'status', state: 'ready' })));
    test.answer = () => {
        test.held = false;
        ready(test.socket);
    };
    test.sent = () =>
        platform === 'android'
            ? test.packets.map((packet) => (packet[0] === 0 && packet.length === 14 ? [0, packet[1], packet.readInt32BE(2)] : [packet[0]]))
            : test.messages.slice();
    await page.route('**/api/notifications/**', (route) => route.fulfill({ json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        const action = new URL(socket.url()).searchParams.get('action');
        if (action === 'proxy-adb' || action === 'proxy-coredevice') {
            test.streams++;
            test.socket = socket;
            socket.onMessage((data) => {
                if (action === 'proxy-adb') test.packets.push(Buffer.from(data));
                else if (typeof data === 'string') test.messages.push(JSON.parse(data));
            });
            if (!test.held) setTimeout(() => ready(socket), 40);
            return;
        }
        socket.onMessage((data) => {
            const packet = Buffer.from(data);
            if (packet.length < 5 || packet[0] !== 4) return;
            const id = packet.readUInt32LE(1);
            const code = packet.subarray(5, 9).toString();
            const send = (message) => socket.send(frame(32, id, JSON.stringify(message)));
            if (code === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } });
            if (code === 'GTRC') {
                send({ id: -1, type: 'devicelist', data: { id: 'android', name: 'Fixture host', list: [ANDROID] } });
                test.updateAndroid = (fields) => send({ id: -1, type: 'device', data: { id: 'android', name: 'Fixture host', device: { ...ANDROID, ...fields } } });
            }
            if (code === 'ATRC') send({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Fixture host', list: [IOS] } });
        });
    });
    await page.goto(`${BASE}#!action=device&udid=${platform === 'android' ? PIXEL : IPHONE}&view=screen`);
    await connected(page);
    await page.locator('.control-buttons-list button').first().waitFor({ state: 'attached' });
    await settleMotion(page);
    return test;
}

const connected = (page) => page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.includes('Connected'));
const openSheet = (page) => page.locator('dialog.kit-sheet[open]');
const byIcon = (page, icon) => page.locator('.control-buttons-list button').filter({ has: page.locator(`path[d="${ICONS[icon]}"]`) });
const byName = (page, name) => page.locator(`.control-buttons-list button[aria-label="${name}"]`);

async function shot(page, name) {
    fs.mkdirSync(OUT, { recursive: true });
    await settleMotion(page);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled' });
}

async function openPanel(test) {
    if (!test.mobile) return;
    await test.page.locator('.floating-toolbar-fab').click();
    await test.page.locator('.floating-toolbar.open').waitFor();
    await settleMotion(test.page);
}

/** What each control sends when clicked, and the sheet it opens, against `SENDS`. */
async function sends(browser, platform) {
    const test = await start(browser, platform);
    const { page } = test;
    try {
        const found = {};
        for (const icon of Object.keys(SENDS[platform])) {
            test.packets.length = 0;
            test.messages.length = 0;
            test.downloads = 0;
            const control = byIcon(page, icon);
            assert.equal(await control.count(), 1, `${platform}: one control shows ${icon}`);
            await control.click();
            await pause(300);
            await settleMotion(page);
            const sheet = (await openSheet(page).count()) ? sheetName(platform, await openSheet(page).locator('.kit-sheet-title').innerText()) : null;
            found[icon] = { sent: test.sent(), sheet, download: test.downloads > 0, pressed: await control.getAttribute('aria-pressed') };
            if (sheet) {
                await page.keyboard.press('Escape');
                await openSheet(page).waitFor({ state: 'detached' });
                await settleMotion(page);
            }
        }
        assert.deepEqual(found, SENDS[platform], `${platform}: each control sends and opens what it did before`);
        assert.deepEqual(test.errors, []);
        assert.equal(test.streams, 1, `${platform}: one stream socket`);
    } finally {
        await test.context.close();
    }
    console.log(`PASS ${platform}: each control sends and opens what it did before`);
}

/** Read actual grid tracks: a wrapped caption can grow a row of the touch grid, and a short picture can give the rail two columns. */
async function cells(page) {
    return page.locator('.control-buttons-list').evaluate((list) => {
        const box = list.getBoundingClientRect();
        const buttons = [...list.querySelectorAll(':scope > button')];
        const style = getComputedStyle(list);
        const trackAt = (offset, sizes, gap) => {
            let edge = 0;
            for (let i = 0; i < sizes.length; i++) {
                edge += sizes[i];
                if (offset < edge) return i + 1;
                edge += gap;
            }
            throw Error('button is outside the rendered grid tracks');
        };
        const rows = style.gridTemplateRows.split(' ').map(parseFloat), columns = style.gridTemplateColumns.split(' ').map(parseFloat);
        return Object.fromEntries(buttons.map((button) => {
            const rect = button.getBoundingClientRect();
            const row = trackAt(rect.top + rect.height / 2 - box.top, rows, parseFloat(style.rowGap));
            const column = trackAt(rect.left + rect.width / 2 - box.left, columns, parseFloat(style.columnGap));
            return [button.getAttribute('aria-label'), [row, column]];
        }));
    });
}

/** One slot map on both kinds of phone, in the panel and in the rail, light and dark. */
async function slotMap(browser) {
    for (const viewport of [PHONE, DESKTOP]) {
        for (const colorScheme of ['light', 'dark']) {
            const found = {};
            for (const platform of ['android', 'ios']) {
                const label = `${viewport.name}-${colorScheme} ${platform}`;
                const test = await start(browser, platform, { viewport, colorScheme });
                const { page } = test;
                try {
                    await openPanel(test);
                    found[platform] = await cells(page);
                    const columns = viewport.mobile ? 3 : Number(await page.locator('.floating-toolbar.desktop').getAttribute('data-columns'));
                    const wanted = Object.fromEntries(Object.entries(SLOTS[platform]).map(([name, [row, column]]) => {
                        const index = viewport.mobile ? (row - 1) * 3 + column - 1 : Object.keys(SLOTS[platform]).indexOf(name);
                        return [name, [Math.floor(index / columns) + 1, index % columns + 1]];
                    }));
                    assert.deepEqual(found[platform], wanted, `${label}: each control in its slot`);
                    const group = page.getByRole('group', { name: 'Phone controls', exact: true });
                    assert.equal(await group.count(), 1, `${label}: the controls are one group named Phone controls`);
                    if (viewport.mobile) assert.equal(await page.locator('.floating-toolbar-heading').innerText(), 'Phone controls');
                    const fit = await page.evaluate(() => {
                        const panel = document.querySelector('.floating-toolbar-panel').getBoundingClientRect();
                        const settings = document.querySelector('.control-buttons-list button[aria-label="Settings"]').getBoundingClientRect();
                        return { panel: panel.top >= 0 && panel.bottom <= innerHeight + 1, settings: settings.bottom <= innerHeight + 1, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
                    });
                    if (viewport.mobile) assert.equal(fit.panel, true, `${label}: the whole panel is on screen`);
                    assert.equal(fit.settings, true, `${label}: the shared rows are in view`);
                    assert.equal(fit.overflow, false, `${label}: nothing overflows sideways`);
                    await shot(page, `${platform}-controls-${viewport.name}-${colorScheme}`);
                    assert.deepEqual(test.errors, []);
                } finally {
                    await test.context.close();
                }
            }
            if (viewport.mobile) {
                for (const name of ['Volume down', 'Mute phone', 'Volume up']) {
                    assert.deepEqual(found.ios[name], found.android[name], `${viewport.name}-${colorScheme}: ${name} has one touch cell on both kinds of phone`);
                }
                // No control alone in a row and no hole: the cells of each phone are 1.1, 1.2, 1.3, 2.1 and so on.
                for (const platform of ['android', 'ios']) {
                    const cells = Object.values(found[platform]).map(([row, column]) => (row - 1) * 3 + column).sort((a, b) => a - b);
                    assert.deepEqual(cells, cells.map((_, index) => index + 1), `${viewport.name}-${colorScheme}: the ${platform} touch grid has no empty cell before its last control`);
                }
            }
        }
    }
    console.log('PASS touch cells without holes on both kinds of phone and consecutive mouse rail slots, light and dark');
}

/**
 * The rail, its tiles and the picture, once the boxes have been the same for three frames, and
 * how often the stage's style was written in the twenty frames after that.
 */
async function railBoxes(page) {
    await settleMotion(page);
    return page.evaluate(async () => {
        const measure = () => {
            const panel = document.querySelector('.stream-controls-slot .floating-toolbar-panel');
            // Before the player has sized its layer, the picture's box is the mount node's.
            const layer = document.querySelector('.stream-mount .touch-layer[width][height]');
            const picture = (layer || document.querySelector('.stream-mount')).getBoundingClientRect();
            const range = document.createRange();
            const tiles = [...panel.querySelectorAll('.control-buttons-list > button')].map((button) => {
                const caption = button.querySelector('.kit-icon-button-caption');
                range.selectNodeContents(caption);
                const text = range.getBoundingClientRect();
                const box = button.getBoundingClientRect();
                const style = getComputedStyle(button);
                const left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
                const right = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
                return {
                    name: button.getAttribute('aria-label'), title: button.title, caption: caption.textContent, height: box.height,
                    // One line box for the words, and the words inside the tile's padding.
                    lines: new Set([...range.getClientRects()].map((line) => Math.round(line.top))).size,
                    inside: text.left >= left - 0.5 && text.right <= right + 0.5,
                    // The room for words in the tile, and what the words take.
                    room: right - left, text: text.width,
                };
            });
            const rail = panel.getBoundingClientRect();
            return {
                tiles, columns: panel.parentElement.dataset.columns,
                rail: { left: rail.left, top: rail.top, width: rail.width, height: rail.height },
                picture: { right: picture.right, top: picture.top, height: picture.height },
            };
        };
        let last = JSON.stringify(measure()), still = 0;
        for (let frame = 0; frame < 60 && still < 3; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const now = JSON.stringify(measure());
            still = now === last ? still + 1 : 0;
            last = now;
        }
        // A measure that wrote a width which asked for another measure would keep writing.
        const stage = document.querySelector('.stream-stage');
        let writes = 0;
        const watch = new MutationObserver((records) => (writes += records.length));
        watch.observe(stage, { attributes: true, attributeFilter: ['style'] });
        for (let frame = 0; frame < 20; frame++) await new Promise((resolve) => requestAnimationFrame(resolve));
        watch.disconnect();
        return { ...JSON.parse(last), settled: still >= 3, writes, column: stage.style.getPropertyValue('--stream-rail-column') };
    });
}

/**
 * The rail with a mouse, at 1440x900 in one column and at 1366x650 in two, light and dark: no
 * caption wraps, so every tile is one height, and the rail is as wide as its resting captions
 * need ("Volume down" is the widest), with no more than a few pixels to spare. It stands against
 * the picture and is as tall as it. Listen shows a short caption in each state, so the rail
 * keeps its width while the sound waits, plays, is blocked and is unavailable; the hover text
 * keeps the state's full words. The stage, the mount node and the stream socket stay the same.
 */
async function railCaptions(browser) {
    const LARGE = { name: '1440x900', width: 1440, height: 900, mobile: false };
    const SHORT = { name: '1366x650', width: 1366, height: 650, mobile: false };
    const runs = [[LARGE, '1', 'light'], [LARGE, '1', 'dark'], [SHORT, '2', 'light'], [SHORT, '2', 'dark']];
    for (const [viewport, columns, colorScheme] of runs) {
        for (const platform of ['android', 'ios']) {
            const label = `${viewport.name}-${colorScheme} ${platform}`;
            const test = await start(browser, platform, { viewport, colorScheme });
            const { page } = test;
            try {
                await page.evaluate(() => {
                    window.__railStage = document.querySelector('.stream-stage');
                    window.__railMount = document.querySelector('.stream-mount');
                });
                const check = (found, when) => {
                    assert.equal(found.settled, true, `${label}${when}: the rail settles`);
                    assert.equal(found.writes, 0, `${label}${when}: the stage is not written again once the rail has settled`);
                    assert.equal(found.columns, columns, `${label}${when}: ${columns} column${columns === '1' ? '' : 's'}`);
                    assert.deepEqual(found.tiles.filter((tile) => tile.lines !== 1).map((tile) => tile.caption), [], `${label}${when}: no caption wraps`);
                    assert.deepEqual(found.tiles.filter((tile) => !tile.inside).map((tile) => tile.caption), [], `${label}${when}: every caption is inside its tile`);
                    const heights = found.tiles.map((tile) => tile.height);
                    assert.ok(Math.max(...heights) - Math.min(...heights) < 0.5, `${label}${when}: every tile is one height (${heights})`);
                    const { rail, picture } = found;
                    assert.ok(rail.left >= picture.right - 0.5 && rail.left - picture.right <= 4, `${label}${when}: the rail touches the picture (${picture.right} to ${rail.left})`);
                    assert.ok(Math.abs(rail.top - picture.top) <= 1 && Math.abs(rail.height - picture.height) <= 1, `${label}${when}: the rail is as tall as the picture`);
                };
                const listen = (found) => found.tiles.find((tile) => tile.name === 'Listen');
                const resting = await railBoxes(page);
                check(resting, '');
                // The widest resting caption takes the tile's room, to a few pixels.
                const widest = resting.tiles.reduce((wide, tile) => (tile.text > wide.text ? tile : wide));
                const spare = widest.room - widest.text;
                assert.ok(spare >= -0.5 && spare < 4, `${label}: the rail is as wide as "${widest.caption}" needs (${spare.toFixed(1)}px spare, column ${resting.column})`);
                assert.ok(['Volume down', 'Screenshot'].includes(widest.caption), `${label}: the widest caption is a resting one (${widest.caption})`);
                await shot(page, `${platform}-rail-${viewport.name}-${colorScheme}`);

                const sendAudio = (kind, payload) => {
                    const packet = Buffer.alloc(23 + payload.length);
                    packet.write('scrcpy_audio_2');
                    packet[14] = kind;
                    payload.copy(packet, 23);
                    test.socket.send(platform === 'ios' ? Buffer.concat([Buffer.from([3]), packet]) : packet);
                };
                const audioState = (state) => page.waitForFunction((wanted) => document.querySelector('[data-control="audio"]')?.getAttribute('data-audio-state') === wanted, state);
                const states = [
                    ['waiting', 'Waiting', 'Waiting for audio', () => byName(page, 'Listen').click()],
                    ['playing', 'Listening', 'Listening', async () => {
                        // Silent PCM through the audio envelope: the state, not a claim about sound.
                        sendAudio(2, Buffer.from(JSON.stringify({ status: 'ready', codec: 'raw', sampleRate: 48000, channels: 2 })));
                        sendAudio(0, Buffer.alloc(4800 * 4));
                    }],
                    ['blocked', 'Blocked', 'Blocked', async () => {
                        await byName(page, 'Listen').click();
                        await page.evaluate(() => {
                            window.__railResume = window.AudioContext.prototype.resume;
                            window.AudioContext.prototype.resume = () => Promise.reject(new Error('Fixture playback denied'));
                        });
                        await byName(page, 'Listen').click();
                    }],
                    ['disabled', 'Listen', 'Listen', async () => {
                        await page.evaluate(() => {
                            window.AudioContext.prototype.resume = window.__railResume;
                            delete window.__railResume;
                        });
                        sendAudio(2, Buffer.from(JSON.stringify({ status: 'disabled', sampleRate: 48000, channels: 2 })));
                    }],
                ];
                for (const [state, caption, title, enter] of states) {
                    await enter();
                    await audioState(state);
                    const found = await railBoxes(page);
                    check(found, ` while ${state}`);
                    assert.deepEqual([listen(found).caption, listen(found).title], [caption, title], `${label}: Listen's caption and hover text while ${state}`);
                    assert.ok(Math.abs(found.rail.width - resting.rail.width) < 0.5, `${label}: the rail keeps its width while ${state} (${resting.rail.width}, ${found.rail.width})`);
                    if (state === 'waiting') await shot(page, `${platform}-rail-${viewport.name}-${colorScheme}-waiting`);
                }
                assert.equal(await page.evaluate(() => window.__railStage === document.querySelector('.stream-stage') && window.__railMount === document.querySelector('.stream-mount')), true, `${label}: the stage and the mount node are the ones of the start`);
                assert.equal(test.streams, 1, `${label}: one stream socket`);
                assert.deepEqual(test.errors, []);
            } finally {
                await test.context.close();
            }
        }
    }
    console.log('PASS the mouse rail is as wide as its resting captions and keeps every caption on one line and every tile one height in every state of Listen, against the picture, in one column and in two');
}

/** While there is no connection the keys of the phone are disabled, and only they. */
async function disabledWithoutConnection(browser, platform) {
    const test = await start(browser, platform);
    const { page } = test;
    const disabled = () => page.locator('.control-buttons-list button:disabled').evaluateAll((list) => list.map((button) => button.getAttribute('aria-label')));
    try {
        assert.deepEqual(await disabled(), [], `${platform}: every control works while connected`);
        test.held = true;
        test.socket.close();
        await page.waitForFunction((count) => document.querySelectorAll('.control-buttons-list button:disabled').length === count, KEYS[platform].length);
        assert.deepEqual(await disabled(), KEYS[platform], `${platform}: the keys of the phone, Mute phone among them, are disabled and nothing else`);
        // The receiver connects again by itself; the fixture answers once asked.
        const deadline = Date.now() + 10000;
        while (test.streams < 2 && Date.now() < deadline) await pause(100);
        assert.equal(test.streams, 2, `${platform}: the stream connects again`);
        test.answer();
        await connected(page);
        await page.waitForFunction(() => !document.querySelector('.control-buttons-list button:disabled'));
        assert.deepEqual(test.errors, []);
    } finally {
        await test.context.close();
    }
    console.log(`PASS ${platform}: without a connection the keys of the phone are disabled, by their definition`);
}

/** The press of a key is held with the mouse on the control. */
async function holdOn(page, name, ms) {
    const box = await byName(page, name).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await pause(ms);
}

/** Holding Lock sends one down and one up; a held key is let go once when the panel closes or the window loses focus. */
async function holds(browser, platform, viewport) {
    const label = `${viewport.name} ${platform}`;
    const test = await start(browser, platform, { viewport });
    const { page } = test;
    const keysSent = () => test.sent().filter((item) => (platform === 'android' ? item[0] === 0 : item.type === 'button'));
    const pair = (code, name) => (platform === 'android' ? [[0, 0, code], [0, 1, code]] : [{ type: 'button', name, state: 'down' }, { type: 'button', name, state: 'up' }]);
    try {
        await openPanel(test);
        test.packets.length = 0;
        test.messages.length = 0;
        await holdOn(page, 'Lock', 1000);
        await page.mouse.up();
        await pause(200);
        assert.deepEqual(keysSent(), pair(26, 'lock'), `${label}: holding Lock sends one down and one up`);

        // The second key: Volume up on Android, Siri on an iPhone, which holds it for Siri.
        const [name, code, button] = platform === 'android' ? ['Volume up', 24, 'volume-up'] : ['Siri', 0, 'siri'];
        test.packets.length = 0;
        test.messages.length = 0;
        await holdOn(page, name, 900);
        if (viewport.mobile) {
            await page.keyboard.press('Escape');
            await page.locator('.floating-toolbar.open').waitFor({ state: 'detached' });
        } else {
            await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        }
        await pause(100);
        assert.deepEqual(keysSent(), pair(code, button), `${label}: ${viewport.mobile ? 'closing the panel' : 'losing focus'} lets go of ${name}`);
        await page.mouse.up();
        await pause(200);
        assert.deepEqual(keysSent(), pair(code, button), `${label}: and the pointer's own end sends nothing more`);
        assert.deepEqual(test.errors, []);
    } finally {
        await test.context.close();
    }
    console.log(`PASS ${label}: a hold is one down and one up, let go once`);
}

const LANDSCAPE = { name: 'landscape', width: 844, height: 390, mobile: true };
// The button turns translucent this long after the last touch (`controls/ControlPanel.tsx`).
const IDLE_MS = 3000;
// The button keeps this far from the top and the bottom of the stage.
const EDGE_MARGIN = 12;
const NO_INSETS = { left: 0, top: 0, right: 0, bottom: 0 };

/** The controls button: its box and look, and the boxes it has to keep clear of. */
async function buttonState(page) {
    return page.evaluate(() => {
        const box = (element) => {
            if (!element) return null;
            const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
            return { left, top, right, bottom, width, height };
        };
        const fab = document.querySelector('.floating-toolbar-fab');
        return {
            fab: box(fab), stage: box(document.querySelector('.stream-stage')), bar: box(document.querySelector('.kit-bar')),
            tabs: box(document.querySelector('.kit-tabs')), banners: box(document.querySelector('.stream-banners')),
            picture: box(document.querySelector('.touch-layer')), width: innerWidth, height: innerHeight,
            side: fab.closest('.floating-toolbar').dataset.side, idle: fab.hasAttribute('data-idle'),
            opacity: Number(getComputedStyle(fab).opacity),
            idleOpacity: Number(getComputedStyle(document.documentElement).getPropertyValue('--idle-opacity')),
            moving: fab.getAnimations().filter((animation) => animation.playState === 'running').length,
        };
    });
}

/** Where the button may be: under the header, the tabs and the banners, on screen, inside the safe area. */
function buttonArea(state, insets = NO_INSETS) {
    return {
        left: insets.left,
        right: state.width - insets.right,
        top: Math.max(state.stage.top, state.bar.bottom, state.tabs?.bottom ?? 0, state.banners.bottom, insets.top) + EDGE_MARGIN,
        bottom: Math.min(state.stage.bottom, state.height - insets.bottom) - EDGE_MARGIN,
    };
}

/** The button is in its area and against the edge of `side`; returns its height as a fraction of the area. */
function onEdge(label, state, side, insets = NO_INSETS) {
    const area = buttonArea(state, insets);
    const { fab } = state;
    assert.equal(state.side, side, `${label}: on the ${side} side`);
    if (side === 'left') assert.ok(Math.abs(fab.left - area.left) < 0.5, `${label}: against the left edge (${fab.left}, edge ${area.left})`);
    else assert.ok(Math.abs(fab.right - area.right) < 0.5, `${label}: against the right edge (${fab.right}, edge ${area.right})`);
    assert.ok(fab.top >= area.top - 0.5, `${label}: under the header, the tabs and the banners (${fab.top}, area from ${area.top})`);
    assert.ok(fab.bottom <= area.bottom + 0.5, `${label}: above the bottom of the stage (${fab.bottom}, area to ${area.bottom})`);
    return (fab.top - area.top) / (area.bottom - area.top - fab.height);
}

const centre = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
/** Touch messages the page sent to the phone. */
const touches = (test, platform) => (platform === 'android' ? test.packets.filter((packet) => packet[0] === 2).length : test.messages.filter((message) => /^touch/.test(message.type)).length);

/** Waits until the page has taken the end of a drag of the button. */
const dropped = (page) => page.waitForFunction(() => !document.querySelector('.floating-toolbar.dragging'));

/** A finger on the touch screen, through the browser's own input, so pointer and touch events both fire. */
async function finger(page) {
    const cdp = await page.context().newCDPSession(page);
    const at = ({ x, y }) => [{ x: Math.round(x), y: Math.round(y) }];
    return {
        down: (point) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(point) }),
        move: (point) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(point) }),
        up: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
        async tap(point) {
            await this.down(point);
            await this.up();
        },
        async drag(from, to, during) {
            await this.down(from);
            for (let step = 1; step <= 10; step++) await this.move({ x: from.x + ((to.x - from.x) * step) / 10, y: from.y + ((to.y - from.y) * step) / 10 });
            if (during) await during();
            await this.up();
        },
        detach: () => cdp.detach(),
    };
}

/**
 * The controls button on a touch screen (U-stream-9): named Phone controls with aria-expanded;
 * translucent before a touch and 3 s after one, opaque on a touch, while its panel is open and
 * with the keyboard's focus; a tap opens the panel and a drag does not, nor sends a touch to the
 * phone; let go, it slides to the nearer edge; it never sits over the header, the tabs or the
 * banner slot, keeps its place after a reload, a rotation and a resize, and keeps inside the
 * safe-area insets.
 */
async function touchButton(browser, platform, viewport) {
    const label = `${viewport.name} ${platform}`;
    const test = await start(browser, platform, { viewport });
    const { page } = test;
    const fab = page.locator('.floating-toolbar-fab');
    const touch = await finger(page);
    try {
        assert.equal(await page.getByRole('button', { name: 'Phone controls', exact: true }).count(), 1, `${label}: the button is named Phone controls`);
        assert.equal(await fab.getAttribute('aria-expanded'), 'false', `${label}: and says its panel is closed`);

        // Before the first touch: translucent, on the right edge of the stage.
        let state = await buttonState(page);
        assert.ok(state.idleOpacity >= 0.4 && state.idleOpacity <= 0.5, `${label}: the idle opacity is about 45% (${state.idleOpacity})`);
        assert.equal(state.idle, true, `${label}: idle before a touch`);
        assert.equal(state.opacity, state.idleOpacity, `${label}: translucent when idle`);
        onEdge(label, state, 'right');
        // Where the picture leaves a band beside it wide enough for the button, it is in that band.
        if (state.picture && state.width - state.picture.right >= state.fab.width) {
            assert.ok(state.fab.left >= state.picture.right - 0.5, `${label}: in the band beside the picture`);
        }

        // A touch makes it opaque; the tap opens the panel, which keeps it opaque.
        await touch.down(centre(state.fab));
        await settleMotion(page);
        assert.equal((await buttonState(page)).opacity, 1, `${label}: opaque while touched`);
        await touch.up();
        await page.locator('.floating-toolbar.open').waitFor();
        assert.equal(await fab.getAttribute('aria-expanded'), 'true', `${label}: a tap opens the panel`);
        await pause(IDLE_MS + 500);
        assert.equal((await buttonState(page)).opacity, 1, `${label}: opaque while the panel is open`);
        // Escape closes the panel and gives the button the keyboard's focus.
        const closed = Date.now();
        await page.keyboard.press('Escape');
        await page.locator('.floating-toolbar.open').waitFor({ state: 'detached' });
        assert.equal(await fab.getAttribute('aria-expanded'), 'false', `${label}: and says it is closed`);
        assert.equal((await buttonState(page)).idle, false, `${label}: not idle right after the panel closes`);
        await page.waitForFunction(() => document.querySelector('.floating-toolbar-fab').hasAttribute('data-idle'), null, { timeout: IDLE_MS + 2000 });
        const after = Date.now() - closed;
        assert.ok(after >= IDLE_MS - 100, `${label}: idle 3 s after the last touch (${after} ms)`);
        await settleMotion(page);
        assert.equal(await fab.evaluate((button) => button.matches(':focus-visible')), true, `${label}: the button has the keyboard's focus`);
        assert.equal((await buttonState(page)).opacity, 1, `${label}: opaque while it has the keyboard's focus`);
        await fab.evaluate((button) => button.blur());
        await settleMotion(page);
        assert.equal((await buttonState(page)).opacity, state.idleOpacity, `${label}: translucent again without it`);

        // Dragged up over the header and let go on the left half: it stays under the header,
        // opens nothing, sends no touch, and slides to the left edge at the top of the stage.
        test.packets.length = 0;
        test.messages.length = 0;
        // Counts the slides started on the button, so that a slow run cannot miss one that has
        // already ended.
        await fab.evaluate((button) => {
            window.slides = 0;
            const animate = button.animate.bind(button);
            button.animate = (...args) => {
                window.slides++;
                return animate(...args);
            };
        });
        let during;
        await touch.drag(centre(state.fab), { x: viewport.width * 0.3, y: 10 }, async () => (during = await buttonState(page)));
        assert.ok(during.fab.top >= buttonArea(during).top - 0.5, `${label}: dragged over the header, the button stays under it (${during.fab.top})`);
        assert.equal(during.opacity, 1, `${label}: opaque while dragged`);
        await dropped(page);
        assert.equal(await page.evaluate(() => window.slides), 1, `${label}: let go, it slides to the edge`);
        await settleMotion(page);
        state = await buttonState(page);
        assert.ok(Math.abs(onEdge(label, state, 'left')) < 0.01, `${label}: at the top of the stage`);
        assert.equal(await fab.getAttribute('aria-expanded'), 'false', `${label}: a drag does not open the panel`);
        assert.equal(await page.locator('.floating-toolbar-panel').isVisible(), false, `${label}: no panel after a drag`);
        assert.equal(touches(test, platform), 0, `${label}: a drag of the button sends no touch to the phone`);

        // A banner takes height from the stage: the button moves down with it.
        if (platform === 'android') {
            test.updateAndroid({ 'keyguard.showing': true, 'keyguard.occluded': false, 'device.locked': true });
            await page.locator('.lock-screen-notice').waitFor();
            await settleMotion(page);
            state = await buttonState(page);
            assert.ok(state.banners.height > 0, `${label}: the lock notice is in the banner slot`);
            assert.ok(Math.abs(onEdge(`${label} with a banner`, state, 'left')) < 0.01, `${label}: under the banner`);
            test.updateAndroid({ 'keyguard.showing': false, 'device.locked': false });
            await page.locator('.lock-screen-notice').waitFor({ state: 'hidden' });
            await settleMotion(page);
            onEdge(`${label} without the banner`, await buttonState(page), 'left');
        }

        // Let go low on the right half: the right edge, at the height it was let go.
        state = await buttonState(page);
        const target ={ x: viewport.width * 0.7, y: state.stage.top + state.stage.height * 0.7 };
        await touch.drag(centre(state.fab), target);
        await settleMotion(page);
        state = await buttonState(page);
        const fraction = onEdge(label, state, 'right');
        assert.ok(Math.abs(state.fab.top - (target.y - state.fab.height / 2)) < 1, `${label}: at the height it was let go`);
        assert.equal(touches(test, platform), 0, `${label}: no touch reached the phone`);

        // Kept after a reload, and after a rotation and a resize, at the same height of the stage.
        await page.reload();
        await connected(page);
        await settleMotion(page);
        const reloaded = await buttonState(page);
        assert.deepEqual([reloaded.fab.left, reloaded.fab.top], [state.fab.left, state.fab.top], `${label}: the place is kept after a reload`);
        for (const size of [{ width: viewport.height, height: viewport.width }, { width: 360, height: 640 }, { width: viewport.width, height: viewport.height }]) {
            await page.setViewportSize(size);
            await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, size);
            await settleMotion(page);
            const resized = await buttonState(page);
            const kept = onEdge(`${label} at ${size.width}x${size.height}`, resized, 'right');
            assert.ok(Math.abs(kept - fraction) < 0.01, `${label} at ${size.width}x${size.height}: at the same height of the stage (${kept}, was ${fraction})`);
        }

        // Inside the safe-area insets. The probe takes env(safe-area-inset-*), which is 0 here.
        const insets = { left: 32, top: 0, right: 24, bottom: 20 };
        await page.addStyleTag({ content: `.floating-toolbar-safearea { padding: ${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px !important; }` });
        await page.evaluate(() => window.dispatchEvent(new Event('resize')));
        await settleMotion(page);
        state = await buttonState(page);
        onEdge(`${label} with insets`, state, 'right', insets);
        await touch.drag(centre(state.fab), { x: 4, y: viewport.height - 2 });
        await settleMotion(page);
        state = await buttonState(page);
        assert.ok(Math.abs(onEdge(`${label} with insets`, state, 'left', insets) - 1) < 0.01, `${label}: at the bottom, above the inset`);
        assert.deepEqual(test.errors, []);
    } finally {
        await touch.detach().catch(() => undefined);
        await test.context.close();
    }
    console.log(`PASS ${label}: the controls button is translucent when idle, snaps to an edge, keeps its place and stays clear of the header`);
}

/**
 * Type text leaves the button in reach above its sheet. With the button low on the stage, its
 * panel opens beside it and stays above the sheet, all of it in view.
 */
async function panelAboveTypeText(browser, platform) {
    const label = `phone ${platform} Type text`;
    const test = await start(browser, platform, { viewport: PHONE });
    const { page } = test;
    const touch = await finger(page);
    try {
        const state = await buttonState(page);
        await touch.drag(centre(state.fab), { x: PHONE.width - 10, y: PHONE.height - 5 });
        await dropped(page);
        await settleMotion(page);
        // A tap soon after a fast drag sent this way brings no click, with the button of the
        // base as well: the browser takes the tap as the end of the gesture before it.
        await pause(2000);
        await touch.tap(centre((await buttonState(page)).fab));
        await page.locator('.floating-toolbar.open').waitFor();
        await settleMotion(page);
        await touch.tap(centre(await byName(page, 'Type text').evaluate((button) => button.getBoundingClientRect().toJSON())));
        const sheet = openSheet(page).filter({ has: page.locator('.kit-sheet-title', { hasText: /^Type text$/ }) });
        await sheet.waitFor();
        await settleMotion(page);
        const typing = await buttonState(page);
        const dock = await sheet.locator('.kit-sheet-panel').boundingBox();
        assert.ok(typing.fab.bottom <= dock.y + 0.5, `${label}: the button is above the sheet (${typing.fab.bottom}, sheet at ${dock.y})`);
        await touch.tap(centre(typing.fab));
        await page.locator('.floating-toolbar.open').waitFor();
        await settleMotion(page);
        const panel = await page.locator('.floating-toolbar-panel').boundingBox();
        assert.ok(panel.y >= 0 && panel.y + panel.height <= dock.y + 0.5, `${label}: the panel is above the sheet (${panel.y}-${panel.y + panel.height}, sheet at ${dock.y})`);
        assert.ok(panel.x + panel.width <= typing.fab.left + 0.5, `${label}: the panel is beside the button (${panel.x}+${panel.width}, button at ${typing.fab.left})`);
        assert.deepEqual(test.errors, []);
    } finally {
        await touch.detach().catch(() => undefined);
        await test.context.close();
    }
    console.log(`PASS ${label}: the button and its panel stay above the sheet`);
}

/**
 * Type text keeps the view on the part of the window in view. The on-screen keyboard shrinks
 * that part, and Safari can then pan it without a resize; the view follows a frame later
 * (`LiveTextOverlay.tsx`). The button keeps its place on the stage through both, so it is never
 * left over the header or over the sheet. The keyboard and the pan are played by the visual
 * viewport's own values and events.
 */
async function followsTypingView(browser, platform) {
    const label = `phone ${platform} Type text with the keyboard`;
    const test = await start(browser, platform, { viewport: PHONE });
    const { page } = test;
    const viewport = async (values, event) => {
        await page.evaluate(({ values, event }) => {
            const visual = window.visualViewport;
            if (!window.fakeViewport) {
                window.fakeViewport = { offsetTop: visual.offsetTop, height: visual.height };
                for (const name of ['offsetTop', 'height']) Object.defineProperty(visual, name, { configurable: true, get: () => window.fakeViewport[name] });
            }
            Object.assign(window.fakeViewport, values);
            visual.dispatchEvent(new Event(event));
        }, { values, event });
        await pause(100);
        await settleMotion(page);
        return buttonState(page);
    };
    try {
        await openPanel(test);
        await byName(page, 'Type text').click();
        await openSheet(page).filter({ has: page.locator('.kit-sheet-title', { hasText: /^Type text$/ }) }).waitFor();
        await settleMotion(page);
        const keyboard = await viewport({ height: PHONE.height - 300 }, 'resize');
        const fraction = onEdge(`${label} up`, keyboard, 'right');
        const panned = await viewport({ offsetTop: 300 }, 'scroll');
        assert.equal(panned.bar.top, 300, `${label}: the view follows the pan`);
        const kept = onEdge(`${label} panned`, panned, 'right');
        assert.ok(Math.abs(kept - fraction) < 0.01, `${label} panned: at the same height of the stage (${kept}, was ${fraction})`);
        const back = await viewport({ offsetTop: 0 }, 'scroll');
        assert.equal(back.bar.top, 0, `${label}: the view follows the pan back`);
        const again = onEdge(`${label} panned back`, back, 'right');
        assert.ok(Math.abs(again - fraction) < 0.01, `${label} panned back: at the same height of the stage (${again}, was ${fraction})`);
        assert.deepEqual(test.errors, []);
    } finally {
        await test.context.close();
    }
    console.log(`PASS ${label}: the button stays on the stage when the view is panned`);
}

/**
 * A touch screen 1024px or wider docks Type text beside the stage (`ui/Sheet.tsx`). The button
 * then keeps to the part of the stage the sheet leaves, so it stays in reach and its panel opens
 * beside it, not under the sheet; when the sheet closes the button goes back to the stage's
 * edge. The stage is not built again and the page keeps one stream socket.
 */
async function besideDockedSheet(browser, platform) {
    const label = `tablet ${platform} Type text docked`;
    const test = await start(browser, platform, { viewport: TABLET });
    const { page } = test;
    const touch = await finger(page);
    try {
        await page.evaluate(() => { window.__controlsStage = document.querySelector('.stream-stage'); });
        const before = await buttonState(page);
        const edge = onEdge(`${label} before`, before, 'right');
        assert.ok(Math.abs(before.fab.right - before.stage.right) < 0.5, `${label}: at the stage's right edge (${before.fab.right}, stage to ${before.stage.right})`);
        await touch.tap(centre(before.fab));
        await page.locator('.floating-toolbar.open').waitFor();
        await settleMotion(page);
        await touch.tap(centre(await byName(page, 'Type text').evaluate((button) => button.getBoundingClientRect().toJSON())));
        const sheet = openSheet(page).filter({ has: page.locator('.kit-sheet-title', { hasText: /^Type text$/ }) });
        await sheet.waitFor();
        await page.locator('.stream-stage[data-sheet-docked]').waitFor({ state: 'attached' });
        await settleMotion(page);
        const dock = await sheet.locator('.kit-sheet-panel').boundingBox();
        const typing = await buttonState(page);
        assert.ok(Math.abs(dock.x + dock.width - typing.stage.right) < 1, `${label}: the sheet is docked at the stage's right edge (${dock.x + dock.width}, stage to ${typing.stage.right})`);
        assert.equal(typing.side, 'right', `${label}: still on the right side`);
        assert.ok(Math.abs(typing.fab.right - dock.x) < 0.5, `${label}: the button stands against the docked sheet (${typing.fab.right}, sheet from ${dock.x})`);
        assert.ok(Math.abs(typing.fab.top - before.fab.top) < 0.5, `${label}: at the same height (${typing.fab.top}, was ${before.fab.top})`);
        assert.equal(
            await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.floating-toolbar-fab'), centre(typing.fab)),
            true,
            `${label}: the button is not under the sheet`,
        );
        await touch.tap(centre(typing.fab));
        await page.locator('.floating-toolbar.open').waitFor();
        await settleMotion(page);
        const panel = await page.locator('.floating-toolbar-panel').boundingBox();
        assert.ok(panel.x + panel.width <= dock.x + 0.5, `${label}: the panel opens beside the button, not under the sheet (${panel.x}+${panel.width}, sheet at ${dock.x})`);
        await touch.tap(centre(typing.fab));
        await page.locator('.floating-toolbar.open').waitFor({ state: 'detached' });
        await settleMotion(page);
        await sheet.getByRole('button', { name: 'Close Type text', exact: true }).click();
        await page.locator('.stream-stage[data-sheet-docked]').waitFor({ state: 'detached' });
        await settleMotion(page);
        const after = await buttonState(page);
        const back = onEdge(`${label} closed`, after, 'right');
        assert.ok(Math.abs(after.fab.right - after.stage.right) < 0.5, `${label}: back at the stage's right edge (${after.fab.right}, stage to ${after.stage.right})`);
        assert.ok(Math.abs(back - edge) < 0.01, `${label}: at the height it had (${back}, was ${edge})`);
        assert.equal(await page.evaluate(() => document.querySelector('.stream-stage') === window.__controlsStage), true, `${label}: the stage is the same element`);
        assert.equal(test.streams, 1, `${label}: one stream socket`);
        assert.deepEqual(test.errors, []);
    } finally {
        await touch.detach().catch(() => undefined);
        await test.context.close();
    }
    console.log(`PASS ${label}: the button and its panel stay beside the sheet, and the stage keeps one stream`);
}

/** With motion reduced, the button let go is at its edge at once. */
async function snapWithoutMotion(browser) {
    const test = await start(browser, 'android', { viewport: PHONE, reducedMotion: 'reduce' });
    const { page } = test;
    const touch = await finger(page);
    try {
        const state = await buttonState(page);
        await touch.drag(centre(state.fab), { x: 60, y: state.fab.top + 30 });
        await dropped(page);
        assert.equal((await buttonState(page)).moving, 0, 'reduced motion: the button does not slide');
        // With motion reduced every property changes over 0.01ms (app.css), which takes effect
        // on the next frame. From then on the button is at its edge, and nothing runs.
        const frames = await page.evaluate(async () => {
            const fab = document.querySelector('.floating-toolbar-fab');
            const seen = [];
            for (let frame = 0; frame < 6; frame++) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
                seen.push({ left: fab.getBoundingClientRect().left, running: document.getAnimations().filter((animation) => animation.playState === 'running' && fab.closest('.floating-toolbar').contains(animation.effect?.target)).length });
            }
            return seen;
        });
        assert.deepEqual(frames.slice(1), frames.slice(1).map(() => ({ left: 0, running: 0 })), `reduced motion: at the edge from the next frame (${JSON.stringify(frames)})`);
        const after = await buttonState(page);
        onEdge('reduced motion', after, 'left');
        assert.deepEqual(test.errors, []);
    } finally {
        await touch.detach().catch(() => undefined);
        await test.context.close();
    }
    console.log('PASS reduced motion: the controls button goes to its edge without moving through the picture');
}

/** WCAG contrast of two sRGB colours. */
function contrast(first, second) {
    const luminance = (rgb) => {
        const [r, g, b] = rgb.map((value) => {
            const unit = value / 255;
            return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
}

/**
 * The idle button over a white and over a black picture, in both themes: its fill or its icon
 * keeps 3:1 against the picture. Measured on the pixels drawn at the pixel ratio of a phone, 3,
 * where the icon's dots cover whole pixels.
 */
async function idleContrast(browser) {
    const ratio = 3;
    for (const viewport of [PHONE, LANDSCAPE]) {
        for (const colorScheme of ['light', 'dark']) {
            const test = await start(browser, 'android', { viewport, colorScheme, deviceScaleFactor: ratio });
            const { page } = test;
            try {
                for (const [name, picture] of [['white', [255, 255, 255]], ['black', [0, 0, 0]]]) {
                    const label = `${viewport.name}-${colorScheme} over ${name}`;
                    // The stage behind the button painted in one colour, in place of the picture.
                    await page.addStyleTag({ content: `.stream-stage .video { background-color: rgb(${picture.join(',')}) !important; } .stream-stage .video-layer { visibility: hidden; }` });
                    await settleMotion(page);
                    const state = await buttonState(page);
                    assert.equal(state.opacity, state.idleOpacity, `${label}: the button is idle`);
                    const beside = 80;
                    const clip = { x: state.fab.left - beside, y: state.fab.top, width: state.fab.width + beside, height: state.fab.height };
                    const png = await page.screenshot({ clip, scale: 'device', animations: 'disabled' });
                    const pixels = await page.evaluate(async (base64) => {
                        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
                        const bitmap = await window.createImageBitmap(new Blob([bytes], { type: 'image/png' }));
                        const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
                        canvas.getContext('2d').drawImage(bitmap, 0, 0);
                        return { width: bitmap.width, data: Array.from(canvas.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height).data) };
                    }, png.toString('base64'));
                    // A point in CSS pixels from the top left of the clip.
                    const at = (x, y) => {
                        const index = (Math.round(y * ratio) * pixels.width + Math.round(x * ratio)) * 4;
                        return pixels.data.slice(index, index + 3);
                    };
                    const middle = state.fab.height / 2;
                    assert.deepEqual(at(4, middle), picture, `${label}: the picture beside the button`);
                    const fill = at(beside + 5, middle);
                    // The icon: the pixel of the 24px icon box that differs most from the fill.
                    let icon = fill;
                    for (let y = middle - 12; y < middle + 12; y += 1 / ratio) {
                        for (let x = beside + state.fab.width / 2 - 12; x < beside + state.fab.width / 2 + 12; x += 1 / ratio) {
                            if (contrast(at(x, y), fill) > contrast(icon, fill)) icon = at(x, y);
                        }
                    }
                    const best = Math.max(contrast(fill, picture), contrast(icon, picture));
                    assert.ok(best >= 3, `${label}: the idle button keeps 3:1 against the picture (fill ${contrast(fill, picture).toFixed(2)}, icon ${contrast(icon, picture).toFixed(2)})`);
                    console.log(`  ${label}: fill ${contrast(fill, picture).toFixed(2)}:1, icon ${contrast(icon, picture).toFixed(2)}:1`);
                    await shot(page, `android-button-${viewport.name}-${colorScheme}-${name}`);
                }
                assert.deepEqual(test.errors, []);
            } finally {
                await test.context.close();
            }
        }
    }
    console.log('PASS the idle controls button keeps 3:1 against a white and a black picture, light and dark');
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        await Promise.all([
            ONLY && ONLY !== 'button'
                ? undefined
                : (async () => {
                      for (const platform of ['android', 'ios']) {
                          for (const viewport of [PHONE, LANDSCAPE]) await touchButton(browser, platform, viewport);
                      }
                      for (const platform of ['android', 'ios']) {
                          await panelAboveTypeText(browser, platform);
                          await followsTypingView(browser, platform);
                          await besideDockedSheet(browser, platform);
                      }
                      await snapWithoutMotion(browser);
                      await idleContrast(browser);
                  })(),
            ONLY && ONLY !== 'sends'
                ? undefined
                : (async () => {
                      await sends(browser, 'android');
                      await sends(browser, 'ios');
                  })(),
            ONLY
                ? undefined
                : (async () => {
                      await slotMap(browser);
                  })(),
            ONLY && ONLY !== 'rail' ? undefined : railCaptions(browser),
            ONLY
                ? undefined
                : (async () => {
                      for (const platform of ['android', 'ios']) {
                          await disabledWithoutConnection(browser, platform);
                          for (const viewport of [PHONE, DESKTOP]) await holds(browser, platform, viewport);
                      }
                  })(),
        ]);
    } finally {
        await browser.close();
    }
}

module.exports = { start, openPanel };
if (require.main === module) main().catch((error) => {
    console.error(error);
    process.exit(1);
});
