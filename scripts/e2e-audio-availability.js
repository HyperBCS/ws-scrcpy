/* eslint-disable */
// BASE=http://127.0.0.1:8000 node scripts/e2e-audio-availability.js
// Every WebSocket is mocked. Checks desktop Sound access and recovery when audio cannot load,
// without reaching hardware, changing its capture settings, or requiring browser WebCodecs.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, UDID } = require('./e2e-settings');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mode of ['unsupported-browser', 'failed-audio-chunk', 'unknown-sdk', 'old-android']) {
            const context = await browser.newContext({ viewport: { width: 1280, height: 600 } });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            if (mode === 'unsupported-browser') {
                await context.addInitScript(() => {
                    Object.defineProperty(globalThis, 'AudioContext', { value: undefined });
                    Object.defineProperty(globalThis, 'webkitAudioContext', { value: undefined });
                });
            }
            let audioChunkBlocked = false;
            if (mode === 'failed-audio-chunk') {
                await page.route('**/*.js*', async (route) => {
                    const response = await route.fetch();
                    // Match an AudioPlayer-only string rather than a development chunk name;
                    // this also catches the content-hashed/minified production audio chunk.
                    if ((await response.text()).includes('Could not play device audio:')) {
                        audioChunkBlocked = true;
                        return route.abort('failed');
                    }
                    return route.fulfill({ response });
                });
            }
            await fixture(page, { sdk: mode === 'unknown-sdk' ? '' : mode === 'old-android' ? '29' : '37' });
            const socket = new URL('/__settings_fixture__', BASE);
            socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = new URL(BASE);
            url.hash = `!${new URLSearchParams({
                action: 'stream',
                udid: UDID,
                player: 'mse',
                ws: socket.toString(),
                captureKeyboard: '0',
            })}`;
            await page.goto(url.toString());
            const sound = page.locator('[data-control="audio"]');
            await sound.waitFor();
            const bounds = await sound.boundingBox();
            assert(
                bounds && bounds.y >= 0 && bounds.y + bounds.height <= 600,
                mode + ': Sound is visible without scrolling the desktop sidebar',
            );
            // The fixture sends a capture error so the action opens recovery Settings even in
            // browsers where playback is supported. Missing-runtime paths do the same.
            await page.waitForFunction(() =>
                ['error', 'unsupported'].includes(
                    document.querySelector('[data-control="audio"]')?.getAttribute('data-audio-state'),
                ),
            );
            await sound.click();
            await page.locator('.bottom-sheet-root.open').waitFor();
            await page.waitForFunction(
                () =>
                    !document
                        .querySelector('.bottom-sheet-root.open')
                        ?.textContent.includes('Loading current device settings'),
            );
            const section = page.locator('.settings-audio');
            const text = await section.textContent();
            const capture = section.locator('input[type="checkbox"]');
            const source = section.locator('select').first();
            if (mode === 'unknown-sdk') {
                assert.equal(
                    await source.isDisabled(),
                    false,
                    'A missing SDK property cannot falsely disable a current Android device',
                );
                assert(!text.includes('requires Android 11'));
            } else {
                assert.equal(await source.isDisabled(), true);
                assert.equal(
                    await capture.isDisabled(),
                    false,
                    'Enabled capture can be turned off even when browser playback is unavailable',
                );
                await capture.click();
                assert.equal(await capture.isChecked(), false);
                assert.equal(await capture.isDisabled(), true);
                if (mode === 'old-android') {
                    assert(text.includes('Android API 29') && text.includes('requires Android 11'), text);
                } else {
                    assert.equal(await section.getByRole('button', { name: 'Reload page' }).count(), 1);
                    assert(!text.includes('requires Android 11'), 'A runtime failure is not a device version failure');
                    if (mode === 'unsupported-browser') {
                        assert(text.includes('does not provide Web Audio'), text);
                    } else {
                        assert(audioChunkBlocked, 'The fixture must abort the actual audio chunk');
                        assert(text.includes('Sound could not load'), text);
                    }
                }
            }
            assert.deepEqual(errors, [], 'Audio capability failures must not crash the app');
            console.log('PASS', mode, JSON.stringify({ soundY: bounds.y, soundBottom: bounds.y + bounds.height }));
            await context.close();
        }
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
