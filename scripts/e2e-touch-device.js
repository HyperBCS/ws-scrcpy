/* eslint-disable */
/**
 * Proves a tap in the browser actually moves the DEVICE, not merely that a control message left
 * the page.
 *
 * Uses a purpose-built page with a large tap target and a counter rather than tapping a system
 * app: "did the foreground activity change?" depends on hitting a row that happens to navigate,
 * which produced false failures that looked exactly like a product bug.
 *
 * Requires that page served at $KB_URL (see scripts/serve-testpage.sh).
 */
const { chromium } = require('/home/brandon/ws-scrcpy/node_modules/playwright');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8000/';
const SERIAL = process.env.SERIAL || 'WC7HFMPJGY7PUCGQ';
const KB_URL = process.env.KB_URL || 'http://10.10.10.5:8099/';
const OUT = process.env.E2E_OUT || path.join(process.env.HOME, '.cache', 'wsshot');

const adb = (cmd) => execSync(`adb -s ${SERIAL} ${cmd}`, { encoding: 'utf8' }).trim();
const dumpUi = () => {
    adb('shell uiautomator dump /sdcard/u.xml');
    return adb('shell cat /sdcard/u.xml');
};
const tapCount = (xml) => {
    const m = xml.match(/text="(\d+)"\s+resource-id="t"/);
    return m ? parseInt(m[1], 10) : -1;
};
// Target bounds in DEVICE pixels, so the test aims at it instead of guessing coordinates.
const targetCentre = (xml) => {
    const m = xml.match(/resource-id="btn"[^/]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!m) return null;
    const [, l, t, r, b] = m.map(Number);
    return { x: (l + r) / 2, y: (t + b) / 2 };
};

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    adb('shell svc power stayon usb');
    adb('shell input keyevent 224');
    adb('shell input keyevent 82'); // dismiss lock screen
    adb(`shell am start -a android.intent.action.VIEW -d "${KB_URL}"`);
    await new Promise((r) => setTimeout(r, 6000));

    const xml = dumpUi();
    const before = tapCount(xml);
    const centre = targetCentre(xml);
    const size = adb('shell wm size').match(/(\d+)x(\d+)/);
    if (before < 0 || !centre || !size) {
        console.log('[RESULT] SETUP FAILED - is the test page open on the device?');
        process.exit(1);
    }
    const [, dw, dh] = size.map(Number);
    console.log(`[device] taps before=${before}, target=(${centre.x},${centre.y}) of ${dw}x${dh}`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await page
        .locator('.device', { has: page.locator(`text=${SERIAL}`) })
        .locator('a.desc-block.stream')
        .first()
        .click();
    await page.waitForTimeout(11000);
    await page.screenshot({ path: path.join(OUT, '10-before-tap.png') });

    // Map the device-pixel target into the touch layer's own box.
    const rect = await page.evaluate(() => {
        const v = document.querySelector('.touch-layer') || document.querySelector('.video');
        const r = v.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const tx = Math.round(rect.x + (centre.x / dw) * rect.w);
    const ty = Math.round(rect.y + (centre.y / dh) * rect.h);
    console.log(`[browser] tapping (${tx}, ${ty}) within ${JSON.stringify(rect)}`);
    await page.touchscreen.tap(tx, ty);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, '11-after-tap.png') });

    const after = tapCount(dumpUi());
    console.log(`[device] taps after=${after}`);
    console.log(
        after > before
            ? '[RESULT] PASS - the browser tap reached the device'
            : '[RESULT] FAIL - device did not register the tap',
    );

    await browser.close();
    process.exit(after > before ? 0 : 2);
}

main().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
});
