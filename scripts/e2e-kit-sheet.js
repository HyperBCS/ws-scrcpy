/* eslint-disable */
// node scripts/test-browser.js kit-sheet      (E2E_OUT=<dir> keeps a picture of each state;
//                                              KIT_SHEET_ONLY=focus,menu runs only those checks)
// The sheet and the menu of the design kit, on their page at #!action=kit-sheets.
// At 390x844 (touch) and 1440x900 (mouse), light and dark:
//   the sheet is a bottom sheet below 600px and a centred dialog 560px wide from there, whatever
//   the pointer; it has one header (title, subtitle, close) and one footer slot;
//   it has one history entry while it is open: Back closes the top sheet and leaves the page,
//   and the close button, the backdrop, Escape and a drag leave no entry behind;
//   Escape, Back and the browser's close request cancel a confirm prompt first; a sheet that
//   may not close stays open on every one of them;
//   focus moves into the sheet, Tab stays inside, and focus returns to the button that opened it;
//   a sheet opened from a sheet stacks and closes in order; one that takes the place of another
//   keeps its history entry;
//   a toast raised while a sheet is open shows above it and can be pressed;
//   touch, mouse and wheel events in a sheet or a menu do not reach document.body;
//   the sheet follows the visual viewport when an on-screen keyboard resizes it;
//   the menu opens at its button, moves with the arrow keys, closes on Escape, a press outside
//   and Back, and returns focus.
// The page talks to no phone: every socket is refused here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { settleMotion } = require('./ui-motion');

// Only through test-browser.js, which serves the build on a port of its own.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js kit-sheet');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT;

const PHONE = { name: 'phone', width: 390, height: 844, mobile: true };
const DESKTOP = { name: 'desktop', width: 1440, height: 900, mobile: false };
const SURFACE = { light: 'rgb(245, 246, 248)', dark: 'rgb(23, 25, 29)' };
const RAISED = { light: 'rgb(255, 255, 255)', dark: 'rgb(32, 35, 41)' };
const near = (actual, expected, message, by = 1) =>
    assert.ok(Math.abs(actual - expected) <= by, `${message}: ${actual}, expected ${expected}`);

async function start(browser, viewport, colorScheme = 'light') {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile,
        colorScheme, serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const test = { context, page, viewport, mobile: viewport.mobile, colorScheme, errors: [], label: `${viewport.name}--${colorScheme}` };
    page.on('pageerror', (error) => test.errors.push(error.message));
    // The app looks for phones on every page. Here it finds no host.
    await page.routeWebSocket('**', () => undefined);
    await page.goto(`${BASE}#!action=kit-sheets`);
    await page.locator('.kit-sheets-page').waitFor();
    return test;
}

const press = (test, locator) => (test.mobile ? locator.tap() : locator.click());
const pressAt = (test, x, y) => (test.mobile ? test.page.touchscreen.tap(x, y) : test.page.mouse.click(x, y));
const opener = (page, label) => page.locator('.kit-sheets-page > .kit-sheets-list').getByRole('button', { name: label, exact: true });
const sheet = (page, title) => page.getByRole('dialog', { name: title, exact: true });
const openSheets = (page) => page.locator('dialog.kit-sheet[open]:not([data-exiting])').count();
const at = (page) => page.evaluate(() => ({ index: history.state?.nav?.index ?? 0, overlay: history.state?.nav?.overlay || 0, hash: location.hash }));
const untilAt = (page, index, overlay) =>
    page.waitForFunction(([i, o]) => (history.state?.nav?.index ?? 0) === i && (history.state?.nav?.overlay || 0) === o, [index, overlay]);
