/* eslint-disable */
// Files flows that the main Files suite does not reach: history, menus on short screens,
// selection on a phone, dialogs, errors, upload control and large files. Run through
// scripts/test-browser.js. Every socket is answered by the fixture in e2e-files.js; no device
// is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { settleMotion } = require('./ui-motion');
const { fixture } = require('./e2e-files');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-files';
const UDID = 'files-fixture';
const ROOT = '/data/local/tmp';

const PHONE = { width: 390, height: 844, touch: true };
const DESKTOP = { width: 1280, height: 800, touch: false };
const row = (page, name) => page.locator(`.fx-row[data-name="${name}"]`);
const ready = (page) => page.locator('.file-explorer[data-listing="ready"]').waitFor();
const crumb = (page, name) => page.locator('.fx-crumb[aria-current="page"]').filter({ hasText: name }).waitFor();

/** Opens the app with the fixture attached. `target` is a folder, or undefined for the device list. */
async function start(browser, { width, height, touch }, target, scheme = 'dark') {
    const context = await browser.newContext({
        viewport: { width, height },
        isMobile: touch,
        hasTouch: touch,
        acceptDownloads: true,
        colorScheme: scheme,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const device = await fixture(page);
    const url = new URL(BASE);
    if (target) url.hash = `!${new URLSearchParams({ action: 'list-files', udid: UDID, path: target })}`;
    await page.goto(url.toString());
    if (target) await ready(page);
    const finish = async () => {
        assert.deepEqual(errors, [], 'no browser errors');
        await context.close();
    };
    return { page, context, finish, ...device };
}

async function open(page, name) {
    const anchor = row(page, name).locator('.entry-name a');
    const coarse = await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
    if (coarse) await anchor.click();
    else await anchor.dblclick();
}

// One history: the device card's link, the toolbar and the browser all walk the same entries.
async function history(browser, layout) {
    const { page, finish } = await start(browser, layout);
    const card = page.locator('.device').filter({ hasText: 'Files test phone' });
    await card.locator('summary').click();
    await card.getByRole('link', { name: 'Files', exact: true }).click();
    await ready(page);
    await row(page, 'notes.txt').waitFor();
    const back = page.getByRole('button', { name: 'Back', exact: true });
    const forward = page.getByRole('button', { name: 'Forward', exact: true });
    assert.equal(await back.isDisabled(), true, 'nothing to go back to inside Files yet');
    assert.equal(await forward.isDisabled(), true);
    assert.equal(
        new URLSearchParams(await page.evaluate(() => location.hash.slice(2))).get('path'),
        ROOT,
        'the link names the folder the way the explorer shows it',
    );
    // The first Back leaves Files: opening it added exactly one entry.
    await page.goBack();
    await page.locator('.file-listing-client').waitFor({ state: 'detached' });
    await card.waitFor();
    await page.goForward();
    await ready(page);

    // A link written with a trailing slash is corrected in place, not pushed a second time.
    await page.evaluate(
        ({ udid, root }) => {
            location.hash = `#!${new URLSearchParams({ action: 'list-files', udid, path: root + '/archive/' })}`;
        },
        { udid: UDID, root: ROOT },
    );
    await crumb(page, 'archive');
    await ready(page);
    await page.waitForFunction(() => !decodeURIComponent(location.hash).endsWith('/'));
    await page.goBack();
    await crumb(page, 'tmp');
    await ready(page);
    assert.equal(await forward.isDisabled(), false, 'the browser Back leaves Forward available');

    // The toolbar and the browser move through the same entries, in either order.
    await open(page, 'empty');
    await crumb(page, 'empty');
    await ready(page);
    assert.equal(await forward.isDisabled(), true, 'a new folder clears Forward');
    await back.click();
    await crumb(page, 'tmp');
    await page.goForward();
    await crumb(page, 'empty');
    await page.goBack();
    await crumb(page, 'tmp');
    await forward.click();
    await crumb(page, 'empty');
    await back.click();
    await crumb(page, 'tmp');
    await ready(page);
    assert.equal(await back.isDisabled(), true, 'the toolbar Back stops at the folder Files opened on');
    await page.goBack();
    await page.locator('.file-listing-client').waitFor({ state: 'detached' });
    await finish();
}

/** The element can be brought fully inside the tool frame, which clips everything else. */
async function reachable(page, locator, what) {
    await locator.scrollIntoViewIfNeeded();
    await settleMotion(page);
    const frame = await page.locator('.tool-mount').boundingBox();
    const box = await locator.boundingBox();
    assert(
        box.y >= frame.y - 0.5 && box.y + box.height <= frame.y + frame.height + 0.5,
        `${what} is inside the tool frame (${Math.round(box.y)}..${Math.round(box.y + box.height)} of ${Math.round(frame.y)}..${Math.round(frame.y + frame.height)})`,
    );
    const viewport = page.viewportSize();
    assert(box.y + box.height <= viewport.height, `${what} is on screen`);
}

async function menuFits(page, what) {
    await settleMotion(page);
    const frame = await page.locator('.tool-mount').boundingBox();
    const menu = await page.locator('.fx-menu').boundingBox();
    assert(
        menu.y >= frame.y && menu.y + menu.height <= frame.y + frame.height + 0.5,
        `${what} stays inside the tool frame (${Math.round(menu.y)}..${Math.round(menu.y + menu.height)} of ${Math.round(frame.y + frame.height)})`,
    );
}

// Menus on short screens: every item can be reached, because the menu scrolls inside the frame.
async function menus(browser) {
    // A phone in portrait with little height, and the longest Actions menu.
    let session = await start(browser, { width: 390, height: 664, touch: true }, ROOT);
    let page = session.page;
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.locator('.fx-menu').waitFor();
    await menuFits(page, 'the Actions menu');
    await reachable(page, page.getByRole('menuitem', { name: 'View options…', exact: true }), 'View options');
    await page.getByRole('menuitem', { name: 'View options…', exact: true }).click();
    await page.locator('.fx-menu [data-menu="view"]').first().waitFor();
    await menuFits(page, 'the View options inside Actions');
    await reachable(page, page.getByRole('menuitemcheckbox', { name: 'Hidden items' }), 'Hidden items');
    await page.screenshot({ path: path.join(OUT, 'flows-menu-phone-664.png') });
    await page.keyboard.press('Escape');
    await session.finish();

    // A phone in landscape: the row menu and the View menu are both taller than the frame.
    session = await start(browser, { width: 926, height: 428, touch: true }, ROOT);
    page = session.page;
    await row(page, 'notes.txt').locator('.fx-row-menu').click();
    await page.locator('.fx-menu').waitFor();
    await menuFits(page, 'the row menu');
    await reachable(page, page.getByRole('menuitem', { name: 'Properties', exact: true }), 'Properties');
    await reachable(page, page.getByRole('menuitem', { name: 'Delete', exact: true }), 'Delete');
    await page.screenshot({ path: path.join(OUT, 'flows-menu-landscape-row.png') });
    await page.keyboard.press('Escape');
    await page.locator('.fx-menu').waitFor({ state: 'hidden' });
    await page.locator('.fx-commands').getByRole('button', { name: 'View', exact: true }).click();
    await page.locator('.fx-menu').waitFor();
    await menuFits(page, 'the View menu');
    assert(
        await page.locator('.fx-menu').evaluate((menu) => menu.scrollHeight > menu.clientHeight),
        'the View menu scrolls when it is taller than the frame',
    );
    await reachable(page, page.getByRole('menuitemcheckbox', { name: 'Hidden items' }), 'Hidden items');
    await reachable(page, page.getByRole('menuitemradio', { name: 'Descending', exact: true }), 'Descending');
    await page.screenshot({ path: path.join(OUT, 'flows-menu-landscape-view.png') });
    await page.keyboard.press('Escape');
    await session.finish();
}

// Keyboard focus in the list: visible on the row, and the list is one Tab stop.
async function keyboardFocus(browser) {
    const { page, finish } = await start(browser, DESKTOP, ROOT, 'light');
    const stops = () => page.locator('tbody [tabindex="0"]').evaluateAll((list) => list.map((el) => el.getAttribute('aria-label')));
    assert.deepEqual(await stops(), ['Open archive', 'Actions for archive'], 'one row holds the Tab stops');
    assert.equal(await page.locator('.fx-items').getAttribute('tabindex'), '-1', 'the container is not a second stop');
    await page.getByRole('button', { name: 'Modified', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Open archive');
    await page.keyboard.press('ArrowDown');
    const focused = await page.evaluate(() => {
        const anchor = document.activeElement;
        const style = getComputedStyle(anchor);
        const cell = anchor.closest('td').getBoundingClientRect();
        const box = anchor.getBoundingClientRect();
        const offset = parseFloat(style.outlineOffset);
        const width = parseFloat(style.outlineWidth);
        const other = document.querySelector('.fx-row[data-name="empty"]');
        return {
            label: anchor.getAttribute('aria-label'),
            visible: anchor.matches(':focus-visible') && style.outlineStyle === 'solid' && width >= 2,
            // The outline's outer edge, which must not leave the cell that clips it.
            inside:
                box.left - offset - width >= cell.left &&
                box.top - offset - width >= cell.top &&
                box.right + offset + width <= cell.right &&
                box.bottom + offset + width <= cell.bottom,
            rowTint: getComputedStyle(anchor.closest('tr')).backgroundColor !== getComputedStyle(other).backgroundColor,
        };
    });
    assert.deepEqual(focused, { label: 'Open denied', visible: true, inside: true, rowTint: true });
    await page.screenshot({ path: path.join(OUT, 'flows-row-focus.png') });
    assert.deepEqual(await stops(), ['Open denied', 'Actions for denied'], 'the Tab stop follows the arrow keys');
    // Tab reaches the focused row's menu, then leaves the list; it does not walk every row.
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Actions for denied');
    await page.keyboard.press('Space');
    await page.locator('.fx-menu').waitFor();
    assert.equal(await page.locator('.fx-row.selected').count(), 1, 'Space on the menu button opens the menu');
    await page.keyboard.press('Escape');
    await page.locator('.fx-menu').waitFor({ state: 'hidden' });
    await row(page, 'denied').locator('.fx-row-menu').focus();
    await page.keyboard.press('Tab');
    assert.equal(
        await page.evaluate(() => !!document.activeElement.closest('tbody')),
        false,
        'the next Tab leaves the list',
    );
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Open denied');
    // A re-render (sorting) keeps the stop on the same row.
    await page.getByRole('button', { name: 'Size', exact: true }).click();
    assert.deepEqual(await stops(), ['Open denied', 'Actions for denied']);
    await finish();
}

// The details table: dates and sizes are whole at every width, and Type gives way first.
async function columns(browser) {
    const { page, finish } = await start(browser, DESKTOP, ROOT, 'light');
    const measure = () =>
        page.evaluate(() => {
            const cut = (selector) =>
                Array.from(document.querySelectorAll(selector)).filter(
                    (cell) => cell.getClientRects().length && cell.scrollWidth > cell.clientWidth,
                ).length;
            return {
                times: cut('.entry-time'),
                sizes: cut('.entry-size'),
                types: cut('.entry-type'),
                typeShown: !!document.querySelector('.entry-type')?.getClientRects().length,
                name: Math.round(document.querySelector('.fx-col-name').getBoundingClientRect().width),
                headers: Array.from(document.querySelectorAll('.fx-table thead .fx-sort')).filter(
                    (button) => button.getClientRects().length && button.scrollWidth > button.clientWidth,
                ).length,
            };
        });
    for (const [width, touch] of [[720, false], [760, false], [820, false], [1024, false], [1100, false], [1280, false]]) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(50);
        const result = await measure();
        assert.equal(result.times, 0, `no Modified date is cut off at ${width}px`);
        assert.equal(result.sizes, 0, `no Size is cut off at ${width}px`);
        assert.equal(result.types, 0, `no Type is cut off at ${width}px`);
        assert.equal(result.headers, 0, `no column heading is cut off at ${width}px`);
        assert(result.name >= 280, `Name keeps room at ${width}px (${result.name}px)`);
        assert.equal(result.typeShown, width >= 760, `Type is shown from 760px, and gives way below (${width}px)`);
        if (width === 820) await page.screenshot({ path: path.join(OUT, 'flows-columns-820.png') });
    }
    await finish();
    // A tablet has larger text and 44px controls.
    const tablet = await start(browser, { width: 820, height: 1180, touch: true }, ROOT, 'light');
    const result = await tablet.page.evaluate(() => {
        const cut = (selector) =>
            Array.from(document.querySelectorAll(selector)).filter(
                (cell) => cell.getClientRects().length && cell.scrollWidth > cell.clientWidth,
            ).length;
        return { times: cut('.entry-time'), sizes: cut('.entry-size'), types: cut('.entry-type') };
    });
    assert.deepEqual(result, { times: 0, sizes: 0, types: 0 }, 'a tablet shows whole dates, sizes and types');
    await tablet.page.screenshot({ path: path.join(OUT, 'flows-columns-tablet.png') });
    await tablet.finish();
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const only = process.env.FX_ONLY;
    const scenarios = [
        ['history desktop', () => history(browser, DESKTOP)],
        ['history phone', () => history(browser, PHONE)],
        ['menus on short screens', () => menus(browser)],
        ['keyboard focus', () => keyboardFocus(browser)],
        ['columns', () => columns(browser)],
    ];
    try {
        for (const [name, run] of scenarios) {
            if (only && !name.includes(only)) continue;
            await run();
            console.log('PASS', name);
        }
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
