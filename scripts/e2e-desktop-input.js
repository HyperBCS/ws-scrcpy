// Isolated keyboard and clipboard checks. Run through scripts/test-browser.js.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const OUT = process.env.E2E_OUT;
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE;
if (!BASE) throw Error('Run this suite through scripts/test-browser.js.');

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32; frame.writeUInt32LE(id, 1); body.copy(frame, 5); return frame;
}
function initial() {
    const p = Buffer.alloc(186); p.write('scrcpy_initial'); p.write('Keyboard phone', 14);
    for (const [at, n] of [[78, 1], [86, 720], [90, 1280], [110, 25], [122, 720], [126, 1280], [130, 720], [134, 1280], [139, 35], [143, 4000000], [147, 60], [182, 31]]) p.writeInt32BE(n, at);
    p.writeInt8(1, 151); p.writeInt8(-1, 165); return p;
}
const sleep = (page) => page.waitForTimeout(80);
const chip = (page) => page.locator('.kit-keyboard-chip');
const control = (page, name) => page.locator(`.control-buttons-list [title="${name}"]`);

async function start(browser, platform, { uhid = true, width = 1280, decode = true, theme = 'light', mobile = false, nativeClipboard = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, colorScheme: theme, isMobile: mobile, hasTouch: mobile });
    if (nativeClipboard) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await context.addInitScript(({ decode, nativeClipboard }) => {
        window.VideoDecoder = class {
            static async isConfigSupported() { return { supported: decode }; }
            constructor({ output }) { this.output = output; this.state = 'unconfigured'; }
            configure() { this.state = 'configured'; }
            decode(chunk) {
                const canvas = new window.OffscreenCanvas(428, 926);
                canvas.getContext('2d').fillRect(0, 0, 428, 926);
                this.output(new window.VideoFrame(canvas, { timestamp: chunk.timestamp }));
            }
            close() { this.state = 'closed'; }
        };
        if (!decode && window.MediaSource) window.MediaSource.isTypeSupported = () => false;
        window.__trustedPastes = 0;
        window.addEventListener('paste', event => { if (event.isTrusted) window.__trustedPastes++; }, true);
        if (!nativeClipboard) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } });
    }, { decode, nativeClipboard });
    const page = await context.newPage();
    const messages = [], errors = [], sockets = [];
    let pendingSet, failSet = false, holdSet = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', socket => {
        const url = new URL(socket.url());
        if (url.pathname === '/__desktop_input__' || url.searchParams.get('action') === 'proxy-coredevice') {
            sockets.push(socket);
            socket.onMessage(data => {
                const message = platform === 'android' ? Buffer.from(data) : JSON.parse(data);
                messages.push(message);
                if (platform === 'ios' && message.type === 'clipboard') {
                    if (message.op === 'get') socket.send(JSON.stringify({ type: 'clipboard', text: 'Copied phone text' }));
                    else {
                        const answer = () => socket.send(JSON.stringify({ type: 'result', id: message.id, ok: !failSet, error: failSet ? 'Clipboard refused' : undefined }));
                        if (holdSet) pendingSet = answer; else answer();
                    }
                } else if (platform === 'android' && message[0] === 8) {
                    const text = Buffer.from('Copied phone text');
                    const reply = Buffer.alloc(14 + 1 + 4 + text.length); reply.write('scrcpy_message');
                    reply[14] = 0; reply.writeInt32BE(text.length, 15); text.copy(reply, 19); socket.send(reply);
                }
            });
            setTimeout(() => socket.send(platform === 'android' ? initial() : JSON.stringify({ type: 'status', state: 'ready' })), 30);
            if (platform === 'ios') {
                setTimeout(() => socket.send(JSON.stringify({ type: 'codec', codec: 'hev1.1.6.L150.B0', description: 'AQ==' })), 50);
                let open = true; socket.onClose(() => { open = false; });
                const frame = () => { if (open && !page.isClosed()) { socket.send(Buffer.from([0, 0, 0, 0, 1, 0x26])); setTimeout(frame, 200).unref(); } };
                setTimeout(frame, 150);
            }
            return;
        }
        socket.onMessage(data => {
            const frame = Buffer.from(data); if (frame[0] !== 4) return;
            const id = frame.readUInt32LE(1), kind = frame.subarray(5).toString();
            if (kind === 'HSTS') socket.send(channelJson(id, { id: -1, type: 'hosts', data: { local: [{ type: platform }] } }));
            if (kind === 'GTRC' || kind === 'ATRC') socket.send(channelJson(id, { id: -1, type: 'devicelist', data: { id: 'keyboard', name: 'Fixture', list: [{ udid: 'keyboard-phone', name: 'Keyboard phone', state: platform === 'android' ? 'device' : 'Connected', pid: 123, model: 'Phone', version: '27', paired: true, developerMode: true, session: 'ready', 'screen.power': 'on', 'device.locked': true }] } }));
        });
    });
    const url = new URL(BASE);
    const ws = new URL('/__desktop_input__', BASE); ws.protocol = 'ws:';
    url.hash = `!${new URLSearchParams(platform === 'android' ? { action: 'stream', udid: 'keyboard-phone', player: 'webcodecs', ws: ws.href } : { action: 'stream-coredevice', udid: 'keyboard-phone' })}`;
    await page.goto(url.href);
    await page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent === 'Connected' || document.querySelector('.stream-state')?.textContent.includes('cannot show'));
    if (platform === 'ios' && decode) await page.waitForFunction(() => document.querySelector('.touch-layer')?.width === 428);
    if (!uhid) {
        await control(page, 'Settings').click();
        await page.getByRole('switch', { name: 'Native keyboard (UHID)', exact: true }).click();
        await page.goBack(); await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' });
    }
    const focus = async () => {
        await page.locator(decode || platform === 'android' ? '.touch-layer' : '.stream-mount').focus(); await sleep(page);
    };
    await focus();
    const keys = () => messages.filter(m => platform === 'ios' ? m.type === 'key' : m[0] === 0 || m[0] === 13);
    const paste = async (text, target = '.touch-layer') => {
        await page.locator(target).evaluate((node, text) => {
            const data = new DataTransfer(); data.setData('text/plain', text);
            node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }, text); await sleep(page);
    };
    return { context, page, messages, errors, sockets, focus, keys, paste, setFailure: value => { failSet = value; }, hold: value => { holdSet = value; }, finish: () => { pendingSet?.(); pendingSet = undefined; } };
}

