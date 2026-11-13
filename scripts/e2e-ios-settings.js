// BASE=http://127.0.0.1:8000 E2E_OUT=/tmp/ws-scrcpy-ios-settings node scripts/e2e-ios-settings.js
// The iPhone's Settings sheet (Settings button on the iOS card: the scheduled unlock rows, the
// passcode fields, the facts) and the stream page's Unlock sheet, against fixture sockets: every
// tracker command is captured in the browser, nothing reaches a phone. Runs under
// scripts/test-browser.js as the `ios-settings` suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { settleMotion } = require('./ui-motion');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-ios-settings';
const UDID = 'fixture-iphone-settings';
const ANDROID_UDID = 'fixture-android-settings';
// A dummy code; it only ever reaches the fixture socket in this browser.
const PASSCODE = '246810';
// The browser's zone in every context here, and the server's for a schedule saved without one.
const ZONE = 'America/New_York';
const BASE_STATUS = { enabled: false, time: '03:00', hasPasscode: false, serverTimeZone: 'UTC' };

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

function iphone(unlockSchedule, extra = {}) {
    return {
        udid: UDID, name: 'iPhone fixture', state: 'Connected', model: 'iPhone 13 Pro Max', version: '27.2',
        paired: true, developerMode: true, session: 'stopped', 'screen.power': 'off', 'device.locked': true,
        unlockSchedule, ...extra,
    };
}
const android = {
    udid: ANDROID_UDID, state: 'device', pid: 123, interfaces: [], 'ro.product.model': 'Pixel fixture',
    'ro.product.manufacturer': 'Fixture', 'ro.build.version.release': '16', 'ro.build.version.sdk': '36',
    'ro.product.cpu.abi': 'arm64-v8a', 'screen.power': 'on', 'device.awake': true, 'battery.level': 80, 'battery.charging': false,
};

