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
const { fixture, pressAtRest, DEVICE, SHARED, HUGE, HUGE_COUNT } = require('./e2e-files');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-files';
const UDID = 'files-fixture';
const ROOT = '/data/local/tmp';

const PHONE = { width: 390, height: 844, touch: true };
const DESKTOP = { width: 1280, height: 800, touch: false };
const row = (page, name) => page.locator(`.fx-row[data-name="${name}"]`);
const ready = (page) => page.locator('.file-explorer[data-listing="ready"]').waitFor();
const crumb = (page, name) => page.locator('.fx-crumb[aria-current="page"]').filter({ hasText: name }).waitFor();
/** The address of a folder: the phone's page, its Files view and the path. */
const address = (folder) => `#!${new URLSearchParams({ action: 'device', udid: UDID, view: 'files', path: folder })}`;

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
    await card.waitFor();
    const entries = () => page.evaluate(() => history.length);
    const listEntries = await entries();
    await card.getByRole('link', { name: 'Files on Fixture Files test phone', exact: true }).click();
    await ready(page);
    await row(page, 'notes.txt').waitFor();
    const back = page.getByRole('button', { name: 'Back', exact: true });
    const forward = page.getByRole('button', { name: 'Forward', exact: true });
    assert.equal(await back.isDisabled(), true, 'nothing to go back to inside Files yet');
    assert.equal(await forward.isDisabled(), true);
    assert.equal(
        await page.evaluate(() => location.hash),
        address(ROOT),
        'Files has the address of the phone page, and names the folder the way the explorer shows it',
    );
    // The first Back leaves Files: opening it added exactly one entry.
    assert.equal(await entries(), listEntries + 1);
    await page.goBack();
    await page.locator('.file-listing-client').waitFor({ state: 'detached' });
    await card.waitFor();
    await page.goForward();
    await ready(page);

    // A link in the older form, written with a trailing slash, is rewritten and corrected in
    // place: one entry, not three.
    await page.evaluate(
        ({ udid, root }) => {
            location.hash = `#!${new URLSearchParams({ action: 'list-files', udid, path: root + '/archive/' })}`;
        },
        { udid: UDID, root: ROOT },
    );
    await crumb(page, 'archive');
    await ready(page);
    await page.waitForFunction((expected) => location.hash === expected, address(ROOT + '/archive'));
    assert.equal(await entries(), listEntries + 2);
    await page.goBack();
    await crumb(page, 'tmp');
    await ready(page);
    assert.equal(await forward.isDisabled(), false, 'the browser Back leaves Forward available');

    // The toolbar and the browser move through the same entries, in either order.
    await open(page, 'empty');
    await crumb(page, 'empty');
    await ready(page);
    assert.equal(await page.evaluate(() => location.hash), address(ROOT + '/empty'), 'a folder step keeps the form of the address');
    assert.equal(await entries(), listEntries + 2, 'and is one entry, in place of the one Forward led to');
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

// Menus and dialogs have a history entry of their own: the browser's Back closes the top one
// and leaves the folder alone. One that closes by itself leaves no entry behind.
async function overlays(browser, layout) {
    const { page, finish, traffic } = await start(browser, layout);
    const card = page.locator('.device').filter({ hasText: 'Files test phone' });
    await card.getByRole('link', { name: 'Files on Fixture Files test phone', exact: true }).click();
    await ready(page);
    // Two folder steps, so that the folder shown has another one behind it: tmp, archive, tmp.
    await open(page, 'archive');
    await crumb(page, 'archive');
    await ready(page);
    await page.getByRole('button', { name: 'Up one folder', exact: true }).click();
    await crumb(page, 'tmp');
    await ready(page);
    const menu = page.locator('.files-menu');
    const dialog = page.locator('.fx-dialog[open]');
    const forward = page.getByRole('button', { name: 'Forward', exact: true });
    const openMenu = async () => {
        await page.getByRole('button', { name: layout.touch ? 'Actions' : 'View', exact: true }).click();
        await menu.waitFor();
    };
    const rowCommand = async (command) => {
        await pressAtRest(page, row(page, 'notes.txt').locator('.fx-row-menu'));
        await menu.getByRole('menuitem', { name: command, exact: true }).click();
    };
    const folderKept = async (what) => {
        assert.equal(await page.evaluate(() => location.hash), address(ROOT), `${what}: the address is the folder's`);
        assert.equal(await page.evaluate(() => history.state.nav.overlay), undefined, `${what}: on the folder's own entry`);
        await crumb(page, 'tmp');
        assert.equal(await row(page, 'notes.txt').count(), 1, `${what}: the rows are still there`);
    };

    await openMenu();
    await page.goBack();
    await menu.waitFor({ state: 'hidden' });
    await folderKept('Back with a menu open');

    // A dialog opened from a menu: the menu's entry is gone by then, and Back closes the dialog.
    await rowCommand('Properties');
    await dialog.getByRole('heading', { name: 'Properties', exact: true }).waitFor();
    await page.goBack();
    await page.locator('.fx-dialog').waitFor({ state: 'hidden' });
    await folderKept('Back with Properties open');

    await rowCommand('Delete');
    await dialog.getByRole('heading', { name: `Delete “notes.txt” from ${DEVICE}?`, exact: true }).waitFor();
    await page.goBack();
    await page.locator('.fx-dialog').waitFor({ state: 'hidden' });
    await folderKept('Back with the delete question open');
    assert.equal(traffic.operations.length, 0, 'Back answered the question with Cancel');

    // Rename from a row's menu: the field keeps the keyboard while the menu's entry is left
    // and the dialog's own is added.
    await rowCommand('Rename');
    const field = dialog.locator('input[name="value"]');
    await field.waitFor();
    await page.waitForFunction(() => history.state.nav.overlay === 1);
    await page.keyboard.type('x');
    assert.equal(await field.inputValue(), 'x.txt', 'typing replaces the selected name');
    await page.goBack();
    await page.locator('.fx-dialog').waitFor({ state: 'hidden' });
    await folderKept('Back with Rename open');
    assert.equal(traffic.operations.length, 0, 'nothing was renamed');

    // A menu that is closed with Escape steps back over its own entry, so the next Back is a
    // folder step, and Forward from there is the folder again.
    await openMenu();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await folderKept('Escape in a menu');
    await page.goBack();
    await crumb(page, 'archive');
    await ready(page);
    assert.equal(await forward.isDisabled(), false);
    await forward.click();
    await crumb(page, 'tmp');
    await ready(page);

    // A menu opened on an earlier folder takes the place of what Forward led to, as any new
    // entry does. The toolbar's Forward says so instead of doing nothing.
    await page.goBack();
    await crumb(page, 'archive');
    await ready(page);
    assert.equal(await forward.isDisabled(), false);
    await openMenu();
    assert.equal(await forward.isDisabled(), true, 'Forward has nowhere to go once a menu is open');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await crumb(page, 'tmp');
    await ready(page);
    assert.equal(await page.locator('.file-listing-client').count(), 1, 'Files stayed open throughout');
    await finish();
}

/** The item can be brought fully inside its menu, which is inside the window. */
async function reachable(page, locator, what) {
    await locator.scrollIntoViewIfNeeded();
    await settleMotion(page);
    const menu = await page.locator('.kit-menu.files-menu').boundingBox();
    const box = await locator.boundingBox();
    assert(
        box.y >= menu.y - 0.5 && box.y + box.height <= menu.y + menu.height + 0.5,
        `${what} is inside the menu (${Math.round(box.y)}..${Math.round(box.y + box.height)} of ${Math.round(menu.y)}..${Math.round(menu.y + menu.height)})`,
    );
    const viewport = page.viewportSize();
    assert(box.y >= 0 && box.y + box.height <= viewport.height, `${what} is on screen`);
}

