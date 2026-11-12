const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium, webkit } = require('playwright');
const { fixture, historyItems, showSetup } = require('./e2e-notifications');
const { settleMotion } = require('./ui-motion');
const BASE = process.env.BASE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
    const browserName = process.env.BROWSER || 'chromium';
    const browser = await ({ chromium, webkit }[browserName]).launch();
    const out = `/tmp/ws-review-polish-${browserName}`; await fs.mkdir(out, { recursive: true });
    try {
        const f = await fixture(browser, { history: true, notifications: historyItems(), devices: true });
        try {
            // The bar names the iPhone and holds Switch, Search and Setup in one row.
            const bar = f.page.locator('.notifications-view > .kit-bar');
            const button = bar.getByRole('button', { name: 'Switch iPhone', exact: true });
            await button.waitFor();
            await settleMotion(f.page);
            const [action, search] = await Promise.all([button.boundingBox(), bar.getByRole('button', { name: 'Search', exact: true }).boundingBox()]);
            assert(Math.abs(action.y + action.height / 2 - (search.y + search.height / 2)) < 3, 'Switch sits in the row of the bar');
            assert(action.width < 130 && action.height >= 32, 'a compact button');
            assert.equal(await button.evaluate(el => getComputedStyle(el).textDecorationLine), 'none');
            assert.equal(await button.evaluate(el => getComputedStyle(el).borderTopStyle), 'solid');
            await f.page.screenshot({ path: `${out}/notifications.png`, fullPage: true });
            let requests = 0;
            await f.page.route('**/api/notifications/status', async route => { requests++; await sleep(6000); try { await route.fallback(); } catch {} });
            f.notifications[0].title = 'Status arrived over a slow connection';
            await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
            await f.page.getByRole('heading', { name: 'Status arrived over a slow connection', exact: true }).waitFor({ timeout: 14000 });
            assert(requests <= 2, 'polling never piles up slow requests');
            await f.page.unroute('**/api/notifications/status');
            await showSetup(f.page);
            const poll = () => f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
            f.pairingOpen = true; await poll();
            await f.page.waitForFunction(() => document.querySelector('.notification-pairing')?.dataset.expanded === 'true');
            await settleMotion(f.page);
            f.pairingOpen = false; await poll();
            await f.page.waitForFunction(() => document.querySelector('.notification-pairing')?.dataset.expanded === 'false');
            f.pairingOpen = true; await poll(); await sleep(450);
            assert.equal(await f.page.locator('.notification-pairing').evaluate(node => node.open), true, 'controlled disclosures reverse a closing animation');
            assert.deepEqual(f.errors, []);
            console.log('PASS compact notification action, slow polling and controlled disclosure reversal');
        } finally { await f.context.close(); }
        for (const width of [390, 1280]) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: width === 390 ? 'dark' : 'light' });
            const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
            await page.routeWebSocket('**', socket => socket.onMessage(data => {
                const frame = Buffer.from(data); if (frame[0] !== 4) return;
                const code = frame.subarray(5).toString();
                const message = code === 'HSTS' ? { type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } } :
                    { type: 'devicelist', data: { id: code, name: 'Devices', list: code === 'GTRC' ? [{ udid: 'pixel', state: 'device', pid: -1, interfaces: [], 'ro.product.model': 'Pixel', 'ro.product.manufacturer': 'Google', 'ro.build.version.release': '16', 'battery.level': 80, 'screen.power': 'on' }] :
                    [{ udid: 'iphone', name: 'iPhone', state: 'Connected', model: 'iPhone', version: '27', paired: true, developerMode: true, session: 'stopped', 'screen.power': 'on' }] } };
                const body = Buffer.from(JSON.stringify({ id: -1, ...message })); const reply = Buffer.alloc(5 + body.length); reply[0] = 32; reply.writeUInt32LE(frame.readUInt32LE(1), 1); body.copy(reply, 5); socket.send(reply);
            }));
            await page.goto(BASE); await page.locator('.device').nth(1).waitFor(); await settleMotion(page);
            assert.equal(await page.getByRole('link', { name: 'Open screen', exact: true }).count(), 2);
            // One status chip and a Settings button on each card; the disclosure is gone.
            assert.equal(await page.locator('.device summary').count(), 0);
            assert.equal(await page.locator('.device .phone-row-chip').count(), 2);
            assert.equal(await page.locator('.device .stream-settings-button').count(), 2);
            assert.equal(await page.locator('.tracker-block').count(), 1, 'one host shares one grid across platforms');
            if (width > 720) {
                const cards = await page.locator('.device').all();
                assert(Math.abs((await cards[0].boundingBox()).y - (await cards[1].boundingBox()).y) < 1, 'platform cards align in one desktop row');
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            const buttons = await page.locator('.device-primary-actions .stream.primary').evaluateAll(nodes => nodes.map(el => ({ height: el.getBoundingClientRect().height, color: getComputedStyle(el).backgroundColor, radius: getComputedStyle(el).borderRadius })));
            assert.deepEqual(buttons[0], buttons[1], 'platform cards have matching primary controls');
            await page.screenshot({ path: `${out}/devices-${width}.png`, fullPage: true });
            assert.deepEqual(errors, []); await context.close();
        }
        console.log('PASS coherent Android/iOS cards in light desktop and dark mobile layouts');
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
        const page = await context.newPage(); const requests = [];
        page.on('request', request => requests.push(request));
        await page.routeWebSocket('**', () => {});
        await page.goto(BASE); await page.locator('#devices').waitFor();
        assert.equal(await page.locator('input[type="password"]').count(), 0);
        assert.equal((await context.cookies()).length, 0);
        assert.equal((await context.request.get(new URL('api/access', BASE).href)).status(), 404);
        await page.reload(); await page.locator('#devices').waitFor();
        assert.equal(requests.some(request => new URL(request.url()).pathname === '/api/access'), false, 'the app never performs a login check');
        assert.equal(requests.some(request => request.headers().authorization), false, 'no API credential headers');
        await context.close(); console.log('PASS direct app startup without login endpoints, forms, cookies or credentials');
        const recovery = await browser.newContext({ serviceWorkers: 'block' });
        const recoveryPage = await recovery.newPage(); let offline = true;
        await recoveryPage.routeWebSocket('**', () => {});
        await recoveryPage.route('**/api/notifications/**', route => {
            if (offline) return route.fulfill({ status: 503, json: { error: 'Connection unavailable' } });
            return route.fulfill({ json: { sources: [], notifications: [], bluetooth: [], statuses: {}, pairing: null, pairingOpen: false, error: '', delivery: { sent: 0, failed: 0, lastError: '' }, unread: 0, unreadBySource: {}, publicKey: '', publicUrl: 'https://example.test' } });
        });
        const notificationUrl = new URL(BASE); notificationUrl.hash = '!action=notifications';
        await recoveryPage.goto(notificationUrl.href);
        await recoveryPage.getByRole('heading', { name: "Can't reach the server" }).waitFor();
        assert.equal(await recoveryPage.locator('input[type="password"]').count(), 0);
        offline = false; await recoveryPage.getByRole('button', { name: 'Try again', exact: true }).click();
        await recoveryPage.getByRole('heading', { name: 'Send from an iPhone', exact: true }).waitFor();
        await recovery.close(); console.log('PASS notification connection failures recover with Retry, without setup credentials');

    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
