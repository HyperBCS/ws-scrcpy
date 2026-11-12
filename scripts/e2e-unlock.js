// BASE=http://127.0.0.1:8000 node scripts/e2e-unlock.js
// All sockets and credentials are fixtures. Never contacts, locks, or unlocks a real device.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, UDID } = require('./e2e-settings');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-unlock';
require('node:fs').mkdirSync(OUT, { recursive: true });
const PIN = '000719';
const PASSWORD = 'Fixture 7!';
const LOCKED = { 'keyguard.showing': true, 'keyguard.occluded': false, 'device.locked': true, 'screen.power': 'on' };

const REMEMBERED_KEY = `ws-scrcpy:remembered-passcode:${UDID}`;

async function start(browser, { mobile = true, flags = LOCKED, holdQuery = 0, storage = {} } = {}) {
    const context = await browser.newContext({
        viewport: mobile ? { width: 320, height: 568 } : { width: 1280, height: 600 },
        isMobile: mobile,
        hasTouch: mobile,
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
async function open(page) {
    await page.locator('.lock-screen-notice').getByRole('button', { name: 'Unlock', exact: true }).click();
    await require('./ui-motion').settleMotion(page);
    await page.getByRole('dialog', { name: 'Unlock device', exact: true }).waitFor();
}
async function state(page, value) {
    await page.locator(`[data-unlock-state="${value}"]`).waitFor();
}
const passcodeKeys = (page) =>
    page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('passcode')).sort());
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

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [true, false]) {
            const test = await start(browser, { mobile });
            const { page } = test;
            const notice = await page.locator('.lock-screen-notice').boundingBox();
            const stage = await page.locator('.stream-stage').boundingBox();
            assert(notice.y + notice.height <= stage.y + 1, 'Lock notice does not cover the controllable stream');
            const awakeNotice = await page.locator('.lock-screen-notice').screenshot({ animations: 'disabled' });
            test.update({ 'screen.power': 'off', 'device.awake': false });
            await page.getByText('Screen is asleep', { exact: true }).waitFor();
            const asleepNotice = await page.locator('.lock-screen-notice').screenshot({ animations: 'disabled' });
            assert(awakeNotice.equals(asleepNotice), 'The lock notice is equally bright while the device is asleep');
            await open(page);
            test.update({ 'screen.power': 'on', 'device.awake': true });
            assert.equal(await status(page).getAttribute('aria-live'), 'polite', 'The feedback is a live region before its first message');
            const remember = page.getByRole('checkbox', { name: 'Remember in this browser', exact: true });
            assert.equal(await remember.isChecked(), false, 'Remembering is off unless the owner asks for it');
            assert.equal(await field(page).getAttribute('type'), 'password');
            assert.equal(await field(page).getAttribute('inputmode'), 'numeric');
            assert(await field(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 16));
            await field(page).pressSequentially(PIN);
            assert.equal(test.texts.length, 0, 'Typing masked digits never sends remote text');
            assert.equal(test.keys.length, 0, 'Global keyboard capture does not forward local passcode keys');
            assert.equal(test.uhidCreated, false, 'Typing in the local unlock field never attaches a remote HID keyboard');
            assert.equal(test.hidReports.length, 0, 'Masked local typing never sends HID key reports');
            await page.getByRole('button', { name: 'Send PIN', exact: true }).click();
            assert.equal(await field(page).inputValue(), '', 'Clear the draft before preflight completes');
            await page.locator('.unlock-form').evaluate((form) => {
                form.requestSubmit();
                form.requestSubmit();
            });
            await state(page, 'waiting');
            assert.deepEqual(
                test.texts,
                [PIN],
                'One explicit submission sends exactly one unchanged PIN, including leading zeros',
            );
            assert.equal(test.queryCount, 2, 'Check lock state before preparation and again before credentials');
            assert.equal(
                test.keys.filter((key) => key.code === 66 && key.action === 0).length,
                1,
                'Only one Enter submission',
            );
            test.update({ 'device.locked': false, 'keyguard.showing': true });
            await page.waitForTimeout(100);
            assert.equal(
                await status(page).getAttribute('data-unlock-state'),
                'waiting',
                'Still showing keyguard is not confirmation',
            );
            test.update({ 'device.locked': false, 'keyguard.showing': false });
            await state(page, 'confirmed');
            assert((await status(page).textContent()).includes('Phone confirmed unlocked'));
            assert.deepEqual(await passcodeKeys(page), [], 'A confirmed unlock stores nothing unless asked');
            test.update(LOCKED);
            await state(page, 'idle');
            assert(
                !(await status(page).textContent()).includes('confirmed unlocked'),
                'Relocking clears stale success',
            );
            await field(page).fill(PIN);
            await page.getByRole('button', { name: 'Close Unlock device' }).click();
            await open(page);
            assert.equal(await field(page).inputValue(), '', 'Reopening does not bring back a passcode that was not remembered');
            await page.getByRole('radio', { name: 'Password', exact: true }).check();
            assert.equal(await field(page).getAttribute('type'), 'password');
            assert.equal(await field(page).getAttribute('inputmode'), 'text');
            await field(page).fill('invalidé');
            await page.getByRole('button', { name: 'Send password', exact: true }).click();
            await state(page, 'error');
            assert.equal(await field(page).inputValue(), '');
            assert.equal(test.texts.length, 1, 'Unsupported password characters are rejected before transport');
            assert((await status(page).textContent()).includes('Other characters must be entered on the phone'));
            await field(page).fill(PASSWORD);
            // Enter in the field sends it: the Send button is in the sheet's footer, outside the
            // form, and belongs to it through its form attribute.
            await field(page).press('Enter');
            await state(page, 'waiting');
            assert.deepEqual(test.texts, [PIN, PASSWORD], 'Password mode preserves ASCII letters, symbols and spaces');
            assert(
                await page
                    .locator('dialog.kit-sheet[open] .kit-sheet-body')
                    .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
                'No horizontal form overflow',
            );
            await noLeaks(test);
            assert.deepEqual(await passcodeKeys(page), [], 'Sending stores nothing');
            await page.reload();
            await open(page);
            assert.equal(await field(page).inputValue(), '', 'Nothing to restore after a reload');

            // Remember in this browser: written only once the device confirms the unlock.
            await page.getByRole('radio', { name: 'Password', exact: true }).check();
            await remember.check();
            await field(page).fill(PASSWORD);
            await page.getByRole('button', { name: 'Send password', exact: true }).click();
            await state(page, 'waiting');
            assert.deepEqual(await passcodeKeys(page), [], 'Not stored when it is sent');
            test.update({ 'device.locked': false, 'keyguard.showing': false });
            await state(page, 'confirmed');
            assert.deepEqual(await passcodeKeys(page), [REMEMBERED_KEY], 'Stored after the device confirmed it');
            test.update(LOCKED);
            await page.reload();
            await open(page);
            assert.equal(await field(page).inputValue(), PASSWORD, 'A remembered passcode survives reload');
            assert.equal(await page.getByRole('radio', { name: 'Password', exact: true }).isChecked(), true);
            assert.equal(await remember.isChecked(), true);
            assert.deepEqual(test.texts, [PIN, PASSWORD, PASSWORD], 'Restoring a passcode never submits it');
            await noLeaks(test);
            await remember.uncheck();
            assert.equal(await field(page).inputValue(), '');
            assert.deepEqual(await passcodeKeys(page), [], 'Clearing the box forgets it at once');
            await page.reload(); await open(page);
            assert.equal(await field(page).inputValue(), '', 'Forgetting survives reload');
            assert.equal(await remember.isChecked(), false);
            await page.screenshot({ path: require('node:path').join(OUT, `unlock-${mobile ? 'phone' : 'desktop'}.png`) });
            await test.context.close();
            console.log(
                'PASS',
                mobile ? 'phone' : 'desktop',
                'masked input, no typing leaks, single submission, actual confirmation, relock, close cleanup, password validation and opt-in remembering',
            );
        }

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
                'Send PIN remains visible and tappable above the keyboard',
            );
            assert(
                geometry.input.top >= geometry.body.top - 1 && geometry.input.bottom <= geometry.actions.top + 1,
                'The focused masked field stays fully visible above the sticky actions',
            );
            assert(
                geometry.scrollWidth <= geometry.width + 1,
                'Keyboard viewport does not introduce horizontal scrolling',
            );
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
        const send = await keyboard.page.getByRole('button', { name: 'Send PIN', exact: true }).boundingBox();
        assert(send.y + send.height <= 250);
        await keyboard.page.touchscreen.tap(send.x + send.width / 2, send.y + send.height / 2);
        await state(keyboard.page, 'waiting');
        assert.deepEqual(keyboard.texts, [PIN], 'The visible keyboard-adjacent action submits exactly once');
        await keyboard.context.close();
        console.log(
            'PASS bright/clickable asleep lock notice and keyboard viewports350/320/250 with native touch scrolling',
        );

        for (const holdQuery of [1, 2]) {
            const test = await start(browser, { holdQuery });
            await open(test.page);
            await field(test.page).fill(PIN);
            await test.page.getByRole('button', { name: 'Send PIN', exact: true }).click();
            while (test.queryCount < holdQuery) await test.page.waitForTimeout(25);
            await test.page.getByRole('button', { name: 'Close Unlock device' }).click();
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
        await disconnected.page.getByRole('button', { name: 'Send PIN', exact: true }).click();
        while (!disconnected.queryCount) await disconnected.page.waitForTimeout(25);
        disconnected.disconnect();
        await state(disconnected.page, 'disconnected');
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
        await changedClient.page.getByRole('button', { name: 'Send PIN', exact: true }).click();
        while (!changedClient.queryCount) await changedClient.page.waitForTimeout(25);
        await changedClient.page.evaluate(() => {
            location.hash = location.hash.replace('player=mse', 'player=webcodecs');
        });
        await changedClient.page.locator('dialog.kit-sheet[open]').waitFor({ state: 'hidden' });
        changedClient.release();
        await changedClient.page.waitForTimeout(1000);
        assert.deepEqual(changedClient.texts, [], 'Replacing the stream client cancels an old pending passcode');
        await open(changedClient.page);
        assert.equal(
            await field(changedClient.page).inputValue(),
            '',
            'A new client for the same device starts with an empty field',
        );
        await noLeaks(changedClient);
        await changedClient.context.close();
        console.log('PASS stream-client change cancels old submission and clears draft');

        const safeError = await start(browser);
        await open(safeError.page);
        safeError.update({ 'device.locked': 'unknown' });
        await field(safeError.page).fill(PIN);
        await safeError.page.getByRole('button', { name: 'Send PIN', exact: true }).click();
        await state(safeError.page, 'error');
        assert(
            (await status(safeError.page).textContent()).includes('could not be confirmed'),
            'Known-safe preflight errors explain recovery',
        );
        assert.deepEqual(safeError.texts, [], 'Unknown lock state never receives a credential');
        await safeError.context.close();

        const unknown = await start(browser, {
            flags: { ...LOCKED, 'device.locked': 'unknown', 'keyguard.showing': 'unknown' },
        });
        assert.equal(await unknown.page.locator('.lock-screen-notice').count(), 0, 'Unknown lock state is neutral');
        await unknown.context.close();

        // A remembered passcode that no longer unlocks the device is dropped, not offered again.
        const timedOut = await start(browser, {
            storage: { [REMEMBERED_KEY]: JSON.stringify({ value: PIN, mode: 'pin' }) },
        });
        await timedOut.page.clock.install();
        await open(timedOut.page);
        assert.equal(await field(timedOut.page).inputValue(), PIN, 'The remembered PIN is offered');
        await timedOut.page.getByRole('button', { name: 'Send PIN', exact: true }).click();
        await timedOut.page.clock.runFor(1200);
        await state(timedOut.page, 'waiting');
        await timedOut.page.clock.fastForward(26000);
        await state(timedOut.page, 'unconfirmed');
        assert.equal(timedOut.texts.length, 1, 'Timeout cannot automatically retry a passcode');
        assert(
            !(await status(timedOut.page).textContent()).toLowerCase().includes('incorrect'),
            'A timeout cannot establish an incorrect passcode',
        );
        assert((await status(timedOut.page).textContent()).includes('saved in this browser was removed'));
        assert.deepEqual(await passcodeKeys(timedOut.page), [], 'An unconfirmed passcode does not stay saved');
        assert.equal(await field(timedOut.page).inputValue(), '', 'and is not left in the field for another tap');
        await timedOut.context.close();
        console.log('PASS unknown state and unconfirmed timeout with no automatic retry or saved copy');

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
        await open(legacy.page);
        assert.equal(await field(legacy.page).inputValue(), '', 'and nothing is prefilled from them');
        assert.equal(
            await legacy.page.getByRole('checkbox', { name: 'Remember in this browser', exact: true }).isChecked(),
            false,
        );
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
