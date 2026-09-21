/* eslint-disable */
const { chromium } = require('/home/brandon/ws-scrcpy/node_modules/playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:8000/';

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
(async () => {
    const b = await chromium.launch({ headless: true });
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await c.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.waitForTimeout(2500);
    await p.locator('a.desc-block.stream').first().click();
    await p.waitForTimeout(11000);
    await openFab(p);

    const items = await p.evaluate(() => {
        const out = [];
        document.querySelectorAll('.control-buttons-list > *').forEach((el, i) => {
            const t = el.querySelector('[title]') || el;
            out.push({ i, tag: el.tagName, cls: el.className, title: t.getAttribute('title') || el.getAttribute('title') || '' });
        });
        return out;
    });
    console.log('toolbar items:', JSON.stringify(items, null, 1));

    // Click each interactive control and report what visibly changed.
    for (const it of items) {
        const snap = () =>
            p.evaluate(() =>
                Array.from(document.querySelectorAll('.bottom-sheet-root'))
                    .map((el) => (el.classList.contains('open') ? el.querySelector('.bottom-sheet-title')?.textContent : null))
                    .filter(Boolean)
                    .join(','),
            );
        const before = await snap();
        try {
            await p.evaluate((i) => {
                const el = document.querySelectorAll('.control-buttons-list > *')[i];
                const target = el.tagName === 'LABEL' || el.tagName === 'BUTTON' ? el : el.querySelector('button,label');
                if (target) target.click();
            }, it.i);
        } catch (e) { /* ignore */ }
        await p.waitForTimeout(900);
        const after = await snap();
        console.log(`  [${it.i}] ${(it.title || it.cls).padEnd(22)} openSheets "${before}" -> "${after}"  ${before !== after ? 'OPENED' : '*** NO EFFECT ***'}`);
        // close any sheet before the next one
        await p.evaluate(() => { const bd = document.querySelector('.bottom-sheet-backdrop'); if (bd) bd.click(); });
        await p.waitForTimeout(500);
    }
    if (errs.length) console.log('PAGE ERRORS:', errs.slice(0, 5));
    await b.close();
})();
