// node scripts/test-browser.js unlock
// The one Unlock sheet and the lock notice, on an Android phone and on an iPhone. All sockets and
// credentials are fixtures. Never contacts, locks, or unlocks a real phone.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { fixture, UDID } = require('./e2e-settings');
const { settleMotion } = require('./ui-motion');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-unlock';
require('node:fs').mkdirSync(OUT, { recursive: true });
const PIN = '000719';
const PASSWORD = 'Fixture 7!';
const LOCKED = { 'keyguard.showing': true, 'keyguard.occluded': false, 'device.locked': true, 'screen.power': 'on' };
const UNLOCKED = { 'device.locked': false, 'keyguard.showing': false };

const REMEMBERED_KEY = `ws-scrcpy:remembered-passcode:${UDID}`;
// What both kinds of phone show in the sheet.
const TITLE = 'Unlock phone';
const HINT = 'You can also unlock on the remote screen or on the phone itself.';

async function start(browser, { mobile = true, flags = LOCKED, holdQuery = 0, storage = {}, viewport, colorScheme = 'light' } = {}) {
    const context = await browser.newContext({
        viewport: viewport || (mobile ? { width: 320, height: 568 } : { width: 1280, height: 600 }),
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme,
    });
    if (Object.keys(storage).length) {
        // Seeded once, before the app's own scripts run; a reload must not put it back.
        await context.addInitScript((entries) => {
            if (sessionStorage.getItem('fixture-seeded')) return;
            sessionStorage.setItem('fixture-seeded', '1');
            for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
        }, storage);
    }
    const page = await context.newPage();
    const hidReports = [];
    let uhidCreated = false;
    const errors = [],
        logs = [],
        texts = [],
        keys = [],
        heldReplies = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => logs.push(message.text()));
    let queryCount = 0,
        sendDeviceList,
        closeStream;
    let state = { ...flags };
    const descriptor = () => ({
        udid: UDID,
        state: 'device',
        pid: 123,
        interfaces: [],
        'ro.product.model': 'Locked fixture',
        'ro.product.manufacturer': 'Fixture',
        'ro.build.version.sdk': '37',
        'ro.build.version.release': '17',
        'device.awake': true,
        'battery.level': 80,
        ...state,
    });
    const commands = await fixture(page, {
        deviceList: [descriptor()],
        onTrackerReady: (tracker) => {
            sendDeviceList = tracker.sendDeviceList;
        },
        onStreamReady: (stream) => {
            closeStream = stream.close;
        },
        onCommand: (command, reply) => {
            if (command.type !== 'get_lock_state') return;
            queryCount++;
            const respond = () => reply({ id: command.id, type: command.type, data: { udid: UDID, ...state } });
            if (queryCount === holdQuery) heldReplies.push(respond);
            else respond();
        },
        onStreamMessage: (data) => {
            const bytes = Buffer.from(data);
            let offset = 0;
            // Parent sends complete control batches. Ignore separate stream setup messages,
            // and decode every key/text packet within an explicit unlock batch.
            while (offset < bytes.length) {
                if (bytes[offset] === 0 && offset + 14 <= bytes.length) {
                    keys.push({ action: bytes[offset + 1], code: bytes.readUInt32BE(offset + 2) });
                    offset += 14;
                } else if (bytes[offset] === 1 && offset + 5 <= bytes.length) {
                    const length = bytes.readUInt32BE(offset + 1);
                    assert(offset + 5 + length <= bytes.length, 'Complete text control frame');
                    texts.push(bytes.subarray(offset + 5, offset + 5 + length).toString());
                    offset += 5 + length;
                } else if (bytes[offset] === 13 && offset + 5 <= bytes.length) {
                    const length = bytes.readUInt16BE(offset + 3);
                    const report = bytes.subarray(offset + 5, offset + 5 + length);
                    if (report.some((byte) => byte !== 0)) hidReports.push(Buffer.from(report));
                    offset += 5 + length;
                } else if (bytes[offset] === 12) {
                    uhidCreated = true;
                    break;
                } else break;
            }
        },
    });
    const socket = new URL('/', BASE);
    socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
    socket.search = new URLSearchParams({ action: 'proxy-adb', remote: 'tcp:8886', udid: UDID }).toString();
    const url = new URL(BASE);
    url.hash = `!${new URLSearchParams({ action: 'stream', udid: UDID, player: 'mse', ws: socket.toString() })}`;
    await page.goto(url.toString());
    await page.waitForFunction(() =>
        document.querySelector('.kit-bar-status')?.textContent.includes('Connected'),
    );
    return {
        context,
        page,
        mobile,
        errors,
        logs,
        texts,
        keys,
        commands,
        hidReports,
        get uhidCreated() {
            return uhidCreated;
        },
        get queryCount() {
            return queryCount;
        },
        update(patch) {
            state = { ...state, ...patch };
            sendDeviceList([descriptor()]);
        },
        release() {
            heldReplies.splice(0).forEach((reply) => reply());
        },
        disconnect() {
            closeStream();
        },
    };
}

