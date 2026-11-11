// E2E_OUT=/tmp/ws-scrcpy-files node scripts/test-browser.js files-kit
// Files on the design kit, at 390x844 (touch) and 1280x800 (mouse) in both themes. Every socket
// is answered by the fixture in e2e-files.js; no phone is touched.
//   controls  every button is the kit's button, icon button or menu item, at 44px, and at 32px
//             for the compact size under a mouse; every icon is one of the kit's set
//   type      every font size is 12, 13, 15, 17, 20 or 24, and 16 in a field
//   colours   every colour and radius is a role token; text is 4.5:1 on what is behind it and
//             the edge of a field is 3:1
//   dialog    New folder, Rename, Delete, Properties and the name conflict are the kit's sheet
//             on a native dialog: a bottom sheet below 600px, a dialog from there. Back, Escape,
//             the backdrop, the close button and a drag close it, and a second conflict
//             question keeps the first one's history entry
//   menus     the menus are the kit's menu in the top layer, with the arrow keys, Home, End,
//             Escape and Back; a check item shows the kit's check and leaves the menu open
//   toast     results are the kit's toast
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { settleMotion } = require('./ui-motion');
const { fixture, pressAtRest, DEVICE } = require('./e2e-files');

// Only through test-browser.js, which serves the build on a port of its own.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js files-kit');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-files';
const UDID = 'files-fixture';
const ROOT = '/data/local/tmp';
const LAYOUTS = [
    { name: 'phone', width: 390, height: 844, mobile: true },
    { name: 'desktop', width: 1280, height: 800, mobile: false },
];
const THEMES = ['light', 'dark'];
// The role tokens that are colours. Files may show no other colour.
const COLOUR_TOKENS = [
    'surface', 'surface-raised', 'surface-sunken', 'surface-inverse', 'border', 'border-strong', 'text', 'text-muted',
    'accent', 'accent-text', 'accent-soft', 'accent-pressed', 'on-accent', 'on-inverse', 'danger-text', 'danger-fill',
    'success-text', 'success-fill', 'warning-text', 'warning-fill', 'info-text', 'info-fill', 'neutral-text', 'neutral-fill',
    'scrim',
];

