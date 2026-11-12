// E2E_OUT=/tmp/ws-scrcpy-web-security node scripts/test-browser.js web-security
// Where the browser may connect. An Android card has one route, through the server, whatever
// addresses the phone reports and whatever this browser saved earlier. A stream link cannot name
// another host for its socket. The response headers stop framing and foreign connections in a real
// browser. Every device socket is a fixture; the header checks use a loopback server of their own.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const WS = require('ws');
const playwright = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-web-security';
const browserName = process.env.BROWSER || 'chromium';
const ANDROID = 'fixture-android-route';
const IPHONE = 'fixture-iphone-route';
const PHONE_ADDRESS = '192.168.1.42';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

// An Android phone on Wi-Fi, asleep, with its stream service running: the case where the card
// used to preselect the phone's own address.
const android = {
    udid: ANDROID, state: 'device', pid: 123, 'ro.product.model': 'Pixel fixture', 'ro.product.manufacturer': 'Fixture',
    'ro.build.version.release': '16', 'ro.build.version.sdk': '36', 'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'off', 'device.awake': false, 'battery.level': 80, 'battery.charging': false,
    interfaces: [{ name: 'wlan0', ipv4: PHONE_ADDRESS }, { name: 'rmnet0', ipv4: '10.20.30.40' }], 'wifi.interface': 'wlan0',
};
const iphone = {
    udid: IPHONE, name: 'iPhone fixture', state: 'Connected', model: 'iPhone 13 Pro Max', version: '27.2', paired: true,
    developerMode: true, session: 'ready', 'screen.power': 'on', 'device.locked': false,
};

/** A page whose sockets are all fixtures. `sockets` lists every URL the page tried to open. */
async function start(browser, { mobile = true, dark = false, hash } = {}) {
    const context = await browser.newContext({
        viewport: mobile ? PHONE : DESKTOP, isMobile: mobile, hasTouch: mobile, colorScheme: dark ? 'dark' : 'light',
    });
    // A choice saved while the card still had a Connection select.
    await context.addInitScript(([udid]) => {
        try {
            for (const tracker of ['android', 'goog']) localStorage.setItem(`device_list::${tracker}_${udid}::interface`, 'wlan0');
        } catch {}
    }, [ANDROID]);
    const page = await context.newPage();
    const errors = [];
    const sockets = [];
    const commands = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        const url = new URL(socket.url());
        sockets.push(url);
        const action = url.searchParams.get('action');
        if (action === 'proxy-coredevice') {
            setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 50);
            return;
        }
        if (action === 'proxy-adb') {
            setTimeout(() => socket.send(initialStreamPacket()), 50);
            return;
        }
        socket.onMessage((data) => {
            const frame = Buffer.from(data);
            if (frame.length < 5) return;
            const id = frame.readUInt32LE(1);
            const reply = (message) => socket.send(channelJson(id, message));
            if (frame[0] === 4) {
                const code = frame.subarray(5).toString();
                if (code === 'HSTS') reply({ id: -1, type: 'hosts', data: { local: [{ type: 'ios' }, { type: 'android' }] } });
                if (code === 'ATRC') reply({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [iphone] } });
                if (code === 'GTRC') reply({ id: -1, type: 'devicelist', data: { id: 'android', name: 'Devices', list: [android] } });
            } else if (frame[0] === 32) {
                commands.push(JSON.parse(frame.subarray(5).toString()));
            }
        });
    });
    const url = new URL(BASE);
    if (hash) url.hash = `!${typeof hash === 'string' ? hash : new URLSearchParams(hash)}`;
    await page.goto(url.toString());
    return { context, page, errors, sockets, commands };
}

const own = new URL(BASE);
const ownSocketHost = own.host;
function assertOnlyOwnSockets(sockets, label) {
    for (const url of sockets) {
        assert.equal(url.host, ownSocketHost, `${label}: ${url} goes to this server`);
        assert.equal(url.protocol, own.protocol === 'https:' ? 'wss:' : 'ws:', `${label}: ${url} uses the page's scheme`);
    }
}

