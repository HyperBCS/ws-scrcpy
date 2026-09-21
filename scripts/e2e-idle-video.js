/* eslint-disable */
// BASE=http://127.0.0.1:8000 SERIAL=<optional udid> node scripts/e2e-idle-video.js
// Mock mode sends config + exactly one red IDR and then stays silent. SERIAL additionally joins
// the real device with both players; it never sends touches/keys or changes device state.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SERIAL = process.env.SERIAL;
const CONFIG = Buffer.from('000000016742c00ada25b011000003000100000300788f1226a00000000168ce0fc8', 'hex');
const IDR = Buffer.from('000000016588843a118a000218f1c00040f63800087949d75e', 'hex');

function initial() {
    const packet = Buffer.alloc(186);
    packet.write('scrcpy_initial');
    packet.write('Static red frame', 14);
    packet.writeInt32BE(1, 78);
    packet.writeInt32BE(32, 86);
    packet.writeInt32BE(32, 90);
    packet.writeInt32BE(25, 110);
    packet.writeInt32BE(32, 122);
    packet.writeInt32BE(32, 126);
    packet.writeInt32BE(32, 130);
    packet.writeInt32BE(32, 134);
    packet.writeInt32BE(35, 139);
    packet.writeInt32BE(4000000, 143);
    packet.writeInt32BE(60, 147);
    packet.writeInt8(1, 151);
    packet.writeInt8(-1, 165);
    packet.writeInt32BE(1, 182);
    return packet;
}

function sampleScreen(expectedRed) {
    const video = document.querySelector('.video-layer');
    if (!video) return false;
    if (video instanceof HTMLVideoElement && (video.readyState < 2 || video.videoWidth === 0)) return false;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 16, 16);
    const pixels = ctx.getImageData(0, 0, 16, 16).data;
    if (expectedRed) {
        const center = (8 * 16 + 8) * 4;
        return pixels[center] > 200 && pixels[center + 1] < 50 && pixels[center + 2] < 50;
    }
    // A real idle test page must have some visible content. No screenshot or interaction is
    // used to provoke a frame; read already-rendered pixels only.
    for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) return true;
    }
    return false;
}

async function checkPlayer(context, player, realHref) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let url;
    let packets = 0;
    if (realHref) {
        url = new URL(realHref, BASE);
        const params = new URLSearchParams(url.hash.replace(/^#!/, ''));
        params.set('player', player);
        params.set('captureKeyboard', '0');
        params.set('fitToScreen', '1');
        url.hash = `!${params}`;
    } else {
        const socketUrl = new URL('/__idle_frame_fixture__', BASE);
        socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        await page.routeWebSocket(socketUrl.toString(), (socket) => {
            setTimeout(() => {
                socket.send(initial());
                socket.send(CONFIG);
                socket.send(IDR);
                packets += 3;
            }, 100);
        });
        url = new URL(BASE);
        url.hash = `!${new URLSearchParams({ action: 'stream', udid: 'idle-frame-fixture', player, ws: socketUrl.toString(), captureKeyboard: '0', fitToScreen: '1' })}`;
    }
    try {
        await page.goto(url.toString());
        await page.waitForFunction(
            () => document.querySelector('.stream-header-status')?.textContent.includes('Connected'),
            undefined,
            { timeout: 45000 },
        );
        const started = Date.now();
        await page.waitForFunction(sampleScreen, !realHref, { timeout: 5000 });
        const decoded = await page
            .locator('.video-layer')
            .evaluate((el) =>
                el instanceof HTMLVideoElement ? el.getVideoPlaybackQuality().totalVideoFrames : undefined,
            );
        if (player === 'mse') {
            assert(decoded > 0, 'the browser decoded an actual video frame');
            assert(
                await page
                    .locator('video.video-layer')
                    .evaluate((video) => video.playsInline && video.hasAttribute('playsinline')),
                'mobile playback stays inline',
            );
        }
        if (!realHref) assert.equal(packets, 3, 'no later picture or remote movement was needed');
        assert.deepEqual(errors, [], 'no browser runtime errors');
        console.log(
            `PASS ${realHref ? 'device ' + SERIAL : 'single-frame fixture'} ${player}: visible pixels after ${Date.now() - started}ms${decoded === undefined ? '' : ', decoded=' + decoded}`,
        );
    } finally {
        await page.close();
    }
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        for (const player of ['mse', 'webcodecs']) await checkPlayer(context, player);
        if (SERIAL) {
            const list = await context.newPage();
            await list.goto(BASE);
            const stream = list.locator('.device').filter({ hasText: SERIAL }).locator('a.desc-block.stream').first();
            await stream.waitFor();
            const href = await stream.getAttribute('href');
            assert(href, 'the selected device has a stream link');
            for (const player of ['mse', 'webcodecs']) await checkPlayer(context, player, href);
        }
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
