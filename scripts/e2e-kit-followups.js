// Run only through test-browser.js. Ordinary pages use production BASE; demo cases use KIT_BASE.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { fixture, UDID } = require('./e2e-settings');
const { settleMotion } = require('./ui-motion');
if (!process.env.BASE || !process.env.KIT_BASE) throw Error('Run node scripts/test-browser.js kit-followups');
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-kit-followups';
const config = { bitrate: 3500000, maxFps: 60, maxSize: 1280, iFrameInterval: 10,
    videoCodec: 'h264', videoEncoder: '', audio: true, audioCodec: 'raw', audioSource: 'output' };
const selected = process.env.KIT_FOLLOWUP_ONLY;
const run = (name) => !selected || selected.split(',').includes(name);
async function ids(page) {
    const duplicates = await page.locator('[id]').evaluateAll(nodes => {
        const ids = nodes.map(node => node.id);
        return ids.filter((id, index) => ids.indexOf(id) !== index);
    });
    assert.deepEqual(duplicates, [], 'all DOM ids remain unique');
}
async function production(browser) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
        const page = await context.newPage();
        let streams = 0;
        await page.routeWebSocket('**', socket => {
            if (/proxy-adb|stream-coredevice/.test(socket.url())) streams++;
        });
        for (const suffix of ['#!action=kit', '?kit=1&development=1#!action=kit']) {
            await page.goto(BASE + suffix);
            await page.waitForFunction(() => document.querySelector('#devices') || document.querySelector('.kit-page'));
            assert.equal(await page.locator('.kit-page').count(), 0, 'normal production never renders the demo');
            await page.locator('#devices').waitFor();
            assert.equal(await page.locator('.stream-mount').count(), 0);
        }
        assert.equal(streams, 0, 'a production kit address opens no phone stream');
        console.log('PASS production demo route falls back to Phones, zero streams');
    } finally { await context.close(); }
}
async function lifecycle(browser) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.routeWebSocket('**', () => {});
        await page.goto(process.env.KIT_BASE + '#!action=kit');
        await page.getByRole('button', { name: 'Open lifecycle sheet', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Lifecycle', exact: true });
        await settleMotion(page);
        await dialog.getByRole('button', { name: 'Toggle child', exact: true }).click();
        await dialog.getByRole('button', { name: 'Child count 0', exact: true }).click();
        await dialog.getByRole('button', { name: 'Child count 1', exact: true }).waitFor();
        await ids(page);
        // Hold the first scheduled resize frame for 50ms. Sample painted frames throughout:
        // growth/shrink must stay monotonic, including when a callback is delivered late.
        for (const source of ['parent', 'child', 'external', 'image', 'font']) for (const growing of [true, false, true]) {
            const samples = await page.evaluate(async ({ growing, source }) => {
                const card = document.querySelector(source === 'parent' ? '.lifecycle-height' : source === 'child' ? '.lifecycle-child-height' : `.lifecycle-${source}-height`);
                const original = window.requestAnimationFrame;
                const cancel = window.cancelAnimationFrame;
                const pending = new Map();
                let next = 1000000;
                const values = [card.getBoundingClientRect().height];
                window.requestAnimationFrame = callback => {
                    const id = next++;
                    const record = {};
                    pending.set(id, record);
                    record.timer = setTimeout(() => {
                        record.frame = original(time => { pending.delete(id); callback(time); });
                    }, 50);
                    return id;
                };
                window.cancelAnimationFrame = id => {
                    const record = pending.get(id);
                    if (record) { clearTimeout(record.timer); cancel(record.frame); pending.delete(id); }
                    else cancel(id);
                };
                if (source === 'image') {
                    document.querySelector('.lifecycle-image').src = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="${growing ? 120 : 40}"/>`);
                } else if (source === 'font') {
                    document.querySelector('.lifecycle-font').style.fontSize = growing ? 'var(--font-size-24)' : 'var(--font-size-13)';
                } else if (source === 'external') {
                    // No Preact render: model an externally loaded image/font changing size.
                    document.querySelector('.lifecycle-external').style.height = growing ? '120px' : '40px';
                } else {
                    const label = source === 'parent' ? (growing ? 'Grow rows' : 'Shrink rows') : (growing ? 'Grow child rows' : 'Shrink child rows');
                    Array.from(document.querySelectorAll('dialog[open] button')).find(node => node.textContent === label).click();
                }
                for (let index = 0; index < 24; index++) {
                    await new Promise(resolve => original(() => setTimeout(resolve, 0)));
                    values.push(card.getBoundingClientRect().height);
                }
                for (const id of pending.keys()) window.cancelAnimationFrame(id);
                window.requestAnimationFrame = original;
                window.cancelAnimationFrame = cancel;
                return values;
            }, { growing, source });
            console.log('HEIGHT_FRAMES', source, growing, JSON.stringify(samples));
            for (let index = 1; index < samples.length; index++) {
                assert(growing ? samples[index] >= samples[index - 1] - 0.6 : samples[index] <= samples[index - 1] + 0.6,
                    `height moves in one direction through delayed resize: ${JSON.stringify(samples)}`);
            }
            await settleMotion(page);
            await natural(dialog.locator(source === 'parent' ? '.lifecycle-height' : source === 'child' ? '.lifecycle-child-height' : `.lifecycle-${source}-height`));
        }
        for (const source of ['parent', 'child']) {
        const interrupted = await page.evaluate(async (source) => {
            const card = document.querySelector(source === 'parent' ? '.lifecycle-height' : '.lifecycle-child-height');
            const click = text => Array.from(document.querySelectorAll('dialog[open] button')).find(node => node.textContent === text).click();
            const start = card.getBoundingClientRect().height;
            click(source === 'parent' ? 'Shrink rows' : 'Shrink child rows');
            await new Promise(resolve => setTimeout(resolve, 80));
            const before = card.getBoundingClientRect().height;
            click(source === 'parent' ? 'Grow rows' : 'Grow child rows');
            await Promise.resolve(); await Promise.resolve();
            return { start, before, after: card.getBoundingClientRect().height };
        }, source);
        console.log('HEIGHT_INTERRUPTED', source, JSON.stringify(interrupted));
        assert(interrupted.before < interrupted.start - 1, 'shrink reached an intermediate frame');
        assert(Math.abs(interrupted.after - interrupted.before) < 1, 'reversed growth starts at the actual intermediate height');
        await settleMotion(page);
        await natural(dialog.locator(source === 'parent' ? '.lifecycle-height' : '.lifecycle-child-height'));
        }
        for (let index = 0; index < 3; index++) {
            await dialog.getByRole('button', { name: 'Arm lifecycle prompt', exact: true }).click();
            await dialog.getByRole('alertdialog', { name: 'Change this example?' }).waitFor();
            await ids(page);
            await page.keyboard.press('Escape');
            assert.equal(await dialog.isVisible(), true, 'Escape cancels the prompt first');
        }
        await dialog.getByRole('button', { name: 'Arm floating prompt', exact: true }).click();
        await page.locator('.kit-sheet-above .kit-confirm').filter({ hasText: 'Change floating example?' }).waitFor();
        await ids(page);
        await page.getByRole('alertdialog', { name: 'Change floating example?', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await dialog.isVisible(), true, 'a prompt in the separate AboveSheet root cancels before the sheet');
        const before = await page.evaluate(() => history.state.nav.index);
        await dialog.getByRole('button', { name: 'Close Lifecycle', exact: true }).click();
        // Reverse an exit without remounting the child.
        await page.evaluate(() => document.querySelector('[data-kit-section="Sheet lifecycle"] .kit-demo-specimen > button').click());
        await dialog.waitFor();
        await settleMotion(page);
        await dialog.getByRole('button', { name: 'Child count 1', exact: true }).waitFor();
        for (const source of ['parent', 'child', 'external', 'image', 'font']) await natural(dialog.locator(source === 'parent' ? '.lifecycle-height' : `.lifecycle-${source}-height`));
        await ids(page);
        await page.screenshot({ path: path.join(OUT, 'lifecycle-retained-desktop-light.png') });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => history.state.nav.index), before - 1, 'closing removes the overlay history entry');
        assert.deepEqual(errors, []);
        console.log('PASS sheet child ids/state, ancestor updates, prompts, retained exit/reopen and history');
    } finally { await context.close(); }
}
async function motion(browser) {
    for (const reducedMotion of ['no-preference', 'reduce']) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion });
        try {
            const page = await context.newPage();
            await page.routeWebSocket('**', () => {});
            await page.goto(process.env.KIT_BASE + '#!action=kit');
            await page.evaluate(() => {
                window.__panels = [];
                const animate = Element.prototype.animate;
                Element.prototype.animate = function(frames, options) {
                    const animation = animate.call(this, frames, options);
                    if (this.classList.contains('kit-sheet-panel')) {
                        window.__panels.push({ frames, animation });
                        animation.pause();
                    }
                    return animation;
                };
            });
            await page.getByRole('button', { name: 'Docked sheet', exact: true }).click();
            const dialog = page.getByRole('dialog', { name: 'Beside the screen', exact: true });
            await dialog.waitFor();
            const entrance = await page.evaluate(() => window.__panels.map(item => item.frames));
            if (reducedMotion === 'reduce') assert.deepEqual(entrance, []);
            else {
                assert.equal(entrance.at(-1)[0].transform, 'translateX(100%)', 'docked entrance slides from the right');
                assert.equal(entrance.at(-1)[1].transform, 'none');
            }
            await page.evaluate(() => window.__panels.forEach(item => item.animation.finish()));
            await dialog.getByRole('button', { name: 'Close Beside the screen', exact: true }).click();
            if (reducedMotion !== 'reduce') {
                const exit = await page.evaluate(() => window.__panels.at(-1).frames);
                assert.equal(exit.at(-1).transform, 'translateX(100%)', 'docked exit slides right');
                await page.evaluate(() => window.__panels.forEach(item => item.animation.finish()));
            }
            await dialog.waitFor({ state: 'hidden' });
        } finally { await context.close(); }
    }
    console.log('PASS docked entrance/exit slide and reduced motion');
}
async function natural(card) {
    const size = await card.evaluate(node => {
        const style = getComputedStyle(node);
        const inner = node.firstElementChild.getBoundingClientRect().height;
        const extra = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + parseFloat(style[key]), 0);
        return { outer: node.getBoundingClientRect().height, inner, extra, inline: node.style.height };
    });
    assert(Math.abs(size.outer - size.inner - size.extra) < 0.6, `natural card height: ${JSON.stringify(size)}`);
    return size;
}
async function settings(browser) {
    for (const colorScheme of (process.env.KIT_FOLLOWUP_THEME ? [process.env.KIT_FOLLOWUP_THEME] : ['light', 'dark'])) {
        assert(['light', 'dark'].includes(colorScheme), 'known fixture theme');
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme, reducedMotion: colorScheme === 'dark' ? 'reduce' : 'no-preference', serviceWorkers: 'block' });
        try {
            await context.addInitScript(() => {
                const Native = window.ResizeObserver;
                const animate = Element.prototype.animate;
                window.__heightFrames = [];
                Element.prototype.animate = function(frames, options) {
                    if (this.classList.contains('auto-height')) window.__heightFrames.push(frames);
                    return animate.call(this, frames, options);
                };
                const pending = new Map();
                window.__holdHeights = false;
                window.__releaseHeights = () => {
                    window.__holdHeights = false;
                    for (const [callback, entries] of pending) callback(entries);
                    pending.clear();
                };
                window.ResizeObserver = class extends Native {
                    constructor(callback) {
                        super((entries, observer) => {
                            if (window.__holdHeights && entries.some(entry => entry.target.parentElement?.classList.contains('auto-height'))) {
                                pending.set(callback, entries);
                            } else callback(entries, observer);
                        });
                    }
                };
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            let answer;
            let instant = false;
            let updates = 0;
            await fixture(page, {
                onEncoders: (command, reply) => {
                    answer = () => reply({ id: command.id, type: command.type, data: { udid: UDID, encoders: [], config } });
                    if (instant) answer();
                },
                onApply: (command, reply) => { updates++; reply({ id: command.id, type: command.type, data: { udid: UDID, error: 'fixture refused' } }); },
            });
            await page.goto(BASE);
            const open = async (waitForLoading = true) => {
                await page.locator(`[data-device-key$=":${UDID}"]`).first().getByRole('button', { name: /Settings/ }).click();
                const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
                await dialog.waitFor();
                if (waitForLoading) await dialog.getByText('Loading settings…', { exact: true }).waitFor();
                return dialog;
            };
            let dialog = await open();
            await settleMotion(page);
            const card = dialog.locator('.settings-quality .auto-height');
            const loading = await natural(card);
            // Deliver ready content while a ResizeObserver delivery is held. The wrapper must
            // return to natural layout even when the initial resize notification is coalesced.
            await page.evaluate(() => { window.__holdHeights = true; });
            answer();
            await dialog.getByRole('radio', { name: 'Balanced', exact: true }).waitFor();
            await dialog.getByText('Loading settings…', { exact: true }).waitFor({ state: 'hidden' });
            await settleMotion(page);
            const ready = await natural(card);
            console.log('QUALITY', colorScheme, JSON.stringify({ loading, ready }));
            assert(loading.outer > ready.outer, 'loading row really left the card');
            const frames = await page.evaluate(() => window.__heightFrames);
            if (colorScheme === 'light') assert(frames.some(pair => parseFloat(pair[0].height) > parseFloat(pair[1].height)), 'normal shrink still animates');
            else assert.deepEqual(frames, [], 'reduced motion uses natural size without height animations');
            await page.evaluate(() => window.__releaseHeights());
            const balanced = dialog.getByRole('radio', { name: 'Balanced', exact: true });
            await balanced.focus();
            for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End', 'ArrowLeft']) await page.keyboard.press(key);
            assert.equal(updates, 0, 'arrows move focus without applying a preset');
            assert.equal(await balanced.isChecked(), true, 'arrows preserve current selected quality');
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('Enter');
            await dialog.getByText('Could not apply changes: fixture refused', { exact: true }).waitFor();
            assert.equal(updates, 1, 'Enter applies once');
            assert.equal(await balanced.isChecked(), true, 'failure preserves selected quality');
            await dialog.getByRole('radio', { name: 'Sharper', exact: true }).focus();
            await page.keyboard.press('Space');
            assert.equal(updates, 2, 'Space applies once');
            await settleMotion(page);
            for (const width of [1080, 800, 390, 1440]) {
                await page.setViewportSize({ width, height: 900 });
                await settleMotion(page);
                await natural(card);
                if ([390, 1440].includes(width)) await page.screenshot({ path: path.join(OUT, `settings-natural-${width}-${colorScheme}.png`) });
            }
            for (const delay of [0, 16, 80]) {
                await page.keyboard.press('Escape');
                await dialog.waitFor({ state: 'hidden' });
                instant = delay === 0;
                if (instant) await page.evaluate(() => { window.__holdHeights = true; });
                dialog = await open(!instant);
                if (!instant) {
                    await page.waitForTimeout(delay);
                    answer();
                }
                await page.waitForFunction(() => document.querySelector('dialog[open] input[value="Balanced"]')?.checked);
                await dialog.getByText('Loading settings…', { exact: true }).waitFor({ state: 'hidden' });
                await settleMotion(page);
                await natural(dialog.locator('.settings-quality .auto-height'));
                if (instant) {
                    await page.evaluate(() => window.__releaseHeights());
                    await settleMotion(page);
                    await natural(dialog.locator('.settings-quality .auto-height'));
                }
            }
            assert.deepEqual(errors, [], 'no runtime or ResizeObserver loop errors');
            console.log(`PASS ${colorScheme} loading/ready, held observer, widths/reopens and explicit presets`);
        } finally { await context.close(); }
    }
}
async function storage(browser) {
    for (const existing of [false, true]) for (const mode of ['success', 'write-fail', 'remove-fail']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        try {
            await context.addInitScript(({ existing, mode }) => {
                localStorage.setItem('floating_toolbar_position', '{"x":12,"y":300}');
                if (existing) localStorage.setItem('controls_button_place', '{"side":"right","fraction":0.75}');
                const write = window.Storage.prototype.setItem;
                const remove = window.Storage.prototype.removeItem;
                window.Storage.prototype.setItem = function(key, value) {
                    if (mode === 'write-fail' && key === 'controls_button_place') throw Error('blocked write');
                    return write.call(this, key, value);
                };
                window.Storage.prototype.removeItem = function(key) {
                    if (mode === 'remove-fail' && key === 'floating_toolbar_position') throw Error('blocked removal');
                    return remove.call(this, key);
                };
            }, { existing, mode });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await fixture(page);
            await page.goto(`${BASE}#!action=device&udid=${UDID}&view=screen`);
            await page.getByRole('button', { name: 'Phone controls', exact: true }).waitFor();
            const kept = await page.evaluate(() => ({ old: localStorage.getItem('floating_toolbar_position'), next: localStorage.getItem('controls_button_place') }));
            assert.equal(kept.old, mode === 'success' ? null : '{"x":12,"y":300}', `${existing} ${mode}: discard the old corner only after a successful write and removal`);
            if (!existing && mode === 'write-fail') assert.equal(kept.next, null);
            else if (existing) assert.deepEqual(JSON.parse(kept.next), { side: 'right', fraction: 0.75 }, 'the current remembered place takes precedence');
            else assert.equal(JSON.parse(kept.next).side, 'left', 'the old corner converts to the same side');
            assert.equal(await page.locator('.floating-toolbar.mobile').getAttribute('data-side'), existing ? 'right' : 'left', 'the chosen place still works when storage is blocked');
            assert.deepEqual(errors, [], 'blocked storage never breaks controls');
        } finally { await context.close(); }
    }
    console.log('PASS controls conversion, both stored keys, write failure and removal failure');
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch();
    try {
        for (const [name, test] of Object.entries({ production, lifecycle, motion, settings, storage })) if (run(name)) await test(browser);
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
