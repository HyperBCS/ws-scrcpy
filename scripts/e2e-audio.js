/* eslint-disable */
// Hardware check: serve scripts/fixtures/audio.html to the Android phone as TONE_URL.
// SERIAL=... TONE_URL=http://host:8099/audio.html BASE=http://host:8000 npm run test:audio
// Add DESKTOP=1 to exercise the mouse sidebar in a short desktop window.
// The selected device must use Capture audio + Device media + PCM (or AUDIO_CODEC=opus).
// Opens only the diagnostic page; never initiates a call. Measures actual browser output.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const SERIAL = process.env.SERIAL;
const TONE_URL = process.env.TONE_URL;
const BASE = process.env.BASE || 'http://127.0.0.1:8000';
const CODEC = process.env.AUDIO_CODEC || 'raw';
const DESKTOP = process.env.DESKTOP === '1';
assert(SERIAL && TONE_URL, 'Set SERIAL and TONE_URL to the served diagnostic audio fixture.');
const adb = (...args) => execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', timeout: 20000 });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function deviceButton(id) {
    adb('shell', 'uiautomator', 'dump', '/sdcard/ws-scrcpy-audio-test.xml');
    const xml = adb('shell', 'cat', '/sdcard/ws-scrcpy-audio-test.xml');
    const node = xml.match(new RegExp(`<node[^>]*resource-id="${id}"[^>]*>`))?.[0];
    const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    assert(bounds, `Diagnostic button ${id} must be visible on the device`);
    adb(
        'shell',
        'input',
        'tap',
        String(Math.round((+bounds[1] + +bounds[3]) / 2)),
        String(Math.round((+bounds[2] + +bounds[4]) / 2)),
    );
}
async function controls(page) {
    const fab = page.locator('.floating-toolbar-fab');
    if ((await fab.count()) && (await fab.getAttribute('aria-expanded')) !== 'true') await fab.click();
}
async function connected(page) {
    await page.waitForFunction(
        () => document.querySelector('.stream-header-status')?.textContent.includes('Connected'),
        undefined,
        { timeout: 45000 },
    );
    await page.locator('.touch-layer').waitFor({ state: 'visible' });
}
async function meter(page) {
    return page.evaluate(() =>
        window.__audioMeters.map(({ analyser, context }) => {
            const values = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(values);
            return {
                state: context.state,
                rms: Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length),
            };
        }),
    );
}
async function audible(page, label) {
    await page
        .waitForFunction(
            () =>
                window.__audioMeters.some(({ analyser, context }) => {
                    if (context.state !== 'running') return false;
                    const values = new Float32Array(analyser.fftSize);
                    analyser.getFloatTimeDomainData(values);
                    return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length) > 0.0002;
                }),
            undefined,
            { timeout: 15000 },
        )
        .catch(async (error) => {
            console.error(
                label,
                await meter(page),
                await page.locator('[data-control="audio"]').getAttribute('aria-description'),
                await page.evaluate(() => window.__sourceStats),
            );
            throw error;
        });
    assert.equal(await page.locator('[data-control="audio"]').getAttribute('data-audio-state'), 'playing');
    await page.waitForTimeout(300);
    const frequency = await page.evaluate(() => {
        const { analyser, context } = window.__audioMeters.find(({ context }) => context.state === 'running');
        const spectrum = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(spectrum);
        let strongest = 1;
        for (let i = 2; i < spectrum.length; i++) if (spectrum[i] > spectrum[strongest]) strongest = i;
        return (strongest * context.sampleRate) / analyser.fftSize;
    });
    assert(Math.abs(frequency - 440) < 40, `Captured diagnostic frequency: ${frequency} Hz`);
    console.log(label, await meter(page), `${frequency.toFixed(1)} Hz`);
}
async function quality(page) {
    // A sine obeys x[n] = 2*cos(w)*x[n-1] - x[n-2]. Gaps, overlaps and clicks
    // violate this even when RMS and the dominant frequency still look correct.
    const initial = await page.evaluate(() => ({ ...window.__sourceStats }));
    const residuals = [];
    for (let snapshot = 0; snapshot < 30; snapshot++) {
        residuals.push(
            await page.evaluate(() => {
                const { analyser, context } = window.__audioMeters.find(({ context }) => context.state === 'running');
                const values = new Float32Array(analyser.fftSize);
                analyser.getFloatTimeDomainData(values);
                const coefficient = 2 * Math.cos((2 * Math.PI * 440) / context.sampleRate);
                let energy = 0;
                let residual = 0;
                for (let i = 2; i < values.length; i++) {
                    energy += values[i] ** 2;
                    residual += (values[i] - coefficient * values[i - 1] + values[i - 2]) ** 2;
                }
                return energy > 0 ? Math.sqrt(residual / energy) : Infinity;
            }),
        );
        await page.waitForTimeout(40);
    }
    const stats = await page.evaluate(() => ({ ...window.__sourceStats }));
    const maximum = Math.max(...residuals);
    assert(maximum < 0.02, `Rendered tone has no substantial clicks/static (normalized residual ${maximum})`);
    assert(stats.sources - initial.sources > 20, 'Quality measurement covers live incoming audio chunks');
    assert.equal(stats.discontinuities, initial.discontinuities, 'Live chunks play without gaps or overlaps');
    console.log('Playback quality', { maximumResidual: maximum, chunks: stats.sources - initial.sources });
}
async function main() {
    adb('shell', 'input', 'keyevent', '224');
    adb('shell', 'input', 'keyevent', '82');
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', TONE_URL);
    await delay(2500);
    const browser = await chromium.launch({ headless: true });
    const errors = [];
    try {
        const context = await browser.newContext({
            viewport: DESKTOP ? { width: 1280, height: 600 } : { width: 390, height: 844 },
            isMobile: !DESKTOP,
            hasTouch: !DESKTOP,
        });
        await context.addInitScript(() => {
            window.__audioMeters = [];
            window.__sourceStats = { sources: 0, peak: 0, discontinuities: 0 };
            const previousEnd = new WeakMap();
            const start = AudioBufferSourceNode.prototype.start;
            AudioBufferSourceNode.prototype.start = function (...args) {
                window.__sourceStats.sources++;
                const end = previousEnd.get(this.context);
                if (end !== undefined && Math.abs(args[0] - end) > 0.000001) window.__sourceStats.discontinuities++;
                previousEnd.set(this.context, args[0] + (this.buffer?.duration || 0));
                if (this.buffer)
                    for (const value of this.buffer.getChannelData(0))
                        window.__sourceStats.peak = Math.max(window.__sourceStats.peak, Math.abs(value));
                return start.apply(this, args);
            };
            const connect = AudioNode.prototype.connect;
            AudioNode.prototype.connect = function (destination, ...args) {
                if (destination instanceof AudioDestinationNode) {
                    const analyser = this.context.createAnalyser();
                    analyser.fftSize = 4096;
                    analyser.smoothingTimeConstant = 0;
                    connect.call(this, analyser, ...args);
                    connect.call(analyser, destination);
                    window.__audioMeters.push({ analyser, context: this.context });
                    return destination;
                }
                return connect.call(this, destination, ...args);
            };
        });
        const page = await context.newPage();
        let audioMetadata;
        page.on('websocket', (socket) =>
            socket.on('framereceived', ({ payload }) => {
                if (
                    Buffer.isBuffer(payload) &&
                    payload.subarray(0, 14).toString() === 'scrcpy_audio_2' &&
                    payload[14] === 2
                ) {
                    audioMetadata = JSON.parse(payload.subarray(23).toString());
                }
            }),
        );
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(BASE);
        const card = page.locator('.device').filter({ hasText: SERIAL });
        await card.locator('a.desc-block.stream').first().click();
        await connected(page);
        await deviceButton('tone');
        await controls(page);
        const sound = page.locator('[data-control="audio"]');
        if (DESKTOP) {
            assert.equal(await page.locator('.floating-toolbar-fab').count(), 0, 'Desktop uses its sidebar');
            const bounds = await sound.boundingBox();
            assert(
                bounds && bounds.y >= 0 && bounds.y + bounds.height <= 600,
                'Sound is visible without scrolling the desktop sidebar',
            );
        }
        await page.waitForFunction(
            () => document.querySelector('[data-control="audio"]')?.getAttribute('data-audio-state') === 'muted',
        );
        assert.equal((await meter(page)).length, 0, 'No AudioContext allocated before listening');
        assert.equal(audioMetadata?.codec, CODEC, 'Device sends the requested audio codec');
        if (CODEC === 'raw' && !(await page.evaluate(() => isSecureContext))) {
            assert.equal(
                await page.evaluate(() => typeof AudioDecoder),
                'undefined',
                'Insecure mobile playback exercises PCM without WebCodecs',
            );
        }
        await sound.click();
        await audible(page, `${CODEC} real device output`);
        await quality(page);
        await sound.click();
        await page.waitForTimeout(400);
        assert(
            (await meter(page)).every((m) => m.state !== 'running' || m.rms < 0.0001),
            'Mute silences browser output',
        );
        await sound.click();
        await audible(page, 'Unmute resumes live audio');
        // A viewer joining after initial audio config must also be able to play.
        const second = await context.newPage();
        second.on('pageerror', (error) => errors.push(error.message));
        await second.goto(page.url());
        await connected(second);
        await controls(second);
        await second.locator('[data-control="audio"]').click();
        await audible(second, 'Late viewer output');
        await second.close();
        await page.bringToFront();
        await connected(page);
        await page.reload();
        await connected(page);
        await controls(page);
        await page.locator('[data-control="audio"]').click();
        await audible(page, 'Reloaded viewer output');
        assert.deepEqual(errors, [], 'No browser runtime exceptions');
        console.log('PASS hardware audio: output, mute/unmute, late viewer, reload');
    } finally {
        await browser.close();
        await deviceButton('stop').catch((error) => console.error('Stop diagnostic tone:', error.message));
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
