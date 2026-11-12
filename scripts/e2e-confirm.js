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
const { fixture: androidFixture, UDID: ANDROID_UDID } = require('./e2e-settings');
const { initialStreamPacket } = require('./e2e-sheets');
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
    const handlers = { onCommand: undefined, iphone: undefined };
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
                if (code === 'ATRC') {
                    // A later device list, as the tracker sends when the phone's state changes.
                    handlers.iphone = (next) => reply({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [next] } });
                    handlers.iphone(device);
                }
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
// The buttons of a prompt, in a sheet or on a card.
const PROMPT_BUTTONS = '.kit-confirm-actions .kit-button';
const READY_PROMPT_BUTTON = '.kit-confirm-go:not([aria-disabled])';
const READY_DANGER_BUTTON = '.kit-confirm-danger .kit-confirm-go:not([aria-disabled])';
// A trigger can share its name with the confirm button it arms ("Reboot"); this is the trigger.
const trigger = (scope, name) =>
    scope.getByRole('button', { name, exact: true }).and(scope.page().locator(`:not(:is(${PROMPT_BUTTONS}))`));
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
    await dialog.locator(READY_PROMPT_BUTTON).first().waitFor();
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
    await page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.includes('Connected'));
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
    if (await page.locator('.kit-confirm').count()) {
        await page.locator(READY_DANGER_BUTTON).waitFor({ timeout: 2000 }).catch(() => undefined);
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

        // The browser's Back does what Escape does: the first one cancels the prompt and the
        // sheet stays open on its history entry; the stream under it is not left.
        await trigger(sheet, 'Reboot').click();
        await dialog.waitFor();
        await page.goBack();
        await dialog.waitFor({ state: 'detached' });
        await page.waitForFunction(() => history.state?.nav?.overlay === 1);
        await pause(150);
        assert.equal(await sheet.isVisible(), true, 'Back with a prompt open leaves the sheet open');
        assert.equal(await page.locator('.stream-view').count(), 1, 'and the stream page');
        assert.equal(power(), 0, 'Back sends nothing');

        if (!mobile) {
            // Keyboard: Enter arms it with Cancel focused; moving focus away with Tab disarms it.
            await trigger(sheet, 'Reboot').focus();
            await page.keyboard.press('Enter');
            await dialog.waitFor();
            assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel');
            await page.keyboard.press('Shift+Tab');
            assert.equal(await page.evaluate(() => document.activeElement?.className), 'kit-button kit-button-danger-solid kit-confirm-go');
            assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.kit-confirm-danger')), true, 'the confirm button of a danger prompt');
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

        // The two service actions under Troubleshooting end the session for every viewer, so
        // they use the same prompt here as on the device card.
        await sheet.locator('summary').filter({ hasText: 'Troubleshooting' }).click();
        await settleMotion(page);
        test.handlers.onCommand = (command) => (command.type === 'restart_session' ? { result: 'Fixture done.' } : undefined);
        const restart = trigger(sheet, 'Restart services');
        assert.match(await restart.getAttribute('class'), /danger/);
        dialog = await armAndCheck(test, {
            trigger: restart, scope: sheet, question: `Restart services on ${NAME}?`, consequence: /The phone session ends for every viewer/,
            confirmLabel: 'Restart services', sentCount: () => ofType('restart_session').length,
        });
        await shot(page, `actions-restart-services-armed-${label}-light`);
        if (!(await dialog.count())) await restart.click();
        await confirmAfterGuard(dialog, 'Restart services');
        await sheet.getByText('Fixture done.', { exact: true }).waitFor();
        assert.equal(ofType('restart_session').length, 1);
        dialog = await armAndCheck(test, {
            trigger: trigger(sheet, 'Remount developer image'), scope: sheet, question: `Remount the developer image on ${NAME}?`,
            consequence: /while the image is reloaded/, confirmLabel: 'Remount', sentCount: () => ofType('remount_ddi').length,
        });
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        assert.equal(ofType('remount_ddi').length, 0, 'Cancel sends no remount');

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

// U-home-4, U-system-1, U-settings-1 (card warning)
async function deviceCards(browser, mobile) {
    const device = iphone({ developerMode: false, unlockSchedule: { enabled: true, time: '03:00', hasPasscode: false } });
    const test = await start(browser, { mobile, device });
    const { page, ofType } = test;
    const label = mobile ? 'phone' : 'desktop';
    try {
        const card = page.locator(`[data-device-key="ios:${UDID}"]`);
        await card.waitFor();
        const unlockLine = card.locator('.device-unlock-schedule.problem');
        assert.equal(
            await unlockLine.textContent(),
            'Scheduled unlock cannot run: no passcode',
            'the card says when scheduled unlock cannot run',
        );

        // Developer Mode: the button says it restarts the phone and needs a confirming press.
        const enable = trigger(card, 'Enable and restart');
        let dialog = await armAndCheck(test, {
            trigger: enable, scope: card, question: `Enable Developer Mode on ${NAME}?`, consequence: /The phone restarts/,
            confirmLabel: 'Enable and restart', sentCount: () => ofType('enable_developer_mode').length,
        });
        await shot(page, `card-developer-mode-armed-${label}-light`);
        if (!(await dialog.count())) await enable.click();
        await confirmAfterGuard(dialog, 'Enable and restart');
        await card.getByText(/Enabling Developer Mode/).waitFor();
        assert.deepEqual(ofType('enable_developer_mode').map((command) => command.data), [{ udid: UDID }]);

        // Recovery actions: own group, danger style, the consequence as visible text, confirmed.
        await card.locator('summary').click();
        await settleMotion(page);
        const trouble = card.getByRole('group', { name: 'Troubleshooting', exact: true });
        await trouble.getByRole('heading', { name: 'Troubleshooting', exact: true }).waitFor();
        const rows = [
            ['Stop stream service', /Ends the screen stream for every viewer\./, `Stop the stream service on ${NAME}?`, 'Stop stream service', 'kill_server'],
            ['Restart services', /Ends the phone session for every viewer\./, `Restart services on ${NAME}?`, 'Restart services', 'restart_session'],
            ['Remount developer image', /Ends the phone session first\./, `Remount the developer image on ${NAME}?`, 'Remount', 'remount_ddi'],
        ];
        for (const [name, visible] of rows) {
            const button = trigger(trouble, name);
            assert.match(await button.getAttribute('class'), /danger/, `${name} is a danger button`);
            assert.equal(await button.getAttribute('title'), null, `${name} does not hide its warning in a tooltip`);
            assert.match(await button.locator('xpath=..').textContent(), visible, `${name} shows what it ends`);
        }
        assert.equal(await trouble.getByRole('button', { name: 'Refresh info' }).count(), 0, 'Refresh info is not a troubleshooting action');
        await shot(page, `card-iphone-troubleshooting-${label}-light`);
        await page.emulateMedia({ colorScheme: 'dark' });
        await shot(page, `card-iphone-troubleshooting-${label}-dark`);
        await page.emulateMedia({ colorScheme: 'light' });
        test.handlers.onCommand = (command) =>
            ['restart_session', 'remount_ddi'].includes(command.type) ? { result: 'Fixture done.' } : undefined;
        for (const [name, , question, confirmLabel, type] of rows) {
            dialog = await armAndCheck(test, {
                trigger: trigger(trouble, name), scope: trouble, question, consequence: /every viewer/,
                confirmLabel, sentCount: () => ofType(type).length,
            });
            if (name === 'Restart services') await shot(page, `card-iphone-restart-armed-${label}-light`);
            if (!(await dialog.count())) await trigger(trouble, name).click();
            await confirmAfterGuard(dialog, confirmLabel);
            await dialog.waitFor({ state: 'detached' });
            assert.equal(ofType(type).length, 1, `${name} is sent once after confirming`);
            if (type !== 'kill_server') {
                await card.getByText('Fixture done.', { exact: true }).waitFor();
                // The outcome is the status line under the row whose button was pressed.
                const outcome = trouble.locator(`.device-trouble-row:has(> [aria-label="${name}"]) + .kit-status`);
                assert.equal(await outcome.textContent(), 'Fixture done.', `${name}: the outcome is under its row`);
            }
        }
        assert.deepEqual(ofType('kill_server')[0].data, { udid: UDID, pid: 1 });

        // A waiting prompt goes away once its action no longer applies: the session stops
        // elsewhere, or the phone disconnects.
        await trigger(trouble, 'Stop stream service').click();
        const stopPrompt = prompt(trouble, `Stop the stream service on ${NAME}?`);
        await stopPrompt.waitFor();
        test.handlers.iphone({ ...device, session: 'stopped' });
        // Well inside the timeout, so it is the state change that removes it.
        await stopPrompt.waitFor({ state: 'detached', timeout: 2000 });
        await trigger(trouble, 'Restart services').click();
        const restartPrompt = prompt(trouble, `Restart services on ${NAME}?`);
        await restartPrompt.waitFor();
        test.handlers.iphone({ ...device, state: 'Disconnected', session: 'stopped' });
        await restartPrompt.waitFor({ state: 'detached', timeout: 2000 });
        assert.equal(ofType('kill_server').length, 1, 'no second stop was sent');
        assert.equal(ofType('restart_session').length, 1, 'no second restart was sent');
        test.handlers.iphone(device);

        // Android: Stop stream service leaves the Files and Shell row and is confirmed.
        const androidCard = page.locator(`[data-device-key="android:${android.udid}"]`);
        await androidCard.locator('summary').click();
        await settleMotion(page);
        const androidTrouble = androidCard.getByRole('group', { name: 'Troubleshooting', exact: true });
        const stop = trigger(androidTrouble, 'Stop stream service');
        assert.equal(await androidCard.locator('.device-secondary-actions').getByRole('button', { name: /stream service/ }).count(), 0);
        assert.match(await stop.getAttribute('class'), /danger/);
        assert.match(await androidTrouble.textContent(), /Stopping it ends the stream for every viewer\./);
        const killed = () => ofType('kill_server').filter((command) => command.data.udid === android.udid);
        dialog = await armAndCheck(test, {
            trigger: stop, scope: androidTrouble, question: 'Stop the stream service on Fixture Pixel fixture?', consequence: /every viewer/,
            confirmLabel: 'Stop stream service', sentCount: () => killed().length,
        });
        await shot(page, `card-android-stop-armed-${label}-light`);
        if (!(await dialog.count())) await stop.click();
        await confirmAfterGuard(dialog, 'Stop stream service');
        await dialog.waitFor({ state: 'detached' });
        assert.deepEqual(killed().map((command) => command.data), [{ udid: android.udid, pid: 123 }]);
        assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
            'the cards do not overflow the page',
        );
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label} device cards: Developer Mode, stop, restart and remount are grouped, explained and confirmed`);
    } finally {
        await test.context.close();
    }
}

// U-settings-1, U-system-1
async function removePasscode(browser, mobile) {
    const status = { enabled: true, time: '03:00', hasPasscode: true, nextRunAt: Date.now() + 3600000 };
    const test = await start(browser, { mobile, device: iphone({ session: 'stopped', unlockSchedule: status }) });
    const { page, ofType } = test;
    const label = mobile ? 'phone' : 'desktop';
    try {
        const settings = page.locator(`[data-device-key="ios:${UDID}"]`).getByRole('button', { name: `Settings for ${NAME}`, exact: true });
        const open = async () => {
            await settings.click();
            const sheet = page.getByRole('dialog', { name: 'Settings', exact: true });
            await sheet.waitFor();
            await settleMotion(page);
            return sheet;
        };
        let sheet = await open();
        const remove = sheet.getByRole('button', { name: 'Remove', exact: true });
        const cleared = () => ofType('clear_unlock_passcode').length;
        assert.match(await remove.getAttribute('class'), /danger/, 'Remove is a danger button');
        assert.doesNotMatch(await sheet.getByRole('button', { name: 'Replace', exact: true }).getAttribute('class'), /danger/);
        let dialog = await armAndCheck(test, {
            trigger: remove, scope: sheet, question: `Remove the stored passcode for ${NAME}?`,
            consequence: /Scheduled unlock stops\. The iPhone stops accepting connections 24 hours after the passcode was last entered\./,
            confirmLabel: 'Remove passcode', sentCount: cleared,
        });
        await shot(page, `passcode-remove-armed-${label}-light`);
        await page.emulateMedia({ colorScheme: 'dark' });
        await shot(page, `passcode-remove-armed-${label}-dark`);
        await page.emulateMedia({ colorScheme: 'light' });

        // Closing the sheet disarms it.
        if (!(await dialog.count())) await remove.click();
        await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
        await sheet.waitFor({ state: 'hidden' });
        sheet = await open();
        assert.equal(await sheet.getByRole('alertdialog').count(), 0, 'closing the sheet disarms Remove');
        assert.equal(cleared(), 0);

        // Confirming sends it once and says that the schedule can no longer run.
        test.handlers.onCommand = (command) =>
            command.type === 'clear_unlock_passcode' ? { result: JSON.stringify({ ...status, hasPasscode: false, nextRunAt: undefined }) } : undefined;
        await remove.click();
        await confirmAfterGuard(dialog, 'Remove passcode');
        await sheet.locator('.kit-status.kit-status-warning', { hasText: 'Scheduled unlock is on but cannot run until a passcode is stored.' }).waitFor();
        assert.deepEqual(ofType('clear_unlock_passcode').map((command) => command.data), [{ udid: UDID }]);
        await sheet.getByLabel('Passcode for scheduled unlock').waitFor();
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label} passcode Remove: danger style, confirm prompt, disarmed by closing, warning after removal`);
    } finally {
        await test.context.close();
    }
}

