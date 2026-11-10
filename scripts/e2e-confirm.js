/* eslint-disable */
// E2E_OUT=/tmp/ws-scrcpy-confirm node scripts/test-browser.js confirm
// The shared confirm prompt (src/app/ui/ConfirmAction.tsx) on every destructive or phone-side
// action outside the notifications page, and the shield under the floating controls panel.
// Every socket is a fixture: tracker commands are captured in the browser and nothing reaches
// a phone. The notifications page prompts are covered in e2e-notifications.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { settleMotion } = require('./ui-motion');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-confirm';
const UDID = 'fixture-iphone-confirm';
const NAME = 'iPhone fixture';
// Mirrors CONFIRM_GUARD_MS and CONFIRM_TIMEOUT_MS in src/app/ui/ConfirmAction.tsx.
const GUARD_MS = 500;
const TIMEOUT_MS = 6000;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

function iphone(extra = {}) {
    return {
        udid: UDID, name: NAME, state: 'Connected', model: 'iPhone 13 Pro Max', version: '27.2', paired: true,
        developerMode: true, session: 'ready', 'screen.power': 'on', 'device.locked': false, ...extra,
    };
}
const android = {
    udid: 'fixture-android-confirm', state: 'device', pid: 123, interfaces: [], 'ro.product.model': 'Pixel fixture',
    'ro.product.manufacturer': 'Fixture', 'ro.build.version.release': '16', 'ro.build.version.sdk': '36',
    'ro.product.cpu.abi': 'arm64-v8a', 'screen.power': 'on', 'device.awake': true, 'battery.level': 80, 'battery.charging': false,
};

/** One iPhone and one Android phone on fixture trackers, plus the iPhone stream socket. */
async function start(browser, { mobile = true, dark = false, device = iphone(), hash } = {}) {
    const context = await browser.newContext({
        viewport: mobile ? PHONE : DESKTOP, isMobile: mobile, hasTouch: mobile, colorScheme: dark ? 'dark' : 'light',
    });
    const page = await context.newPage();
    const errors = [];
    const commands = [];
    const sent = [];
    const handlers = { onCommand: undefined };
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
                if (code === 'HSTS') reply({ id: -1, type: 'hosts', data: { local: [{ type: 'ios' }, { type: 'android' }] } });
                if (code === 'ATRC') reply({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [device] } });
                if (code === 'GTRC') reply({ id: -1, type: 'devicelist', data: { id: 'android', name: 'Devices', list: [android] } });
            } else if (frame[0] === 32) {
                const command = JSON.parse(frame.subarray(5).toString());
                commands.push(command);
                Promise.resolve(handlers.onCommand?.(command)).then((answer) => {
                    if (answer) reply({ id: command.id, type: command.type, data: { udid: command.data.udid, ...answer } });
                });
            }
        });
    });
    const url = new URL(BASE);
    if (hash) url.hash = `!${new URLSearchParams(hash)}`;
    await page.goto(url.toString());
    const ofType = (type) => commands.filter((command) => command.type === type);
    return { context, page, errors, commands, sent, handlers, ofType, mobile };
}

const prompt = (scope, name) => scope.getByRole('alertdialog', { name, exact: true });
// A trigger can share its name with the confirm button it arms ("Reboot"); this is the trigger.
const trigger = (scope, name) =>
    scope.getByRole('button', { name, exact: true }).and(scope.page().locator(':not(.confirm-prompt-button)'));
const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** First press: with touch, two taps 60 ms apart on the same point, as a double tap lands. */
async function doubleTap(test, locator) {
    await locator.scrollIntoViewIfNeeded();
    const point = center(await locator.boundingBox());
    if (test.mobile) {
        await test.page.touchscreen.tap(point.x, point.y);
        await pause(60);
        await test.page.touchscreen.tap(point.x, point.y);
    } else {
        await test.page.mouse.dblclick(point.x, point.y);
    }
    return point;
}

/** The confirm button ignores presses until the guard has passed; Playwright waits for that. */
async function confirmAfterGuard(dialog, name) {
    const button = dialog.getByRole('button', { name, exact: true });
    await dialog.locator('.confirm-prompt-button:not([aria-disabled])').first().waitFor();
    await button.click();
}

/**
 * The checks every use of the prompt shares: a double tap sends nothing, and the confirm button
 * sits away from the first press and ignores an immediate press.
 */
async function armAndCheck(test, { trigger: button, scope, question, consequence, confirmLabel, sentCount }) {
    const before = sentCount();
    const point = await doubleTap(test, button);
    const dialog = prompt(scope, question);
    await dialog.waitFor();
    assert.equal(sentCount(), before, `${question} a double tap sends nothing`);
    assert.match(await dialog.textContent(), consequence, `${question} states the consequence`);
    const confirm = dialog.getByRole('button', { name: confirmLabel, exact: true });
    assert.equal(await confirm.getAttribute('aria-disabled'), 'true', 'the confirm button starts guarded');
    // A press that lands inside the guard window is dropped by the handler itself.
    await confirm.evaluate((el) => el.click());
    assert.equal(sentCount(), before, `${question} a press inside the guard sends nothing`);
    await dialog.waitFor();
    const box = await confirm.boundingBox();
    assert.ok(
        point.x < box.x || point.x > box.x + box.width || point.y < box.y || point.y > box.y + box.height,
        `${question} the confirm button is not under the first press`,
    );
    assert.equal(overlaps(await button.boundingBox(), box), false, `${question} the confirm button is clear of its trigger`);
    return dialog;
}

