/* eslint-disable */
// BASE=http://127.0.0.1:8000 E2E_OUT=/tmp/ws-scrcpy-ios-settings node scripts/e2e-ios-settings.js
// The iPhone settings panel (Settings button on the iOS card, scheduled unlock rows, passcode
// field) against fixture sockets: every tracker command is captured in the browser, nothing
// reaches a phone. Runs under scripts/test-browser.js as the `ios-settings` suite.
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
const BASE_STATUS = { enabled: false, time: '03:00', hasPasscode: false };

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

function iphone(unlockSchedule) {
    return {
        udid: UDID, name: 'iPhone fixture', state: 'Connected', model: 'iPhone 13 Pro Max', version: '27.2',
        paired: true, developerMode: true, session: 'stopped', 'screen.power': 'off', 'device.locked': true,
        unlockSchedule,
    };
}
const android = {
    udid: ANDROID_UDID, state: 'device', pid: 123, interfaces: [], 'ro.product.model': 'Pixel fixture',
    'ro.product.manufacturer': 'Fixture', 'ro.build.version.release': '16', 'ro.build.version.sdk': '36',
    'ro.product.cpu.abi': 'arm64-v8a', 'screen.power': 'on', 'device.awake': true, 'battery.level': 80, 'battery.charging': false,
};

async function start(browser, { width = 390, height = 844 } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    const commands = [];
    // `onCommand(command)` returns the reply body (`{ result }` or `{ error }`), a promise of one, or nothing.
    const handlers = { onCommand: undefined };
    let trackerReply;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
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
                    reply({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [iphone(BASE_STATUS)] } });
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
    await page.goto(BASE);
    await page.locator(`[data-device-key="ios:${UDID}"]`).waitFor();
    const sendDevice = (device) => trackerReply({ id: -1, type: 'device', data: { id: 'ios', name: 'Devices', device } });
    return { context, page, errors, commands, handlers, sendDevice };
}