// The kit puts a menu in the top layer, so the tool frame no longer cuts it off. It keeps
// inside the window, 8px from every edge, and scrolls when it is taller than that.
async function menuFits(page, what) {
    await settleMotion(page);
    const viewport = page.viewportSize();
    const menu = await page.locator('.kit-menu.files-menu').boundingBox();
    assert(
        menu.y >= 8 - 0.5 && menu.y + menu.height <= viewport.height - 8 + 0.5,
        `${what} stays inside the window (${Math.round(menu.y)}..${Math.round(menu.y + menu.height)} of ${viewport.height})`,
    );
    assert(
        menu.x >= 8 - 0.5 && menu.x + menu.width <= viewport.width - 8 + 0.5,
        `${what} stays inside the window sideways (${Math.round(menu.x)}..${Math.round(menu.x + menu.width)} of ${viewport.width})`,
    );
}

// Menus on short screens: every item can be reached, because the menu scrolls inside the window.
async function menus(browser) {
    // A phone in portrait with little height, and the longest Actions menu.
    let session = await start(browser, { width: 390, height: 664, touch: true }, ROOT);
    let page = session.page;
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.locator('.files-menu').waitFor();
    await menuFits(page, 'the Actions menu');
    await reachable(page, page.getByRole('menuitem', { name: 'View options…', exact: true }), 'View options');
    await page.getByRole('menuitem', { name: 'View options…', exact: true }).click();
    await page.locator('.files-menu [data-menu="view"]').first().waitFor();
    await menuFits(page, 'the View options inside Actions');
    await reachable(page, page.getByRole('menuitemcheckbox', { name: 'Hidden items' }), 'Hidden items');
    await page.screenshot({ path: path.join(OUT, 'flows-menu-phone-664.png') });
    await page.keyboard.press('Escape');
    await session.finish();

    // A phone in landscape: the row menu and the View menu are both taller than the window.
    session = await start(browser, { width: 926, height: 428, touch: true }, ROOT);
    page = session.page;
    await pressAtRest(page, row(page, 'notes.txt').locator('.fx-row-menu'));
    await page.locator('.files-menu').waitFor();
    await menuFits(page, 'the row menu');
    await reachable(page, page.getByRole('menuitem', { name: 'Properties', exact: true }), 'Properties');
    await reachable(page, page.getByRole('menuitem', { name: 'Delete', exact: true }), 'Delete');
    await page.screenshot({ path: path.join(OUT, 'flows-menu-landscape-row.png') });
    await page.keyboard.press('Escape');
    await page.locator('.files-menu').waitFor({ state: 'hidden' });
    await pressAtRest(page, page.locator('.fx-commands').getByRole('button', { name: 'View', exact: true }));
    await page.locator('.files-menu').waitFor();
    await menuFits(page, 'the View menu');
    assert(
        await page.locator('.files-menu').evaluate((menu) => menu.scrollHeight > menu.clientHeight),
        'the View menu scrolls when it is taller than the window',
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
    await page.locator('.files-menu').waitFor();
    assert.equal(await page.locator('.fx-row.fx-row-menu-open').getAttribute('data-name'), 'denied', 'Space opens the menu');
    assert.equal(await page.locator('.fx-row.selected').count(), 0, 'the menu does not change the selection');
    await page.keyboard.press('Escape');
    await page.locator('.files-menu').waitFor({ state: 'hidden' });
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

// Dialogs: Escape belongs to the dialog, the question names the item and the device, and a
// bad name is explained inside the dialog.
async function dialogs(browser) {
    const { page, finish, traffic } = await start(browser, DESKTOP, ROOT);
    const dialog = page.locator('.fx-dialog[open]');
    const closed = () => page.locator('.fx-dialog').waitFor({ state: 'hidden' });
    const selected = () => page.locator('.fx-row.selected').evaluateAll((rows) => rows.map((item) => item.dataset.name));

    await row(page, 'notes.txt').locator('.entry-name a').click();
    await page.keyboard.press('Delete');
    await dialog.getByRole('heading', { name: `Delete “notes.txt” from ${DEVICE}?`, exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'Cancel has the focus');
    await settleMotion(page);
    await page.screenshot({ path: path.join(OUT, 'flows-dialog-delete.png') });
    // One Escape closes the dialog and leaves the selection as it was.
    await page.keyboard.press('Escape');
    await closed();
    assert.deepEqual(await selected(), ['notes.txt'], 'Escape in the dialog does not clear the selection');
    assert.equal(traffic.operations.length, 0, 'nothing was deleted');

    // The same in Rename, where Escape used to be taken by the list first.
    await page.keyboard.press('F2');
    const field = dialog.locator('input[name="value"]');
    await field.waitFor();
    await page.keyboard.press('Escape');
    await closed();
    assert.deepEqual(await selected(), ['notes.txt']);

    // A name the device cannot take is explained under the field, and the text is kept.
    await page.keyboard.press('F2');
    await field.fill('a/b');
    await page.keyboard.press('Enter');
    const problem = dialog.locator('.fx-dialog-error');
    await problem.waitFor();
    assert.equal(await problem.innerText(), 'A name cannot contain “/”.');
    assert.equal(await field.inputValue(), 'a/b', 'the typed name is still there');
    assert.equal(await field.getAttribute('aria-invalid'), 'true', 'the field is marked invalid');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'value');
    await settleMotion(page);
    await page.screenshot({ path: path.join(OUT, 'flows-dialog-invalid-name.png') });
    await field.fill('photo.png');
    assert.equal(await problem.isVisible(), false, 'typing clears the message');
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
    await problem.waitFor();
    assert.equal(await problem.innerText(), '“photo.png” already exists in this folder.');
    assert.equal(traffic.operations.length, 0, 'a refused name sends nothing');
    await field.fill('renamed.txt');
    await page.keyboard.press('Enter');
    await closed();
    await row(page, 'renamed.txt').waitFor();
    assert.deepEqual(traffic.operations.at(-1), { cmd: 'MOVE', paths: [ROOT + '/notes.txt', ROOT + '/renamed.txt'] });

    // New folder validates the same way.
    await ready(page);
    await page.locator('.fx-commands').getByRole('button', { name: 'New folder', exact: true }).click();
    await field.fill('  ');
    await page.keyboard.press('Enter');
    await problem.waitFor();
    assert.equal(await problem.innerText(), 'Enter a name.');
    await field.fill('archive');
    await page.keyboard.press('Enter');
    assert.equal(await problem.innerText(), '“archive” already exists in this folder.');
    await page.keyboard.press('Escape');
    await closed();
    assert.equal(traffic.operations.length, 1, 'no folder was created');

    // Several items, one of them a folder.
    await row(page, 'archive').locator('.entry-name a').click();
    await row(page, 'photo.png').locator('.entry-name a').click({ modifiers: ['Control'] });
    await page.keyboard.press('Delete');
    await dialog.getByRole('heading', { name: `Delete 2 items from ${DEVICE}?`, exact: true }).waitFor();
    assert.equal(
        await dialog.locator('.fx-dialog-message').innerText(),
        'Folders are deleted with everything inside them. This cannot be undone.',
    );
    await page.keyboard.press('Escape');
    await closed();
    assert.equal((await selected()).length, 2);
    await finish();
}

// A folder that cannot be opened says so in the list, and results arrive as toasts.
async function errors(browser, layout, name) {
    const { page, finish, traffic } = await start(browser, layout, ROOT, 'light');
    const box = page.locator('.fx-failed-box');
    const toast = page.locator('.kit-toast:not([data-exiting])');
    const statusLine = () => page.locator('.fx-status').innerText();

    await open(page, 'denied');
    await box.waitFor();
    assert.equal(await page.locator('.file-explorer').getAttribute('data-listing'), 'error');
    assert.equal(await box.locator('strong').innerText(), 'This folder could not be opened');
    assert.equal(await box.locator('.fx-failed-reason').innerText(), 'Permission denied by fixture');
    assert.equal(await box.locator('.fx-failed-path').innerText(), ROOT + '/denied');
    assert.equal(await page.getByText('This folder is empty.').count(), 0, 'a failed folder is not called empty');
    assert.equal(await page.locator('.fx-row').count(), 0, 'no rows from the folder before');
    assert.equal(await statusLine(), '', 'the status line carries no error');
    assert.equal(await page.locator('.fx-counts').innerText(), '', 'and no item count for a folder that was not read');
    const frame = await page.locator('.tool-mount').boundingBox();
    const boxArea = await box.boundingBox();
    assert(boxArea.x >= frame.x && boxArea.x + boxArea.width <= frame.x + frame.width + 0.5, 'the message fits the list');
    await page.screenshot({ path: path.join(OUT, `flows-folder-error-${name}.png`) });
    // Retry asks the device again; Up leaves.
    const lists = () => traffic.requests.filter((item) => item.cmd === 'LIST' && item.destination === ROOT + '/denied').length;
    const before = lists();
    await box.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.file-explorer').dataset.listing === 'error');
    await box.waitFor();
    assert.equal(lists(), before + 1, 'Retry lists the folder again');
    await box.getByRole('button', { name: 'Up one folder', exact: true }).click();
    await crumb(page, 'tmp');
    await row(page, 'notes.txt').waitFor();

    // A mistyped path: the address bar shows what was asked for, not the folder before it.
    await page.getByRole('button', { name: 'Type a folder path', exact: true }).click();
    await page.locator('.fx-address-input').fill('/data/local/nope');
    await page.locator('.fx-address-input').press('Enter');
    await box.waitFor();
    assert.equal(await box.locator('.fx-failed-path').innerText(), '/data/local/nope');
    assert.equal((await page.locator('.fx-crumb').allInnerTexts()).join(' '), '/ data local nope');
    assert.equal(await page.locator('.fx-row').count(), 0);
    // Back returns to the folder that worked.
    await page.goBack();
    await crumb(page, 'tmp');
    await ready(page);

    // A result is a toast that names the item and stays after the folder is listed again.
    await pressAtRest(page, row(page, 'photo.png').locator('.fx-row-menu'));
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.locator('.fx-dialog[open] input[name="value"]').fill('picture.png');
    await page.locator('.fx-dialog[open]').getByRole('button', { name: 'Rename', exact: true }).click();
    await row(page, 'picture.png').waitFor();
    await ready(page);
    assert.equal(await toast.getAttribute('role'), 'status');
    assert.equal(await toast.locator('.kit-toast-message').innerText(), 'Renamed photo.png to picture.png.');
    assert.equal(await statusLine(), '', 'the status line keeps to counts');

    // A refusal names the item and gives the device's reason, in full.
    await pressAtRest(page, row(page, 'denied').locator('.fx-row-menu'));
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.locator('.fx-dialog[open] input[name="value"]').fill('allowed');
    await page.locator('.fx-dialog[open]').getByRole('button', { name: 'Rename', exact: true }).click();
    const failure = page.locator('.kit-toast[role="alert"]:not([data-exiting])');
    await failure.waitFor();
    await ready(page);
    await settleMotion(page);
    assert.equal(
        await failure.locator('.kit-toast-message').innerText(),
        'Could not rename “denied”: Operation not permitted by fixture',
    );
    const message = await failure.locator('.kit-toast-message').evaluate((el) => ({
        cut: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
        left: el.getBoundingClientRect().left,
        right: el.getBoundingClientRect().right,
    }));
    assert.equal(message.cut, false, 'the whole message is readable');
    assert(message.left >= 0 && message.right <= layout.width, 'the toast fits the screen');
    await page.screenshot({ path: path.join(OUT, `flows-operation-error-${name}.png`) });
    await failure.getByRole('button', { name: 'Dismiss message', exact: true }).click();
    await failure.waitFor({ state: 'detached' });
    await finish();
}

async function goTo(page, target) {
    await page.getByRole('button', { name: 'Type a folder path', exact: true }).click();
    await page.locator('.fx-address-input').fill(target);
    await page.locator('.fx-address-input').press('Enter');
    await crumb(page, path.posix.basename(target));
    await ready(page);
}
const pick = (page, ...list) =>
    page.locator('.file-explorer input[type=file]').setInputFiles(
        list.map(([name, text]) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })),
    );
