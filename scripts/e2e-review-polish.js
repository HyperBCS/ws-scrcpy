const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium, webkit } = require('playwright');
const { fixture, historyItems } = require('./e2e-notifications');
const { settleMotion } = require('./ui-motion');
const BASE = process.env.BASE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
    const browserName = process.env.BROWSER || 'chromium';
    const browser = await ({ chromium, webkit }[browserName]).launch();
    const out = `/tmp/ws-review-polish-${browserName}`; await fs.mkdir(out, { recursive: true });
    try {
        const f = await fixture(browser, { history: true, notifications: historyItems() });
        try {
            await settleMotion(f.page);
            const button = f.page.getByRole('link', { name: 'Open screen', exact: true });
            const [action, search] = await Promise.all([button.boundingBox(), f.page.getByRole('searchbox').boundingBox()]);
            assert(Math.abs(action.y - search.y) < 3, 'Open screen shares the search row');
            assert(action.width < 130 && action.height >= 44, 'compact width, full touch target');
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
            await f.page.getByRole('button', { name: 'Setup & delivery', exact: true }).click();
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
            assert.equal(await page.locator('.device summary').filter({ hasText: 'Connection & tools' }).count(), 2);
            assert.equal(await page.locator('.device .stream-service-status').count(), 2);
            assert.equal(await page.locator('.tracker-block').count(), 1, 'one host shares one grid across platforms');
            if (width > 720) {
                const cards = await page.locator('.device').all();
                assert(Math.abs((await cards[0].boundingBox()).y - (await cards[1].boundingBox()).y) < 1, 'platform cards align in one desktop row');
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            const buttons = await page.locator('.device-primary-actions .stream.primary').evaluateAll(nodes => nodes.map(el => ({ height: el.getBoundingClientRect().height, color: getComputedStyle(el).backgroundColor, radius: getComputedStyle(el).borderRadius })));
            assert.deepEqual(buttons[0], buttons[1], 'platform cards have matching primary controls');
            await page.screenshot({ path: `${out}/devices-${width}.png`, fullPage: true });
            for (const details of await page.locator('.device-details').all()) { await details.locator('summary').click(); await settleMotion(page); assert.equal(await details.evaluate(el => el.open), true); }
            assert.deepEqual(errors, []); await context.close();
        }
        console.log('PASS coherent Android/iOS cards in light desktop and dark mobile layouts');
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
        const page = await context.newPage(); let authenticated = false;
        await page.route('**/api/access', route => {
            if (route.request().method() === 'POST') authenticated = route.request().postDataJSON().key === 'fixture-key';
            return route.fulfill({ status: route.request().method() === 'POST' && !authenticated ? 401 : 200, json: { authenticated, ...(!authenticated ? { error: 'That setup key did not match.' } : {}) } });
        });
        await page.routeWebSocket('**', () => {});
        await page.goto(BASE); await page.getByLabel('Setup key').fill('wrong'); await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await page.getByRole('alert').waitFor();
        await page.screenshot({ path: `${out}/lan-sign-in.png`, fullPage: true });
        await page.getByLabel('Setup key').fill('fixture-key'); await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await page.locator('#devices').waitFor(); await page.reload(); await page.locator('#devices').waitFor();
        await context.close(); console.log('PASS LAN sign-in errors and remembered access UI');
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
