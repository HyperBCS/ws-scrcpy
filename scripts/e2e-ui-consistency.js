// Layout regressions through scripts/test-browser.js. Default: Chromium; BROWSER=webkit runs
// only the native Time cases against the installed engine, without a new default dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { settleMotion } = require('./ui-motion');
const { start: startControls, openPanel: openControls } = require('./e2e-controls');
const { start: startSettings, openPanel: openSettings, ZONE } = require('./e2e-ios-settings');
const { fixture, openCardMenu } = require('./e2e-notifications');
const BASE = process.env.BASE;
assert.ok(BASE && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(BASE) && !/:(8000|8010)\/$/.test(BASE), 'runner-owned fixture URL required');
const OUT = process.env.E2E_OUT;
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const metrics = [];
async function shot(page, name) {
    await settleMotion(page);
    if (OUT) await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled' });
}
async function tileGeometry(page) {
    return page.locator('.control-buttons-list button').evaluateAll(buttons => buttons.map(button => {
        const b = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect(), caption = button.querySelector('.kit-icon-button-caption').getBoundingClientRect();
        const s = getComputedStyle(button);
        return { name: button.title, width: b.width, height: b.height, iconTop: icon.top - b.top, iconWidth: icon.width, iconHeight: icon.height, captionTop: caption.top - b.top, gap: caption.top - icon.bottom, color: s.borderTopColor, background: s.backgroundColor, border: s.borderTopWidth };
    }));
}
async function controls(browser) {
    const views = [{ width: 320, height: 844, mobile: true }, { width: 390, height: 844, mobile: true }, { width: 1280, height: 1000, mobile: false }, { width: 1366, height: 650, mobile: false }];
    for (const platform of ['android', 'ios']) for (const colorScheme of ['light', 'dark']) for (const viewport of views) {
        const t = await startControls(browser, platform, { viewport, colorScheme, reducedMotion: 'reduce' });
        const id = `controls-${platform}-${viewport.width}x${viewport.height}-${colorScheme}`;
        try {
            const { page } = t;
            await openControls(t);
            await page.locator('.stream-mount').evaluate(node => { window.__retainedConsistencyMount = node; });
            const verify = async state => {
                const data = await tileGeometry(page);
                for (const b of data) {
                    assert.ok(b.width >= 44 && b.height >= 56, `${id} ${b.name}: retained hit target`);
                    assert.notEqual(b.background, 'rgba(0, 0, 0, 0)', `${id} ${b.name}: visible button surface`);
                    assert.notEqual(b.color, 'rgba(0, 0, 0, 0)', `${id} ${b.name}: visible button edge`);
                    assert.equal(b.border, '1px');
                    assert.equal(b.iconWidth, 24); assert.equal(b.iconHeight, 24);
                    assert.ok(Math.abs(b.iconTop - data[0].iconTop) < 1, `${id}: icons share their top inset`);
                    assert.ok(Math.abs(b.captionTop - data[0].captionTop) < 1, `${id}: captions start at the same inset, including wrapped audio`);
                    assert.equal(b.gap, 4);
                }
                metrics.push({ id, state, data });
                await shot(page, `${id}-${state}`);
            };
            await verify('normal');
            const listen = page.locator('[data-control="audio"]');
            await listen.click();
            await page.waitForFunction(() => document.querySelector('[data-control="audio"]')?.getAttribute('aria-pressed') === 'true');
            await page.waitForFunction(() => document.querySelector('[data-control="audio"]')?.textContent.includes('Waiting for audio'));
            await verify('waiting');
            // Feed silent PCM through the actual audio envelope; this checks the Listening state
            // without making any claim about audible playback or phone capture.
            const sendAudio = (kind, payload) => {
                const packet = Buffer.alloc(23 + payload.length); packet.write('scrcpy_audio_2'); packet[14] = kind; payload.copy(packet, 23);
                t.socket.send(platform === 'ios' ? Buffer.concat([Buffer.from([3]), packet]) : packet);
            };
            sendAudio(2, Buffer.from(JSON.stringify({ status: 'ready', codec: 'raw', sampleRate: 48000, channels: 2 })));
            sendAudio(0, Buffer.alloc(4800 * 4));
            await page.waitForFunction(() => document.querySelector('[data-control="audio"]')?.textContent.includes('Listening'));
            await verify('listening');
            await listen.click();
            await page.evaluate(() => {
                window.__consistencyResume = AudioContext.prototype.resume;
                AudioContext.prototype.resume = () => Promise.reject(new Error('Fixture playback denied'));
            });
            await listen.click();
            await page.waitForFunction(() => document.querySelector('[data-control="audio"]')?.getAttribute('data-audio-state') === 'blocked');
            await verify('blocked');
            await page.evaluate(() => { AudioContext.prototype.resume = window.__consistencyResume; delete window.__consistencyResume; });
            sendAudio(2, Buffer.from(JSON.stringify({ status: 'disabled', sampleRate: 48000, channels: 2 })));
            await page.waitForFunction(() => document.querySelector('[data-control="audio"]')?.getAttribute('data-audio-state') === 'disabled');
            await verify('unavailable');
            if (!viewport.mobile) {
                const grid = page.locator('.control-buttons-list');
                assert.equal(await page.locator('.floating-toolbar.desktop').getAttribute('data-columns'), viewport.height === 650 ? '2' : '1');
                const spacing = await grid.evaluate(node => parseFloat(getComputedStyle(node).gap));
                assert.ok(spacing > 0, 'rail buttons have visible separation');
                const last = grid.locator('button').last();
                await last.scrollIntoViewIfNeeded();
                assert.equal(await last.evaluate(node => { const b = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); }), true, 'last rail action remains reachable');
                await last.focus(); await shot(page, `${id}-last-focus`);
            }
            assert.equal(await page.evaluate(() => window.__retainedConsistencyMount === document.querySelector('.stream-mount')), true);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.equal(t.streams, 1); assert.deepEqual(t.errors, []);
        } finally { await t.context.close(); }
    }
    console.log('PASS outlined controls, common icon/caption starts across waiting/listening/blocked/unavailable states, narrow touch and one/two-column rails in both themes');
}
async function time(browser, engine) {
    for (const { width, docked } of [{ width: 320 }, { width: 390 }, { width: 1280 }, { width: 1280, docked: true }]) for (const colorScheme of ['light', 'dark']) {
        const status = { enabled: true, time: '03:00', timeZone: ZONE, hasPasscode: true, nextRunAt: Date.UTC(2026, 10, 11, 8) };
        const t = await startSettings(browser, { width, height: 844, mobile: width < 600, colorScheme, status, stream: !!docked });
        const id = `time-${engine}-${width}${docked ? '-dock' : ''}-${colorScheme}`;
        let release;
        try {
            const { page, handlers, commands } = t;
            let dialog;
            const streamSocket = t.sockets.stream;
            if (docked) {
                await page.locator('.stream-mount').evaluate(node => { window.__timeDockMount = node; });
                await page.locator('.control-buttons-list [title="Settings"]').click();
                dialog = page.getByRole('dialog', { name: 'Settings', exact: true }); await dialog.waitFor();
                assert.equal(await dialog.evaluate(node => node.classList.contains('kit-sheet-docked')), true);
            } else dialog = await openSettings(page);
            const field = dialog.getByLabel('Unlock time');
            const row = dialog.locator('[data-unlock-time]');
            await row.scrollIntoViewIfNeeded(); await settleMotion(page);
            await field.evaluate(node => { window.__retainedConsistencyTime = node; });
            const normal = await field.boundingBox();
            const observe = async state => {
                await settleMotion(page);
                const b = await field.boundingBox();
                const geometry = await row.evaluate(node => {
                    const r = node.getBoundingClientRect(), feedback = node.nextElementSibling;
                    const f = feedback?.classList.contains('settings-time-feedback') ? feedback.getBoundingClientRect() : null;
                    const card = node.closest('.kit-card'), c = card.getBoundingClientRect(), inner = card.firstElementChild.getBoundingClientRect();
                    return { row: { top: r.top, width: r.width, bottom: r.bottom }, feedback: f && { top: f.top, width: f.width }, card: c.height, inner: inner.height, overflow: document.documentElement.scrollWidth > innerWidth };
                });
                assert.equal(b.height, 44); assert.ok(b.width >= 110, 'native segments retain natural width');
                assert.ok(Math.abs(b.y - normal.y) < 1, `${id} ${state}: feedback does not move the field`);
                assert.equal(await field.evaluate(node => window.__retainedConsistencyTime === node), true);
                assert.equal(geometry.overflow, false);
                assert.ok(Math.abs(geometry.card - geometry.inner - 2) < 1, 'Schedule card keeps natural height');
                if (['draft', 'pending', 'saved'].includes(state)) {
                    assert.ok(geometry.feedback && geometry.feedback.top >= geometry.row.bottom - 1, 'feedback follows the compact row');
                    assert.ok(geometry.feedback.width >= geometry.row.width - 1, 'feedback can use the full row width');
                    assert.equal(await dialog.locator('.settings-time-feedback [role="status"]').count(), 1, 'one feedback announcement');
                }
                metrics.push({ id, state, field: b, geometry });
                await shot(page, `${id}-${state}`);
                if (OUT) await field.screenshot({ path: path.join(OUT, `${id}-${state}-native.png`) });
            };
            await observe('normal');
            await field.focus(); await observe('focused');
            await field.evaluate(node => { node.value = '04:30'; node.dispatchEvent(new Event('input', { bubbles: true })); });
            await observe('draft'); assert.equal(commands.length, 0);
            handlers.onCommand = command => command.type === 'update_unlock_schedule' ? new Promise(resolve => { release = resolve; }) : undefined;
            await field.press('Enter');
            await dialog.getByText('Saving…', { exact: true }).waitFor(); await observe('pending');
            assert.equal(commands.length, 1); assert.equal(commands[0].type, 'update_unlock_schedule');
            assert.equal(await field.evaluate(node => node === document.activeElement), true);
            assert.equal(await field.isDisabled(), false);
            release({ result: JSON.stringify({ ...status, time: '04:30' }) }); release = undefined;
            await dialog.locator('.settings-time-feedback').filter({ hasText: '· saved' }).waitFor(); await observe('saved');
            assert.equal(await field.evaluate(node => node === document.activeElement), true);
            await field.evaluate(node => node.blur()); await settleMotion(page); assert.equal(commands.length, 1, 'blur after Enter does not duplicate the edit');
            // A picker change on a coarse pointer commits once; a refused edit restores short feedback.
            if (width < 600) {
                handlers.onCommand = () => ({ error: 'Fixture refused time change' });
                await field.focus();
                await field.evaluate(node => { node.value = '05:30'; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); });
                await dialog.getByText('Fixture refused time change', { exact: true }).waitFor(); await observe('refused');
                assert.equal(commands.length, 2); assert.equal(await field.inputValue(), '04:30');
                assert.equal(await dialog.locator('.settings-time-feedback').count(), 0);
            }
            assert.deepEqual(t.errors, []); assert.deepEqual(t.streamMessages, []);
            if (docked) {
                assert.equal(t.sockets.stream, streamSocket, 'Time edit keeps the same stream socket');
                assert.equal(await page.evaluate(() => window.__timeDockMount === document.querySelector('.stream-mount')), true, 'Time edit keeps the docked stream mount');
            }
        } finally { release?.({ error: 'Fixture closed' }); await t.context.close(); }
    }
    console.log(`PASS ${engine} native Time keeps its box, focus and identity through draft/pending/save/refusal, with full-width single feedback and one update per edit`);
}
const card = (page, key) => page.locator(`[data-notification-key="${key}"] article`);
async function notifications(browser) {
    for (const width of [320, 390, 600, 1024, 1440]) for (const mouse of [false, true]) for (const theme of ['light', 'dark']) {
        const long = 'T'.repeat(120);
        const sources = [{ id: 'phone-a', name: 'S'.repeat(120), address: 'AA:BB:CC:DD:EE:01', apps: [], preview: true }, { id: 'phone-b', name: 'Phone B', address: 'AA:BB:CC:DD:EE:02', apps: [], preview: true }];
        const items = [
            { key: 'normal', title: 'Normal notification', body: 'A short message with ordinary spaces.' },
            ...['title', 'subtitle', 'body'].map((field, i) => ({ key: field, title: `Long ${field}`, [field]: long, body: field === 'body' ? long : 'A short body.', received: Date.now() - (i + 1) * 1000 })),
            { key: 'url', title: 'Link and lines', body: 'First line\nhttps://example.com/' + 'x'.repeat(120) + '\nLast line' },
        ].map((item, i) => ({ app: `com.example.layout${i}`, appName: `App ${i}`, source: 'phone-a', read: false, dismissed: false, active: true, received: Date.now(), ...item }));
        const f = await fixture(browser, { width, height: 844, mouse, history: true, allSources: true, sources, notifications: items, beforeGoto: async page => { await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' }); } });
        const id = `notifications-${mouse ? 'fine' : 'touch'}-${width}-${theme}`;
        try {
            const { page } = f;
            const normal = card(page, 'normal'); await normal.scrollIntoViewIfNeeded(); await settleMotion(page);
            if (width < 600) {
                assert.equal(await normal.getByRole('button', { name: 'Show more', exact: true }).count(), 0, 'ordinary short text needs no expansion caused by mouse padding');
                const padding = await normal.evaluate(node => parseFloat(getComputedStyle(node).paddingRight));
                assert.equal(padding, 16, 'narrow card keeps full text width');
            }
            if (mouse) {
                await normal.hover(); await normal.focus(); await shot(page, `${id}-normal-focus`);
                if (width >= 600) {
                    const quick = normal.locator('.notification-card-actions button').first();
                    await quick.focus(); assert.equal(await quick.isVisible(), true);
                } else assert.equal(await normal.locator('.notification-card-actions').isVisible(), false, 'menu replaces the narrow side lane');
                const menu = await openCardMenu(page, 'Normal notification');
                await shot(page, `${id}-menu`);
                const r = await menu.boundingBox(); assert.ok(r.x >= 0 && r.x + r.width <= width + 1);
                assert.ok(await menu.getByRole('menuitem').count() >= 3, 'card actions remain in the keyboard menu');
                await page.keyboard.press('Escape');
            }
            for (const key of ['title', 'subtitle', 'body', 'url']) {
                const item = card(page, key); await item.scrollIntoViewIfNeeded(); await settleMotion(page);
                const preview = item.locator('.notification-preview');
                assert.equal(await preview.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `${id} ${key}: text wraps inside preview width`);
                const source = item.locator('.notification-source-name-on-card');
                const bounds = await source.evaluate(node => { const r = node.getBoundingClientRect(), dot = node.closest('article').querySelector('.notification-unread-dot').getBoundingClientRect(); return { right: r.right, dot: dot.left, overflow: getComputedStyle(node).overflow }; });
                assert.ok(bounds.right <= bounds.dot, 'source identity keeps clear of unread/menu lanes'); assert.equal(bounds.overflow, 'hidden');
                await shot(page, `${id}-${key}-collapsed`);
                if (await item.getByRole('button', { name: 'Show more', exact: true }).count()) await item.getByRole('button', { name: 'Show more', exact: true }).click();
                else { await item.focus(); await page.keyboard.press('Space'); }
                await item.locator('.notification-preview.expanded').waitFor(); await settleMotion(page);
                assert.equal(await preview.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1), true, 'expanded text is fully readable');
                if (key !== 'url') assert.ok((await preview.textContent()).includes(long), 'all long-token characters remain');
                else { assert.equal(await preview.locator('a').getAttribute('href'), 'https://example.com/' + 'x'.repeat(120)); assert.ok((await preview.textContent()).includes('\nLast line')); }
                await shot(page, `${id}-${key}-expanded`);
                await item.focus(); await page.keyboard.press('Space'); await settleMotion(page);
                assert.equal(f.readRequests.filter(request => request.keys.includes(key) && request.read).length, 1, 'expand/collapse marks read once');
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.deepEqual(f.errors, []);
        } finally { await f.context.close(); }
    }
    console.log('PASS long title/subtitle/body/source bounds, complete expanded links/newlines and read-once; narrow mouse menu and wide action lane, both themes');
}
async function main() {
    const engine = process.env.BROWSER || 'chromium';
    assert.ok(['chromium', 'webkit'].includes(engine));
    const browser = await ({ chromium, webkit }[engine]).launch({ headless: true });
    try {
        const cases = engine === 'webkit' ? [time] : [controls, time, notifications];
        const selected = cases.filter(run => !process.env.SCENARIO || process.env.SCENARIO === run.name);
        assert.ok(selected.length, 'SCENARIO must name an existing consistency case');
        for (const run of selected) await run(browser, engine);
    } finally {
        await browser.close();
        if (OUT) fs.writeFileSync(path.join(OUT, 'geometry.json'), JSON.stringify(metrics, null, 2) + '\n');
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
