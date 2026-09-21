/* eslint-disable */
// BASE=http://127.0.0.1:8000 node scripts/e2e-ios-typing.js
// The iOS "Type text" overlay against fixture sockets: every HID report is captured in the
// browser, nothing reaches a phone. Covers the phone layout, live typing order, editing keys,
// smart punctuation, paste, focus retention and dismissal.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
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

async function start(browser, { mobile = true } = {}) {
    const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 700 },
        isMobile: mobile,
        hasTouch: mobile,
    });
    const page = await context.newPage();
    const errors = [];
    const sent = [];
    page.on('pageerror', (error) => errors.push(error.message));
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
                socket.send(channelJson(frame.readUInt32LE(1), { id: -1, type: 'hosts', data: { local: [] } }));
            }
        });
    });
    const url = new URL(BASE);
    url.hash = `!${new URLSearchParams({ action: 'stream-coredevice', udid: UDID })}`;
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
        const button = page.locator('.control-buttons-list [title="Type text"]');
        const target = await button.boundingBox();
        await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2);
    } else {
        await page.locator('.control-buttons-list [title="Type text"]').click();
    }
    await page.locator('.live-text-overlay').waitFor();
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

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        await mobileFlow(browser);
        await desktopFlow(browser);
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