async function captureFlow(browser, platform, options) {
    const t = await start(browser, platform, options), { page, messages, keys } = t;
    try {
        assert.equal(await chip(page).innerText(), 'Keyboard: phone');
        if (OUT) await page.screenshot({ path: path.join(OUT, `${platform}-${options.width || 1280}-${options.theme || 'light'}-${options.uhid === false ? 'fallback' : 'native'}.png`) });
        const before = keys().length;
        await page.keyboard.press('Control+Alt+k'); await page.waitForTimeout(650);
        assert.equal(await chip(page).innerText(), 'Keyboard: this page');
        assert.equal(keys().length, before, 'the release chord sends no key or modifier');
        await page.keyboard.press('Tab');
        assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY', 'Tab reaches this page');
        const switchButton = page.getByRole('button', { name: 'Switch', exact: true });
        await switchButton.focus();
        await page.keyboard.press('Control+k');
        await page.getByRole('dialog', { name: 'Switch phone', exact: true }).waitFor();
        await page.goBack(); await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' }); await sleep(page);
        assert.equal(await switchButton.evaluate(node => node === document.activeElement), true, 'released capture keeps page navigation focus');
        await page.keyboard.press('Control+Alt+k'); await sleep(page);
        assert.equal(await chip(page).innerText(), 'Keyboard: phone');
        await chip(page).click(); await sleep(page);
        assert.equal(await chip(page).innerText(), 'Keyboard: this page', 'click releases capture');
        await chip(page).click(); await sleep(page);
        assert.equal(await chip(page).innerText(), 'Keyboard: phone', 'click captures and focuses the picture');
        await page.keyboard.press('Control+Alt+s');
        await page.getByRole('dialog', { name: 'Switch phone', exact: true }).waitFor();
        assert.equal(await chip(page).innerText(), 'Keyboard: this page');
        await page.goBack(); await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' }); await sleep(page);
        assert.equal(await chip(page).innerText(), 'Keyboard: phone');
        const homeBefore = messages.length;
        await page.keyboard.press('Control+Alt+h'); await sleep(page);
        assert.equal(messages.slice(homeBefore).filter(m => platform === 'ios' ? m.type === 'button' && m.name === 'home' : m[0] === 0 && m.readInt32BE(2) === 3).length, platform === 'ios' ? 1 : 2);
        for (const name of ['Actions', 'Settings']) {
            await control(page, name).click(); await page.getByRole('dialog', { name, exact: true }).waitFor();
            const n = keys().length; await page.keyboard.press('x'); await sleep(page);
            assert.equal(keys().length, n, `${name} keeps keys local`);
            if (name === 'Settings') {
                assert.match(await page.locator('.settings-keyboard').innerText(), /Ctrl\+Alt\+K/);
                await page.getByRole('switch', { name: 'Send this keyboard to the phone', exact: true }).click();
            }
            await page.goBack(); await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' }); await sleep(page);
        }
        assert.equal(await chip(page).innerText(), 'Keyboard: this page', 'settings and chip share capture');
        await chip(page).click(); await sleep(page);
        await page.keyboard.press('Control+Alt+t'); await page.locator('.live-text-input').waitFor();
        const n = keys().length, textStart = messages.length;
        await t.paste('local field', '.live-text-input');
        await page.waitForTimeout(300);
        assert.equal(keys().length - n, platform === 'ios' ? 22 : 0, 'Type text alone handles its paste once');
        if (platform === 'android') assert.deepEqual(messages.slice(textStart).filter(m => m[0] === 1).map(m => m.subarray(5).toString()), ['local field'], 'Android Type text injects the pasted text exactly once');
        assert.equal(messages.filter(m => platform === 'ios' ? m.type === 'clipboard' && m.op === 'set' : m[0] === 9).length, 0);
        assert.equal(await page.locator('.stream-stage').evaluate(node => !!node.closest('[inert]')), false, 'Type text leaves the stage active');
        const inert = await page.locator('.stream-view [inert]').evaluateAll(nodes => nodes.map(node => ({ class: node.className, exiting: node.hasAttribute('data-exiting') })));
        console.log(`Type text inert elements (${platform}): ${JSON.stringify(inert)}`);
        await page.getByRole('button', { name: 'Close Type text', exact: true }).click();
        await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' }); await sleep(page);
        assert.equal(await chip(page).innerText(), 'Keyboard: phone');
        await page.keyboard.press('a'); await page.waitForTimeout(650);
        assert.ok(keys().length > n, 'typing after sheets reaches the phone');
        await control(page, 'Listen').click(); await sleep(page);
        // An unavailable sound may open Settings. Closing it still returns focus to the picture.
        if (await page.locator('dialog.kit-sheet[open]').count()) { await page.goBack(); await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' }); }
        await sleep(page);
        assert.equal(await chip(page).innerText(), 'Keyboard: phone');
        assert.equal(t.sockets.length, 1, 'capture, actions and sheets never remount the screen');
        assert.deepEqual(t.errors, []);
        console.log(`PASS: ${platform} capture, chords, shared settings, local fields and one stream (${JSON.stringify(options)})`);
    } finally { await t.context.close(); }
}

async function pasteFlow(browser, platform, options = {}) {
    const t = await start(browser, platform, { ...options, nativeClipboard: true }), { page, messages } = t;
    try {
        await page.evaluate(() => navigator.clipboard.writeText('Browser paste ✓'));
        await page.keyboard.press('Control+v'); await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => window.__trustedPastes), 1, 'Ctrl+V raises one real browser paste event');
        const writes = () => messages.filter(m => platform === 'ios' ? m.type === 'clipboard' && m.op === 'set' : m[0] === 9);
        assert.equal(writes().length, 1, 'one real Ctrl+V paste writes once');
        if (platform === 'android') {
            assert.equal(t.keys().length, 0, 'Ctrl+V sends no Android phone keys');
            assert.equal(writes()[0][9], 1); assert.equal(writes()[0].subarray(14).toString(), 'Browser paste ✓');
        } else {
            assert.equal(writes()[0].text, 'Browser paste ✓');
            assert.deepEqual(t.keys().map(m => m.usages), [[0xe3], [0xe3, 0x19], [0xe3], []], 'clipboard confirmation precedes Cmd+V');
            t.setFailure(true); const before = t.keys().length;
            await t.paste('refused'); await page.getByText('Clipboard refused', { exact: true }).waitFor();
            assert.equal(t.keys().length, before, 'a refused write never presses paste');
            t.setFailure(false); t.hold(true);
            await t.paste('pending'); await control(page, 'Actions').click();
            t.finish(); await sleep(page);
            assert.equal(t.keys().length, before, 'moving into a sheet cancels pending paste');
            await page.goBack(); await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' }); await sleep(page);
        }
        const localWrites = writes().length;
        await control(page, 'Actions').click();
        const draft = page.getByRole('dialog', { name: 'Actions', exact: true }).locator('textarea:not([readonly])');
        await draft.focus();
        await page.evaluate(() => navigator.clipboard.writeText('Keep in this page'));
        await page.keyboard.press('Control+v'); await sleep(page);
        assert.equal(await draft.inputValue(), 'Keep in this page', 'native paste stays in a local field');
        assert.equal(writes().length, localWrites, 'a local field sends no direct phone clipboard write');
        await page.goBack(); await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' }); await sleep(page);
        await control(page, 'Type text').click(); await page.locator('.live-text-input').waitFor();
        const typedAt = messages.length;
        await page.evaluate(() => navigator.clipboard.writeText('once'));
        await page.keyboard.press('Control+v'); await page.waitForTimeout(250);
        if (platform === 'android') assert.deepEqual(messages.slice(typedAt).filter(m => m[0] === 1).map(m => m.subarray(5).toString()), ['once']);
        else assert.equal(messages.slice(typedAt).filter(m => m.type === 'key').length, 8, 'Type text alone handles the trusted native paste once');
        assert.equal(writes().length, localWrites, 'native Type text paste sends no direct clipboard write');
        await page.getByRole('button', { name: 'Close Type text', exact: true }).click();
        await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' }); await sleep(page);
        const total = writes().length;
        await t.paste('x'.repeat(262144));
        await page.getByText('This text is too long to send. The limit is 256 KB.', { exact: true }).waitFor();
        assert.equal(writes().length, total);
        await t.focus(); await page.keyboard.press('Control+Alt+c');
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Copied phone text');
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('Denied'); } } });
            document.execCommand = () => false;
        });
        await page.keyboard.press('Control+Alt+c');
        await page.getByText('This browser blocked copying. Read the clipboard in Actions and copy it there.', { exact: true }).waitFor();
        assert.equal(t.sockets.length, 1); assert.deepEqual(t.errors, []);
        console.log(`PASS: ${platform} direct paste, limits, Copy from phone and clipboard failures`);
    } finally { await t.context.close(); }
}