const field = (page) => page.locator('.unlock-field');
const status = (page) => page.locator('[data-unlock-state]');
const dialog = (page) => page.getByRole('dialog', { name: TITLE, exact: true });
const notice = (page) => page.locator('.lock-screen-notice');
const noticeUnlock = (page) => notice(page).getByRole('button', { name: 'Unlock', exact: true });
// The one action of the sheet, in its footer.
const unlockButton = (page) =>
    page.locator('dialog.kit-sheet[open] .kit-sheet-footer').getByRole('button', { name: 'Unlock', exact: true });
const closeButton = (page) => page.getByRole('button', { name: `Close ${TITLE}`, exact: true });

/** The notice's Unlock, where it opens the sheet: no passcode is saved for the phone. */
async function open(page) {
    await noticeUnlock(page).click();
    await settleMotion(page);
    await dialog(page).waitFor();
}
/** The sheet from the Actions sheet: the way to it while a passcode is saved. */
async function openFromActions(test) {
    const { page } = test;
    if (test.mobile) {
        await page.locator('.floating-toolbar-fab').click();
        await page.locator('.floating-toolbar.open').waitFor();
        await settleMotion(page);
    }
    await page.locator('.control-buttons-list [title="Actions"]').click();
    const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
    await actions.waitFor();
    await settleMotion(page);
    await actions.getByRole('button', { name: 'Unlock', exact: true }).click();
    await settleMotion(page);
    await dialog(page).waitFor();
}
async function state(page, value) {
    await page.locator(`[data-unlock-state="${value}"]`).waitFor({ state: 'attached' });
}
/** Sent once: the sheet waits for the phone to confirm. */
async function sent(page) {
    await state(page, 'waiting');
    await page.waitForFunction(() => document.querySelector('[data-unlock-state]')?.textContent.includes('Waiting for the phone to confirm'));
}
async function closed(page) {
    await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' });
}
const passcodeKeys = (page) =>
    page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('passcode')).sort());
const activeIsField = (page) => page.evaluate(() => document.activeElement?.classList.contains('unlock-field'));
async function noLeaks(test) {
    const storage = await test.page.evaluate((remembered) => ({
        local: Object.fromEntries(Object.entries(localStorage).filter(([key]) => key !== remembered)),
        session: { ...sessionStorage },
        url: location.href,
    }), REMEMBERED_KEY);
    for (const secret of [PIN, PASSWORD]) {
        assert(!JSON.stringify(storage).includes(secret), 'A passcode is only ever in the one entry the owner asked for, never in session storage or URLs');
        assert(!test.logs.some((log) => log.includes(secret)), 'No credential in browser logs');
        assert(!JSON.stringify(test.commands).includes(secret), 'Tracker commands never contain credentials');
    }
    assert.deepEqual(test.errors, [], 'No browser exceptions');
}
/** What both kinds of phone share: the title, the one Unlock button, the hint, the live region. */
async function sameSheet(page, label) {
    assert.equal(await dialog(page).locator('.kit-sheet-title').textContent(), TITLE, `${label}: title`);
    const footer = page.locator('dialog.kit-sheet[open] .kit-sheet-footer');
    assert.deepEqual(await footer.getByRole('button').allTextContents(), ['Unlock'], `${label}: one action, Unlock`);
    assert.equal(await footer.locator('.kit-button-primary').count(), 1, `${label}: and it is the primary one`);
    await dialog(page).getByText(HINT, { exact: true }).waitFor();
    assert.equal(await status(page).getAttribute('aria-live'), 'polite', `${label}: the feedback is a live region before its first message`);
    assert.equal(await dialog(page).getByText(/device/i).count(), 0, `${label}: the sheet says phone`);
}