// `refusal` makes the stream socket answer every start with that error and close with that code,
// the way the server does for a phone it cannot start a session on.
async function start(browser, { width = 390, height = 844, mobile = true, colorScheme = 'light', status = BASE_STATUS, device = {}, stream = false, storage = {}, refusal, now } = {}) {
    const context = await browser.newContext({
        viewport: { width, height }, isMobile: mobile, hasTouch: mobile, colorScheme,
        // A 24-hour time field, so typed digits are the time, and a known zone for the patches.
        locale: 'en-GB', timezoneId: ZONE,
    });
    if (Object.keys(storage).length) {
        await context.addInitScript((entries) => {
            for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
        }, storage);
    }
    const page = await context.newPage();
    if (now !== undefined) await page.clock.setFixedTime(now);
    const errors = [];
    const commands = [];
    // Everything the page sends to the phone's stream socket: must stay free of keys and touches.
    const streamMessages = [];
    // `onCommand(command)` returns the reply body (`{ result }` or `{ error }`), a promise of one, or nothing.
    // `onStream(message)` returns what the stream socket answers with, or nothing.
    const handlers = { onCommand: undefined, onStream: undefined };
    // The latest of each, so a flow can close one the way a dropped connection would.
    const sockets = { stream: undefined, tracker: undefined };
    let trackerReply;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        if (new URL(socket.url()).searchParams.get('action') === 'proxy-coredevice') {
            sockets.stream = socket;
            socket.onMessage((data) => {
                if (typeof data !== 'string') return;
                const message = JSON.parse(data);
                streamMessages.push(message);
                const answer = handlers.onStream?.(message);
                if (answer) socket.send(JSON.stringify(answer));
            });
            if (refusal) {
                setTimeout(() => {
                    socket.send(JSON.stringify({ type: 'status', state: 'error', message: refusal.message }));
                    socket.close({ code: refusal.code, reason: 'Session failed' });
                }, 50);
                return;
            }
            setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 50);
            return;
        }
        sockets.tracker = socket;
        socket.onMessage((data) => {
            const frame = Buffer.from(data);
            if (frame.length < 5) return;
            const id = frame.readUInt32LE(1);
            const reply = (message) => socket.send(channelJson(id, message));
            if (frame[0] === 4) {
                const code = frame.subarray(5).toString();
                if (code === 'HSTS') reply({ id: -1, type: 'hosts', data: { local: [{ type: 'ios' }, { type: 'android' }] } });
                if (code === 'ATRC') {
                    trackerReply = reply;
                    reply({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [iphone(status, device)] } });
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
    if (stream) url.hash = `!${new URLSearchParams({ action: 'stream-coredevice', udid: UDID })}`;
    await page.goto(url.toString());
    if (refusal) {
        await page.locator('.stream-start-error').waitFor();
    } else if (stream) {
        await page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.includes('Connected'));
    } else {
        await page.locator(`[data-device-key="ios:${UDID}"]`).waitFor();
    }
    const sendDevice = (device) => trackerReply({ id: -1, type: 'device', data: { id: 'ios', name: 'Devices', device } });
    return { context, page, errors, commands, handlers, sendDevice, streamMessages, sockets };
}

const ofType = (commands, type) => commands.filter((command) => command.type === type);
const colorOf = (locator) => locator.evaluate((el) => getComputedStyle(el).color);

async function openPanel(page) {
    await page.locator(`[data-device-key="ios:${UDID}"]`).getByRole('button', { name: 'Settings for iPhone fixture', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.waitFor();
    await settleMotion(page);
    return dialog;
}
// The scheduled unlock's rows, within the one Settings sheet.
const scheduleGroup = (dialog) => dialog.locator('section.kit-group.settings-schedule');
const SCHEDULE_SWITCH = 'dialog.kit-sheet[open] .settings-schedule .kit-switch';

async function panelFlow(browser) {
    const test = await start(browser);
    const { page, commands, handlers } = test;
    try {
        fs.mkdirSync(OUT, { recursive: true });
        const iosCard = page.locator(`[data-device-key="ios:${UDID}"]`);
        const androidCard = page.locator(`[data-device-key="android:${ANDROID_UDID}"]`);
        const iosSettings = iosCard.getByRole('button', { name: 'Settings for iPhone fixture', exact: true });
        await iosSettings.waitFor();
        await androidCard.getByRole('button', { name: 'Settings for Fixture Pixel fixture', exact: true }).waitFor();
        assert.equal(await iosCard.locator('.device-unlock-schedule').count(), 0, 'no card line while the schedule is off');
        await page.screenshot({ path: path.join(OUT, 'device-list-390.png') });
        const storageBefore = await page.evaluate(() => Object.keys(localStorage).sort());

        const dialog = await openPanel(page);
        for (const name of ['Schedule', 'Runs', 'Phone']) {
            await dialog.getByRole('heading', { name, exact: true }).waitFor();
        }
        assert.equal(await dialog.getByRole('heading', { name: 'Status', exact: true }).count(), 0);
        assert.equal(await dialog.locator('[data-fact="developer-mode"] .kit-row-value').textContent(), 'On');
        const toggle = dialog.getByRole('switch', { name: 'Unlock twice a day' });
        assert.equal(await toggle.isDisabled(), true, 'the toggle waits for a stored passcode');
        assert.equal(await toggle.isChecked(), false);
        // The group opens with one row for state and last result.
        const summary = dialog.locator('[data-unlock-summary]');
        assert.equal(await summary.getAttribute('data-unlock-summary'), 'off');
        assert.equal(await summary.locator('.kit-row-title').textContent(), 'Off');
        assert.equal(await summary.locator('.kit-row-desc').textContent(), 'No run yet');
        assert.equal(await scheduleGroup(dialog).locator('.kit-row').first().getAttribute('data-unlock-summary'), 'off', 'it is the first row');
        await dialog.getByText('No run yet.', { exact: true }).waitFor();
        // A schedule saved before zones were stored is server time, and says so.
        const timeRow = dialog.locator('[data-unlock-time]');
        assert.equal(await timeRow.locator('.kit-row-desc').textContent(), 'Server time (UTC)');
        await dialog.getByText(`The time is server time, saved before time zones were stored. This browser is in ${ZONE}.`, { exact: true }).waitFor();
        await page.screenshot({ path: path.join(OUT, 'panel-390.png') });
        assert.equal(await dialog.getByText('saved in this browser', { exact: false }).count(), 0, 'no offer to copy a browser passcode');

        // Save: asked for twice, one frame, fields cleared, nothing new in localStorage.
        const field = dialog.getByLabel('Passcode for scheduled unlock');
        const repeat = dialog.getByLabel('Repeat the passcode');
        const save = dialog.getByRole('button', { name: 'Save on server', exact: true });
        assert.equal(await field.getAttribute('type'), 'password');
        assert.equal(await field.getAttribute('inputmode'), 'numeric');
        assert.equal(await repeat.getAttribute('type'), 'password');
        await field.fill(PASSCODE);
        assert.equal(await save.isDisabled(), true, 'one entry is not enough');
        await repeat.fill('246811');
        assert.equal(commands.length, 0, 'typing in the fields sends nothing');
        await save.click();
        await dialog.getByRole('alert').filter({ hasText: 'The two entries do not match.' }).waitFor();
        assert.equal(commands.length, 0, 'a mismatch is not sent');
        assert.equal(await repeat.inputValue(), '');
        await repeat.fill(PASSCODE);
        let status = { ...BASE_STATUS, hasPasscode: true };
        handlers.onCommand = (command) => (command.type === 'set_unlock_passcode' ? { result: JSON.stringify(status) } : undefined);
        await save.click();
        await dialog.getByText('Passcode stored on the server.', { exact: true }).waitFor();
        assert.deepEqual(ofType(commands, 'set_unlock_passcode').map((command) => command.data), [{ udid: UDID, passcode: PASSCODE }]);
        await dialog.locator('.kit-row-desc', { hasText: 'Stored on the server.' }).waitFor();
        assert.equal(await field.count(), 0, 'the stored passcode is shown as Replace / Remove');
        await dialog.getByRole('button', { name: 'Replace', exact: true }).click();
        assert.equal(await field.inputValue(), '', 'the field is empty after the reply');
        assert.equal(await repeat.inputValue(), '');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(await field.count(), 0);
        assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).sort()), storageBefore, 'localStorage has no new key');
        assert.ok(!(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).includes(PASSCODE));
        assert.equal(await toggle.isDisabled(), false, 'the reply enables the toggle');

        // Toggle: one update frame carrying this browser's zone; the reply updates the summary.
        const nextRunAt = Date.UTC(2026, 10, 11, 8, 0);
        status = { enabled: true, time: '03:00', hasPasscode: true, timeZone: ZONE, nextRunAt };
        handlers.onCommand = (command) => (command.type === 'update_unlock_schedule' ? { result: JSON.stringify(status) } : undefined);
        await toggle.click();
        await page.waitForFunction((selector) => document.querySelector(selector)?.checked === true, SCHEDULE_SWITCH);
        assert.deepEqual(ofType(commands, 'update_unlock_schedule').map((command) => command.data), [{ udid: UDID, schedule: { enabled: true, timeZone: ZONE } }]);
        await dialog.getByText('Scheduled unlock is on.', { exact: true }).waitFor();
        assert.equal(await summary.getAttribute('data-unlock-summary'), 'on');
        assert.equal(await summary.locator('.kit-row-title').textContent(), 'On');
        assert.equal(await summary.locator('.kit-row-desc').textContent(), 'Next run Wed 11 Nov, 03:00 · No run yet', 'the next run is shown in the schedule zone');
        // The schedule is explained in two sentences, and the switch names both times.
        await dialog.getByText('Unlocks the iPhone twice a day, at the set time and 12 hours later, then locks it again. The iPhone stops accepting connections 24 hours after the passcode was last entered.', { exact: true }).waitFor();
        assert.equal(await scheduleGroup(dialog).locator('.kit-row-toggle .kit-row-desc').textContent(), 'At 03:00 and 15:00.');
        assert.equal(await timeRow.locator('.kit-row-desc').textContent(), ZONE, 'the zone is named next to the time');
        assert.equal(await dialog.getByRole('button', { name: `Use ${ZONE}`, exact: true }).count(), 0, 'nothing to adopt once the zones agree');

        // Run now: disabled until the reply, then the outcome.
        let release;
        handlers.onCommand = (command) =>
            command.type === 'run_unlock_now' ? new Promise((resolve) => { release = resolve; }) : undefined;
        await dialog.getByRole('button', { name: 'Run now', exact: true }).click();
        const runningButton = dialog.getByRole('button', { name: 'Running…', exact: true });
        await runningButton.waitFor();
        assert.equal(await runningButton.isDisabled(), true);
        assert.equal(await summary.getAttribute('data-unlock-summary'), 'running');
        assert.deepEqual(ofType(commands, 'run_unlock_now').map((command) => command.data), [{ udid: UDID }]);
        release({ result: JSON.stringify({ at: Date.now(), trigger: 'manual', outcome: 'unlocked', message: 'Locked again' }) });
        await dialog.locator('.kit-status.kit-status-success', { hasText: 'Unlocked. Locked again' }).waitFor();
        await dialog.getByRole('button', { name: 'Run now', exact: true }).waitFor();
        // A run the server refuses (too soon after the last) says when it can run.
        handlers.onCommand = (command) =>
            command.type === 'run_unlock_now' ? { error: 'A screen session was opened for this phone a moment ago. Try again in 90 s.' } : undefined;
        await dialog.getByRole('button', { name: 'Run now', exact: true }).click();
        await dialog.getByRole('alert').filter({ hasText: 'Try again in 90 s.' }).waitFor();

        // A descriptor broadcast changes Last run and the card line without reopening.
        status = { ...status, lastUnlockedAt: Date.now() - 2 * 3600000, lastRun: { at: Date.UTC(2026, 10, 10, 8, 0, 20), trigger: 'schedule', outcome: 'skipped-recent' } };
        test.sendDevice(iphone(status));
        const lastRun = dialog.locator('[data-outcome]');
        await dialog.locator('[data-outcome="skipped-recent"]').waitFor();
        assert.equal(await lastRun.locator('.kit-row-desc').textContent(), 'Skipped: the server entered the passcode less than 11 hours earlier · Tue 10 Nov, 03:00');
        assert.equal(await lastRun.getAttribute('data-tone'), null, 'a skip that needs nothing is not an error');
        const neutral = await colorOf(lastRun.locator('.kit-row-desc'));
        await iosCard.locator('.device-unlock-schedule').waitFor({ state: 'attached' });
        assert.equal(await iosCard.locator('.device-unlock-schedule').textContent(), 'Scheduled unlock · next 03:00 · last 2 h ago');
        assert.equal(await iosCard.locator('.device-unlock-schedule').getAttribute('title'), `Scheduled unlock at 03:00 and 15:00, ${ZONE}`);
        assert.equal(await iosCard.locator('.device-unlock-schedule.problem').count(), 0);

        // A failed run reads as a failure: error tone and an icon in the sheet, and on the card.
        test.sendDevice(iphone({ ...status, lastRun: { at: Date.UTC(2026, 10, 10, 8, 0, 20), trigger: 'schedule', outcome: 'failed-wake', message: 'The screen stayed dark after Home and Lock' } }));
        await dialog.locator('[data-outcome="failed-wake"][data-tone="error"]').waitFor();
        assert.equal(await lastRun.locator('.kit-row-desc').textContent(), 'Failed: the screen did not wake · Tue 10 Nov, 03:00. The screen stayed dark after Home and Lock');
        assert.notEqual(await colorOf(lastRun.locator('.kit-row-desc')), neutral, 'a failure is not the grey of a success');
        assert.equal(await lastRun.locator('.settings-problem svg').count(), 1);
        assert.equal(await summary.getAttribute('data-tone'), 'error');
        assert.match(await summary.locator('.kit-row-desc').textContent(), /Last run: Failed: the screen did not wake$/);
        assert.equal(await iosCard.locator('.device-unlock-schedule.problem').textContent(), 'Scheduled unlock · Failed: the screen did not wake · next 03:00');
        await page.screenshot({ path: path.join(OUT, 'panel-390-failed.png') });

        // A rejected passcode pauses the schedule, and the panel and the card say so.
        test.sendDevice(iphone({ ...status, passcodeRejected: true, nextRunAt: undefined, lastRun: { at: Date.UTC(2026, 10, 10, 8, 0, 20), trigger: 'schedule', outcome: 'failed-rejected', message: 'Scheduled unlock is paused until the passcode is saved again' } }));
        await dialog.locator('[data-unlock-summary="paused"][data-tone="error"]').waitFor();
        assert.equal(await summary.locator('.kit-row-title').textContent(), 'Paused');
        assert.match(await summary.locator('.kit-row-desc').textContent(), /rejected the stored passcode/);
        await dialog.locator('.kit-row-desc', { hasText: 'Rejected by the phone. Replace it to resume the schedule.' }).waitFor();
        assert.equal(await iosCard.locator('.device-unlock-schedule.problem').textContent(), 'Scheduled unlock paused: passcode rejected');
        test.sendDevice(iphone(status));
        await dialog.locator('[data-unlock-summary="on"]').waitFor();

        // An error reply lands in a SheetStatus with role="alert".
        handlers.onCommand = (command) => (command.type === 'update_unlock_schedule' ? { error: 'Scheduled unlock is not available' } : undefined);
        const before = ofType(commands, 'update_unlock_schedule').length;
        await dialog.getByLabel('Unlock time').fill('04:30');
        await dialog.getByLabel('Unlock time').press('Enter');
        await dialog.getByRole('alert').filter({ hasText: 'Scheduled unlock is not available' }).waitFor();
        assert.equal(ofType(commands, 'update_unlock_schedule').length, before + 1, 'a picked time is sent once');
        assert.deepEqual(ofType(commands, 'update_unlock_schedule').at(-1).data, { udid: UDID, schedule: { time: '04:30', timeZone: ZONE } });
        assert.equal(await dialog.getByLabel('Unlock time').inputValue(), '03:00', 'a time the server refused is not left in the field');

        // A waiting Remove prompt goes away when the passcode is removed from another browser.
        await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
        await dialog.getByRole('alertdialog').waitFor();
        test.sendDevice(iphone({ ...status, hasPasscode: false, nextRunAt: undefined }));
        await dialog.getByRole('alertdialog').waitFor({ state: 'detached', timeout: 2000 });
        assert.equal(ofType(commands, 'clear_unlock_passcode').length, 0, 'nothing was sent');
        test.sendDevice(iphone(status));
        await dialog.getByRole('button', { name: 'Remove', exact: true }).waitFor();
        assert.equal(await dialog.getByRole('alertdialog').count(), 0, 'the withdrawn prompt does not come back');

        // Remove brings the fields back.
        handlers.onCommand = (command) => (command.type === 'clear_unlock_passcode' ? { result: JSON.stringify({ ...status, hasPasscode: false, enabled: false }) } : undefined);
        await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
        // Remove only arms a confirm prompt; its button ignores presses for the first 500 ms.
        const removal = dialog.getByRole('alertdialog');
        await removal.locator('.kit-confirm-actions .kit-button:not([aria-disabled])').first().waitFor();
        assert.equal(ofType(commands, 'clear_unlock_passcode').length, 0, 'Remove alone sends nothing');
        await removal.getByRole('button', { name: 'Remove passcode', exact: true }).click();
        await field.waitFor();
        assert.deepEqual(ofType(commands, 'clear_unlock_passcode').map((command) => command.data), [{ udid: UDID }]);
        assert.equal(await toggle.isDisabled(), true);

        // Removing the passcode leaves the switch on: the panel and the card say it cannot run.
        test.sendDevice(iphone({ ...status, hasPasscode: false, enabled: true, nextRunAt: undefined }));
        await page.waitForFunction((selector) => document.querySelector(selector)?.checked === true, SCHEDULE_SWITCH);
        assert.equal(await toggle.isDisabled(), false, 'a switch left on can be turned off without a passcode');
        assert.equal(await summary.getAttribute('data-unlock-summary'), 'blocked');
        assert.equal(await summary.locator('.kit-row-title').textContent(), 'On, but cannot run');
        assert.equal(await iosCard.locator('.device-unlock-schedule.problem').textContent(), 'Scheduled unlock cannot run: no passcode');
        handlers.onCommand = (command) =>
            command.type === 'update_unlock_schedule' ? { result: JSON.stringify({ ...status, hasPasscode: false, enabled: false, nextRunAt: undefined }) } : undefined;
        await toggle.click();
        await dialog.getByText('Scheduled unlock is off.', { exact: true }).waitFor();
        assert.deepEqual(ofType(commands, 'update_unlock_schedule').at(-1).data, { udid: UDID, schedule: { enabled: false } });
        assert.equal(await toggle.isDisabled(), true, 'once off, it waits for a passcode again');

        // The passcode left the browser exactly once.
        assert.equal(commands.filter((command) => JSON.stringify(command).includes(PASSCODE)).length, 1);

        await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.deepEqual(test.errors, []);
        console.log('PASS iOS settings panel: summary row, passcode asked twice, zone, toggle, run now and its refusal, failure tone, paused state, error alert, remove');
    } finally {
        await test.context.close();
    }
}

