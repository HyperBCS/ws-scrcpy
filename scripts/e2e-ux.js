/* eslint-disable */
// Phone-first layout and interaction regression checks against an attached device.
// BASE=http://127.0.0.1:8000 SERIAL=<adb serial> node scripts/e2e-ux.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SERIAL = process.env.SERIAL;
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-ux';

async function noOverflow(page, label) {
    const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert(size.scroll <= size.width + 1, `${label}: horizontal overflow ${JSON.stringify(size)}`);
}
async function screenshot(page, name) {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true, animations: 'disabled' });
}
async function openControls(page) {
    const fab = page.locator('.floating-toolbar-fab');
    if ((await fab.getAttribute('aria-expanded')) !== 'true') await fab.click();
    await page.locator('.floating-toolbar-panel').waitFor({ state: 'visible' });
}
async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({
            viewport: { width: 440, height: 956 },
            isMobile: true,
            hasTouch: true,
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(BASE);
        await page.locator('.device').first().waitFor();
        const card = SERIAL ? page.locator('.device').filter({ hasText: SERIAL }) : page.locator('.device').first();
        await noOverflow(page, 'phone list');
        await screenshot(page, 'phone-devices');
        await card.getByRole('button', { name: /^Settings for / }).click();
        const dialog = page.locator('.bottom-sheet-root.open [role="dialog"]');
        await dialog.waitFor();
        await page.waitForFunction(
            () =>
                !document
                    .querySelector('.bottom-sheet-root.open')
                    ?.textContent.includes('Loading current device settings'),
        );
        await screenshot(page, 'phone-settings');
        await noOverflow(page, 'phone settings');
        for (let i = 0; i < 16; i++) {
            await page.keyboard.press('Tab');
            assert(
                await dialog.evaluate((el) => el.contains(document.activeElement)),
                'dialog must contain keyboard focus',
            );
        }
        await page.keyboard.press('Escape');
        await page.locator('.bottom-sheet-root.open').waitFor({ state: 'detached' });
        assert(
            await card.getByRole('button', { name: /^Settings for / }).evaluate((el) => el === document.activeElement),
            'close restores focus',
        );
        await card.locator('a.desc-block.stream').first().click();
        await page.waitForFunction(
            () => document.querySelector('.stream-header-status')?.textContent.includes('Connected'),
            undefined,
            { timeout: 45000 },
        );
        await page.locator('.touch-layer').waitFor({ state: 'visible' });
        await page.waitForTimeout(1200); // Allow the first key frame to render after the handshake.
        await screenshot(page, 'phone-stream');
        await openControls(page);
        await screenshot(page, 'phone-controls');
        const targets = await page.locator('.control-buttons-list button').evaluateAll((els) =>
            els.map((el) => ({
                name: el.title,
                w: el.getBoundingClientRect().width,
                h: el.getBoundingClientRect().height,
            })),
        );
        assert(targets.length >= 9, 'control panel contains expected actions');
        for (const t of targets) assert(t.w >= 44 && t.h >= 44, `${t.name}: small touch target ${t.w}x${t.h}`);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await dialog.waitFor();
        await page.keyboard.press('Tab');
        assert(
            await dialog.evaluate((el) => el.contains(document.activeElement)),
            'remote capture must not steal dialog Tab',
        );
        await page.keyboard.press('Escape');
        await page.locator('.bottom-sheet-root.open').waitFor({ state: 'detached' });
        await openControls(page);
        await page.getByRole('button', { name: 'Type text', exact: true }).click();
        await page.getByRole('textbox', { name: 'Text to send to device' }).waitFor();
        assert(
            await page
                .getByRole('textbox', { name: 'Text to send to device' })
                .evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 16),
            'mobile text field avoids Safari focus zoom',
        );
        await screenshot(page, 'phone-keyboard');
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        for (const [label, width, height] of [
            ['iphone17pm-landscape', 956, 440],
            ['small-phone', 320, 568],
            ['tablet', 1280, 900],
        ]) {
            await page.setViewportSize({ width, height });
            await page.waitForTimeout(400);
            await noOverflow(page, label);
            await openControls(page);
            const fab = await page.locator('.floating-toolbar-fab').boundingBox();
            assert(
                fab.x >= 0 && fab.y >= 0 && fab.x + fab.width <= width + 1 && fab.y + fab.height <= height + 1,
                `${label}: controls remain on screen`,
            );
            await screenshot(page, `${label}-controls`);
            await page.getByRole('button', { name: 'Settings', exact: true }).click();
            await dialog.waitFor();
            await dialog.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
            const box = await dialog.boundingBox();
            assert(
                box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1,
                `${label}: dialog remains inside viewport`,
            );
            await screenshot(page, `${label}-settings`);
            await page.keyboard.press('Escape');
        }
        const streamUrl = page.url();
        await page.getByRole('button', { name: 'Back to devices', exact: true }).click();
        await page.locator('.device').first().waitFor();
        const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const desktop = await desktopContext.newPage();
        desktop.on('pageerror', (error) => errors.push(error.message));
        await desktop.goto(streamUrl);
        await desktop.waitForFunction(
            () => document.querySelector('.stream-header-status')?.textContent.includes('Connected'),
            undefined,
            { timeout: 45000 },
        );
        await desktop.locator('.floating-toolbar.desktop .control-button').first().waitFor();
        assert.equal(await desktop.locator('.floating-toolbar-fab').count(), 0, 'desktop has no mobile FAB');
        const sidebar = await desktop.locator('.stream-controls-slot').boundingBox();
        const video = await desktop.locator('.stream-mount').boundingBox();
        assert(
            sidebar.width >= 80 && video.x + video.width <= sidebar.x + 1,
            'desktop sidebar reserves space beside the video',
        );
        const centeredBack = await desktop.locator('.stream-header-back').evaluate((button) => {
            const outer = button.getBoundingClientRect();
            const icon = button.querySelector('svg').getBoundingClientRect();
            return (
                Math.abs(outer.x + outer.width / 2 - icon.x - icon.width / 2) < 1 &&
                Math.abs(outer.y + outer.height / 2 - icon.y - icon.height / 2) < 1
            );
        });
        assert(centeredBack, 'back icon is centered in its touch target');
        await screenshot(desktop, 'desktop-controls');
        await desktop.setViewportSize({ width: 480, height: 720 });
        await noOverflow(desktop, 'narrow desktop');
        assert.equal(await desktop.locator('.floating-toolbar-fab').count(), 0, 'narrow desktop keeps its sidebar');
        await desktop.setViewportSize({ width: 1280, height: 900 });
        await desktop.getByRole('button', { name: 'Settings', exact: true }).click();
        const desktopDialog = desktop.locator('.bottom-sheet-root.open [role="dialog"]');
        await desktopDialog.waitFor();
        await desktop.keyboard.press('Tab');
        assert(
            await desktopDialog.evaluate((el) => el.contains(document.activeElement)),
            'desktop dialog contains keyboard focus',
        );
        await screenshot(desktop, 'desktop-settings');
        await desktop.keyboard.press('Escape');
        await desktop.getByRole('button', { name: 'Back to devices', exact: true }).click();
        await desktop.locator('.device').first().waitFor();
        await screenshot(desktop, 'desktop-devices');
        assert.deepEqual(errors, [], 'no browser runtime errors');
        console.log(
            'PASS: device list, mobile/tablet FAB, desktop sidebar, centered navigation, dialog focus and Escape, stream startup, labeled touch targets, text UI, viewport changes, return navigation',
        );
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