async function openActions(test) {
    const { page } = test;
    await page.waitForFunction(() => document.querySelector('.stream-header-status')?.textContent.includes('Connected'));
    if (test.mobile) {
        await page.locator('.floating-toolbar-fab').click();
        await settleMotion(page);
    }
    await page.locator('.control-buttons-list [title="Actions"]').click();
    const sheet = page.getByRole('dialog', { name: 'Actions', exact: true });
    await sheet.waitFor();
    await settleMotion(page);
    return sheet;
}

async function shot(page, name) {
    fs.mkdirSync(OUT, { recursive: true });
    // An armed prompt is captured once it has been scrolled into view and its guard has passed.
    if (await page.locator('.confirm-prompt').count()) {
        await page.locator('.confirm-prompt-button.danger:not([aria-disabled])').waitFor({ timeout: 2000 }).catch(() => undefined);
    }
    await settleMotion(page);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled' });
}

// U-stream-1, C-client-ui-2
async function powerActions(browser, mobile) {
    const test = await start(browser, { mobile, hash: { action: 'stream-coredevice', udid: UDID } });
    const { page, ofType } = test;
    const label = mobile ? 'phone' : 'desktop';
    try {
        const power = () => ofType('reboot_device').length + ofType('shutdown_device').length;
        let sheet = await openActions(test);
        const reboot = trigger(sheet, 'Reboot');
        const shutDown = trigger(sheet, 'Shut down');
        assert.match(await reboot.getAttribute('class'), /danger/, 'Reboot is a danger button before it is pressed');
        assert.match(await shutDown.getAttribute('class'), /danger/, 'Shut down is a danger button before it is pressed');

        // Double tap on Reboot: armed, nothing sent, and the button keeps its label.
        let dialog = await armAndCheck(test, {
            trigger: reboot, scope: sheet, question: `Reboot ${NAME}?`, consequence: /passcode is set, it has to be entered on the phone/,
            confirmLabel: 'Reboot', sentCount: power,
        });
        assert.equal(await sheet.getByRole('button', { name: /Confirm reboot/ }).count(), 0, 'the trigger does not turn into the confirm button');
        await shot(page, `power-reboot-armed-${label}-light`);

        // Close and reopen: the armed state is gone and one more press only arms it again.
        await page.getByRole('button', { name: 'Close Actions', exact: true }).click();
        await sheet.waitFor({ state: 'hidden' });
        sheet = await openActions(test);
        assert.equal(await sheet.getByRole('alertdialog').count(), 0, 'closing the sheet disarms the action');
        assert.equal(await sheet.getByText(/Press Confirm/).count(), 0, 'no stale confirm note after reopening');
        await trigger(sheet, 'Reboot').click();
        dialog = prompt(sheet, `Reboot ${NAME}?`);
        await dialog.waitFor();
        assert.equal(power(), 0, 'open, Reboot, close, reopen, Reboot sends no command');
        assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'Cancel is the default');

        // Cancel sends nothing and returns focus to the button that armed it.
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Reboot');
        assert.equal(power(), 0, 'Cancel sends nothing');

        // A press anywhere else disarms it.
        await trigger(sheet, 'Reboot').click();
        await dialog.waitFor();
        await sheet.getByRole('heading', { name: 'Phone', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        assert.equal(power(), 0, 'a press elsewhere sends nothing');

        if (!mobile) {
            // Keyboard: Enter arms it with Cancel focused; moving focus away with Tab disarms it.
            await trigger(sheet, 'Reboot').focus();
            await page.keyboard.press('Enter');
            await dialog.waitFor();
            assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel');
            await page.keyboard.press('Shift+Tab');
            assert.equal(await page.evaluate(() => document.activeElement?.className), 'confirm-prompt-button danger');
            await page.keyboard.press('Enter');
            assert.equal(power(), 0, 'Enter on the confirm button inside the guard sends nothing');
            await pause(GUARD_MS + 100);
            await page.keyboard.press('Tab');
            await page.keyboard.press('Tab');
            await dialog.waitFor({ state: 'detached' });
            assert.equal(power(), 0, 'moving focus away sends nothing');
        }

        // Left alone, it disarms after the timeout.
        await trigger(sheet, 'Reboot').click();
        await dialog.waitFor();
        const armedAt = Date.now();
        await dialog.waitFor({ state: 'detached', timeout: TIMEOUT_MS + 2000 });
        assert.ok(Date.now() - armedAt >= TIMEOUT_MS - 500, 'the prompt stays for the whole timeout');
        assert.equal(power(), 0, 'the timeout sends nothing');

        // Shut down: the prompt names the phone and the consequence; confirming sends it once.
        test.handlers.onCommand = (command) => (command.type === 'shutdown_device' ? { result: 'ok' } : undefined);
        await shutDown.scrollIntoViewIfNeeded();
        dialog = await armAndCheck(test, {
            trigger: shutDown, scope: sheet, question: `Shut down ${NAME}?`, consequence: /You cannot turn it back on from here\./,
            confirmLabel: 'Shut down', sentCount: power,
        });
        await page.emulateMedia({ colorScheme: 'dark' });
        await shot(page, `power-shutdown-armed-${label}-dark`);
        await page.emulateMedia({ colorScheme: 'light' });
        await shot(page, `power-shutdown-armed-${label}-light`);
        // The screenshots took time; arm it again so the timeout cannot race the press.
        if (!(await dialog.count())) await shutDown.click();
        await confirmAfterGuard(dialog, 'Shut down');
        await sheet.getByText('Shutting down…', { exact: true }).waitFor();
        assert.deepEqual(ofType('shutdown_device').map((command) => command.data), [{ udid: UDID }]);
        assert.equal(ofType('reboot_device').length, 0);
        assert.equal(await sheet.getByRole('alertdialog').count(), 0);
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label} power actions: double tap, guard, close and reopen, cancel, outside press, timeout, confirm`);
    } finally {
        await test.context.close();
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [true, false]) {
            await powerActions(browser, mobile);
        }
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