// A desktop time field changes its value with every segment typed. Nothing is sent until the
// time is finished, and the field keeps focus while it is being saved.
async function timeTypingFlow(browser) {
    const status = { enabled: true, time: '03:00', hasPasscode: true, timeZone: 'Europe/Berlin', nextRunAt: Date.UTC(2026, 10, 11, 2, 0) };
    const test = await start(browser, { width: 1280, height: 800, mobile: false, status });
    const { page, commands, handlers } = test;
    try {
        const dialog = await openPanel(page);
        const time = dialog.getByLabel('Unlock time');
        const description = dialog.locator('[data-unlock-time] .kit-row-desc');
        const feedback = dialog.locator('.settings-time-feedback');
        const isFocused = () => time.evaluate((el) => document.activeElement === el);
        assert.equal(await description.textContent(), 'Europe/Berlin');
        // The schedule was saved from another zone: both are named, and nothing changes unasked.
        await dialog.getByText(`The time is in Europe/Berlin. This browser is in ${ZONE}.`, { exact: true }).waitFor();

        let release;
        handlers.onCommand = (command) =>
            command.type === 'update_unlock_schedule' ? new Promise((resolve) => { release = resolve; }) : undefined;
        await time.focus();
        for (const key of ['0', '4', '3', '0']) {
            await page.keyboard.press(key);
            await page.waitForTimeout(60);
        }
        assert.equal(await time.inputValue(), '04:30', 'every digit lands in the field');
        assert.equal(ofType(commands, 'update_unlock_schedule').length, 0, 'typing sends nothing');
        assert.equal(await isFocused(), true, 'the field keeps focus between segments');
        assert.equal(await description.textContent(), 'Europe/Berlin', 'the compact row keeps its zone while feedback grows below');
        assert.equal(await feedback.textContent(), 'Not saved yet. Press Enter or leave the field to save.');

        await page.keyboard.press('Enter');
        await dialog.getByText('Saving…', { exact: true }).waitFor();
        assert.deepEqual(ofType(commands, 'update_unlock_schedule').map((command) => command.data), [{ udid: UDID, schedule: { time: '04:30', timeZone: ZONE } }]);
        assert.equal(await time.isDisabled(), false, 'the field being edited is not disabled by its own save');
        assert.equal(await isFocused(), true);
        assert.equal(await time.inputValue(), '04:30', 'and it does not jump back to the old time while saving');
        release({ result: JSON.stringify({ ...status, time: '04:30', timeZone: ZONE, nextRunAt: Date.UTC(2026, 10, 11, 9, 30) }) });
        await page.waitForFunction(() => document.querySelector('.settings-time-feedback')?.textContent.startsWith('Saved'));
        assert.equal(await description.textContent(), ZONE, 'the saved zone stays beside the native field');
        assert.equal(await feedback.textContent(), 'Saved, next run Wed 11 Nov, 04:30', 'full-width feedback keeps the result and next run below the stable field');
        assert.equal(await feedback.getByRole('status').count(), 1, 'one result announcement, without a duplicate saved line');
        assert.equal(await dialog.locator('.kit-status').count(), 1, 'only that result line announces the saved time');

        // Arrow keys step a segment; leaving the field saves the result once.
        handlers.onCommand = (command) => (command.type === 'update_unlock_schedule' ? { result: JSON.stringify({ ...status, time: command.data.schedule.time, timeZone: ZONE }) } : undefined);
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(100);
        assert.equal(ofType(commands, 'update_unlock_schedule').length, 1, 'stepping sends nothing');
        const stepped = await time.inputValue();
        assert.notEqual(stepped, '04:30');
        // Tab alone stops on the field's own picker button; leaving the field is what saves.
        await time.evaluate((el) => el.blur());
        await page.waitForFunction(() => document.querySelector('.settings-time-feedback')?.textContent.startsWith('Saved'));
        assert.deepEqual(ofType(commands, 'update_unlock_schedule').map((command) => command.data.schedule.time), ['04:30', stepped]);
        assert.equal(await time.inputValue(), stepped);

        // The other zone is adopted only on request, with the time as it stands.
        const adopt = dialog.getByRole('button', { name: `Use ${ZONE}`, exact: true });
        assert.equal(await adopt.count(), 0, 'saving the time from this browser already moved the schedule to its zone');
        assert.deepEqual(test.errors, []);
        console.log('PASS iOS settings time field: typed by segment, saved on Enter and on blur, focus kept, confirmed in the row');
    } finally {
        await test.context.close();
    }
}

