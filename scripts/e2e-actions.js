/* eslint-disable */
/** Exercises the Actions sheet against a real device: each button must change device state. */
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
const adb = (c) => execSync(`adb -s ${SERIAL} ${c}`, { encoding: 'utf8' }).trim();
// `dumpsys window` prints several mCurrentFocus lines and the first is usually `null`; take the
// last non-null one. No `grep -m1`/`head`: closing the pipe early makes dumpsys log a broken pipe.
const focus = () => {
    // Several mCurrentFocus lines are printed and the first is usually `null`; take the last real
    // one, and capture the whole window name (it contains spaces, so a \\S+ capture truncates it).
    const out = adb(`shell "dumpsys window | grep mCurrentFocus" || true`);
    const all = [...out.matchAll(/mCurrentFocus=Window\{\S+ \S+ ([^}]+)\}/g)].map((m) => m[1]);
    return all.length ? all[all.length - 1] : 'null';
};
(async () => {
    adb('shell input keyevent 224');
    adb('shell input keyevent 82');
    adb('shell am start -a android.intent.action.MAIN -c android.intent.category.HOME');
    adb('shell input swipe 600 1200 600 1000'); // settle
    // Put something on the device clipboard so "Read from device" has a value to fetch.
    await new Promise((r) => setTimeout(r, 1500));

    const b = await chromium.launch({ headless: true });
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await c.newPage();
    await p.goto('http://127.0.0.1:8000/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(2500);
    await p.locator('.device', { has: p.locator(`text=${SERIAL}`) }).locator('a.desc-block.stream').first().click();
    await p.waitForTimeout(11000);
    await openFab(p);

    const openActions = async () => {
        const pos = await p.evaluate(() => {
            const el = Array.from(document.querySelectorAll('.control-buttons-list [title]')).find((e) => e.getAttribute('title') === 'Actions');
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        });
        await p.touchscreen.tap(pos.x, pos.y);
        await p.waitForTimeout(800);
    };
    const clickInSheet = async (label) => {
        const found = await p.evaluate((t) => {
            const all = Array.from(document.querySelectorAll('.bottom-sheet-root.open .sheet-button')).map((e) => e.textContent.trim());
            return { all, hit: all.includes(t) };
        }, label);
        console.log(`   [debug] sheet buttons=${JSON.stringify(found.all)} hit=${found.hit}`);
        await p.evaluate((t) => {
            const el = Array.from(document.querySelectorAll('.bottom-sheet-root.open .sheet-button')).find((e) => e.textContent.trim() === t);
            if (el) el.click();
        }, label);
        await p.waitForTimeout(1600);
    };

    // The scrcpy server exits when its last viewer disconnects, so assert it is actually alive
    // at click time -- otherwise a dead server looks identical to a dead button.
    console.log('scrcpy pid at click time:', JSON.stringify((() => { try { return adb('shell pidof app_process').trim(); } catch (e) { return '(none)'; } })()));
    await openActions();
    const before = focus();
    await clickInSheet('Notifications');
    const afterNotif = focus();
    console.log(`Notifications : ${before} -> ${afterNotif}  ${afterNotif !== before ? 'OK' : '*** NO EFFECT ***'}`);

    await clickInSheet('Collapse');
    const afterCollapse = focus();
    console.log(`Collapse      : ${afterNotif} -> ${afterCollapse}  ${afterCollapse !== afterNotif ? 'OK' : '*** NO EFFECT ***'}`);

    await b.close();
})();
