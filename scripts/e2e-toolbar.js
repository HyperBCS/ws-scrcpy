const { chromium } = require('playwright');
const BASE = process.env.BASE || process.argv[2] || 'http://127.0.0.1:8000/';

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
    await p.getByRole('link', { name: 'Open screen', exact: true }).first().click();
    await p.waitForTimeout(11000);
    await openFab(p);

    const items = await p.locator('.control-buttons-list .control-button').evaluateAll((buttons) =>
        buttons.map((button) => ({ label: button.getAttribute('aria-label'), title: button.title })),
    );
    console.log('toolbar controls:', JSON.stringify(items));
    // Keep the physical control presses of this hardware-only pass. Sheet entry points also
    // verify their current title and close control; phone keys report the press for observation.
    for (const item of items) {
        await openFab(p);
        await p.getByRole('button', { name: item.label, exact: true }).click();
        if (['Actions', 'Settings', 'Type text'].includes(item.label)) {
            const sheet = p.getByRole('dialog', { name: item.label, exact: true });
            await sheet.waitFor();
            console.log(`${item.label}: opened ${await sheet.locator('.kit-sheet-title').textContent()}`);
            await sheet.getByRole('button', { name: /^Close/ }).click();
            await sheet.waitFor({ state: 'hidden' });
        } else {
            console.log(`${item.label}: pressed; check the phone for its effect`);
        }
    }
    // Switch is in the phone header rather than the controls panel.
    await p.getByRole('button', { name: 'Switch', exact: true }).click();
    const switcher = p.getByRole('dialog', { name: 'Switch phone', exact: true });
    await switcher.waitFor();
    await switcher.getByRole('button', { name: /^Close/ }).click();
    await switcher.waitFor({ state: 'hidden' });
    if (errs.length) console.log('PAGE ERRORS:', errs.slice(0, 5));
    await b.close();
})();