async function androidCard(browser) {
    for (const [label, mobile, dark] of [
        ['phone-light', true, false],
        ['phone-dark', true, true],
        ['desktop-light', false, false],
        ['desktop-dark', false, true],
    ]) {
        const test = await start(browser, { mobile, dark });
        const { page } = test;
        const card = page.locator('.device').filter({ hasText: 'Pixel fixture' });
        await card.waitFor();

        const open = card.getByRole('link', { name: 'Open screen', exact: true });
        const link = new URLSearchParams(new URL(await open.getAttribute('href')).hash.slice(2));
        // The link names the phone only. The page opens the socket itself (checked below).
        assert.equal(link.get('ws'), null, `${label}: Open screen names no socket`);
        assert.equal(link.get('udid'), ANDROID);
        assert.equal(link.get('hostname'), null, 'a local link names no host');

        // The card offers no connection choice and no address of the phone. Every link on it
        // names the phone only, never a socket.
        assert.equal(await card.locator('select').count(), 0, `${label}: no Connection select`);
        assert.equal(await card.getByRole('button', { name: 'Refresh connection' }).count(), 0, `${label}: no Refresh connection`);
        assert.doesNotMatch(await card.textContent(), new RegExp(`wlan0|${PHONE_ADDRESS.replaceAll('.', '\\.')}`), `${label}: the phone's own address is not offered`);
        for (const link of await card.locator('a[href]').all()) {
            const params = new URLSearchParams(new URL(await link.getAttribute('href')).hash.slice(2));
            assert.equal(params.get('ws'), null, `${label}: ${await link.getAttribute('aria-label') || await link.textContent()} names no socket`);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no sideways scroll`);
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(OUT, `android-card-${label}.png`) });

        // Wake is a command on the device list's own connection to the server (p2-android-server):
        // it opens no socket, so it cannot reach another host or the phone's own address.
        const before = test.sockets.length;
        await card.getByRole('button', { name: 'Wake', exact: true }).click();
        await page.waitForTimeout(200);
        assert.equal(test.sockets.length, before, `${label}: Wake opens no socket`);
        assert.deepEqual(
            test.commands.filter((command) => command.type === 'wake_device').map((command) => command.data?.udid),
            [ANDROID],
            `${label}: Wake asks the server`,
        );
        await open.click();
        await page.getByText('Connected', { exact: true }).waitFor();
        const stream = test.sockets.filter((url) => url.searchParams.get('action') === 'proxy-adb');
        assert.deepEqual(stream.map((url) => [url.host, url.searchParams.get('udid')]), [[ownSocketHost, ANDROID]], `${label}: Open screen connects through the server`);
        assertOnlyOwnSockets(test.sockets, label);
        assert.equal(test.commands.filter((command) => command.type === 'update_interfaces').length, 0);
        assert.deepEqual(test.errors, [], `${label}: no runtime errors`);
        await test.context.close();
        console.log('PASS', label, 'Android card: one route through the server, no interface choice, Wake goes to the server');
    }
}

async function streamLinks(browser) {
    // An iPhone stream link that names another host: the stored passcode would go down this socket.
    const crafted = await start(browser, {
        hash: { action: 'stream-coredevice', udid: IPHONE, hostname: 'attacker.example', port: '443', secure: 'true', pathname: '/collect' },
    });
    await crafted.page.waitForFunction(() => document.querySelector('.stream-view, .coredevice-stream, [class*="stream"]'));
    await crafted.page.waitForTimeout(600);
    const iphoneSockets = crafted.sockets.filter((url) => url.searchParams.get('action') === 'proxy-coredevice');
    assert.equal(iphoneSockets.length >= 1, true, 'the iPhone stream connected');
    assert.equal(iphoneSockets[0].pathname, own.pathname, 'the link does not choose the path either');
    assertOnlyOwnSockets(crafted.sockets, 'crafted iPhone link');
    assert.deepEqual(crafted.errors, []);
    await crafted.context.close();
    console.log('PASS', 'an iPhone stream link with a foreign hostname connects to this server only');

    // An Android stream link whose socket is another host is refused, with a way forward.
    for (const ws of ['wss://attacker.example/?action=proxy-adb&remote=tcp%3A8886&udid=' + ANDROID, `ws://${PHONE_ADDRESS}:8886/`]) {
        for (const mobile of [true, false]) {
            const refused = await start(browser, { mobile, hash: { action: 'stream', udid: ANDROID, player: 'mse', ws } });
            await refused.page.getByText('This link connects to another server. Open the device from the Devices page.').waitFor();
            await refused.page.waitForTimeout(300);
            assertOnlyOwnSockets(refused.sockets, `refused ${ws}`);
            assert.equal(refused.sockets.filter((url) => url.searchParams.get('action') === 'proxy-adb').length, 0, 'no stream socket was opened');
            assert.equal(await refused.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            if (ws.startsWith('wss://attacker')) await refused.page.screenshot({ path: path.join(OUT, `refused-link-${mobile ? 'phone' : 'desktop'}.png`) });
            // The error offers the way back to the device list.
            await refused.page.locator('.stream-start-error button.kit-button', { hasText: 'Phones' }).click();
            await refused.page.locator('.device').first().waitFor();
            assert.deepEqual(refused.errors, []);
            await refused.context.close();
        }
    }
    console.log('PASS', 'an Android stream link to another host is refused and says what to do');

    // The switcher marks the device being viewed by its serial. The link here lists its socket's
    // parameters in another order than the card writes them.
    const socket = new URL(BASE);
    socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
    socket.search = new URLSearchParams({ udid: ANDROID, remote: 'tcp:8886', action: 'proxy-adb' }).toString();
    const viewing = await start(browser, {
        hash: { action: 'stream', udid: ANDROID, player: 'webcodecs', ws: socket.toString(), captureKeyboard: '0', fitToScreen: '1' },
    });
    await viewing.page.getByText('Connected', { exact: true }).waitFor();
    await viewing.page.getByRole('button', { name: 'Switch', exact: true }).click();
    const current = viewing.page.locator('.device-switcher-item.current');
    await current.waitFor();
    assert.match(await current.textContent(), /Pixel fixture/);
    assert.match(await current.textContent(), /Viewing/);
    assert.equal(await current.isDisabled(), true, 'the device being viewed cannot be opened again');
    assert.equal(await viewing.page.locator('.device-switcher-item.current').count(), 1);
    assertOnlyOwnSockets(viewing.sockets, 'stream');
    assert.deepEqual(viewing.errors, []);
    await viewing.context.close();
    console.log('PASS', 'the switcher marks the viewed Android device by serial');
}

/** The real header middleware in front of the built app, and a second origin that plays the other site. */
async function headers(browser) {
    global.__PATHNAME__ = '/';
    require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
    const { knownHost, securityHeaders } = require('../src/server/requestOrigin');
    const app = express();
    app.use(knownHost, securityHeaders);
    app.get('/api/notifications/summary', (_req, res) => res.json({ sources: [], unread: 0, unreadBySource: {} }));
    app.use(express.static(path.join(__dirname, '../dist/public')));
    const server = http.createServer(app);
    const accepted = [];
    const wss = new WS.Server({ server });
    wss.on('connection', (socket, request) => {
        accepted.push(request.url);
        socket.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const appOrigin = `http://127.0.0.1:${server.address().port}`;

    const otherHits = [];
    const other = http.createServer((request, response) => {
        otherHits.push(request.url);
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Content-Type', 'text/html');
        response.end(`<!doctype html><title>other site</title><iframe id="app" src="${appOrigin}/" width="390" height="600"></iframe>`);
    });
    const otherSockets = new WS.Server({ server: other });
    otherSockets.on('connection', (socket, request) => {
        otherHits.push(`socket ${request.url}`);
        socket.on('error', () => undefined);
    });
    other.listen(0, '127.0.0.1');
    await once(other, 'listening');
    const otherOrigin = `http://127.0.0.1:${other.address().port}`;

    try {
        const context = await browser.newContext({ viewport: PHONE });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const response = await page.goto(`${appOrigin}/`);
        assert.equal(response.headers()['x-frame-options'], 'DENY');
        assert.match(response.headers()['content-security-policy'], /frame-ancestors 'none'; connect-src 'self' /);
        // The app's own sockets are allowed: the page opens its multiplexed socket by itself.
        await page.locator('#devices').waitFor();
        await page.waitForFunction(() => true);
        const deadline = Date.now() + 5000;
        while (!accepted.length && Date.now() < deadline) await page.waitForTimeout(50);
        assert(accepted.some((url) => url.includes('action=multiplex')), `${browserName}: the app's own WebSocket is allowed (${accepted})`);
        assert.equal((await page.evaluate(() => fetch('api/notifications/summary').then((reply) => reply.status))), 200);

        // What a crafted link or injected script would try: a socket and a request to another host.
        const result = await page.evaluate(async (target) => {
            const violations = [];
            document.addEventListener('securitypolicyviolation', (event) => violations.push(`${event.effectiveDirective} ${event.blockedURI}`));
            const socket = await new Promise((resolve) => {
                try {
                    const ws = new WebSocket(target.replace('http:', 'ws:') + '/collect');
                    ws.onopen = () => resolve('open');
                    ws.onerror = () => resolve('error');
                    ws.onclose = () => resolve('closed');
                } catch (error) {
                    resolve(`threw ${error.name}`);
                }
                setTimeout(() => resolve('timeout'), 3000);
            });
            const request = await fetch(target + '/collect', { mode: 'cors' }).then(() => 'fetched', () => 'failed');
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { socket, request, violations };
        }, otherOrigin);
        assert.notEqual(result.socket, 'open', `${browserName}: a socket to another host is blocked (${result.socket})`);
        assert.equal(result.request, 'failed', `${browserName}: a request to another host is blocked`);
        assert.equal(result.violations.filter((entry) => entry.startsWith('connect-src')).length, 2, `${browserName}: both were stopped by the policy: ${result.violations}`);
        assert.deepEqual(otherHits, [], 'nothing reached the other host');
        assert.deepEqual(errors, []);

        // Another site frames the app: the frame stays empty.
        const framing = await context.newPage();
        await framing.goto(`${otherOrigin}/`);
        await framing.waitForTimeout(800);
        const frame = framing.frames().find((candidate) => candidate !== framing.mainFrame());
        const framed = frame ? await frame.locator('#root, #devices').count().catch(() => 0) : 0;
        assert.equal(framed, 0, `${browserName}: the app does not render inside another site's frame`);
        await framing.screenshot({ path: path.join(OUT, `framed-${browserName}.png`) });

        // A name that is not this server's: the page is not served at all.
        const foreign = await context.request.get(`${appOrigin}/`, { headers: { Host: 'evil.example:8000' } });
        assert.equal(foreign.status(), 403);
        await context.close();
        console.log('PASS', browserName, 'headers: own sockets allowed, foreign socket and request blocked, framing refused');
    } finally {
        for (const client of [...wss.clients, ...otherSockets.clients]) client.terminate();
        wss.close();
        otherSockets.close();
        server.closeAllConnections();
        other.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await new Promise((resolve) => other.close(resolve));
    }
}

/**
 * The notifications page over plain HTTP on a name that is not loopback, where alerts cannot work.
 * The link to the secure address comes from the server's WS_PUBLIC_URL, or is not shown.
 */
async function privateAppNotice() {
    // Chromium treats 127.0.0.1 as secure; this name resolves to it and is not.
    const browser = await playwright.chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP insecure.test 127.0.0.1'] });
    try {
        for (const [label, mobile, dark, publicUrl] of [
            ['phone-light', true, false, ''],
            ['desktop-dark', false, true, ''],
            ['phone-dark', true, true, 'https://phone.example'],
            ['desktop-light', false, false, 'https://phone.example'],
        ]) {
            const context = await browser.newContext({
                viewport: mobile ? PHONE : DESKTOP, isMobile: mobile, hasTouch: mobile, colorScheme: dark ? 'dark' : 'light',
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.routeWebSocket('**', () => {});
            await page.route('**/api/notifications/**', (route) => route.fulfill({ json: {
                sources: [], notifications: [], bluetooth: [], statuses: {}, pairing: null, pairingOpen: false, error: '',
                delivery: { sent: 0, failed: 0, lastError: '' }, unread: 0, unreadBySource: {}, publicKey: '', publicUrl,
            } }));
            const url = new URL(BASE);
            url.hostname = 'insecure.test';
            url.hash = '!action=notifications';
            await page.goto(url.toString());
            assert.equal(await page.evaluate(() => isSecureContext), false, 'the fixture page is not a secure context');
            await page.getByRole('radio', { name: 'Setup & delivery', exact: true }).click();
            const notice = page.locator('.notification-receiver .notification-card');
            await notice.waitFor();
            const link = notice.getByRole('link', { name: 'Open private app', exact: true });
            if (publicUrl) {
                assert.equal(await link.getAttribute('href'), 'https://phone.example/#!action=notifications');
            } else {
                assert.equal(await link.count(), 0, `${label}: no link without a configured address`);
                assert.match(await notice.textContent(), /Set WS_PUBLIC_URL on the server/);
            }
            assert.doesNotMatch(await page.content(), /ts\.net/, `${label}: no host name is built in`);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no sideways scroll`);
            await notice.scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(OUT, `private-app-${publicUrl ? 'link' : 'hint'}-${label}.png`) });
            assert.deepEqual(errors, []);
            await context.close();
        }
        console.log('PASS', 'the private app link is the configured address, or a hint to set one');
    } finally {
        await browser.close();
    }
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await playwright[browserName].launch({ headless: true });
    try {
        await androidCard(browser);
        await streamLinks(browser);
        await headers(browser);
    } finally {
        await browser.close();
    }
    if (browserName === 'chromium') await privateAppNotice();
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