async function androidFlow(browser, mobile) {
    const test = await start(browser, { mobile });
    const { page } = test;
    const label = `Android ${mobile ? 'phone' : 'desktop'}`;
    const box = await notice(page).boundingBox();
    const stage = await page.locator('.stream-stage').boundingBox();
    assert(box.y + box.height <= stage.y + 1, 'Lock notice does not cover the controllable stream');
    const awakeNotice = await notice(page).screenshot({ animations: 'disabled' });
    test.update({ 'screen.power': 'off', 'device.awake': false });
    await page.getByText('Screen is asleep', { exact: true }).waitFor();
    const asleepNotice = await notice(page).screenshot({ animations: 'disabled' });
    assert(awakeNotice.equals(asleepNotice), 'The lock notice is equally bright while the phone is asleep');
    await open(page);
    test.update({ 'screen.power': 'on', 'device.awake': true });
    await sameSheet(page, label);
    // The field, and the choice of PIN or password, are Android's.
    assert.equal(await dialog(page).getByRole('radio', { name: 'PIN', exact: true }).isChecked(), true);
    await dialog(page).getByRole('radio', { name: 'Password', exact: true }).waitFor();
    // A mouse and a keyboard: the field has focus, so typing goes into it at once. On a touch
    // screen it does not, so no keyboard comes up over the sheet before it is asked for.
    if (mobile) {
        await page.waitForTimeout(150);
        assert.equal(await activeIsField(page), false, `${label}: the field waits for a tap`);
    } else {
        await page.waitForFunction(() => document.activeElement?.classList.contains('unlock-field'));
    }
    const remember = page.getByRole('checkbox', { name: 'Remember in this browser', exact: true });
    assert.equal(await remember.isChecked(), false, 'Remembering is off unless the owner asks for it');
    assert.equal(await field(page).getAttribute('type'), 'password');
    assert.equal(await field(page).getAttribute('inputmode'), 'numeric');
    assert(await field(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 16));
    assert.equal(await unlockButton(page).isDisabled(), true, 'Nothing to send yet');
    await field(page).pressSequentially(PIN);
    assert.equal(test.texts.length, 0, 'Typing masked digits never sends remote text');
    assert.equal(test.keys.length, 0, 'Global keyboard capture does not forward local passcode keys');
    assert.equal(test.uhidCreated, false, 'Typing in the local unlock field never attaches a remote HID keyboard');
    assert.equal(test.hidReports.length, 0, 'Masked local typing never sends HID key reports');
    await unlockButton(page).click();
    assert.equal(await field(page).inputValue(), '', 'Clear the draft before preflight completes');
    await page.locator('.unlock-form').evaluate((form) => {
        form.requestSubmit();
        form.requestSubmit();
    });
    await state(page, 'waiting');
    assert.equal(await unlockButton(page).getAttribute('aria-busy'), 'true', 'Unlock is busy while it waits');
    await page.waitForFunction(() => document.querySelector('[data-unlock-state]')?.textContent.includes('Waiting for the phone to confirm'));
    assert.deepEqual(test.texts, [PIN], 'One explicit submission sends exactly one unchanged PIN, including leading zeros');
    assert.equal(test.queryCount, 2, 'Check lock state before preparation and again before credentials');
    assert.equal(
        test.keys.filter((key) => key.code === 66 && key.action === 0).length,
        1,
        'Only one Enter submission',
    );
    test.update({ 'device.locked': false, 'keyguard.showing': true });
    await page.waitForTimeout(100);
    assert.equal(await status(page).getAttribute('data-unlock-state'), 'waiting', 'Still showing keyguard is not confirmation');
    test.update(UNLOCKED);
    // Confirmed: the sheet closes by itself, with its last words.
    await closed(page);
    await state(page, 'confirmed');
    assert.equal(await status(page).textContent(), 'Phone confirmed unlocked.');
    await notice(page).waitFor({ state: 'detached' });
    assert.deepEqual(await passcodeKeys(page), [], 'A confirmed unlock stores nothing unless asked');
    test.update(LOCKED);
    await open(page);
    await state(page, 'idle');
    assert(!(await status(page).textContent()).includes('confirmed unlocked'), 'Relocking clears stale success');
    await field(page).fill(PIN);
    await closeButton(page).click();
    await closed(page);
    await open(page);
    assert.equal(await field(page).inputValue(), '', 'Reopening does not bring back a passcode that was not remembered');
    await page.getByRole('radio', { name: 'Password', exact: true }).check();
    assert.equal(await field(page).getAttribute('type'), 'password');
    assert.equal(await field(page).getAttribute('inputmode'), 'text');
    await field(page).fill('invalidé');
    await unlockButton(page).click();
    await state(page, 'failed');
    assert.equal(await field(page).inputValue(), '');
    assert.equal(test.texts.length, 1, 'Unsupported password characters are rejected before transport');
    assert((await status(page).textContent()).includes('Other characters must be entered on the phone'));
    assert.equal(await status(page).locator('.kit-status-error').count(), 1, 'A failure is in the error tone');
    if (!mobile) {
        // Typing again needs no click: the field takes focus back after a failure.
        await page.waitForFunction(() => document.activeElement?.classList.contains('unlock-field'));
    }
    await field(page).fill(PASSWORD);
    // Enter in the field sends it: the Unlock button is in the sheet's footer, outside the
    // form, and belongs to it through its form attribute.
    await field(page).press('Enter');
    await sent(page);
    assert.deepEqual(test.texts, [PIN, PASSWORD], 'Password mode preserves ASCII letters, symbols and spaces');
    assert(
        await page.locator('dialog.kit-sheet[open] .kit-sheet-body').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        'No horizontal form overflow',
    );
    await noLeaks(test);
    assert.deepEqual(await passcodeKeys(page), [], 'Sending stores nothing');
    await page.reload();
    await open(page);
    assert.equal(await field(page).inputValue(), '', 'Nothing to restore after a reload');

    // Remember in this browser: written only once the phone confirms the unlock.
    await page.getByRole('radio', { name: 'Password', exact: true }).check();
    await remember.check();
    await field(page).fill(PASSWORD);
    await unlockButton(page).click();
    await sent(page);
    assert.deepEqual(await passcodeKeys(page), [], 'Not stored when it is sent');
    test.update(UNLOCKED);
    await closed(page);
    await state(page, 'confirmed');
    assert.deepEqual(await passcodeKeys(page), [REMEMBERED_KEY], 'Stored after the phone confirmed it');
    test.update(LOCKED);
    await page.reload();
    // With a passcode saved, the notice would send it; the sheet is reached from Actions.
    await openFromActions(test);
    assert.equal(await field(page).inputValue(), PASSWORD, 'A remembered passcode survives reload');
    assert.equal(await page.getByRole('radio', { name: 'Password', exact: true }).isChecked(), true);
    assert.equal(await remember.isChecked(), true);
    assert.deepEqual(test.texts, [PIN, PASSWORD, PASSWORD], 'Restoring a passcode never submits it');
    await noLeaks(test);
    await remember.uncheck();
    assert.equal(await field(page).inputValue(), '');
    assert.deepEqual(await passcodeKeys(page), [], 'Clearing the box forgets it at once');
    await page.reload();
    await open(page);
    assert.equal(await field(page).inputValue(), '', 'Forgetting survives reload');
    assert.equal(await remember.isChecked(), false);
    await page.screenshot({ path: path.join(OUT, `unlock-${mobile ? 'phone' : 'desktop'}.png`) });
    await test.context.close();
    console.log(
        'PASS',
        label,
        'masked input, focus by pointer, no typing leaks, single submission, confirmation closes the sheet, relock, close cleanup, password validation and opt-in remembering',
    );
}