const ofType = (commands, type) => commands.filter((command) => command.type === type);

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

        await iosSettings.click();
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
        await dialog.waitFor();
        await settleMotion(page);
        for (const name of ['Scheduled unlock', 'Status', 'Phone']) {
            await dialog.getByRole('heading', { name, exact: true }).waitFor();
        }
        assert.match(await dialog.getByText('Developer Mode').locator('..').textContent(), /on/);
        const toggle = dialog.getByRole('checkbox', { name: 'Unlock every day' });
        assert.equal(await toggle.isDisabled(), true, 'the toggle waits for a stored passcode');
        assert.equal(await toggle.isChecked(), false);
        await dialog.getByText('Off', { exact: true }).waitFor();
        await dialog.getByText('No run yet.', { exact: true }).waitFor();
        await page.screenshot({ path: path.join(OUT, 'panel-390.png') });

        // Save: one frame, field cleared, nothing new in localStorage.
        const field = dialog.getByLabel('Passcode for scheduled unlock');
        assert.equal(await field.getAttribute('type'), 'password');
        assert.equal(await field.getAttribute('inputmode'), 'numeric');
        await field.fill(PASSCODE);
        assert.equal(commands.length, 0, 'typing in the field sends nothing');
        let status = { ...BASE_STATUS, hasPasscode: true };
        handlers.onCommand = (command) => (command.type === 'set_unlock_passcode' ? { result: JSON.stringify(status) } : undefined);
        await dialog.getByRole('button', { name: 'Save on server', exact: true }).click();
        await dialog.getByText('Passcode stored on the server.', { exact: true }).waitFor();
        assert.deepEqual(ofType(commands, 'set_unlock_passcode').map((command) => command.data), [{ udid: UDID, passcode: PASSCODE }]);
        await dialog.locator('.sheet-row-desc', { hasText: 'Stored on the server.' }).waitFor();
        assert.equal(await field.count(), 0, 'the stored passcode is shown as Replace / Remove');
        await dialog.getByRole('button', { name: 'Replace', exact: true }).click();
        assert.equal(await field.inputValue(), '', 'the field is empty after the reply');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(await field.count(), 0);
        assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).sort()), storageBefore, 'localStorage has no new key');
        assert.ok(!(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).includes(PASSCODE));
        assert.equal(await toggle.isDisabled(), false, 'the reply enables the toggle');

        // Toggle: one update frame; the reply updates the row and Next run.
        const nextRunAt = Date.now() + 3600000;
        handlers.onCommand = (command) =>
            command.type === 'update_unlock_schedule' ? { result: JSON.stringify({ ...status, enabled: true, nextRunAt }) } : undefined;
        await toggle.click();
        await page.waitForFunction(() => document.querySelector('[role="dialog"] .sheet-switch')?.checked === true);
        assert.deepEqual(ofType(commands, 'update_unlock_schedule').map((command) => command.data), [{ udid: UDID, schedule: { enabled: true } }]);
        await dialog.getByText('Scheduled unlock is on.', { exact: true }).waitFor();
        assert.equal(await dialog.getByText('Off', { exact: true }).count(), 0, 'Next run shows a time');

        // Run now: disabled until the reply, then the outcome.
        let release;
        handlers.onCommand = (command) =>
            command.type === 'run_unlock_now' ? new Promise((resolve) => { release = resolve; }) : undefined;
        await dialog.getByRole('button', { name: 'Run now', exact: true }).click();
        const runningButton = dialog.getByRole('button', { name: 'Running…', exact: true });
        await runningButton.waitFor();
        assert.equal(await runningButton.isDisabled(), true);
        assert.deepEqual(ofType(commands, 'run_unlock_now').map((command) => command.data), [{ udid: UDID }]);
        release({ result: JSON.stringify({ at: Date.now(), trigger: 'manual', outcome: 'unlocked', message: 'Locked again' }) });
        await dialog.locator('.sheet-status.success', { hasText: 'Unlocked and locked again. Locked again' }).waitFor();
        await dialog.getByRole('button', { name: 'Run now', exact: true }).waitFor();

        // A descriptor broadcast changes Last run and the card line without reopening.
        status = {
            ...status, enabled: true, nextRunAt, lastUnlockedAt: Date.now() - 2 * 3600000,
            lastRun: { at: Date.now(), trigger: 'schedule', outcome: 'skipped-recent' },
        };
        test.sendDevice(iphone(status));
        await dialog.locator('[data-outcome="skipped-recent"]').waitFor();
        assert.match(await dialog.locator('[data-outcome="skipped-recent"]').textContent(), /Skipped: unlocked in the last 24 hours/);
        await iosCard.locator('.device-unlock-schedule').waitFor({ state: 'attached' });
        assert.equal(await iosCard.locator('.device-unlock-schedule').textContent(), 'Scheduled unlock 03:00 · last 2 h ago');

        // An error reply lands in a SheetStatus with role="alert".
        handlers.onCommand = (command) => (command.type === 'update_unlock_schedule' ? { error: 'Scheduled unlock is not available' } : undefined);
        await dialog.getByLabel('Unlock time').fill('04:30');
        await dialog.getByRole('alert').filter({ hasText: 'Scheduled unlock is not available' }).waitFor();
        assert.deepEqual(ofType(commands, 'update_unlock_schedule').at(-1).data, { udid: UDID, schedule: { time: '04:30' } });

        // Remove brings the field back.
        handlers.onCommand = (command) => (command.type === 'clear_unlock_passcode' ? { result: JSON.stringify({ ...status, hasPasscode: false, enabled: false }) } : undefined);
        await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
        await field.waitFor();
        assert.deepEqual(ofType(commands, 'clear_unlock_passcode').map((command) => command.data), [{ udid: UDID }]);
        assert.equal(await toggle.isDisabled(), true);

        // The passcode left the browser exactly once.
        assert.equal(commands.filter((command) => JSON.stringify(command).includes(PASSCODE)).length, 1);

        await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.deepEqual(test.errors, []);
        console.log('PASS iOS settings panel: card buttons, groups, passcode save, toggle, run now, broadcast update, error alert, remove');
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

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const run of [panelFlow, narrowFlow]) await run(browser);
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
