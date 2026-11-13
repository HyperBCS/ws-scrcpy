/* eslint-disable */
// node scripts/test-browser.js home
// The Phones list, its cards, the switcher and the screen headers, against socket fixtures: the
// Notifications entry, one name and one tab-title format, one status per card with at most one
// line under it, Wake beside an asleep phone's status, Open screen disabled with the reason, the
// action row, Settings on every card, the switcher rows as the card's head (current first, then
// the phones that can be opened, then the rest, greyed), scroll and focus restore, and the refusal
// of tool links that name an iPhone. The list is also measured against the kit: the type scale,
// kit buttons at their heights, the kit bar with one h1, status as a chip with words, and the
// unread count as a badge. Loading before the first list, the stale cards while the list
// reconnects, and the even grid on a desktop (U-home-8, U-home-9). No phone, adb or
// pymobiledevice3 is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const { settleMotion } = require('./ui-motion');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-home';
const NOW = Date.now();

const android = (udid, model, extra = {}) => ({
    udid, state: 'device', pid: 123, interfaces: [], 'ro.product.model': model, 'ro.product.manufacturer': 'Google',
    'ro.build.version.release': '16', 'ro.build.version.sdk': '36', 'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'on', 'device.awake': true, 'battery.level': 80, 'battery.charging': false, ...extra,
});
const iphone = (udid, name, extra = {}) => ({
    udid, name, model: 'iPhone 13 Pro Max', version: '27.2', state: 'Connected', paired: true, developerMode: true,
    session: 'stopped', 'screen.power': 'on', 'device.locked': false, 'last.update.timestamp': NOW, ...extra,
});
const schedule = { enabled: true, time: '03:00', hasPasscode: true, serverTimeZone: 'UTC', lastUnlockedAt: NOW - 2 * 86400000 };

// The last one is ready with its stream service stopped, the normal state of an idle phone, so
// its card has no line.
const ANDROIDS = [
    android('HOME-PIXEL-0001', 'Pixel 9 Pro'),
    android('HOME-TAB-0002', 'Galaxy Tab S9', { 'screen.power': 'off', 'device.awake': false }),
    android('HOME-LOCKED-0003', 'Pixel 8', { 'device.locked': true }),
    android('HOME-OFFLINE-0004', 'Pixel 7', { state: 'offline', pid: -1 }),
    android('HOME-UNAUTH-0005', 'Pixel 6', { state: 'unauthorized', pid: -1 }),
    android('HOME-IDLE-0006', 'Pixel 5', { pid: -1, 'battery.level': 35, 'battery.charging': true }),
];
const LINKED = 'HOME-IPHONE-LINKED';
const IPHONES = [
    iphone(LINKED, 'iPhone linked'),
    iphone('HOME-IPAD-NODEV', 'iPad mini', { developerMode: false }),
    iphone('HOME-IPHONE-ERROR', 'iPhone failed', { session: 'error', sessionMessage: 'The screen stream ended.' }),
    iphone('HOME-IPHONE-UNLOCK', 'iPhone unlock', {
        'screen.power': 'off',
        unlockSchedule: { ...schedule, lastRun: { at: NOW - 3600000, trigger: 'schedule', outcome: 'failed-wake' } },
    }),
    iphone('HOME-IPHONE-STREAM', 'iPhone streaming', { session: 'ready' }),
    iphone('HOME-IPHONE-START', 'iPhone starting', { session: 'starting' }),
    iphone('HOME-IPHONE-AWAY', 'iPhone away', { state: 'disconnected', unlockSchedule: { ...schedule, hasPasscode: false } }),
];
const SUMMARY = { unread: 5, unreadBySource: { [LINKED]: 2, 'bluetooth-only': 3 }, sources: [{ id: LINKED, name: 'iPhone linked' }, { id: 'bluetooth-only', name: 'Bluetooth iPhone' }] };

function frame(type, id, data) {
    const body = Buffer.from(data);
    const packet = Buffer.alloc(5 + body.length);
    packet[0] = type; packet.writeUInt32LE(id, 1); body.copy(packet, 5);
    return packet;
}

async function start(browser, { width, height, mobile, colorScheme = 'light', androids = ANDROIDS, iphones = IPHONES, summary = SUMMARY, hash, holdLists = false, remoteAndroids = [] } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, colorScheme, serviceWorkers: 'block' });
    const page = await context.newPage();
    // `streams` counts the screen sockets the page opens; `updateAndroid` sends one phone's new
    // descriptor on the Android list, as the server does when a phone changes. With `holdLists`
    // set the lists wait until `releaseLists()`; `dropList()` closes the list's socket, as a
    // server restart does, and the page opens a new one by itself. `listIds` are the ids the lists
    // carry; a restarted server sends new ones.
    const state = {
        context, page, errors: [], commands: [], channels: [], summary, streams: 0, updateAndroid: undefined,
        holdLists: false, heldLists: [], remoteSocket: undefined, listSocket: undefined, listIds: { android: 'android', ios: 'ios' },
        releaseLists() { state.holdLists = false; state.heldLists.splice(0).forEach((send) => send()); },
        dropList() { state.listSocket.close({ code: 1006, reason: 'Server restart' }); },
    };
    const list = (send) => (state.holdLists ? state.heldLists.push(send) : send());
    page.on('pageerror', (error) => state.errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith('/summary')) return route.fulfill({ json: state.summary });
        return route.fulfill({ json: {
            ...state.summary, sources: state.summary.sources.map((source) => ({ ...source, address: '', apps: [], preview: true })),
            notifications: [], bluetooth: [], statuses: {}, pairing: null, pairingOpen: false, error: '',
            delivery: { sent: 0, failed: 0, lastError: '' }, publicKey: '', publicUrl: 'https://example.test',
        } });
    });
    await page.routeWebSocket('**', (socket) => {
        const socketUrl = new URL(socket.url());
        const action = socketUrl.searchParams.get('action');
        const remote = socketUrl.hostname === 'remote.test';
        if (action === 'proxy-adb') {
            state.streams++;
            setTimeout(() => socket.send(initialStreamPacket()), 40);
            return;
        }
        if (action === 'proxy-coredevice') {
            state.streams++;
            return; // The iPhone stream stays on "Connecting".
        }
        if (remote) state.remoteSocket = socket;
        else state.listSocket = socket;
        socket.onMessage((data) => {
            const packet = Buffer.from(data);
            if (packet.length < 5) return;
            const id = packet.readUInt32LE(1), body = packet.subarray(5).toString();
            const send = (message) => socket.send(frame(32, id, JSON.stringify(message)));
            if (packet[0] === 4) {
                state.channels.push(body);
                if (body === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }], remote: remoteAndroids.length ? [{ type: 'android', hostname: 'remote.test', port: 80, secure: false }] : [] } });
                if (body === 'GTRC' && remote) {
                    state.remoteSend = (type, data) => send({ id: -1, type, data: { id: 'remote-android', name: 'Remote fixture host', ...data } });
                    if (!state.holdRemote) state.remoteSend('devicelist', { list: remoteAndroids });
                }
                if (body === 'GTRC' && !remote) {
                    list(() => send({ id: -1, type: 'devicelist', data: { id: state.listIds.android, name: 'Fixture host', list: androids } }));
                    state.updateAndroid = (device) => send({ id: -1, type: 'device', data: { id: state.listIds.android, name: 'Fixture host', device } });
                }
                if (body === 'ATRC') list(() => send({ id: -1, type: 'devicelist', data: { id: state.listIds.ios, name: 'Fixture host', list: iphones } }));
            } else if (packet[0] === 32 && body.startsWith('{')) {
                try {
                    const command = JSON.parse(body);
                    // The fixture answers nothing by itself; a check can answer a command later.
                    command.reply = (data) => send({ id: command.id, type: command.type, data });
                    state.commands.push(command);
                } catch {}
            }
        });
    });
    state.holdLists = holdLists;
    const url = new URL(BASE);
    if (hash) url.hash = `!${new URLSearchParams(hash)}`;
    await page.goto(url.toString());
    return state;
}

const card = (page, key) => page.locator(`article.device[data-device-key="${key}"]`);
/** What each row of a switcher shows, in order. */
const switcherRows = (sheet) => sheet.locator('.device-switcher-item').evaluateAll((items) => items.map((item) => ({
    name: item.querySelector('.phone-row-name').textContent,
    platform: item.querySelector('.phone-row-platform').textContent,
    chips: [...item.querySelectorAll('.kit-chip')].map((chip) => chip.textContent),
    chip: item.querySelector('.kit-chip').outerHTML,
    unread: item.querySelector('.phone-row-unread .kit-badge')?.textContent ?? '',
    inUse: item.querySelector('.phone-row-in-use')?.textContent ?? '',
    disabled: item.disabled,
    label: item.textContent,
    text: item.textContent,
})));
// The bar of the list: the kit bar in its root form.
const HEADER = 'header.kit-bar.kit-bar-root';
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
/** The card and the link that have the focus, or null when no control of a card has it. */
const focusedCardControl = (page) => page.evaluate(() => {
    const key = document.activeElement?.closest('article.device')?.dataset.deviceKey;
    return key ? { key, href: document.activeElement.getAttribute('href') } : null;
});
/** Waits up to `ms` for a condition on the fixture's side. */
async function until(page, check, what, ms = 8000) {
    for (let waited = 0; waited < ms && !check(); waited += 50) await page.waitForTimeout(50);
    assert.ok(check(), what);
}

