/* eslint-disable */
// BASE=http://127.0.0.1:8000 E2E_OUT=/tmp/ws-scrcpy-sheets node scripts/e2e-sheets.js
// Every socket is mocked. Native CDP touch events exercise browser gesture arbitration;
// the deferred Apply reply never reaches a device or changes real configuration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { fixture, UDID, ENCODER } = require('./e2e-settings');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-sheets';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(page) {
    await page
        .locator('.bottom-sheet')
        .evaluateAll((panels) =>
            Promise.all(panels.flatMap((panel) => panel.getAnimations().map((animation) => animation.finished))),
        );
}
async function gesture(cdp, { x, y }, dx, dy, end = 'touchEnd', during) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y, force: 1 }] });
    for (let step = 1; step <= 10; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ id: 1, x: x + (dx * step) / 10, y: y + (dy * step) / 10, force: 1 }],
        });
        await pause(16);
    }
    if (during) await during();
    await cdp.send('Input.dispatchTouchEvent', { type: end, touchPoints: [] });
}
async function handlePoint(page, fromHeader = false) {
    const box = await page
        .locator('.bottom-sheet-root.open ' + (fromHeader ? '.bottom-sheet-title' : '.bottom-sheet-handle'))
        .boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function assertResting(page, label) {
    await settle(page);
    const result = await page.locator('.bottom-sheet-root.open').evaluate((root) => {
        const panel = root.querySelector('.bottom-sheet');
        const body = root.querySelector('.bottom-sheet-body');
        body.scrollLeft = 100;
        return {
            dragging: root.classList.contains('dragging'),
            offset: panel.style.getPropertyValue('--sheet-drag-y'),
            width: body.clientWidth,
            scrollWidth: body.scrollWidth,
            x: body.scrollLeft,
        };
    });
    assert.equal(result.dragging, false, label + ': drag state cleared');
    assert.equal(result.offset, '', label + ': transform reset');
    assert.equal(result.x, 0, label + ': no horizontal scrolling');
    assert(result.scrollWidth <= result.width + 1, label + ': content fits');
}
function initialStreamPacket() {
    const packet = Buffer.alloc(186);
    packet.write('scrcpy_initial');
    packet.write('Sheet touch fixture', 14);
    packet.writeInt32BE(1, 78);
    packet.writeInt32BE(720, 86);
    packet.writeInt32BE(1280, 90);
    packet.writeInt32BE(25, 110);
    packet.writeInt32BE(720, 122);
    packet.writeInt32BE(1280, 126);
    packet.writeInt32BE(720, 130);
    packet.writeInt32BE(1280, 134);
    packet.writeInt32BE(35, 139);
    packet.writeInt32BE(4000000, 143);
    packet.writeInt32BE(60, 147);
    packet.writeInt8(1, 151);
    packet.writeInt8(-1, 165);
    packet.writeInt32BE(1, 182);
    return packet;
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
            let completeApply;
            let sendAudioError;
            const remotePackets = [];
            await fixture(page, {
                initialPacket: initialStreamPacket(),
                onStreamMessage: (packet) => remotePackets.push(Buffer.from(packet)),
                onStreamReady: (controls) => {
                    sendAudioError = controls.sendAudioError;
                },
                onApply: (command, reply) => {
                    completeApply = () =>
                        reply({
                            id: command.id,
                            type: command.type,
                            data: { udid: UDID, error: 'Fixture failure releases the dismissal lock.' },
                        });
                },
            });
            await page.goto(BASE);
            const original = page.locator('.device').filter({ hasText: UDID });
            await original.waitFor();
            await original.evaluate((card) => {
                card.dataset.sheetTarget = 'true';
                const scroller = document.querySelector('#devices');
                // Clone until the list really scrolls: the card layout is compact and multi-column,
                // so a fixed filler count stops scrolling on a large window.
                for (let i = 0; i < 80 && scroller.scrollHeight < scroller.clientHeight + 400; i++) {
                    const filler = card.cloneNode(true);
                    filler.removeAttribute('data-sheet-target');
                    filler.setAttribute('aria-hidden', 'true');
                    filler.inert = true;
                    filler.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
                    card.parentElement.insertBefore(filler, card);
                }
            });
            const trigger = page.locator('[data-sheet-target] button').filter({ hasText: 'Settings' });
            await trigger.scrollIntoViewIfNeeded();
            const list = page.locator('#devices');
            const savedTop = await list.evaluate((el) => el.scrollTop);
            assert(savedTop > 100, 'fixture starts on a scrolled real component');
            const open = async () => {
                await trigger.click();
                await page.locator('.bottom-sheet-root.open').waitFor();
                await page.waitForFunction(
                    (value) => document.querySelector('.settings-encoder-row select')?.value === value,
                    ENCODER,
                );
                await settle(page);
            };
            const closed = async () => {
                await page.locator('.bottom-sheet-root.open').waitFor({ state: 'hidden' });
                assert.equal(
                    await list.evaluate((el) => el.scrollTop),
                    savedTop,
                    'closing restores background position',
                );
                assert.equal(
                    await trigger.evaluate((el) => document.activeElement === el),
                    true,
                    'closing restores trigger focus',
                );
                assert.equal(
                    await page.locator('body').evaluate((el) => el.classList.contains('sheet-open')),
                    false,
                    'closing releases background scroll lock',
                );
            };
            await open();
            const close = page.getByRole('button', { name: 'Close Settings', exact: true });
            const closeBox = await close.boundingBox();
            const iconBox = await close.locator('svg').boundingBox();
            assert(closeBox.width >= 48 && closeBox.height >= 48, 'close has a48px target');
            assert(iconBox.width === 24 && iconBox.height === 24, 'close icon is clearly visible');
            assert.equal(
                await page.locator('.bottom-sheet-handle').isVisible(),
                touch,
                'only bottom sheets expose the drag affordance',
            );
            await page.screenshot({ path: path.join(OUT, label + '-popup.png') });
            if (touch) await page.touchscreen.tap(closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2);
            else await close.click();
            await closed();
            await open();
            if (touch) {
                const panel = page.locator('.bottom-sheet-root.open .bottom-sheet');
                const originalTop = (await panel.boundingBox()).y;
                await gesture(cdp, await handlePoint(page), 0, 32, 'touchEnd', async () => {
                    assert((await panel.boundingBox()).y > originalTop + 25, 'drag visibly follows the finger');
                });
                await assertResting(page, 'short drag');
                await gesture(cdp, await handlePoint(page, true), 0, 125, 'touchCancel');
                await assertResting(page, 'native pointer cancellation');
                await gesture(cdp, await handlePoint(page), 70, 20);
                await assertResting(page, 'horizontal drag');
                await page
                    .locator('.settings-advanced')
                    .first()
                    .evaluate((el) => {
                        el.open = true;
                    });
                const body = page.locator('.bottom-sheet-root.open .bottom-sheet-body');
                const bodyBox = await body.boundingBox();
                await gesture(cdp, { x: width / 2, y: bodyBox.y + Math.min(bodyBox.height - 110, 230) }, 0, -90);
                assert(await body.evaluate((el) => el.scrollTop > 20), 'body gesture scrolls its content');
                await assertResting(page, 'body scroll');
                assert.equal(
                    await list.evaluate((el) => el.scrollTop),
                    savedTop,
                    'body gesture leaves background still',
                );
                await gesture(cdp, await handlePoint(page, true), 0, 130);
                await closed();
                await open();
            }
            await page.getByRole('button', { name: /Data saver/ }).click();
            await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
            await page.getByRole('button', { name: 'Apply & restart', exact: true }).click();
            await page
                .getByText('Saving settings… The screen will reconnect automatically.', { exact: true })
                .waitFor();
            assert(await close.isDisabled(), 'Apply disables Close');
            if (touch) {
                await gesture(cdp, await handlePoint(page), 0, 140);
                await assertResting(page, 'locked Apply drag');
                await page.touchscreen.tap(closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2);
            }
            await page.keyboard.press('Escape');
            await page.locator('.bottom-sheet-root.open .bottom-sheet-backdrop').dispatchEvent('click');
            assert.equal(
                await page.locator('.bottom-sheet-root.open').count(),
                1,
                'Apply ignores Escape/backdrop/close',
            );
            assert(completeApply, 'Apply reached only fixture');
            completeApply();
            await page.locator('.settings-sheet-apply-bar [role="alert"]').waitFor();
            await close.click();
            await closed();
            // The same popup over a live-shaped mock stream must never emit remote touches.
            const socket = new URL('/__settings_fixture__', BASE);
            socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = new URL(BASE);
            url.hash = `!${new URLSearchParams({ action: 'stream', udid: UDID, player: 'webcodecs', ws: socket.toString(), captureKeyboard: '0', fitToScreen: '1' })}`;
            await page.goto(url.toString());
            await page.getByText('Connected', { exact: true }).waitFor();
            const canvas = page.locator('.touch-layer');
            await canvas.waitFor({ state: 'visible' });
            await canvas.evaluate((el) => {
                window.sheetTestCanvas = el;
            });
            assert(sendAudioError, 'stream fixture exposes controlled audio status');
            sendAudioError();
            await page.locator('.stream-notice').waitFor();
            assert(
                await canvas.evaluate((el) => el === window.sheetTestCanvas && el.isConnected),
                'notice insertion preserves the actual remote canvas',
            );
            await page.getByRole('button', { name: 'Dismiss message', exact: true }).click();
            await page.locator('.stream-notice').waitFor({ state: 'hidden' });
            assert(
                await canvas.evaluate((el) => el === window.sheetTestCanvas && el.isConnected),
                'notice dismissal preserves the actual remote canvas',
            );
            if (touch) await page.getByRole('button', { name: 'Show controls', exact: true }).click();
            await page.getByRole('button', { name: 'Settings', exact: true }).click();
            await page.locator('.bottom-sheet-root.open').waitFor();
            await settle(page);
            const touchesBefore = remotePackets.filter((packet) => packet[0] === 2).length;
            if (touch) await gesture(cdp, await handlePoint(page), 0, 130);
            else await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
            await page.locator('.bottom-sheet-root.open').waitFor({ state: 'hidden' });
            assert.equal(
                remotePackets.filter((packet) => packet[0] === 2).length,
                touchesBefore,
                'popup gestures send no remote touches',
            );
            if (touch) await canvas.tap();
            else await canvas.click();
            await pause(50);
            assert(
                remotePackets.filter((packet) => packet.length === 32 && packet[0] === 2).length >= touchesBefore + 2,
                'positive control: exposed mock screen receives touch down/up after the popup closes',
            );
            assert.deepEqual(errors, [], 'no browser runtime errors');
            await context.close();
            console.log(
                'PASS',
                label,
                'close, drag/cancel, scroll/focus restoration, Apply lock and remote touch isolation',
            );
        }
    } finally {
        await browser.close();
    }
}
module.exports = { gesture, initialStreamPacket, settle };
if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