// U-stream-2 and the Disconnect button from U-system-1, on a live-shaped Android stream. The
// iPhone stream page uses the same FloatingToolbar, and its touch handler also acts only on
// events whose target is the touch layer, so the shield covers it the same way.
async function controlsPanelShield(browser) {
    const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const errors = [];
    const packets = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
        await androidFixture(page, {
            initialPacket: initialStreamPacket(),
            onStreamMessage: (packet) => packets.push(Buffer.from(packet)),
            onStreamReady: () => undefined,
        });
        const socket = new URL('/__settings_fixture__', BASE);
        socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = new URL(BASE);
        url.hash = `!${new URLSearchParams({ action: 'stream', udid: ANDROID_UDID, player: 'webcodecs', ws: socket.toString(), captureKeyboard: '0', fitToScreen: '1' })}`;
        await page.goto(url.toString());
        await page.getByText('Connected', { exact: true }).waitFor();
        const canvas = page.locator('.touch-layer');
        await canvas.waitFor({ state: 'visible' });
        const touches = () => packets.filter((packet) => packet.length === 32 && packet[0] === 2).length;
        const fab = page.locator('.floating-toolbar-fab');
        const panel = page.locator('.floating-toolbar-panel');
        const picture = await canvas.boundingBox();
        // A point on the picture that the panel and the button do not cover.
        const point = { x: picture.x + 40, y: picture.y + 60 };

        await fab.click();
        await panel.waitFor({ state: 'visible' });
        await settleMotion(page);
        const panelBox = await panel.boundingBox();
        assert.ok(point.x < panelBox.x || point.y < panelBox.y, 'the test point is outside the panel');
        await page.touchscreen.tap(point.x, point.y);
        await panel.waitFor({ state: 'hidden' });
        await pause(100);
        assert.equal(touches(), 0, 'the tap that closes the controls panel is not sent to the phone');
        assert.equal(await fab.getAttribute('aria-expanded'), 'false');

        // Once the panel is closed and the shield has gone, the same point is a normal tap.
        await page.locator('.floating-toolbar-shield').waitFor({ state: 'detached' });
        await page.touchscreen.tap(point.x, point.y);
        await pause(100);
        assert.ok(touches() >= 2, 'positive control: the next tap reaches the phone as touch down and up');

        // The panel still stays open for repeated key presses.
        await fab.click();
        await panel.waitFor({ state: 'visible' });
        await settleMotion(page);
        const before = packets.length;
        await page.locator('.control-buttons-list [title="Back"]').click();
        await pause(100);
        assert.ok(packets.length > before, 'a control in the panel still works');
        assert.equal(await fab.getAttribute('aria-expanded'), 'true', 'the panel stays open after a key press');

        // The shield covers the stage only: the header above it takes a press directly.
        await page.locator('.kit-bar').getByRole('button', { name: 'Switch', exact: true }).tap();
        const switcher = page.getByRole('dialog', { name: 'Switch device', exact: true });
        await switcher.waitFor();
        await page.getByRole('button', { name: 'Close Switch device', exact: true }).click();
        await switcher.waitFor({ state: 'hidden' });
        await fab.click();
        await panel.waitFor({ state: 'visible' });
        await settleMotion(page);

        // The sheet has no way out of the page: the header's back control is the one.
        await page.locator('.control-buttons-list [title="Actions"]').click();
        const sheet = page.getByRole('dialog', { name: 'Actions', exact: true });
        await sheet.waitFor();
        assert.equal(await sheet.getByRole('button', { name: 'Disconnect', exact: true }).count(), 0);
        assert.deepEqual(errors, []);
        console.log('PASS controls panel: the dismissing tap stays off the phone, the next tap reaches it, the Actions sheet has no Disconnect');
    } finally {
        await context.close();
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [true, false]) {
            await powerActions(browser, mobile);
            await deviceCards(browser, mobile);
            await removePasscode(browser, mobile);
        }
        await controlsPanelShield(browser);
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