/** WCAG contrast of an element's text on its own background, composited over what is behind it. */
function contrastOf(locator) {
    return locator.evaluate((el) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const paint = (colors) => {
            context.clearRect(0, 0, 1, 1);
            for (const color of colors) { context.fillStyle = color; context.fillRect(0, 0, 1, 1); }
            return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
        };
        const layers = [];
        for (let node = el; node; node = node.parentElement) layers.unshift(getComputedStyle(node).backgroundColor);
        const background = paint(['#fff', ...layers]);
        const text = paint([`rgb(${background.join(',')})`, getComputedStyle(el).color]);
        const luminance = (rgb) => {
            const [r, g, b] = rgb.map((value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const [a, b] = [luminance(background), luminance(text)].sort((x, y) => y - x);
        return { ratio: (a + 0.05) / (b + 0.05), size: parseFloat(getComputedStyle(el).fontSize) };
    });
}

async function devicesPage(browser, { width, height, mobile, colorScheme }) {
    const label = `${width}-${colorScheme}`;
    const test = await start(browser, { width, height, mobile, colorScheme });
    const { page } = test;
    try {
        await card(page, 'ios:HOME-IPHONE-START').waitFor();
        await page.locator(`${HEADER} .kit-badge`).waitFor();
        await settleMotion(page);
        assert.equal(await page.title(), 'Phones · ws-scrcpy');

        // Header: a Notifications entry with the total unread count, and a reload control.
        const header = page.locator(HEADER);
        const inbox = header.getByRole('link', { name: 'Notifications, 5 unread', exact: true });
        assert.equal(await inbox.getAttribute('href'), '#!action=notifications');
        assert.equal(await inbox.locator('.kit-badge').textContent(), '5');
        const reload = header.getByRole('button', { name: 'Reload', exact: true });
        for (const control of [inbox, reload]) {
            const box = await control.boundingBox();
            assert.ok(box.width >= 44 && box.height >= 44, `${label}: header controls keep a 44px target`);
        }
        const pill = header.locator('.kit-bar-status');
        assert.equal((await pill.textContent()).trim(), '10 available · 3 need attention');
        assert.equal(await pill.getAttribute('role'), 'status');
        const title = await header.getByRole('heading', { name: 'Phones', exact: true }).boundingBox();
        assert.ok(Math.abs((await inbox.boundingBox()).y + 22 - (title.y + title.height / 2)) < 16, `${label}: the actions sit on the heading row`);
        assert.equal(await noOverflow(page), true, `${label}: no horizontal page scroll`);

        // Status: 12px or larger and 4.5:1 on its own tint, for every state.
        const expected = {
            'android:HOME-PIXEL-0001': 'Ready', 'android:HOME-TAB-0002': 'Asleep', 'android:HOME-LOCKED-0003': 'Locked',
            'android:HOME-OFFLINE-0004': 'Offline', 'android:HOME-UNAUTH-0005': 'Unauthorized', 'android:HOME-IDLE-0006': 'Ready',
            [`ios:${LINKED}`]: 'Ready', 'ios:HOME-IPAD-NODEV': 'Needs attention', 'ios:HOME-IPHONE-ERROR': 'Error',
            'ios:HOME-IPHONE-UNLOCK': 'Needs attention', 'ios:HOME-IPHONE-STREAM': 'Ready', 'ios:HOME-IPHONE-START': 'Starting…',
            'ios:HOME-IPHONE-AWAY': 'Offline',
        };
        for (const [key, status] of Object.entries(expected)) {
            const badge = card(page, key).locator('.device-status');
            assert.equal(await badge.textContent(), status, key);
            const { ratio, size } = await contrastOf(badge);
            assert.ok(size >= 12, `${label} ${status}: status text is ${size}px`);
            assert.ok(ratio >= 4.5, `${label} ${status}: status contrast is ${ratio.toFixed(2)}`);
        }
        // One status per card: one chip, and at most one line under the head. A running session is
        // a dot and "In use" on the platform line, the same on both platforms, never a chip.
        const cards = await page.locator('article.device').evaluateAll((items) => items.map((item) => ({
            key: item.dataset.deviceKey,
            chips: [...item.querySelectorAll('.kit-chip')].map((chip) => chip.textContent),
            lines: [...item.querySelectorAll('.device-line')].map((line) => line.dataset.line),
            inUse: item.querySelector('.phone-row-meta .phone-row-in-use')?.textContent ?? '',
            dot: !!item.querySelector('.phone-row-in-use > .phone-row-dot'),
            text: item.textContent,
        })));
        assert.equal(cards.length, Object.keys(expected).length);
        for (const item of cards) {
            assert.deepEqual(item.chips, [expected[item.key]], `${label} ${item.key}: one chip, the status`);
            assert.ok(item.lines.length <= 1, `${label} ${item.key}: at most one line under the head (${item.lines})`);
            assert.doesNotMatch(item.text, /Session running|Stream service: |Screen is asleep|Device unavailable|Waiting for trust/, `${label} ${item.key}: says its status once`);
        }
        const inUse = cards.filter((item) => item.inUse).map((item) => item.key).sort();
        assert.deepEqual(inUse, ['android:HOME-LOCKED-0003', 'android:HOME-PIXEL-0001', 'android:HOME-TAB-0002', 'ios:HOME-IPHONE-STREAM'], `${label}: In use where a session runs`);
        assert.ok(cards.filter((item) => item.inUse).every((item) => item.inUse === 'In use' && item.dot), `${label}: a dot and In use`);
        const lines = Object.fromEntries(cards.filter((item) => item.lines.length).map((item) => [item.key, item.lines[0]]));
        assert.deepEqual(lines, {
            'android:HOME-OFFLINE-0004': 'offline', 'android:HOME-UNAUTH-0005': 'unauthorized',
            'ios:HOME-IPAD-NODEV': 'developer-mode', 'ios:HOME-IPHONE-ERROR': 'session', 'ios:HOME-IPHONE-UNLOCK': 'unlock', 'ios:HOME-IPHONE-AWAY': 'offline',
        }, `${label}: the line of each card`);
        assert.equal(await page.getByText('Streaming', { exact: true }).count(), 0, `${label}: Streaming is not a status`);
        assert.ok((await contrastOf(card(page, 'ios:HOME-IPHONE-STREAM').locator('.phone-row-in-use'))).ratio >= 4.5, `${label}: In use is readable`);
        // An idle Android phone, its stream service stopped: the head and the actions, no line and
        // no Start. Open screen starts the service; Settings starts and stops it by hand.
        const idle = card(page, 'android:HOME-IDLE-0006');
        const parts = await idle.evaluate((item) => [...item.children].map((child) =>
            child.classList.contains('device-header') ? 'head' : child.classList.contains('device-primary-actions') ? 'actions' : child.className));
        assert.deepEqual(parts, ['head', 'actions'], `${label}: an idle Android card is its head and its actions`);
        assert.equal(await idle.getByRole('button', { name: /^Start/ }).count(), 0, `${label}: no Start on an idle card`);
        assert.equal(await page.locator('.stream-service-status').count(), 0, `${label}: no Stream service line on a card`);
        const small = await page.locator('#devices .device').evaluateAll((items) =>
            items.flatMap((el) => [...el.querySelectorAll('.phone-row-meta, .device-line, .device-schedule, .desc-block')])
                .map((node) => parseFloat(getComputedStyle(node).fontSize)).filter((size) => size < 12));
        assert.deepEqual(small, [], `${label}: no card text under 12px`);

        // The disclosure is gone: Settings is on every card, in every state.
        assert.equal(await page.locator('#devices summary, #devices details').count(), 0, `${label}: no Details disclosure`);
        for (const item of cards) {
            const name = await card(page, item.key).locator('.phone-row-name').textContent();
            await card(page, item.key).locator('.device-primary-actions').getByRole('button', { name: `Settings for ${name}`, exact: true }).waitFor();
        }
        // No serial and no tracker name on a card.
        for (const device of [...ANDROIDS, ...IPHONES]) assert.equal(await page.getByText(device.udid).count(), 0, `${label}: no serial ${device.udid}`);
        assert.equal(await page.locator('#devices').getByText('Fixture host').count(), 0, `${label}: no tracker name`);

        // Open screen is always the first button. Where the screen cannot be opened it is
        // disabled and the one line says why; no other words stand in for it.
        for (const key of ['android:HOME-OFFLINE-0004', 'android:HOME-UNAUTH-0005', 'ios:HOME-IPAD-NODEV', 'ios:HOME-IPHONE-AWAY']) {
            const open = card(page, key).getByRole('button', { name: 'Open screen', exact: true });
            assert.equal(await open.isDisabled(), true, `${label} ${key}: Open screen is disabled`);
            assert.equal(await card(page, key).getByRole('link', { name: 'Open screen', exact: true }).count(), 0);
        }
        await card(page, 'android:HOME-OFFLINE-0004').getByText("Not connected. Check the phone's cable or network connection.", { exact: true }).waitFor();
        await card(page, 'android:HOME-UNAUTH-0005').getByText('Unlock this phone and approve the USB debugging or trust prompt to connect.', { exact: true }).waitFor();
        for (const name of ['Device unavailable', 'Waiting for trust']) assert.equal(await page.getByRole('button', { name }).count(), 0, `${label}: no "${name}" button`);

        // Action row: Open screen takes at least half, then Files and Shell where the phone has
        // them, Notifications where it sends them here, and Settings, all icon buttons.
        const rowOf = (key) => card(page, key).locator('.device-primary-actions');
        const boxes = (key) => rowOf(key).evaluate((row) => [...row.children].map((child) => ({
            width: child.getBoundingClientRect().width, height: child.getBoundingClientRect().height, top: child.getBoundingClientRect().top,
            text: child.textContent.trim(), name: child.getAttribute('aria-label') || child.textContent.trim(),
            background: getComputedStyle(child).backgroundColor, border: getComputedStyle(child).borderTopColor,
            row: row.clientWidth,
        })));
        const pixel = await boxes('android:HOME-PIXEL-0001');
        const linked = await boxes(`ios:${LINKED}`);
        assert.deepEqual(pixel.map((box) => box.name), ['Open screen', 'Files on Google Pixel 9 Pro', 'Shell on Google Pixel 9 Pro', 'Settings for Google Pixel 9 Pro']);
        assert.deepEqual(linked.map((box) => box.text), ['Open screen', '2', '']);
        assert.deepEqual((await boxes('android:HOME-OFFLINE-0004')).map((box) => box.name), ['Open screen', 'Settings for Google Pixel 7'], `${label}: no Files or Shell for an offline phone`);
        for (const row of [pixel, linked]) {
            assert.ok(row[0].width >= row[0].row / 2 - 1, `${label}: Open screen takes at least half the row (${row[0].width} of ${row[0].row})`);
            assert.ok(row.every((box) => box.height >= 44 && Math.abs(box.top - row[0].top) < 1), `${label}: one row of 44px controls ${JSON.stringify(row)}`);
            assert.ok(row.slice(1).every((box) => box.width === 44), `${label}: Notifications and Settings are 44px icon buttons`);
        }
        await card(page, `ios:${LINKED}`).getByRole('link', { name: 'Notifications for iPhone linked, 2 unread', exact: true }).waitFor();
        assert.equal(linked[1].background, linked[2].background, `${label}: Notifications and Settings share a surface`);
        assert.equal(linked[1].border, linked[2].border);
        assert.equal(pixel[3].background, linked[2].background, `${label}: Settings looks the same on both platforms`);
        assert.equal(pixel[1].background, pixel[3].background, `${label}: Files is an icon button like Settings`);

        // Notifications on a card only where the iPhone sends its notifications to this server.
        assert.equal(await card(page, `ios:${LINKED}`).locator('.device-notification-history').getAttribute('href'), `#!action=notifications&source=${LINKED}`);
        for (const key of ['ios:HOME-IPAD-NODEV', 'ios:HOME-IPHONE-ERROR', 'ios:HOME-IPHONE-STREAM'])
            assert.equal(await card(page, key).locator('.device-notification-history').count(), 0, `${key} has no inbox to open`);

        // Files and Shell are icon links of the Android card, to the phone's tool pages.
        const pixelCard = card(page, 'android:HOME-PIXEL-0001');
        for (const [name, view] of [['Files', 'files'], ['Shell', 'shell']]) {
            const link = pixelCard.getByRole('link', { name: `${name} on Google Pixel 9 Pro`, exact: true });
            assert.equal(await link.isVisible(), true, `${name} is on the card`);
            assert.match(await link.getAttribute('href'), new RegExp(`action=device&udid=HOME-PIXEL-0001&view=${view}`));
        }
        for (const key of [`ios:${LINKED}`, 'ios:HOME-IPHONE-STREAM']) assert.equal(await card(page, key).locator('.device-tool').count(), 0, `${key}: an iPhone has no Files or Shell`);

        // Asleep: Wake sits beside the status in the head, and one press sends one wake. An iPhone
        // has no wake request from the list, so its card has no Wake.
        const tab = card(page, 'android:HOME-TAB-0002');
        const wake = tab.locator('.phone-row-status').getByRole('button', { name: 'Wake', exact: true });
        const chipBox = await tab.locator('.phone-row-status .kit-chip').boundingBox();
        const wakeBox = await wake.boundingBox();
        assert.ok(wakeBox.x >= chipBox.x + chipBox.width && Math.abs(wakeBox.y + wakeBox.height / 2 - (chipBox.y + chipBox.height / 2)) < 2, `${label}: Wake is beside the status`);
        assert.equal(await card(page, 'ios:HOME-IPHONE-UNLOCK').getByRole('button', { name: 'Wake' }).count(), 0, `${label}: no Wake on an iPhone`);
        assert.equal(await page.getByRole('button', { name: 'Wake', exact: true }).count(), 1, `${label}: Wake only on the asleep Android phone`);
        await wake.click();
        const waking = tab.getByRole('button', { name: 'Waking…', exact: true });
        await waking.waitFor();
        assert.equal(await waking.isDisabled(), true, `${label}: Wake cannot be pressed twice`);
        await waking.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(100);
        assert.deepEqual(test.commands.filter((command) => command.type === 'wake_device').map((command) => command.data), [{ udid: 'HOME-TAB-0002' }], `${label}: one wake`);
        assert.equal(await tab.locator('.device-line').count(), 0, `${label}: no line under an asleep phone`);

        // Developer Mode off: not Ready, and the screen cannot be opened.
        const ipad = card(page, 'ios:HOME-IPAD-NODEV');
        assert.equal(await ipad.getByRole('link', { name: 'Open screen', exact: true }).count(), 0);
        assert.equal(await ipad.getByRole('button', { name: 'Open screen', exact: true }).isDisabled(), true);
        await ipad.getByText('Enable Developer Mode to open the screen.', { exact: true }).waitFor();
        await ipad.getByRole('button', { name: 'Enable and restart', exact: true }).waitFor();

        // A failed session: the message as a problem line with one action, confirmed.
        const failed = card(page, 'ios:HOME-IPHONE-ERROR');
        const line = failed.locator('.device-problem[data-problem="session"]');
        assert.equal(await line.locator('.kit-banner-text').textContent(), 'The screen stream ended.');
        assert.ok((await contrastOf(line.locator('.kit-banner-text'))).ratio >= 4.5, `${label}: the error line is readable`);
        assert.notEqual(
            await line.evaluate((el) => getComputedStyle(el).color),
            await failed.locator('.phone-row-meta').evaluate((el) => getComputedStyle(el).color),
            `${label}: an error is not the neutral grey`,
        );
        // Open screen stays: the owner can still try the screen of a phone whose session failed.
        await failed.getByRole('link', { name: 'Open screen', exact: true }).waitFor();
        await line.getByRole('button', { name: 'Restart services', exact: true }).click();
        const prompt = failed.getByRole('alertdialog', { name: 'Restart services on iPhone failed?', exact: true });
        await prompt.waitFor();
        assert.equal(test.commands.filter((command) => command.type === 'restart_session').length, 0, 'the first press sends nothing');
        await prompt.locator('.kit-confirm-go:not([aria-disabled])').waitFor();
        await prompt.getByRole('button', { name: 'Restart services', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.kit-confirm'));
        assert.deepEqual(test.commands.filter((command) => command.type === 'restart_session').map((command) => command.data.udid), ['HOME-IPHONE-ERROR']);
        // The outcome is a status line directly under the line whose button was pressed, not a
        // grey paragraph further down the card.
        const outcome = failed.locator('.device-problem[data-problem="session"] + .kit-status');
        assert.equal(await outcome.textContent(), 'Restarting services…', `${label}: the outcome is under the control that caused it`);
        assert.equal(await failed.locator('.kit-status').count(), 1, `${label}: the outcome shows once`);

        // A failed scheduled unlock: a problem line whose action opens the settings panel.
        const unlock = card(page, 'ios:HOME-IPHONE-UNLOCK');
        const unlockLine = unlock.locator('.device-problem[data-problem="unlock"]');
        assert.match(await unlockLine.locator('.device-unlock-schedule.problem').textContent(), /^Scheduled unlock 03:00 and 15:00 · /);
        assert.equal(await unlock.locator('.device-schedule').count(), 0, 'the problem is not said twice');
        await page.screenshot({ path: path.join(OUT, `devices-${label}.png`), fullPage: true });
        // An unplugged iPhone has no action for its unlock problem: the schedule stays as its own
        // line, and the line under the head says that the phone is not connected.
        const away = card(page, 'ios:HOME-IPHONE-AWAY');
        assert.equal(await away.locator('.device-problem').count(), 0);
        assert.equal(await away.locator('.device-schedule .device-unlock-schedule.problem').textContent(), 'Scheduled unlock cannot run: no passcode');
        await unlockLine.getByRole('button', { name: 'Open settings for iPhone unlock', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
        await dialog.waitFor();
        await settleMotion(page);
        await dialog.getByRole('button', { name: /^Close/ }).click();
        await dialog.waitFor({ state: 'hidden' });
        // Settings opens from a card in every state, offline and untrusted included.
        for (const [key, name] of [['android:HOME-OFFLINE-0004', 'Google Pixel 7'], ['android:HOME-UNAUTH-0005', 'Google Pixel 6'], ['ios:HOME-IPHONE-AWAY', 'iPhone away']]) {
            await card(page, key).getByRole('button', { name: `Settings for ${name}`, exact: true }).click();
            await dialog.waitFor();
            await settleMotion(page);
            await dialog.getByRole('button', { name: /^Close/ }).click();
            await dialog.waitFor({ state: 'hidden' });
            await settleMotion(page);
        }

        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'Phones header, one status per card, one line under it, Wake beside the status, the action row');
    } finally {
        await test.context.close();
    }
}

/**
 * The list measured against the kit: what a person can read and press on the page, as a list of
 * faults.
 */
function auditList({ mobile }) {
    const faults = [];
    const page = document.querySelector('.devices-page');
    const shown = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const name = (element) => {
        const key = element.closest('[data-device-key]')?.getAttribute('data-device-key') || 'page';
        const text = (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 40);
        return `${key} / ${element.tagName.toLowerCase()}.${String(element.getAttribute('class') || '').split(' ')[0]} "${text}"`;
    };
    // Type: every piece of text is on the scale, and nothing is under 12px.
    const SCALE = [12, 13, 15, 17, 20, 24];
    for (const element of page.querySelectorAll('*')) {
        if (element.closest('svg') || !shown(element)) continue;
        const hasText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
        if (!hasText) continue;
        const size = parseFloat(getComputedStyle(element).fontSize);
        if (!SCALE.includes(size)) faults.push(`${size}px is not on the type scale: ${name(element)}`);
    }
    // Controls: every button and link that looks like one is the kit's, at the kit's height.
    for (const element of page.querySelectorAll('button, a[href]')) {
        if (!shown(element)) continue;
        const kit = element.matches('.kit-button, .kit-icon-button');
        if (!kit) faults.push(`not a kit button: ${name(element)}`);
        const compact = element.matches('.kit-button-compact, .kit-icon-button-compact');
        const expected = compact && !mobile ? 32 : 44;
        const { width, height } = element.getBoundingClientRect();
        // A line of words in place of Open screen may wrap; it is never shorter.
        const tall = element.matches('.stream.unavailable') ? height >= expected : Math.abs(height - expected) < 0.5;
        if (kit && !tall) faults.push(`${height}px high, not ${expected}px: ${name(element)}`);
        if (element.matches('.kit-icon-button') && Math.abs(width - expected) >= 0.5) faults.push(`not square: ${name(element)}`);
        const label = (element.getAttribute('aria-label') || element.textContent || '').trim();
        if (!label) faults.push(`a control without a name: ${name(element)}`);
    }
    // A card has no disclosure: what it held is in the phone's Settings.
    for (const summary of page.querySelectorAll('summary')) faults.push(`a disclosure on the list: ${name(summary)}`);
    // The header is the kit bar, with the page's one h1. A sheet has a header of its own inside its
    // dialog, which stays in the page while the sheet is closed.
    const bars = [...document.querySelectorAll('header')].filter((header) => !header.closest('dialog'));
    if (bars.length !== 1 || !bars[0].matches('.kit-bar.kit-bar-root')) faults.push('the header is not the kit bar of the list');
    const headings = [...document.querySelectorAll('h1')].map((heading) => heading.textContent);
    if (headings.join('|') !== 'Phones') faults.push(`the page has these h1: ${headings.join('|') || 'none'}`);
    // A status is one chip with words, never a glyph alone. A running session is a mark, not a chip.
    for (const item of page.querySelectorAll('article.device')) {
        const chips = item.querySelectorAll('.kit-chip');
        if (chips.length !== 1 || !chips[0].closest('.device-header')) faults.push(`${chips.length} chips: ${name(item)}`);
        else if (!/^[A-Za-z][A-Za-z ]{3,}…?$/.test(chips[0].textContent)) faults.push(`a status without words: "${chips[0].textContent}"`);
        for (const mark of item.querySelectorAll('.phone-row-in-use')) {
            if (mark.textContent !== 'In use') faults.push(`the session mark says "${mark.textContent}"`);
        }
        if (item.querySelectorAll('.device-line').length > 1) faults.push(`more than one line under the head: ${name(item)}`);
    }
    // Text glyphs that stood in for icons.
    const glyphs = page.textContent.match(/[☾⚠✕▶●▣◐○→←]/g);
    if (glyphs) faults.push(`text glyphs in place of icons: ${[...new Set(glyphs)].join(' ')}`);
    // The unread count is a badge on the bell, and the bell's name says the count.
    const bell = document.querySelector('header .notifications-link');
    const badge = bell?.querySelector('.kit-badge');
    if (!bell?.matches('a.kit-icon-button')) faults.push('the bell is not a kit icon button');
    if (bell?.getAttribute('aria-label') !== 'Notifications, 5 unread') faults.push(`the bell is named "${bell?.getAttribute('aria-label')}"`);
    if (badge?.textContent !== '5' || badge.getAttribute('aria-hidden') !== 'true') faults.push('the unread count is not a badge inside the named bell');
    if (document.documentElement.scrollWidth > innerWidth + 1) faults.push('the page scrolls sideways');
    return faults;
}

async function kitList(browser, { width, height, mobile, colorScheme }) {
    const label = `${width}-${colorScheme}`;
    const test = await start(browser, { width, height, mobile, colorScheme });
    const { page } = test;
    try {
        await card(page, 'ios:HOME-IPHONE-START').waitFor();
        await page.locator(`${HEADER} .kit-badge`).waitFor();
        await settleMotion(page);
        assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), mobile, `${label}: the pointer of the context`);
        assert.deepEqual(await page.evaluate(auditList, { mobile }), [], `${label}: the list against the kit`);
        // Focus shows the token's ring on a kit control of the bar and of a card.
        if (!mobile) {
            const ring = await page.evaluate(() => {
                const probe = document.createElement('span');
                probe.style.outline = 'var(--focus-ring)';
                document.body.append(probe);
                const value = getComputedStyle(probe).outlineColor;
                probe.remove();
                return value;
            });
            await page.keyboard.press('Tab');
            for (let step = 0; step < 4; step++) {
                const focus = await page.evaluate(() => {
                    const style = getComputedStyle(document.activeElement);
                    return { name: document.activeElement.getAttribute('aria-label') || document.activeElement.textContent, style: style.outlineStyle, width: style.outlineWidth, colour: style.outlineColor };
                });
                assert.deepEqual([focus.style, focus.width, focus.colour], ['solid', '2px', ring], `${label}: the focus ring on "${focus.name}"`);
                await page.keyboard.press('Tab');
            }
        }
        await page.screenshot({ path: path.join(OUT, `kit-list-${label}.png`), fullPage: true });
        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'the list on the kit: type scale, kit buttons and heights, kit bar with one h1, status chips, unread badge');
    } finally {
        await test.context.close();
    }
}

/**
 * A phone with a notch, emulated: the bar's fill reaches the top and the sides of the window,
 * what is in the bar and in the list keeps clear of the notch, and the list ends above the home
 * indicator. A real phone still has to show this.
 */
async function notchedList(browser) {
    const insets = { top: 47, left: 44, right: 44, bottom: 21 };
    const test = await start(browser, { width: 844, height: 390, mobile: true });
    const { page } = test;
    try {
        const cdp = await test.context.newCDPSession(page);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
        await page.reload();
        await card(page, 'ios:HOME-IPHONE-START').waitFor();
        await settleMotion(page);
        const seen = await page.evaluate((HEADER) => {
            const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
            const bar = document.querySelector(HEADER);
            return {
                bar: box(bar), title: box(bar.querySelector('h1')), reload: box(bar.querySelector('button')),
                list: box(document.querySelector('#devices')), card: box(document.querySelector('article.device')),
            };
        }, HEADER);
        assert.deepEqual([seen.bar.left, seen.bar.top, seen.bar.right], [0, 0, 844], 'the bar reaches the top and the sides');
        assert.ok(seen.title.top >= insets.top && seen.title.left >= insets.left, `the title is clear of the notch ${JSON.stringify(seen.title)}`);
        assert.ok(seen.reload.top >= insets.top && seen.reload.right <= 844 - insets.right, `Reload is clear of the notch ${JSON.stringify(seen.reload)}`);
        // The bar is about 61px high: its two lines of text, its padding and its edge.
        assert.ok(seen.bar.bottom >= 60 + insets.top && seen.bar.bottom <= 64 + insets.top, `the bar is its own height below the notch, with no second inset (${seen.bar.bottom})`);
        assert.ok(seen.card.left >= insets.left && seen.card.right <= 844 - insets.right, `a card is clear of the sides ${JSON.stringify(seen.card)}`);
        assert.ok(seen.list.bottom <= 390 - insets.bottom + 1, `the list ends above the home indicator ${JSON.stringify(seen.list)}`);
        assert.equal(await noOverflow(page), true, 'no horizontal page scroll with a notch');
        assert.deepEqual(test.errors, []);
        console.log('PASS notch: the bar fills to the edges, and the bar and the list keep clear of the insets');
    } finally {
        await test.context.close();
    }
}

/** Waits up to two seconds for a request of the page to cross the fixture's socket. */
async function arrived(page, check) {
    for (let i = 0; i < 100 && !check(); i++) await page.waitForTimeout(20);
}

/**
 * Start in an idle Android phone's Settings (About and troubleshooting): one start request,
 * Starting… as the status on its card until the phone reports the service, and In use once it
 * does. A phone that goes away ends the Starting flag at once, so it is not Starting… when it
 * comes back. Nothing here opens a screen.
 */
async function startFromSettings(browser) {
    const udid = 'HOME-IDLE-0006';
    const idle = android(udid, 'Pixel 5', { pid: -1 });
    const test = await start(browser, { width: 390, height: 844, mobile: true, androids: [idle], iphones: [] });
    const { page } = test;
    try {
        const item = card(page, `android:${udid}`);
        const chip = item.locator('.phone-row-status .kit-chip');
        const starts = () => test.commands.filter((command) => command.type === 'start_server').map((command) => command.data);
        await item.getByRole('button', { name: 'Settings for Google Pixel 5', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
        await dialog.waitFor();
        const row = dialog.locator('[data-section="about"] [data-service="stream-service"]');
        const startButton = row.getByRole('button', { name: 'Start stream service', exact: true });
        const stopped = row.getByText('Stopped. It starts when the screen is opened.', { exact: true });
        await stopped.waitFor();
        await startButton.click();
        await chip.getByText('Starting…', { exact: true }).waitFor();
        assert.equal(await startButton.isDisabled(), true, 'Start cannot be pressed twice');
        assert.equal(await item.locator('.device-line').count(), 0, 'no line on the card while the service starts');
        await arrived(page, () => starts().length > 0);
        assert.deepEqual(starts(), [{ udid }], 'one start request');

        // The phone reports the service: Ready with In use, and no line.
        test.updateAndroid({ ...idle, pid: 4242 });
        await chip.getByText('Ready', { exact: true }).waitFor();
        assert.equal(await item.locator('.phone-row-in-use').textContent(), 'In use');
        assert.equal(await item.locator('.device-line').count(), 0);
        // It stops later: the row says Stopped, and the status is not Starting…. Well inside the
        // flag's own time limit, so it is the report that ended the flag.
        test.updateAndroid({ ...idle, pid: -1 });
        await stopped.waitFor({ timeout: 3000 });
        assert.equal(await chip.textContent(), 'Ready');

        // A start that the phone never confirms, then the phone goes away and comes back.
        await startButton.click();
        await chip.getByText('Starting…', { exact: true }).waitFor();
        test.updateAndroid({ ...idle, state: 'offline' });
        await chip.getByText('Offline', { exact: true }).waitFor();
        test.updateAndroid(idle);
        await stopped.waitFor({ timeout: 3000 });
        assert.equal(await chip.textContent(), 'Ready', 'the Starting flag ended with the phone');
        assert.equal(await item.locator('.device-line').count(), 0, 'no line on the card once it is back');
        await arrived(page, () => starts().length > 1);
        assert.deepEqual(starts(), [{ udid }, { udid }], 'one start request per press');
        assert.equal(test.streams, 0, 'no screen was opened');
        assert.deepEqual(test.errors, []);
        console.log('PASS Start in Settings for an idle Android phone: one request, Starting… on its card until the phone reports the service');
    } finally {
        await test.context.close();
    }
}

/**
 * Wake belongs to one sleep: a reply that comes after the phone woke and slept again does not
 * speak for the new sleep, and each press sends one wake.
 */
async function wakeOnePerSleep(browser) {
    const udid = 'HOME-TAB-0002';
    const asleep = android(udid, 'Galaxy Tab S9', { 'screen.power': 'off', 'device.awake': false });
    const awake = { ...asleep, 'screen.power': 'on', 'device.awake': true };
    const test = await start(browser, { width: 390, height: 844, mobile: true, androids: [asleep], iphones: [] });
    const { page } = test;
    try {
        const item = card(page, `android:${udid}`);
        const head = item.locator('.phone-row-status');
        const wakes = () => test.commands.filter((command) => command.type === 'wake_device');
        const sent = async (count) => {
            await arrived(page, () => wakes().length >= count);
            assert.equal(wakes().length, count, 'one wake per press');
        };
        await head.getByRole('button', { name: 'Wake', exact: true }).click();
        await head.getByRole('button', { name: 'Waking…', exact: true }).waitFor();
        await sent(1);
        const first = wakes()[0];
        // The screen comes on and goes off again before the server answers the first press.
        test.updateAndroid(awake);
        await head.locator('.kit-chip').getByText('Ready', { exact: true }).waitFor();
        assert.equal(await head.getByRole('button', { name: /^Wak/ }).count(), 0, 'no Wake for a phone that is awake');
        test.updateAndroid(asleep);
        await head.getByRole('button', { name: 'Wake', exact: true }).waitFor();
        first.reply({ udid });
        await page.waitForTimeout(200);
        assert.equal(await item.getByText('Wake sent', { exact: false }).count(), 0, 'a late reply does not speak for this sleep');
        assert.equal(await head.getByRole('button', { name: 'Wake', exact: true }).isEnabled(), true);
        // A new press is its own wake, and its reply is shown.
        await head.getByRole('button', { name: 'Wake', exact: true }).click();
        await sent(2);
        wakes()[1].reply({ udid });
        await item.getByText('Wake sent. Waiting for the screen.', { exact: true }).waitFor();
        assert.equal(test.streams, 0, 'no screen was opened');
        assert.deepEqual(test.errors, []);
        console.log('PASS Wake on a card: one wake per press, and its outcome belongs to one sleep');
    } finally {
        await test.context.close();
    }
}

/**
 * U-home-8: before the first list the page says it is loading, and never that no phone is
 * connected; a first list that is empty says so.
 */
async function firstList(browser, { width, height, mobile, colorScheme }) {
    const label = `${width}-${colorScheme}`;
    const test = await start(browser, { width, height, mobile, colorScheme, holdLists: true });
    const { page } = test;
    try {
        const loading = page.locator('#devices .device-list-loading');
        await loading.waitFor();
        await until(page, () => test.heldLists.length === 2, `${label}: both lists were asked for`);
        // It comes in after a short wait, and stays until a list arrives.
        await page.waitForTimeout(600);
        assert.equal(await loading.getAttribute('role'), 'status');
        assert.equal(await loading.getAttribute('aria-busy'), 'true');
        assert.equal(await loading.evaluate((el) => getComputedStyle(el).opacity), '1', `${label}: the loading box is shown`);
        assert.equal((await loading.textContent()).trim(), 'Loading phones…');
        assert.equal(await page.getByRole('heading', { name: /No phones connected|Connection lost/ }).count(), 0, `${label}: no empty state before the first list`);
        assert.equal((await page.locator(`${HEADER} .kit-bar-status`).textContent()).trim(), 'Waiting for phones');
        assert.equal(await noOverflow(page), true);
        await page.screenshot({ path: path.join(OUT, `loading-${label}.png`) });
        test.releaseLists();
        await card(page, 'ios:HOME-IPHONE-START').waitFor();
        assert.equal(await loading.count(), 0, `${label}: the cards take the place of the loading box`);
        assert.deepEqual(test.errors, []);
    } finally {
        await test.context.close();
    }
    // An empty first list: the empty state, with no loading box.
    const empty = await start(browser, { width, height, mobile, colorScheme, androids: [], iphones: [] });
    try {
        await empty.page.getByRole('heading', { name: 'No phones connected', exact: true }).waitFor();
        assert.equal(await empty.page.locator('.device-list-loading').count(), 0);
        assert.equal((await empty.page.locator(`${HEADER} .kit-bar-status`).textContent()).trim(), 'Waiting for phones');
        assert.deepEqual(empty.errors, []);
    } finally {
        await empty.context.close();
    }
    console.log('PASS', label, 'loading before the first list, the empty state only for an empty list');
}

/** The cards as the list shows them: name, status, stale mark and opacity of the name. */
const cardsOf = (page) => page.locator('article.device').evaluateAll((items) => items.map((item) => ({
    name: item.querySelector('.phone-row-name').textContent,
    chip: item.querySelector('.phone-row-status .kit-chip').textContent,
    stale: item.classList.contains('stale'),
    dim: getComputedStyle(item.querySelector('.phone-row-text')).opacity,
})));

/**
 * U-home-8: the list's socket drops. The cards stay, each with the status it had, dimmed under
 * one Reconnecting bar; nothing on them reaches a phone and none opens a screen, while Settings
 * still opens. The next list makes them live again, with the focus and the scroll where they
 * were, also when it comes from a restarted server under new ids. No screen socket is opened at
 * any point.
 */
async function reconnectingList(browser, { width, height, mobile, colorScheme }) {
    const label = `${width}-${colorScheme}`;
    const androids = [...ANDROIDS, ...Array.from({ length: 20 }, (_, index) => android(`HOME-MORE-${String(index).padStart(2, '0')}`, `More ${String(index).padStart(2, '0')}`))];
    const test = await start(browser, { width, height, mobile, colorScheme, androids });
    const { page } = test;
    const list = page.locator('#devices');
    const bar = page.locator('.devices-reconnecting .kit-banner');
    const pill = page.locator(`${HEADER} .kit-bar-status`);
    const drop = async () => {
        const asked = test.channels.length;
        test.holdLists = true;
        test.dropList();
        await bar.waitFor();
        return asked;
    };
    // The page reconnects on its own after 2 s and asks for both lists again.
    const reconnect = async (asked) => {
        await until(page, () => test.channels.length >= asked + 3 && test.heldLists.length === 2, `${label}: the page asked for the lists again`);
        test.releaseLists();
        await bar.waitFor({ state: 'detached' });
    };
    try {
        let target = card(page, 'android:HOME-MORE-15');
        await target.waitFor();
        await settleMotion(page);
        await list.evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
        await target.scrollIntoViewIfNeeded();
        const open = target.getByRole('link', { name: 'Open screen', exact: true });
        const href = await open.getAttribute('href');
        await open.focus();
        await page.waitForTimeout(100);
        const scrollTop = await list.evaluate((el) => el.scrollTop);
        assert.ok(scrollTop > 100, `${label}: the list is scrolled (${scrollTop})`);
        const before = await cardsOf(page);
        const summary = (await pill.textContent()).trim();

        const asked = await drop();
        assert.equal(await bar.getAttribute('role'), 'status');
        assert.equal((await bar.textContent()).trim(), 'Reconnecting… The phones are shown as last reported.');
        assert.equal(await page.locator('.devices-reconnecting').count(), 1, `${label}: one bar`);
        assert.equal((await pill.textContent()).trim(), 'Reconnecting…', `${label}: the page's line agrees with the bar`);
        const during = await cardsOf(page);
        assert.deepEqual(during.map((item) => [item.name, item.chip]), before.map((item) => [item.name, item.chip]), `${label}: every card stays, in its place, with the status it had`);
        assert.ok(during.every((item) => item.stale && item.dim === '0.5'), `${label}: every card is stale and dimmed`);
        assert.ok(before.every((item) => !item.stale && item.dim === '1'));
        assert.equal(await page.getByText('Offline', { exact: true }).count(), before.filter((item) => item.chip === 'Offline').length, `${label}: no stale phone is called Offline`);
        // Nothing on a card reaches the phone or opens one of its pages.
        assert.equal(await list.locator('a[href*="action=device"]').count(), 0, `${label}: no link to a phone's page`);
        assert.equal(await list.getByRole('link', { name: 'Open screen', exact: true }).count(), 0);
        assert.equal(await target.getByRole('button', { name: 'Open screen', exact: true }).isDisabled(), true);
        for (const name of ['Files', 'Shell']) {
            const link = target.getByRole('link', { name: `${name} on Google More 15`, exact: true });
            assert.deepEqual([await link.getAttribute('aria-disabled'), await link.getAttribute('href')], ['true', null], `${label}: ${name} is off`);
        }
        assert.equal(await card(page, 'android:HOME-TAB-0002').getByRole('button', { name: 'Wake', exact: true }).isDisabled(), true, `${label}: Wake is off`);
        assert.equal(await card(page, 'ios:HOME-IPHONE-ERROR').getByRole('button', { name: 'Restart services', exact: true }).isDisabled(), true);
        assert.equal(await card(page, 'ios:HOME-IPAD-NODEV').getByRole('button', { name: 'Enable and restart', exact: true }).isDisabled(), true);
        // Settings, the line's Open settings and Notifications stay.
        assert.equal(await target.getByRole('button', { name: 'Settings for Google More 15', exact: true }).isEnabled(), true);
        assert.equal(await card(page, 'ios:HOME-IPHONE-UNLOCK').getByRole('button', { name: 'Open settings for iPhone unlock', exact: true }).isEnabled(), true);
        assert.equal(await card(page, `ios:${LINKED}`).locator('.device-notification-history').getAttribute('href'), `#!action=notifications&source=${LINKED}`);
        assert.ok(Math.abs((await list.evaluate((el) => el.scrollTop)) - scrollTop) <= 1, `${label}: the list did not move`);
        assert.equal(await noOverflow(page), true);
        await page.screenshot({ path: path.join(OUT, `reconnecting-${label}.png`) });

        // The next list, from the server restarted under new ids: live cards, the summary back,
        // the focus on the link it was on and the list where it was.
        test.listIds = { android: 'android-2', ios: 'ios-2' };
        await reconnect(asked);
        assert.deepEqual(await cardsOf(page), before, `${label}: the cards are as they were`);
        assert.equal((await pill.textContent()).trim(), summary);
        target = card(page, 'android-2:HOME-MORE-15');
        assert.deepEqual(await focusedCardControl(page), { key: 'android-2:HOME-MORE-15', href }, `${label}: the focus is back on Open screen`);
        assert.ok(Math.abs((await list.evaluate((el) => el.scrollTop)) - scrollTop) <= 1, `${label}: the list is where it was`);

        // Again, and this time press what a stale card offers: Open screen does nothing, and
        // Settings opens.
        const address = await page.evaluate(() => location.href);
        const again = await drop();
        await target.getByRole('button', { name: 'Open screen', exact: true }).click({ force: true });
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => location.href), address, `${label}: a stale card opens no screen`);
        await target.getByRole('button', { name: 'Settings for Google More 15', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
        await dialog.waitFor();
        await settleMotion(page);
        // It says what it last knew, and that the list is reconnecting, not that the phone is off.
        const staleBanner = 'Reconnecting to the server. Settings that need it are off until it is back.';
        await dialog.getByText(staleBanner, { exact: true }).waitFor();
        const fact = (name) => dialog.locator(`[data-fact="${name}"] .kit-row-value`).textContent();
        assert.deepEqual([await fact('status'), await fact('connection')], ['Ready', 'Reconnecting…'], `${label}: the stale phone in its Settings`);
        await dialog.getByRole('button', { name: /^Close/ }).click();
        await dialog.waitFor({ state: 'hidden' });
        await reconnect(again);
        await target.getByRole('link', { name: 'Open screen', exact: true }).waitFor();

        // Settings of an iPhone stays open through a drop and the list of a restarted server.
        // While the list is stale the schedule, which is kept on the server, cannot be changed.
        // The new list lists the phone under a new key, and the sheet has the phone again.
        const third = await drop();
        await card(page, 'ios-2:HOME-IPHONE-UNLOCK').getByRole('button', { name: 'Settings for iPhone unlock', exact: true }).click();
        await dialog.waitFor();
        await settleMotion(page);
        await dialog.getByText(staleBanner, { exact: true }).waitFor();
        const toggle = dialog.getByRole('switch', { name: 'Unlock twice a day' });
        assert.equal(await toggle.isDisabled(), true, `${label}: the schedule cannot be changed while the list is stale`);
        test.listIds = { android: 'android-3', ios: 'ios-3' };
        await reconnect(third);
        await dialog.locator('[data-fact="connection"] .kit-row-value').getByText('Connected', { exact: true }).waitFor({ timeout: 5000 });
        assert.equal(await dialog.getByText(/^(Reconnecting to the server|Waiting for the phone)/).count(), 0, `${label}: Settings has the phone again`);
        assert.equal(await toggle.isEnabled(), true, `${label}: the schedule can be changed again`);
        await dialog.getByRole('button', { name: /^Close/ }).click();
        await dialog.waitFor({ state: 'hidden' });

        // Focus that had left the cards before the drop stays where it is after the next list.
        await page.evaluate(() => document.activeElement?.blur());
        const fourth = await drop();
        test.listIds = { android: 'android-4', ios: 'ios-4' };
        await reconnect(fourth);
        await card(page, 'android-4:HOME-MORE-15').getByRole('link', { name: 'Open screen', exact: true }).waitFor();
        assert.equal(await focusedCardControl(page), null, `${label}: no card takes the focus it did not have`);
        assert.equal(test.streams, 0, `${label}: no screen was opened`);
        assert.deepEqual(test.commands, [], `${label}: nothing was sent to a phone`);
        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'a dropped list keeps its cards stale under one Reconnecting bar, and the next list brings them back with focus and scroll');
    } finally {
        await test.context.close();
    }
}

/**
 * U-home-9: on a desktop the cards are an even grid. One width for every card, rows whose cards
 * share their top, their height and the line of their actions, and at most three columns in the
 * 1200px of the list. The widths are measured, not read from the stylesheet.
 */
/** A reconnect notice belongs to its server; healthy phones keep their controls and summary. */
async function reconnectingOneServer(browser, size) {
    const test = await start(browser, { ...size, androids: [ANDROIDS[0]], iphones: [], remoteAndroids: [android('HOME-REMOTE', 'Remote phone')] });
    const { page } = test;
    try {
        const local = card(page, 'android:HOME-PIXEL-0001');
        const remote = card(page, 'remote-android:HOME-REMOTE');
        await remote.waitFor();
        const localOpen = local.getByRole('link', { name: 'Open screen', exact: true });
        await localOpen.focus();
        const localBox = await local.boundingBox();
        // A multiplex channel closes without closing the other server's socket.
        test.holdRemote = true;
        test.remoteSocket.close({ code: 1006, reason: 'Only the remote server dropped' });
        await remote.locator('.phone-row-stale').waitFor();
        const affected = remote.locator('xpath=ancestor::section[contains(@class,"tracker-block")]');
        const healthy = local.locator('xpath=ancestor::section[contains(@class,"tracker-block")]');
        assert.equal(await page.locator('.devices-reconnecting').count(), 0, 'No page-wide warning over a healthy server');
        assert.match(await affected.locator('.tracker-reconnecting').textContent(), /Reconnecting…/);
        assert.equal(await healthy.locator('.tracker-reconnecting').count(), 0);
        assert.equal(await localOpen.isEnabled(), true);
        assert.equal(await localOpen.evaluate((node) => node === document.activeElement), true, 'Healthy card keeps focus');
        assert.equal(await remote.getByRole('button', { name: 'Open screen', exact: true }).isDisabled(), true);
        assert.doesNotMatch(await page.locator(`${HEADER} .kit-bar-status`).textContent(), /Reconnecting/);
        const after = await local.boundingBox();
        assert.equal(after.width, localBox.width, 'The card grid keeps its even widths');
        await page.screenshot({ path: path.join(OUT, `one-server-reconnecting-${size.width}-${size.colorScheme}.png`), fullPage: true });
        assert.equal(test.streams, 0);
        assert.deepEqual(test.errors, []);
    } finally { await test.context.close(); }
}

/** A stale switcher row keeps its last status and explicitly says why it is disabled. */
async function reconnectingSwitcher(browser, size) {
    const test = await start(browser, { ...size, androids: [ANDROIDS[0], ANDROIDS[1]], iphones: [] });
    const { page } = test;
    try {
        await card(page, 'android:HOME-PIXEL-0001').getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.touch-layer').waitFor();
        await page.getByRole('button', { name: 'Switch', exact: true }).click();
        const sheet = page.getByRole('dialog', { name: 'Switch phone', exact: true });
        await sheet.waitFor();
        test.holdLists = true;
        test.dropList();
        const stale = sheet.locator('.device-switcher-item:not(.current)');
        await stale.locator('.device-switcher-reconnecting').waitFor();
        assert.equal((await stale.locator('.device-switcher-reconnecting').textContent()).trim(), 'Reconnecting…');
        assert.equal(await stale.isDisabled(), true);
        assert.equal(await stale.locator('.kit-chip').textContent(), 'Asleep', 'The last phone status is retained');
        assert.equal(await stale.evaluate((node) => { node.focus(); return node !== document.activeElement; }), true);
        assert.equal(test.streams, 1, 'Opening the sheet and dropping the list never remount the stream');
        await page.screenshot({ path: path.join(OUT, `switcher-reconnecting-${size.width}-${size.colorScheme}.png`) });
        await sheet.getByRole('button', { name: /^Close/ }).click();
        await sheet.waitFor({ state: 'hidden' });
        assert.equal(test.streams, 1);
        assert.deepEqual(test.errors, []);
    } finally { await test.context.close(); }
}

async function evenGrid(browser) {
    for (const [width, height, columns] of [[1024, 768, 2], [1280, 800, 3], [1440, 900, 3], [1920, 1080, 3], [390, 844, 1]]) {
        for (const colorScheme of width === 1280 ? ['light', 'dark'] : ['light']) {
            const label = `${width}-${colorScheme}`;
            const mobile = width < 600;
            const test = await start(browser, { width, height, mobile, colorScheme });
            const { page } = test;
            try {
                await card(page, 'ios:HOME-IPHONE-START').waitFor();
                await settleMotion(page);
                const boxes = await page.locator('article.device').evaluateAll((items) => items.map((item) => {
                    const box = item.getBoundingClientRect();
                    const actions = item.querySelector('.device-primary-actions').getBoundingClientRect();
                    return { left: box.left, top: box.top, width: box.width, height: box.height, actionsBottom: box.bottom - actions.bottom };
                }));
                const round = (value) => Math.round(value * 2) / 2;
                const widths = new Set(boxes.map((box) => round(box.width)));
                assert.equal(widths.size, 1, `${label}: every card has one width (${[...widths]})`);
                const lefts = [...new Set(boxes.map((box) => round(box.left)))].sort((a, b) => a - b);
                assert.equal(lefts.length, columns, `${label}: ${columns} columns (${lefts})`);
                const rows = new Map();
                for (const box of boxes) rows.set(round(box.top), [...(rows.get(round(box.top)) || []), box]);
                for (const [top, row] of rows) {
                    assert.equal(new Set(row.map((box) => round(box.height))).size, 1, `${label}: the cards of the row at ${top} are one height`);
                    assert.ok(row.every((box) => Math.abs(box.actionsBottom - row[0].actionsBottom) < 1), `${label}: the actions of the row at ${top} line up`);
                }
                // The rows fill from the left, so every row but the last is full.
                const sizes = [...rows.values()].map((row) => row.length);
                assert.ok(sizes.slice(0, -1).every((size) => size === columns), `${label}: full rows (${sizes})`);
                const cardWidth = boxes[0].width;
                if (columns > 1) assert.ok(cardWidth >= 340 && cardWidth <= 692, `${label}: a card is between 340 and 692px wide (${cardWidth})`);
                if (columns === 3) assert.ok(cardWidth <= 392.5, `${label}: three columns in 1200px make the widest card (${cardWidth})`);
                if (width >= 1280) {
                    const span = lefts[lefts.length - 1] + cardWidth - lefts[0];
                    assert.ok(Math.abs(span - 1200) < 1 && Math.abs(lefts[0] - (width - 1200) / 2) < 1, `${label}: the grid is the 1200px of the list, centred`);
                }
                assert.equal(await noOverflow(page), true);
                await page.screenshot({ path: path.join(OUT, `grid-${label}.png`) });
                assert.deepEqual(test.errors, []);
            } finally {
                await test.context.close();
            }
        }
    }
    console.log('PASS the cards are an even grid at 1024, 1280, 1440 and 1920, and one column at 390');
}

/**
 * A phone's page reloaded after a server restart, before the list is back: the tab title and
 * the header give the name this browser kept for the phone, not its serial.
 */
async function rememberedName(browser) {
    const udid = 'HOME-PIXEL-0001';
    const test = await start(browser, { width: 390, height: 844, mobile: true });
    const { page } = test;
    try {
        await card(page, `android:${udid}`).waitFor();
        // What a visit of the phone's page leaves in this browser (`rememberPhone`).
        await page.evaluate((serial) => {
            localStorage.setItem('ws-scrcpy.phones', JSON.stringify({ [serial]: { platform: 'android', name: 'Google Pixel 9 Pro' } }));
            location.hash = `#!action=device&udid=${serial}&view=shell`;
        }, udid);
        test.holdLists = true;
        await page.reload();
        await page.waitForFunction(() => document.title === 'Google Pixel 9 Pro · Shell · ws-scrcpy');
        await page.locator('h1.kit-bar-name').getByText('Google Pixel 9 Pro', { exact: true }).waitFor();
        assert.equal(test.heldLists.length > 0, true, 'the list has not come');
        assert.equal(await page.getByText(udid).count(), 0, 'the serial is not shown');
        assert.equal(test.streams, 0);
        assert.deepEqual(test.errors, []);
        console.log('PASS a reloaded phone page is named by the name this browser kept, before the list is back');
    } finally {
        await test.context.close();
    }
}

async function narrowRow(browser) {
    const test = await start(browser, { width: 320, height: 568, mobile: true });
    const { page } = test;
    try {
        const row = card(page, `ios:${LINKED}`).locator('.device-primary-actions');
        await row.locator('.device-notification-history').waitFor();
        await settleMotion(page);
        const open = await row.getByRole('link', { name: 'Open screen', exact: true }).boundingBox();
        assert.ok(open.height <= 46, `Open screen stays on one line at 320px (${open.height}px tall)`);
        assert.ok(open.width >= (await row.evaluate((el) => el.clientWidth)) / 2 - 1, 'Open screen takes at least half the row at 320px');
        assert.equal(await row.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
        assert.equal(await noOverflow(page), true, 'no horizontal page scroll at 320px');
        // Nothing overflows its card, and no words overflow their button, name or chip. (The
        // unread badge sits over the corner of its button on purpose.)
        const spills = await page.locator('article.device').evaluateAll((items) => items.flatMap((item) => {
            const edge = item.getBoundingClientRect().right;
            const name = (el) => `${item.dataset.deviceKey}: ${el.textContent.trim() || el.getAttribute('aria-label')}`;
            return [
                ...(item.scrollWidth > item.clientWidth + 1 ? [`${item.dataset.deviceKey}: the card`] : []),
                ...[...item.querySelectorAll('a, button')].filter((el) => el.getBoundingClientRect().right > edge + 0.5).map(name),
                ...[...item.querySelectorAll('.kit-button, .phone-row-name, .phone-row-platform, .kit-chip')].filter((el) => el.scrollWidth > el.clientWidth + 1).map(name),
            ];
        }));
        assert.deepEqual(spills, [], 'nothing overflows at 320px');
        const header = page.locator(HEADER);
        const heading = await header.getByRole('heading', { name: 'Phones', exact: true }).boundingBox();
        const inbox = await header.locator('.notifications-link').boundingBox();
        assert.ok(inbox.y < heading.y + heading.height, 'the header actions stay on the first row at 320px');
        await page.screenshot({ path: path.join(OUT, 'devices-320.png') });
        assert.deepEqual(test.errors, []);
        console.log('PASS 320px: action row and header fit');
    } finally {
        await test.context.close();
    }
}

async function returnToDevices(browser, { width, height, mobile, colorScheme }) {
    const label = `${width}-${colorScheme}`;
    // A list long enough to scroll at every size.
    const androids = [...ANDROIDS, ...Array.from({ length: 16 }, (_, index) => android(`HOME-EXTRA-${String(index).padStart(2, '0')}`, `Extra ${String(index).padStart(2, '0')}`))];
    const test = await start(browser, { width, height, mobile, colorScheme, androids });
    const { page } = test;
    try {
        const target = card(page, 'android:HOME-EXTRA-15');
        await target.waitFor();
        await settleMotion(page);
        const list = page.locator('#devices');
        await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await page.waitForTimeout(100);
        assert.ok((await list.evaluate((el) => el.scrollTop)) > 300, `${label}: the fixture list scrolls`);
        // Leaves Devices through a control, noting where the list was. The control is brought into
        // view first, so the press itself does not move the list.
        let before = 0;
        const leave = async (control) => {
            await control.scrollIntoViewIfNeeded();
            await page.waitForTimeout(100);
            before = await list.evaluate((el) => el.scrollTop);
            assert.ok(before > 300, `${label}: the list is scrolled when it is left (${before})`);
            await control.evaluate((el) => el.click());
        };
        const check = async (how, focusedLink) => {
            await page.locator('#devices').waitFor();
            await card(page, 'android:HOME-EXTRA-15').waitFor();
            await page.waitForFunction(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))));
            assert.ok(Math.abs((await list.evaluate((el) => el.scrollTop)) - before) <= 2, `${label}: ${how} returns to the same scroll position`);
            // The card the page was opened from has the focus, on the link that opened it.
            assert.deepEqual(await focusedCardControl(page), focusedLink, `${label}: ${how} focuses the card it was opened from`);
        };
        const linkOf = async (name) => ({ key: 'android:HOME-EXTRA-15', href: await target.getByRole('link', { name, exact: true }).getAttribute('href') });
        const openLink = await linkOf('Open screen');
        const filesLink = await linkOf('Files on Google Extra 15');

        // A screen and back, by the header button and by browser Back.
        await leave(target.getByRole('link', { name: 'Open screen', exact: true }));
        await page.locator('.stream-view').waitFor();
        await page.waitForFunction(() => document.title === 'Google Extra 15 · Screen · ws-scrcpy');
        assert.equal(await page.locator('.kit-bar-name').textContent(), 'Google Extra 15', 'the stream header names the device like its card');
        await page.getByRole('button', { name: 'Phones', exact: true }).click();
        await check('the back control', openLink);
        await leave(target.getByRole('link', { name: 'Open screen', exact: true }));
        await page.locator('.stream-view').waitFor();
        await page.goBack();
        await check('browser Back', openLink);

        // A tool and back.
        await leave(target.getByRole('link', { name: 'Files on Google Extra 15', exact: true }));
        await page.locator('.tool-view').waitFor();
        await page.waitForFunction(() => document.title === 'Google Extra 15 · Files · ws-scrcpy');
        assert.equal(await page.locator('.kit-bar-name').textContent(), 'Google Extra 15');
        await page.getByRole('button', { name: 'Phones', exact: true }).click();
        await check('Files', filesLink);

        // Notifications and back. The bar stays in view above the scrolled list.
        before = await list.evaluate((el) => el.scrollTop);
        assert.equal(await page.locator(`${HEADER} .notifications-link`).isVisible(), true, `${label}: the bar does not scroll away`);
        await page.locator(`${HEADER} .notifications-link`).evaluate((el) => el.click());
        await page.locator('.notifications-view').getByRole('button', { name: 'Phones', exact: true }).waitFor();
        await page.waitForFunction(() => document.title === 'Notifications · ws-scrcpy');
        await page.locator('.notifications-view').getByRole('button', { name: 'Phones', exact: true }).click();
        // Opened from the page's bar, not from a card: no card takes the focus.
        await check('Notifications', null);
        await page.waitForFunction(() => document.title === 'Phones · ws-scrcpy');

        // A reload starts at the top, with no card focused.
        await page.reload();
        await card(page, 'android:HOME-EXTRA-15').waitFor();
        assert.equal(await list.evaluate((el) => el.scrollTop), 0);
        assert.equal(await focusedCardControl(page), null);
        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'Phones keeps its scroll position and focuses the card a page was opened from; one name and title format');
    } finally {
        await test.context.close();
    }
}

