/* eslint-disable */
// BASE=http://127.0.0.1:8000 E2E_OUT=/tmp/ws-scrcpy-switcher node scripts/e2e-switcher.js
// All sockets are intercepted; native touch scrolls real device-row buttons without hardware input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { fixture, UDID } = require('./e2e-settings');
const { gesture, initialStreamPacket, settle } = require('./e2e-sheets');
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
async function checkGeometry(page) {
    const result = await page.locator('.bottom-sheet-root.open').evaluate((root) => {
        const list = root.querySelector('.device-switcher-list');
        const body = root.querySelector('.bottom-sheet-body');
        const panel = root.querySelector('.bottom-sheet');
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
            const root = page.locator('.bottom-sheet-root.open');
            await root.waitFor();
            await settle(page);
            const list = root.locator('.device-switcher-list');
            const search = page.getByRole('searchbox', { name: 'Find a device to switch to' });
            await page.waitForFunction(() => document.querySelectorAll('.device-switcher-list button').length === 28);
            await checkGeometry(page);
            // The search field is one 48px row: it used to take a 220px flex-basis as its height.
            const field = await root.locator('.device-switcher-search').boundingBox();
            const firstRow = await list.locator('button').first().boundingBox();
            assert.ok(Math.abs(field.height - 48) <= 1, `${label}: the search field is 48px tall, not ${field.height}`);
            assert.ok(field.height < firstRow.height, `${label}: search is shorter than a device row`);
            assert.equal(await root.locator('.device-switcher-search svg').count(), 1, 'the search icon is drawn, not a text glyph');
            assert.equal(await list.getAttribute('tabindex'), null, 'the list is not a tab stop of its own');
            // With a mouse and keyboard the search field has focus; a touch screen keeps its keyboard down.
            await page.waitForTimeout(80);
            assert.equal(await search.evaluate((el) => el === document.activeElement), !touch, `${label}: search focus on open`);
            const searchStart = await search.boundingBox();
            const headerStart = await root.locator('.bottom-sheet-header').boundingBox();
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
                (await root.locator('.bottom-sheet-header').boundingBox()).y,
                headerStart.y,
                'header remains fixed',
            );
            assert.equal(
                await root.locator('.bottom-sheet-body').evaluate((el) => el.scrollTop),
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
            assert.equal(await list.locator('button').count(), 1, 'search filters without scrolling page');
            assert.equal(await list.evaluate((el) => el.scrollTop), 0, 'search resets list to its first result');
            await search.fill('no matching device');
            await page.getByText('No devices match your search.', { exact: true }).waitFor();
            await search.fill('');
            await page.waitForFunction(() => document.querySelectorAll('.device-switcher-list button').length === 28);
            await checkGeometry(page);
            assert.equal(
                messages.filter((packet) => packet[0] === 2).length,
                beforeTouches,
                'search/list gestures send no remote touch messages',
            );
            await page.getByRole('button', { name: 'Close Switch device', exact: true }).click();
            await root.waitFor({ state: 'hidden' });
            assert(await trigger.evaluate((el) => document.activeElement === el), 'close restores focus to Switch');
            await trigger.click();
            await root.waitFor();
            await settle(page);
            assert.equal(await list.evaluate((el) => el.scrollTop), 0, 'reopening begins at top');
            if (touch) {
                const handle = await root.locator('.bottom-sheet-handle').boundingBox();
                await gesture(cdp, { x: handle.x + handle.width / 2, y: handle.y + 2 }, 0, 130);
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
                const highlighted = () => list.locator('button.highlighted strong').allTextContents();
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
                'native list scroll, final row, 48px sticky search, filtering, keyboard, Close/drag and remote isolation',
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