async function narrowFlow(browser) {
    const test = await start(browser, { width: 320, height: 568 });
    const { page } = test;
    try {
        const row = page.locator(`[data-device-key="ios:${UDID}"] .device-primary-actions`);
        const button = row.getByRole('button', { name: 'Settings for iPhone fixture', exact: true });
        await button.waitFor();
        // The card has a Notifications button only for an iPhone that sends its notifications here.
        await page.route('**/api/notifications/summary', (route) =>
            route.fulfill({ status: 200, json: { sources: [{ id: UDID, name: 'iPhone fixture' }], unread: 0, unreadBySource: {} } }));
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await row.locator('.device-notification-history').waitFor();
        const geometry = await row.evaluate((el) => ({
            rowOverflow: el.scrollWidth > el.clientWidth + 1,
            pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            children: [...el.children].map((child) => child.getBoundingClientRect().toJSON()),
        }));
        assert.equal(geometry.rowOverflow, false, 'the action row does not overflow at 320px');
        assert.equal(geometry.pageOverflow, false, 'no horizontal page scroll at 320px');
        assert.equal(geometry.children.length, 3, 'Open screen, Notifications and Settings');
        for (const box of geometry.children) {
            assert.ok(box.left >= -1 && box.right <= 321, `every action stays inside the viewport: ${JSON.stringify(box)}`);
            assert.ok(box.height >= 44, 'actions keep a 44px touch target');
        }
        await page.screenshot({ path: path.join(OUT, 'device-list-320.png') });
        await button.click();
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
        await dialog.waitFor();
        await settleMotion(page);
        assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, 'the panel does not overflow at 320px');
        await page.screenshot({ path: path.join(OUT, 'panel-320.png') });
        assert.deepEqual(test.errors, []);
        console.log('PASS iOS settings at 320px: three-button row and panel fit');
    } finally {
        await test.context.close();
    }
}

// Phone and desktop, light and dark: the failed state fits, and stays distinct from a neutral row.
async function themeFlow(browser) {
    const status = {
        enabled: true, time: '03:00', hasPasscode: true, serverTimeZone: 'UTC', nextRunAt: Date.UTC(2026, 10, 11, 3, 0),
        lastUnlockedAt: Date.now() - 40 * 3600000,
        lastRun: { at: Date.UTC(2026, 10, 10, 3, 0, 20), trigger: 'schedule', outcome: 'failed-rejected', message: 'Scheduled unlock is paused until the passcode is saved again' },
    };
    for (const [width, height, mobile] of [[390, 844, true], [1280, 800, false]]) {
        for (const colorScheme of ['light', 'dark']) {
            const test = await start(browser, { width, height, mobile, colorScheme, status });
            const { page } = test;
            try {
                const card = page.locator(`[data-device-key="ios:${UDID}"] .device-unlock-schedule.problem`);
                await card.waitFor();
                await settleMotion(page);
                await page.screenshot({ path: path.join(OUT, `device-list-failed-${width}-${colorScheme}.png`) });
                const dialog = await openPanel(page);
                const lastRun = dialog.locator('[data-outcome="failed-rejected"]');
                const runNow = dialog.locator('.kit-row', { hasText: 'Run now' }).locator('.kit-row-desc');
                assert.notEqual(await colorOf(lastRun.locator('.kit-row-desc')), await colorOf(runNow), `${colorScheme}: a failure is not the neutral grey`);
                assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, `${width} ${colorScheme}: no horizontal overflow`);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
                await page.screenshot({ path: path.join(OUT, `panel-failed-${width}-${colorScheme}.png`) });
                await dialog.getByRole('button', { name: 'Replace', exact: true }).click();
                await dialog.getByLabel('Repeat the passcode').scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(OUT, `panel-passcode-${width}-${colorScheme}.png`) });
                assert.deepEqual(test.errors, []);
            } finally {
                await test.context.close();
            }
        }
    }
    console.log('PASS iOS settings failed state at 390 and 1280, light and dark');
}

// The stream page's Unlock sheet: the server types the stored passcode. The browser holds no
// passcode, offers no field for one, and sends nothing to the phone itself.
async function streamUnlockFlow(browser) {
    const legacy = { [`ws-scrcpy:passcode:${UDID}`]: JSON.stringify({ value: PASSCODE, mode: 'pin' }) };
    const stored = { enabled: true, time: '03:00', hasPasscode: true, timeZone: ZONE, nextRunAt: Date.UTC(2026, 10, 11, 8, 0) };
    // With a stored passcode the lock notice unlocks in one tap (scripts/e2e-unlock.js covers
    // that); the sheet itself is opened from Actions.
    const openUnlock = async (page, mobile) => {
        if (mobile) {
            await page.locator('.floating-toolbar-fab').click();
            await settleMotion(page);
        }
        await page.locator('.control-buttons-list [title="Actions"]').click();
        await settleMotion(page);
        await page.getByRole('dialog', { name: 'Actions', exact: true }).getByRole('button', { name: 'Unlock', exact: true }).click();
        await settleMotion(page);
        const dialog = page.getByRole('dialog', { name: 'Unlock phone', exact: true });
        await dialog.waitFor();
        return dialog;
    };
    for (const [width, height, mobile] of [[390, 844, true], [1280, 800, false]]) {
        const test = await start(browser, { width, height, mobile, status: stored, device: { session: 'ready', 'screen.power': 'on' }, stream: true, storage: legacy });
        const { page, commands, handlers } = test;
        try {
            assert.deepEqual(
                await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('passcode'))),
                [],
                'a passcode an earlier version saved for this iPhone is removed on load',
            );
            const dialog = await openUnlock(page, mobile);
            assert.equal(await dialog.locator('input').count(), 0, 'no passcode field: nothing to mistype, prefill or resend');
            const button = dialog.getByRole('button', { name: 'Unlock', exact: true });
            // Read while the sheet is closed too.
            const state = page.locator('[data-unlock-state]');
            assert.equal(await state.getAttribute('data-unlock-state'), 'idle');
            await page.screenshot({ path: path.join(OUT, `stream-unlock-${width}.png`) });

            let release;
            handlers.onCommand = (command) =>
                command.type === 'run_unlock_now' ? new Promise((resolve) => { release = resolve; }) : undefined;
            await button.click();
            await dialog.locator('[data-unlock-state="waiting"]').waitFor();
            assert.equal(await button.getAttribute('aria-busy'), 'true');
            for (let i = 0; i < 100 && !release; i++) await page.waitForTimeout(20);
            assert.deepEqual(ofType(commands, 'run_unlock_now').map((command) => command.data), [{ udid: UDID, keepUnlocked: true }]);
            // Still locked after the digits: said plainly, and nothing is sent again.
            release({ result: JSON.stringify({ at: Date.now(), trigger: 'manual', outcome: 'failed-rejected', message: 'Scheduled unlock is paused until the passcode is saved again' }) });
            await dialog.locator('[data-unlock-state="failed"]').waitFor();
            assert.equal(await state.textContent(), 'Failed: the stored passcode was rejected. Scheduled unlock is paused until the passcode is saved again.');
            await page.waitForTimeout(300);
            assert.equal(ofType(commands, 'run_unlock_now').length, 1, 'a failure is never retried by the page');

            // The server's status now says rejected: the only action left is to save it again.
            test.sendDevice(iphone({ ...stored, passcodeRejected: true, nextRunAt: undefined }, { session: 'ready', 'screen.power': 'on' }));
            const settings = dialog.getByRole('button', { name: 'Open Settings', exact: true });
            await settings.waitFor();
            assert.equal(await button.isDisabled(), true);
            await page.getByRole('button', { name: 'Close Unlock phone' }).click();
            test.sendDevice(iphone(stored, { session: 'ready', 'screen.power': 'on' }));

            // A confirmed unlock: the server's answer, then the phone's own report closes the sheet.
            await openUnlock(page, mobile);
            handlers.onCommand = (command) =>
                command.type === 'run_unlock_now' ? { result: JSON.stringify({ at: Date.now(), trigger: 'manual', outcome: 'unlocked' }) } : undefined;
            await button.click();
            await page.waitForFunction(() => document.querySelector('[data-unlock-state="waiting"]')?.textContent.includes('Waiting for the phone to confirm'));
            test.sendDevice(iphone(stored, { session: 'ready', 'screen.power': 'on', 'device.locked': false }));
            await dialog.waitFor({ state: 'hidden' });
            assert.equal(await state.getAttribute('data-unlock-state'), 'confirmed');
            assert.equal(await state.textContent(), 'Phone confirmed unlocked.');
            test.sendDevice(iphone(stored, { session: 'ready', 'screen.power': 'on' }));

            // A run the server refuses says when it can run.
            await openUnlock(page, mobile);
            handlers.onCommand = (command) =>
                command.type === 'run_unlock_now' ? { error: 'A screen session was opened for this phone a moment ago. Try again in 90 s.' } : undefined;
            await button.click();
            await dialog.locator('[data-unlock-state="failed"]').waitFor();
            assert.match(await state.textContent(), /Try again in 90 s\.$/);
            await page.getByRole('button', { name: 'Close Unlock phone' }).click();

            // No stored passcode: the sheet leads to Settings instead of asking for one.
            test.sendDevice(iphone({ ...BASE_STATUS }, { session: 'ready', 'screen.power': 'on' }));
            await openUnlock(page, mobile);
            await dialog.getByText(/^No passcode is stored on the server for this phone\./).waitFor();
            await settings.click();
            await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor();
            await settleMotion(page);
            await page.getByLabel('Passcode for scheduled unlock').waitFor();
            assert.equal(await page.getByRole('dialog', { name: 'Unlock phone', exact: true }).count(), 0, 'one sheet at a time');

            assert.deepEqual(test.streamMessages.filter((message) => ['key', 'touch', 'button'].includes(message.type)), [], 'the page itself types and touches nothing');
            assert.ok(!(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).includes(PASSCODE));
            assert.ok(!JSON.stringify(commands).includes(PASSCODE), 'no passcode in any command');
            assert.deepEqual(test.errors, []);
            console.log('PASS iOS stream Unlock', mobile ? 'phone' : 'desktop', 'server-run unlock, failure without resend, rejected and missing passcode lead to Settings, legacy copy removed');
        } finally {
            await test.context.close();
        }
    }
}