async function screenHeaders(browser, { width, height, mobile, colorScheme }) {
    const label = `${width}-${colorScheme}`;
    const test = await start(browser, { width, height, mobile, colorScheme });
    const { page } = test;
    try {
        const headerLink = page.locator('.kit-bar .notifications-link');
        const fits = async (what) => {
            const boxes = await page.locator('.kit-bar').evaluate((header) => [...header.children].map((child) => child.getBoundingClientRect().toJSON()));
            assert.ok(boxes.every((box) => box.left >= 0 && box.right <= width + 1), `${label}: the ${what} header fits`);
            const link = await headerLink.boundingBox();
            assert.ok(link.width >= 44 && link.height >= 44, `${label}: the ${what} header link is a 44px target`);
        };

        // Android screen: the inbox with the total.
        await card(page, 'android:HOME-PIXEL-0001').getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        await page.getByRole('link', { name: 'Notifications, 5 unread', exact: true }).waitFor();
        assert.equal(await headerLink.getAttribute('href'), '#!action=notifications');
        assert.equal(await headerLink.locator('.kit-badge').textContent(), '5');
        await fits('Android screen');
        await page.screenshot({ path: path.join(OUT, `stream-header-${label}.png`) });
        await page.getByRole('button', { name: 'Phones', exact: true }).click();

        // iPhone screen: that iPhone's inbox and count, and the card's name in the header.
        await card(page, `ios:${LINKED}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        await page.getByRole('link', { name: 'Notifications, 2 unread', exact: true }).waitFor();
        assert.equal(await headerLink.getAttribute('href'), `#!action=notifications&source=${LINKED}`);
        assert.equal(await page.locator('.kit-bar-name').textContent(), 'iPhone linked');
        await page.waitForFunction(() => document.title === 'iPhone linked · Screen · ws-scrcpy');
        await fits('iPhone screen');
        await page.getByRole('button', { name: 'Phones', exact: true }).click();

        // An iPhone that sends no notifications here: the inbox, not a setup page for it.
        await card(page, 'ios:HOME-IPHONE-STREAM').getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        assert.equal(await headerLink.getAttribute('href'), '#!action=notifications');
        await page.getByRole('button', { name: 'Phones', exact: true }).click();

        // Shell: the same link, a tab title with the device name, and a switcher for this tool.
        await card(page, 'android:HOME-PIXEL-0001').getByRole('link', { name: 'Shell on Google Pixel 9 Pro', exact: true }).click();
        await page.locator('.tool-view').waitFor();
        await page.waitForFunction(() => document.title === 'Google Pixel 9 Pro · Shell · ws-scrcpy');
        assert.equal(await headerLink.getAttribute('href'), '#!action=notifications');
        await fits('Shell');
        await page.getByRole('button', { name: 'Switch', exact: true }).click();
        const sheet = page.getByRole('dialog', { name: 'Switch phone · Shell', exact: true });
        await sheet.waitFor();
        await settleMotion(page);
        const rows = await switcherRows(sheet);
        assert.deepEqual(rows.map((row) => row.name).sort(), ANDROIDS.map((device) => `Google ${device['ro.product.model']}`).sort(), 'the Shell switcher lists Android phones only');
        assert.equal(rows.some((row) => /iPhone|iPad/.test(row.name)), false);
        // The phone on screen first, marked Viewing in place of its status; then the phones that
        // can be opened; then the rest, each with its status word. Same words as the card.
        assert.deepEqual(rows.map((row) => [row.name, row.chips.join('|'), row.disabled]), [
            ['Google Pixel 9 Pro', 'Viewing', true],
            ['Google Galaxy Tab S9', 'Asleep', false],
            ['Google Pixel 5', 'Ready', false],
            ['Google Pixel 8', 'Locked', false],
            ['Google Pixel 6', 'Unauthorized', true],
            ['Google Pixel 7', 'Offline', true],
        ], `${label}: the Shell switcher rows`);
        assert.equal(await sheet.locator('.device-switcher-item.current').getAttribute('aria-current'), 'true');
        assert.equal(await sheet.locator('.device-switcher-item.current .kit-chip').getAttribute('class'), 'kit-chip kit-chip-info', 'the phone on screen is marked with the info chip');
        assert.equal(await sheet.locator('.device-switcher-item svg.kit-icon:not(.phone-row-icon svg):not(.phone-row-unread svg)').count(), 0, 'no arrow in a row');
        await page.screenshot({ path: path.join(OUT, `switcher-shell-${label}.png`) });
        await sheet.getByRole('button', { name: /Google Pixel 8/ }).click();
        await page.waitForFunction(() => location.hash.includes('view=shell') && location.hash.includes('HOME-LOCKED-0003'));
        await page.waitForFunction(() => document.title === 'Google Pixel 8 · Shell · ws-scrcpy');

        // Files: the switcher names Files. On a desktop Ctrl+K opens it, but not from a text field.
        await page.getByRole('button', { name: 'Files', exact: true }).click();
        await page.waitForFunction(() => document.title === 'Google Pixel 8 · Files · ws-scrcpy');
        const filesSheet = page.getByRole('dialog', { name: 'Switch phone · Files', exact: true });
        if (mobile) {
            await page.getByRole('button', { name: 'Switch', exact: true }).click();
        } else {
            await page.evaluate(() => {
                const field = document.createElement('input');
                field.id = 'home-probe-field';
                document.body.append(field);
                field.focus();
            });
            await page.keyboard.press('Control+k');
            await page.waitForTimeout(150);
            assert.equal(await filesSheet.count(), 0, `${label}: a text field keeps Ctrl+K`);
            await page.evaluate(() => document.getElementById('home-probe-field').remove());
            await page.keyboard.press('Control+k');
        }
        await filesSheet.waitFor();
        await settleMotion(page);
        assert.equal(await filesSheet.locator('.device-switcher-item').filter({ hasText: /iPhone|iPad/ }).count(), 0);
        const filesRows = await switcherRows(filesSheet);
        assert.deepEqual(filesRows[0].name, 'Google Pixel 8', 'the phone of this page is first');
        assert.deepEqual(filesRows.find((row) => row.name === 'Google Pixel 9 Pro').chips, ['Ready']);
        await filesSheet.getByRole('button', { name: /^Close/ }).click();
        await filesSheet.waitFor({ state: 'hidden' });

        // The stream switcher lists every phone. A row is the head of the phone's card: the same
        // name, platform line, status word and tone, the unread count, and no serial or tracker.
        await page.getByRole('button', { name: 'Phones', exact: true }).click();
        await card(page, 'ios:HOME-IPHONE-START').waitFor();
        const heads = Object.fromEntries(await page.locator('article.device').evaluateAll((items) => items.map((item) => [
            item.querySelector('.phone-row-name').textContent,
            { platform: item.querySelector('.phone-row-platform').textContent, chip: item.querySelector('.kit-chip').outerHTML },
        ])));
        await card(page, 'android:HOME-PIXEL-0001').getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.touch-layer').waitFor({ state: 'visible' });
        await page.getByRole('button', { name: 'Switch', exact: true }).click();
        const streamSheet = page.getByRole('dialog', { name: 'Switch phone', exact: true });
        await streamSheet.waitFor();
        await settleMotion(page);
        const streamRows = await switcherRows(streamSheet);
        assert.equal(streamRows.length, ANDROIDS.length + IPHONES.length);
        assert.equal(streamRows[0].name, 'Google Pixel 9 Pro', 'the phone on screen is first');
        let seenUnavailable = false;
        for (const row of streamRows.slice(1)) {
            assert.equal(row.platform, heads[row.name].platform, `${label} ${row.name}: the platform line of the card`);
            assert.equal(row.chip, heads[row.name].chip, `${label} ${row.name}: the status chip of the card`);
            assert.doesNotMatch(row.text, /HOME-|Fixture host/, `${label} ${row.name}: no serial and no tracker name`);
            if (row.disabled) seenUnavailable = true;
            else assert.equal(seenUnavailable, false, `${label} ${row.name}: the phones that cannot be opened come last`);
        }
        assert.deepEqual(streamRows.filter((row) => row.disabled).map((row) => row.name), ['Google Pixel 9 Pro', 'Google Pixel 6', 'Google Pixel 7', 'iPad mini', 'iPhone away']);
        assert.equal(streamRows.find((row) => row.name === 'iPhone linked').unread, '2', 'the unread count of the iPhone');
        assert.equal(streamRows.find((row) => row.name === 'iPhone linked').label.includes('2 unread'), true, 'and its words');
        assert.equal(streamRows.filter((row) => row.unread).length, 1);
        assert.equal(streamRows.find((row) => row.name === 'iPhone streaming').inUse, 'In use', 'a running session is the same mark as on the card');
        // A row that cannot be opened is greyed, takes no hover and opens nothing.
        const away = streamSheet.locator('.device-switcher-item').filter({ hasText: 'iPhone away' });
        assert.equal(await away.locator('.phone-row-text').evaluate((el) => getComputedStyle(el).opacity), '0.5');
        assert.equal(await away.locator('.kit-chip').evaluate((el) => getComputedStyle(el).opacity), '1', 'its status stays readable');
        if (!mobile) {
            await away.hover({ force: true });
            await page.waitForTimeout(250);
            assert.equal(await away.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', `${label}: no hover on a row that cannot be opened`);
        }
        const before = await page.evaluate(() => location.href);
        await away.click({ force: true });
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => location.href), before, `${label}: the row opens nothing`);
        assert.equal(await streamSheet.isVisible(), true);
        assert.equal(await away.evaluate((el) => { el.focus(); return el.tagName === 'BUTTON' && el.disabled && document.activeElement !== el; }), true, 'a disabled button that takes no focus');
        await page.screenshot({ path: path.join(OUT, `switcher-screen-${label}.png`) });
        // The sheet is the kit's dialog, and the browser's Back closes it and stays on the page.
        assert.equal(await streamSheet.evaluate((el) => el.matches('dialog.kit-sheet[open]')), true, `${label}: the switcher is the kit sheet`);
        const address = await page.evaluate(() => location.href);
        await page.goBack();
        await streamSheet.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => location.href), address, `${label}: Back closes the switcher and leaves the page`);
        await page.locator('.touch-layer').waitFor({ state: 'visible' });
        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'Notifications in screen and tool headers; switcher rows are the card heads, current first, unavailable last and greyed');
    } finally {
        await test.context.close();
    }
}