/** Everything that can be read off the explorer at rest, as a list of faults. Runs in the page. */
function audit({ mobile, tokens }) {
    const faults = [];
    const root = document.querySelector('.file-explorer');
    const name = (element) => {
        const text = (element.getAttribute('aria-label') || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        return `${element.tagName.toLowerCase()}.${String(element.getAttribute('class') || '').split(' ').join('.')} "${text}"`;
    };
    const probe = document.createElement('span');
    // With motion reduced every property still has a transition, of 0.01ms. Not this one.
    probe.style.transition = 'none';
    root.append(probe);
    const resolved = {};
    for (const token of tokens) {
        probe.style.color = `var(--${token})`;
        resolved[token] = getComputedStyle(probe).color;
    }
    probe.remove();
    const allowed = new Set(Object.values(resolved));
    const parse = (colour) => {
        const match = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(colour);
        return match ? { r: +match[1], g: +match[2], b: +match[3], a: match[4] === undefined ? 1 : +match[4] } : undefined;
    };
    const luminance = ({ r, g, b }) => {
        const channel = (value) => (value / 255 <= 0.03928 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const contrast = (first, second) => {
        const [high, low] = [luminance(parse(first)), luminance(parse(second))].sort((a, b) => b - a);
        return (high + 0.05) / (low + 0.05);
    };
    /** The colour behind an element: the nearest fill that is solid. */
    const behind = (element) => {
        for (let node = element; node; node = node.parentElement) {
            const fill = parse(getComputedStyle(node).backgroundColor);
            if (fill && fill.a === 1) return getComputedStyle(node).backgroundColor;
        }
        return getComputedStyle(document.body).backgroundColor;
    };
    const dimmed = (element) => {
        for (let node = element; node && node !== root.parentElement; node = node.parentElement) {
            if (node.matches(':disabled, [aria-disabled="true"]') || Number(getComputedStyle(node).opacity) < 1) return true;
        }
        return false;
    };
    const every = [...root.querySelectorAll('*')];
    // What is drawn: not a closed dialog, a hidden part or a menu that is not open.
    const shown = every.filter((element) => element.getClientRects().length > 0);
    const elements = shown.filter((element) => !element.closest('svg') || element.tagName === 'svg');
    const all = (selector) => shown.filter((element) => element.matches(selector));

    // Controls: no button of Files' own making is left, drawn or not.
    const old = every.filter((element) => /(^|\s)fx-(button|icon-button|primary|danger|danger-solid)(\s|$)/.test(element.getAttribute('class') || ''));
    if (old.length) faults.push(`${old.length} elements with the old button classes: ${name(old[0])}`);
    for (const button of every.filter((element) => element.tagName === 'BUTTON')) {
        // A crumb is a segment of the path and a column heading sorts: neither is a button of
        // the kit. Everything else is.
        if (!button.matches('.kit-button, .kit-icon-button, .kit-menu-item, .kit-toast-close, .kit-toast-action, .fx-crumb, .fx-sort')) {
            faults.push(`a button that is not the kit's: ${name(button)}`);
        }
    }
    const coarse = matchMedia('(pointer: coarse)').matches;
    if (coarse !== mobile) faults.push(`(pointer: coarse) is ${coarse} in a ${mobile ? 'touch' : 'mouse'} context`);
    const height = (element) => Math.round(element.getBoundingClientRect().height * 100) / 100;
    const dense = mobile ? 44 : 32;
    for (const element of all('.kit-button, .kit-icon-button')) {
        const expected = element.matches('.kit-button-compact, .kit-icon-button-compact') ? dense : 44;
        if (height(element) !== expected) faults.push(`${height(element)}px high, not ${expected}px: ${name(element)}`);
        if (element.matches('.kit-icon-button') && element.getBoundingClientRect().width !== expected) faults.push(`not square: ${name(element)}`);
    }
    for (const element of all('.kit-menu-item, .fx-address, .fx-filter-input, .fx-sort')) {
        if (height(element) !== dense) faults.push(`${height(element)}px high, not ${dense}px: ${name(element)}`);
    }
    for (const element of all('dialog input.kit-field, .kit-toast-close')) {
        if (height(element) !== 44) faults.push(`${height(element)}px high, not 44px: ${name(element)}`);
    }
    // A crumb is pressed over the whole height of the address box, and a row over its own.
    for (const element of all('.fx-crumb')) {
        if (height(element) !== dense) faults.push(`${height(element)}px high, not ${dense}px: ${name(element)}`);
    }
    for (const element of all('tr.fx-row, .fx-dialog-check')) {
        if (height(element) < dense) faults.push(`${height(element)}px high, under ${dense}px: ${name(element)}`);
    }

    // Icons: all from the kit's set, at one of its sizes. A tile shows its icon larger.
    for (const svg of all('svg')) {
        if (!svg.classList.contains('kit-icon')) faults.push(`an icon that is not the kit's: ${name(svg.parentElement)}`);
        if (svg.getAttribute('aria-hidden') !== 'true') faults.push(`an icon that is read out: ${name(svg.parentElement)}`);
        if (svg.children.length !== 1 || svg.children[0].tagName !== 'path') faults.push(`an icon that is not one path: ${name(svg.parentElement)}`);
        const size = svg.getBoundingClientRect().width;
        const sizes = svg.closest('.file-explorer[data-view="tiles"] tr') ? [32] : [16, 20, 24];
        if (!sizes.includes(size) || svg.getBoundingClientRect().height !== size) faults.push(`an icon of ${size}px: ${name(svg.parentElement)}`);
    }
    for (const button of all('.kit-icon-button, .kit-toast-close')) {
        if (!(button.getAttribute('aria-label') || '').trim()) faults.push(`an icon button without a name: ${name(button)}`);
    }

    // Type, radii and colours, element by element.
    const SIZES = ['12px', '13px', '15px', '17px', '20px', '24px'];
    const length = (property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim();
    const RADII = ['0px', length('--radius-sm'), length('--radius-md'), length('--radius-lg'), length('--radius-full')];
    const colourOf = (style, property, where) => {
        const value = style[property];
        const colour = parse(value);
        if (!colour) faults.push(`${property} ${value} cannot be read: ${where}`);
        else if (colour.a !== 0 && !allowed.has(value)) faults.push(`${property} ${value} is not a role token: ${where}`);
    };
    for (const element of elements) {
        // The browser draws a checkbox; it takes the accent from `accent-color`.
        if (element.matches('input[type="checkbox"]')) continue;
        const field = element.matches('input');
        const hasText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
        const style = getComputedStyle(element);
        const where = name(element);
        for (const corner of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']) {
            if (!RADII.includes(style[corner])) faults.push(`${corner} ${style[corner]} is not a radius token: ${where}`);
        }
        // `color` shows only as text and as the stroke of an icon.
        if (field || hasText || element.tagName === 'svg') colourOf(style, 'color', where);
        colourOf(style, 'backgroundColor', where);
        for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
            if (parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none') colourOf(style, `border${side}Color`, where);
        }
        if (!field && !hasText) continue;
        if (field ? style.fontSize !== '16px' : !SIZES.includes(style.fontSize)) faults.push(`font size ${style.fontSize}: ${where}`);
        if (dimmed(element)) continue;
        const ratio = contrast(style.color, behind(element));
        if (ratio < 4.5) faults.push(`text contrast ${ratio.toFixed(2)}:1 (${style.color} on ${behind(element)}): ${where}`);
    }
    // The edge that makes a field findable.
    for (const element of all('.kit-field, .fx-address')) {
        const ratio = contrast(getComputedStyle(element).borderTopColor, behind(element.parentElement));
        if (ratio < 3) faults.push(`border contrast ${ratio.toFixed(2)}:1: ${name(element)}`);
    }

    // Layout.
    if (document.documentElement.scrollWidth > innerWidth) faults.push('the document scrolls sideways');
    return { faults, counts: { elements: elements.length, buttons: all('button').length, icons: all('svg').length } };
}

const row = (page, name) => page.locator(`.fx-row[data-name="${name}"]`);
const ready = (page) => page.locator('.file-explorer[data-listing="ready"]').waitFor();
const address = (folder) => `#!${new URLSearchParams({ action: 'device', udid: UDID, view: 'files', path: folder })}`;
const overlay = (page) => page.evaluate(() => history.state?.nav?.overlay);
const focusedLabel = (page) => page.evaluate(() => document.activeElement?.textContent.trim());

async function run(browser, layout, theme) {
    const label = `${layout.name} ${theme}`;
    const context = await browser.newContext({
        viewport: { width: layout.width, height: layout.height },
        isMobile: layout.mobile,
        hasTouch: layout.mobile,
        colorScheme: theme,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { traffic } = await fixture(page);
    const url = new URL(BASE);
    url.hash = address(ROOT);
    await page.goto(url.toString());
    await ready(page);
    await row(page, 'notes.txt').waitFor();

    let audits = 0;
    /** The state on screen holds only the kit's controls, sizes and colours. */
    const check = async (state) => {
        await settleMotion(page);
        const { faults, counts } = await page.evaluate(audit, { mobile: layout.mobile, tokens: COLOUR_TOKENS });
        assert.deepEqual(faults, [], `${label}, ${state}`);
        assert(counts.buttons > 5 && counts.icons > 5, `${label}, ${state}: the explorer is on screen`);
        await page.screenshot({ path: path.join(OUT, `kit-${state}-${layout.name}-${theme}.png`) });
        audits++;
    };
    const menu = page.locator('.kit-menu.fx-menu');
    const dialog = page.locator('dialog.kit-sheet.fx-dialog[open]');
    const dialogGone = () => page.locator('.fx-dialog').waitFor({ state: 'hidden' });
    const folderKept = async (what) => {
        assert.equal(await page.evaluate(() => location.hash), address(ROOT), `${label}, ${what}: the address is the folder's`);
        assert.equal(await overlay(page), undefined, `${label}, ${what}: the tab is on the folder's own entry`);
    };
    /** The Actions menu on a phone, the toolbar on a desktop. */
    const command = async (button, item = button) => {
        if (!layout.mobile) return pressAtRest(page, page.locator('.fx-commands').getByRole('button', { name: button, exact: true }));
        await page.getByRole('button', { name: 'Actions', exact: true }).click();
        await menu.locator('.kit-menu-item').filter({ hasText: new RegExp(`^${item}$`) }).click();
    };

    // ---------------------------------------------------------------- the listing
    await check('listing');
    // The arrow of the sorted column is an icon that is not read out.
    const sorted = page.locator('th[aria-sort="ascending"]');
    if (!layout.mobile) {
        assert.equal(await sorted.locator('.fx-sort-arrow svg.kit-icon').count(), 1, `${label}: the sort arrow is the kit's icon`);
        assert.equal(await sorted.getByRole('button', { name: 'Name', exact: true }).count(), 1, `${label}: the heading keeps its name`);
        assert.equal(await page.locator('th[aria-sort="none"] .fx-sort-arrow svg').count(), 0, `${label}: only the sorted column has an arrow`);
    }

    // ---------------------------------------------------------------- menus
    const opener = page.getByRole('button', { name: layout.mobile ? 'Actions' : 'View', exact: true });
    await opener.click();
    await menu.waitFor();
    assert.equal(await menu.getAttribute('role'), 'menu');
    assert.equal(await menu.getAttribute('aria-label'), layout.mobile ? 'Actions' : 'View', `${label}: the menu has a name`);
    assert.equal(await menu.evaluate((element) => element.matches(':popover-open')), true, `${label}: the menu is in the top layer`);
    assert.equal(await opener.getAttribute('aria-expanded'), 'true');
    assert.equal(await overlay(page), 1, `${label}: an open menu has a history entry`);
    const items = () => menu.locator('.kit-menu-item:not(:disabled)').allInnerTexts();
    const first = (await items())[0];
    assert.equal(await focusedLabel(page), first, `${label}: the first item has focus`);
    await page.keyboard.press('ArrowDown');
    assert.equal(await focusedLabel(page), (await items())[1], `${label}: ArrowDown moves to the next item`);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await focusedLabel(page), (await items()).at(-1), `${label}: ArrowUp from the first item goes to the last`);
    await page.keyboard.press('Home');
    assert.equal(await focusedLabel(page), first, `${label}: Home goes to the first item`);
    await page.keyboard.press('End');
    assert.equal(await focusedLabel(page), (await items()).at(-1), `${label}: End goes to the last item`);
    // A key the menu does not know is not a shortcut of the list behind it: Backspace there
    // goes up one folder.
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => location.hash), address(ROOT), `${label}: Backspace in a menu leaves the folder alone`);
    assert.equal(await menu.isVisible(), true);
    await check('menu');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await menu.evaluate((element) => element.matches(':popover-open')), false, `${label}: a closed menu leaves the top layer`);
    assert.equal(await opener.getAttribute('aria-expanded'), 'false');
    assert.equal(await opener.evaluate((element) => element === document.activeElement), true, `${label}: Escape returns focus to the button`);
    await folderKept('Escape in a menu');
    // The button closes the menu it opened, and the browser's Back closes it too.
    await opener.click();
    await menu.waitFor();
    await opener.click();
    await menu.waitFor({ state: 'hidden' });
    await folderKept('the button of an open menu');
    await opener.click();
    await menu.waitFor();
    await page.waitForFunction(() => history.state?.nav?.overlay === 1);
    await page.goBack();
    await menu.waitFor({ state: 'hidden' });
    await folderKept('Back in a menu');

    // A check item shows the kit's check, and choosing it leaves the menu open.
    await opener.click();
    if (layout.mobile) {
        await menu.getByRole('menuitem', { name: 'View options…', exact: true }).click();
        // The items were built again: the first of them has focus, and the menu is still placed
        // inside the window.
        assert.equal(await focusedLabel(page), 'Back', `${label}: the submenu gives its first item focus`);
        assert.equal(await menu.getByRole('menuitem', { name: 'Back', exact: true }).locator('svg.kit-icon').count(), 1, `${label}: Back has the kit's icon`);
        const box = await menu.boundingBox();
        assert(box.y >= 8 && box.y + box.height <= layout.height - 8 + 0.5, `${label}: the submenu is inside the window`);
    }
    const hidden = menu.getByRole('menuitemcheckbox', { name: 'Hidden items', exact: true });
    const checkOf = (item) =>
        item.evaluate((element) => {
            const icon = element.querySelector(':scope > svg.kit-icon');
            return { icon: !!icon, drawn: !!icon && getComputedStyle(icon).visibility === 'visible', checked: element.getAttribute('aria-checked') };
        });
    assert.deepEqual(await checkOf(hidden), { icon: true, drawn: false, checked: 'false' }, `${label}: an item that is off keeps room for its check`);
    await hidden.click();
    await row(page, '.hidden-cache').waitFor();
    assert.equal(await menu.isVisible(), true, `${label}: the menu stays open after a check item`);
    assert.deepEqual(await checkOf(hidden), { icon: true, drawn: true, checked: 'true' }, `${label}: the check is drawn once the item is on`);
    assert.equal(await focusedLabel(page), 'Hidden items', `${label}: focus stays on the item that was chosen`);
    const tiles = menu.getByRole('menuitemradio', { name: 'Tiles', exact: true });
    await tiles.click();
    assert.deepEqual(await checkOf(tiles), { icon: true, drawn: true, checked: 'true' }, `${label}: one of a set shows the same check`);
    assert.equal(await focusedLabel(page), 'Tiles');
    await check('view-menu');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await check('tiles');

    // In a tile the checkbox sits in the corner and can be pressed.
    await command('Select', 'Select items');
    const box = await row(page, 'notes.txt').locator('.fx-check').boundingBox();
    assert.equal(
        await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, { x: box.x + box.width / 2, y: box.y + box.height / 2 }),
        'fx-check',
        `${label}: nothing covers the checkbox of a tile`,
    );
    await row(page, 'notes.txt').locator('.fx-check').click();
    await page.locator('.fx-row.selected[data-name="notes.txt"]').waitFor();
    await check('tiles-selected');
    await page.locator('.fx-items').press('Escape');
    await page.locator('.file-explorer:not(.fx-selecting)').waitFor();

    // Back to the details, with the hidden items off again.
    await opener.click();
    if (layout.mobile) await menu.getByRole('menuitem', { name: 'View options…', exact: true }).click();
    await menu.getByRole('menuitemradio', { name: 'Details', exact: true }).click();
    await menu.getByRole('menuitemcheckbox', { name: 'Hidden items', exact: true }).click();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await row(page, '.hidden-cache').waitFor({ state: 'detached' });

    // A row's menu, and a context menu at the pointer on a desktop.
    await pressAtRest(page, row(page, 'notes.txt').locator('.fx-row-menu'));
    await menu.waitFor();
    assert.equal(await menu.getAttribute('aria-label'), 'Item actions');
    assert.equal(await menu.locator('.kit-menu-danger').innerText(), 'Delete', `${label}: Delete is the kit's danger item`);
    await check('row-menu');
    await pressAtRest(page, row(page, 'notes.txt').locator('.fx-row-menu'));
    await menu.waitFor({ state: 'hidden' });
    if (!layout.mobile) {
        await row(page, 'photo.png').locator('.entry-name a').click({ button: 'right' });
        await menu.waitFor();
        assert.equal(await menu.evaluate((element) => element.matches(':popover-open')), true);
        assert.equal(await focusedLabel(page), 'Download', `${label}: a context menu gives its first item focus`);
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
        await page.locator('.fx-items').press('Escape');
    }

    // ---------------------------------------------------------------- the dialog
    /** The dialog on screen is the kit's sheet, named by its title, in the form its width asks for. */
    const sheet = async (title, close, state) => {
        await dialog.waitFor();
        const heading = dialog.locator('h2.kit-sheet-title');
        assert.equal(await heading.innerText(), title, `${label}: the title of the sheet`);
        assert.equal(await dialog.getAttribute('role'), 'dialog');
        assert.equal(await dialog.getAttribute('aria-labelledby'), await heading.getAttribute('id'), `${label}: the dialog is named by its title`);
        assert.equal(await dialog.evaluate((element) => element.matches(':modal')), true, `${label}: the dialog is modal`);
        assert.equal(await dialog.locator('.kit-sheet-close').getAttribute('aria-label'), close);
        assert.equal(await dialog.locator('.kit-sheet-backdrop').count(), 1);
        assert.equal(await dialog.locator('form.kit-sheet-panel > .kit-sheet-body').count(), 1);
        assert.equal(await dialog.locator('form.kit-sheet-panel > footer.kit-sheet-footer .kit-button').count() > 0, true);
        await settleMotion(page);
        const panel = await dialog.locator('.kit-sheet-panel').boundingBox();
        if (layout.width < 600) {
            assert.equal(panel.x, 0, `${label}, ${title}: a bottom sheet is as wide as the window`);
            assert.equal(panel.width, layout.width);
            assert(Math.abs(panel.y + panel.height - layout.height) < 1, `${label}, ${title}: and sits on its bottom edge`);
        } else {
            assert.equal(panel.width, 560, `${label}, ${title}: a dialog is 560px wide`);
            assert(Math.abs(panel.x - (layout.width - 560) / 2) < 1, `${label}, ${title}: and centred`);
        }
        // The entry is made a moment after the dialog opens.
        await page.waitForFunction(() => history.state?.nav?.overlay === 1);
        await check(state);
    };

    // New folder: the kit's field, with its error line under it. Escape closes it.
    await command('New folder');
    await sheet('New folder', 'Close New folder', 'new-folder');
    const field = dialog.locator('input.kit-field[name="value"]');
    assert.equal(await field.evaluate((element) => element === document.activeElement), true, `${label}: the field has focus`);
    assert.equal(await dialog.locator('label.kit-field-label').innerText(), 'Folder name');
    await field.fill('archive');
    await page.keyboard.press('Enter');
    const problem = dialog.locator('.kit-field-error');
    await problem.waitFor();
    assert.equal(await problem.innerText(), '“archive” already exists in this folder.');
    assert.equal(await problem.locator('svg.kit-icon').count(), 1, `${label}: the error has the kit's icon`);
    assert.equal(await field.getAttribute('aria-invalid'), 'true');
    await check('new-folder-error');
    await page.keyboard.press('Escape');
    await dialogGone();
    await folderKept('Escape in New folder');
    assert.equal(traffic.operations.length, 0, `${label}: nothing was created`);

    // Rename: the browser's Back closes it.
    await pressAtRest(page, row(page, 'notes.txt').locator('.fx-row-menu'));
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await sheet('Rename', 'Close Rename', 'rename');
    await page.goBack();
    await dialogGone();
    await folderKept('Back in Rename');

    // Delete: Cancel has focus, the answer that removes is the solid danger fill, and a press
    // on the backdrop closes the question.
    await pressAtRest(page, row(page, 'notes.txt').locator('.fx-row-menu'));
    await menu.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await sheet(`Delete “notes.txt” from ${DEVICE}?`, 'Close this question', 'delete');
    assert.equal(await focusedLabel(page), 'Cancel', `${label}: Cancel has focus`);
    const remove = dialog.getByRole('button', { name: 'Delete', exact: true });
    await page.waitForFunction(() => !document.querySelector('.fx-dialog [value="confirm"]').disabled);
    const fills = await remove.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.transition = 'none';
        element.append(probe);
        probe.style.color = 'var(--danger-fill)';
        const danger = getComputedStyle(probe).color;
        probe.style.color = 'var(--on-accent)';
        const on = getComputedStyle(probe).color;
        probe.remove();
        const style = getComputedStyle(element);
        return { fill: style.backgroundColor === danger, text: style.color === on, kit: element.matches('.kit-button') };
    });
    assert.deepEqual(fills, { fill: true, text: true, kit: true }, `${label}: Delete is confirmed on the solid danger fill`);
    await page.mouse.click(layout.width / 2, 12);
    await dialogGone();
    await folderKept('a press on the backdrop');
    assert.equal(traffic.operations.length, 0, `${label}: nothing was deleted`);

    // Properties: the close button of the sheet closes it.
    await pressAtRest(page, row(page, 'notes.txt').locator('.fx-row-menu'));
    await menu.getByRole('menuitem', { name: 'Properties', exact: true }).click();
    await sheet('Properties', 'Close Properties', 'properties');
    assert.equal(await focusedLabel(page), 'Close', `${label}: Close has focus`);
    await dialog.getByRole('button', { name: 'Close Properties', exact: true }).click();
    await dialogGone();
    await folderKept('the close button');

    // A name conflict, twice in a row. The second question takes over the entry of the first:
    // the tab neither steps back nor adds an entry in between, and Back then closes it. The
    // owner presses Upload before choosing files; a key stands in for that press.
    await page.keyboard.press('Shift');
    const pick = (...names) =>
        page.locator('.file-explorer input[type=file]').setInputFiles(names.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from('New') })));
    const startsBefore = traffic.starts.length;
    await pick('notes.txt', 'photo.png');
    await sheet(`Replace “notes.txt” on ${DEVICE}?`, 'Close this question', 'conflict');
    assert.equal(await focusedLabel(page), 'Keep both', `${label}: the answer that loses nothing has focus`);
    assert.deepEqual(await dialog.locator('.fx-dialog-actions .kit-button').allInnerTexts(), ['Skip', 'Keep both', 'Replace']);
    const entries = await page.evaluate(() => history.length);
    await dialog.getByRole('button', { name: 'Skip', exact: true }).click();
    await dialog.getByRole('heading', { name: `Replace “photo.png” on ${DEVICE}?`, exact: true }).waitFor();
    await settleMotion(page);
    assert.equal(await overlay(page), 1, `${label}: the second question has the entry of the first`);
    assert.equal(await page.evaluate(() => history.length), entries, `${label}: and no entry was added for it`);
    await page.goBack();
    await dialogGone();
    await folderKept('Back in the second conflict question');
    assert.equal(traffic.starts.length, startsBefore, `${label}: both files were skipped`);

    // On a phone the sheet is dragged down by its header to close it.
    if (layout.mobile) {
        await command('New folder');
        await dialog.waitFor();
        await settleMotion(page);
        const header = await dialog.locator('.kit-sheet-header').boundingBox();
        const x = header.x + header.width / 2;
        await page.mouse.move(x, header.y + 8);
        await page.mouse.down();
        await page.mouse.move(x, header.y + 80, { steps: 4 });
        await page.mouse.move(x, header.y + 200, { steps: 4 });
        await page.mouse.up();
        await dialogGone();
        await folderKept('a drag on the header');
    }

    // ---------------------------------------------------------------- the toast
    const toast = page.locator('.kit-toast:not([data-exiting])');
    await page.locator('.fx-items').press('Escape');
    await row(page, 'notes.txt').locator('.entry-name a').click({ modifiers: ['Control'] });
    await page.locator('.fx-row.selected[data-name="notes.txt"]').waitFor();
    await check('selected');
    if (layout.mobile) await page.locator('.fx-selection-bar').getByRole('button', { name: 'Copy selected items', exact: true }).click();
    else await command('Copy');
    await toast.filter({ hasText: 'ready to paste' }).waitFor();
    assert.equal(await toast.getAttribute('role'), 'status');
    assert.equal(await toast.locator('.kit-toast-message').innerText(), '1 item ready to paste.');
    assert.equal(await page.locator('.app-toast').count(), 0, `${label}: the older toast is not used`);
    await check('toast');
    await toast.getByRole('button', { name: 'Dismiss message', exact: true }).click();
    await toast.waitFor({ state: 'detached' });
    // A failure is the same toast as an alert, with the kit's warning icon.
    await pressAtRest(page, row(page, 'denied').locator('.fx-row-menu'));
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await dialog.locator('input[name="value"]').fill('allowed');
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
    const failure = page.locator('.kit-toast[role="alert"]:not([data-exiting])');
    await failure.waitFor();
    await ready(page);
    assert.equal(await failure.locator('svg.kit-icon').count(), 2, `${label}: the warning icon and the close icon`);
    await check('toast-error');
    await failure.getByRole('button', { name: 'Dismiss message', exact: true }).click();

    // ---------------------------------------------------------------- a folder that cannot be opened
    const denied = row(page, 'denied').locator('.entry-name a');
    if (layout.mobile) await denied.click();
    else await denied.dblclick();
    await page.locator('.fx-failed-box').waitFor();
    await check('failed');

    assert.deepEqual(errors, [], `${label}: no browser errors`);
    await context.close();
    console.log(`PASS ${label}: ${audits} states hold only the kit's controls, type and colours; menus, dialog and toast are the kit's`);
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        for (const layout of LAYOUTS) for (const theme of THEMES) await run(browser, layout, theme);
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