/** U-settings-6 on Android: a passcode remembered in this browser is sent from the notice in one tap. */
async function androidOneTap(browser) {
    for (const mobile of [true, false]) {
        const label = `Android one tap ${mobile ? 'phone' : 'desktop'}`;
        const saved = { [REMEMBERED_KEY]: JSON.stringify({ value: PIN, mode: 'pin' }) };
        const test = await start(browser, { mobile, storage: saved });
        const { page } = test;
        await noticeUnlock(page).click();
        await page.waitForFunction(() => document.querySelector('.lock-screen-notice .kit-banner-text')?.textContent === 'Unlocking…');
        assert.equal(await noticeUnlock(page).getAttribute('aria-busy'), 'true', `${label}: the notice's Unlock is busy`);
        await until(page, () => test.texts.length >= 1);
        assert.deepEqual(test.texts, [PIN], `${label}: the saved PIN is sent once`);
        // A second press while it runs does nothing.
        await noticeUnlock(page).click({ force: true });
        await page.waitForTimeout(300);
        assert.equal(await page.locator('dialog.kit-sheet[open]').count(), 0, `${label}: no sheet opens`);
        assert.deepEqual(test.texts, [PIN]);
        test.update(UNLOCKED);
        await notice(page).waitFor({ state: 'detached' });
        assert.equal(await page.locator('dialog.kit-sheet[open]').count(), 0, `${label}: no sheet after the unlock either`);
        assert.deepEqual(await passcodeKeys(page), [REMEMBERED_KEY], `${label}: the saved copy stays`);
        assert.equal(test.queryCount, 2);
        await noLeaks(test);
        await test.context.close();
    }

    // A remembered passcode that no longer unlocks the phone: one send, then the sheet with the
    // error, and the copy is dropped, not offered again.
    for (const mobile of [true, false]) {
        const timedOut = await start(browser, {
            mobile,
            storage: { [REMEMBERED_KEY]: JSON.stringify({ value: PIN, mode: 'pin' }) },
        });
        const { page } = timedOut;
        await page.clock.install();
        await noticeUnlock(page).click();
        await page.clock.runFor(1200);
        await until(page, () => timedOut.texts.length >= 1);
        assert.equal(await page.locator('dialog.kit-sheet[open]').count(), 0, 'Sent, so no sheet yet');
        await page.clock.fastForward(26000);
        await dialog(page).waitFor();
        await state(page, 'failed');
        assert.equal(timedOut.texts.length, 1, 'Timeout cannot automatically retry a passcode');
        const words = await status(page).textContent();
        assert(!words.toLowerCase().includes('incorrect'), 'A timeout cannot establish an incorrect passcode');
        assert(words.startsWith('Unlock was not confirmed.'), words);
        assert(words.includes('saved in this browser was removed'));
        assert.equal(await status(page).locator('.kit-status-error').count(), 1);
        assert.deepEqual(await passcodeKeys(page), [], 'An unconfirmed passcode does not stay saved');
        assert.equal(await field(page).inputValue(), '', 'and is not left in the field for another tap');
        assert.equal(await page.getByRole('checkbox', { name: 'Remember in this browser', exact: true }).isChecked(), false);
        await page.screenshot({ path: path.join(OUT, `one-tap-failed-${mobile ? 'phone' : 'desktop'}.png`) });
        await noLeaks(timedOut);
        await timedOut.context.close();
    }
    console.log('PASS Android one tap: Unlocking… on the notice, one send, no sheet on success; the sheet with the error after an unconfirmed send');
}

