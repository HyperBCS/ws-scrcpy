/* eslint-disable */
/**
 * Reloading a stream URL must behave the same as navigating to it from the device list. The
 * device list is what used to start the host tracker, so a direct load left the device store
 * empty and every udid lookup (stream settings, device switcher, sleep overlay) silently no-op'd.
 */
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
const SERIAL = process.env.SERIAL || 'WC7HFMPJGY7PUCGQ';
(async () => {
    const b = await chromium.launch({ headless: true });
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await c.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));

    // 1. Navigate from the list, capture the resulting deep link.
    await p.goto('http://127.0.0.1:8000/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(2500);
    await p.locator('.device', { has: p.locator(`text=${SERIAL}`) }).locator('a.desc-block.stream').first().click();
    await p.waitForTimeout(9000);
    const url = p.url();
    console.log('deep link:', url.slice(0, 90) + '…');

    // 2. Hard-reload straight onto it, exactly as the user's refresh does.
    await p.goto(url, { waitUntil: 'networkidle' });
    await p.waitForTimeout(11000);
    await openFab(p);

    const open = () => p.evaluate(() => Array.from(document.querySelectorAll('.bottom-sheet-root.open')).map((e) => e.querySelector('.bottom-sheet-title')?.textContent).join(',') || '(none)');
    const btn = (title) => p.evaluate((t) => {
        const el = Array.from(document.querySelectorAll('.control-buttons-list [title]')).find((e) => e.getAttribute('title') === t);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, title);

    console.log('devices known after reload:', await p.evaluate(() => document.querySelectorAll('.device').length), '(list not rendered on stream route, store is what matters)');
    for (const title of ['Settings', 'Switch device', 'Actions']) {
        const pos = await btn(title);
        if (!pos) { console.log(`  ${title}: BUTTON NOT FOUND`); continue; }
        await p.touchscreen.tap(pos.x, pos.y);
        await p.waitForTimeout(1200);
        const o = await open();
        const hasContent = await p.evaluate(() => {
            const s = document.querySelector('.bottom-sheet-root.open .bottom-sheet-body');
            return s ? s.innerText.trim().length : 0;
        });
        console.log(`  ${title.padEnd(16)} -> sheet "${o}" bodyChars=${hasContent} ${o !== '(none)' ? 'OK' : '*** DEAD ***'}`);
        await p.evaluate(() => document.querySelector('.bottom-sheet-root.open .bottom-sheet-close')?.click());
        await p.waitForTimeout(600);
    }
    if (errs.length) console.log('page errors:', errs.slice(0, 4));
    await b.close();
})();