async function noDecoder(browser) {
    const t = await start(browser, 'ios', { decode: false });
    try {
        const { page } = t;
        await page.getByRole('heading', { name: 'This browser cannot show the stream', exact: true }).waitFor();
        await page.locator('.lock-screen-notice').waitFor();
        await control(page, 'Actions').click();
        assert.equal(await page.getByRole('dialog', { name: 'Actions', exact: true }).getByRole('button', { name: 'Unlock', exact: true }).isDisabled(), false);
        await page.goBack(); await page.locator('dialog.kit-sheet[open]').waitFor({ state: 'detached' });
        await control(page, 'Type text').click(); await page.locator('.live-text-input').waitFor();
        assert.equal(await page.getByText('Reconnecting to the phone…', { exact: true }).count(), 0);
        assert.equal(t.sockets.length, 1); assert.deepEqual(t.errors, []);
        console.log('PASS: a ready iPhone session keeps unlock and Type text available without HEVC decoding');
    } finally { await t.context.close(); }
}

async function phoneLayout(browser, platform, theme) {
    const t = await start(browser, platform, { mobile: true, width: 390, theme });
    try {
        const { page } = t;
        assert.equal(await chip(page).isVisible(), false, 'the desktop chip takes no space on a touch screen');
        await page.locator('.floating-toolbar-fab').click(); await control(page, 'Settings').click();
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
        await dialog.waitFor();
        await dialog.locator('[data-section="keyboard"]').scrollIntoViewIfNeeded();
        assert.match(await dialog.locator('.settings-keyboard').innerText(), /Ctrl\+Alt\+K/);
        const before = t.keys().length; await page.keyboard.press('x'); await sleep(page);
        assert.equal(t.keys().length, before, 'a bottom sheet keeps keys local');
        if (OUT) await page.screenshot({ path: path.join(OUT, `${platform}-390-${theme}-keyboard.png`) });
        assert.equal(t.sockets.length, 1); assert.deepEqual(t.errors, []);
        console.log(`PASS: ${platform} phone Keyboard settings and unchanged touch header (${theme})`);
    } finally { await t.context.close(); }
}

