// node scripts/test-browser.js controls      (E2E_OUT=/tmp/ws-scrcpy-controls for screenshots)
// The controls of a phone's screen, on an Android phone and an iPhone, against socket fixtures:
//   - one slot map: the same control in the same cell of the panel (390x844) and the same place
//     in the rail (1280x800), an empty cell where a phone lacks the control, light and dark;
//   - what each control sends or opens, found by its icon, not its name;
//   - a key of the phone is disabled while there is no connection, and only the keys;
//   - holding Lock sends one down and one up, and a key held when the panel closes or the
//     window loses focus is let go once.
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
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The cells of the slot map: row and column in the grid of three. */
const SHARED = {
    'Volume down': [2, 1], 'Mute phone': [2, 2], 'Volume up': [2, 3],
    Lock: [3, 1], Listen: [3, 2], 'Take screenshot': [3, 3],
    'Type text': [4, 1], Actions: [4, 2], Settings: [4, 3],
};
const SLOTS = {
    android: { Back: [1, 1], Home: [1, 2], Overview: [1, 3], ...SHARED },
    ios: { Home: [1, 2], ...SHARED, Siri: [5, 1] },
};
/** The keys of the phone: they need a connection. */
const KEYS = {
    android: ['Back', 'Home', 'Overview', 'Volume down', 'Mute phone', 'Volume up', 'Lock'],
    ios: ['Home', 'Volume down', 'Mute phone', 'Volume up', 'Lock', 'Siri'],
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
async function start(browser, platform, { viewport = DESKTOP, colorScheme = 'light' } = {}) {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile,
        colorScheme, serviceWorkers: 'block', acceptDownloads: true,
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
            if (code === 'GTRC') send({ id: -1, type: 'devicelist', data: { id: 'android', name: 'Fixture host', list: [ANDROID] } });
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

/** Each control's cell: row and column in the panel, or row of the one column in the rail. */
async function cells(page, mobile) {
    return page.locator('.control-buttons-list').evaluate((list, mobile) => {
        const box = list.getBoundingClientRect();
        const buttons = [...list.querySelectorAll(':scope > button')];
        const height = buttons[0].getBoundingClientRect().height + (parseFloat(getComputedStyle(list).rowGap) || 0);
        const width = box.width / (mobile ? 3 : 1);
        return Object.fromEntries(buttons.map((button) => {
            const rect = button.getBoundingClientRect();
            const row = Math.floor((rect.top + rect.height / 2 - box.top) / height) + 1;
            const column = Math.floor((rect.left + rect.width / 2 - box.left) / width) + 1;
            return [button.getAttribute('aria-label'), mobile ? [row, column] : [row, 1]];
        }));
    }, mobile);
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
                    found[platform] = await cells(page, viewport.mobile);
                    const wanted = Object.fromEntries(Object.entries(SLOTS[platform]).map(([name, [row, column]]) => [name, viewport.mobile ? [row, column] : [(row - 1) * 3 + column, 1]]));
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
            for (const name of Object.keys(SHARED).concat('Home')) {
                assert.deepEqual(found.ios[name], found.android[name], `${viewport.name}-${colorScheme}: ${name} has one place on both kinds of phone`);
            }
            const taken = (cell) => Object.values(found.ios).some((other) => other.join() === cell.join());
            const empty = viewport.mobile ? [[1, 1], [1, 3]] : [[1, 1], [3, 1]];
            assert.deepEqual(empty.filter(taken), [], `${viewport.name}-${colorScheme}: the iPhone leaves the cells of Back and Overview empty`);
        }
    }
    console.log('PASS one slot map on both kinds of phone, with empty cells, in the panel and the rail, light and dark');
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

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        await Promise.all([
            (async () => {
                await sends(browser, 'android');
                await sends(browser, 'ios');
            })(),
            ONLY === 'sends'
                ? undefined
                : (async () => {
                      await slotMap(browser);
                  })(),
            ONLY === 'sends'
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

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