const uploadsDone = (page) =>
    page.waitForFunction(
        () =>
            !document.querySelector('.file-listing-upload-progress') &&
            document.querySelector('.file-listing-client')?.dataset.listing === 'ready',
    );

// Shared storage ignores case in names, so a name that differs only by case is a conflict there.
async function nameCase(browser) {
    const { page, finish, traffic, files } = await start(browser, PHONE, SHARED);
    const dialog = page.locator('.fx-dialog[open]');
    const closed = () => page.locator('.fx-dialog').waitFor({ state: 'hidden' });
    await row(page, 'notes.txt').waitFor();

    await pick(page, ['Notes.txt', 'Capitalised']);
    await dialog.getByRole('heading', { name: `Replace “notes.txt” on ${DEVICE}?`, exact: true }).waitFor();
    assert(
        (await dialog.locator('.fx-dialog-message').innerText()).includes(
            'This storage treats “Notes.txt” and “notes.txt” as the same name.',
        ),
        'the dialog says why the two names collide',
    );
    await settleMotion(page);
    await page.screenshot({ path: path.join(OUT, 'flows-case-conflict.png') });
    assert.equal(traffic.starts.length, 0, 'nothing is sent before the answer');
    await dialog.getByRole('button', { name: 'Keep both', exact: true }).click();
    await closed();
    await row(page, 'Notes (1).txt').waitFor();
    assert.deepEqual(traffic.starts.at(-1), { path: SHARED + '/Notes (1).txt', overwrite: false });
    assert.equal(files.get(SHARED + '/notes.txt').toString(), 'Shared notes\n', 'the existing file is untouched');
    await uploadsDone(page);

    // Replace is still an explicit answer, and it replaces the file that holds the name.
    await pick(page, ['NOTES.TXT', 'Replacement']);
    await dialog.getByRole('heading', { name: `Replace “notes.txt” on ${DEVICE}?`, exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Replace', exact: true }).click();
    await closed();
    await uploadsDone(page);
    assert.deepEqual(traffic.starts.at(-1), { path: SHARED + '/NOTES.TXT', overwrite: true });
    assert.equal(files.has(SHARED + '/notes.txt'), false);
    assert.equal(files.get(SHARED + '/NOTES.TXT').toString(), 'Replacement');

    // Two spellings of one name in a single batch cannot both land.
    const startsBefore = traffic.starts.length;
    await pick(page, ['report.txt', 'First'], ['Report.TXT', 'Second']);
    await page.getByRole('alert').filter({ hasText: '“Report.TXT” was added more than once.' }).waitFor();
    await uploadsDone(page);
    assert.equal(traffic.starts.length, startsBefore + 1);
    assert.equal(files.get(SHARED + '/report.txt').toString(), 'First');

    // A new folder cannot take a name that differs from a folder here only by case.
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
    await dialog.locator('input[name="value"]').fill('camera');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    assert.equal(
        await dialog.locator('.fx-dialog-error').innerText(),
        'This storage treats “camera” and “Camera” as the same name.',
    );
    await page.keyboard.press('Escape');
    await closed();
    assert.equal(traffic.operations.length, 0);

    // Elsewhere on the device the two spellings are two files, and no question is asked.
    await goTo(page, ROOT);
    await pick(page, ['Notes.txt', 'A second file']);
    await row(page, 'Notes.txt').waitFor();
    await uploadsDone(page);
    assert.deepEqual(traffic.starts.at(-1), { path: ROOT + '/Notes.txt', overwrite: false });
    assert.equal(files.get(ROOT + '/notes.txt').toString(), 'Mock download contents\n');
    assert.equal(files.get(ROOT + '/Notes.txt').toString(), 'A second file');
    await finish();
}

// Selection on a phone: a bar with the selection's commands, a ⋮ that never retargets, and
// selection mode that ends with the action.
async function phoneSelection(browser, layout, name, scheme) {
    const { page, finish, traffic } = await start(browser, layout, ROOT, scheme);
    const bar = page.locator('.fx-selection-bar');
    const dialog = page.locator('.fx-dialog[open]');
    const closed = () => page.locator('.fx-dialog').waitFor({ state: 'hidden' });
    const selected = () => page.locator('.fx-row.selected').evaluateAll((rows) => rows.map((item) => item.dataset.name));
    const tap = (item) => row(page, item).locator('.entry-name a').click();
    assert.equal(await bar.isVisible(), false, 'no bar without a selection');

    // A tap on a file starts no download on a touch screen. It opens a sheet with the file's
    // facts and Download, Rename and Delete, and only Download there starts one.
    let downloads = 0;
    page.on('download', () => downloads++);
    await tap('notes.txt');
    await dialog.getByRole('heading', { name: 'notes.txt', exact: true }).waitFor();
    assert.deepEqual(await dialog.locator('.fx-file-actions .kit-button').allInnerTexts(), ['Download', 'Rename', 'Delete']);
    assert.match(await dialog.locator('.fx-dialog-message').innerText(), / · /, 'the size, the type and the date of the file');
    assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate((button) => button === document.activeElement), true, 'Cancel has the focus');
    await page.waitForTimeout(300);
    assert.equal(downloads, 0, 'the tap started no download');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await closed();
    assert.equal(downloads, 0, 'Cancel starts none');
    assert.equal(traffic.operations.length, 0);
    await tap('notes.txt');
    await dialog.getByRole('button', { name: 'Download', exact: true }).click();
    await closed();
    for (let attempt = 0; attempt < 100 && downloads === 0; attempt++) await page.waitForTimeout(50);
    assert.equal(downloads, 1, 'Download in the sheet starts the download');
    // Rename in the sheet is the row menu's Rename for this file.
    await tap('notes.txt');
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
    await dialog.locator('input[name="value"]').waitFor();
    assert.equal(await dialog.locator('input[name="value"]').inputValue(), 'notes.txt');
    await page.keyboard.press('Escape');
    await closed();
    assert.equal(traffic.operations.length, 0);
    assert.deepEqual(await selected(), [], 'the sheet selects nothing');

    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Select items', exact: true }).click();
    await tap('notes.txt');
    await tap('photo.png');
    assert.deepEqual(await selected(), ['notes.txt', 'photo.png']);
    await bar.waitFor();
    assert.equal(await page.locator('.fx-history').isVisible(), false, 'the bar takes the history row');
    assert.equal(await bar.locator('.fx-selection-count').textContent(), '2 selected');
    // A narrow phone shows the number alone; the word is still read out.
    const word = await bar.locator('.fx-selection-word').boundingBox();
    assert.equal(word.width <= 1, name === 'phone320', `the word "selected" at ${layout.width}px`);
    const commands = ['Close selection', 'Download selected files', 'Copy selected items', 'Move selected items', 'Delete selected items'];
    const actions = page.getByRole('button', { name: 'Actions', exact: true });
    for (const label of commands) {
        const button = bar.getByRole('button', { name: label, exact: true });
        assert.equal(await button.isEnabled(), true, `${label} is enabled`);
        const box = await button.boundingBox();
        assert(box.width >= 44 && box.height >= 44, `${label} is a touch target`);
        assert(box.x >= 0 && box.x + box.width <= layout.width, `${label} is on screen`);
    }
    const more = await actions.boundingBox();
    assert(more.x + more.width <= layout.width, 'the Actions menu stays reachable');
    assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        'the bar does not widen the page',
    );
    await settleMotion(page);
    await page.screenshot({ path: path.join(OUT, `flows-selection-bar-${name}.png`) });

    // A ⋮ on a row that is not selected acts on that row and leaves the selection alone.
    await pressAtRest(page, row(page, 'archive').locator('.fx-row-menu'));
    await page.locator('.files-menu').waitFor();
    assert.equal(await page.locator('.fx-row.fx-row-menu-open').getAttribute('data-name'), 'archive');
    assert.deepEqual(await selected(), ['notes.txt', 'photo.png'], 'the menu keeps the selection');
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await dialog.getByRole('heading', { name: `Delete “archive” from ${DEVICE}?`, exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await closed();
    assert.deepEqual(await selected(), ['notes.txt', 'photo.png']);
    assert.equal(traffic.operations.length, 0);

    // The bar's Delete acts on the selection, and the action ends selection mode.
    await bar.getByRole('button', { name: 'Delete selected items', exact: true }).click();
    await dialog.getByRole('heading', { name: `Delete 2 items from ${DEVICE}?`, exact: true }).waitFor();
    await settleMotion(page);
    await page.waitForTimeout(500);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await closed();
    await row(page, 'notes.txt').waitFor({ state: 'detached' });
    await ready(page);
    assert.deepEqual(traffic.operations.at(-1), { cmd: 'DELE', paths: [ROOT + '/notes.txt', ROOT + '/photo.png'] });
    await page.locator('.file-explorer:not(.fx-selecting)').waitFor();
    assert.equal(await bar.isVisible(), false);
    assert.equal(await page.locator('.fx-history').isVisible(), true, 'history is back');
    assert.equal(await page.locator('.fx-check').first().isVisible(), false, 'no checkboxes');
    await tap('archive');
    await crumb(page, 'archive');
    await ready(page);
    await page.getByRole('button', { name: 'Up one folder', exact: true }).click();
    await crumb(page, 'tmp');
    await ready(page);

    // Copy from the bar ends selection mode too; Close ends it without doing anything.
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
    await bar.waitFor();
    await tap('archive');
    assert.equal((await selected()).includes('archive'), false, 'after Select all a tap toggles, it does not open');
    await bar.getByRole('button', { name: 'Copy selected items', exact: true }).click();
    await page.locator('.kit-toast .kit-toast-message').filter({ hasText: 'ready to paste.' }).waitFor();
    await page.locator('.file-explorer:not(.fx-selecting)').waitFor();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Select items', exact: true }).click();
    await bar.waitFor();
    assert.equal(await bar.getByRole('button', { name: 'Delete selected items', exact: true }).isDisabled(), true);
    await bar.getByRole('button', { name: 'Close selection', exact: true }).click();
    await page.locator('.file-explorer:not(.fx-selecting)').waitFor();

    // A folder change ends selection mode: browser Back lands in a folder where taps open.
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Select items', exact: true }).click();
    await bar.waitFor();
    await page.goBack();
    await crumb(page, 'archive');
    await ready(page);
    await page.locator('.file-explorer:not(.fx-selecting)').waitFor();
    assert.equal(await bar.isVisible(), false, 'no bar in the folder Back leads to');
    assert.equal(await page.locator('.fx-history').isVisible(), true, 'history is back after a folder change');
    await page.getByRole('button', { name: 'Up one folder', exact: true }).click();
    await crumb(page, 'tmp');
    await ready(page);
    await tap('archive');
    await crumb(page, 'archive');
    await ready(page);
    assert.equal(traffic.operations.length, 1, 'Copy, Close and a folder change send nothing to the device');
    await finish();
}

async function until(page, check, what) {
    for (let attempt = 0; attempt < 250; attempt++) {
        if (check()) return;
        await page.waitForTimeout(20);
    }
    assert.fail(`Timed out waiting for ${what}`);
}

// Uploads: two at a time, the rest wait; each can be cancelled; leaving asks first.
async function uploads(browser, layout, name, scheme) {
    const { page, finish, traffic, files } = await start(browser, layout, undefined, scheme);
    const card = page.locator('.device').filter({ hasText: 'Files test phone' });
    await card.getByRole('link', { name: 'Files on Fixture Files test phone', exact: true }).click();
    await ready(page);
    await row(page, 'notes.txt').waitFor();
    const rows = page.locator('.file-listing-upload-progress');
    const rowFor = (file) => rows.filter({ has: page.locator('.fx-upload-name', { hasText: file }) });
    const summary = page.locator('.fx-transfer-total');
    const toastText = page.locator('.kit-toast:not([data-exiting]) .kit-toast-message');

    traffic.holdAppends = true;
    const size = 1024 * 1024;
    await page.locator('.file-explorer input[type=file]').setInputFiles(
        [1, 2, 3, 4, 5, 6].map((index) => ({
            name: `clip-${index}.bin`,
            mimeType: 'application/octet-stream',
            buffer: Buffer.alloc(size, index),
        })),
    );
    await rows.nth(5).waitFor();
    await until(page, () => traffic.sending.size === 2, 'two uploads to start');
    await until(page, () => traffic.heldAppends.length > 2, 'several chunks in flight');
    assert.equal(await rows.filter({ hasText: 'Waiting' }).count(), 4, 'the other four wait their turn');
    assert.equal(await summary.innerText(), 'Uploading 1 of 6, 0%');
    assert.equal(traffic.starts.length, 2, 'a waiting upload has not started');
    // Each upload shows its name, a bar, how much of how much is sent, and Cancel.
    const first = rowFor('clip-1.bin');
    const bar = first.getByRole('progressbar', { name: 'Upload of clip-1.bin', exact: true });
    assert.equal(await bar.getAttribute('aria-valuenow'), '0');
    assert.equal(await bar.getAttribute('aria-valuetext'), '0 B of 1.0 MB');
    assert.equal(await first.getByRole('button', { name: 'Cancel the upload of clip-1.bin', exact: true }).isVisible(), true);
    // The phone takes a few chunks: the bar and the bytes move.
    traffic.heldAppends.splice(0, 6).forEach((release) => release());
    const moving = rows.filter({ has: page.locator('.fx-upload-state', { hasText: /^[\d.]+ KB of 1\.0 MB$/ }) }).first();
    await moving.waitFor();
    const state = await moving.locator('.fx-upload-state').innerText();
    const percent = Number(await moving.getByRole('progressbar').getAttribute('aria-valuenow'));
    assert(percent > 0 && percent < 100, `${state}: ${percent}%`);
    assert.equal(await moving.getByRole('progressbar').getAttribute('aria-valuetext'), state);
    const filled = await moving.locator('.fx-upload-bar').evaluate((track) => {
        const fill = track.firstElementChild.getBoundingClientRect();
        return fill.width / track.getBoundingClientRect().width;
    });
    assert(Math.abs(filled - percent / 100) < 0.02, `the bar is ${Math.round(filled * 100)}% full at ${percent}%`);
    await settleMotion(page);
    await page.screenshot({ path: path.join(OUT, `flows-uploads-${name}.png`) });

    // A waiting upload is cancelled before it starts; a running one is cancelled on the device.
    await rowFor('clip-5.bin').getByRole('button', { name: 'Cancel the upload of clip-5.bin', exact: true }).click();
    await rowFor('clip-5.bin').waitFor({ state: 'detached' });
    await rowFor('clip-1.bin').getByRole('button', { name: 'Cancel the upload of clip-1.bin', exact: true }).click();
    await rowFor('clip-1.bin').waitFor({ state: 'detached' });
    await until(page, () => traffic.cancels.includes(ROOT + '/clip-1.bin'), 'the CANCEL');
    await until(page, () => traffic.sending.size === 2, 'the next upload to take the free place');
    // The owner browses meanwhile: another folder opens, a folder operation runs there, and the
    // uploads go on to the folder they started in.
    await open(page, 'archive');
    await crumb(page, 'archive');
    await ready(page);
    assert.equal(await rows.count(), 4, 'the uploads go on behind the other folder');
    const newFolder = page.locator('.fx-commands').getByRole('button', { name: 'New folder', exact: true });
    if (await newFolder.isVisible()) await pressAtRest(page, newFolder);
    else {
        await page.getByRole('button', { name: 'Actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
    }
    await page.locator('.fx-dialog input[name="value"]').fill('during-upload');
    await page.locator('.fx-dialog[open]').getByRole('button', { name: 'Create', exact: true }).click();
    await row(page, 'during-upload').waitFor();
    assert.deepEqual(traffic.operations.at(-1), { cmd: 'MKDR', paths: [ROOT + '/archive/during-upload'] });
    await ready(page);
    traffic.holdAppends = false;
    traffic.releaseAppends();
    await toastText.filter({ hasText: 'Uploaded 4 files. Cancelled 2 uploads.' }).waitFor();
    await ready(page);
    await crumb(page, 'archive');
    assert.equal([...files.keys()].some((file) => file.startsWith(ROOT + '/archive/clip-')), false, 'nothing went to the folder shown');
    assert.equal(await row(page, 'clip-2.bin').count(), 0);
    // Back to the folder the files went to, by the browser's Back: the history of the page is
    // as it was, for the questions below.
    await page.goBack();
    await crumb(page, 'tmp');
    await ready(page);
    await row(page, 'clip-2.bin').waitFor();
    assert.equal(traffic.mostSending, 2, 'never more than two at once');
    for (const index of [2, 3, 4, 6]) assert.equal(files.get(`${ROOT}/clip-${index}.bin`)?.length, size);
    assert.equal(files.has(ROOT + '/clip-1.bin'), false, 'a cancelled upload saves nothing');
    assert.equal(traffic.starts.some((start) => start.path.endsWith('/clip-5.bin')), false);
    assert.equal(await page.locator('.fx-transfers').isVisible(), false);
    assert.equal(
        await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))),
        false,
        'with nothing uploading, closing the page does not ask',
    );

    // Leaving while a file uploads asks first. Keep uploading stays, whatever the way out.
    traffic.holdAppends = true;
    await page.locator('.file-explorer input[type=file]').setInputFiles({
        name: 'leave.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(size, 9),
    });
    await rowFor('leave.bin').waitFor();
    await until(page, () => traffic.heldAppends.length > 0, 'the upload to send');
    assert.equal(
        await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))),
        true,
        'closing the page asks first',
    );
    const leave = page.locator('.fx-dialog[open]');
    const question = leave.getByRole('heading', { name: `Stop the upload to ${DEVICE}?`, exact: true });
    const files0 = await page.evaluate(() => location.hash);
    // The question asked after the browser's Back opens with no press since that step, so it
    // has no history entry of its own (Chrome would skip one, and the page with it). A second
    // Back with it open is then refused like the first: the tab returns to Files and the
    // question stays. Asked after the Phones button, a press, it has an entry.
    for (const way of ['browser Back', 'browser Back twice', 'Phones button']) {
        if (way.startsWith('browser Back')) await page.goBack();
        if (way === 'Phones button') await page.getByRole('button', { name: 'Phones', exact: true }).click();
        await question.waitFor();
        assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Keep uploading');
        assert.equal(
            await leave.locator('.fx-dialog-message').innerText(),
            'Leaving this phone stops the upload, and the file is not saved on it.',
        );
        await settleMotion(page);
        if (way === 'browser Back') await page.screenshot({ path: path.join(OUT, `flows-leave-${name}.png`) });
        if (way === 'browser Back twice') {
            await page.goBack();
            await page.waitForFunction((hash) => location.hash === hash, files0);
            await page.waitForTimeout(300);
            assert.equal(await question.count(), 1, `${way}: the question is still open`);
        }
        if (way === 'Phones button') {
            assert.equal(await page.evaluate(() => history.state?.nav?.overlay), 1, `${way}: the question has an entry`);
        }
        await leave.getByRole('button', { name: 'Keep uploading', exact: true }).click();
        await page.locator('.fx-dialog').waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => location.hash), files0, `${way}: the address is still Files`);
        assert.equal(await page.locator('.file-listing-client').count(), 1, `${way}: Files stays open`);
        assert.equal(await page.locator('.file-explorer').count(), 1, `${way}: the dialog is back inside the explorer`);
        assert.equal(await rowFor('leave.bin').count(), 1, `${way}: the upload goes on`);
    }
    assert.equal(traffic.cancels.length, 1, 'nothing more was cancelled');

    // Stop and leave cancels the upload and goes where the owner asked.
    await page.goBack();
    await question.waitFor();
    await page.waitForTimeout(550);
    await leave.getByRole('button', { name: 'Stop and leave', exact: true }).click();
    await page.locator('.file-listing-client').waitFor({ state: 'detached' });
    await card.waitFor();
    await until(page, () => traffic.cancels.includes(ROOT + '/leave.bin'), 'the CANCEL');
    assert.equal(files.has(ROOT + '/leave.bin'), false);
    // The device list is not guarded: the next navigation goes straight through.
    const filesLink = card.getByRole('link', { name: 'Files on Fixture Files test phone', exact: true });
    await filesLink.click();
    await ready(page);
    await page.getByRole('button', { name: 'Phones', exact: true }).click();
    await card.waitFor();

    // Another tab of the same phone is not leaving it, so nothing is asked, and the upload goes
    // on behind that tab.
    await filesLink.click();
    await ready(page);
    await page.locator('.file-explorer input[type=file]').setInputFiles({
        name: 'stay.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(size, 7),
    });
    await rowFor('stay.bin').waitFor();
    const tabButton = (name) => page.locator('.kit-tabs-list').getByRole('button', { name, exact: true });
    await tabButton('Shell').click();
    await page.waitForFunction((udid) => location.hash === `#!action=device&udid=${udid}&view=shell`, UDID);
    assert.equal(await page.locator('.fx-dialog[open]').count(), 0, 'a change of view on the same phone asks nothing');
    assert.equal(await page.locator('.file-explorer').isVisible(), false, 'Files is hidden behind Shell');
    // Leaving the phone from the Shell tab asks, with the question on top of the Shell tab.
    await page.getByRole('button', { name: 'Phones', exact: true }).click();
    await question.waitFor();
    assert.equal(await question.isVisible(), true, 'the question of a hidden Files is shown');
    await leave.getByRole('button', { name: 'Keep uploading', exact: true }).click();
    await page.locator('.fx-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => location.hash), `#!action=device&udid=${UDID}&view=shell`, 'Keep uploading stays on Shell');
    // Back on Files: the same explorer, the upload still running, and the folder in the address.
    await tabButton('Files').click();
    await page.waitForFunction(
        (expected) => location.hash === expected,
        `#!action=device&udid=${UDID}&view=files&path=${encodeURIComponent(ROOT)}`,
    );
    assert.equal(await rowFor('stay.bin').count(), 1, 'the upload went on behind the Shell tab');
    assert.equal(traffic.cancels.includes(ROOT + '/stay.bin'), false);
    traffic.holdAppends = false;
    traffic.releaseAppends();
    await rowFor('stay.bin').waitFor({ state: 'detached' });
    await until(page, () => files.get(ROOT + '/stay.bin')?.length === size, 'the upload to finish');
    await finish();
}

