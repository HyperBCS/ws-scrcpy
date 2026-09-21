/* eslint-disable */
// Real-device regression: keyboard input must survive a quality restart, and settings read back.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SERIAL = process.env.SERIAL;
const KB_URL = process.env.KB_URL || 'http://10.10.10.5:8099/';
if (!SERIAL) throw new Error('Set SERIAL to the device under test.');
const adb = (...args) => execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8' });
function dump() {
    adb('shell', 'uiautomator', 'dump', '/sdcard/ws-scrcpy-review.xml');
    return adb('shell', 'cat', '/sdcard/ws-scrcpy-review.xml');
}
function field(xml) {
    return xml.match(/text="([^"]*)"\s+resource-id="o"/)?.[1];
}
async function focusField(page) {
    const xml = dump();
    const bounds = xml.match(/resource-id="i"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    assert(bounds, 'deterministic input field must be visible on device');
    const [left, top, right, bottom] = bounds.slice(1).map(Number);
    const size = adb('shell', 'wm', 'size')
        .match(/(\d+)x(\d+)/)
        .slice(1)
        .map(Number);
    const box = await page.locator('.touch-layer').boundingBox();
    await page.mouse.click(
        box.x + ((left + right) / 2 / size[0]) * box.width,
        box.y + ((top + bottom) / 2 / size[1]) * box.height,
    );
}
async function settings(page) {
    const fab = page.locator('.floating-toolbar-fab');
    if ((await fab.getAttribute('aria-expanded')) !== 'true') await fab.click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.bottom-sheet-root.open .settings-quality-preset:not(:disabled)').first().waitFor();
}
async function applyPreset(page, name, nextHandshake) {
    await page
        .getByRole('button', { name: new RegExp(name) })
        .filter({ has: page.locator('strong') })
        .click();
    await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
    await page.getByRole('button', { name: 'Apply & restart', exact: true }).click();
    await page
        .getByText('Saved. Active screens will reconnect automatically.', { exact: true })
        .waitFor({ timeout: 35000 });
    await nextHandshake();
    await page.keyboard.press('Escape');
}
async function main() {
    adb('shell', 'input', 'keyevent', '224');
    adb('shell', 'input', 'keyevent', '82');
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `${KB_URL}?review=${Date.now()}`);
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
        const page = await context.newPage();
        let handshakes = 0;
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('websocket', (socket) =>
            socket.on('framereceived', (frame) => {
                if (Buffer.isBuffer(frame.payload) && frame.payload.subarray(0, 14).toString() === 'scrcpy_initial')
                    handshakes++;
            }),
        );
        const waitHandshake = async (count) => {
            const end = Date.now() + 45000;
            while (handshakes < count && Date.now() < end) await page.waitForTimeout(250);
            assert(handshakes >= count, `expected stream handshake ${count}, got ${handshakes}`);
            await page.waitForTimeout(1000);
        };
        await page.goto(BASE);
        await page.locator('.device').filter({ hasText: SERIAL }).locator('a.desc-block.stream').first().click();
        await waitHandshake(1);
        await focusField(page);
        await page.keyboard.type('before', { delay: 70 });
        assert.equal(field(dump()), 'before', 'physical keyboard reaches the device before restart');
        const sibling = await page.context().newPage();
        await sibling.goto(page.url());
        await sibling.waitForFunction(() =>
            document.querySelector('.stream-header-status')?.textContent.includes('Connected'),
        );
        await sibling.close();
        await focusField(page);
        await page.keyboard.press('End');
        await page.keyboard.type('shared', { delay: 70 });
        assert.equal(field(dump()), 'beforeshared', 'closing another viewer must not destroy this keyboard');
        await settings(page);
        const originalPreset = await page.locator('.settings-quality-preset[aria-pressed="true"] strong').innerText();
        const testPreset = originalPreset === 'Data saver' ? 'Balanced' : 'Data saver';
        const next = handshakes + 1;
        await applyPreset(page, testPreset, () => waitHandshake(next));
        await focusField(page);
        await page.keyboard.press('End');
        await page.keyboard.type('after', { delay: 70 });
        assert.equal(field(dump()), 'beforesharedafter', 'UHID keyboard reaches device after stream restart');
        await settings(page);
        assert.equal(
            await page.locator('.settings-quality-preset[aria-pressed="true"] strong').innerText(),
            testPreset,
            'settings show the saved values when reopened',
        );
        await applyPreset(page, originalPreset, () => waitHandshake(next + 1));
        assert.deepEqual(errors, [], 'no browser errors');
        console.log(
            'PASS: real device typing before/after quality restart and second-viewer closure, saved settings readback, original quality restored',
        );
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
