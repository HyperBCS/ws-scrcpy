// BASE=http://127.0.0.1:8000 E2E_OUT=/tmp/ws-scrcpy-switcher node scripts/e2e-switcher.js
// All sockets are intercepted; native touch scrolls real device-row buttons without hardware input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { fixture, UDID } = require('./e2e-settings');
const { gesture, initialStreamPacket } = require('./e2e-sheets');
// Waits for the sheet's own motion, whatever element carries it.
const { settleMotion: settle } = require('./ui-motion');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-switcher';
const descriptors = Array.from({ length: 28 }, (_, index) => ({
    udid: index ? `switch-fixture-${String(index).padStart(2, '0')}-${'long_serial_'.repeat(3)}` : UDID,
    state: index > 23 ? 'offline' : 'device',
    pid: 123,
    interfaces: [],
    'ro.product.model': `Device ${String(index).padStart(2, '0')}`,
    'ro.product.manufacturer': 'Fixture',
    'ro.build.version.sdk': '36',
    'ro.build.version.release': '16',
    'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'on',
    'device.awake': true,
}));
// The switcher is the kit sheet: a native dialog. Below 600px it is a bottom sheet with a
// handle to drag; from 600px it is a centred dialog, whatever the pointer.
const SHEET = 'dialog.kit-sheet[open]';
async function checkGeometry(page) {
    const result = await page.locator(SHEET).evaluate((root) => {
        const list = root.querySelector('.device-switcher-list');
        const body = root.querySelector('.kit-sheet-body');
        const panel = root.querySelector('.kit-sheet-panel');
        const bounds = list.getBoundingClientRect();
        list.scrollLeft = 100;
        return {
            height: list.clientHeight,
            content: list.scrollHeight,
            width: list.clientWidth,
            contentWidth: list.scrollWidth,
            scrollLeft: list.scrollLeft,
            bodyScroll: body.scrollTop,
            bodyOverflow: getComputedStyle(body).overflowY,
            listOverflow: getComputedStyle(list).overflowY,
            touch: getComputedStyle(list).touchAction,
            panelBottom: panel.getBoundingClientRect().bottom,
            viewport: visualViewport.height,
            escaped: Array.from(list.querySelectorAll('button'))
                .filter((el) => {
                    const rect = el.getBoundingClientRect();
                    return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
                })
                .map((el) => el.textContent),
        };
    });
    assert(result.height >= 70, 'at least one usable device row remains visible');
    assert(result.content > result.height + 700, 'long fixture overflows the bounded list itself');
    assert.equal(result.bodyScroll, 0, 'outer sheet body is not a competing scroller');
    assert.equal(result.bodyOverflow, 'hidden', 'outer body holds search in place');
    assert.equal(result.listOverflow, 'auto', 'device list explicitly scrolls');
    assert.equal(result.touch, 'pan-y', 'list admits vertical touch scrolling');
    assert.equal(result.scrollLeft, 0, 'no horizontal list scrolling');
    assert(result.contentWidth <= result.width + 1, 'long identifiers fit');
    assert.deepEqual(result.escaped, [], 'row controls remain inside list');
    assert(result.panelBottom <= result.viewport + 1, 'sheet stays within viewport');
}
async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        for (const [label, width, height, touch] of [
            ['phone320', 320, 568, true],
            ['iphone17pm', 440, 956, true],
            ['iphone17pm-landscape', 956, 440, true],
            ['tablet', 1024, 900, true],
            ['desktop', 1280, 900, false],
        ]) {
            const context = await browser.newContext({
                viewport: { width, height },
                hasTouch: touch,
                isMobile: touch,
                colorScheme: 'dark',
            });
            const page = await context.newPage();
            const cdp = await context.newCDPSession(page);
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            const messages = [];
            await fixture(page, {
                deviceList: descriptors,
                initialPacket: initialStreamPacket(),
                onStreamReady() {},
                onStreamMessage: (data) => messages.push(Buffer.from(data)),
            });
            const ws = new URL('/__settings_fixture__', BASE);
            ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = new URL(BASE);
            url.hash = `!${new URLSearchParams({ action: 'stream', udid: UDID, player: 'webcodecs', ws: ws.toString(), captureKeyboard: '0', fitToScreen: '1' })}`;
            await page.goto(url.toString());
            await page.getByText('Connected', { exact: true }).waitFor();
            await page.locator('.touch-layer').waitFor({ state: 'visible' });
            const trigger = page.getByRole('button', { name: 'Switch', exact: true });
            await trigger.click();
            const root = page.locator(SHEET);
            await root.waitFor();
            await settle(page);
            const list = root.locator('.device-switcher-list');
            const search = page.getByRole('searchbox', { name: 'Find a phone to switch to' });
            assert.equal(await search.getAttribute('placeholder'), 'Find a phone…');
            await page.waitForFunction(() => document.querySelectorAll('.device-switcher-list button').length === 28);
            await checkGeometry(page);
            assert.equal(await root.getAttribute('role'), 'dialog', `${label}: the sheet is a dialog`);
            assert.equal(await root.evaluate((el) => document.getElementById(el.getAttribute('aria-labelledby')).textContent), 'Switch phone', `${label}: the dialog is named by its title`);
            // Each row is the phone's row of the list: name, platform line and one chip; no serial
            // and no tracker name. The phone on screen comes first with Viewing in place of its
            // status and cannot be chosen; the phones that cannot be opened come last.
            const rows = await list.locator('button').evaluateAll((buttons) => buttons.map((button) => ({
                name: button.querySelector('.phone-row-name')?.textContent,
                platform: button.querySelector('.phone-row-platform')?.textContent,
                chips: [...button.querySelectorAll('.kit-chip')].map((chip) => chip.textContent),
                disabled: button.disabled,
                current: button.getAttribute('aria-current'),
                text: button.textContent,
            })));
            assert.deepEqual(rows[0], { name: 'Fixture Device 00', platform: 'Android 16', chips: ['Viewing'], disabled: true, current: 'true', text: rows[0].text }, `${label}: the phone on screen is first`);
            assert.ok(rows.every((row) => row.chips.length === 1), `${label}: one chip per row`);
            assert.ok(rows.every((row) => !/long_serial_|switch-fixture|Settings test host/.test(row.text)), `${label}: no serial and no tracker name in a row`);
            assert.deepEqual(rows.slice(-4).map((row) => [row.name, row.chips[0], row.disabled]), [24, 25, 26, 27].map((index) => [`Fixture Device ${index}`, 'Offline', true]), `${label}: the offline phones last`);
            assert.ok(rows.slice(1, -4).every((row) => !row.disabled && row.chips[0] === 'Ready'), `${label}: the phones that can be opened between`);
            const offline = list.locator('button').last();
            assert.equal(await offline.locator('.phone-row-text').evaluate((el) => getComputedStyle(el).opacity), '0.5', `${label}: a row that cannot be opened is greyed`);
            assert.equal(await offline.locator('.kit-chip').evaluate((el) => getComputedStyle(el).opacity), '1', `${label}: its status stays readable`);
            if (!touch) {
                await offline.hover({ force: true });
                await page.waitForTimeout(250);
                assert.equal(await offline.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', `${label}: no hover on a row that cannot be opened`);
                await list.evaluate((el) => { el.scrollTop = 0; });
                await page.mouse.move(0, 0);
            }
            // The search field is the kit's field, one 44px row: it once took a 220px flex-basis as its height.
            const field = await root.locator('.device-switcher-search').boundingBox();
            const firstRow = await list.locator('button').first().boundingBox();
            assert.ok(Math.abs(field.height - 44) <= 1, `${label}: the search field is 44px tall, not ${field.height}`);
            assert.ok(field.height < firstRow.height, `${label}: search is shorter than a device row`);
            assert.equal(await search.evaluate((el) => el.matches('input.kit-field') && getComputedStyle(el).fontSize), '16px', `${label}: the search field is the kit field, at 16px`);
            assert.equal(await root.locator('.device-switcher-search svg.kit-icon').count(), 1, 'the search icon is the kit icon, not a text glyph');
            assert.ok(firstRow.height >= 56, `${label}: a row is at least 56px tall (${firstRow.height})`);
            const sizes = await root.evaluate((el) => [...new Set([...el.querySelectorAll('.kit-sheet-title, .phone-row-name, .phone-row-meta, .kit-chip')].map((node) => getComputedStyle(node).fontSize))].sort());
            assert.deepEqual(sizes.filter((size) => !['12px', '13px', '15px', '20px'].includes(size)), [], `${label}: the switcher's text is on the type scale`);
            assert.equal(await list.locator('button[aria-current="true"] .kit-chip').textContent(), 'Viewing', `${label}: the phone on screen is marked with a chip`);
            assert.doesNotMatch(await list.textContent(), /[→←]/, `${label}: no arrow glyph in a row`);
            assert.equal(await list.getAttribute('tabindex'), null, 'the list is not a tab stop of its own');
            // With a mouse and keyboard the search field has focus; a touch screen keeps its keyboard down.
            await page.waitForTimeout(80);
            assert.equal(await search.evaluate((el) => el === document.activeElement), !touch, `${label}: search focus on open`);
            const searchStart = await search.boundingBox();
            const headerStart = await root.locator('.kit-sheet-header').boundingBox();
            const listBox = await list.boundingBox();
            const beforeTouches = messages.filter((packet) => packet[0] === 2).length;
            if (touch)
                await gesture(
                    cdp,
                    { x: listBox.x + listBox.width / 2, y: listBox.y + listBox.height - 22 },
                    0,
                    -Math.min(190, listBox.height - 45),
                );
            else {
                await list.hover();
                await page.mouse.wheel(0, 450);
                await page.waitForTimeout(120);
            }
            assert(await list.evaluate((el) => el.scrollTop > 50), 'native gesture/wheel advances device rows');
            assert.equal((await search.boundingBox()).y, searchStart.y, 'search remains fixed while rows scroll');
            assert.equal(
                (await root.locator('.kit-sheet-header').boundingBox()).y,
                headerStart.y,
                'header remains fixed',
            );
            assert.equal(
                await root.locator('.kit-sheet-body').evaluate((el) => el.scrollTop),
                0,
                'only list scrolls',
            );
            assert.equal(
                await page.evaluate(() => scrollY + scrollX + document.scrollingElement.scrollTop),
                0,
                'background stays still',
            );
            // Reach the final disabled rows and confirm swiping from disabled button content also works.
            await list.evaluate((el) => {
                el.scrollTop = el.scrollHeight;
            });
            const maxTop = await list.evaluate((el) => el.scrollTop);
            const last = list.locator('button').last();
            await last.scrollIntoViewIfNeeded();
            const lastBox = await last.boundingBox();
            assert(
                lastBox.y >= listBox.y - 1 && lastBox.y + lastBox.height <= listBox.y + listBox.height + 1,
                'last row is reachable',
            );
            await page.screenshot({ path: path.join(OUT, label + '-last-device.png') });
            if (touch) {
                await gesture(
                    cdp,
                    { x: listBox.x + listBox.width / 2, y: listBox.y + 20 },
                    0,
                    Math.min(150, listBox.height - 45),
                );
                assert(
                    (await list.evaluate((el) => el.scrollTop)) < maxTop - 20,
                    'downward swipe scrolls back through disabled rows',
                );
                assert.equal(await root.count(), 1, 'list downward swipe does not dismiss sheet');
            }
            await search.fill('Device 27');
            await search.press('Enter');
            assert(
                await search.evaluate((el) => document.activeElement !== el),
                'Search action dismisses the phone keyboard',
            );
            // Focus stays in the dialog, where the sheet hears Escape; the page behind is inert.
            assert(
                await root.evaluate((el) => el.contains(document.activeElement)),
                `${label}: focus stays in the sheet when Search finds nothing to open`,
            );
            assert.equal(await list.locator('button').count(), 1, 'search filters without scrolling page');
            assert.equal(await list.evaluate((el) => el.scrollTop), 0, 'search resets list to its first result');
            await search.fill('no matching device');
            await page.getByText('No phones match your search.', { exact: true }).waitFor();
            await search.fill('');
            await page.waitForFunction(() => document.querySelectorAll('.device-switcher-list button').length === 28);
            await checkGeometry(page);
            assert.equal(
                messages.filter((packet) => packet[0] === 2).length,
                beforeTouches,
                'search/list gestures send no remote touch messages',
            );
            await page.getByRole('button', { name: 'Close Switch phone', exact: true }).click();
            await root.waitFor({ state: 'hidden' });
            assert(await trigger.evaluate((el) => document.activeElement === el), 'close restores focus to Switch');
            await trigger.click();
            await root.waitFor();
            await settle(page);
            assert.equal(await list.evaluate((el) => el.scrollTop), 0, 'reopening begins at top');
            // The browser's Back closes the sheet and leaves the page where it was.
            const address = await page.evaluate(() => location.href);
            await page.goBack();
            await root.waitFor({ state: 'hidden' });
            assert.equal(await page.evaluate(() => location.href), address, `${label}: Back closes the sheet and stays on the phone's page`);
            await trigger.click();
            await root.waitFor();
            await settle(page);
            // A bottom sheet is dragged down by its header. A dialog has no handle; Escape closes it.
            const handle = root.locator('.kit-sheet-handle');
            assert.equal(await handle.isVisible(), width < 600, `${label}: the handle shows on a bottom sheet only`);
            if (touch && width < 600) {
                const box = await handle.boundingBox();
                await gesture(cdp, { x: box.x + box.width / 2, y: box.y + 2 }, 0, 130);
            } else await page.keyboard.press('Escape');
            await root.waitFor({ state: 'hidden' });
            assert.equal(
                messages.filter((packet) => packet[0] === 2).length,
                beforeTouches,
                'header dismissal sends no remote touch messages',
            );
            // Positive control ensures the fake stream was actually receiving input throughout.
            if (touch) await page.locator('.touch-layer').tap();
            else await page.locator('.touch-layer').click();
            await page.waitForTimeout(50);
            assert(
                messages.filter((packet) => packet.length === 32 && packet[0] === 2).length >= beforeTouches + 2,
                'mock screen receives down/up after dismissal',
            );
            if (!touch) {
                // Keyboard only: the shortcut opens the sheet, typing filters, Enter opens the only match.
                // This page was opened with captureKeyboard=0, so the keys are the browser's.
                const udidOf = () => page.evaluate(() => new URLSearchParams(location.hash.slice(2)).get('udid'));
                const searchFocused = () => page.waitForFunction(() => document.activeElement?.type === 'search');
                await page.keyboard.press('Control+k');
                await root.waitFor();
                await settle(page);
                await searchFocused();
                await page.keyboard.type('Device 05');
                assert.equal(await list.locator('button').count(), 1, 'typing goes to the search field');
                await page.keyboard.press('Enter');
                await page.waitForFunction((udid) => new URLSearchParams(location.hash.slice(2)).get('udid') === udid, descriptors[5].udid);
                await root.waitFor({ state: 'hidden' });
                await page.getByText('Connected', { exact: true }).waitFor();
                // The link the switcher built captures the keyboard for the phone, as stream links
                // do by default. Ctrl+K then goes to the phone and the sheet stays closed.
                await page.locator('.touch-layer').waitFor({ state: 'visible' });
                await page.keyboard.press('Control+k');
                await page.waitForTimeout(150);
                assert.equal(await root.count(), 0, 'with keyboard capture on, Ctrl+K belongs to the phone');
                // Arrow keys move a highlight through the rows that can be opened; Enter opens it.
                await trigger.click();
                await root.waitFor();
                await settle(page);
                await searchFocused();
                const highlighted = () => list.locator('button.highlighted .phone-row-name').allTextContents();
                assert.deepEqual(await highlighted(), [], 'nothing is highlighted before an arrow key');
                await page.keyboard.press('ArrowDown');
                assert.deepEqual(await highlighted(), ['Fixture Device 00']);
                await page.keyboard.press('ArrowUp');
                assert.deepEqual(await highlighted(), ['Fixture Device 23'], 'ArrowUp wraps to the last row that can be opened, past the offline ones');
                assert.ok(await list.evaluate((el) => el.scrollTop > 50), 'the highlighted row is scrolled into view');
                await page.keyboard.press('ArrowDown');
                await page.keyboard.press('ArrowDown');
                assert.deepEqual(await highlighted(), ['Fixture Device 01']);
                assert.equal(await search.evaluate((el) => el === document.activeElement), true, 'focus stays in the search field');
                await page.keyboard.press('Enter');
                await page.waitForFunction((udid) => new URLSearchParams(location.hash.slice(2)).get('udid') === udid, descriptors[1].udid);
                await root.waitFor({ state: 'hidden' });
                await page.getByText('Connected', { exact: true }).waitFor();
                // Enter with several matches and no highlight opens nothing.
                await trigger.click();
                await root.waitFor();
                await settle(page);
                await searchFocused();
                await page.keyboard.type('Device 1');
                await page.keyboard.press('Enter');
                await page.waitForTimeout(80);
                assert.equal(await udidOf(), descriptors[1].udid, 'Enter does not guess among several matches');
                await page.keyboard.press('Escape');
                await root.waitFor({ state: 'hidden' });
            }
            await trigger.click();
            await root.waitFor();
            await settle(page);
            const lastAvailable = list.getByRole('button', { name: /Fixture Device 23/ });
            await lastAvailable.scrollIntoViewIfNeeded();
            await lastAvailable.click();
            await page.waitForFunction(
                (udid) => new URLSearchParams(location.hash.slice(2)).get('udid') === udid,
                descriptors[23].udid,
            );
            await root.waitFor({ state: 'hidden' });
            assert.deepEqual(errors, [], 'no runtime errors');
            await context.close();
            console.log(
                'PASS',
                label,
                'phone rows (current first, offline last and greyed), native list scroll, final row, kit search field, filtering, keyboard, Back, Close/drag and remote isolation',
            );
        }
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