// C-client-ui-7: a phone that dropped off USB stays in the list with its schedule line, and the
// panel is where the owner looks for the last run and turns the schedule off.
async function disconnectedFlow(browser) {
    const status = {
        enabled: true, time: '03:00', hasPasscode: true, timeZone: ZONE, nextRunAt: Date.UTC(2026, 10, 12, 8, 0),
        lastRun: { at: Date.UTC(2026, 10, 11, 8, 0, 20), trigger: 'schedule', outcome: 'skipped-disconnected', message: 'The phone is not connected' },
    };
    const gone = { state: 'disconnected', session: 'stopped', 'screen.power': 'unknown', 'device.locked': 'unknown' };
    for (const [width, height, mobile] of [[320, 640, true], [390, 844, true], [1280, 800, false]]) {
        for (const colorScheme of ['light', 'dark']) {
            const test = await start(browser, { width, height, mobile, colorScheme, status, device: gone });
            const { page, commands, handlers } = test;
            const label = `${width} ${colorScheme}`;
            try {
                const card = page.locator(`[data-device-key="ios:${UDID}"]`);
                await card.locator('.device-unlock-schedule').waitFor();
                assert.equal(await card.getByRole('button', { name: 'Open screen', exact: true }).isDisabled(), true);
                const settings = card.getByRole('button', { name: 'Settings for iPhone fixture', exact: true });
                assert.ok(await settings.isVisible(), `${label}: Settings stays on a disconnected iPhone's card`);
                assert.ok(await settings.isEnabled());
                const row = await card.locator('.device-primary-actions').evaluate((el) => ({
                    overflow: el.scrollWidth > el.clientWidth + 1,
                    page: document.documentElement.scrollWidth > innerWidth + 1,
                }));
                assert.deepEqual(row, { overflow: false, page: false }, `${label}: the action row fits`);
                await settleMotion(page);
                await page.screenshot({ path: path.join(OUT, `device-list-disconnected-${width}-${colorScheme}.png`) });

                const dialog = await openPanel(page);
                await dialog.getByText('The phone is not connected. Changes are kept on the server and apply when it is back.').waitFor();
                assert.match(await dialog.locator('[data-outcome="skipped-disconnected"]').textContent(), /Last run/);
                const run = dialog.locator('[data-unlock-run]');
                assert.equal(await run.getAttribute('data-unlock-run'), 'unavailable');
                assert.equal(await run.locator('.kit-row-desc').textContent(), 'Not available while the phone is not connected.');
                assert.equal(await run.getByRole('button', { name: 'Run now', exact: true }).isDisabled(), true, `${label}: no run without a phone`);
                assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, `${label}: no horizontal overflow`);
                await run.scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(OUT, `panel-disconnected-${width}-${colorScheme}.png`) });

                // The schedule can still be turned off: the command needs the server, not the phone.
                handlers.onCommand = (command) =>
                    command.type === 'update_unlock_schedule' ? { result: JSON.stringify({ ...status, enabled: false, nextRunAt: undefined }) } : undefined;
                await dialog.getByRole('switch', { name: 'Unlock twice a day' }).click();
                await dialog.getByText('Scheduled unlock is off.').waitFor();
                assert.deepEqual(ofType(commands, 'update_unlock_schedule').map((command) => command.data.schedule), [{ enabled: false }]);
                assert.equal(ofType(commands, 'run_unlock_now').length, 0);

                // Back on USB: Run now is offered again without reopening the panel.
                test.sendDevice(iphone({ ...status, enabled: false }, { state: 'Connected' }));
                await dialog.locator('[data-unlock-run="ready"]').waitFor();
                assert.equal(await run.getByRole('button', { name: 'Run now', exact: true }).isEnabled(), true);
                assert.deepEqual(test.errors, []);
            } finally {
                await test.context.close();
            }
        }
    }
    console.log('PASS iOS settings for a disconnected phone at 320, 390 and 1280, light and dark');
}

// C-ios-unlock-11: the reply to Run now never arrives (the tracker socket dropped during the run).
// The device update that reports the finished run ends the wait.
async function lostRunReplyFlow(browser) {
    const status = { enabled: true, time: '03:00', hasPasscode: true, timeZone: ZONE, lastRun: { at: 1000, trigger: 'schedule', outcome: 'unlocked' } };
    const test = await start(browser, { status });
    const { page, commands } = test;
    try {
        // One sheet, Settings, for both kinds of phone (U-settings-9). The Android phone's first.
        const androidCard = page.locator(`[data-device-key="android:${ANDROID_UDID}"]`);
        await androidCard.getByRole('button', { name: 'Settings for Fixture Pixel fixture', exact: true }).click();
        await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor();
        await settleMotion(page);
        await page.getByRole('button', { name: 'Close Settings' }).click();
        await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'hidden' });

        const dialog = await openPanel(page);
        const button = dialog.locator('[data-unlock-run]').getByRole('button');
        await button.click();
        await dialog.getByRole('button', { name: 'Running…', exact: true }).waitFor();
        assert.equal(ofType(commands, 'run_unlock_now').length, 1);
        // The run is reported as started: still running, the old result does not end it.
        test.sendDevice(iphone({ ...status, running: true }));
        await page.waitForTimeout(300);
        assert.equal(await button.textContent(), 'Running…');
        // The run ended. No reply to the command was ever sent.
        const finished = { at: Date.now(), trigger: 'manual', outcome: 'failed-wake', message: 'The screen stayed dark' };
        test.sendDevice(iphone({ ...status, lastRun: finished }));
        await dialog.getByRole('button', { name: 'Run now', exact: true }).waitFor();
        assert.equal(await button.isEnabled(), true, 'the button is not left on Running for three minutes');
        assert.match(await dialog.locator('.kit-status').last().textContent(), /Failed: the screen did not wake\. The screen stayed dark/);
        // The other controls are released with it.
        assert.equal(await dialog.getByRole('switch', { name: 'Unlock twice a day' }).isEnabled(), true);
        assert.deepEqual(test.errors, []);
        console.log('PASS iOS Run now ends with the device update when its reply is lost');
    } finally {
        await test.context.close();
    }
}

