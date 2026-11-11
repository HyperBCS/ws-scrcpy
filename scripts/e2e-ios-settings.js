/* eslint-disable */
// BASE=http://127.0.0.1:8000 E2E_OUT=/tmp/ws-scrcpy-ios-settings node scripts/e2e-ios-settings.js
// The iPhone settings panel (Settings button on the iOS card, scheduled unlock rows, passcode
// fields) and the stream page's Unlock sheet, against fixture sockets: every tracker command is
// captured in the browser, nothing reaches a phone. Runs under scripts/test-browser.js as the
// `ios-settings` suite.
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

async function start(browser, { width = 390, height = 844, mobile = true, colorScheme = 'light', status = BASE_STATUS, device = {}, stream = false, storage = {} } = {}) {
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
    const errors = [];
    const commands = [];
    // Everything the page sends to the phone's stream socket: must stay free of keys and touches.
    const streamMessages = [];
    // `onCommand(command)` returns the reply body (`{ result }` or `{ error }`), a promise of one, or nothing.
    const handlers = { onCommand: undefined };
    let trackerReply;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        if (new URL(socket.url()).searchParams.get('action') === 'proxy-coredevice') {
            socket.onMessage((data) => {
                if (typeof data === 'string') streamMessages.push(JSON.parse(data));
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
    if (stream) {
        await page.waitForFunction(() => document.querySelector('.stream-header-status')?.textContent.includes('Connected'));
    } else {
        await page.locator(`[data-device-key="ios:${UDID}"]`).waitFor();
    }
    const sendDevice = (device) => trackerReply({ id: -1, type: 'device', data: { id: 'ios', name: 'Devices', device } });
    return { context, page, errors, commands, handlers, sendDevice, streamMessages };
}

const ofType = (commands, type) => commands.filter((command) => command.type === type);
const colorOf = (locator) => locator.evaluate((el) => getComputedStyle(el).color);

async function openPanel(page) {
    await page.locator(`[data-device-key="ios:${UDID}"]`).getByRole('button', { name: 'Settings for iPhone fixture', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Scheduled unlock', exact: true });
    await dialog.waitFor();
    await settleMotion(page);
    return dialog;
}

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
        assert.match(await dialog.getByText('Developer Mode').locator('..').textContent(), /on/);
        const toggle = dialog.getByRole('checkbox', { name: 'Unlock every day' });
        assert.equal(await toggle.isDisabled(), true, 'the toggle waits for a stored passcode');
        assert.equal(await toggle.isChecked(), false);
        // The group opens with one row for state and last result.
        const summary = dialog.locator('[data-unlock-summary]');
        assert.equal(await summary.getAttribute('data-unlock-summary'), 'off');
        assert.equal(await summary.locator('.sheet-row-title').textContent(), 'Off');
        assert.equal(await summary.locator('.sheet-row-desc').textContent(), 'No run yet');
        assert.equal(await dialog.locator('.sheet-row').first().getAttribute('data-unlock-summary'), 'off', 'it is the first row');
        await dialog.getByText('No run yet.', { exact: true }).waitFor();
        // A schedule saved before zones were stored is server time, and says so.
        const timeRow = dialog.locator('[data-unlock-time]');
        assert.equal(await timeRow.locator('.sheet-row-desc').textContent(), 'Server time (UTC)');
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
        await dialog.locator('.sheet-row-desc', { hasText: 'Stored on the server.' }).waitFor();
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
        await page.waitForFunction(() => document.querySelector('[role="dialog"] .sheet-switch')?.checked === true);
        assert.deepEqual(ofType(commands, 'update_unlock_schedule').map((command) => command.data), [{ udid: UDID, schedule: { enabled: true, timeZone: ZONE } }]);
        await dialog.getByText('Scheduled unlock is on.', { exact: true }).waitFor();
        assert.equal(await summary.getAttribute('data-unlock-summary'), 'on');
        assert.equal(await summary.locator('.sheet-row-title').textContent(), 'On');
        assert.equal(await summary.locator('.sheet-row-desc').textContent(), 'Next run Wed 11 Nov, 03:00 · No run yet', 'the next run is shown in the schedule zone');
        assert.equal(await timeRow.locator('.sheet-row-desc').textContent(), ZONE, 'the zone is named next to the time');
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
        await dialog.locator('.sheet-status.success', { hasText: 'Unlocked. Locked again' }).waitFor();
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
        assert.equal(await lastRun.locator('.sheet-row-desc').textContent(), 'Skipped: unlocked in the last 22 hours · Tue 10 Nov, 03:00');
        assert.equal(await lastRun.getAttribute('data-tone'), null, 'a skip that needs nothing is not an error');
        const neutral = await colorOf(lastRun.locator('.sheet-row-desc'));
        await iosCard.locator('.device-unlock-schedule').waitFor({ state: 'attached' });
        assert.equal(await iosCard.locator('.device-unlock-schedule').textContent(), 'Scheduled unlock 03:00 · last 2 h ago');
        assert.equal(await iosCard.locator('.device-unlock-schedule').getAttribute('title'), `Scheduled unlock at 03:00, ${ZONE}`);
        assert.equal(await iosCard.locator('.device-unlock-schedule.problem').count(), 0);

        // A failed run reads as a failure: error tone and an icon in the sheet, and on the card.
        test.sendDevice(iphone({ ...status, lastRun: { at: Date.UTC(2026, 10, 10, 8, 0, 20), trigger: 'schedule', outcome: 'failed-wake', message: 'The screen stayed dark after Home and Lock' } }));
        await dialog.locator('[data-outcome="failed-wake"][data-tone="error"]').waitFor();
        assert.equal(await lastRun.locator('.sheet-row-desc').textContent(), 'Failed: the screen did not wake · Tue 10 Nov, 03:00. The screen stayed dark after Home and Lock');
        assert.notEqual(await colorOf(lastRun.locator('.sheet-row-desc')), neutral, 'a failure is not the grey of a success');
        assert.equal(await lastRun.locator('svg.sheet-problem-icon').count(), 1);
        assert.equal(await summary.getAttribute('data-tone'), 'error');
        assert.match(await summary.locator('.sheet-row-desc').textContent(), /Last run: Failed: the screen did not wake$/);
        assert.equal(await iosCard.locator('.device-unlock-schedule.problem').textContent(), 'Scheduled unlock 03:00 · Failed: the screen did not wake');
        await page.screenshot({ path: path.join(OUT, 'panel-390-failed.png') });

        // A rejected passcode pauses the schedule, and the panel and the card say so.
        test.sendDevice(iphone({ ...status, passcodeRejected: true, nextRunAt: undefined, lastRun: { at: Date.UTC(2026, 10, 10, 8, 0, 20), trigger: 'schedule', outcome: 'failed-rejected', message: 'Scheduled unlock is paused until the passcode is saved again' } }));
        await dialog.locator('[data-unlock-summary="paused"][data-tone="error"]').waitFor();
        assert.equal(await summary.locator('.sheet-row-title').textContent(), 'Paused');
        assert.match(await summary.locator('.sheet-row-desc').textContent(), /rejected the stored passcode/);
        await dialog.locator('.sheet-row-desc', { hasText: 'Rejected by the phone. Replace it to resume the schedule.' }).waitFor();
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
        await removal.locator('.confirm-prompt-button:not([aria-disabled])').first().waitFor();
        assert.equal(ofType(commands, 'clear_unlock_passcode').length, 0, 'Remove alone sends nothing');
        await removal.getByRole('button', { name: 'Remove passcode', exact: true }).click();
        await field.waitFor();
        assert.deepEqual(ofType(commands, 'clear_unlock_passcode').map((command) => command.data), [{ udid: UDID }]);
        assert.equal(await toggle.isDisabled(), true);

        // Removing the passcode leaves the switch on: the panel and the card say it cannot run.
        test.sendDevice(iphone({ ...status, hasPasscode: false, enabled: true, nextRunAt: undefined }));
        await page.waitForFunction(() => document.querySelector('[role="dialog"] .sheet-switch')?.checked === true);
        assert.equal(await toggle.isDisabled(), false, 'a switch left on can be turned off without a passcode');
        assert.equal(await summary.getAttribute('data-unlock-summary'), 'blocked');
        assert.equal(await summary.locator('.sheet-row-title').textContent(), 'On, but cannot run');
        assert.equal(await iosCard.locator('.device-unlock-schedule.problem').textContent(), 'Scheduled unlock cannot run: no passcode');
        handlers.onCommand = (command) =>
            command.type === 'update_unlock_schedule' ? { result: JSON.stringify({ ...status, hasPasscode: false, enabled: false, nextRunAt: undefined }) } : undefined;
        await toggle.click();
        await dialog.getByText('Scheduled unlock is off.', { exact: true }).waitFor();
        assert.deepEqual(ofType(commands, 'update_unlock_schedule').at(-1).data, { udid: UDID, schedule: { enabled: false } });
        assert.equal(await toggle.isDisabled(), true, 'once off, it waits for a passcode again');

        // The passcode left the browser exactly once.
        assert.equal(commands.filter((command) => JSON.stringify(command).includes(PASSCODE)).length, 1);

        await page.getByRole('button', { name: 'Close Scheduled unlock', exact: true }).click();
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
        const description = dialog.locator('[data-unlock-time] .sheet-row-desc');
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
        assert.equal(await description.textContent(), 'Not saved yet. Press Enter or leave the field to save.');

        await page.keyboard.press('Enter');
        await dialog.getByText('Saving…', { exact: true }).waitFor();
        assert.deepEqual(ofType(commands, 'update_unlock_schedule').map((command) => command.data), [{ udid: UDID, schedule: { time: '04:30', timeZone: ZONE } }]);
        assert.equal(await time.isDisabled(), false, 'the field being edited is not disabled by its own save');
        assert.equal(await isFocused(), true);
        assert.equal(await time.inputValue(), '04:30', 'and it does not jump back to the old time while saving');
        release({ result: JSON.stringify({ ...status, time: '04:30', timeZone: ZONE, nextRunAt: Date.UTC(2026, 10, 11, 9, 30) }) });
        await page.waitForFunction(() => document.querySelector('[data-unlock-time] .sheet-row-desc')?.textContent.includes('· saved'));
        assert.equal(await description.textContent(), `${ZONE} · saved, next run Wed 11 Nov, 04:30`, 'confirmed in the row, with the next run');
        assert.equal(await dialog.locator('.sheet-status').count(), 0, 'no separate line for a saved time');

        // Arrow keys step a segment; leaving the field saves the result once.
        handlers.onCommand = (command) => (command.type === 'update_unlock_schedule' ? { result: JSON.stringify({ ...status, time: command.data.schedule.time, timeZone: ZONE }) } : undefined);
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(100);
        assert.equal(ofType(commands, 'update_unlock_schedule').length, 1, 'stepping sends nothing');
        const stepped = await time.inputValue();
        assert.notEqual(stepped, '04:30');
        // Tab alone stops on the field's own picker button; leaving the field is what saves.
        await time.evaluate((el) => el.blur());
        await page.waitForFunction(() => document.querySelector('[data-unlock-time] .sheet-row-desc')?.textContent.includes('· saved'));
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
        const geometry = await row.evaluate((el) => ({
            rowOverflow: el.scrollWidth > el.clientWidth + 1,
            pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            children: [...el.children].map((child) => child.getBoundingClientRect().toJSON()),
        }));
        assert.equal(geometry.rowOverflow, false, 'the action row does not overflow at 320px');
        assert.equal(geometry.pageOverflow, false, 'no horizontal page scroll at 320px');
        assert.equal(geometry.children.length, 3, 'Open screen, Settings and Notifications');
        for (const box of geometry.children) {
            assert.ok(box.left >= -1 && box.right <= 321, `every action stays inside the viewport: ${JSON.stringify(box)}`);
            assert.ok(box.height >= 44, 'actions keep a 44px touch target');
        }
        await page.screenshot({ path: path.join(OUT, 'device-list-320.png') });
        await button.click();
        const dialog = page.getByRole('dialog', { name: 'Scheduled unlock', exact: true });
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
                const runNow = dialog.locator('.sheet-row', { hasText: 'Run now' }).locator('.sheet-row-desc');
                assert.notEqual(await colorOf(lastRun.locator('.sheet-row-desc')), await colorOf(runNow), `${colorScheme}: a failure is not the neutral grey`);
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
    const openUnlock = async (page) => {
        await page.locator('.lock-screen-notice').getByRole('button', { name: 'Unlock', exact: true }).click();
        await settleMotion(page);
        const dialog = page.getByRole('dialog', { name: 'Unlock device', exact: true });
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
            const dialog = await openUnlock(page);
            assert.equal(await dialog.locator('input').count(), 0, 'no passcode field: nothing to mistype, prefill or resend');
            const button = dialog.getByRole('button', { name: 'Unlock with stored passcode', exact: true });
            const state = dialog.locator('[data-unlock-state]');
            assert.equal(await state.getAttribute('data-unlock-state'), 'idle');
            await page.screenshot({ path: path.join(OUT, `stream-unlock-${width}.png`) });

            let release;
            handlers.onCommand = (command) =>
                command.type === 'run_unlock_now' ? new Promise((resolve) => { release = resolve; }) : undefined;
            await button.click();
            const busy = dialog.getByRole('button', { name: 'Unlocking…', exact: true });
            await busy.waitFor();
            assert.equal(await busy.isDisabled(), true);
            assert.equal(await state.getAttribute('data-unlock-state'), 'running');
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
            assert.equal(await button.count(), 0);
            await page.getByRole('button', { name: 'Close Unlock device' }).click();
            test.sendDevice(iphone(stored, { session: 'ready', 'screen.power': 'on' }));

            // A confirmed unlock.
            await openUnlock(page);
            handlers.onCommand = (command) =>
                command.type === 'run_unlock_now' ? { result: JSON.stringify({ at: Date.now(), trigger: 'manual', outcome: 'unlocked' }) } : undefined;
            await button.click();
            await dialog.locator('[data-unlock-state="confirmed"]').waitFor();
            assert.equal(await state.textContent(), 'Unlocked.');
            test.sendDevice(iphone(stored, { session: 'ready', 'screen.power': 'on', 'device.locked': false }));
            await page.waitForFunction(() => document.querySelector('.unlock-sheet-actions .primary')?.disabled === true);
            await page.getByRole('button', { name: 'Close Unlock device' }).click();
            test.sendDevice(iphone(stored, { session: 'ready', 'screen.power': 'on' }));

            // A run the server refuses says when it can run.
            await openUnlock(page);
            handlers.onCommand = (command) =>
                command.type === 'run_unlock_now' ? { error: 'A screen session was opened for this phone a moment ago. Try again in 90 s.' } : undefined;
            await button.click();
            await dialog.locator('[data-unlock-state="failed"]').waitFor();
            assert.match(await state.textContent(), /Try again in 90 s\.$/);
            await page.getByRole('button', { name: 'Close Unlock device' }).click();

            // No stored passcode: the sheet leads to Settings instead of asking for one.
            test.sendDevice(iphone({ ...BASE_STATUS }, { session: 'ready', 'screen.power': 'on' }));
            await openUnlock(page);
            assert.match(await state.textContent(), /^No passcode is stored on the server for this phone\./);
            await settings.click();
            await page.getByRole('dialog', { name: 'Scheduled unlock', exact: true }).waitFor();
            await settleMotion(page);
            await page.getByLabel('Passcode for scheduled unlock').waitFor();
            assert.equal(await page.getByRole('dialog', { name: 'Unlock device', exact: true }).count(), 0, 'one sheet at a time');

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

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const run of [panelFlow, timeTypingFlow, narrowFlow, themeFlow, streamUnlockFlow]) await run(browser);
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
