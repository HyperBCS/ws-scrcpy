/* eslint-disable */
/** The "Type text" overlay must actually reach the device (it routes via UHID, not INJECT_TEXT). */
const { chromium } = require('/home/brandon/ws-scrcpy/node_modules/playwright');

// The controls live behind the floating action button now; expand it before looking for them.
async function openFab(page) {
    const fab = page.locator('.floating-toolbar-fab');
    if ((await fab.count()) === 0) return false;
    const expanded = await fab.getAttribute('aria-expanded');
    if (expanded !== 'true') {
        const b = await fab.boundingBox();
        await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
        await page.waitForTimeout(600);
    }
    return true;
}
const { execSync } = require('child_process');
const SERIAL = process.env.SERIAL || 'WC7HFMPJGY7PUCGQ';
const KB_URL = process.env.KB_URL || 'http://10.10.10.5:8099/';
const adb = (c) => execSync(`adb -s ${SERIAL} ${c}`, { encoding: 'utf8' });
const field = () => { adb('shell uiautomator dump /sdcard/u.xml'); const x = adb('shell cat /sdcard/u.xml'); const m = x.match(/text="([^"]*)"\s+resource-id="o"/); return m ? m[1] : '(not found)'; };
(async () => {
    adb('shell svc power stayon usb'); adb('shell input keyevent 224'); adb('shell input keyevent 82');
    adb(`shell am start -a android.intent.action.VIEW -d "${KB_URL}"`);
    await new Promise((r) => setTimeout(r, 6000));
    console.log('before:', field());
    const b = await chromium.launch({ headless: true });
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await c.newPage();
    await p.goto('http://127.0.0.1:8000/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(2500);
    await p.locator('.device', { has: p.locator(`text=${SERIAL}`) }).locator('a.desc-block.stream').first().click();
    await p.waitForTimeout(11000);
    await openFab(p);
    const pos = await p.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.control-buttons-list [title]')).find((e) => e.getAttribute('title') === 'Type text');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    await p.touchscreen.tap(pos.x, pos.y);
    await p.waitForTimeout(900);
    await p.keyboard.type('Typed-OK', { delay: 70 });
    await p.waitForTimeout(2000);
    console.log('after :', field());
    await b.close();
})();