// U-flows-7, C-client-ui-9 and the Restart video reply: the iPhone stream page.
async function streamSheetsFlow(browser) {
    const stored = { enabled: true, time: '03:00', hasPasscode: true, timeZone: ZONE, nextRunAt: Date.UTC(2026, 10, 11, 8, 0) };
    for (const [width, height, mobile] of [[390, 844, true], [1280, 800, false]]) {
        const test = await start(browser, { width, height, mobile, status: stored, device: { session: 'ready', 'screen.power': 'on', 'device.locked': false }, stream: true });
        const { page, commands, handlers, sockets } = test;
        const label = mobile ? 'phone' : 'desktop';
        const settingsDialog = page.getByRole('dialog', { name: 'Settings', exact: true });
        const actionsDialog = page.getByRole('dialog', { name: 'Actions', exact: true });
        const control = async (title, shot) => {
            if (mobile) {
                await page.locator('.floating-toolbar-fab').click();
                await settleMotion(page);
            }
            const button = page.locator(`button.control-button[title="${title}"]`);
            if (shot) {
                const box = await button.boundingBox();
                assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height, `${label}: ${title} is inside the viewport`);
                await page.screenshot({ path: path.join(OUT, shot) });
            }
            await button.click();
            await settleMotion(page);
        };
        try {
            // The keyboard switch as the sheet first draws it: on, as the screen sends keys, so it
            // does not slide on while the sheet opens.
            await page.evaluate(() => {
                const observer = new MutationObserver(() => {
                    const input = document.querySelector('dialog.kit-sheet [data-section="keyboard"] input[role="switch"]');
                    if (input) {
                        window.firstKeyboardSwitch = input.checked;
                        observer.disconnect();
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });
            });
            // Settings is one of the stream controls and opens the one Settings sheet, with the
            // scheduled unlock in its Unlock section.
            await control('Settings', `stream-controls-${width}.png`);
            await settingsDialog.waitFor();
            assert.equal(await page.evaluate(() => window.firstKeyboardSwitch), true, `${label}: the keyboard switch is drawn on from the start`);
            assert.equal(await settingsDialog.getByRole('switch', { name: 'Send this keyboard to the phone' }).isChecked(), true);
            await settingsDialog.locator('[data-section="unlock"]').getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
            await page.screenshot({ path: path.join(OUT, `stream-settings-${width}.png`) });
            // This screen would start a stopped session again at once, a counted start: Stop is
            // used from the list. Restart services is still offered.
            const stopRow = settingsDialog.locator('[data-service="stream-service"]');
            assert.equal(await stopRow.getByRole('button', { name: 'Stop stream service', exact: true }).isDisabled(), true, `${label}: no Stop from the open screen`);
            assert.equal(await stopRow.locator('.kit-row-desc').textContent(), 'Running. This screen would start it again at once, so stop it from the list.');
            assert.equal(await settingsDialog.locator('[data-service="restart-services"]').getByRole('button').isDisabled(), false);
            await page.getByRole('button', { name: 'Close Settings' }).click();
            await settingsDialog.waitFor({ state: 'hidden' });

            // The Actions sheet leads there too, from its last row, and one sheet replaces the other.
            await control('Actions');
            await actionsDialog.waitFor();
            const settingsRow = actionsDialog.getByRole('button', { name: 'Open Settings', exact: true });
            await settingsRow.scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(OUT, `stream-actions-settings-row-${width}.png`) });
            await settingsRow.click();
            await settingsDialog.waitFor();
            await actionsDialog.waitFor({ state: 'hidden' });
            await page.getByRole('button', { name: 'Close Settings' }).click();
            await settingsDialog.waitFor({ state: 'hidden' });

            // Restart video: the server answers, also when it refuses a second restart.
            await control('Actions');
            await actionsDialog.waitFor();
            const restart = actionsDialog.locator('.kit-row', { hasText: 'Restart video' }).getByRole('button', { name: 'Restart video', exact: true });
            handlers.onStream = (message) => (message.type === 'restart' ? { type: 'result', id: message.id, ok: true } : undefined);
            await restart.click();
            await actionsDialog.getByText('The video was restarted.', { exact: true }).waitFor();
            handlers.onStream = (message) =>
                message.type === 'restart'
                    ? { type: 'result', id: message.id, ok: false, error: 'The video was restarted a moment ago. Try again in 27 s.' }
                    : undefined;
            await restart.click();
            await actionsDialog.getByText('The video was restarted a moment ago. Try again in 27 s.', { exact: true }).waitFor();
            assert.equal(await actionsDialog.getByText('Restarting the video…').count(), 0, `${label}: the sheet does not stay on Restarting`);
            const restarts = test.streamMessages.filter((message) => message.type === 'restart');
            assert.equal(restarts.length, 2);
            assert.ok(restarts.every((message) => Number.isInteger(message.id)), 'each restart carries an id to answer');

            // Send to phone with no answer: the stream socket drops and comes back, and the button is usable again.
            handlers.onStream = undefined;
            const draft = actionsDialog.getByLabel('Text for the phone clipboard');
            await draft.fill('note for the phone');
            const send = actionsDialog.getByRole('button', { name: 'Send to phone', exact: true });
            await send.click();
            await actionsDialog.getByText('Sending to the phone clipboard…').waitFor();
            assert.equal(await send.isDisabled(), true);
            const before = sockets.stream;
            before.close({ code: 4007, reason: 'Session stopped' });
            await actionsDialog.getByText('The connection dropped before the phone answered. Try again once the stream is back.').waitFor();
            await page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.includes('Connected'), undefined, { timeout: 10000 });
            assert.notEqual(sockets.stream, before, 'the stream reconnected');
            await page.waitForFunction(() => {
                const button = Array.from(document.querySelectorAll('dialog.kit-sheet[open] button')).find((el) => el.textContent.trim() === 'Send to phone');
                return button && !button.disabled;
            });
            await page.getByRole('button', { name: 'Close Actions' }).click();
            await actionsDialog.waitFor({ state: 'hidden' });

            // Remount with no answer, from Settings on the screen: the tracker socket drops, and
            // the service rows are not left disabled.
            await control('Settings');
            await settingsDialog.waitFor();
            const services = settingsDialog.locator('.settings-services');
            const remount = services.getByRole('button', { name: 'Remount developer image', exact: true });
            await remount.scrollIntoViewIfNeeded();
            await remount.click();
            await settingsDialog.getByRole('alertdialog', { name: 'Remount the developer image on iPhone fixture?', exact: true })
                .locator('.kit-confirm-go:not([aria-disabled])').waitFor();
            await settingsDialog.getByRole('button', { name: 'Remount', exact: true }).click();
            await services.getByText('Remounting the developer image…').waitFor();
            // Busy retains the active button's focus and blocks repeat activation; the other
            // service actions remain natively disabled until this request has an outcome.
            assert.equal(await remount.isDisabled(), false);
            assert.equal(await remount.getAttribute('aria-busy'), 'true');
            assert.equal(await remount.getAttribute('aria-disabled'), 'true');
            assert.equal(await remount.evaluate((button) => button === document.activeElement), true);
            for (const id of ['stream-service', 'restart-services', 'refresh']) {
                assert.equal(await services.locator(`[data-service="${id}"] button`).isDisabled(), true);
            }
            await remount.evaluate((button) => { button.click(); button.click(); });
            assert.equal(ofType(commands, 'remount_ddi').length, 1);
            sockets.tracker.close();
            await settingsDialog.getByText('The connection to the server dropped before it answered. Check the result once it is back.').waitFor();
            // With the tracker back, a command is answered by request id and its text is shown.
            await page.waitForFunction(() => !!document.querySelector('.kit-bar-name')?.textContent.includes('iPhone fixture'), undefined, { timeout: 10000 });
            for (const name of ['Restart services', 'Remount developer image', 'Refresh info']) {
                const button = name === 'Refresh info' ? services.locator('[data-service="refresh"]').getByRole('button') : services.getByRole('button', { name, exact: true });
                await page.waitForFunction((el) => !el.disabled, await button.elementHandle(), { timeout: 10000 });
            }
            handlers.onCommand = (command) => (command.type === 'refresh_device' ? { result: null } : undefined);
            await page.waitForTimeout(2500);
            await services.locator('[data-service="refresh"]').getByRole('button').click();
            await services.getByText('Phone info refreshed.', { exact: true }).waitFor({ timeout: 10000 });
            assert.equal(ofType(commands, 'refresh_device').length, 1);

            assert.deepEqual(test.errors, []);
            console.log('PASS iOS stream sheets', label, 'Settings from the controls and Actions, restart reply, a request ends when its socket drops');
        } finally {
            await test.context.close();
        }
    }
}

