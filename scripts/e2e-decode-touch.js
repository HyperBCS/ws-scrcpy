/* eslint-disable */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:8000/';
(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
        window.__raw = [];
        const orig = WebSocket.prototype.send;
        WebSocket.prototype.send = function (d) {
            try {
                const v = new Uint8Array(d.buffer || d);
                if (v[0] === 2) window.__raw.push(Array.from(v));
            } catch (e) {}
            return orig.apply(this, arguments);
        };
    });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await page.locator('a.desc-block.stream').first().click();
    await page.waitForTimeout(12000);
    const r = await page.evaluate(() => {
        const v = document.querySelector('.video').getBoundingClientRect();
        return { x: v.left, y: v.top, w: v.width, h: v.height };
    });
    await page.touchscreen.tap(Math.round(r.x + r.w / 2), Math.round(r.y + r.h * 0.32));
    await page.waitForTimeout(1000);
    const raw = await page.evaluate(() => window.__raw);
    console.log(`video rect: ${JSON.stringify(r)}`);
    raw.forEach((arr) => {
        const b = Buffer.from(arr);
        console.log(JSON.stringify({
            type: b.readUInt8(0), action: b.readUInt8(1),
            pointerIdHi: b.readUInt32BE(2), pointerIdLo: b.readUInt32BE(6),
            x: b.readUInt32BE(10), y: b.readUInt32BE(14),
            screenW: b.readUInt16BE(18), screenH: b.readUInt16BE(20),
            pressure: b.readUInt16BE(22),
            actionButton: b.readUInt32BE(24), buttons: b.readUInt32BE(28),
            len: b.length,
        }));
    });
    await browser.close();
})();
