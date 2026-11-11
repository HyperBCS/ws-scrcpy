/* eslint-disable */
// node scripts/test-browser.js sheet-chrome      (E2E_OUT=/tmp/ws-scrcpy-sheet-chrome for screenshots)
// Sheets, stream chrome and shared UI: moving between sheets, Escape with a confirm prompt open,
// typing while the phone picture stays usable, Copy here over plain HTTP, the error boundary,
// the Listen control, message placement, spacing, contrast and labels. Every socket is a fixture;
// nothing reaches a phone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { fixture, UDID } = require('./e2e-settings');
const { initialStreamPacket } = require('./e2e-sheets');
const { settleMotion } = require('./ui-motion');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-sheet-chrome';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const IOS_UDID = 'fixture-iphone-sheets';
const ANDROID_NAME = 'Fixture Foldable device with a descriptive model name';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}
function clipboardMessage(text) {
    const body = Buffer.from(text);
    const frame = Buffer.alloc(14 + 5 + body.length);
    frame.write('scrcpy_message');
    frame.writeInt32BE(body.length, 15);
    body.copy(frame, 19);
    return frame;
}

async function shot(page, name) {
    fs.mkdirSync(OUT, { recursive: true });
    await settleMotion(page);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled' });
}

/** An Android phone on the fixture tracker; `stream` opens its stream page on a fixture socket. */
async function android(browser, { mobile = false, dark = false, stream = true, viewport, init, clipboard } = {}) {
    const context = await browser.newContext({
        viewport: viewport || (mobile ? PHONE : DESKTOP),
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme: dark ? 'dark' : 'light',
    });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    const errors = [];
    const packets = [];
    let controls;
    page.on('pageerror', (error) => errors.push(error.message));
    const commands = await fixture(page, {
        initialPacket: initialStreamPacket(),
        onStreamMessage: (data) => {
            const packet = Buffer.from(data);
            packets.push(packet);
            // GET_CLIPBOARD: answer as the phone would.
            if (packet[0] === 8 && clipboard !== undefined) controls?.send(clipboardMessage(clipboard));
        },
        onStreamReady: (ready) => {
            controls = ready;
        },
    });
    const url = new URL(BASE);
    if (stream) {
        const socket = new URL('/', BASE);
        socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
        socket.search = new URLSearchParams({ action: 'proxy-adb', remote: 'tcp:8886', udid: UDID }).toString();
        url.hash = `!${new URLSearchParams({ action: 'stream', udid: UDID, player: 'webcodecs', ws: socket.toString(), captureKeyboard: '0', fitToScreen: '1' })}`;
    }
    await page.goto(url.toString());
    if (stream) {
        await page.waitForFunction(() => document.querySelector('.stream-header-status')?.textContent.includes('Connected'));
        await page.locator('.touch-layer').waitFor({ state: 'visible' });
    } else {
        await page.locator('.device').filter({ hasText: UDID }).waitFor();
    }
    const touches = () => packets.filter((packet) => packet.length === 32 && packet[0] === 2).length;
    return { context, page, errors, packets, commands, touches, mobile, controls: () => controls };
}

function iphone(extra = {}) {
    return {
        udid: IOS_UDID, name: 'iPhone fixture', state: 'Connected', model: 'iPhone 13 Pro Max', version: '27.2',
        paired: true, developerMode: true, session: 'ready', 'screen.power': 'on', 'device.locked': false,
        unlockSchedule: { enabled: false, time: '03:00', hasPasscode: false, serverTimeZone: 'UTC' }, ...extra,
    };
}

