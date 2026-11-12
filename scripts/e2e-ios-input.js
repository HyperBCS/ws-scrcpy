// node scripts/test-browser.js ios-input      (E2E_OUT=/tmp/ws-scrcpy-ios-input for screenshots)
// The mouse on an iPhone's picture, against fixture sockets: every touch message is captured in
// the browser and nothing reaches a phone.
//   - the wheel is one short swipe at the pointer, and a fast wheel starts few of them;
//   - a drag that leaves the picture rides its edge and lifts once where the button comes up;
//   - right-click sends nothing and opens no browser menu;
//   - Ctrl+drag sends two contacts mirrored through the middle, and both lift together;
//   - while the Actions sheet is open a wheel does not reach the phone;
//   - one screen session per visit;
//   - the Mouse and keyboard row of the Actions sheet lists this, at 390x844 and 1280x800, light
//     and dark.
// No device, adb or pymobiledevice3 is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { settleMotion } = require('./ui-motion');

// Only through test-browser.js, which serves the build on a port of its own. Without it this
// would open a stream on the live server.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js ios-input');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-ios-input';
const UDID = 'fixture-iphone-input';
// The fixture's decoder turns every key frame into a picture of this size.
const VIDEO = { width: 428, height: 926 };
const HID = 65535;
// What the Mouse and keyboard row lists for an iPhone.
const MOUSE_HELP = [
    'Wheel: scrolls with a short swipe.',
    'Drag: swipes, and keeps going past the edge of the picture.',
    'Right-click: nothing. This phone has no Back button.',
    'Ctrl+drag: pinches around the middle. With Shift too, around where you pressed.',
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

async function open(browser, { mobile, dark, scale = 1 }) {
    const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme: dark ? 'dark' : 'light',
        deviceScaleFactor: scale,
    });
    // A picture of the phone: the socket announces a codec and sends key frames, and this
    // decoder turns each into a frame of the phone's size.
    await context.addInitScript(({ width, height }) => {
        window.VideoDecoder = class {
            static async isConfigSupported() {
                return { supported: true };
            }
            constructor({ output }) {
                this.output = output;
                this.state = 'unconfigured';
            }
            configure() {
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
    const sent = [];
    let sessions = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/notifications/**', (route) =>
        route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }),
    );
    await page.routeWebSocket('**', (socket) => {
        const target = new URL(socket.url());
        if (target.searchParams.get('action') === 'proxy-coredevice') {
            sessions++;
            let live = true;
            socket.onClose(() => {
                live = false;
            });
            socket.onMessage((data) => {
                if (typeof data === 'string') sent.push({ at: Date.now(), ...JSON.parse(data) });
            });
            setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 50);
            setTimeout(
                () => socket.send(JSON.stringify({ type: 'codec', codec: 'hev1.1.6.L150.B0', description: Buffer.from([1]).toString('base64') })),
                80,
            );
            // A key frame now and then: the first may come before the decoder is ready.
            const frame = () => {
                if (!live || page.isClosed()) return;
                socket.send(Buffer.from([0, 0, 0, 0, 1, 0x26]));
                setTimeout(frame, 250).unref();
            };
            setTimeout(frame, 150);
            return;
        }
        socket.onMessage((data) => {
            const message = Buffer.from(data);
            if (message.length < 5 || message[0] !== 4) return;
            const id = message.readUInt32LE(1);
            if (message.subarray(5).toString() === 'HSTS') {
                socket.send(channelJson(id, { id: -1, type: 'hosts', data: { local: [{ type: 'ios' }] } }));
            } else if (message.subarray(5).toString() === 'ATRC') {
                const phone = { udid: UDID, name: 'iPhone fixture', state: 'Connected', model: 'iPhone', version: '27', paired: true, developerMode: true, session: 'ready', 'screen.power': 'on', 'device.locked': false };
                socket.send(channelJson(id, { id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [phone] } }));
            }
        });
    });
    const url = new URL(BASE);
    url.hash = `!${new URLSearchParams({ action: 'stream-coredevice', udid: UDID })}`;
    await page.goto(url.toString());
    await page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.includes('Connected'));
    await page.waitForFunction((width) => document.querySelector('.stream-mount .touch-layer')?.width === width, VIDEO.width);
    return { context, page, errors, sent, sessions: () => sessions };
}

/** The touch messages sent while `act` ran, once the page has gone quiet. */
async function touchesDuring(test, act, quiet = 400) {
    const before = test.sent.length;
    await act();
    await pause(quiet);
    return test.sent.slice(before).filter((message) => message.type === 'touch' || message.type === 'touch-frame');
}

/** A share of the picture in the 0..65535 the touch messages carry, within rounding. */
const near = (value, share, slack = 200) => Math.abs(value - share * HID) <= slack;

async function mouse(test, label) {
    const { page } = test;
    const picture = await page.locator('.stream-mount .touch-layer').boundingBox();
    const at = (fx, fy) => [picture.x + fx * picture.width, picture.y + fy * picture.height];

    // One wheel notch: a touch down at the pointer, moves up a fifth of the screen, one lift.
    await page.mouse.move(...at(0.5, 0.5));
    const swipe = await touchesDuring(test, () => page.mouse.wheel(0, 100));
    assert.deepEqual(
        swipe.map((message) => message.op),
        ['contact', 'contact', 'contact', 'contact', 'contact', 'contact', 'release'],
        `${label}: a wheel notch is a down, five moves and an up`,
    );
    assert(near(swipe[0].x, 0.5) && near(swipe[0].y, 0.5), `${label}: the swipe starts at the pointer`);
    assert(swipe.every((message) => near(message.x, 0.5)), `${label}: it goes straight up`);
    const ys = swipe.map((message) => message.y);
    assert(ys.slice(1).every((y, index) => y <= ys[index]), `${label}: the finger moves up to scroll down (${ys})`);
    assert(near(ys.at(-1), 0.3), `${label}: by a fifth of the screen (${ys.at(-1)})`);

    // A fast wheel: twenty notches as fast as the browser takes them start few swipes.
    await pause(500);
    const started = Date.now();
    const fast = await touchesDuring(test, async () => {
        for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 100);
    });
    const elapsed = Date.now() - started;
    const downs = fast.filter((message, index) => message.op === 'contact' && (index === 0 || fast[index - 1].op === 'release')).length;
    const ups = fast.filter((message) => message.op === 'release').length;
    assert.equal(downs, ups, `${label}: every swipe lifts once`);
    assert(ups >= 1 && ups <= Math.floor(elapsed / 400) + 1, `${label}: ${ups} swipes in ${elapsed} ms, at most one per 400 ms`);
    assert.equal(fast.length, ups * 7, `${label}: and nothing else`);

    // A drag that leaves the picture rides the right edge, goes up over the bar above it and
    // lifts where the button comes up: the top right corner.
    await pause(500);
    const right = picture.x + picture.width + 30;
    const drag = await touchesDuring(test, async () => {
        await page.mouse.move(...at(0.5, 0.5));
        await page.mouse.down();
        await page.mouse.move(right, picture.y + picture.height / 2, { steps: 4 });
        await page.mouse.move(right, picture.y - 10, { steps: 4 });
        await page.mouse.up();
    }, 200);
    assert.equal(drag[0].op, 'contact');
    assert(drag.some((message) => message.op === 'contact' && message.x === HID && message.y > 0), `${label}: it rode the right edge`);
    assert.deepEqual(
        drag.filter((message) => message.op === 'release').map(({ x, y }) => [x, y]),
        [[HID, 0]],
        `${label}: one lift, where the button came up`,
    );
    assert.equal(drag.at(-1).op, 'release');

    // Right-click: nothing reaches the phone and the browser's menu stays shut.
    await page.evaluate(() => {
        window.__menus = [];
        document.addEventListener('contextmenu', (event) => window.__menus.push(event.defaultPrevented));
    });
    const rightClick = await touchesDuring(test, () => page.mouse.click(...at(0.5, 0.5), { button: 'right' }), 200);
    assert.deepEqual(rightClick, [], `${label}: right-click sends nothing`);
    assert.deepEqual(await page.evaluate(() => window.__menus), [true], `${label}: no browser menu over the picture`);

    // Ctrl+drag: two contacts in every frame, mirrored through the middle; both lift together.
    const pinch = await touchesDuring(test, async () => {
        await page.keyboard.down('Control');
        await page.mouse.move(...at(0.25, 0.25));
        await page.mouse.down();
        await page.mouse.move(...at(0.4, 0.35), { steps: 3 });
        await page.mouse.up();
        await page.keyboard.up('Control');
    }, 200);
    assert(pinch.length >= 2, `${label}: the pinch reaches the phone`);
    assert(pinch.every((message) => message.type === 'touch-frame' && message.contacts.length === 2), `${label}: as frames of two contacts`);
    for (const { contacts } of pinch) {
        const [finger, mirror] = contacts;
        assert.deepEqual([finger.id, mirror.id], [0, 1]);
        assert(Math.abs(finger.x + mirror.x - HID) <= 2 && Math.abs(finger.y + mirror.y - HID) <= 2, `${label}: mirrored (${JSON.stringify(contacts)})`);
    }
    assert(near(pinch[0].contacts[0].x, 0.25) && near(pinch[0].contacts[0].y, 0.25), `${label}: the first finger is where it was aimed`);
    assert.deepEqual(pinch.at(-1).contacts.map((contact) => contact.touching), [false, false], `${label}: both lift together`);
    assert.equal(pinch.filter((message) => message.contacts.every((contact) => !contact.touching)).length, 1, `${label}: once`);
}

async function mouseHelp(test, label, mobile) {
    const { page } = test;
    const actionsControl = page.locator('.control-buttons-list [title="Actions"]');
    if (mobile && !(await actionsControl.isVisible())) {
        await page.locator('.floating-toolbar-fab').click();
        await settleMotion(page);
    }
    await actionsControl.click();
    const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
    await actions.waitFor();
    await settleMotion(page);
    const picture = await page.locator('.stream-mount .touch-layer').boundingBox();
    const middle = [picture.x + picture.width / 2, picture.y + picture.height / 2];
    if (!mobile) {
        // The sheet is modal: a wheel over the picture, or beside the panel, does not reach the
        // phone. Each wheel comes after the 400 ms between swipes, so the limit is not the reason.
        const panel = await actions.locator('.kit-sheet-panel').boundingBox();
        const wheeled = await touchesDuring(test, async () => {
            for (const spot of [middle, [panel.x / 2, panel.y + panel.height / 2]]) {
                await pause(450);
                await page.mouse.move(...spot);
                await page.mouse.wheel(0, 100);
            }
        });
        assert.deepEqual(wheeled, [], `${label}: a wheel under the open sheet does not reach the phone`);
    }
    const help = actions.locator('.kit-row[data-mouse-help]');
    assert.equal(await help.locator('.kit-row-title').textContent(), 'Mouse and keyboard');
    assert.equal(
        await help.evaluate((row) => row.parentElement.lastElementChild === row && row.closest('section.kit-group').querySelector('.kit-group-title').textContent),
        'Screen',
        `${label}: the last row of Screen`,
    );
    await help.scrollIntoViewIfNeeded();
    const show = help.getByRole('button', { name: 'Show', exact: true });
    assert.equal(await show.getAttribute('aria-expanded'), 'false');
    await show.click();
    const hide = help.getByRole('button', { name: 'Hide', exact: true });
    await hide.waitFor();
    assert.equal(await hide.getAttribute('aria-expanded'), 'true');
    assert.deepEqual((await help.locator('.kit-row-desc').innerText()).split('\n'), MOUSE_HELP, `${label}: the lines for an iPhone`);
    assert(await actions.locator('.kit-sheet-body').evaluate((body) => body.scrollWidth <= body.clientWidth + 1), `${label}: the lines fit the sheet`);
    await page.waitForFunction(() => {
        const row = document.querySelector('[data-mouse-help]');
        return row && row.getBoundingClientRect().bottom <= row.closest('.auto-height').getBoundingClientRect().bottom + 1;
    });
    await settleMotion(page);
    await help.scrollIntoViewIfNeeded();
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, `${label}-mouse-help.png`) });
    await hide.click();
    await show.waitFor();
    assert.equal(await help.locator('.kit-row-desc').textContent(), 'What the mouse does on this phone.');
    await page.keyboard.press('Escape');
    await actions.waitFor({ state: 'hidden' });
    if (!mobile) {
        await settleMotion(page);
        // From 1024px Actions stands beside the picture, which is centred again once it has gone
        // (p6-desktop-layout): the middle is measured again.
        const shut = await page.locator('.stream-mount .touch-layer').boundingBox();
        const control = await touchesDuring(test, async () => {
            await pause(450);
            await page.mouse.move(shut.x + shut.width / 2, shut.y + shut.height / 2);
            await page.mouse.wheel(0, 100);
        });
        assert.equal(control.filter((message) => message.op === 'release').length, 1, `${label}: positive control: with the sheet shut the wheel swipes`);
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const [label, mobile, dark, scale] of [
            ['desktop-light', false, false, 1],
            // The pointer lands in the same place at another pixel ratio.
            ['desktop-dark', false, true, 2],
            ['phone-light', true, false, 1],
            ['phone-dark', true, true, 1],
        ]) {
            const test = await open(browser, { mobile, dark, scale });
            try {
                if (!mobile) await mouse(test, label);
                await mouseHelp(test, label, mobile);
                assert.equal(test.sessions(), 1, `${label}: one screen session for the visit`);
                assert.deepEqual(test.errors, [], `${label}: no browser runtime errors`);
            } finally {
                await test.context.close();
            }
            console.log(`PASS ${label}: ${mobile ? '' : 'wheel swipe, drag off the picture, right-click, Ctrl+drag pinch, no wheel under a sheet, '}mouse help`);
        }
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