// U-settings-9, U-settings-7: one Settings sheet for both kinds of phone. The same sections in
// the same order, with Stream left out on an iPhone, whose stream has no settings; the Saved
// passcode group with one row per place a passcode is kept; the facts and the service rows,
// also for a phone that is not connected or not trusted.
async function sectionsFlow(browser) {
    const sectionsOf = (dialog) => dialog.locator('.settings-section').evaluateAll((nodes) => nodes.map((node) => node.dataset.section));
    const storesOf = (dialog) => dialog.locator('[data-section="unlock"] [data-store]').evaluateAll((rows) => rows.map((row) => [row.dataset.store, row.dataset.storeState]));
    for (const [width, height, mobile, colorScheme] of [[390, 844, true, 'light'], [1280, 800, false, 'dark']]) {
        const label = `${width} ${colorScheme}`;
        const test = await start(browser, { width, height, mobile, colorScheme });
        const { page, commands, handlers } = test;
        try {
            await page.locator(`[data-device-key="android:${ANDROID_UDID}"]`).getByRole('button', { name: 'Settings for Fixture Pixel fixture', exact: true }).click();
            let dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
            await dialog.waitFor();
            await settleMotion(page);
            const android = await sectionsOf(dialog);
            assert.deepEqual(android, ['stream', 'sound', 'keyboard', 'unlock', 'about'], `${label}: Android has every section`);
            assert.deepEqual(await storesOf(dialog), [['browser', 'empty']], `${label}: an Android passcode is kept only in this browser`);
            await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
            await dialog.waitFor({ state: 'hidden' });

            dialog = await openPanel(page);
            assert.deepEqual(await sectionsOf(dialog), android.filter((section) => section !== 'stream'), `${label}: the iPhone leaves out Stream only, and keeps the order`);
            assert.deepEqual(
                await dialog.locator('.settings-section-title').allTextContents(),
                ['Sound', 'Keyboard', 'Unlock', 'About and troubleshooting'],
            );
            assert.equal(await dialog.locator('.kit-sheet-footer').count(), 0, `${label}: no Apply bar`);
            // Sound and Keyboard need the screen, and say so.
            assert.equal(await dialog.locator('.settings-audio .kit-row-desc').first().textContent(), 'Open the screen to listen.');
            const keys = dialog.getByRole('switch', { name: 'Send this keyboard to the phone' });
            assert.equal(await keys.isDisabled(), true);
            assert.equal(await dialog.locator('.settings-keyboard .kit-row').count(), 1, `${label}: the iPhone has no UHID row`);

            // Saved passcode: the server is the one place an iPhone passcode is kept.
            assert.deepEqual(await storesOf(dialog), [['server', 'empty']], `${label}: one row, for the server`);
            const server = dialog.locator('[data-store="server"]');
            assert.equal(await server.locator('.kit-row-title').textContent(), 'Server');
            assert.equal(await dialog.locator('[data-section="unlock"] .kit-group-title').first().textContent(), 'Saved passcode');
            const stored = { ...BASE_STATUS, hasPasscode: true, timeZone: ZONE };
            test.sendDevice(iphone(stored));
            await dialog.locator('[data-store="server"][data-store-state="stored"]').waitFor();
            await server.getByRole('button', { name: 'Remove', exact: true }).waitFor();
            await server.getByRole('button', { name: 'Replace', exact: true }).waitFor();
            test.sendDevice(iphone({ ...stored, passcodeRejected: true }));
            await dialog.locator('[data-store="server"][data-store-state="rejected"]').waitFor();
            await server.scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(OUT, `sections-unlock-${width}-${colorScheme}.png`) });

            // About and troubleshooting: the facts in words, and the service rows with their prompts.
            const about = dialog.locator('[data-section="about"]');
            const fact = (name) => about.locator(`[data-fact="${name}"] .kit-row-value`).textContent();
            assert.equal(await fact('status'), 'Asleep');
            assert.equal(await about.locator('[data-fact="model"] .kit-row-desc').textContent(), 'iPhone 13 Pro Max');
            assert.equal(await fact('system'), '27.2');
            assert.equal(await fact('screen'), 'Asleep');
            assert.equal(await fact('lock'), 'Locked');
            assert.equal(await fact('session'), 'Stopped');
            assert.equal(await fact('paired'), 'Yes');
            assert.equal(await fact('developer-mode'), 'On');
            assert.equal(await fact('connection'), 'Connected');
            const service = (id) => about.locator(`[data-service="${id}"]`).getByRole('button');
            assert.equal(await service('stream-service').isDisabled(), true, `${label}: no session to stop`);
            handlers.onCommand = (command) => (command.type === 'refresh_device' ? { result: null } : command.type === 'restart_session' ? { result: null } : undefined);
            await service('refresh').click();
            await about.getByText('Phone info refreshed.', { exact: true }).waitFor();
            await service('restart-services').click();
            // Found by its name: the ids that name a prompt in the sheet are its own.
            const prompt = about.getByRole('alertdialog', { name: 'Restart services on iPhone fixture?', exact: true });
            await prompt.waitFor();
            const duplicates = await page.evaluate(() => {
                const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
                return ids.filter((id, index) => ids.indexOf(id) !== index);
            });
            assert.deepEqual(duplicates, [], `${label}: no id is used twice`);
            assert.equal(ofType(commands, 'restart_session').length, 0, 'asked first');
            await prompt.locator('.kit-confirm-actions .kit-button:not([aria-disabled])').first().waitFor();
            await prompt.getByRole('button', { name: 'Restart services', exact: true }).click();
            await about.getByText('Services restarted. Open the screen again.', { exact: true }).waitFor();
            assert.deepEqual(ofType(commands, 'restart_session').map((command) => command.data), [{ udid: UDID }]);
            await about.locator('.settings-section-title').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(OUT, `sections-about-${width}-${colorScheme}.png`) });
            assert.equal(await page.getByText(/\b(the|this) device\b/i).count(), 0, `${label}: the sheet says phone`);

            // From the list a running session can be stopped, after its question.
            test.sendDevice(iphone(stored, { session: 'ready' }));
            await about.locator('[data-service="stream-service"] .kit-row-desc', { hasText: 'Running. Stopping it ends the screen stream for every viewer.' }).waitFor();
            await service('stream-service').click();
            const stop = about.getByRole('alertdialog', { name: 'Stop the stream service on iPhone fixture?', exact: true });
            await stop.waitFor();
            assert.equal(ofType(commands, 'kill_server').length, 0, 'asked first');
            await stop.locator('.kit-confirm-actions .kit-button:not([aria-disabled])').first().waitFor();
            await stop.getByRole('button', { name: 'Stop stream service', exact: true }).click();
            await stop.waitFor({ state: 'detached' });
            assert.deepEqual(ofType(commands, 'kill_server').map((command) => command.data), [{ udid: UDID, pid: 1 }]);

            // Not trusted: the sheet still opens from the list, with what is known of the phone.
            await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
            await dialog.waitFor({ state: 'hidden' });
            test.sendDevice(iphone(stored, { state: 'unauthorized', session: 'stopped' }));
            dialog = await openPanel(page);
            assert.deepEqual(await sectionsOf(dialog), ['sound', 'keyboard', 'unlock', 'about']);
            await dialog.getByText('The phone is not connected. Changes are kept on the server and apply when it is back.', { exact: true }).waitFor();
            assert.equal(await fact('status'), 'Unauthorized');
            assert.equal(await fact('connection'), 'Offline');
            for (const id of ['stream-service', 'restart-services', 'remount', 'refresh']) {
                assert.equal(await service(id).isDisabled(), true, `${label}: ${id} needs the phone`);
            }
            assert.equal(await about.locator('.settings-services .kit-group-hint').textContent(), 'Not available while the phone is not connected.');
            assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, `${label}: no horizontal overflow`);
            await about.locator('.settings-section-title').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(OUT, `sections-unauthorized-${width}-${colorScheme}.png`) });
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    console.log('PASS iOS settings: the sections in the order of the Android sheet without Stream, the Saved passcode rows, facts and service rows, also for an untrusted phone');
}