// The iPhone page against fixture sockets: every tracker command is captured, nothing reaches a phone.
const IPHONE = 'fixture-iphone-unlock';
const STORED = { enabled: false, time: '03:00', hasPasscode: true, serverTimeZone: 'UTC' };

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

async function startIphone(browser, { mobile = true, colorScheme = 'light', schedule = STORED } = {}) {
    const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme,
    });
    const page = await context.newPage();
    const errors = [];
    const commands = [];
    const handlers = { onCommand: undefined };
    let trackerReply;
    let current = { 'device.locked': true, unlockSchedule: schedule };
    const iphone = () => ({
        udid: IPHONE, name: 'iPhone fixture', state: 'Connected', model: 'iPhone 13 Pro Max', version: '27.2',
        paired: true, developerMode: true, session: 'ready', 'screen.power': 'on', ...current,
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        if (new URL(socket.url()).searchParams.get('action') === 'proxy-coredevice') {
            socket.onMessage(() => undefined);
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
                if (code === 'ATRC') {
                    trackerReply = reply;
                    reply({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [iphone()] } });
                }
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
    url.hash = `!${new URLSearchParams({ action: 'stream-coredevice', udid: IPHONE })}`;
    await page.goto(url.toString());
    await page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.includes('Connected'));
    await notice(page).waitFor();
    const runs = () => commands.filter((command) => command.type === 'run_unlock_now');
    return {
        context, page, mobile, errors, commands, handlers, runs,
        update(patch) {
            current = { ...current, ...patch };
            trackerReply({ id: -1, type: 'device', data: { id: 'ios', name: 'Devices', device: iphone() } });
        },
    };
}
const run = (outcome, message) => ({ result: JSON.stringify({ at: Date.now(), trigger: 'manual', outcome, message }) });
/** Holds the server's answer to the next run until the flow gives it, once the run has arrived. */
function holdRun(test) {
    let release;
    const arrived = new Promise((resolve) => {
        test.handlers.onCommand = (command) => {
            if (command.type !== 'run_unlock_now') return undefined;
            return new Promise((answer) => {
                release = answer;
                resolve();
            });
        };
    });
    return async (answer) => {
        await arrived;
        release(answer);
    };
}
async function until(page, check) {
    for (let i = 0; i < 200 && !check(); i++) await page.waitForTimeout(25);
    assert(check(), 'waited for the fixture');
}

