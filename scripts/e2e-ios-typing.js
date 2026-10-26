const { settleMotion } = require('./ui-motion');
/* eslint-disable */
// BASE=http://127.0.0.1:8000 node scripts/e2e-ios-typing.js
// The iOS "Type text" overlay against fixture sockets: every HID report is captured in the
// browser, nothing reaches a phone. Covers the phone layout, live typing order, editing keys,
// smart punctuation, paste, IME commits, focus retention and dismissal. The viewport case
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

async function start(browser, { mobile = true, mockViewport = false, udid = UDID, locked = false } = {}) {
    const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 700 },
        isMobile: mobile,
        hasTouch: mobile,
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
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/notifications/**', route => route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        const target = new URL(socket.url());
        if (target.searchParams.get('action') === 'proxy-coredevice') {
            socket.onMessage((data) => {
                if (typeof data === 'string') sent.push(JSON.parse(data));
            });
            setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 50);
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
        document.querySelector('.stream-header-status')?.textContent.includes('Connected'),
    );
    const keys = () => sent.filter((message) => message.type === 'key').map((message) => message.usages);
    const waitForKeys = async (count) => {
        for (let i = 0; i < 100 && keys().length < count; i++) await page.waitForTimeout(20);
        return keys();
    };
    return { context, page, errors, sent, keys, waitForKeys };
}

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
    await page.locator('.live-text-overlay').waitFor();
    await settleMotion(page);
}

async function mobileFlow(browser) {
    const test = await start(browser, { mobile: true });
    const { page } = test;
    await openOverlay(page, true);
    assert.equal(
        await page.evaluate(() => document.activeElement?.className),
        'live-text-input',
        'the field is focused so the phone keyboard opens',
    );
    assert.match(await page.locator('#live-text-hint').textContent(), /on the phone/);

    await settleMotion(page);
    const geometry = await page.evaluate(() => {
        const bar = document.querySelector('.live-text-bar');
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
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'live-text-input');
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
    await page.locator('.live-text-overlay').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'floating-toolbar-fab', 'focus returns to the controls button');
    assert.deepEqual(test.errors, []);
    await test.context.close();
    console.log('mobile: ok');
}

async function desktopFlow(browser) {
    const test = await start(browser, { mobile: false });
    const { page } = test;
    await openOverlay(page, false);
    await page.keyboard.type('a1!');
    assert.deepEqual(await test.waitForKeys(8), [...press(0x04), ...press(0x1e), ...shifted(0x1e)]);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Enter');
    assert.deepEqual((await test.waitForKeys(14)).slice(8), [...press(0x50), ...press(0x4c), ...press(0x28)]);
    // The window-level capture must stay quiet while the overlay owns the keyboard: no report
    // for the physical H key beyond the typed text itself.
    assert.equal(test.keys().length, 14);
    const done = page.locator('.live-text-done');
    await done.click();
    await page.locator('.live-text-overlay').waitFor({ state: 'detached' });
    assert.deepEqual(test.errors, []);
    await test.context.close();
    console.log('desktop: ok');
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
        await page.locator('.live-text-done').click();
        await page.locator('.live-text-overlay').waitFor({ state: 'detached' });
        assert.ok(test.keys().length < 64, 'Done closes while the queued text is still being sent');
        await waitUntil(() => detachCount() === 1, 'Done detaches the virtual keyboard after queued text finishes');
        assert.deepEqual(test.keys(), repeatPress(32), 'closing preserves every queued character');
        assert.equal(keyboardMessages().at(-1).type, 'keyboard-detach', 'detach follows the final key release');

        // Reopen while the previous close is waiting on a long input sequence. Its detach
        // must be invalidated before it can unregister the keyboard during this new session.
        const firstRunEnd = keyboardMessages().length;
        await openOverlay(page, true);
        await page.keyboard.insertText('a'.repeat(120));
        await page.locator('.live-text-done').click();
        await page.locator('.live-text-overlay').waitFor({ state: 'detached' });
        await openOverlay(page, true);
        assert.ok(test.keys().length < 64 + 240, 'the dock reopens before the earlier text finishes');
        await page.keyboard.insertText('b');
        await waitUntil(() => test.keys().length === 64 + 242, 'old and new session text both finish');
        await page.waitForTimeout(50);
        assert.equal(detachCount(), 1, 'reopening cancels the older queued detach');
        assert.deepEqual(keyboardMessages().slice(firstRunEnd).map(message => message.usages), [...repeatPress(120), ...press(0x05)], 'the reopened session retains text order without a detach between batches');
        await page.locator('.live-text-done').click();
        await page.locator('.live-text-overlay').waitFor({ state: 'detached' });
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
        await page.locator('.live-text-done').click();
        await page.locator('.live-text-overlay').waitFor({ state: 'detached' });
        await waitUntil(() => detachCount() === 5, 'closing a backgrounded session remains safe');

        // Captured physical keys release held usages before detaching on window blur.
        await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true })));
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await waitUntil(() => detachCount() === 6, 'blur detaches captured hardware keyboard input');
        assert.deepEqual(keyboardMessages().slice(-3), [
            { type: 'key', usages: [0x04] }, { type: 'key', usages: [] }, { type: 'keyboard-detach' },
        ]);

        // The separate passcode helper also releases its keyboard after the final digit.
        // This dummy code and its wake/swipe/key sequence are intercepted by fixture sockets.
        await page.locator('.floating-toolbar-fab').click();
        await page.locator('.control-buttons-list [title="Actions"]').click();
        await page.getByRole('dialog', { name: 'Actions', exact: true }).getByRole('button', { name: 'Unlock', exact: true }).click();
        await settleMotion(page);
        const beforePasscode = test.keys().length;
        await page.getByLabel('Device passcode').fill('1234');
        assert.equal(test.keys().length, beforePasscode, 'editing the local passcode field sends no remote keys');
        await page.getByRole('button', { name: 'Unlock', exact: true }).click();
        await waitUntil(() => detachCount() === 7, 'passcode input detaches after its final digit');
        assert.deepEqual(test.keys().slice(beforePasscode), [...press(0x1e), ...press(0x1f), ...press(0x20), ...press(0x21)]);
        assert.equal(keyboardMessages().at(-1).type, 'keyboard-detach');
        await page.getByText('Passcode sent.', { exact: false }).waitFor();
        assert.equal(await page.getByLabel('Device passcode').inputValue(), '1234', 'the masked passcode is retained for reuse');
        assert.deepEqual(test.errors, []);
        console.log('keyboard lifecycle: queued close, reopen race, blur/background, held-key release and passcode cleanup passed');
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
            stream: rect('.stream-view'), header: rect('.stream-header'), stage: rect('.stream-stage'), video: rect('.video'),
            dock: rect('.live-text-bar'), canvas: rect('.typing-fixture-video'), touch: rect('.typing-fixture-touch'), feedbackError: rect('.live-text-feedback-error'),
            active: document.activeElement?.className,
            buttons: [...document.querySelectorAll('.live-text-bar button, .live-text-bar input')]
                .filter(el => el.getClientRects().length)
                .map(el => ({ name: el.getAttribute('aria-label') || el.textContent.trim(), ...el.getBoundingClientRect().toJSON() })),
            overflow: document.documentElement.scrollWidth > innerWidth || document.querySelector('.live-text-bar').scrollWidth > document.querySelector('.live-text-bar').clientWidth,
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
    const { viewport: vv, header, video, dock, canvas, touch } = boxes;
    assert.ok(header.top >= vv.top - 1, `${label}: the stream header is not clipped above the visual viewport`);
    assert.ok(header.bottom <= vv.top + vv.height, `${label}: the stream header remains visible`);
    assert.ok(dock.left >= vv.left - 1 && dock.right <= vv.left + vv.width + 1, `${label}: the dock fits horizontally inside the visual viewport`);
    assert.ok(dock.top >= vv.top - 1 && dock.bottom <= vv.top + vv.height + 1, `${label}: every dock row stays above the local keyboard`);
    assert.ok(video.top >= header.bottom - 1, `${label}: the full stream starts below its header`);
    assert.ok(video.bottom <= dock.top + 1, `${label}: the video area is reserved above the typing dock`);
    assert.ok(video.height > 20, `${label}: the stream retains usable vertical space`);
    assert.ok(canvas.height > 20 && canvas.top >= video.top - 1 && canvas.bottom <= video.bottom + 1, `${label}: the whole portrait frame fits above the dock`);
    assert.ok(Math.abs(canvas.width / canvas.height - 428 / 926) < .01, `${label}: the frame keeps its aspect ratio`);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(canvas[key] - touch[key]) < 1.1, `${label}: video and touch layers stay aligned (${key})`);
    assert.ok(dock.height <= 160, `${label}: the mobile typing dock stays compact`);
    if (boxes.feedbackError) assert.ok(boxes.feedbackError.top >= dock.top && boxes.feedbackError.bottom <= dock.bottom, `${label}: send errors remain visible inside the dock`);
    assert.ok(boxes.buttons.every(button => button.height >= 44 && button.width >= 44), `${label}: all controls remain usable touch targets`);
    assert.equal(boxes.overflow, false, `${label}: no horizontal overflow`);
    assert.equal(boxes.active, 'live-text-input', `${label}: keyboard focus stays on the live typing field`);
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
        await page.locator('.live-text-done').click();
        await page.locator('.live-text-overlay').waitFor({ state: 'detached' });
        await settleLayout(page);
        const restored = await page.locator('.video').boundingBox();
        assert.ok(Math.abs(restored.height - initial.height) < 1.1, 'Done restores the original stream height');
        assert.ok(Math.abs(restored.y - initial.y) < 1.1, 'Done restores the original stream top');
        assert.equal(await page.evaluate(() => document.activeElement?.className), 'floating-toolbar-fab');
        assert.equal(await page.locator('.stream-view').evaluate(el => el.classList.contains('stream-typing')), false, 'Done clears the temporary typing layout');
        assert.deepEqual(test.errors, []);
        await captureTyping(page, 'keyboard-closed');
        console.log('keyboard viewport: compact dock, uncut stream, rotation, short viewport and Done restoration passed (visualViewport simulation)');
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
            const dialog = await openUnlock();
            const input = dialog.getByLabel('Device passcode');
            const button = dialog.getByRole('button', { name: 'Unlock', exact: true });
            for (const control of [input, button]) {
                const box = await control.boundingBox();
                assert(box.y >= 0 && box.y + box.height <= page.viewportSize().height, 'unlock controls are visible immediately without scrolling');
            }
            assert.equal(await dialog.getByRole('heading', { name: 'Sound', exact: true }).count(), 0);
            assert.equal(await input.getAttribute('type'), 'password');
            await input.fill('000719'); assert.equal(test.keys().length, 0);
            await input.press('Enter');
            await dialog.getByText('Passcode sent.', { exact: true }).waitFor();
            assert.deepEqual(test.keys(), [...press(0x27), ...press(0x27), ...press(0x27), ...press(0x24), ...press(0x1e), ...press(0x26)]);
            const count = test.keys().length;
            await page.reload(); await openUnlock();
            assert.equal(await input.inputValue(), '000719', 'saved code survives reload');
            assert.equal(test.keys().length, count, 'saved codes never send themselves');
            await page.getByRole('button', { name: 'Close Unlock device' }).click();
            await page.evaluate(() => { location.hash = location.hash.replace('fixture-iphone-typing', 'fixture-other-phone'); });
            await page.waitForFunction(() => document.querySelector('.stream-header-status')?.textContent.includes('Connected'));
            if (mobile) { await page.locator('.floating-toolbar-fab').click(); await settleMotion(page); }
            await page.locator('.control-buttons-list [title="Actions"]').click();
            await page.getByRole('dialog', { name: 'Actions', exact: true }).getByRole('button', { name: 'Unlock', exact: true }).click();
            await settleMotion(page);
            assert.equal(await input.inputValue(), '', 'another device does not inherit the code');
            await page.evaluate(() => { location.hash = location.hash.replace('fixture-other-phone', 'fixture-iphone-typing'); });
            await openUnlock(); assert.equal(await input.inputValue(), '000719');
            await dialog.getByRole('button', { name: 'Forget', exact: true }).click();
            await page.reload(); await openUnlock(); assert.equal(await input.inputValue(), '');
            assert.equal(test.keys().length, count);
            assert.deepEqual(test.errors, []);
            console.log('PASS iOS', mobile ? 'mobile' : 'desktop', 'Lock dispatch, direct Unlock panel, masked per-device persistence, reload and Forget');
        } finally { await test.context.close(); }
    }
}

(async () => {
    const browser = await ({ chromium, webkit }[browserName] || chromium).launch({ headless: true });
    try {
        const scenarios = [mobileFlow, desktopFlow, keyboardViewportFlow, keyboardLifecycleFlow, unlockFlow];
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