// 2026-11-11: an iPhone refuses new connections 24 hours after its passcode was last entered.
// The card, the panel and the stream page say so in one sentence, and the schedule shows its two
// times. Phone and desktop, light and dark.
async function lockoutFlow(browser) {
    const SENTENCE = 'The iPhone stopped accepting connections. Enter the passcode on the phone.';
    const refused = { at: Date.UTC(2026, 10, 11, 8, 0, 46), trigger: 'schedule', outcome: 'needs-manual-unlock', message: 'Enter the passcode on the phone.' };
    const status = {
        enabled: true, time: '03:00', hasPasscode: true, timeZone: ZONE, nextRunAt: Date.UTC(2026, 10, 11, 20, 0),
        lastUnlockedAt: Date.UTC(2026, 10, 10, 8, 0, 46), needsManualUnlock: true, lastRun: refused,
    };
    for (const [width, height, mobile] of [[390, 844, true], [1280, 800, false]]) {
        for (const colorScheme of ['light', 'dark']) {
            const label = `${width} ${colorScheme}`;
            const test = await start(browser, { width, height, mobile, colorScheme, status });
            const { page, commands, handlers } = test;
            try {
                // The card: the sentence as the problem line, and both times in its title.
                const card = page.locator(`[data-device-key="ios:${UDID}"]`);
                const line = card.locator('.device-unlock-schedule.problem');
                await line.waitFor();
                assert.equal(await line.textContent(), SENTENCE);
                assert.equal(await line.getAttribute('title'), `Scheduled unlock at 03:00 and 15:00, ${ZONE}`);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}: the card line does not widen the page`);
                const lineBox = await line.boundingBox();
                const cardBox = await card.boundingBox();
                assert.ok(lineBox.x >= cardBox.x && lineBox.x + lineBox.width <= cardBox.x + cardBox.width + 1, `${label}: the line stays inside the card`);
                await settleMotion(page);
                await page.screenshot({ path: path.join(OUT, `device-list-by-hand-${width}-${colorScheme}.png`) });

                // The panel: the state first, in the error tone, with the next try.
                const dialog = await openPanel(page);
                const summary = dialog.locator('[data-unlock-summary]');
                assert.equal(await summary.getAttribute('data-unlock-summary'), 'by-hand');
                assert.equal(await summary.getAttribute('data-tone'), 'error');
                assert.equal(await summary.locator('.kit-row-title').textContent(), 'Unlock the iPhone by hand');
                assert.equal(await summary.locator('.kit-row-desc').textContent(), `${SENTENCE} Next try Wed 11 Nov, 15:00.`);
                assert.equal(await summary.locator('.settings-problem svg').count(), 1);
                assert.equal(await scheduleGroup(dialog).locator('.kit-row-toggle .kit-row-desc').textContent(), 'At 03:00 and 15:00.');
                const lastRun = dialog.locator('[data-outcome="needs-manual-unlock"]');
                assert.equal(await lastRun.getAttribute('data-tone'), 'error');
                assert.equal(await lastRun.locator('.kit-row-desc').textContent(), 'The iPhone stopped accepting connections · Wed 11 Nov, 03:00. Enter the passcode on the phone.');
                const neutral = dialog.locator('.kit-row', { hasText: 'Run now' }).locator('.kit-row-desc');
                assert.notEqual(await colorOf(summary.locator('.kit-row-desc')), await colorOf(neutral), `${label}: the state is not the neutral grey`);
                assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, `${label}: no horizontal overflow`);
                assert.equal(await dialog.getByText(/device/i).count(), 0, `${label}: the panel says phone or iPhone`);
                await page.screenshot({ path: path.join(OUT, `panel-by-hand-${width}-${colorScheme}.png`) });

                // Run now on a phone that still refuses: the same sentence, as an error.
                handlers.onCommand = (command) =>
                    command.type === 'run_unlock_now' ? { result: JSON.stringify({ ...refused, at: Date.now(), trigger: 'manual' }) } : undefined;
                await dialog.getByRole('button', { name: 'Run now', exact: true }).click();
                await dialog.locator('.kit-status.kit-status-error', { hasText: SENTENCE }).waitFor();
                assert.equal(await dialog.locator('.kit-status.kit-status-error').textContent(), SENTENCE);
                assert.equal(ofType(commands, 'run_unlock_now').length, 1);

                // The passcode was entered on the phone: the server clears the state. The last run
                // is still listed, but nothing reads as a problem any more.
                const reachable = { ...status, needsManualUnlock: undefined, lastUnlockedAt: Date.now() - 2 * 3600000 };
                test.sendDevice(iphone(reachable));
                await dialog.locator('[data-unlock-summary="on"]').waitFor();
                assert.equal(await summary.getAttribute('data-tone'), 'neutral');
                assert.equal(await summary.locator('.kit-row-desc').textContent(), 'Next run Wed 11 Nov, 15:00 · Last run: The iPhone stopped accepting connections');
                assert.equal(await lastRun.getAttribute('data-tone'), null);
                assert.equal(await card.locator('.device-unlock-schedule.problem').count(), 0);
                assert.equal(await card.locator('.device-unlock-schedule').textContent(), 'Scheduled unlock · next 15:00 · last 2 h ago');

                // A slot that arrived while the phone was in use waits for it to be locked.
                test.sendDevice(iphone({ ...reachable, waitingForLock: true }, { 'device.locked': false, 'screen.power': 'on' }));
                await dialog.locator('.kit-row-desc', { hasText: 'Runs when the phone is next locked' }).waitFor();
                assert.equal(await card.locator('.device-unlock-schedule').textContent(), 'Scheduled unlock · runs when the phone is locked');
                assert.equal(await card.locator('.device-unlock-schedule.problem').count(), 0);
                assert.deepEqual(test.errors, []);
            } finally {
                await test.context.close();
            }

            // The stream page of that phone: the same sentence instead of a generic start failure,
            // also once the page has stopped retrying.
            const viewer = await start(browser, { width, height, mobile, colorScheme, status, stream: true, refusal: { message: SENTENCE, code: 4009 } });
            try {
                const problem = viewer.page.locator('.stream-start-error');
                assert.equal(await problem.locator('h2').textContent(), 'Unlock the iPhone by hand');
                assert.equal(await problem.locator('p').first().textContent(), SENTENCE);
                await problem.getByRole('button', { name: 'Retry', exact: true }).waitFor();
                // Three failed starts: the page stops trying. The sentence stays as it is.
                await viewer.page.waitForFunction(() => !document.querySelector('.stream-start-error-note'), undefined, { timeout: 15000 });
                assert.equal(await problem.locator('p').first().textContent(), SENTENCE, `${label}: no retry count is added to the sentence`);
                assert.equal(await problem.locator('h2').textContent(), 'Unlock the iPhone by hand');
                assert.equal(await viewer.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
                await settleMotion(viewer.page);
                await viewer.page.screenshot({ path: path.join(OUT, `stream-by-hand-${width}-${colorScheme}.png`) });
                assert.deepEqual(viewer.errors, []);
            } finally {
                await viewer.context.close();
            }
        }
    }
    console.log('PASS iOS unlock by hand: card, panel, Run now and stream page at 390 and 1280, light and dark; cleared state and waiting for lock');
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        const flows = [panelFlow, timeTypingFlow, narrowFlow, themeFlow, lockoutFlow, streamUnlockFlow, disconnectedFlow, lostRunReplyFlow, streamSheetsFlow, sectionsFlow];
        for (const run of process.env.SCENARIO ? flows.filter((flow) => flow.name === process.env.SCENARIO) : flows) await run(browser);
    } finally {
        await browser.close();
    }
}
module.exports = { start, openPanel, ZONE };
if (require.main === module) main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
