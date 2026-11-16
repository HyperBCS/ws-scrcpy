// node scripts/test-browser.js ios-colour      (E2E_OUT=/tmp/ws-scrcpy-ios-colour for screenshots)
// The picture colour range of an iPhone, against fixture sockets. Headless Chromium has no HEVC
// decoder, so a fixture VideoDecoder records the config the page hands it; no check here can see
// the picture.
//   - the decoder config of the iPhone header carries colorSpace with fullRange true and BT.709;
//   - Settings, About shows what the stream declares and the Picture colour range row;
//   - Limited, Full and Auto configure the decoder again and ask for one key frame each time the
//     colour changes, on the same socket, with the same stream mount: no new session;
//   - the choice is kept in this browser and applies at the next open;
//   - at 440x956 (touch) and 1440x900 (mouse), light and dark.
// No device, adb or pymobiledevice3 is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { settleMotion } = require('./ui-motion');

// Only through test-browser.js, which serves the build on a port of its own. Without it this
// would open a stream on the live server.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js ios-colour');
    process.exit(1);
}
const BASE = new URL(process.env.BASE);
assert.ok(['127.0.0.1', 'localhost'].includes(BASE.hostname) && !['8000', '8010', '18100'].includes(BASE.port),
    'a loopback fixture origin, never the phone server');
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-ios-colour';
const UDID = 'fixture-iphone-colour';
const STORAGE_KEY = 'ws-scrcpy.iphone.colour-range';
// The /codec record of the bench iPhone: its VPS, SPS and PPS (full range, colour space unspecified).
const HVCC = Buffer.from(
    '010160000000b0000000000096f000fcfdf8f800000b03200001001840011c01ffff016000000300b000000300000300960cc090' +
        '210001003f420111016000000300b000000300000300964800a22002c05880cee45218b9fc4fc2fe86fd43fea823f5504feaa82bf55505feaaa833f555529b8101010040' +
        '2200010008440148072f05b240',
    'hex',
);
// The fixture decoder turns each key frame into a picture of this size.
const VIDEO = { width: 324, height: 704 };
const BT709_FULL = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true };
const BT709_LIMITED = { ...BT709_FULL, fullRange: false };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