/** An iPhone on the fixture tracker; `stream` opens its stream page. */
async function ios(browser, { mobile = false, dark = false, stream = true, init, viewport, device } = {}) {
    const context = await browser.newContext({
        viewport: viewport || (mobile ? PHONE : DESKTOP), isMobile: mobile, hasTouch: mobile, colorScheme: dark ? 'dark' : 'light',
    });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    const errors = [];
    const sent = [];
    const commands = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        if (new URL(socket.url()).searchParams.get('action') === 'proxy-coredevice') {
            socket.onMessage((data) => {
                if (typeof data === 'string') sent.push(JSON.parse(data));
            });
            setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 50);
            return;
        }
        socket.onMessage((data) => {
            const frame = Buffer.from(data);
            if (frame.length < 5) return;
            const id = frame.readUInt32LE(1);
            const reply = (message) => socket.send(channelJson(id, message));
            if (frame[0] === 4) {
                const code = frame.subarray(5).toString();
                if (code === 'HSTS') reply({ id: -1, type: 'hosts', data: { local: [{ type: 'ios' }] } });
                if (code === 'ATRC') reply({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [iphone(device)] } });
            } else if (frame[0] === 32) {
                commands.push(JSON.parse(frame.subarray(5).toString()));
            }
        });
    });
    const url = new URL(BASE);
    if (stream) url.hash = `!${new URLSearchParams({ action: 'stream-coredevice', udid: IOS_UDID })}`;
    await page.goto(url.toString());
    if (stream) {
        await page.waitForFunction(() => document.querySelector('.stream-header-status')?.textContent.includes('Connected'));
    } else {
        await page.locator(`[data-device-key="ios:${IOS_UDID}"]`).waitFor();
    }
    const keys = () => sent.filter((message) => message.type === 'key');
    return { context, page, errors, sent, commands, keys, mobile };
}

/** Presses a toolbar button by its title, opening the controls panel first on a phone. */
async function toolbar(test, title) {
    const { page } = test;
    const button = page.locator(`.control-buttons-list [title="${title}"]`);
    if (test.mobile && !(await button.isVisible())) {
        await page.locator('.floating-toolbar-fab').click();
        await settleMotion(page);
    }
    await button.click();
    await settleMotion(page);
}
const openDialog = (page) => page.locator('.bottom-sheet-root.open [role="dialog"]');
const sheet = (page, name) => page.getByRole('dialog', { name, exact: true });
const activeIn = (locator) => locator.evaluate((el) => el.contains(document.activeElement));
const activeTitle = (page) => page.evaluate(() => document.activeElement?.getAttribute('title') || document.activeElement?.className || document.activeElement?.tagName);