async function iphoneFlow(browser, mobile) {
    const label = `iPhone ${mobile ? 'phone' : 'desktop'}`;

    // No passcode on the server: the notice opens the sheet, which says why and leads to Settings.
    const none = await startIphone(browser, { mobile, schedule: { ...STORED, hasPasscode: false } });
    try {
        const { page } = none;
        await open(page);
        await sameSheet(page, `${label} without a passcode`);
        assert.equal(await dialog(page).locator('input').count(), 0, 'no passcode field: nothing to mistype, prefill or resend');
        assert.equal(await dialog(page).getByRole('radio').count(), 0, 'no PIN or Password choice');
        await dialog(page).getByText('The server types the stored passcode. Nothing is saved in this browser.', { exact: true }).waitFor();
        const banner = dialog(page).locator('.kit-banner', { hasText: 'No passcode is stored on the server for this phone.' });
        await banner.getByRole('button', { name: 'Open Settings', exact: true }).waitFor();
        assert.equal(await unlockButton(page).isDisabled(), true, 'Unlock waits for a stored passcode');
        assert.equal(await status(page).getAttribute('data-unlock-state'), 'idle');
        assert.deepEqual(none.runs(), []);
        await page.screenshot({ path: path.join(OUT, `iphone-no-passcode-${mobile ? 'phone' : 'desktop'}.png`) });
        assert.deepEqual(none.errors, []);
    } finally {
        await none.context.close();
    }

    const test = await startIphone(browser, { mobile });
    const { page } = test;
    try {
        // A stored passcode: the notice's Unlock is the unlock. One request, and no sheet.
        let release = holdRun(test);
        await noticeUnlock(page).click();
        await page.waitForFunction(() => document.querySelector('.lock-screen-notice .kit-banner-text')?.textContent === 'Unlocking…');
        assert.equal(await noticeUnlock(page).getAttribute('aria-busy'), 'true');
        await until(page, () => test.runs().length === 1);
        assert.deepEqual(test.runs().map((command) => command.data), [{ udid: IPHONE, keepUnlocked: true }]);
        await noticeUnlock(page).click({ force: true });
        await page.waitForTimeout(200);
        assert.equal(test.runs().length, 1, 'a second press while it runs sends nothing');
        assert.equal(await page.locator('dialog.kit-sheet[open]').count(), 0);
        await release(run('unlocked'));
        await page.waitForTimeout(200);
        assert.equal(await page.locator('dialog.kit-sheet[open]').count(), 0, 'the server said unlocked: no sheet');
        test.update({ 'device.locked': false });
        await notice(page).waitFor({ state: 'detached' });
        assert.equal(test.runs().length, 1);

        // Still locked after the digits: the sheet opens with the sentence, and nothing is sent again.
        test.update({ 'device.locked': true });
        release = holdRun(test);
        await noticeUnlock(page).click();
        await release(run('failed-rejected', 'Scheduled unlock is paused until the passcode is saved again'));
        await dialog(page).waitFor();
        await settleMotion(page);
        await sameSheet(page, `${label} after a failure`);
        await state(page, 'failed');
        assert.equal(await status(page).textContent(), 'Failed: the stored passcode was rejected. Scheduled unlock is paused until the passcode is saved again.');
        assert.equal(await status(page).locator('.kit-status-error').count(), 1, 'the error tone, as on Android');
        await page.waitForTimeout(300);
        assert.equal(test.runs().length, 2, 'a failure is never retried by the page');
        await page.screenshot({ path: path.join(OUT, `iphone-failed-${mobile ? 'phone' : 'desktop'}.png`) });

        // From the sheet: Unlock waits for the phone to confirm, then the sheet closes.
        release = holdRun(test);
        await unlockButton(page).click();
        await state(page, 'waiting');
        assert.equal(await unlockButton(page).getAttribute('aria-busy'), 'true');
        assert.equal(await status(page).textContent(), 'Unlocking with the passcode stored on the server…');
        await release(run('unlocked'));
        await page.waitForFunction(() => document.querySelector('[data-unlock-state]')?.textContent.includes('Waiting for the phone to confirm'));
        assert.equal(await status(page).getAttribute('data-unlock-state'), 'waiting', 'the server said so; the phone has not yet');
        test.update({ 'device.locked': false });
        await closed(page);
        await state(page, 'confirmed');
        assert.equal(await status(page).textContent(), 'Phone confirmed unlocked.');
        assert.equal(test.runs().length, 3);

        // A run the server refuses says when it can run.
        test.update({ 'device.locked': true });
        test.handlers.onCommand = (command) =>
            command.type === 'run_unlock_now' ? { error: 'A screen session was opened for this phone a moment ago. Try again in 90 s.' } : undefined;
        await noticeUnlock(page).click();
        await dialog(page).waitFor();
        await state(page, 'failed');
        assert.match(await status(page).textContent(), /Try again in 90 s\.$/);
        assert.equal(test.runs().length, 4);
        await closeButton(page).click();
        await closed(page);

        // The phone stopped accepting connections: the sheet says so instead of trying.
        test.update({ unlockSchedule: { ...STORED, needsManualUnlock: true } });
        await open(page);
        await dialog(page).getByText('The iPhone stopped accepting connections. Enter the passcode on the phone.', { exact: true }).waitFor();
        assert.equal(test.runs().length, 4, 'opening the sheet sends nothing');
        await closeButton(page).click();
        await closed(page);

        // A rejected passcode: the sheet leads to Settings.
        test.update({ unlockSchedule: { ...STORED, passcodeRejected: true } });
        await open(page);
        await dialog(page).getByText('The stored passcode was rejected by the phone. Save it again in Settings before it is used again.', { exact: true }).waitFor();
        assert.equal(await unlockButton(page).isDisabled(), true);
        await dialog(page).getByRole('button', { name: 'Open Settings', exact: true }).click();
        await dialog(page).waitFor({ state: 'hidden' });
        // The Settings sheet of this iPhone takes its place.
        const settings = page.locator('dialog.kit-sheet[open]:not([data-exiting])');
        await settings.waitFor();
        assert.notEqual(await settings.locator('.kit-sheet-title').textContent(), TITLE);
        assert.equal(await page.locator('dialog.kit-sheet[open]').count(), 1, 'one sheet at a time');
        assert.equal(test.runs().length, 4);
        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'one tap with a stored passcode, the sheet only after a failure, confirmation closes it, one request per press');
    } finally {
        await test.context.close();
    }
}