const box = (locator) => locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
});
const style = (locator, ...names) => locator.evaluate((node, props) => {
    const computed = getComputedStyle(node);
    return Object.fromEntries(props.map((prop) => [prop, computed[prop]]));
}, names);
const focused = (page) => page.evaluate(() => {
    const node = document.activeElement;
    return node ? `${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(' ')[0]}` : ''}:${node.getAttribute('aria-label') || node.textContent.trim().slice(0, 40)}` : '';
});
/** The element that a press at the middle of `locator` would reach is inside it. */
const onTop = (locator) => locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!hit && node.contains(hit);
});
/** The browser's close request, as Chrome on Android sends it for Back on a modal dialog. */
const closeRequest = (locator) => locator.evaluate((node) => {
    const event = new Event('cancel', { cancelable: true });
    node.dispatchEvent(event);
    return event.defaultPrevented;
});

async function shot(test, name) {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    await settleMotion(test.page);
    await test.page.screenshot({ path: path.join(OUT, `${name}--${test.label}.png`), animations: 'disabled' });
}

/** Opens an example from the page and waits until it is at rest on its history entry. */
async function open(test, label, title) {
    const { page } = test;
    const home = await at(page);
    await press(test, opener(page, label));
    const dialog = sheet(page, title);
    await dialog.waitFor();
    await settleMotion(page);
    await untilAt(page, home.index + 1, home.overlay + 1);
    return { dialog, panel: dialog.locator(':scope > .kit-sheet-panel'), home };
}

/** The sheet has gone, the tab is on the entry it was opened from, and the page is still there. */
async function closed(test, dialog, home, how) {
    const { page } = test;
    await dialog.waitFor({ state: 'hidden' });
    await untilAt(page, home.index, home.overlay);
    assert.equal((await at(page)).hash, home.hash, `${how} leaves the address alone`);
    assert.ok(await page.locator('.kit-sheets-page').isVisible(), `${how} leaves the page`);
}

/** Drags the header of a bottom sheet down by `distance`. */
async function dragDown(page, dialog, distance) {
    const header = await box(dialog.locator(':scope > .kit-sheet-panel > .kit-sheet-header'));
    const x = header.left + header.width / 3;
    const y = header.top + 12;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + distance, { steps: 8 });
    await page.mouse.up();
}

async function layout(test) {
    const { page, viewport, mobile, colorScheme } = test;
    const { dialog, panel, home } = await open(test, 'Short sheet', 'Short sheet');
    const rect = await box(panel);
    const look = await style(panel, 'backgroundColor', 'borderTopLeftRadius', 'borderBottomLeftRadius');
    assert.equal(look.backgroundColor, SURFACE[colorScheme], 'the sheet has the surface colour of the theme');
    assert.equal(look.borderTopLeftRadius, '20px');
    const handle = dialog.locator('.kit-sheet-handle');
    if (mobile) {
        assert.equal(rect.left, 0, 'a bottom sheet starts at the left edge');
        assert.equal(rect.width, viewport.width, 'a bottom sheet is as wide as the window');
        near(rect.bottom, viewport.height, 'a bottom sheet sits on the bottom edge');
        assert.equal(look.borderBottomLeftRadius, '0px');
        assert.ok(await handle.isVisible(), 'a bottom sheet shows where it is dragged');
    } else {
        assert.equal(rect.width, 560, 'a dialog is 560px wide');
        near(rect.left + rect.width / 2, viewport.width / 2, 'a dialog is centred across the window');
        assert.equal(rect.top, 108, 'the top edge of a dialog is fixed');
        assert.equal(look.borderBottomLeftRadius, '20px');
        assert.ok(await handle.isHidden(), 'a dialog has no drag handle');
    }
    // One header: the title, the phone under it, and the close control.
    assert.equal(await dialog.locator('.kit-sheet-header').count(), 1);
    const title = dialog.locator('.kit-sheet-title');
    assert.equal(await title.textContent(), 'Short sheet');
    assert.deepEqual(await style(title, 'fontSize', 'fontWeight'), { fontSize: '20px', fontWeight: '600' });
    const subtitle = dialog.locator('.kit-sheet-subtitle');
    assert.equal(await subtitle.textContent(), 'Pixel 9');
    assert.equal((await style(subtitle, 'fontSize')).fontSize, '13px');
    assert.equal(await dialog.getAttribute('aria-describedby'), await subtitle.getAttribute('id'), 'the phone is the description of the dialog');
    const close = dialog.getByRole('button', { name: 'Close Short sheet', exact: true });
    const closeBox = await box(close);
    assert.deepEqual([closeBox.width, closeBox.height], [44, 44], 'the close control is a 44px target');
    assert.equal(await dialog.locator('.kit-sheet-footer').count(), 0, 'no footer without actions');
    assert.ok(await dialog.evaluate((node) => node.matches(':modal')), 'the sheet is a modal dialog');
    await shot(test, 'sheet-short');
    await press(test, close);
    await closed(test, dialog, home, 'the close button');

    // The footer holds the actions under the body, inside the sheet.
    const footer = await open(test, 'Sheet with a footer', 'Footer');
    const slot = footer.dialog.locator('.kit-sheet-footer');
    assert.equal(await slot.count(), 1, 'one footer');
    const [slotBox, bodyBox, panelBox] = await Promise.all([box(slot), box(footer.dialog.locator('.kit-sheet-body')), box(footer.panel)]);
    assert.ok(slotBox.top >= bodyBox.bottom - 1, 'the footer is under the body');
    assert.ok(slotBox.bottom <= panelBox.bottom + 1, 'the footer is inside the sheet');
    const [cancel, save] = await Promise.all([box(slot.getByRole('button', { name: 'Cancel' })), box(slot.getByRole('button', { name: 'Save' }))]);
    assert.deepEqual([cancel.height, save.height], [44, 44]);
    if (mobile) {
        near(cancel.width, save.width, 'the actions share the width on a phone');
        near(cancel.width + save.width + 8, slotBox.width - 32, 'the actions fill the footer on a phone');
    } else {
        near(save.right, slotBox.right - 16, 'the actions sit at the right edge of a dialog');
    }
    await shot(test, 'sheet-footer');
    await page.keyboard.press('Escape');
    await closed(test, footer.dialog, footer.home, 'Escape');

    // A long sheet stops short of the top edge and scrolls inside; the header stays.
    const long = await open(test, 'Long sheet', 'Long sheet');
    assert.equal(await long.dialog.locator('.kit-sheet-subtitle').count(), 0, 'the subtitle is optional');
    assert.equal(await long.dialog.getAttribute('aria-describedby'), null);
    const longBox = await box(long.panel);
    assert.ok(longBox.height <= viewport.height * 0.88 + 1, `a long sheet leaves room above it (${longBox.height})`);
    assert.ok(longBox.top >= 32, 'a long sheet does not reach the top edge');
    assert.ok(longBox.bottom <= viewport.height + 1, 'a long sheet ends inside the window');
    const body = long.dialog.locator('.kit-sheet-body');
    const headerTop = (await box(long.dialog.locator('.kit-sheet-header'))).top;
    assert.ok(await body.evaluate((node) => node.scrollHeight > node.clientHeight + 200), 'the body of a long sheet scrolls');
    await body.evaluate((node) => { node.scrollTop = 400; });
    assert.equal(await body.evaluate((node) => node.scrollTop), 400);
    assert.equal((await box(long.dialog.locator('.kit-sheet-header'))).top, headerTop, 'the header stays while the body scrolls');
    await shot(test, 'sheet-long');
    await pressAt(test, 8, 8);
    await closed(test, long.dialog, long.home, 'the backdrop');

    const field = await open(test, 'Sheet with a text field', 'Text field');
    assert.equal((await style(field.dialog.locator('#kit-sheets-name'), 'fontSize')).fontSize, '16px', 'a field is 16px, so iOS does not zoom');
    await shot(test, 'sheet-field');
    await page.keyboard.press('Escape');
    await closed(test, field.dialog, field.home, 'Escape');
    console.log(`PASS ${test.label}: bottom sheet below 600px, centred 560px dialog from there, one header and one footer slot`);
}

/** The width decides, not the pointer. */
async function widthRule(browser) {
    const cases = [
        { name: 'touch tablet', width: 820, height: 1180, mobile: true, dialog: 560 },
        { name: 'narrow desktop window', width: 599, height: 800, mobile: false, dialog: 0 },
        { name: 'desktop window at the breakpoint', width: 600, height: 800, mobile: false, dialog: 552 },
        { name: 'short and wide phone', width: 844, height: 390, mobile: true, dialog: 560 },
    ];
    for (const viewport of cases) {
        const test = await start(browser, viewport);
        try {
            const { dialog, panel } = await open(test, 'Short sheet', 'Short sheet');
            const rect = await box(panel);
            const handle = dialog.locator('.kit-sheet-handle');
            if (viewport.dialog) {
                assert.equal(rect.width, viewport.dialog, `${viewport.name}: the dialog width`);
                near(rect.left + rect.width / 2, viewport.width / 2, `${viewport.name}: centred`);
                assert.ok(await handle.isHidden(), `${viewport.name}: no drag handle`);
                // A dialog does not drag away.
                await dragDown(test.page, dialog, 200);
                await settleMotion(test.page);
                assert.equal(await openSheets(test.page), 1, `${viewport.name}: a dialog is not dragged away`);
            } else {
                assert.equal(rect.width, viewport.width, `${viewport.name}: a bottom sheet`);
                near(rect.bottom, viewport.height, `${viewport.name}: on the bottom edge`);
                assert.ok(await handle.isVisible(), `${viewport.name}: a drag handle`);
            }
            assert.ok(rect.bottom <= viewport.height + 1 && rect.top >= 0, `${viewport.name}: inside the window`);
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    console.log('PASS the width decides: a 560px dialog on a touch tablet, a bottom sheet in a narrow desktop window');
}

async function history(test) {
    const { page, mobile } = test;
    // Back closes the sheet and leaves the page.
    let { dialog, home } = await open(test, 'Short sheet', 'Short sheet');
    const entries = await page.evaluate(() => window.history.length);
    await page.goBack();
    await closed(test, dialog, home, 'Back');

    const ways = {
        'the close button': (shown) => press(test, shown.locator('.kit-sheet-close')),
        'the backdrop': () => pressAt(test, 8, 8),
        Escape: () => page.keyboard.press('Escape'),
        'a button in the sheet': (shown) => press(test, shown.getByRole('button', { name: 'Done' })),
    };
    if (mobile) ways['a drag on the header'] = (shown) => dragDown(page, shown, 260);
    for (const [how, close] of Object.entries(ways)) {
        ({ dialog, home } = await open(test, 'Short sheet', 'Short sheet'));
        assert.equal(await page.evaluate(() => window.history.length), entries, `one entry while the sheet is open (${how})`);
        await close(dialog);
        await closed(test, dialog, home, how);
        assert.equal(await page.evaluate(() => document.body.classList.contains('sheet-open')), false);
    }
    // A short drag is not a request to close.
    if (mobile) {
        ({ dialog, home } = await open(test, 'Short sheet', 'Short sheet'));
        await dragDown(page, dialog, 30);
        await settleMotion(page);
        assert.equal(await openSheets(page), 1, 'a short drag leaves the sheet open');
        near((await box(dialog.locator(':scope > .kit-sheet-panel'))).bottom, test.viewport.height, 'the sheet settles back');
        await page.keyboard.press('Escape');
        await closed(test, dialog, home, 'Escape');
    }
    console.log(`PASS ${test.label}: one history entry while a sheet is open; Back closes it and leaves the page; none left after the close button, the backdrop, Escape${mobile ? ' or a drag' : ''}`);
}

async function confirmFirst(test) {
    const { page } = test;
    const { dialog, home } = await open(test, 'Sheet with a confirm prompt', 'Confirm prompt');
    const prompt = dialog.locator('.confirm-prompt.kit');
    const arm = async () => {
        await press(test, dialog.getByRole('button', { name: 'Erase the example' }));
        await prompt.waitFor();
    };
    await arm();
    // The kit look: a raised card, and a solid danger button with the kit's size.
    const confirm = prompt.getByRole('button', { name: 'Erase', exact: true });
    assert.equal((await style(prompt, 'backgroundColor')).backgroundColor, RAISED[test.colorScheme]);
    assert.deepEqual(await style(confirm, 'backgroundColor', 'color', 'fontSize', 'height', 'borderTopLeftRadius'), {
        backgroundColor: 'rgb(179, 38, 30)', color: 'rgb(255, 255, 255)', fontSize: '15px', height: '44px', borderTopLeftRadius: '12px',
    });
    await shot(test, 'sheet-confirm');

    await page.keyboard.press('Escape');
    await prompt.waitFor({ state: 'detached' });
    assert.equal(await openSheets(page), 1, 'the first Escape cancels the prompt and the sheet stays');
    assert.deepEqual(await at(page), { ...home, index: home.index + 1, overlay: home.overlay + 1 });

    await arm();
    assert.equal(await closeRequest(dialog), true, 'the close request is answered by the sheet');
    await prompt.waitFor({ state: 'detached' });
    assert.equal(await openSheets(page), 1, 'the first close request cancels the prompt and the sheet stays');

    await arm();
    await page.goBack();
    await prompt.waitFor({ state: 'detached' });
    await untilAt(page, home.index + 1, home.overlay + 1);
    assert.equal(await openSheets(page), 1, 'the first Back cancels the prompt and the sheet stays');

    // Confirming still works, and the second close request closes the sheet.
    await arm();
    await page.waitForTimeout(600);
    await press(test, confirm);
    await dialog.getByText('The example was erased.').waitFor();
    assert.equal(await closeRequest(dialog), true);
    await closed(test, dialog, home, 'the close request');
    console.log(`PASS ${test.label}: Escape, Back and the close request cancel a confirm prompt first and close the sheet second`);
}

async function busyStays(test) {
    const { page, mobile } = test;
    const { dialog, home } = await open(test, 'Sheet that stays open while busy', 'Busy sheet');
    const start = dialog.getByRole('button', { name: 'Start' });
    await start.focus();
    await page.keyboard.press('Enter');
    await dialog.getByText('Working.').waitFor();
    // The pressed button was removed while it had focus: focus stays in the sheet.
    await page.waitForFunction(() => document.activeElement?.matches('dialog.kit-sheet'));
    const close = dialog.locator('.kit-sheet-close');
    assert.ok(await close.isDisabled(), 'the close control is off while the sheet may not close');
    const here = { ...home, index: home.index + 1, overlay: home.overlay + 1 };
    const stays = async (how) => {
        await settleMotion(page);
        await untilAt(page, here.index, here.overlay);
        assert.equal(await openSheets(page), 1, `the sheet stays open on ${how}`);
        assert.ok(await dialog.evaluate((node) => node.open && node.matches(':modal')), `the dialog is still modal after ${how}`);
        assert.ok(await dialog.getByText('Working.').isVisible());
    };
    await page.keyboard.press('Escape');
    await stays('Escape');
    assert.equal(await closeRequest(dialog), true);
    await stays('the close request');
    // Chrome closes the dialog itself on a second close request with no press in between.
    await dialog.evaluate((node) => node.close());
    await page.waitForFunction(() => document.querySelector('dialog.kit-sheet[open]'));
    await stays('a close by the browser');
    await pressAt(test, 8, 8);
    await stays('the backdrop');
    if (mobile) {
        await dragDown(page, dialog, 260);
        await stays('a drag');
        near((await box(dialog.locator(':scope > .kit-sheet-panel'))).bottom, test.viewport.height, 'the sheet is back in place');
    }
    await page.goBack();
    await stays('Back');
    await shot(test, 'sheet-busy');

    await press(test, dialog.getByRole('button', { name: 'Finish' }));
    await dialog.getByText('Nothing is running.').waitFor();
    assert.ok(await close.isEnabled());
    await page.keyboard.press('Escape');
    await closed(test, dialog, home, 'Escape after the work');
    console.log(`PASS ${test.label}: a sheet that may not close stays open on Escape, the close request, the backdrop, ${mobile ? 'a drag, ' : ''}Back and a close by the browser`);
}

async function focus(test) {
    const { page } = test;
    const button = opener(page, 'Sheet with a text field');
    const home = await at(page);
    await button.focus();
    await page.keyboard.press('Enter');
    const dialog = sheet(page, 'Text field');
    await dialog.waitFor();
    await settleMotion(page);
    await untilAt(page, home.index + 1, home.overlay + 1);
    // The dialog itself, not the field: the phone keyboard stays down.
    assert.ok(await dialog.evaluate((node) => document.activeElement === node), 'the dialog has focus, not a control in it');
    const inside = () => dialog.evaluate((node) => node.contains(document.activeElement) && document.activeElement !== node);
    const order = [];
    for (let step = 0; step < 4; step++) {
        await page.keyboard.press('Tab');
        assert.ok(await inside(), 'Tab stays in the sheet');
        order.push(await page.evaluate(() => document.activeElement.id || document.activeElement.className));
    }
    assert.deepEqual(order, ['kit-sheet-close', 'kit-sheets-name', 'kit-sheets-text', 'kit-sheet-close'], 'Tab goes round the controls of the sheet');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'kit-sheets-text', 'Shift+Tab goes round the other way');
    assert.ok(await inside());
    // The page under the sheet cannot take focus.
    await button.evaluate((node) => node.focus());
    assert.ok(await dialog.evaluate((node) => node.contains(document.activeElement)), 'the page under a sheet is inert');
    await page.keyboard.press('Escape');
    await closed(test, dialog, home, 'Escape');
    assert.equal(await focused(page), 'button.kit-sheets-button:Sheet with a text field', 'focus returns to the button that opened the sheet');
    console.log(`PASS ${test.label}: focus moves to the dialog, Tab stays inside, and focus returns to the opener`);
}

async function stack(test) {
    const { page } = test;
    const first = await open(test, 'Sheet opened from a sheet', 'First sheet');
    const again = first.dialog.getByRole('button', { name: 'Open the second sheet' });
    const second = sheet(page, 'Second sheet');
    const openSecond = async () => {
        await press(test, again);
        await second.waitFor();
        await settleMotion(page);
        await untilAt(page, first.home.index + 2, first.home.overlay + 2);
        assert.equal(await openSheets(page), 2, 'both sheets are open');
        assert.ok(await onTop(second.locator(':scope > .kit-sheet-panel')), 'the second sheet is on top');
        assert.ok(await second.evaluate((node) => node.contains(document.activeElement)), 'focus is in the second sheet');
    };
    const onlyFirst = async (how) => {
        await second.waitFor({ state: 'hidden' });
        await untilAt(page, first.home.index + 1, first.home.overlay + 1);
        await settleMotion(page);
        assert.equal(await openSheets(page), 1, `${how} closes only the sheet on top`);
        assert.ok(await first.dialog.isVisible());
        assert.ok(await onTop(first.panel), 'the first sheet can be pressed again');
    };
    await openSecond();
    await shot(test, 'sheet-stacked');
    await page.keyboard.press('Escape');
    await onlyFirst('Escape');
    assert.equal(await focused(page), 'button.kit-sheets-button:Open the second sheet', 'focus returns into the first sheet');
    await openSecond();
    await page.goBack();
    await onlyFirst('Back');
    await openSecond();
    assert.equal(await closeRequest(second), true);
    await onlyFirst('the close request');
    await openSecond();
    await pressAt(test, 8, 8);
    await onlyFirst('the backdrop');
    assert.equal(await page.evaluate(() => document.body.classList.contains('sheet-open')), true, 'the page stays locked under the first sheet');
    await page.keyboard.press('Escape');
    await closed(test, first.dialog, first.home, 'Escape');

    // One sheet in the place of another: the entry is handed over, and focus goes back to the
    // button on the page, because the button that was pressed has gone with its sheet.
    const short = await open(test, 'Short sheet', 'Short sheet');
    const entries = await page.evaluate(() => window.history.length);
    await press(test, short.dialog.getByRole('button', { name: 'Go to the long sheet' }));
    const long = sheet(page, 'Long sheet');
    await long.waitFor();
    await short.dialog.waitFor({ state: 'hidden' });
    await settleMotion(page);
    assert.equal(await openSheets(page), 1, 'the long sheet took the place of the short one');
    assert.deepEqual(await at(page), { ...short.home, index: short.home.index + 1, overlay: short.home.overlay + 1 }, 'the sheets share one entry');
    assert.equal(await page.evaluate(() => window.history.length), entries, 'no entry was added');
    assert.ok(await long.evaluate((node) => node.contains(document.activeElement)), 'focus is in the sheet that opened');
    assert.ok(await onTop(long.locator(':scope > .kit-sheet-panel')));
    assert.equal(await page.evaluate(() => document.body.classList.contains('sheet-open')), true);
    await page.keyboard.press('Escape');
    await closed(test, long, short.home, 'Escape');
    assert.equal(await focused(page), 'button.kit-sheets-button:Short sheet', 'focus returns to the button on the page');
    assert.equal(await page.evaluate(() => document.body.classList.contains('sheet-open')), false);

    // Back from both, one at a time, ends on the page.
    await press(test, opener(page, 'Sheet opened from a sheet'));
    await first.dialog.waitFor();
    await settleMotion(page);
    await untilAt(page, first.home.index + 1, first.home.overlay + 1);
    await openSecond();
    await page.goBack();
    await onlyFirst('Back');
    await page.goBack();
    await closed(test, first.dialog, first.home, 'the second Back');
    assert.equal(await openSheets(page), 0);
    console.log(`PASS ${test.label}: a sheet opened from a sheet stacks, and Escape, Back, the close request and the backdrop close the top one first; a sheet that takes the place of another keeps its entry`);
}

async function toastAbove(test) {
    const { page } = test;
    const { dialog, home } = await open(test, 'Toast over a sheet', 'Toast');
    const toast = page.locator('.app-toast');
    const raise = async () => {
        await press(test, dialog.getByRole('button', { name: 'Show a message' }));
        await toast.waitFor();
        await settleMotion(page);
    };
    await raise();
    assert.equal(await toast.count(), 1, 'one toast');
    assert.ok(await dialog.evaluate((node) => !!node.querySelector(':scope > .kit-sheet-above > .app-toast')), 'the toast is shown inside the open sheet');
    assert.ok(await onTop(toast), 'the toast is above the sheet');
    const toastBox = await box(toast);
    assert.ok(toastBox.bottom <= test.viewport.height && toastBox.top > test.viewport.height - 160, 'the toast is at the bottom edge, where it always is');
    await shot(test, 'sheet-toast');
    // It can be pressed there, and pressing it does not close the sheet.
    await press(test, toast.getByRole('button', { name: 'Dismiss message' }));
    await toast.waitFor({ state: 'detached' });
    assert.equal(await openSheets(page), 1, 'closing the toast leaves the sheet open');
    // Tab reaches the toast from the sheet.
    await raise();
    await dialog.locator('.kit-sheet-close').focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(page), 'button.toast-close:Dismiss message', 'Tab reaches the toast');
    // The toast outlives the sheet: it goes back to the page.
    await page.keyboard.press('Escape');
    await closed(test, dialog, home, 'Escape');
    await toast.waitFor();
    await settleMotion(page);
    assert.equal(await toast.count(), 1);
    assert.ok(await page.evaluate(() => !document.querySelector('dialog .app-toast')), 'the toast is on the page again');
    assert.ok(await onTop(toast));
    // One that is already showing moves into a sheet that opens over it.
    const short = await open(test, 'Short sheet', 'Short sheet');
    await toast.waitFor();
    await settleMotion(page);
    assert.ok(await short.dialog.evaluate((node) => !!node.querySelector(':scope > .kit-sheet-above > .app-toast')), 'a toast on the page moves into the sheet');
    assert.ok(await onTop(toast));
    await press(test, toast.getByRole('button', { name: 'Dismiss message' }));
    await toast.waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    await closed(test, short.dialog, short.home, 'Escape');
    console.log(`PASS ${test.label}: a toast raised while a sheet is open shows above it, can be pressed, and stays when the sheet closes`);
}

const REMOTE = ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'mousedown', 'mousemove', 'mouseup', 'wheel'];
/** Records what reaches document.body, where the listeners that drive a phone are. */
const listen = (page) => page.evaluate((names) => {
    window.__reached = [];
    window.__listen ??= names.map((name) => document.body.addEventListener(name, (event) => window.__reached.push(event.type), { passive: true }));
}, REMOTE);
const reached = (page) => page.evaluate(() => Array.from(new Set(window.__reached)).sort());

async function eventsStop(test) {
    const { page, mobile } = test;
    // The listeners hear the page itself.
    await listen(page);
    const heading = await box(page.locator('.kit-sheets-heading'));
    await pressAt(test, heading.left + 10, heading.top + 10);
    await page.mouse.move(heading.left + 20, heading.top + 12);
    await page.mouse.wheel(0, 40);
    await page.waitForFunction(() => window.__reached.includes('wheel'));
    const heard = await reached(page);
    for (const name of mobile ? ['touchstart', 'touchend', 'mousemove', 'wheel'] : ['mousedown', 'mouseup', 'mousemove', 'wheel']) {
        assert.ok(heard.includes(name), `document.body hears ${name} on the page (${heard})`);
    }

    const { dialog, home } = await open(test, 'Long sheet', 'Long sheet');
    await listen(page);
    const body = dialog.locator('.kit-sheet-body');
    const rows = await box(body);
    const x = rows.left + rows.width / 2;
    const y = rows.top + rows.height / 2;
    await pressAt(test, x, y);
    await page.mouse.move(x + 5, y + 5);
    await page.mouse.down();
    await page.mouse.move(x + 15, y + 25, { steps: 3 });
    await page.mouse.up();
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => document.querySelector('dialog.kit-sheet[open] .kit-sheet-body').scrollTop > 0);
    if (mobile) {
        // A finger that scrolls the list, and one that drags the header and lets go.
        const cdp = await page.context().newCDPSession(page);
        const swipe = async (fromY, toY) => {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y: fromY, force: 1 }] });
            for (let step = 1; step <= 4; step++) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x, y: fromY + ((toY - fromY) * step) / 4, force: 1 }] });
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        };
        await swipe(y, y - 120);
        const header = await box(dialog.locator('.kit-sheet-header'));
        await swipe(header.top + 12, header.top + 40);
        await cdp.detach();
        await settleMotion(page);
    }
    // The backdrop too.
    await page.mouse.move(8, 8);
    await page.mouse.wheel(0, 60);
    await page.waitForTimeout(100);
    assert.deepEqual(await reached(page), [], 'nothing in a sheet reaches document.body');
    assert.equal(await openSheets(page), 1);
    await page.keyboard.press('Escape');
    await closed(test, dialog, home, 'Escape');
    console.log(`PASS ${test.label}: touch, mouse and wheel events inside a sheet do not reach document.body`);
}

async function keyboardResize(test) {
    const { page, viewport } = test;
    const { dialog, panel, home } = await open(test, 'Sheet with a text field', 'Text field');
    const resize = (height, offsetTop) => page.evaluate(([h, top]) => {
        // What an on-screen keyboard does: the visual viewport shrinks and the page does not.
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => h });
        Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, get: () => top });
        window.visualViewport.dispatchEvent(new Event('resize'));
    }, [height, offsetTop]);
    const before = await box(panel);
    await resize(420, 0);
    await settleMotion(page);
    let root = await box(dialog);
    let rect = await box(panel);
    assert.deepEqual([root.top, root.height], [0, 420], 'the sheet has the height the keyboard leaves');
    assert.ok(rect.bottom <= 420 + 1, `the sheet ends above the keyboard (${rect.bottom})`);
    assert.ok(rect.top >= 0, 'the sheet starts inside the window');
    if (test.mobile) near(rect.bottom, 420, 'a bottom sheet sits on the keyboard');
    const fieldBox = await box(dialog.locator('#kit-sheets-text'));
    assert.ok(fieldBox.bottom <= 420, 'the field is above the keyboard');
    await shot(test, 'sheet-keyboard');
    // iOS also moves the visual viewport down the page.
    await resize(420, 60);
    root = await box(dialog);
    rect = await box(panel);
    assert.deepEqual([root.top, root.height], [60, 420], 'the sheet follows the visual viewport down the page');
    assert.ok(rect.bottom <= 480 + 1 && rect.top >= 60);
    await page.evaluate(() => {
        delete window.visualViewport.height;
        delete window.visualViewport.offsetTop;
        window.visualViewport.dispatchEvent(new Event('resize'));
    });
    assert.deepEqual(await box(panel), before, 'the sheet is back when the keyboard has gone');
    assert.equal((await box(dialog)).height, viewport.height);
    await page.keyboard.press('Escape');
    await closed(test, dialog, home, 'Escape');
    console.log(`PASS ${test.label}: the sheet follows the visual viewport when a keyboard resizes it`);
}

async function menu(test) {
    const { page, viewport, mobile } = test;
    const button = page.locator('.kit-sheets-page > .kit-sheets-list').getByRole('button', { name: 'More', exact: true });
    const list = page.getByRole('menu', { name: 'More actions' });
    const home = await at(page);
    const openMenu = async () => {
        await press(test, button);
        await list.waitFor();
        await settleMotion(page);
        await untilAt(page, home.index + 1, home.overlay + 1);
        assert.equal(await button.getAttribute('aria-expanded'), 'true');
    };
    const gone = async (how) => {
        await list.waitFor({ state: 'detached' });
        await untilAt(page, home.index, home.overlay);
        assert.equal(await button.getAttribute('aria-expanded'), 'false', `${how} closes the menu`);
        assert.ok(await page.locator('.kit-sheets-page').isVisible());
    };
    const current = () => page.evaluate(() => (document.activeElement.closest('[role="menu"]') ? document.activeElement.textContent.trim() : `outside: ${document.activeElement.textContent.trim()}`));

    await openMenu();
    // At its button: under it, in line with its left edge, inside the window.
    const [from, rect] = await Promise.all([box(button), box(list)]);
    near(rect.left, from.left, 'the menu is in line with its button');
    // Under the button, or above it when the window has no room under it.
    if (from.bottom + 4 + rect.height <= viewport.height - 8) near(rect.top, from.bottom + 4, 'the menu is under its button');
    else near(rect.bottom, from.top - 4, 'the menu is above its button');
    assert.ok(rect.right <= viewport.width - 8 + 1 && rect.bottom <= viewport.height - 8 + 1, 'the menu is inside the window');
    assert.deepEqual(await style(list, 'backgroundColor', 'borderTopLeftRadius'), { backgroundColor: RAISED[test.colorScheme], borderTopLeftRadius: '12px' });
    const items = list.locator('[role^="menuitem"]');
    assert.deepEqual(await items.evaluateAll((nodes) => nodes.map((node) => `${node.getAttribute('role')}:${node.textContent.trim()}`)), [
        'menuitem:Rename', 'menuitem:Move', 'menuitem:Share', 'menuitemcheckbox:Show hidden items', 'menuitem:Delete',
    ]);
    assert.deepEqual(await items.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height)), [44, 44, 44, 44, 44], 'each item is a 44px target');
    assert.ok(await onTop(list), 'the menu is on top');
    await shot(test, 'menu');

    // The first item has focus; the arrow keys move it past the item that is off, and round.
    assert.equal(await current(), 'Rename');
    const walk = [['ArrowDown', 'Move'], ['ArrowDown', 'Show hidden items'], ['ArrowDown', 'Delete'], ['ArrowDown', 'Rename'], ['ArrowUp', 'Delete'], ['ArrowUp', 'Show hidden items'], ['Home', 'Rename'], ['End', 'Delete']];
    for (const [key, item] of walk) {
        await page.keyboard.press(key);
        assert.equal(await current(), item, `${key} moves to ${item}`);
    }
    await page.keyboard.press('Escape');
    await gone('Escape');
    assert.equal(await focused(page), 'button.kit-sheets-button:More', 'Escape returns focus to the button');

    await openMenu();
    await page.goBack();
    await gone('Back');
    assert.equal(await focused(page), 'button.kit-sheets-button:More', 'Back returns focus to the button');

    await openMenu();
    const heading = await box(page.locator('.kit-sheets-heading'));
    await pressAt(test, heading.left + 10, heading.top + 10);
    await gone('a press outside');

    await openMenu();
    await page.keyboard.press('Tab');
    await gone('Tab');
    assert.equal(await focused(page), 'button.kit-sheets-button:More');

    // The button closes the menu it opened.
    await openMenu();
    await press(test, button);
    await gone('the button');

    // An item that is on or off leaves the menu open; an action closes it.
    await openMenu();
    const hiddenItems = list.getByRole('menuitemcheckbox', { name: 'Show hidden items' });
    assert.equal(await hiddenItems.getAttribute('aria-checked'), 'false');
    await press(test, hiddenItems);
    await page.waitForFunction(() => document.querySelector('.kit-menu [role="menuitemcheckbox"]')?.getAttribute('aria-checked') === 'true');
    assert.ok(await list.isVisible(), 'a checked item leaves the menu open');
    await shot(test, 'menu-checked');
    await page.keyboard.press('ArrowUp');
    assert.equal(await current(), 'Move');
    await page.keyboard.press('Enter');
    await gone('an item');
    await page.getByText('Last choice: Move.').waitFor();
    assert.equal(await focused(page), 'button.kit-sheets-button:More', 'choosing an item returns focus to the button');
    await openMenu();
    await press(test, list.getByRole('menuitem', { name: 'Delete' }));
    await gone('an item');
    await page.getByText('Last choice: Delete.').waitFor();

    // Presses in the menu do not reach the listeners that drive a phone.
    await openMenu();
    await listen(page);
    const inMenu = await box(list.getByRole('menuitem', { name: 'Share' }));
    await pressAt(test, inMenu.left + 20, inMenu.top + 20);
    await page.mouse.move(inMenu.left + 30, inMenu.top + 25);
    await page.mouse.wheel(0, 30);
    await page.waitForTimeout(100);
    assert.deepEqual(await reached(page), [], 'nothing in a menu reaches document.body');
    assert.ok(await list.isVisible(), 'an item that is off does nothing');
    await page.keyboard.press('Escape');
    await gone('Escape');

    // In a sheet the menu is above the sheet, and each request to close takes the menu first.
    const footer = await open(test, 'Sheet with a footer', 'Footer');
    const inSheet = footer.dialog.getByRole('button', { name: 'More', exact: true });
    const openInSheet = async () => {
        await press(test, inSheet);
        await list.waitFor();
        await settleMotion(page);
        await untilAt(page, footer.home.index + 2, footer.home.overlay + 2);
        assert.ok(await onTop(list), 'the menu is above the sheet');
    };
    const sheetStays = async (how) => {
        await list.waitFor({ state: 'detached' });
        await untilAt(page, footer.home.index + 1, footer.home.overlay + 1);
        assert.equal(await openSheets(page), 1, `${how} closes the menu and the sheet stays`);
    };
    await openInSheet();
    const [sheetButton, sheetMenu] = await Promise.all([box(inSheet), box(list)]);
    near(sheetMenu.left, sheetButton.left, 'the menu in a sheet is in line with its button');
    assert.ok(sheetMenu.bottom <= viewport.height - 8 + 1 && sheetMenu.top >= 8 - 1, 'the menu in a sheet is inside the window');
    if (mobile) near(sheetMenu.bottom, sheetButton.top - 4, 'with no room under the button the menu opens above it');
    await shot(test, 'menu-in-sheet');
    await page.keyboard.press('Escape');
    await sheetStays('Escape');
    assert.equal(await focused(page), 'button.kit-sheets-button:More');
    await openInSheet();
    assert.equal(await closeRequest(footer.dialog), true);
    await sheetStays('the close request');
    await openInSheet();
    await page.goBack();
    await sheetStays('Back');
    await page.keyboard.press('Escape');
    await closed(test, footer.dialog, footer.home, 'Escape');
    console.log(`PASS ${test.label}: the menu opens at its button, moves with the arrow keys, closes on Escape, a press outside, Tab and Back, and returns focus`);
}

const ONLY = process.env.KIT_SHEET_ONLY ? process.env.KIT_SHEET_ONLY.split(',') : undefined;
const chosen = (check) => !ONLY || ONLY.includes(check.name);

async function run(browser, viewport, colorScheme, checks) {
    const test = await start(browser, viewport, colorScheme);
    try {
        for (const check of checks.filter(chosen)) await check(test);
        assert.equal(await openSheets(test.page), 0);
        assert.deepEqual(test.errors, [], `${test.label}: no page error`);
    } finally {
        await test.context.close();
    }
}

async function main() {
    const browser = await chromium.launch();
    try {
        const behaviour = [history, confirmFirst, busyStays, focus, stack, toastAbove, eventsStop, keyboardResize, menu];
        // Side by side, each in a context of its own: the suite has four minutes.
        await Promise.all([
            run(browser, PHONE, 'light', [layout, ...behaviour]),
            run(browser, DESKTOP, 'dark', [layout, ...behaviour]),
            run(browser, PHONE, 'dark', [layout, confirmFirst, toastAbove, menu]),
            run(browser, DESKTOP, 'light', [layout, confirmFirst, toastAbove, menu]),
            chosen(widthRule) ? widthRule(browser) : undefined,
        ]);
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