async function fillFilter(page, text) {
    const input = page.locator('.fx-filter-input');
    if (!(await input.isVisible())) await page.getByRole('button', { name: 'Filter this folder', exact: true }).click();
    await input.fill(text);
}
/** The View menu: the toolbar's on a desktop, inside Actions on a phone. */
async function openViewMenu(page) {
    const view = page.locator('.fx-commands').getByRole('button', { name: 'View', exact: true });
    if (await view.isVisible()) await pressAtRest(page, view);
    else {
        await page.getByRole('button', { name: 'Actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'View options…', exact: true }).click();
    }
    await page.locator('.files-menu [data-menu="view"]').first().waitFor();
}

// A folder of 5,000 items. Its rows are added in batches at most every 250 ms while it arrives,
// typing in the filter shows and hides rows without building them again, and the keyboard and
// the selection still work. Every task of the page that took 50 ms or more is reported.
async function largeFolder(browser, layout, name) {
    const { page, finish } = await start(browser, layout, ROOT);
    await page.evaluate(() => {
        window.__longTasks = [];
        new PerformanceObserver((list) => list.getEntries().forEach((entry) => window.__longTasks.push(Math.round(entry.duration)))).observe({ type: 'longtask' });
        // Each time the rows are put in order the item count is written. Only the rows near the
        // view are in the document, so new rows are not a sign of it.
        window.__batches = [];
        const counts = document.querySelector('.fx-counts');
        new MutationObserver(() => {
            const text = counts.textContent;
            if (text !== window.__batches.at(-1)?.text) window.__batches.push({ at: performance.now(), text });
        }).observe(counts, { childList: true, characterData: true, subtree: true });
    });
    const tasks = [];
    const longTasks = async (what) => {
        const found = await page.evaluate(() => window.__longTasks.splice(0));
        console.log(`  ${name}, ${what}: tasks of 50 ms or more: ${found.length ? found.join(', ') + ' ms' : 'none'}`);
        tasks.push(...found);
    };
    const shown = () => page.evaluate(() => [...document.querySelectorAll('.fx-row')].map((row) => row.dataset.name));
    const rowsAndSpacers = () =>
        page.evaluate(() => {
            const rows = document.querySelectorAll('.fx-row').length;
            const spacers = [...document.querySelectorAll('.fx-spacer')].reduce((total, spacer) => total + spacer.getBoundingClientRect().height, 0);
            const row = document.querySelector('.fx-row').getBoundingClientRect().height;
            return { rows, spacers, row };
        });
    const started = Date.now();
    await goTo(page, HUGE);
    const listed = Date.now() - started;
    assert.equal(await page.locator('.fx-counts').innerText(), `${HUGE_COUNT} items`);
    // The renders while the items arrive, in bursts over about half a second. The one when the
    // listing ends comes at once.
    const batches = (await page.evaluate(() => window.__batches.splice(0))).filter(({ text }) => {
        const count = Number(/^(\d+) items/.exec(text)?.[1]);
        return count >= HUGE_COUNT / 10 && count < HUGE_COUNT;
    });
    const gaps = batches.slice(1).map(({ at }, index) => Math.round(at - batches[index].at));
    console.log(`  ${name}: listed in ${listed} ms, ${batches.map(({ text }) => text).join(', ')} while it arrived${gaps.length ? `, ${gaps.join(', ')} ms apart` : ''}`);
    assert(batches.length >= 2, 'the rows are put in order more than once while the items arrive');
    // The count is seen once a render's work is done, and renders differ in length; one each
    // frame would be 16 to 60 ms apart.
    assert(gaps.every((gap) => gap >= 200), `rows are added at most every 250 ms: ${gaps.join(', ')}`);
    // Only the rows near the view are in the document; the spacers keep the list as tall as all of them.
    const first = await rowsAndSpacers();
    assert(first.rows < 200, `${first.rows} rows in the document for ${HUGE_COUNT} items`);
    assert.deepEqual((await shown()).slice(0, 2), ['IMG_0000.jpg', 'IMG_0001.jpg']);
    await longTasks('listing');

    // Scrolling to the end brings the last rows; the list kept its height on the way.
    const items = page.locator('.fx-items');
    const height = await items.evaluate((element) => element.scrollHeight);
    await items.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await page.waitForFunction(() => [...document.querySelectorAll('.fx-row')].some((row) => row.dataset.name === 'IMG_4999.jpg'));
    assert.equal(await items.evaluate((element) => element.scrollHeight), height, 'the list keeps its height');
    const last = await row(page, 'IMG_4999.jpg').boundingBox();
    const box = await items.boundingBox();
    assert(last.y + last.height <= box.y + box.height + 1 && last.y >= box.y, 'the last row is in view at the end');
    await items.evaluate((element) => element.scrollTo(0, 0));
    await page.waitForFunction(() => document.querySelector('.fx-row')?.dataset.name === 'IMG_0000.jpg');
    await longTasks('scroll');

    // Typing in the filter: the rows that stay are the rows from before.
    await page.evaluate(() => document.querySelectorAll('.fx-row').forEach((row) => (row.__kept = true)));
    const before = await shown();
    await fillFilter(page, 'IMG_00');
    await page.waitForFunction(() => document.querySelectorAll('.fx-row').length === 100);
    assert.equal(await page.locator('.fx-counts').innerText(), `100 of ${HUGE_COUNT} items`);
    const kept = await page.evaluate(() => [...document.querySelectorAll('.fx-row')].map((row) => [row.dataset.name, !!row.__kept]));
    assert.deepEqual(
        kept.filter(([name]) => before.includes(name)).filter(([, same]) => !same),
        [],
        'a row that stays is the row from before',
    );
    await fillFilter(page, '');
    await page.waitForFunction((count) => document.querySelector('.fx-counts').textContent === `${count} items`, HUGE_COUNT);
    assert.equal(
        await page.evaluate((names) => names.every((name) => document.querySelector(`.fx-row[data-name="${name}"]`)?.__kept), before.slice(0, 20)),
        true,
        'and so does clearing the filter',
    );
    await longTasks('filter');

    // The keyboard walks the whole list and the selection follows.
    if (!layout.touch) {
        await row(page, 'IMG_0000.jpg').locator('.entry-name a').click();
        await page.keyboard.press('End');
        await page.waitForFunction(() => document.activeElement?.closest('tr')?.dataset.name === 'IMG_4999.jpg');
        // Space selects the row the keys are on; Shift with an arrow extends from it.
        await page.keyboard.press('Space');
        await page.keyboard.press('Shift+ArrowUp');
        await page.keyboard.press('Shift+ArrowUp');
        await page.waitForFunction(() => document.querySelectorAll('.fx-row.selected').length === 3);
        assert.equal(await page.evaluate(() => document.activeElement?.closest('tr')?.dataset.name), 'IMG_4997.jpg');
        assert((await page.locator('.fx-counts').innerText()).includes('3 selected'));
        await page.keyboard.press('Home');
        await page.waitForFunction(() => document.activeElement?.closest('tr')?.dataset.name === 'IMG_0000.jpg');
        await page.keyboard.press('Control+a');
        await page.waitForFunction((count) => document.querySelector('.fx-counts').textContent.includes(`${count} selected`), HUGE_COUNT);
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('.fx-row')].every((row) => row.classList.contains('selected'))), true);
        // Rows that come into view show the selection too.
        await items.evaluate((element) => element.scrollTo(0, element.scrollHeight / 2));
        await page.waitForFunction(() => !document.querySelector('.fx-row[data-name="IMG_0000.jpg"]'));
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('.fx-row')].every((row) => row.classList.contains('selected'))), true);
        // Focus stays in the list while its row is out of the document, and the keys go on from it.
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction(() => document.activeElement?.closest('tr')?.dataset.name === 'IMG_0001.jpg');
        await page.locator('.fx-items').press('Escape');
        await page.waitForFunction((count) => !document.querySelector('.fx-counts').textContent.includes('selected'), HUGE_COUNT);
        await longTasks('keyboard and selection');
    } else {
        // A long press selects; Select all selects every item, also the rows not in the document.
        await page.getByRole('button', { name: 'Actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
        await page.waitForFunction((count) => document.querySelector('.fx-counts').textContent.includes(`${count} selected`), HUGE_COUNT);
        await items.evaluate((element) => element.scrollTo(0, element.scrollHeight / 2));
        await page.waitForFunction(() => !document.querySelector('.fx-row[data-name="IMG_0000.jpg"]'));
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('.fx-row')].every((row) => row.classList.contains('selected'))), true);
        await page.locator('.fx-selection-bar').getByRole('button', { name: 'Close selection', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.fx-row.selected'));
        await longTasks('selection');
    }

    // A new order moves the rows near the view.
    await items.evaluate((element) => element.scrollTo(0, 0));
    await openViewMenu(page);
    await page.locator('.files-menu').getByRole('menuitemradio', { name: 'Descending', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.fx-row')?.dataset.name === 'IMG_4999.jpg');
    await openViewMenu(page);
    await page.locator('.files-menu').getByRole('menuitemradio', { name: 'Tiles', exact: true }).click();
    await page.locator('.files-menu').getByRole('menuitemradio', { name: 'Ascending', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.fx-row')?.dataset.name === 'IMG_0000.jpg');
    // Tiles lie several to a line; the window follows them.
    const tiles = await rowsAndSpacers();
    assert(tiles.rows < 400, `${tiles.rows} tiles in the document`);
    await items.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await page.waitForFunction(() => [...document.querySelectorAll('.fx-row')].some((row) => row.dataset.name === 'IMG_4999.jpg'));
    await items.evaluate((element) => element.scrollTo(0, 0));
    await openViewMenu(page);
    await page.locator('.files-menu').getByRole('menuitemradio', { name: 'Details', exact: true }).click();
    await page.keyboard.press('Escape');
    await longTasks('order and tiles');
    console.log(`  ${name}: longest task ${tasks.length ? Math.max(...tasks) : 0} ms`);
    assert(tasks.every((duration) => duration < 200), `no task near 200 ms or more: ${tasks.join(', ')}`);
    await finish();
}

/**
 * A finger on `target` for `ms`, sent as touch events so the page sees a touch pointer. `move`
 * drags it up that far first, as a scroll does. `click` makes sure one click follows when the
 * finger lifts, as it may on a phone: Chromium sends one after a long hold, and if it sends
 * none, this does.
 */
async function touchHold(page, target, ms, { move = 0, click = false } = {}) {
    const box = await target.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.evaluate(() => {
        if (window.__holdClicks === undefined) document.addEventListener('click', () => window.__holdClicks++, { capture: true });
        window.__holdClicks = 0;
    });
    const cdp = await page.context().newCDPSession(page);
    try {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let step = 1; move && step <= 6; step++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - (move * step) / 6 }] });
        }
        await page.waitForTimeout(ms);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(50);
        if (click && !(await page.evaluate(() => window.__holdClicks))) {
            await target.evaluate((element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
        }
    } finally {
        await cdp.detach();
    }
}

// Holding a row on a touch screen selects it and turns selection mode on. No menu shows, ours or
// the browser's: on touch the name is a link without an address that cannot be dragged, and the
// row takes no text selection and no callout. The iOS menu itself needs a phone to see.
async function hold(browser) {
    const { page, finish, traffic } = await start(browser, PHONE, ROOT, 'light');
    const name = (item) => row(page, item).locator('.entry-name a');
    const bar = page.locator('.fx-selection-bar');
    const selected = () => page.locator('.fx-row.selected').evaluateAll((rows) => rows.map((item) => item.dataset.name));
    const endSelection = async () => {
        await bar.getByRole('button', { name: 'Close selection', exact: true }).click();
        await page.locator('.file-explorer:not(.fx-selecting)').waitFor();
    };
    let downloads = 0;
    page.on('download', () => downloads++);

    // The name: still a link with its name for assistive technology, with no address and no drag.
    assert.equal(await page.getByRole('link', { name: 'Download notes.txt', exact: true }).count(), 1, 'the name keeps its role and name');
    assert.equal(await name('notes.txt').getAttribute('href'), null, 'on touch a file name has no address');
    assert.equal(await name('archive').getAttribute('href'), null, 'on touch a folder name has no address');
    assert.equal(await name('notes.txt').evaluate((link) => link.draggable), false, 'the name cannot be dragged');
    const styles = await row(page, 'notes.txt').evaluate((item) =>
        [item, item.querySelector('.entry-name a'), item.querySelector('.fx-name'), item.querySelector('.entry-size')].map((element) => {
            const style = getComputedStyle(element);
            return { select: style.userSelect || style.webkitUserSelect, callout: style.webkitTouchCallout || null };
        }),
    );
    for (const style of styles) {
        assert.equal(style.select, 'none', 'the row and what is in it take no text selection');
        // Chromium does not report the callout; WebKit does. The stylesheet itself is read in test-files.js.
        if (style.callout) assert.equal(style.callout, 'none', 'and bring up no callout');
    }

    // A hold of 600ms on a file selects it. Letting go opens no sheet, menu or download.
    const hash = await page.evaluate(() => location.hash);
    await page.evaluate(() => {
        window.__cancels = 0;
        document.addEventListener('pointercancel', () => window.__cancels++, true);
    });
    await touchHold(page, name('notes.txt'), 600, { click: true });
    await page.locator('.file-explorer.fx-selecting').waitFor();
    assert.equal(await page.evaluate(() => window.__cancels), 0, 'nothing cancelled the finger held still');
    await page.waitForTimeout(300);
    assert.deepEqual(await selected(), ['notes.txt'], 'the hold selected the file');
    assert.equal(await bar.isVisible(), true, 'and turned selection mode on');
    assert.equal(await page.locator('.fx-dialog[open]').count(), 0, 'letting go opened no sheet');
    assert.equal(await page.locator('.files-menu:not([hidden])').count(), 0, 'and no menu');
    assert.equal(downloads, 0, 'and started no download');
    assert.equal(await page.evaluate(() => location.hash), hash);
    // Selection mode is on: a tap adds a row. (A tap within 600ms of the hold is dropped.)
    await page.waitForTimeout(400);
    await name('photo.png').click();
    assert.deepEqual(await selected(), ['notes.txt', 'photo.png'], 'a tap after the hold adds a row');
    await endSelection();

    // A folder: held, it is selected and not opened.
    await touchHold(page, name('archive'), 600, { click: true });
    await page.locator('.file-explorer.fx-selecting').waitFor();
    await page.waitForTimeout(300);
    assert.deepEqual(await selected(), ['archive'], 'the hold selected the folder');
    assert.equal(await page.locator('.fx-crumb[aria-current="page"]').innerText(), 'tmp', 'and did not open it');
    assert.equal(await page.evaluate(() => location.hash), hash);
    await endSelection();

    // A long hold, then the click that may follow when the finger lifts: the click is dropped,
    // so the row stays selected and nothing opens.
    await touchHold(page, name('notes.txt'), 1200, { click: true });
    await page.locator('.file-explorer.fx-selecting').waitFor();
    await page.waitForTimeout(300);
    assert.deepEqual(await selected(), ['notes.txt'], 'the click after a long hold does not undo it');
    assert.equal(await page.locator('.fx-dialog[open]').count(), 0, 'and opens no sheet');
    await endSelection();

    // A finger that scrolls the list is no hold.
    await touchHold(page, name('notes.txt'), 600, { move: 120 });
    await page.waitForTimeout(300);
    assert.deepEqual(await selected(), [], 'a scroll selects nothing');
    assert.equal(await page.locator('.file-explorer.fx-selecting').count(), 0);

    // A keyboard or assistive technology still opens the name: Enter on a folder opens it.
    await name('archive').focus();
    await page.keyboard.press('Enter');
    await crumb(page, 'archive');
    await ready(page);
    assert.equal(downloads, 0);
    assert.equal(traffic.operations.length, 0, 'nothing was sent to the phone');
    await page.screenshot({ path: path.join(OUT, 'flows-hold-phone.png') });
    await finish();

    // A mouse keeps the links as they were: an address, and a drag of its own.
    const desktop = await start(browser, DESKTOP, ROOT, 'dark');
    const link = row(desktop.page, 'archive').locator('.entry-name a');
    assert.equal(await link.getAttribute('href'), new URL(address(ROOT + '/archive'), BASE).toString(), 'a mouse keeps the address');
    assert.equal(await link.evaluate((element) => element.draggable), true, 'and the drag');
    await desktop.finish();
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const only = process.env.FX_ONLY;
    const scenarios = [
        ['history desktop', () => history(browser, DESKTOP)],
        ['history phone', () => history(browser, PHONE)],
        ['Back closes menus and dialogs desktop', () => overlays(browser, DESKTOP)],
        ['Back closes menus and dialogs phone', () => overlays(browser, PHONE)],
        ['menus on short screens', () => menus(browser)],
        ['keyboard focus', () => keyboardFocus(browser)],
        ['columns', () => columns(browser)],
        ['dialogs', () => dialogs(browser)],
        ['names that differ by case', () => nameCase(browser)],
        ['errors phone', () => errors(browser, PHONE, 'phone')],
        ['errors desktop', () => errors(browser, DESKTOP, 'desktop')],
        ['selection on a phone', () => phoneSelection(browser, PHONE, 'phone', 'light')],
        ['selection on a small phone', () => phoneSelection(browser, { width: 320, height: 640, touch: true }, 'phone320', 'dark')],
        ['hold on a phone', () => hold(browser)],
        ['uploads phone', () => uploads(browser, PHONE, 'phone', 'light')],
        ['uploads desktop', () => uploads(browser, DESKTOP, 'desktop', 'dark')],
        ['large folder phone', () => largeFolder(browser, PHONE, 'phone')],
        ['large folder desktop', () => largeFolder(browser, DESKTOP, 'desktop')],
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