/** Contrast of an element's text against what is painted behind it, whatever the colour syntax. */
const contrastOf = (locator, property = 'color') =>
    locator.evaluate((el, property) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const paint = (color) => {
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
        };
        context.fillStyle = '#fff';
        context.fillRect(0, 0, 1, 1);
        const chain = [];
        for (let node = property === 'color' ? el : el.parentElement; node; node = node.parentElement) chain.unshift(node);
        chain.forEach((node) => paint(getComputedStyle(node).backgroundColor));
        const background = Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
        paint(getComputedStyle(el)[property]);
        const foreground = Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
        const luminance = (rgb) => {
            const [r, g, b] = rgb.map((value) => {
                value /= 255;
                return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return (high + 0.05) / (low + 0.05);
    }, property);
const fontSize = (locator) => locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

// C-client-ui-3
async function sheetToSheetFocus(browser) {
    const droid = await android(browser);
    try {
        const { page } = droid;
        await toolbar(droid, 'Actions');
        await sheet(page, 'Actions').getByRole('button', { name: 'Open Stream settings', exact: true }).click();
        const settings = sheet(page, 'Stream settings');
        await settings.waitFor();
        // Past the end of the Actions sheet's exit, which is when it used to take focus back.
        await pause(500);
        assert.equal(await activeIn(settings), true, 'focus stays in the sheet that was opened from Actions');
        await page.keyboard.press('Tab');
        assert.equal(await activeIn(settings), true, 'Tab moves inside the new sheet');
        await page.keyboard.press('Escape');
        await settings.waitFor({ state: 'hidden' });
        assert.equal(await activeTitle(page), 'Actions', 'closing the second sheet returns focus to the toolbar button');
        assert.deepEqual(droid.errors, []);
    } finally {
        await droid.context.close();
    }
    const phone = await ios(browser);
    try {
        const { page } = phone;
        await toolbar(phone, 'Actions');
        await sheet(page, 'Actions').locator('.sheet-row', { hasText: 'Type text' }).getByRole('button', { name: 'Open', exact: true }).click();
        await page.locator('.live-text-input').waitFor();
        await pause(500);
        assert.equal(await page.evaluate(() => document.activeElement?.className), 'live-text-input', 'the text field keeps focus after the Actions sheet has gone');
        await page.keyboard.type('a');
        for (let tries = 0; tries < 50 && phone.keys().length < 2; tries++) await pause(20);
        assert.deepEqual(phone.keys().map((message) => message.usages), [[0x04], []], 'typed keys go to the text field, not to a toolbar button');
        await page.keyboard.press('Escape');
        await page.locator('.live-text-overlay').waitFor({ state: 'detached' });
        assert.equal(await activeTitle(page), 'Actions', 'closing Type text returns focus to the toolbar button');
        assert.deepEqual(phone.errors, []);
    } finally {
        await phone.context.close();
    }
    console.log('PASS a sheet opened from another sheet keeps focus, and focus returns to the toolbar when it closes');
}

// P1-carry-escape
async function escapeCancelsPrompt(browser) {
    const test = await ios(browser);
    try {
        const { page } = test;
        await toolbar(test, 'Actions');
        const actions = sheet(page, 'Actions');
        const reboot = actions.getByRole('button', { name: 'Reboot', exact: true }).and(page.locator(':not(.confirm-prompt-button)'));
        const prompt = actions.getByRole('alertdialog');
        await reboot.click();
        await prompt.waitFor();
        await page.keyboard.press('Escape');
        await prompt.waitFor({ state: 'detached' });
        assert.equal(await actions.isVisible(), true, 'the first Escape cancels the prompt and leaves the sheet open');
        assert.equal(await reboot.evaluate((el) => el === document.activeElement), true, 'focus returns to the button that armed it');
        // Focus outside the prompt: a second press on the armed button keeps the prompt up.
        await reboot.click();
        await prompt.waitFor();
        await reboot.click();
        assert.equal(await prompt.count(), 1);
        assert.equal(await reboot.evaluate((el) => el === document.activeElement), true);
        await page.keyboard.press('Escape');
        await prompt.waitFor({ state: 'detached' });
        assert.equal(await actions.isVisible(), true, 'Escape cancels the prompt wherever focus is');
        await page.keyboard.press('Escape');
        await actions.waitFor({ state: 'hidden' });
        assert.equal(test.commands.filter((command) => command.type === 'reboot_device').length, 0, 'nothing was sent');
        assert.deepEqual(test.errors, []);
    } finally {
        await test.context.close();
    }
    console.log('PASS Escape cancels a confirm prompt first and closes the sheet on the second press');
}

// U-stream-5, and the Type text title from U-system-12
async function typeTextKeepsPicture(browser) {
    for (const mobile of [true, false]) {
        const test = await android(browser, { mobile });
        try {
            const { page } = test;
            await toolbar(test, 'Type text');
            const overlay = page.locator('.live-text-overlay');
            await overlay.waitFor();
            await settleMotion(page);
            assert.equal(await page.locator('#live-text-title').textContent(), 'Type text', 'the bar has the name of the button that opens it');
            assert.equal(await page.locator('.live-text-backdrop').count(), 0);
            const picture = await page.locator('.touch-layer').boundingBox();
            const bar = await page.locator('.live-text-bar').boundingBox();
            const point = { x: picture.x + picture.width / 2, y: picture.y + picture.height / 3 };
            assert(point.y < bar.y, 'the test presses the picture, not the bar');
            const before = test.touches();
            for (let press = 0; press < 2; press++) {
                if (mobile) await page.touchscreen.tap(point.x, point.y);
                else await page.mouse.click(point.x, point.y);
                await pause(80);
            }
            assert.equal(await overlay.count(), 1, 'a press on the picture leaves Type text open');
            assert(test.touches() >= before + 4, 'each press reaches the phone as touch down and up');
            assert.equal(await page.evaluate(() => document.activeElement?.className), 'live-text-input', 'the text field keeps focus, so the keyboard stays up');
            const textPackets = () => test.packets.filter((packet) => packet[0] === 1).length;
            const typedBefore = textPackets();
            await page.keyboard.type('a');
            for (let tries = 0; tries < 50 && textPackets() === typedBefore; tries++) await pause(20);
            assert.equal(textPackets(), typedBefore + 1, 'typing continues after the press');
            await shot(page, `type-text-open-${mobile ? 'phone' : 'desktop'}-light`);
            await page.keyboard.press('Escape');
            await overlay.waitFor({ state: 'detached' });
            await toolbar(test, 'Type text');
            await overlay.waitFor();
            await page.locator('.live-text-done').click();
            await overlay.waitFor({ state: 'detached' });
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    // The iPhone stream: the area beside the bar belongs to the picture, not to an overlay.
    const phone = await ios(browser);
    try {
        const { page } = phone;
        await toolbar(phone, 'Type text');
        await page.locator('.live-text-overlay').waitFor();
        await settleMotion(page);
        const mount = await page.locator('.stream-mount').boundingBox();
        const point = { x: mount.x + mount.width / 2, y: mount.y + mount.height / 4 };
        assert.equal(
            await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.live-text-overlay'), point),
            false,
            'nothing of the overlay covers the picture',
        );
        await page.mouse.click(point.x, point.y);
        await pause(100);
        assert.equal(await page.locator('.live-text-overlay').count(), 1, 'a click on the iPhone picture leaves Type text open');
    } finally {
        await phone.context.close();
    }
    console.log('PASS Type text stays open while the picture is pressed, closes with Escape and Done');
}

// C-client-ui-8
async function copyHereOverHttp(browser) {
    const text = 'copied from the phone';
    const test = await android(browser, {
        clipboard: text,
        // Plain HTTP on a LAN address: no async clipboard API, only the selection copy.
        init: () => {
            Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => undefined });
            document.execCommand = (command) => {
                if (command === 'copy') window.__copied = document.activeElement?.value;
                return command === 'copy';
            };
        },
    });
    try {
        const { page } = test;
        assert.equal(await page.evaluate(() => navigator.clipboard), undefined);
        await toolbar(test, 'Actions');
        const actions = sheet(page, 'Actions');
        const copy = actions.getByRole('button', { name: 'Copy here', exact: true });
        assert.equal(await copy.isDisabled(), true, 'nothing to copy before the clipboard is read');
        await actions.getByRole('button', { name: 'Read', exact: true }).click();
        await actions.getByText('Read from the phone.', { exact: true }).waitFor();
        assert.equal(await actions.getByLabel('Phone clipboard').inputValue(), text);
        await copy.click();
        await actions.getByText('Copied to this browser.', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.__copied), text, 'the text was copied without the async clipboard API');
        assert.equal(await copy.evaluate((el) => el === document.activeElement), true, 'focus stays on Copy here');
        assert.equal(await actions.getByText('needs HTTPS', { exact: false }).count(), 0);
        assert.deepEqual(test.errors, []);
    } finally {
        await test.context.close();
    }
    console.log('PASS Android Copy here works without navigator.clipboard');
}

// C-client-ui-6
async function errorBoundary(browser) {
    const test = await android(browser, {
        stream: false,
        // The notifications page asks for this while rendering; make that one read throw.
        init: () => {
            const original = window.matchMedia.bind(window);
            window.matchMedia = (query) => {
                if (query === '(display-mode: standalone)') throw new Error('fixture render failure');
                return original(query);
            };
        },
    });
    try {
        const { page } = test;
        await page.evaluate(() => (location.hash = '#!action=notifications'));
        const failed = page.locator('.screen-failed');
        await failed.waitFor();
        await failed.getByRole('heading', { name: 'This screen failed', exact: true }).waitFor();
        await failed.getByRole('button', { name: 'Reload', exact: true }).waitFor();
        await shot(page, 'screen-failed-desktop-light');
        await failed.getByRole('button', { name: 'Back to devices', exact: true }).click();
        await page.locator('.device').filter({ hasText: UDID }).waitFor();
        assert.equal(await failed.count(), 0, 'the device list is back');
    } finally {
        await test.context.close();
    }
    // A startup chunk that does not download: the page says so and offers Reload.
    const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
    try {
        const page = await context.newPage();
        await page.route(/\/\d+\.bundle\.js$/, (route) => route.abort());
        await page.goto(BASE);
        const failed = page.locator('.screen-failed');
        await failed.waitFor();
        await failed.getByRole('heading', { name: 'The app could not start', exact: true }).waitFor();
        await failed.getByRole('button', { name: 'Reload', exact: true }).waitFor();
        await shot(page, 'app-could-not-start-phone-light');
    } finally {
        await context.close();
    }
    console.log('PASS a failing screen and a failed startup show a message with Reload');
}

// U-stream-13
async function listenControl(browser) {
    const droid = await android(browser);
    try {
        const { page } = droid;
        const listen = page.locator('[data-control="audio"]');
        assert.equal(await listen.getAttribute('title'), 'Listen');
        assert.equal(await listen.getAttribute('aria-label'), 'Listen');
        assert.equal(await listen.locator('.floating-control-label').count(), 1, 'one caption');
        const icon = (locator) => locator.locator('svg path').first().getAttribute('d');
        for (const key of ['Mute device', 'Volume up', 'Volume down']) {
            assert.notEqual(await icon(listen), await icon(page.locator(`.control-buttons-list [title="${key}"]`)), `Listen is not drawn like ${key}`);
        }
        await shot(page, 'toolbar-listen-desktop-light');
        await toolbar(droid, 'Actions');
        const actions = sheet(page, 'Actions');
        await actions.getByRole('heading', { name: 'Sound', exact: true }).waitFor();
        await actions.getByText('Listen in this browser', { exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await actions.waitFor({ state: 'hidden' });
        await toolbar(droid, 'Settings');
        const settings = sheet(page, 'Stream settings');
        await settings.waitFor();
        const copy = await settings.textContent();
        assert.doesNotMatch(copy, /Mute sound|tap Sound|or Sound/, 'the sheet says Listen, not Sound or Mute');
    } finally {
        await droid.context.close();
    }
    const phone = await ios(browser, { mobile: true });
    try {
        const { page } = phone;
        await page.locator('.floating-toolbar-fab').click();
        await settleMotion(page);
        const listen = page.locator('[data-control="audio"]');
        assert.equal(await listen.getAttribute('title'), 'Listen');
        assert.equal(await listen.locator('.floating-control-label').textContent(), 'Listen');
        await shot(page, 'toolbar-listen-iphone-phone-light');
        await toolbar(phone, 'Actions');
        await sheet(page, 'Actions').getByText('Listen in this browser', { exact: true }).waitFor();
    } finally {
        await phone.context.close();
    }
    console.log('PASS Listen has its own name and icon on the toolbar and its rows in both Actions sheets');
}

// U-settings-11
async function desktopDialogTop(browser) {
    const test = await ios(browser, {
        viewport: { width: 1440, height: 900 },
        device: { 'device.locked': true, unlockSchedule: { enabled: false, time: '03:00', hasPasscode: true, serverTimeZone: 'UTC' } },
    });
    try {
        const { page } = test;
        await page.locator('.lock-screen-notice').getByRole('button', { name: 'Unlock', exact: true }).click();
        const dialog = sheet(page, 'Unlock device');
        await dialog.waitFor();
        await settleMotion(page);
        const before = await dialog.boundingBox();
        // The feedback line appears: the dialog grows.
        await dialog.getByRole('button', { name: 'Unlock with stored passcode', exact: true }).click();
        await dialog.getByText('Unlocking with the passcode stored on the server…', { exact: true }).waitFor();
        await settleMotion(page);
        const grown = await dialog.boundingBox();
        assert(grown.height > before.height + 10, `the dialog grew when the feedback line appeared (${before.height} -> ${grown.height})`);
        assert(Math.abs(grown.y - before.y) < 0.5, `the top edge stays where it was (${before.y} -> ${grown.y})`);
        assert(grown.y >= 32 && grown.y + grown.height <= 900, 'the dialog stays inside the window');
        await shot(page, 'unlock-dialog-desktop-light');
    } finally {
        await test.context.close();
    }
    console.log('PASS the desktop dialog keeps its top edge when its content grows');
}

// U-settings-12
async function statusInItsGroup(browser) {
    for (const [mobile, dark] of [[true, false], [false, true]]) {
        const label = `${mobile ? 'phone' : 'desktop'}-${dark ? 'dark' : 'light'}`;
        const test = await ios(browser, { mobile, dark });
        try {
            const { page } = test;
            await toolbar(test, 'Actions');
            const actions = sheet(page, 'Actions');
            const group = (title) => actions.locator('section.sheet-group').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
            await group('Screen').getByRole('button', { name: 'Refresh', exact: true }).click();
            const note = group('Screen').locator('.sheet-status');
            await note.waitFor();
            assert.equal(await note.textContent(), 'Asked for a new keyframe.');
            assert.equal(await actions.locator('.actions-sheet > .sheet-status').count(), 0, 'no message sits between two groups');
            await actions.getByLabel('Text for the phone clipboard').fill('a'.repeat((1 << 18) - 13));
            const error = group('Clipboard').locator('.sheet-status.error');
            await error.waitFor();
            assert.equal(await error.locator('svg').count(), 1, 'an error has an icon');
            assert((await fontSize(error)) >= 13, 'messages are 13px or larger');
            assert((await contrastOf(error)) >= 7, 'the words are in the normal text colour');
            await error.scrollIntoViewIfNeeded();
            const card = await group('Clipboard').locator('.sheet-group-card').boundingBox();
            const box = await error.boundingBox();
            const gap = box.y - (card.y + card.height);
            assert(gap >= 4 && gap <= 12, `the message sits directly under its card (${gap}px)`);
            const next = await group('Phone').locator('.sheet-group-title').boundingBox();
            assert(next.y - (box.y + box.height) >= 14, 'and clear of the next heading');
            await shot(page, `iphone-actions-status-${label}`);
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    // The iPhone schedule sheet, opened from the device card.
    const test = await ios(browser, { mobile: true, stream: false });
    try {
        const { page } = test;
        await page.locator(`[data-device-key="ios:${IOS_UDID}"]`).getByRole('button', { name: 'Settings for iPhone fixture', exact: true }).click();
        const dialog = sheet(page, 'Scheduled unlock');
        await dialog.waitFor();
        await settleMotion(page);
        await dialog.getByLabel('Passcode for scheduled unlock').fill('1234');
        await dialog.getByLabel('Repeat the passcode').fill('4321');
        await dialog.getByRole('button', { name: 'Save on server', exact: true }).click();
        const schedule = dialog.locator('section.sheet-group').filter({ has: page.getByRole('heading', { name: 'Schedule', exact: true }) });
        const error = schedule.locator('.sheet-status.error');
        await error.waitFor();
        assert.match(await error.textContent(), /do not match/);
        await error.scrollIntoViewIfNeeded();
        const box = await error.boundingBox();
        const runs = await dialog.getByRole('heading', { name: 'Runs', exact: true }).boundingBox();
        assert(runs.y - (box.y + box.height) >= 14, 'the message belongs to Schedule, not to the heading under it');
        await shot(page, 'iphone-schedule-error-phone-light');
        assert.deepEqual(test.errors, []);
    } finally {
        await test.context.close();
    }
    console.log('PASS outcome messages sit in the group that produced them, with an icon and readable type');
}

// U-settings-13, U-settings-14
async function applyBarAndReadability(browser) {
    for (const [mobile, dark] of [[true, false], [true, true], [false, false], [false, true]]) {
        const label = `${mobile ? 'phone' : 'desktop'}-${dark ? 'dark' : 'light'}`;
        const test = await android(browser, { mobile, dark });
        try {
            const { page } = test;
            // Opened from the keyboard: the dialog itself must not show a focus ring.
            if (!mobile) {
                await page.locator('.control-buttons-list [title="Settings"]').focus();
                await page.keyboard.press('Enter');
            } else {
                await toolbar(test, 'Settings');
            }
            const settings = sheet(page, 'Stream settings');
            await settings.waitFor();
            await page.waitForFunction(() => !document.querySelector('.bottom-sheet-root.open')?.textContent.includes('Loading settings…'));
            await settleMotion(page);
            if (!mobile) {
                const ring = await settings.evaluate((el) => ({ focused: el === document.activeElement, style: getComputedStyle(el).outlineStyle }));
                assert.deepEqual(ring, { focused: true, style: 'none' }, 'no ring round the whole dialog');
            }
            const bar = settings.locator('.settings-sheet-apply-bar');
            assert.equal(await settings.getByRole('button', { name: 'Apply changes', exact: true }).count(), 0, 'no Apply before a change');
            assert.equal(await settings.getByRole('button', { name: 'Discard', exact: true }).count(), 0, 'no Discard before a change');
            assert((await bar.boundingBox()).height < 1, 'the empty apply bar takes no room');
            for (const small of [settings.locator('.settings-quality-preset small').first(), settings.locator('.settings-sheet-row small').first()]) {
                assert((await fontSize(small)) >= 13, 'help text is 13px or larger');
            }
            await shot(page, `stream-settings-${label}`);

            await settings.getByRole('button', { name: /Data saver/ }).click();
            const discard = settings.getByRole('button', { name: 'Discard', exact: true });
            const apply = settings.getByRole('button', { name: 'Apply changes', exact: true });
            await discard.click();
            await apply.waitFor({ state: 'detached' });
            assert.equal(await activeIn(settings), true, 'after Discard focus stays in the sheet');
            await settings.getByRole('button', { name: /Data saver/ }).click();
            await apply.click();
            const keep = settings.getByRole('button', { name: 'Keep editing', exact: true });
            await keep.waitFor();
            assert.equal(await keep.evaluate((el) => el === document.activeElement), true, 'after Apply changes focus is on Keep editing');
            await settings.getByRole('button', { name: 'Apply & restart', exact: true }).click();
            const alert = bar.locator('[role="alert"]');
            await alert.waitFor();
            await settleMotion(page);
            assert.equal(await alert.evaluate((el) => el === document.activeElement), true, 'after a failed apply focus is on the message');
            const items = await bar.locator('.settings-sheet-apply-items > *').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
            assert(items.length >= 3, 'the error, the note and the buttons are shown');
            for (let index = 1; index < items.length; index++) {
                const gap = items[index].top - items[index - 1].bottom;
                assert(gap >= 8, `apply bar items are spaced (${gap}px)`);
            }
            assert((await contrastOf(alert)) >= 4.5, `${label}: error text contrast ${await contrastOf(alert)}`);
            await alert.scrollIntoViewIfNeeded();
            await shot(page, `stream-settings-apply-error-${label}`);
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    // Opened from the device card there is no stream: the hint under "Audio format" keeps its distance.
    const card = await android(browser, { mobile: true, stream: false });
    try {
        const { page } = card;
        await page.locator('.device').filter({ hasText: UDID }).getByRole('button', { name: /^Settings for / }).click();
        const settings = sheet(page, 'Stream settings');
        await settings.waitFor();
        await page.waitForFunction(() => !document.querySelector('.bottom-sheet-root.open')?.textContent.includes('Loading settings…'));
        await settleMotion(page);
        const hint = settings.getByText('After applying, open the screen and tap Listen.', { exact: true });
        await hint.scrollIntoViewIfNeeded();
        const format = await settings.locator('.settings-audio .settings-advanced').boundingBox();
        const gap = (await hint.boundingBox()).y - (format.y + format.height);
        assert(gap >= 8, `the hint is clear of the Audio format card (${gap}px)`);
        await shot(page, 'stream-settings-from-card-phone-light');
    } finally {
        await card.context.close();
    }
    // Any sheet: a focused button that is replaced by other controls leaves focus in the sheet.
    const list = await ios(browser, {
        stream: false,
        device: { unlockSchedule: { enabled: false, time: '03:00', hasPasscode: true, serverTimeZone: 'UTC' } },
    });
    try {
        const { page } = list;
        await page.locator(`[data-device-key="ios:${IOS_UDID}"]`).getByRole('button', { name: 'Settings for iPhone fixture', exact: true }).click();
        const dialog = sheet(page, 'Scheduled unlock');
        await dialog.waitFor();
        await settleMotion(page);
        await dialog.getByRole('button', { name: 'Replace', exact: true }).click();
        await dialog.getByLabel('Passcode for scheduled unlock').waitFor();
        await pause(50);
        assert.equal(await activeIn(dialog), true, 'focus stays in the sheet when the pressed button is replaced');
        assert.deepEqual(list.errors, []);
    } finally {
        await list.context.close();
    }
    console.log('PASS apply bar spacing, hidden Apply and Discard, focus after each step, type sizes and contrast');
}

// U-settings-15, and the labels of U-system-12 and U-system-4
async function namesAndLabels(browser) {
    const droid = await android(browser, { mobile: true });
    try {
        const { page } = droid;
        assert.equal(await page.locator('.stream-header-device > strong').first().textContent(), ANDROID_NAME, 'the header uses the same name as the card and the sheets');
        await toolbar(droid, 'Actions');
        const actions = sheet(page, 'Actions');
        assert.equal(await actions.locator('.bottom-sheet-subtitle').textContent(), ANDROID_NAME);
        // The playback status line comes from the audio player and is left out here.
        const ownCopy = await actions.evaluate((el) => {
            const copy = el.cloneNode(true);
            copy.querySelectorAll('[data-audio-state] .sheet-row-desc').forEach((node) => node.remove());
            return copy.textContent;
        });
        assert.doesNotMatch(ownCopy, /\b(the|this) device\b|device's/i, 'the controlled phone is called a phone');
        assert((await fontSize(actions.locator('.sheet-button').first())) >= 14, 'button labels are 14px');
        assert((await contrastOf(actions.locator('.sheet-button:not(.primary):not(:disabled)').first())) >= 4.5, 'outline button labels meet 4.5:1');
        await shot(page, 'android-actions-phone-light');
        await actions.getByRole('button', { name: 'Open Stream settings', exact: true }).click();
        const settings = sheet(page, 'Stream settings');
        await settings.waitFor();
        assert.equal(await settings.locator('.bottom-sheet-subtitle').textContent(), ANDROID_NAME);
        assert.equal(await page.locator('.settings-device-context, .settings-device-dot').count(), 0, 'no pill and no dot');
        assert.deepEqual(droid.errors, []);
    } finally {
        await droid.context.close();
    }
    const phone = await ios(browser, { mobile: true });
    try {
        const { page } = phone;
        await toolbar(phone, 'Actions');
        const actions = sheet(page, 'Actions');
        assert.equal(await actions.locator('.bottom-sheet-subtitle').textContent(), 'iPhone fixture');
        // By text, not by role: Restart services sits in the closed Troubleshooting section.
        const labels = await actions.locator('button.sheet-button').evaluateAll((buttons) => buttons.map((button) => button.textContent.trim()));
        for (const name of ['Restart video', 'Reconnect', 'Restart services']) {
            assert.equal(labels.filter((label) => label === name).length, 1, `one button named ${name}`);
        }
        assert.equal(labels.includes('Restart'), false, 'no button says only Restart');
        await shot(page, 'iphone-actions-phone-light');
        assert.deepEqual(phone.errors, []);
    } finally {
        await phone.context.close();
    }
    const list = await ios(browser, { stream: false });
    try {
        const { page } = list;
        await page.locator(`[data-device-key="ios:${IOS_UDID}"]`).getByRole('button', { name: 'Settings for iPhone fixture', exact: true }).click();
        const dialog = sheet(page, 'Scheduled unlock');
        await dialog.waitFor();
        assert.equal(await dialog.locator('.bottom-sheet-subtitle').textContent(), 'iPhone fixture');
        assert.equal(await page.locator('.settings-device-context').count(), 0);
        await shot(page, 'iphone-schedule-desktop-light');
    } finally {
        await list.context.close();
    }
    console.log('PASS sheets are named by content, carry the device name, and buttons name what they restart');
}

// U-system-9
async function statusContrast(browser) {
    for (const dark of [false, true]) {
        const test = await android(browser, { mobile: true, dark, stream: false });
        try {
            const { page } = test;
            const chip = page.locator('.device').filter({ hasText: UDID }).locator('.device-status');
            await chip.waitFor();
            const ratio = await contrastOf(chip);
            assert(ratio >= 4.5, `${dark ? 'dark' : 'light'}: status chip text contrast ${ratio.toFixed(2)}`);
            await page.locator('.device').filter({ hasText: UDID }).getByRole('button', { name: /^Settings for / }).click();
            const settings = sheet(page, 'Stream settings');
            await settings.waitFor();
            await page.waitForFunction(() => !document.querySelector('.bottom-sheet-root.open')?.textContent.includes('Loading settings…'));
            await settleMotion(page);
            const select = settings.locator('.settings-sheet-row select').first();
            const edge = await contrastOf(select, 'borderTopColor');
            assert(edge >= 3, `${dark ? 'dark' : 'light'}: field edge contrast ${edge.toFixed(2)}`);
        } finally {
            await test.context.close();
        }
    }
    console.log('PASS status chip text and field edges meet their contrast targets in both themes');
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        const scenarios = [
            sheetToSheetFocus, escapeCancelsPrompt, typeTextKeepsPicture, copyHereOverHttp, errorBoundary, listenControl,
            desktopDialogTop, statusInItsGroup, applyBarAndReadability, namesAndLabels, statusContrast,
        ];
        const selected = process.env.SCENARIO ? scenarios.filter((run) => run.name === process.env.SCENARIO) : scenarios;
        assert.ok(selected.length, 'SCENARIO names a known scenario');
        for (const run of selected) await run(browser);
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
