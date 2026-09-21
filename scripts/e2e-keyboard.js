/* eslint-disable */
/**
 * Verifies the browser keyboard reaches the device as a real (UHID) keyboard: opens a stream,
 * types with Playwright's keyboard, and reads back what the DEVICE's focused field received.
 * Expects a page with an <input id=i> served at $KB_URL to be open on the device.
 */
const { chromium } = require('/home/brandon/ws-scrcpy/node_modules/playwright');
const { execSync } = require('child_process');
const SERIAL = process.env.SERIAL || 'WC7HFMPJGY7PUCGQ';
const KB_URL = process.env.KB_URL || 'http://10.10.10.5:8099/';
const adb = (c) => execSync(`adb -s ${SERIAL} ${c}`, { encoding: 'utf8' });
const fieldText = () => {
    adb('shell uiautomator dump /sdcard/ui.xml');
    const xml = adb('shell cat /sdcard/ui.xml');
    const m = xml.match(/resource-id="o"[^>]*/);
    const m2 = xml.match(/text="([^"]*)"\s+resource-id="o"/);
    return m2 ? m2[1] : (m ? m[0].slice(0, 80) : '(field not found)');
};
(async () => {
    // Wake AND dismiss the lock screen: a woken-but-locked device shows systemui, so the test
    // page is never in the foreground and nothing types into it.
    adb('shell svc power stayon usb');
    adb('shell input keyevent 224');
    adb('shell input keyevent 82');
    adb('shell input swipe 600 2000 600 800');
    adb(`shell am start -a android.intent.action.VIEW -d "${KB_URL}"`);
    await new Promise((r) => setTimeout(r, 6000));
    console.log('device field before:', fieldText());

    const b = await chromium.launch({ headless: true });
    const c = await b.newContext({ viewport: { width: 900, height: 700 } });
    const p = await c.newPage();
    await p.goto('http://127.0.0.1:8000/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(2500);
    // Pick the card for OUR device: with more than one attached, `.first()` may open a device
    // whose scrcpy server is not running and no video surface ever mounts.
    const card = p.locator('.device', { has: p.locator(`text=${SERIAL}`) });
    await card.locator('a.desc-block.stream').first().click();
    await p.waitForTimeout(11000);
    // Focus the video surface, then type as a user would.
    await p.locator('.touch-layer').click({ position: { x: 20, y: 20 } });
    await p.waitForTimeout(600);
    await p.keyboard.type('hello', { delay: 90 });
    await p.waitForTimeout(1500);
    console.log('device field after :', fieldText());
    await b.close();
})();
