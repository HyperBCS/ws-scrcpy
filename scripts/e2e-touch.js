/* eslint-disable */
/**
 * End-to-end smoke test for the phone UI: device list -> stream -> touch.
 *
 * Exists because the interesting failures here are layout/hit-testing ones that typecheck and
 * lint cleanly. In particular it answers "what element is actually on top of the video?", which
 * is what silently breaks touch when an overlay is mispositioned.
 *
 * Usage: node scripts/e2e-touch.js [baseUrl]
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || path.join(process.env.HOME, '.cache', 'wsshot');

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    const page = await context.newPage();

    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });

    // Record every outbound WebSocket frame so we can tell whether a touch actually produced a
    // control message, rather than inferring it from the UI.
    //
    // NB this hooks ALL sockets, so the tracker's multiplexer frames show up here too --
    // a 9-byte frame starting with 4 is MessageType.CreateChannel (5-byte header + 4-byte
    // channel code), NOT ControlMessage.TYPE_BACK_OR_SCREEN_ON. Only the 32-byte type-2 frames
    // below are touch events.
    await page.addInitScript(() => {
        window.__sent = [];
        const origSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
            try {
                if (data && data.byteLength !== undefined) {
                    const view = new Uint8Array(data.buffer || data);
                    window.__sent.push({ len: view.byteLength, type: view[0] });
                }
            } catch (e) {
                /* ignore */
            }
            return origSend.apply(this, arguments);
        };
    });

    console.log(`[1] loading ${BASE}`);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, '01-device-list.png'), fullPage: true });

    const cards = await page.locator('.device').count();
    console.log(`[1] device cards rendered: ${cards}`);

    // Report the real rendered geometry of the action controls -- this is the "adequate spacing"
    // check, measured rather than eyeballed.
    const targets = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('#devices .desc-block, #devices .wake-button').forEach((el) => {
            const r = el.getBoundingClientRect();
            out.push({ text: (el.innerText || '').trim().slice(0, 28), w: Math.round(r.width), h: Math.round(r.height) });
        });
        return out;
    });
    console.log('[1] action target sizes:', JSON.stringify(targets));
    const tooSmall = targets.filter((t) => t.h < 44);
    console.log(tooSmall.length ? `[1] FAIL under-44px targets: ${JSON.stringify(tooSmall)}` : '[1] OK all targets >= 44px');

    // Target a specific device: with several attached, `.first()` may land on one that is
    // asleep or has no server running, and the failure looks like a product bug.
    const SERIAL = process.env.SERIAL;
    const scope = SERIAL ? page.locator('.device', { has: page.locator(`text=${SERIAL}`) }) : page;
    const streamLink = scope.locator('a.desc-block.stream').first();
    if ((await streamLink.count()) === 0) {
        console.log('[2] NO STREAM LINK — is a device connected and the scrcpy server running?');
        await browser.close();
        process.exit(1);
    }
    console.log(`[2] opening stream: ${(await streamLink.innerText()).trim()}`);
    await streamLink.click();
    await page.waitForTimeout(10000);
    await page.screenshot({ path: path.join(OUT, '02-stream.png') });

    // The decisive check: what is on top at the centre of the video?
    const hit = await page.evaluate(() => {
        const v = document.querySelector('.video');
        if (!v) return { error: 'no .video element' };
        const r = v.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const el = document.elementFromPoint(cx, cy);
        const overlay = document.querySelector('.sleep-overlay');
        return {
            videoRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
            point: { cx, cy },
            topElement: el ? `${el.tagName.toLowerCase()}.${el.className}` : null,
            isTouchLayer: !!(el && el.classList && el.classList.contains('touch-layer')),
            overlayPresent: !!overlay,
            overlayPointerEvents: overlay ? getComputedStyle(overlay).pointerEvents : null,
            canvasCount: document.querySelectorAll('.video canvas, .video video').length,
        };
    });
    console.log('[3] hit test:', JSON.stringify(hit, null, 1));

    const before = await page.evaluate(() => window.__sent.length);
    const { cx, cy } = hit.point || {};
    if (cx) {
        await page.touchscreen.tap(cx, cy);
        await page.waitForTimeout(1200);
    }
    const after = await page.evaluate(() => window.__sent.slice(-8));
    console.log(`[4] ws frames sent by tap: ${after.length - 0} (total grew from ${before})`);
    console.log('[4] last frames:', JSON.stringify(after));
    // TYPE_TOUCH === 2 in src/app/controlMessage/ControlMessage.ts
    const touchMsgs = after.filter((f) => f.type === 2);
    console.log(touchMsgs.length ? `[4] OK touch control messages sent: ${touchMsgs.length}` : '[4] FAIL no touch control message produced by the tap');

    if (errors.length) {
        console.log('[!] page errors:\n' + errors.slice(0, 10).join('\n'));
    } else {
        console.log('[!] no page errors');
    }
    console.log(`screenshots in ${OUT}`);
    await browser.close();
}

main().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
});