/** Both sheets at phone width and on a desktop, in both themes: the same parts, nothing cut off. */
async function looks(browser) {
    for (const [mobile, viewport] of [[true, { width: 390, height: 844 }], [false, { width: 1280, height: 800 }]]) {
        for (const colorScheme of ['light', 'dark']) {
            const name = `${mobile ? 'phone' : 'desktop'}-${colorScheme}`;
            const android = await start(browser, { mobile, viewport, colorScheme });
            await open(android.page);
            await android.page.getByRole('radio', { name: 'Password', exact: true }).check();
            await field(android.page).fill('invalidé');
            await unlockButton(android.page).click();
            await state(android.page, 'failed');
            for (const page of [android.page]) {
                const fits = await page.locator('dialog.kit-sheet[open] .kit-sheet-panel').evaluate((el) => {
                    const box = el.getBoundingClientRect();
                    return box.left >= 0 && box.right <= innerWidth && el.scrollWidth <= el.clientWidth + 1;
                });
                assert(fits, `${name}: the Android sheet fits`);
            }
            await android.page.screenshot({ path: path.join(OUT, `android-${name}.png`) });
            await android.context.close();

            const iphone = await startIphone(browser, { mobile, colorScheme });
            iphone.handlers.onCommand = (command) =>
                command.type === 'run_unlock_now' ? run('failed-rejected', 'Scheduled unlock is paused until the passcode is saved again') : undefined;
            await noticeUnlock(iphone.page).click();
            await dialog(iphone.page).waitFor();
            await state(iphone.page, 'failed');
            await settleMotion(iphone.page);
            const fits = await iphone.page.locator('dialog.kit-sheet[open] .kit-sheet-panel').evaluate((el) => {
                const box = el.getBoundingClientRect();
                return box.left >= 0 && box.right <= innerWidth && el.scrollWidth <= el.clientWidth + 1;
            });
            assert(fits, `${name}: the iPhone sheet fits`);
            assert.equal(await iphone.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            await iphone.page.screenshot({ path: path.join(OUT, `iphone-${name}.png`) });
            assert.deepEqual(iphone.errors, []);
            await iphone.context.close();
        }
    }
    console.log('PASS both sheets fit at 390x844 and 1280x800, light and dark');
}

/** The lock screen that asks for no passcode: swiped on the picture, never unlocked from the notice. */
async function swipeNotice(browser) {
    const test = await start(browser, { flags: { ...LOCKED, 'device.locked': false } });
    const { page } = test;
    await page.waitForFunction(() => document.querySelector('.lock-screen-notice .kit-banner-text')?.textContent === 'Swipe up to unlock');
    assert.equal(await noticeUnlock(page).count(), 0, 'no Unlock: there is no passcode to send');
    await notice(page).getByRole('button', { name: 'Dismiss lock notice', exact: true }).waitFor();
    // Another screen over the lock screen (a call, the camera): nothing to swipe.
    test.update({ 'keyguard.occluded': true });
    await notice(page).waitFor({ state: 'detached' });
    test.update({ 'keyguard.occluded': false });
    await notice(page).waitFor();
    assert.deepEqual(test.queryCount, 0);
    assert.deepEqual(test.errors, []);
    await test.context.close();
    console.log('PASS swipe notice has no Unlock and hides behind another screen');
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [true, false]) await androidFlow(browser, mobile);

        const keyboard = await start(browser);
        await open(keyboard.page);
        await field(keyboard.page).fill(PIN);
        assert.equal(await field(keyboard.page).getAttribute('enterkeyhint'), 'go');
        for (const height of [350, 320, 250]) {
            await keyboard.page.evaluate((height) => {
                Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => height });
                visualViewport.dispatchEvent(new Event('resize'));
            }, height);
            await keyboard.page.waitForTimeout(100);
            const geometry = await keyboard.page.evaluate(() => {
                const body = document.querySelector('dialog.kit-sheet[open] .kit-sheet-body');
                const input = document.querySelector('.unlock-field');
                const actions = document.querySelector('dialog.kit-sheet[open] .kit-sheet-footer');
                const send = actions.querySelector('.kit-button-primary');
                const target = send.getBoundingClientRect();
                return {
                    body: body.getBoundingClientRect().toJSON(),
                    input: input.getBoundingClientRect().toJSON(),
                    actions: actions.getBoundingClientRect().toJSON(),
                    send: target.toJSON(),
                    hit: send.contains(
                        document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2),
                    ),
                    width: body.clientWidth,
                    scrollWidth: body.scrollWidth,
                };
            });
            assert(
                geometry.send.bottom <= height && geometry.send.height >= 44 && geometry.hit,
                'Unlock remains visible and tappable above the keyboard',
            );
            assert(
                geometry.input.top >= geometry.body.top - 1 && geometry.input.bottom <= geometry.actions.top + 1,
                'The focused masked field stays fully visible above the sticky actions',
            );
            assert(geometry.scrollWidth <= geometry.width + 1, 'Keyboard viewport does not introduce horizontal scrolling');
        }
        const cdp = await keyboard.context.newCDPSession(keyboard.page);
        const body = keyboard.page.locator('dialog.kit-sheet[open] .kit-sheet-body');
        const before = await body.evaluate((el) => el.scrollTop);
        const actions = await keyboard.page.locator('dialog.kit-sheet[open] .kit-sheet-footer').boundingBox();
        const gestureY = actions.y - 8;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: 8, y: gestureY }] });
        for (let i = 1; i <= 10; i++) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{ id: 1, x: 8, y: gestureY - i * 4 }],
            });
            await keyboard.page.waitForTimeout(16);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await keyboard.page.waitForTimeout(100);
        assert(
            (await body.evaluate((el) => el.scrollTop)) > before,
            'The body still scrolls with native touch while the keyboard is open',
        );
        const send = await unlockButton(keyboard.page).boundingBox();
        assert(send.y + send.height <= 250);
        await keyboard.page.touchscreen.tap(send.x + send.width / 2, send.y + send.height / 2);
        await sent(keyboard.page);
        assert.deepEqual(keyboard.texts, [PIN], 'The visible keyboard-adjacent action submits exactly once');
        await keyboard.context.close();
        console.log('PASS bright/clickable asleep lock notice and keyboard viewports350/320/250 with native touch scrolling');

        for (const holdQuery of [1, 2]) {
            const test = await start(browser, { holdQuery });
            await open(test.page);
            await field(test.page).fill(PIN);
            await unlockButton(test.page).click();
            while (test.queryCount < holdQuery) await test.page.waitForTimeout(25);
            await closeButton(test.page).click();
            test.release();
            await test.page.waitForTimeout(1000);
            assert.deepEqual(test.texts, [], 'Closing cancels a pending preflight before any credential bytes');
            await open(test.page);
            assert.equal(await field(test.page).inputValue(), '', 'A canceled passcode is neither kept nor resent');
            assert.deepEqual(await passcodeKeys(test.page), []);
            await noLeaks(test);
            await test.context.close();
            console.log('PASS close cancels lock check', holdQuery);
        }

        const disconnected = await start(browser, { holdQuery: 1 });
        await open(disconnected.page);
        await field(disconnected.page).fill(PIN);
        await unlockButton(disconnected.page).click();
        while (!disconnected.queryCount) await disconnected.page.waitForTimeout(25);
        disconnected.disconnect();
        await state(disconnected.page, 'failed');
        // While the stream is down it says so; once it is back, that the passcode may have gone.
        assert.match(
            await status(disconnected.page).textContent(),
            /^(Waiting for the phone to reconnect\. No passcode will be queued\.|Connection lost\. The passcode may already have been sent\.)/,
        );
        disconnected.release();
        await disconnected.page.waitForTimeout(200);
        assert.equal(await field(disconnected.page).inputValue(), '');
        assert.deepEqual(disconnected.texts, [], 'Disconnect never queues passcode for a later connection');
        await noLeaks(disconnected);
        await disconnected.context.close();
        console.log('PASS disconnect cancels and clears passcode');

        const changedClient = await start(browser, { holdQuery: 1 });
        await open(changedClient.page);
        await field(changedClient.page).fill(PIN);
        await unlockButton(changedClient.page).click();
        while (!changedClient.queryCount) await changedClient.page.waitForTimeout(25);
        await changedClient.page.evaluate(() => {
            location.hash = location.hash.replace('player=mse', 'player=webcodecs');
        });
        await changedClient.page.locator('dialog.kit-sheet[open]').waitFor({ state: 'hidden' });
        changedClient.release();
        await changedClient.page.waitForTimeout(1000);
        assert.deepEqual(changedClient.texts, [], 'Replacing the stream client cancels an old pending passcode');
        await open(changedClient.page);
        assert.equal(await field(changedClient.page).inputValue(), '', 'A new client for the same phone starts with an empty field');
        await noLeaks(changedClient);
        await changedClient.context.close();
        console.log('PASS stream-client change cancels old submission and clears draft');

        const safeError = await start(browser);
        await open(safeError.page);
        safeError.update({ 'device.locked': 'unknown' });
        await field(safeError.page).fill(PIN);
        await unlockButton(safeError.page).click();
        await state(safeError.page, 'failed');
        assert(
            (await status(safeError.page).textContent()).includes('could not be confirmed'),
            'Known-safe preflight errors explain recovery',
        );
        assert.deepEqual(safeError.texts, [], 'Unknown lock state never receives a credential');
        await safeError.context.close();

        const unknown = await start(browser, {
            flags: { ...LOCKED, 'device.locked': 'unknown', 'keyguard.showing': 'unknown' },
        });
        assert.equal(await notice(unknown.page).count(), 0, 'Unknown lock state is neutral');
        await unknown.context.close();
        console.log('PASS unknown state');

        await androidOneTap(browser);
        await swipeNotice(browser);
        for (const mobile of [true, false]) await iphoneFlow(browser, mobile);
        await looks(browser);

        // Copies an earlier version saved on every send, confirmed or not, are removed on load.
        const legacy = await start(browser, {
            storage: {
                [`ws-scrcpy:passcode:${UDID}`]: JSON.stringify({ value: PIN, mode: 'pin' }),
                'ws-scrcpy:passcode:some-iphone': JSON.stringify({ value: '246810', mode: 'pin' }),
                'ws-scrcpy:unrelated': 'kept',
            },
        });
        assert.deepEqual(await passcodeKeys(legacy.page), [], 'Passcodes saved without asking are deleted');
        assert.equal(await legacy.page.evaluate(() => localStorage.getItem('ws-scrcpy:unrelated')), 'kept');
        // Nothing saved, so the notice opens the sheet.
        await open(legacy.page);
        assert.equal(await field(legacy.page).inputValue(), '', 'and nothing is prefilled from them');
        assert.equal(
            await legacy.page.getByRole('checkbox', { name: 'Remember in this browser', exact: true }).isChecked(),
            false,
        );
        assert.deepEqual(legacy.texts, []);
        await legacy.context.close();
        console.log('PASS passcodes saved by an earlier version are removed');
    } finally {
        await browser.close();
    }
}
module.exports = { start, open };
if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