async function open(browser, { width, height, touch, theme }) {
    const context = await browser.newContext({
        viewport: { width, height },
        isMobile: touch,
        hasTouch: touch,
        colorScheme: theme,
        serviceWorkers: 'block',
    });
    await context.addInitScript(({ width, height }) => {
        // Every config the page hands a decoder, in order, across page loads of this context.
        const configs = JSON.parse(sessionStorage.getItem('colour-configs') || '[]');
        window.__colourConfigs = configs;
        window.VideoDecoder = class {
            static async isConfigSupported() {
                return { supported: true };
            }
            constructor({ output }) {
                this.output = output;
                this.state = 'unconfigured';
            }
            configure(config) {
                configs.push({ codec: config.codec, colorSpace: config.colorSpace, bytes: config.description.byteLength });
                sessionStorage.setItem('colour-configs', JSON.stringify(configs));
                this.state = 'configured';
            }
            decode(chunk) {
                const canvas = new window.OffscreenCanvas(width, height);
                canvas.getContext('2d').fillRect(0, 0, width, height);
                this.output(new window.VideoFrame(canvas, { timestamp: chunk.timestamp }));
            }
            close() {
                this.state = 'closed';
            }
        };
    }, VIDEO);
    const page = await context.newPage();
    const errors = [];
    const messages = [];
    let sessions = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/notifications/**', (route) =>
        route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }),
    );
    await page.routeWebSocket('**', (socket) => {
        const target = new URL(socket.url());
        assert.equal(target.hostname, BASE.hostname);
        assert.equal(target.port, BASE.port);
        if (target.searchParams.get('action') === 'proxy-coredevice') {
            sessions++;
            let live = true;
            socket.onClose(() => {
                live = false;
            });
            // A key frame, the way the phone answers a request for one.
            const keyFrame = () => live && !page.isClosed() && socket.send(Buffer.from([0, 0, 0, 0, 1, 0x26]));
            socket.onMessage((data) => {
                if (typeof data !== 'string') return;
                const message = JSON.parse(data);
                messages.push(message);
                if (message.type === 'pli') setTimeout(keyFrame, 30);
            });
            setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 50);
            setTimeout(() => socket.send(JSON.stringify({ type: 'codec', codec: 'hev1.1.6.L150.B0', description: HVCC.toString('base64') })), 80);
            setTimeout(keyFrame, 150);
            return;
        }
        socket.onMessage((data) => {
            const frame = Buffer.from(data);
            if (frame.length < 5 || frame[0] !== 4) return;
            const id = frame.readUInt32LE(1);
            const code = frame.subarray(5).toString();
            if (code === 'HSTS') socket.send(channelJson(id, { id: -1, type: 'hosts', data: { local: [{ type: 'ios' }] } }));
            if (code === 'ATRC') {
                const phone = {
                    udid: UDID, name: 'iPhone fixture', state: 'Connected', model: 'iPhone 13 Pro Max', version: '27.2',
                    paired: true, developerMode: true, session: 'ready', 'screen.power': 'on', 'device.locked': false,
                };
                socket.send(channelJson(id, { id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [phone] } }));
            }
        });
    });
    const test = { context, page, errors, messages, sessions: () => sessions };
    await load(test);
    return test;
}

/** Opens the iPhone's screen; `again` reloads the page, the next open of the same screen. */
async function load(test, again = false) {
    const { page } = test;
    if (again) {
        await page.reload();
    } else {
        const url = new URL(BASE);
        url.hash = `!${new URLSearchParams({ action: 'device', udid: UDID, view: 'screen' })}`;
        await page.goto(url.toString());
    }
    await page.locator('.kit-bar-status', { hasText: 'Connected' }).waitFor();
    await page.waitForFunction((width) => document.querySelector('.stream-mount .touch-layer')?.width === width, VIDEO.width);
    await page.locator('.stream-mount').evaluate((node) => {
        window.__colourMount = node;
    });
}

const configs = (page) => page.evaluate(() => window.__colourConfigs);
const pli = (test) => test.messages.filter((message) => message.type === 'pli').length;

async function waitFor(predicate, what, timeout = 4000) {
    const until = Date.now() + timeout;
    while (!(await predicate())) {
        if (Date.now() > until) throw new Error(`Timed out: ${what}`);
        await pause(20);
    }
}

async function openSettings(test, touch) {
    const { page } = test;
    const direct = page.getByRole('button', { name: 'Settings', exact: true });
    if (!(await direct.isVisible())) {
        const control = page.locator('.control-buttons-list [title="Settings"]');
        if (touch && !(await control.isVisible())) {
            await page.locator('.floating-toolbar-fab').click();
            await settleMotion(page);
        }
        await control.click();
    } else {
        await direct.click();
    }
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.waitFor();
    await settleMotion(page);
    return dialog;
}

/** Choose a range and wait until the page has handled it. */
async function choose(test, row, label) {
    await row.locator('label.kit-segment', { hasText: label }).click();
    await row.getByRole('radio', { name: label, exact: true, checked: true }).waitFor();
    await settleMotion(test.page);
    await pause(150);
}

async function view(browser, { name, width, height, touch, theme }) {
    const label = `${name}-${theme}`;
    const test = await open(browser, { width, height, touch, theme });
    const { page } = test;
    try {
        await waitFor(async () => (await configs(page)).length >= 1, `${label}: the decoder is configured`);
        const first = await configs(page);
        assert.equal(first.length, 1, `${label}: one decoder config at the start`);
        assert.deepEqual(first[0], { codec: 'hev1.1.6.L150.B0', colorSpace: BT709_FULL, bytes: HVCC.length },
            `${label}: the iPhone header is handed over as full range BT.709`);

        const dialog = await openSettings(test, touch);
        const about = dialog.locator('[data-section="about"]');
        const fact = about.locator('[data-fact="colour"]');
        await fact.scrollIntoViewIfNeeded();
        assert.equal(await fact.locator('.kit-row-title').textContent(), 'Stream colour');
        assert.equal(await fact.locator('.kit-row-value').textContent(), 'Full range, colour space not declared');
        const row = about.locator('[data-setting="colour-range"]');
        assert.equal(await row.locator('.kit-row-title').textContent(), 'Picture colour range');
        assert.equal(await row.locator('.kit-row-desc').textContent(),
            'Auto uses what the stream declares. Full and Limited override it in this browser.');
        assert.deepEqual(await row.getByRole('radio').evaluateAll((inputs) => inputs.map((input) => [input.parentElement.textContent, input.checked])),
            [['Auto', true], ['Full', false], ['Limited', false]], `${label}: Auto by default`);
        assert.equal(await about.locator('.settings-picture .kit-group-title').textContent(), 'Picture');
        // The row fits its card at this width: no part of the control is cut off or scrolls.
        const fit = await row.evaluate((node) => {
            const card = node.closest('.kit-card').getBoundingClientRect();
            const control = node.querySelector('.kit-segmented').getBoundingClientRect();
            return { inside: control.left >= card.left - 1 && control.right <= card.right + 1, scroll: node.scrollWidth <= node.clientWidth + 1 };
        });
        assert.deepEqual(fit, { inside: true, scroll: true }, `${label}: the choice fits its row`);
        assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, `${label}: no horizontal scroll`);
        await row.scrollIntoViewIfNeeded();
        await settleMotion(page);
        await page.screenshot({ path: path.join(OUT, `ios-colour-${label}-auto.png`) });

        // Limited: a new config, one key frame request, the same session and mount.
        await choose(test, row, 'Limited');
        await waitFor(async () => (await configs(page)).length === 2, `${label}: Limited configures the decoder again`);
        assert.deepEqual((await configs(page))[1].colorSpace, BT709_LIMITED, `${label}: Limited is limited range`);
        assert.equal(pli(test), 1, `${label}: one key frame request`);
        assert.equal(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY), 'limited', `${label}: kept in this browser`);
        await page.screenshot({ path: path.join(OUT, `ios-colour-${label}-limited.png`) });

        await choose(test, row, 'Full');
        await waitFor(async () => (await configs(page)).length === 3, `${label}: Full configures the decoder again`);
        assert.deepEqual((await configs(page))[2].colorSpace, BT709_FULL);
        assert.equal(pli(test), 2);

        // Auto is what the stream declares, full range, so the decoder stays as it is.
        await choose(test, row, 'Auto');
        await pause(300);
        assert.equal((await configs(page)).length, 3, `${label}: Auto (full for this stream) keeps the decoder`);
        assert.equal(pli(test), 2, `${label}: and asks nothing of the phone`);

        assert.equal(test.sessions(), 1, `${label}: one screen session for every change`);
        assert.equal(await page.locator('.stream-mount').evaluate((node) => node === window.__colourMount), true,
            `${label}: the stream view is not mounted again`);
        assert.equal(await page.locator('.stream-mount .touch-layer').count(), 1, `${label}: one picture`);
        const sent = [...new Set(test.messages.map((message) => message.type))];
        assert.ok(sent.every((type) => ['pli', 'keyboard-detach'].includes(type)), `${label}: nothing else reaches the phone (${sent})`);

        // Limited is applied when the screen is opened again.
        await choose(test, row, 'Limited');
        await waitFor(async () => (await configs(page)).length === 4, `${label}: Limited again`);
        await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await load(test, true);
        await waitFor(async () => (await configs(page)).length === 5, `${label}: the next open configures the decoder`);
        assert.deepEqual((await configs(page))[4].colorSpace, BT709_LIMITED, `${label}: with the range kept in this browser`);
        assert.equal(test.sessions(), 2, `${label}: the reload is the one new session`);
        const again = await openSettings(test, touch);
        const kept = again.locator('[data-setting="colour-range"]');
        await kept.scrollIntoViewIfNeeded();
        assert.equal(await kept.getByRole('radio', { name: 'Limited', exact: true }).isChecked(), true);
        assert.deepEqual(test.errors, [], `${label}: no browser runtime errors`);
    } finally {
        await test.context.close();
    }
    console.log(`PASS ${label}: colorSpace for the iPhone header, the Stream colour fact, Limited/Full/Auto in place with one key frame request each, kept for the next open`);
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        for (const theme of ['light', 'dark']) {
            await view(browser, { name: '440x956-touch', width: 440, height: 956, touch: true, theme });
            await view(browser, { name: '1440x900-mouse', width: 1440, height: 900, touch: false, theme });
        }
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