async function toolLinkForIphone(browser, { width, height, mobile, colorScheme }) {
    const label = `${width}-${colorScheme}`;
    for (const [action, tool] of [['shell', 'Shell'], ['list-files', 'Files']]) {
        const test = await start(browser, { width, height, mobile, colorScheme, hash: { action, udid: LINKED } });
        const { page } = test;
        try {
            await page.getByRole('heading', { name: `${tool} is not available for this phone`, exact: true }).waitFor();
            await page.getByText('Files and Shell work on Android phones only. iPhone linked is an iPhone or iPad.', { exact: true }).waitFor();
            await page.waitForFunction((title) => document.title === title, `iPhone linked · ${tool} · ws-scrcpy`);
            assert.equal(await page.locator('.tool-view, .terminal-container, .file-listing-client').count(), 0, 'no tool is mounted for an iPhone');
            assert.deepEqual(test.channels.filter((code) => !['HSTS', 'GTRC', 'ATRC'].includes(code)), [], 'no tool channel was opened for the iPhone, also not before the device list arrived');
            assert.equal(await page.locator('.kit-bar-name').textContent(), 'iPhone linked', 'the header shows the name, not the serial');
            assert.equal(await noOverflow(page), true);
            await page.screenshot({ path: path.join(OUT, `tool-refused-${action}-${label}.png`) });
            await page.getByRole('link', { name: 'Open screen', exact: true }).click();
            await page.waitForFunction((udid) => location.hash.includes('view=screen') && location.hash.includes(udid), LINKED);
            await page.locator('.stream-view').waitFor();
            await page.getByRole('button', { name: 'Phones', exact: true }).first().click();
            await page.locator('#devices').waitFor();
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    // Developer Mode off: the page does not offer a screen that cannot open.
    {
        const test = await start(browser, { width, height, mobile, colorScheme, hash: { action: 'shell', udid: 'HOME-IPAD-NODEV' } });
        try {
            await test.page.getByRole('heading', { name: 'Shell is not available for this phone', exact: true }).waitFor();
            assert.equal(await test.page.getByRole('link', { name: 'Open screen', exact: true }).count(), 0);
            await test.page.getByRole('button', { name: 'Phones', exact: true }).last().waitFor();
        } finally {
            await test.context.close();
        }
    }
    // An Android serial still opens the tool.
    const test = await start(browser, { width, height, mobile, colorScheme, hash: { action: 'shell', udid: 'HOME-PIXEL-0001' } });
    try {
        await test.page.locator('.tool-view').waitFor();
        assert.equal(await test.page.getByRole('heading', { name: /is not available/ }).count(), 0);
    } finally {
        await test.context.close();
    }
    console.log('PASS', label, 'a Files or Shell link that names an iPhone is refused with a reason');
}

async function installedApp(browser) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
        const manifest = await (await context.request.get(new URL('manifest.json', BASE).href)).json();
        assert.equal(manifest.name, 'ws-scrcpy');
        assert.equal(manifest.short_name, 'ws-scrcpy');
        const shortcut = manifest.shortcuts.find((item) => item.name === 'Notifications');
        const page = await context.newPage();
        await page.routeWebSocket('**', () => {});
        await page.route('**/api/notifications/**', (route) => route.fulfill({ json: { sources: [], notifications: [], bluetooth: [], statuses: {}, pairing: null, pairingOpen: false, error: '', delivery: { sent: 0, failed: 0, lastError: '' }, unread: 0, unreadBySource: {}, publicKey: '', publicUrl: 'https://example.test' } }));
        // The shortcut opens Notifications in the served app.
        await page.goto(new URL(shortcut.url, new URL('manifest.json', BASE)).href);
        await page.locator('.notifications-view h1.kit-bar-name').getByText('Notifications', { exact: true }).waitFor();
        assert.equal(await page.title(), 'Notifications · ws-scrcpy');
        // The browser bar is the colour of the page in both themes.
        for (const scheme of ['light', 'dark']) {
            await page.emulateMedia({ colorScheme: scheme });
            const colours = await page.evaluate((scheme) => {
                const meta = document.querySelector(`meta[name="theme-color"][media="(prefers-color-scheme: ${scheme})"]`).content;
                const probe = document.createElement('div');
                probe.style.color = meta;
                document.body.append(probe);
                const result = { meta: getComputedStyle(probe).color, page: getComputedStyle(document.body).backgroundColor };
                probe.remove();
                return result;
            }, scheme);
            assert.equal(colours.meta, colours.page, `${scheme}: theme-color matches the page`);
        }
        // With no answer from the server the list is loading, and still has the way into
        // Notifications.
        await page.goto(BASE);
        await page.locator('#devices .device-list-loading').waitFor();
        assert.equal(await page.getByRole('heading', { name: /No phones connected|Connection lost/ }).count(), 0);
        await page.locator(HEADER).getByRole('link', { name: 'Notifications', exact: true }).click();
        await page.locator('.notifications-view h1.kit-bar-name').getByText('Notifications', { exact: true }).waitFor();
        console.log('PASS installed app: one name, a Notifications shortcut, page-coloured browser bar, inbox reachable with no devices');
    } finally {
        await context.close();
    }
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        const sizes = [
            { width: 390, height: 844, mobile: true, colorScheme: 'light' },
            { width: 390, height: 844, mobile: true, colorScheme: 'dark' },
            { width: 1280, height: 800, mobile: false, colorScheme: 'light' },
            { width: 1280, height: 800, mobile: false, colorScheme: 'dark' },
        ];
        for (const size of sizes) await devicesPage(browser, size);
        for (const colorScheme of ['light', 'dark']) {
            await kitList(browser, { width: 390, height: 844, mobile: true, colorScheme });
            await kitList(browser, { width: 1440, height: 900, mobile: false, colorScheme });
        }
        for (const size of sizes) {
            await firstList(browser, size);
            await reconnectingList(browser, size);
            await reconnectingOneServer(browser, size);
            await reconnectingSwitcher(browser, size);
        }
        await evenGrid(browser);
        await startFromSettings(browser);
        await wakeOnePerSleep(browser);
        await narrowRow(browser);
        await notchedList(browser);
        await rememberedName(browser);
        for (const size of [sizes[0], sizes[3]]) {
            await returnToDevices(browser, size);
            await screenHeaders(browser, size);
            await toolLinkForIphone(browser, size);
        }
        await installedApp(browser);
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
