const { settleMotion } = require('./ui-motion');
// BASE=http://127.0.0.1:8000 node scripts/e2e-ios-typing.js
// The iOS "Type text" sheet against fixture sockets: every HID report is captured in the
// browser, nothing reaches a phone. Covers the phone layout, live typing order, editing keys,
// smart punctuation, paste, IME commits, focus retention, presses on the picture while typing
// and dismissal. The viewport case
// simulates keyboard shrink/pan; physical iOS/PWA keyboard behavior needs a device check.
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const browserName = process.env.BROWSER || 'chromium';
const SCREENSHOTS = process.env.SCREENSHOTS || '/tmp';
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const UDID = 'fixture-iphone-typing';
const SHIFT = 0xe1;

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

async function start(browser, { mobile = true, mockViewport = false, udid = UDID, locked = false, picture = false } = {}) {
    const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 700 },
        isMobile: mobile,
        hasTouch: mobile,
    });
    // A picture of the phone, so that a press on it is a touch on the phone: the fixture socket
    // announces a codec and sends key frames, and this decoder turns each into a 428x926 frame.
    if (picture) await context.addInitScript(() => {
        window.VideoDecoder = class {
            static async isConfigSupported() { return { supported: true }; }
            constructor({ output }) { this.output = output; this.state = 'unconfigured'; }
            configure() { this.state = 'configured'; }
            decode(chunk) {
                const canvas = new window.OffscreenCanvas(428, 926);
                canvas.getContext('2d').fillRect(0, 0, 428, 926);
                this.output(new window.VideoFrame(canvas, { timestamp: chunk.timestamp }));
            }
            close() { this.state = 'closed'; }
        };
    });
    if (mockViewport) await context.addInitScript(() => {
        const state = { height: null, width: null, offsetTop: 0, offsetLeft: 0 };
        const viewport = new EventTarget();
        for (const property of ['height', 'width', 'offsetTop', 'offsetLeft']) Object.defineProperty(viewport, property, {
            get: () => state[property] ?? (property === 'height' ? innerHeight : innerWidth),
        });
        Object.defineProperties(viewport, { scale: { value: 1 }, pageTop: { get: () => state.offsetTop + scrollY }, pageLeft: { get: () => state.offsetLeft + scrollX } });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
        Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
        window.__setTypingViewport = next => {
            Object.assign(state, next);
            viewport.dispatchEvent(new Event('resize'));
            viewport.dispatchEvent(new Event('scroll'));
        };
    });
    const page = await context.newPage();
    const errors = [];
    const sent = [];
    // Screen sessions the page opened: one per visit.
    let sessions = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/notifications/**', route => route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        const target = new URL(socket.url());
        if (target.searchParams.get('action') === 'proxy-coredevice') {
            sessions++;
            socket.onMessage((data) => {
                if (typeof data === 'string') sent.push(JSON.parse(data));
            });
            setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 50);
            if (picture) {
                let open = true;
                socket.onClose(() => { open = false; });
                setTimeout(() => socket.send(JSON.stringify({ type: 'codec', codec: 'hev1.1.6.L150.B0', description: Buffer.from([1]).toString('base64') })), 80);
                // A key frame now and then: the first may come before the decoder is ready.
                const frame = () => {
                    if (!open || page.isClosed()) return;
                    socket.send(Buffer.from([0, 0, 0, 0, 1, 0x26]));
                    setTimeout(frame, 250).unref();
                };
                setTimeout(frame, 150);
            }
            return;
        }
        socket.onMessage((data) => {
            const frame = Buffer.from(data);
            if (frame.length < 5 || frame[0] !== 4) return;
            if (frame.subarray(5).toString() === 'HSTS') {
                socket.send(channelJson(frame.readUInt32LE(1), { id: -1, type: 'hosts', data: { local: [{ type: 'ios' }] } }));
            } else if (frame.subarray(5).toString() === 'ATRC') {
                socket.send(channelJson(frame.readUInt32LE(1), { id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [{ udid, name: 'iPhone fixture', state: 'Connected', model: 'iPhone', version: '27', paired: true, developerMode: true, session: 'ready', 'screen.power': 'on', 'device.locked': locked }] } }));
            }
        });
    });
    const url = new URL(BASE);
    url.hash = `!${new URLSearchParams({ action: 'stream-coredevice', udid })}`;
    await page.goto(url.toString());
    await page.waitForFunction(() =>
        document.querySelector('.kit-bar-status')?.textContent.includes('Connected'),
    );
    const keys = () => sent.filter((message) => message.type === 'key').map((message) => message.usages);
    const waitForKeys = async (count) => {
        for (let i = 0; i < 100 && keys().length < count; i++) await page.waitForTimeout(20);
        return keys();
    };
    return { context, page, errors, sent, keys, waitForKeys, streams: () => sessions };
}

// Type text is a kit sheet: the open dialog that holds the typing field.
const typingSheet = (page) => page.locator('dialog.kit-sheet[open]').filter({ has: page.locator('.live-text') });
const closeTyping = (page) => page.getByRole('button', { name: 'Close Type text', exact: true });
const press = (usage) => [[usage], []];
const shifted = (usage) => [[SHIFT], [SHIFT, usage], [SHIFT], []];

async function openOverlay(page, mobile) {
    if (mobile) {
        const fab = page.locator('.floating-toolbar-fab');
        const box = await fab.boundingBox();
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await settleMotion(page);
        const button = page.locator('.control-buttons-list [title="Type text"]');
        const target = await button.boundingBox();
        await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2);
    } else {
        await page.locator('.control-buttons-list [title="Type text"]').click();
    }
    await typingSheet(page).waitFor();
    await settleMotion(page);
}

async function mobileFlow(browser) {
    const test = await start(browser, { mobile: true });
    const { page } = test;
    await openOverlay(page, true);
    assert.equal(
        await page.evaluate(() => document.activeElement?.className),
        'kit-field live-text-input',
        'the field is focused so the phone keyboard opens',
    );
    // One sheet, on the kit's dialog, with one header. It is not modal and has no backdrop, so
    // the picture stays in use. Nothing of the older bar is left.
    assert.deepEqual(
        await typingSheet(page).evaluate((dialog) => ({
            modal: dialog.matches('dialog:modal'),
            backdrop: dialog.querySelectorAll('.kit-sheet-backdrop').length,
            headers: dialog.querySelectorAll('.kit-sheet-header').length,
            title: document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent,
            older: document.querySelectorAll('.live-text-overlay, .live-text-bar, .live-text-done').length,
        })),
        { modal: false, backdrop: 0, headers: 1, title: 'Type text', older: 0 },
    );
    assert.match(await page.locator('#live-text-hint').textContent(), /on the phone/);

    await settleMotion(page);
    const geometry = await page.evaluate(() => {
        const bar = document.querySelector('dialog.kit-sheet[open] .kit-sheet-panel');
        const rect = bar.getBoundingClientRect();
        const small = Array.from(bar.querySelectorAll('button, input'))
            .map((el) => ({ name: el.getAttribute('aria-label') || el.textContent.trim(), ...el.getBoundingClientRect().toJSON() }))
            .filter((box) => box.height < 44 || box.width < 44);
        return {
            insideViewport: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
            overflow: bar.scrollWidth > bar.clientWidth + 1,
            small,
            fontSize: getComputedStyle(bar.querySelector('input')).fontSize,
        };
    });
    assert(geometry.insideViewport, 'the overlay sits inside the phone viewport');
    assert(!geometry.overflow, 'no horizontal overflow at 390px');
    assert.deepEqual(geometry.small, [], 'every control is at least 44px');
    assert.equal(geometry.fontSize, '16px', 'the field does not trigger Safari focus zoom');

    // Live typing: each committed character leaves as HID reports, in order.
    await page.keyboard.type('Hi');
    assert.deepEqual(await test.waitForKeys(6), [...shifted(0x0b), ...press(0x0c)]);
    await page.keyboard.press('Backspace');
    assert.deepEqual((await test.waitForKeys(8)).slice(6), press(0x2a), 'Backspace on the empty field reaches the phone');
    assert.equal(await page.evaluate(() => document.querySelector('.live-text-input').value), '', 'the field stays empty');

    // iOS Smart Punctuation: the phone keyboard commits ’ for an apostrophe.
    await page.keyboard.insertText('it’s');
    assert.deepEqual((await test.waitForKeys(16)).slice(8), [...press(0x0c), ...press(0x17), ...press(0x34), ...press(0x16)]);
    await page.waitForFunction(() => document.querySelector('.live-text-feedback').textContent === 'Text sent');

    // A character with no US key is reported, not silently dropped.
    await page.keyboard.insertText('é');
    await page.waitForFunction(() => /no key for these/.test(document.querySelector('.live-text-feedback').textContent));
    assert.match(await page.locator('.live-text-feedback').textContent(), /é/);
    assert.equal(test.keys().length, 16, 'nothing is typed for it');

    // The key buttons keep the field focused (a focus change would close the phone keyboard).
    const enter = await page.locator('button[aria-label="Send Enter"]').boundingBox();
    await page.touchscreen.tap(enter.x + enter.width / 2, enter.y + enter.height / 2);
    assert.deepEqual((await test.waitForKeys(18)).slice(16), press(0x28));
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'kit-field live-text-input');
    const right = await page.locator('button[aria-label="Move cursor right"]').boundingBox();
    await page.touchscreen.tap(right.x + right.width / 2, right.y + right.height / 2);
    assert.deepEqual((await test.waitForKeys(20)).slice(18), press(0x4f));

    // Paste goes out as typed text.
    await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.setData('text/plain', 'ok');
        document.querySelector('.live-text-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    assert.deepEqual((await test.waitForKeys(24)).slice(20), [...press(0x12), ...press(0x0e)]);

    // IME pre-edit stays local; compositionend plus WebKit's follow-up input sends one commit.
    await page.evaluate(() => {
        const input = document.querySelector('.live-text-input');
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        input.value = 'pending';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'pending', isComposing: true }));
    });
    assert.equal(test.keys().length, 24, 'IME pre-edit must not reach the phone');
    const clearedOnCommit = await page.evaluate(() => {
        const input = document.querySelector('.live-text-input');
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ok' }));
        const cleared = input.value === '';
        input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromComposition', data: 'ok' }));
        input.value = 'ok';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromComposition', data: 'ok' }));
        return cleared;
    });
    assert(clearedOnCommit, 'the native compositionend handler clears the committed text');
    await test.waitForKeys(28);
    await page.locator('.live-text-feedback').filter({ hasText: 'Text sent' }).waitFor({ state: 'attached' });
    await settleLayout(page);
    assert.deepEqual(test.keys().slice(24), [...press(0x12), ...press(0x0e)], 'IME commits are not sent twice');
    assert.equal(await page.locator('.live-text-input').inputValue(), '');

    // Every report was a key or touch message in a single ordered stream; no touch leaked from the sheet.
    assert(!test.sent.some((message) => message.type === 'touch'), 'sheet taps never become remote touches');

    await page.keyboard.press('Escape');
    await typingSheet(page).waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('floating-toolbar-fab')), true, 'focus returns to the controls button');
    assert.deepEqual(test.errors, []);
    await test.context.close();
    console.log('mobile: ok');
}

async function desktopFlow(browser) {
    const test = await start(browser, { mobile: false });
    const { page } = test;
    await openOverlay(page, false);
    // A dialog from 600px, at the bottom of the window, with the picture fitted above it: the
    // field being typed into on the phone is not under the sheet.
    await page.waitForFunction(() => {
        const video = document.querySelector('.video')?.getBoundingClientRect();
        const panel = document.querySelector('dialog.kit-sheet[open] .kit-sheet-panel')?.getBoundingClientRect();
        return !!video && !!panel && video.height > 100 && video.bottom <= panel.top + 1;
    }, undefined, { timeout: 3000 }).catch(() => undefined);
    const desk = await page.evaluate(() => ({
        video: document.querySelector('.video').getBoundingClientRect().toJSON(),
        panel: document.querySelector('dialog.kit-sheet[open] .kit-sheet-panel').getBoundingClientRect().toJSON(),
        height: innerHeight,
    }));
    assert.ok(desk.video.height > 100 && desk.video.bottom <= desk.panel.top + 1, `desktop: the picture is fitted above the dialog (${JSON.stringify(desk)})`);
    assert.ok(desk.panel.bottom < desk.height && desk.panel.bottom > desk.height - 40, 'desktop: the dialog stands a little above the bottom edge');
    await page.keyboard.type('a1!');
    assert.deepEqual(await test.waitForKeys(8), [...press(0x04), ...press(0x1e), ...shifted(0x1e)]);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Enter');
    assert.deepEqual((await test.waitForKeys(14)).slice(8), [...press(0x50), ...press(0x4c), ...press(0x28)]);
    // The window-level capture must stay quiet while the overlay owns the keyboard: no report
    // for the physical H key beyond the typed text itself.
    assert.equal(test.keys().length, 14);
    await closeTyping(page).click();
    await typingSheet(page).waitFor({ state: 'hidden' });
    assert.deepEqual(test.errors, []);
    await test.context.close();
    console.log('desktop: ok');
}

// U-stream-5. Type text is not modal: a press on the picture is a touch on the iPhone, Type text
// stays open with its field focused and typing goes on, so the next field can be chosen without
// closing it. A press or a wheel in the sheet is not a touch, and nothing dims the picture.
async function pictureFlow(browser) {
    for (const mobile of [true, false]) {
        const test = await start(browser, { mobile, picture: true });
        const { page } = test;
        const label = mobile ? 'phone' : 'desktop';
        const touches = () => test.sent.filter((message) => message.type === 'touch' || message.type === 'touch-frame').length;
        const where = () => page.evaluate(() => ({ hash: location.hash, index: history.state?.nav?.index, overlay: history.state?.nav?.overlay || 0 }));
        const pressAt = async (x, y) => {
            if (mobile) await page.touchscreen.tap(x, y);
            else await page.mouse.click(x, y);
        };
        try {
            // The first frame gives the picture its size, so a press on it can be placed.
            await page.waitForFunction(() => document.querySelector('.stream-mount .touch-layer')?.width === 428);
            const home = await where();
            await openOverlay(page, mobile);
            const sheet = typingSheet(page);
            assert.deepEqual(
                await sheet.evaluate((dialog) => ({
                    modal: dialog.matches(':modal'),
                    backdrop: dialog.querySelectorAll('.kit-sheet-backdrop').length,
                    // The page takes focus: a modal dialog would make it inert. Focus goes back to the field.
                    inert: (() => {
                        const field = document.activeElement;
                        const outside = document.querySelector('.kit-bar button');
                        outside.focus();
                        const inert = document.activeElement !== outside;
                        field.focus({ preventScroll: true });
                        return inert;
                    })(),
                    through: getComputedStyle(dialog).pointerEvents,
                })),
                { modal: false, backdrop: 0, inert: false, through: 'none' },
                `${label}: Type text is not modal, has no backdrop and leaves the page in use`,
            );
            const picture = await page.locator('.stream-mount .touch-layer').boundingBox();
            const panel = await sheet.locator('.kit-sheet-panel').boundingBox();
            const point = { x: picture.x + picture.width / 2, y: picture.y + picture.height / 2 };
            assert(point.y < panel.y, `${label}: the test presses the picture, not the sheet`);
            assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, point), 'touch-layer', `${label}: nothing covers or dims the picture`);
            await captureTyping(page, `picture-${label}`);

            for (let count = 0; count < 2; count++) {
                const before = touches();
                await pressAt(point.x, point.y);
                for (let tries = 0; tries < 50 && touches() === before; tries++) await page.waitForTimeout(20);
                assert(touches() > before, `${label}: press ${count + 1} on the picture is a touch on the iPhone`);
            }
            await page.waitForTimeout(150);
            assert.equal(await sheet.count(), 1, `${label}: Type text stays open after a press on the picture`);
            assert.equal(await sheet.evaluate((dialog) => dialog.hasAttribute('data-exiting')), false);
            assert.deepEqual(await where(), { ...home, index: home.index + 1, overlay: 1 }, `${label}: the press does not step through history`);
            assert.equal(await page.evaluate(() => document.activeElement?.className), 'kit-field live-text-input', `${label}: the field keeps focus, so the keyboard stays up`);

            // Typing goes on, and a key goes to the field once: the window's key capture leaves it.
            await page.keyboard.type('a');
            await test.waitForKeys(2);
            await page.waitForTimeout(200);
            assert.deepEqual(test.keys(), press(0x04), `${label}: one key press reaches the iPhone for one key`);

            // A press and a wheel inside the sheet are not touches on the iPhone.
            const before = touches();
            const title = await sheet.locator('.kit-sheet-title').boundingBox();
            await pressAt(title.x + 10, title.y + title.height / 2);
            await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 2);
            await page.mouse.wheel(0, 120);
            await page.waitForTimeout(150);
            assert.equal(touches(), before, `${label}: nothing pressed in the sheet reaches the iPhone`);
            assert.equal(await sheet.count(), 1);

            // Back closes it and leaves the page; so do Escape and the close control.
            await page.goBack();
            await sheet.waitFor({ state: 'hidden' });
            assert.deepEqual(await where(), home, `${label}: Back closes Type text and stays on the page`);
            assert.equal(await page.locator('.stream-view').count(), 1);
            await openOverlay(page, mobile);
            await page.keyboard.press('Escape');
            await sheet.waitFor({ state: 'hidden' });
            await openOverlay(page, mobile);
            await closeTyping(page).click();
            await sheet.waitFor({ state: 'hidden' });
            assert.deepEqual(await where(), home);

            // From the Actions sheet: Type text takes its place, and the field has focus in the
            // same press, not after Actions has played its exit. iPhone Safari raises its
            // keyboard only for a focus in the press.
            if (mobile) {
                await page.locator('.floating-toolbar-fab').tap();
                await settleMotion(page);
            }
            await page.locator('.control-buttons-list [title="Actions"]').click();
            const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
            await actions.waitFor();
            await settleMotion(page);
            const open = actions.locator('.kit-row', { hasText: 'Type text' }).getByRole('button', { name: 'Open', exact: true });
            const afterPress = await open.evaluate((button) => new Promise((resolve) => {
                button.click();
                setTimeout(() => resolve({
                    focus: document.activeElement?.className,
                    modal: document.querySelectorAll('dialog:modal').length,
                }), 0);
            }));
            assert.deepEqual(afterPress, { focus: 'kit-field live-text-input', modal: 0 }, `${label}: the field has focus in the press that opened Type text from Actions`);
            await settleMotion(page);
            await page.waitForTimeout(300);
            assert.equal(await page.evaluate(() => document.activeElement?.className), 'kit-field live-text-input', `${label}: the field keeps focus after Actions has gone`);
            await page.keyboard.press('Escape');
            await sheet.waitFor({ state: 'hidden' });
            await page.waitForTimeout(200);
            assert.equal(await page.locator('dialog.kit-sheet[open]').count(), 0, `${label}: no sheet is left open`);
            assert.equal(test.streams(), 1, `${label}: one screen session for the whole visit`);
            assert.deepEqual(test.errors, []);
            console.log(`PASS iOS ${label}: a press on the picture with Type text open is a touch, Type text stays open and typing goes on; from Actions the field has focus in the press`);
        } finally {
            await test.context.close();
        }
    }
}

async function keyboardLifecycleFlow(browser) {
    const test = await start(browser, { mobile: true });
    const { page } = test;
    const keyboardMessages = () => test.sent.filter(message => ['key', 'keyboard-detach'].includes(message.type));
    const detachCount = () => keyboardMessages().filter(message => message.type === 'keyboard-detach').length;
    const waitUntil = async (ready, message) => {
        for (let tries = 0; tries < 300 && !ready(); tries++) await page.waitForTimeout(20);
        assert.ok(ready(), message);
    };
    const repeatPress = count => Array.from({ length: count }, () => press(0x04)).flat();
    try {
        await openOverlay(page, true);
        assert.deepEqual(keyboardMessages(), [], 'opening the typing dock does not register a keyboard or send an empty report');
        await page.keyboard.insertText('a'.repeat(32));
        await closeTyping(page).click();
        await typingSheet(page).waitFor({ state: 'hidden' });
        assert.ok(test.keys().length < 64, 'Close closes while the queued text is still being sent');
        await waitUntil(() => detachCount() === 1, 'Close detaches the virtual keyboard after queued text finishes');
        assert.deepEqual(test.keys(), repeatPress(32), 'closing preserves every queued character');
        assert.equal(keyboardMessages().at(-1).type, 'keyboard-detach', 'detach follows the final key release');

        // Reopen while the previous close is waiting on a long input sequence. Its detach
        // must be invalidated before it can unregister the keyboard during this new session.
        const firstRunEnd = keyboardMessages().length;
        await openOverlay(page, true);
        await page.keyboard.insertText('a'.repeat(120));
        await closeTyping(page).click();
        await typingSheet(page).waitFor({ state: 'hidden' });
        await openOverlay(page, true);
        assert.ok(test.keys().length < 64 + 240, 'the dock reopens before the earlier text finishes');
        await page.keyboard.insertText('b');
        await waitUntil(() => test.keys().length === 64 + 242, 'old and new session text both finish');
        await page.waitForTimeout(50);
        assert.equal(detachCount(), 1, 'reopening cancels the older queued detach');
        assert.deepEqual(keyboardMessages().slice(firstRunEnd).map(message => message.usages), [...repeatPress(120), ...press(0x05)], 'the reopened session retains text order without a detach between batches');
        await closeTyping(page).click();
        await typingSheet(page).waitFor({ state: 'hidden' });
        await waitUntil(() => detachCount() === 2, 'the newly closed session still detaches');

        await openOverlay(page, true);
        const beforeBlur = test.keys().length;
        await page.keyboard.insertText('a'.repeat(24));
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await waitUntil(() => detachCount() === 3, 'window blur detaches after queued text');
        assert.deepEqual(test.keys().slice(beforeBlur), repeatPress(24));
        assert.equal(keyboardMessages().at(-1).type, 'keyboard-detach');
        // An input after blur starts a new session and can safely request a later detach.
        await page.keyboard.insertText('c');
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await waitUntil(() => detachCount() === 4, 'backgrounding the PWA releases the virtual keyboard');
        assert.deepEqual(test.keys().slice(beforeBlur + 48), press(0x06));
        assert.equal(keyboardMessages().at(-1).type, 'keyboard-detach');
        await page.evaluate(() => { delete document.visibilityState; });
        await closeTyping(page).click();
        await typingSheet(page).waitFor({ state: 'hidden' });
        await waitUntil(() => detachCount() === 5, 'closing a backgrounded session remains safe');

        // Captured physical keys release held usages before detaching on window blur.
        await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true })));
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await waitUntil(() => detachCount() === 6, 'blur detaches captured hardware keyboard input');
        assert.deepEqual(keyboardMessages().slice(-3), [
            { type: 'key', usages: [0x04] }, { type: 'key', usages: [] }, { type: 'keyboard-detach' },
        ]);

        assert.deepEqual(test.errors, []);
        console.log('keyboard lifecycle: queued close, reopen race, blur/background and held-key release passed');
    } finally { await test.context.close(); }
}

async function settleLayout(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function setVisualViewport(page, viewport) {
    await page.evaluate(next => window.__setTypingViewport(next), viewport);
    await settleLayout(page);
}

async function addPortraitSurface(page) {
    await page.locator('.video').evaluate(video => {
        const canvas = document.createElement('canvas');
        canvas.className = 'video-layer typing-fixture-video';
        canvas.width = 428; canvas.height = 926;
        const context = canvas.getContext('2d');
        context.fillStyle = '#17263e'; context.fillRect(0, 0, 428, 926);
        context.fillStyle = '#74d3c5'; context.fillRect(0, 0, 428, 80);
        context.fillStyle = '#17263e'; context.font = 'bold 22px sans-serif';
        context.fillText('REMOTE PHONE — TOP', 20, 48);
        context.fillStyle = '#fff'; context.font = '28px sans-serif';
        context.fillText('Typing layout fixture', 24, 150);
        context.fillStyle = '#354860';
        for (let index = 0; index < 6; index++) context.fillRect(24, 190 + index * 90, 380, 60);
        context.fillStyle = '#74d3c5'; context.fillRect(0, 846, 428, 80);
        context.fillStyle = '#17263e'; context.font = 'bold 22px sans-serif';
        context.fillText('REMOTE PHONE — BOTTOM', 14, 896);
        const touch = document.createElement('canvas');
        touch.width = 428; touch.height = 926;
        touch.className = 'touch-layer typing-fixture-touch';
        video.append(canvas, touch);
    });
    await settleLayout(page);
}

async function typingGeometry(page) {
    return page.evaluate(() => {
        const rect = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON();
        const viewport = visualViewport;
        return {
            viewport: { top: viewport.offsetTop, left: viewport.offsetLeft, width: viewport.width, height: viewport.height },
            stream: rect('.stream-view'), header: rect('.kit-bar'), stage: rect('.stream-stage'), video: rect('.video'),
            dock: rect('dialog.kit-sheet[open] .kit-sheet-panel'), canvas: rect('.typing-fixture-video'), touch: rect('.typing-fixture-touch'), feedbackError: rect('.live-text-feedback-error'),
            active: document.activeElement?.className,
            buttons: [...document.querySelectorAll('dialog.kit-sheet[open] .kit-sheet-panel button, dialog.kit-sheet[open] .kit-sheet-panel input')]
                .filter(el => el.getClientRects().length)
                .map(el => ({ name: el.getAttribute('aria-label') || el.textContent.trim(), ...el.getBoundingClientRect().toJSON() })),
            overflow: document.documentElement.scrollWidth > innerWidth || document.querySelector('dialog.kit-sheet[open] .kit-sheet-body').scrollWidth > document.querySelector('dialog.kit-sheet[open] .kit-sheet-body').clientWidth,
            // Below 600px the sheet is at the bottom edge; from there it is a dialog a little above
            // it, and on the edge in a short window.
            docked: innerWidth < 600,
            short: innerHeight <= 500,
            field: rect('.live-text-input'),
        };
    });
}

async function captureTyping(page, label) {
    await fs.mkdir(SCREENSHOTS, { recursive: true });
    await settleLayout(page);
    await page.screenshot({ path: path.join(SCREENSHOTS, `ws-ios-typing-${browserName}-${label}.png`), animations: 'disabled' });
}

async function assertTypingLayout(page, label) {
    await captureTyping(page, label);
    const boxes = await typingGeometry(page);
    const { viewport: vv, header, video, dock, canvas, touch, field } = boxes;
    assert.ok(header.top >= vv.top - 1, `${label}: the stream header is not clipped above the visual viewport`);
    assert.ok(header.bottom <= vv.top + vv.height, `${label}: the stream header remains visible`);
    assert.ok(dock.left >= vv.left - 1 && dock.right <= vv.left + vv.width + 1, `${label}: the dock fits horizontally inside the visual viewport`);
    assert.ok(dock.top >= vv.top - 1 && dock.bottom <= vv.top + vv.height + 1, `${label}: every dock row stays above the local keyboard`);
    assert.ok(video.top >= header.bottom - 1, `${label}: the full stream starts below its header`);
    // A bottom sheet, and a dialog in a short window, stand on the keyboard; a dialog in a taller
    // window stands a little above it. The picture is fitted above the sheet in every case.
    const gap = vv.top + vv.height - dock.bottom;
    if (boxes.docked || boxes.short) assert.ok(Math.abs(gap) < 1.1, `${label}: the sheet stands on the local keyboard (${gap}px)`);
    else assert.ok(gap > 8 && gap < 40, `${label}: the dialog stands a little above the local keyboard (${gap}px)`);
    assert.ok(video.bottom <= dock.top + 1, `${label}: the video area is reserved above the typing dock`);
    assert.ok(field.top >= vv.top - 1 && field.bottom <= vv.top + vv.height + 1, `${label}: the typing field stays above the local keyboard`);
    assert.ok(video.height > 20, `${label}: the stream retains usable vertical space`);
    assert.ok(canvas.height > 20 && canvas.top >= video.top - 1 && canvas.bottom <= video.bottom + 1, `${label}: the whole portrait frame fits above the dock`);
    assert.ok(Math.abs(canvas.width / canvas.height - 428 / 926) < .01, `${label}: the frame keeps its aspect ratio`);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(canvas[key] - touch[key]) < 1.1, `${label}: video and touch layers stay aligned (${key})`);
    // The sheet's header, the field and one row of keys, and one more line while a send has failed.
    assert.ok(dock.height <= (boxes.docked ? (boxes.feedbackError ? 212 : 186) : 160), `${label}: the typing sheet stays compact (${dock.height}px)`);
    assert.ok(boxes.buttons.every(button => button.top >= vv.top - 1 && button.bottom <= vv.top + vv.height + 1), `${label}: every control is in view above the local keyboard`);
    if (boxes.feedbackError) assert.ok(boxes.feedbackError.top >= dock.top && boxes.feedbackError.bottom <= dock.bottom, `${label}: send errors remain visible inside the dock`);
    assert.ok(boxes.buttons.every(button => button.height >= 44 && button.width >= 44), `${label}: all controls remain usable touch targets`);
    assert.equal(boxes.overflow, false, `${label}: no horizontal overflow`);
    assert.equal(boxes.active, 'kit-field live-text-input', `${label}: keyboard focus stays on the live typing field`);
    return boxes;
}

async function keyboardViewportFlow(browser) {
    const test = await start(browser, { mobile: true, mockViewport: true });
    const { page } = test;
    try {
        await addPortraitSurface(page);
        const initial = await page.locator('.video').boundingBox();
        await openOverlay(page, true);
        await setVisualViewport(page, { height: 470, width: 390, offsetTop: 0, offsetLeft: 0 });
        await assertTypingLayout(page, 'keyboard-portrait');
        await setVisualViewport(page, { offsetTop: 42 });
        await assertTypingLayout(page, 'keyboard-panned');
        await page.keyboard.type('ab');
        assert.deepEqual(await test.waitForKeys(4), [...press(0x04), ...press(0x05)], 'viewport fitting does not disturb ordered live typing');
        await page.keyboard.insertText('é');
        await page.waitForFunction(() => /no key for these/.test(document.querySelector('.live-text-feedback').textContent));
        await assertTypingLayout(page, 'keyboard-error');
        assert.equal(test.keys().length, 4, 'unsupported text produces visible feedback without HID reports');

        await page.setViewportSize({ width: 844, height: 390 });
        await setVisualViewport(page, { height: 220, width: 844, offsetTop: 14, offsetLeft: 0 });
        await assertTypingLayout(page, 'keyboard-landscape');
        await page.keyboard.type('c');
        assert.deepEqual((await test.waitForKeys(6)).slice(4), press(0x06));
        await page.waitForFunction(() => document.querySelector('.live-text-feedback').textContent === 'Text sent');
        await page.setViewportSize({ width: 320, height: 568 });
        await setVisualViewport(page, { height: 280, width: 320, offsetTop: 18, offsetLeft: 0 });
        await assertTypingLayout(page, 'keyboard-small-phone');

        await page.setViewportSize({ width: 390, height: 844 });
        await setVisualViewport(page, { height: null, width: null, offsetTop: 0, offsetLeft: 0 });
        await closeTyping(page).click();
        await typingSheet(page).waitFor({ state: 'hidden' });
        await settleLayout(page);
        const restored = await page.locator('.video').boundingBox();
        assert.ok(Math.abs(restored.height - initial.height) < 1.1, 'Close restores the original stream height');
        assert.ok(Math.abs(restored.y - initial.y) < 1.1, 'Close restores the original stream top');
        assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('floating-toolbar-fab')), true);
        assert.equal(await page.locator('.stream-view').evaluate(el => el.classList.contains('stream-typing')), false, 'Close clears the temporary typing layout');
        assert.deepEqual(test.errors, []);
        await captureTyping(page, 'keyboard-closed');
        console.log('keyboard viewport: compact dock, uncut stream, rotation, short viewport and Close restoration passed (visualViewport simulation)');
    } finally { await test.context.close(); }
}

async function unlockFlow(browser) {
    for (const mobile of [true, false]) {
        const test = await start(browser, { mobile, locked: true });
        const { page } = test;
        const openUnlock = async () => {
            await page.locator('.lock-screen-notice').getByRole('button', { name: 'Unlock', exact: true }).click();
            await settleMotion(page);
            return page.getByRole('dialog', { name: 'Unlock device', exact: true });
        };
        try {
            if (mobile) { await page.locator('.floating-toolbar-fab').click(); await settleMotion(page); }
            await page.locator('.control-buttons-list [title="Lock"]').click();
            assert.deepEqual(test.sent.filter(m => m.type === 'button'), [{ type: 'button', name: 'lock', state: 'press' }]);
            // The Unlock panel types nothing from the browser: the server does it with the stored
            // passcode (scripts/e2e-ios-settings.js covers that flow). Here: it opens directly,
            // has no passcode field, and without a stored passcode it leads to Settings.
            const dialog = await openUnlock();
            const button = dialog.getByRole('button', { name: 'Open Settings', exact: true });
            const box = await button.boundingBox();
            assert(box.y >= 0 && box.y + box.height <= page.viewportSize().height, 'the unlock action is visible immediately without scrolling');
            assert.equal(await dialog.getByRole('heading', { name: 'Sound', exact: true }).count(), 0);
            assert.equal(await dialog.locator('input').count(), 0, 'no passcode is entered in the browser');
            await dialog.getByText('No passcode is stored on the server for this phone.', { exact: false }).waitFor();
            assert.equal(test.keys().length, 0, 'opening the panel sends no keys');
            assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('passcode'))), []);
            assert.deepEqual(test.errors, []);
            console.log('PASS iOS', mobile ? 'mobile' : 'desktop', 'Lock dispatch and direct Unlock panel without a passcode field');
        } finally { await test.context.close(); }
    }
}

// Text too long for the server's WebSocket frame limit is refused in the sheet and never sent.
async function clipboardLimitFlow(browser) {
    for (const [mobile, colorScheme] of [[true, 'light'], [true, 'dark'], [false, 'light'], [false, 'dark']]) {
        const test = await start(browser, { mobile });
        const { page } = test;
        try {
            await page.emulateMedia({ colorScheme });
            if (mobile) { await page.locator('.floating-toolbar-fab').click(); await settleMotion(page); }
            await page.locator('.control-buttons-list [title="Actions"]').click();
            const dialog = page.getByRole('dialog', { name: 'Actions', exact: true });
            await dialog.waitFor(); await settleMotion(page);
            const draft = dialog.getByLabel('Text for the phone clipboard');
            const send = dialog.getByRole('button', { name: 'Send to phone', exact: true });
            const tooLong = dialog.getByRole('alert').filter({ hasText: /^This text is too long to send\. The limit is 256 KB\.$/ });
            const clipboardMessages = () => test.sent.filter((message) => message.type === 'clipboard');
            await draft.fill('a'.repeat((1 << 18) - 13));
            await tooLong.waitFor();
            assert.equal(await tooLong.getAttribute('role'), 'alert');
            assert(await send.isDisabled(), 'Send is disabled while the text is too long');
            await tooLong.scrollIntoViewIfNeeded();
            await fs.mkdir(SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SCREENSHOTS, `ws-ios-clipboard-limit-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`), animations: 'disabled' });
            const box = await tooLong.boundingBox(), panel = await dialog.locator('.kit-sheet-panel').boundingBox();
            assert(box.x >= panel.x && box.x + box.width <= panel.x + panel.width + 1, 'the message stays inside the sheet');
            // Three bytes per character: the limit counts UTF-8 bytes, not characters.
            await draft.fill('\u20ac'.repeat(Math.floor(((1 << 18) - 14) / 3) + 1));
            await tooLong.waitFor();
            assert.equal(clipboardMessages().length, 0, 'nothing was sent while the text was too long');
            await draft.fill('a'.repeat((1 << 18) - 14));
            await tooLong.waitFor({ state: 'detached' });
            await send.click();
            await dialog.getByText('Sending to the phone clipboard…', { exact: true }).waitFor();
            assert.deepEqual(clipboardMessages().map((message) => [message.op, message.text.length]), [['set', (1 << 18) - 14]]);
            assert.deepEqual(test.errors, []);
            console.log('PASS iOS', mobile ? 'mobile' : 'desktop', colorScheme, 'clipboard text limit');
        } finally { await test.context.close(); }
    }
}

(async () => {
    const browser = await ({ chromium, webkit }[browserName] || chromium).launch({ headless: true });
    try {
        const scenarios = [mobileFlow, desktopFlow, pictureFlow, keyboardViewportFlow, keyboardLifecycleFlow, unlockFlow, clipboardLimitFlow];
        const selected = process.env.SCENARIO ? scenarios.filter(run => run.name === process.env.SCENARIO) : scenarios;
        assert.ok(selected.length, 'SCENARIO names a known typing fixture');
        for (const run of selected) await run(browser);
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