async function narrowMouseHeader(browser, platform, width) {
    const t = await start(browser, platform, { width });
    try {
        const { page } = t;
        for (const released of [false, true]) {
            if (released) { await page.keyboard.press('Control+Alt+k'); await sleep(page); }
            assert.equal(await chip(page).innerText(), released ? 'Keyboard: this page' : 'Keyboard: phone');
            if (OUT) await page.screenshot({ path: path.join(OUT, `${platform}-${width}-mouse-${released ? 'released' : 'captured'}.png`) });
            const header = await page.locator('.kit-bar').evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
            assert.ok(header.content <= header.width, `${platform} ${width}: header has no horizontal overflow (${JSON.stringify(header)})`);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page has no horizontal overflow');
            for (const button of [page.locator('.kit-bar-back'), page.locator('.kit-bar').getByRole('button', { name: 'Switch', exact: true }), page.locator('.kit-bar').getByRole('link')]) {
                assert.equal(await button.isVisible(), true, 'Back, bell and Switch stay visible');
                assert.equal(await button.evaluate(node => {
                    const b = node.getBoundingClientRect();
                    return b.left >= 0 && b.right <= innerWidth && node.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
                }), true, 'Back, bell and Switch stay inside the mouse viewport and can be pressed');
            }
        }
        assert.equal(t.sockets.length, 1); assert.deepEqual(t.errors, []);
        console.log(`PASS: ${platform} ${width}px mouse header stays inside the viewport with both keyboard targets`);
    } finally { await t.context.close(); }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const selected = process.env.DESKTOP_INPUT_CASE;
        if (selected === 'narrow-header') { for (const platform of ['android', 'ios']) for (const width of [320, 390]) await narrowMouseHeader(browser, platform, width); return; }
        if (selected === 'paste') { for (const platform of ['android', 'ios']) await pasteFlow(browser, platform); return; }
        if (selected === 'no-decoder') { await noDecoder(browser); return; }
        for (const platform of ['android', 'ios']) {
            await captureFlow(browser, platform, { width: 1280, theme: 'light' });
            await captureFlow(browser, platform, { width: 900, theme: 'dark' });
            await pasteFlow(browser, platform);
        }
        await captureFlow(browser, 'android', { uhid: false });
        await pasteFlow(browser, 'android', { uhid: false });
        await noDecoder(browser);
        for (const platform of ['android', 'ios']) for (const width of [320, 390]) await narrowMouseHeader(browser, platform, width);
        for (const platform of ['android', 'ios']) for (const theme of ['light', 'dark']) await phoneLayout(browser, platform, theme);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
