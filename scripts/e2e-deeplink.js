/**
 * Reloading a stream URL must behave the same as navigating to it from the device list. The
 * device list is what used to start the host tracker, so a direct load left the device store
 * empty and every udid lookup (stream settings, device switcher, sleep overlay) silently no-op'd.
 */
const { chromium } = require('playwright');

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
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SERIAL = process.env.SERIAL || 'WC7HFMPJGY7PUCGQ';
(async () => {
    const b = await chromium.launch({ headless: true });
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await c.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));

    // 1. Navigate from the list, capture the resulting deep link.
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.waitForTimeout(2500);
    await p.locator(`.device[data-device-key$=":${SERIAL}"]`).getByRole('link', { name: 'Open screen', exact: true }).first().click();
    await p.waitForTimeout(9000);
    const url = p.url();
    console.log('deep link:', url.slice(0, 90) + '…');

    // 2. Hard-reload straight onto it, exactly as the user's refresh does.
    await p.goto(url, { waitUntil: 'networkidle' });
    await p.waitForTimeout(11000);
    await openFab(p);

    const open = () => p.evaluate(() => Array.from(document.querySelectorAll('dialog.kit-sheet[open]')).map((e) => e.querySelector('.kit-sheet-title')?.textContent).join(',') || '(none)');
    console.log('devices known after reload:', await p.evaluate(() => document.querySelectorAll('.device').length), '(list not rendered on stream route, store is what matters)');
    for (const title of ['Settings', 'Switch', 'Actions']) {
        if (title !== 'Switch') await openFab(p);
        await p.getByRole('button', { name: title, exact: true }).click();
        await p.getByRole('dialog', { name: title === 'Switch' ? 'Switch phone' : title, exact: true }).waitFor();
        await p.waitForTimeout(1200);
        const o = await open();
        const hasContent = await p.evaluate(() => {
            const s = document.querySelector('dialog.kit-sheet[open] .kit-sheet-body');
            return s ? s.innerText.trim().length : 0;
        });
        console.log(`  ${title.padEnd(16)} -> sheet "${o}" bodyChars=${hasContent} ${o !== '(none)' ? 'OK' : '*** DEAD ***'}`);
        await p.evaluate(() => document.querySelector('dialog.kit-sheet[open] .kit-sheet-close')?.click());
        await p.waitForTimeout(600);
    }
    if (errs.length) console.log('page errors:', errs.slice(0, 4));
    await b.close();
})();
