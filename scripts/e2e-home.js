/* eslint-disable */
// node scripts/test-browser.js home
// The Devices page, its cards and the screen headers, against socket fixtures: the Notifications
// entry, one device name and one tab-title format, attention and error states, the action row,
// scroll and disclosure restore, and the refusal of tool links that name an iPhone.
// No device, adb or pymobiledevice3 is involved.
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

const ANDROIDS = [
    android('HOME-PIXEL-0001', 'Pixel 9 Pro'),
    android('HOME-TAB-0002', 'Galaxy Tab S9', { 'screen.power': 'off', 'device.awake': false }),
    android('HOME-LOCKED-0003', 'Pixel 8', { 'device.locked': true }),
    android('HOME-OFFLINE-0004', 'Pixel 7', { state: 'offline', pid: -1 }),
    android('HOME-UNAUTH-0005', 'Pixel 6', { state: 'unauthorized', pid: -1 }),
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

async function start(browser, { width, height, mobile, colorScheme = 'light', androids = ANDROIDS, iphones = IPHONES, summary = SUMMARY, hash } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, colorScheme, serviceWorkers: 'block' });
    const page = await context.newPage();
    const state = { context, page, errors: [], commands: [], channels: [], summary };
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
        const action = new URL(socket.url()).searchParams.get('action');
        if (action === 'proxy-adb') {
            setTimeout(() => socket.send(initialStreamPacket()), 40);
            return;
        }
        if (action === 'proxy-coredevice') return; // The iPhone stream stays on "Connecting".
        socket.onMessage((data) => {
            const packet = Buffer.from(data);
            if (packet.length < 5) return;
            const id = packet.readUInt32LE(1), body = packet.subarray(5).toString();
            const send = (message) => socket.send(frame(32, id, JSON.stringify(message)));
            if (packet[0] === 4) {
                state.channels.push(body);
                if (body === 'HSTS') send({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }, { type: 'ios' }] } });
                if (body === 'GTRC') send({ id: -1, type: 'devicelist', data: { id: 'android', name: 'Fixture host', list: androids } });
                if (body === 'ATRC') send({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Fixture host', list: iphones } });
            } else if (packet[0] === 32 && body.startsWith('{')) {
                try { state.commands.push(JSON.parse(body)); } catch {}
            }
        });
    });
    const url = new URL(BASE);
    if (hash) url.hash = `!${new URLSearchParams(hash)}`;
    await page.goto(url.toString());
    return state;
}

const card = (page, key) => page.locator(`article.device[data-device-key="${key}"]`);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

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
        await page.locator('.device-list-header .notification-unread-count').waitFor();
        await settleMotion(page);
        assert.equal(await page.title(), 'Devices · ws-scrcpy');

        // Header: a Notifications entry with the total unread count, and a reload control.
        const header = page.locator('.device-list-header');
        const inbox = header.getByRole('link', { name: 'Notifications, 5 unread', exact: true });
        assert.equal(await inbox.getAttribute('href'), '#!action=notifications');
        assert.equal(await inbox.locator('.notification-unread-count').textContent(), '5');
        assert.equal(await inbox.locator('.notifications-link-label').isVisible(), width >= 480, 'the word shows where there is room');
        const reload = header.getByRole('button', { name: 'Reload', exact: true });
        for (const control of [inbox, reload]) {
            const box = await control.boundingBox();
            assert.ok(box.width >= 44 && box.height >= 44, `${label}: header controls keep a 44px target`);
        }
        const pill = header.locator('.device-list-summary');
        assert.equal((await pill.textContent()).trim(), '9 available · 3 need attention');
        const title = await header.getByRole('heading', { name: 'Devices', exact: true }).boundingBox();
        assert.ok(Math.abs((await inbox.boundingBox()).y + 22 - (title.y + title.height / 2)) < 16, `${label}: the actions sit on the heading row`);
        assert.equal(await noOverflow(page), true, `${label}: no horizontal page scroll`);

        // Status: 12px or larger and 4.5:1 on its own tint, for every state.
        const expected = {
            'android:HOME-PIXEL-0001': 'Ready', 'android:HOME-TAB-0002': 'Asleep', 'android:HOME-LOCKED-0003': 'Locked',
            'android:HOME-OFFLINE-0004': 'Offline', 'android:HOME-UNAUTH-0005': 'Unauthorized',
            [`ios:${LINKED}`]: 'Ready', 'ios:HOME-IPAD-NODEV': 'Needs attention', 'ios:HOME-IPHONE-ERROR': 'Error',
            'ios:HOME-IPHONE-UNLOCK': 'Needs attention', 'ios:HOME-IPHONE-STREAM': 'Streaming', 'ios:HOME-IPHONE-START': 'Starting…',
            'ios:HOME-IPHONE-AWAY': 'Offline',
        };
        for (const [key, status] of Object.entries(expected)) {
            const badge = card(page, key).locator('.device-status');
            assert.equal(await badge.locator('.device-status-label').textContent(), status, key);
            const { ratio, size } = await contrastOf(badge);
            assert.ok(size >= 12, `${label} ${status}: status text is ${size}px`);
            assert.ok(ratio >= 4.5, `${label} ${status}: status contrast is ${ratio.toFixed(2)}`);
        }
        const small = await page.locator('#devices .device').first().evaluate((el) =>
            [...el.querySelectorAll('.device-meta, .device-serial, summary, .stream-service-status, .desc-block')]
                .map((node) => parseFloat(getComputedStyle(node).fontSize)).filter((size) => size < 12));
        assert.deepEqual(small, [], `${label}: no card text under 12px`);

        // Action row: Open screen takes at least half, Settings is the same icon button on both
        // platforms, and Notifications shares its surface.
        const rowOf = (key) => card(page, key).locator('.device-primary-actions');
        const boxes = (key) => rowOf(key).evaluate((row) => [...row.children].map((child) => ({
            width: child.getBoundingClientRect().width, height: child.getBoundingClientRect().height, top: child.getBoundingClientRect().top,
            text: child.textContent.trim(), background: getComputedStyle(child).backgroundColor, border: getComputedStyle(child).borderTopColor,
            row: row.clientWidth,
        })));
        const pixel = await boxes('android:HOME-PIXEL-0001');
        const linked = await boxes(`ios:${LINKED}`);
        assert.deepEqual(pixel.map((box) => box.text), ['Open screen', '']);
        assert.deepEqual(linked.map((box) => box.text), ['Open screen', '2', '']);
        for (const row of [pixel, linked]) {
            assert.ok(row[0].width >= row[0].row / 2 - 1, `${label}: Open screen takes at least half the row (${row[0].width} of ${row[0].row})`);
            assert.ok(row.every((box) => box.height >= 44 && Math.abs(box.top - row[0].top) < 1), `${label}: one row of 44px controls ${JSON.stringify(row)}`);
            assert.ok(row.slice(1).every((box) => box.width === 44), `${label}: Notifications and Settings are 44px icon buttons`);
        }
        await card(page, `ios:${LINKED}`).getByRole('link', { name: 'Notifications for iPhone linked, 2 unread', exact: true }).waitFor();
        assert.equal(linked[1].background, linked[2].background, `${label}: Notifications and Settings share a surface`);
        assert.equal(linked[1].border, linked[2].border);
        assert.equal(pixel[1].background, linked[2].background, `${label}: Settings looks the same on both platforms`);
        await card(page, 'android:HOME-PIXEL-0001').getByRole('button', { name: 'Settings for Google Pixel 9 Pro', exact: true }).waitFor();

        // Notifications on a card only where the iPhone sends its notifications to this server.
        assert.equal(await card(page, `ios:${LINKED}`).locator('.device-notification-history').getAttribute('href'), `#!action=notifications&source=${LINKED}`);
        for (const key of ['ios:HOME-IPAD-NODEV', 'ios:HOME-IPHONE-ERROR', 'ios:HOME-IPHONE-STREAM'])
            assert.equal(await card(page, key).locator('.device-notification-history').count(), 0, `${key} has no inbox to open`);

        // Files and Shell are on the Android card, outside the disclosure, which is named Details.
        const pixelCard = card(page, 'android:HOME-PIXEL-0001');
        assert.equal(await pixelCard.locator('.device-details').evaluate((el) => el.open), false);
        for (const name of ['Files', 'Shell']) assert.equal(await pixelCard.getByRole('link', { name, exact: true }).isVisible(), true, `${name} is visible on the closed card`);
        const summary = pixelCard.locator('summary');
        assert.equal((await summary.textContent()).trim(), 'Details');
        assert.ok((await summary.boundingBox()).height >= 44, `${label}: the disclosure row is a 44px target`);

        // Developer Mode off: not Ready, and the screen cannot be opened.
        const ipad = card(page, 'ios:HOME-IPAD-NODEV');
        assert.equal(await ipad.getByRole('link', { name: 'Open screen', exact: true }).count(), 0);
        assert.equal(await ipad.getByRole('button', { name: 'Open screen', exact: true }).isDisabled(), true);
        await ipad.getByText('Enable Developer Mode to open the screen.', { exact: true }).waitFor();
        await ipad.getByRole('button', { name: 'Enable and restart', exact: true }).waitFor();

        // A failed session: the message as a problem line with one action, confirmed.
        const failed = card(page, 'ios:HOME-IPHONE-ERROR');
        const line = failed.locator('.device-problem[data-problem="session"]');
        assert.equal(await line.locator('.device-problem-text').textContent(), 'The screen stream ended.');
        assert.ok((await contrastOf(line.locator('.device-problem-text'))).ratio >= 4.5, `${label}: the error line is readable`);
        assert.notEqual(
            await line.evaluate((el) => getComputedStyle(el).color),
            await failed.locator('.device-meta').evaluate((el) => getComputedStyle(el).color),
            `${label}: an error is not the neutral grey`,
        );
        await line.getByRole('button', { name: 'Restart services', exact: true }).click();
        const prompt = failed.getByRole('alertdialog', { name: 'Restart services on iPhone failed?', exact: true });
        await prompt.waitFor();
        assert.equal(await failed.locator('.device-details').evaluate((el) => el.open), false, 'the prompt shows without opening Details');
        assert.equal(test.commands.filter((command) => command.type === 'restart_session').length, 0, 'the first press sends nothing');
        await prompt.locator('.confirm-prompt-button:not([aria-disabled])').first().waitFor();
        await prompt.getByRole('button', { name: 'Restart services', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.confirm-prompt'));
        assert.deepEqual(test.commands.filter((command) => command.type === 'restart_session').map((command) => command.data.udid), ['HOME-IPHONE-ERROR']);

        // A failed scheduled unlock: a problem line whose action opens the settings panel.
        const unlock = card(page, 'ios:HOME-IPHONE-UNLOCK');
        const unlockLine = unlock.locator('.device-problem[data-problem="unlock"]');
        assert.match(await unlockLine.locator('.device-unlock-schedule.problem').textContent(), /^Scheduled unlock 03:00 · /);
        assert.equal(await unlock.locator('.device-meta .device-unlock-schedule').count(), 0, 'the problem is not repeated in the meta line');
        await unlock.getByText('Screen is asleep.', { exact: true }).waitFor();
        await page.screenshot({ path: path.join(OUT, `devices-${label}.png`), fullPage: true });
        // An unplugged iPhone has no action for its unlock problem, so the problem stays in its meta line.
        const away = card(page, 'ios:HOME-IPHONE-AWAY');
        assert.equal(await away.locator('.device-problem').count(), 0);
        assert.equal(await away.locator('.device-meta .device-unlock-schedule.problem').textContent(), 'Scheduled unlock cannot run: no passcode');
        await unlockLine.getByRole('button', { name: 'Open settings for iPhone unlock', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Scheduled unlock', exact: true });
        await dialog.waitFor();
        await settleMotion(page);
        await dialog.getByRole('button', { name: /^Close/ }).click();
        await dialog.waitFor({ state: 'hidden' });

        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'Devices header, status badges, action row, problem lines');
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
        const header = page.locator('.device-list-header');
        const heading = await header.getByRole('heading', { name: 'Devices', exact: true }).boundingBox();
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
        await target.locator('summary').scrollIntoViewIfNeeded();
        await target.locator('summary').click();
        await settleMotion(page);
        await card(page, 'android:HOME-PIXEL-0001').locator('summary').evaluate((el) => el.click());
        await settleMotion(page);
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
        const openBefore = () => page.evaluate(() => [...document.querySelectorAll('.device-details[open]')].map((el) => el.closest('.device').dataset.deviceKey).sort());
        assert.deepEqual(await openBefore(), ['android:HOME-EXTRA-15', 'android:HOME-PIXEL-0001']);

        const check = async (how) => {
            await page.locator('#devices').waitFor();
            await card(page, 'android:HOME-EXTRA-15').waitFor();
            await page.waitForFunction(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))));
            assert.ok(Math.abs((await list.evaluate((el) => el.scrollTop)) - before) <= 2, `${label}: ${how} returns to the same scroll position`);
            assert.deepEqual(await openBefore(), ['android:HOME-EXTRA-15', 'android:HOME-PIXEL-0001'], `${label}: ${how} keeps the open cards open`);
        };

        // A screen and back, by the header button and by browser Back.
        await leave(target.getByRole('link', { name: 'Open screen', exact: true }));
        await page.locator('.stream-view').waitFor();
        await page.waitForFunction(() => document.title === 'Google Extra 15 · Screen · ws-scrcpy');
        assert.equal(await page.locator('.stream-header-device > strong').textContent(), 'Google Extra 15', 'the stream header names the device like its card');
        await page.getByRole('button', { name: 'Back to devices', exact: true }).click();
        await check('Back to devices');
        await leave(target.getByRole('link', { name: 'Open screen', exact: true }));
        await page.locator('.stream-view').waitFor();
        await page.goBack();
        await check('browser Back');

        // A tool and back.
        await leave(target.getByRole('link', { name: 'Files', exact: true }));
        await page.locator('.tool-view').waitFor();
        await page.waitForFunction(() => document.title === 'Google Extra 15 · Files · ws-scrcpy');
        assert.equal(await page.locator('.stream-header-device > strong').textContent(), 'Google Extra 15');
        await page.getByRole('button', { name: 'Back to devices', exact: true }).click();
        await check('Files');

        // Notifications and back. The header has scrolled away with the list; the link still works.
        before = await list.evaluate((el) => el.scrollTop);
        await page.locator('.device-list-header .notifications-link').evaluate((el) => el.click());
        await page.getByRole('link', { name: '← Devices', exact: true }).waitFor();
        await page.waitForFunction(() => document.title === 'Notifications · ws-scrcpy');
        await page.getByRole('link', { name: '← Devices', exact: true }).click();
        await check('Notifications');
        await page.waitForFunction(() => document.title === 'Devices · ws-scrcpy');

        // Closing a card is remembered too.
        await card(page, 'android:HOME-EXTRA-15').locator('summary').click();
        await settleMotion(page);
        await page.waitForFunction(() => !document.querySelector('[data-device-key="android:HOME-EXTRA-15"] .device-details').open);
        await page.locator('.device-list-header .notifications-link').evaluate((el) => el.click());
        await page.getByRole('link', { name: '← Devices', exact: true }).click();
        await card(page, 'android:HOME-EXTRA-15').waitFor();
        assert.deepEqual(await openBefore(), ['android:HOME-PIXEL-0001']);

        // A reload starts at the top with every card closed.
        await page.reload();
        await card(page, 'android:HOME-EXTRA-15').waitFor();
        assert.equal(await list.evaluate((el) => el.scrollTop), 0);
        assert.deepEqual(await openBefore(), []);
        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'Devices keeps its scroll position and open cards; one name and title format');
    } finally {
        await test.context.close();
    }
}

async function screenHeaders(browser, { width, height, mobile, colorScheme }) {
    const label = `${width}-${colorScheme}`;
    const test = await start(browser, { width, height, mobile, colorScheme });
    const { page } = test;
    try {
        const headerLink = page.locator('.stream-header .notifications-link');
        const fits = async (what) => {
            const boxes = await page.locator('.stream-header').evaluate((header) => [...header.children].map((child) => child.getBoundingClientRect().toJSON()));
            assert.ok(boxes.every((box) => box.left >= 0 && box.right <= width + 1), `${label}: the ${what} header fits`);
            const link = await headerLink.boundingBox();
            assert.ok(link.width >= 44 && link.height >= 44, `${label}: the ${what} header link is a 44px target`);
        };

        // Android screen: the inbox with the total.
        await card(page, 'android:HOME-PIXEL-0001').getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        await page.getByRole('link', { name: 'Notifications, 5 unread', exact: true }).waitFor();
        assert.equal(await headerLink.getAttribute('href'), '#!action=notifications');
        assert.equal(await headerLink.locator('.notification-unread-count').textContent(), '5');
        await fits('Android screen');
        await page.screenshot({ path: path.join(OUT, `stream-header-${label}.png`) });
        await page.getByRole('button', { name: 'Back to devices', exact: true }).click();

        // iPhone screen: that iPhone's inbox and count, and the card's name in the header.
        await card(page, `ios:${LINKED}`).getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        await page.getByRole('link', { name: 'Notifications, 2 unread', exact: true }).waitFor();
        assert.equal(await headerLink.getAttribute('href'), `#!action=notifications&source=${LINKED}`);
        assert.equal(await page.locator('.stream-header-device > strong').textContent(), 'iPhone linked');
        await page.waitForFunction(() => document.title === 'iPhone linked · Screen · ws-scrcpy');
        await fits('iPhone screen');
        await page.getByRole('button', { name: 'Back to devices', exact: true }).click();

        // An iPhone that sends no notifications here: the inbox, not a setup page for it.
        await card(page, 'ios:HOME-IPHONE-STREAM').getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        assert.equal(await headerLink.getAttribute('href'), '#!action=notifications');
        await page.getByRole('button', { name: 'Back to devices', exact: true }).click();

        // Shell: the same link, a tab title with the device name, and a switcher for this tool.
        await card(page, 'android:HOME-PIXEL-0001').getByRole('link', { name: 'Shell', exact: true }).click();
        await page.locator('.tool-view').waitFor();
        await page.waitForFunction(() => document.title === 'Google Pixel 9 Pro · Shell · ws-scrcpy');
        assert.equal(await headerLink.getAttribute('href'), '#!action=notifications');
        await fits('Shell');
        await page.getByRole('button', { name: 'Switch', exact: true }).click();
        const sheet = page.getByRole('dialog', { name: 'Switch device · Shell', exact: true });
        await sheet.waitFor();
        await settleMotion(page);
        const rows = await sheet.locator('.device-switcher-item').evaluateAll((items) => items.map((item) => ({
            name: item.querySelector('strong').textContent, status: item.querySelector('.device-switcher-status').textContent,
        })));
        assert.deepEqual(rows.map((row) => row.name).sort(), ANDROIDS.map((device) => `Google ${device['ro.product.model']}`).sort(), 'the Shell switcher lists Android devices only');
        assert.equal(rows.some((row) => /iPhone|iPad/.test(row.name)), false);
        assert.equal(rows.find((row) => row.name === 'Google Pixel 9 Pro').status, 'Viewing');
        assert.equal(rows.find((row) => row.name === 'Google Pixel 8').status, 'Shell →', 'a row says what it opens');
        assert.equal(rows.find((row) => row.name === 'Google Galaxy Tab S9').status, 'Shell →', 'a sleeping screen does not matter to Shell');
        await page.screenshot({ path: path.join(OUT, `switcher-shell-${label}.png`) });
        await sheet.getByRole('button', { name: /Google Pixel 8/ }).click();
        await page.waitForFunction(() => location.hash.includes('action=shell') && location.hash.includes('HOME-LOCKED-0003'));
        await page.waitForFunction(() => document.title === 'Google Pixel 8 · Shell · ws-scrcpy');

        // Files: the switcher names Files. On a desktop Ctrl+K opens it, but not from a text field.
        await page.getByRole('button', { name: 'Files', exact: true }).click();
        await page.waitForFunction(() => document.title === 'Google Pixel 8 · Files · ws-scrcpy');
        const filesSheet = page.getByRole('dialog', { name: 'Switch device · Files', exact: true });
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
        assert.equal(await filesSheet.locator('.device-switcher-item').filter({ hasText: 'Google Pixel 9 Pro' }).locator('.device-switcher-status').textContent(), 'Files →');
        await filesSheet.getByRole('button', { name: /^Close/ }).click();
        await filesSheet.waitFor({ state: 'hidden' });

        // The stream switcher still lists every device and says it opens a screen.
        await page.getByRole('button', { name: 'Back to devices', exact: true }).click();
        await card(page, 'android:HOME-PIXEL-0001').getByRole('link', { name: 'Open screen', exact: true }).click();
        await page.locator('.touch-layer').waitFor({ state: 'visible' });
        await page.getByRole('button', { name: 'Switch', exact: true }).click();
        const streamSheet = page.getByRole('dialog', { name: 'Switch device', exact: true });
        await streamSheet.waitFor();
        await settleMotion(page);
        assert.equal(await streamSheet.locator('.device-switcher-item').count(), ANDROIDS.length + IPHONES.length);
        assert.equal(await streamSheet.locator('.device-switcher-item').filter({ hasText: 'iPhone linked' }).locator('.device-switcher-status').textContent(), 'Screen →');
        // Developer Mode off: the screen cannot open, so the row cannot be chosen.
        const ipadRow = streamSheet.locator('.device-switcher-item').filter({ hasText: 'iPad mini' });
        assert.equal(await ipadRow.isDisabled(), true, 'an iPhone with Developer Mode off is not offered');
        assert.equal(await ipadRow.locator('.device-switcher-status').textContent(), 'Needs attention');
        assert.deepEqual(test.errors, []);
        console.log('PASS', label, 'Notifications in screen and tool headers; tool switcher lists Android only');
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
            await page.getByRole('heading', { name: `${tool} is not available for this device`, exact: true }).waitFor();
            await page.getByText('Files and Shell work on Android devices only. iPhone linked is an iPhone or iPad.', { exact: true }).waitFor();
            await page.waitForFunction((title) => document.title === title, `iPhone linked · ${tool} · ws-scrcpy`);
            assert.equal(await page.locator('.tool-view, .terminal-container, .file-listing-client').count(), 0, 'no tool is mounted for an iPhone');
            assert.deepEqual(test.channels.filter((code) => !['HSTS', 'GTRC', 'ATRC'].includes(code)), [], 'no tool channel was opened for the iPhone, also not before the device list arrived');
            assert.equal(await page.locator('.stream-header-device > strong').textContent(), 'iPhone linked', 'the header shows the name, not the serial');
            assert.equal(await noOverflow(page), true);
            await page.screenshot({ path: path.join(OUT, `tool-refused-${action}-${label}.png`) });
            await page.getByRole('link', { name: 'Open screen', exact: true }).click();
            await page.waitForFunction((udid) => location.hash.includes('action=stream-coredevice') && location.hash.includes(udid), LINKED);
            await page.locator('.stream-view').waitFor();
            await page.goBack();
            await page.getByRole('button', { name: 'Back to devices', exact: true }).last().click();
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
            await test.page.getByRole('heading', { name: 'Shell is not available for this device', exact: true }).waitFor();
            assert.equal(await test.page.getByRole('link', { name: 'Open screen', exact: true }).count(), 0);
            await test.page.getByRole('button', { name: 'Back to devices', exact: true }).last().waitFor();
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
        await page.getByRole('heading', { name: /^Notifications/ }).waitFor();
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
        // With no device listed, Devices still has the way into Notifications.
        await page.goto(BASE);
        await page.getByRole('heading', { name: 'No devices connected', exact: true }).or(page.getByRole('heading', { name: 'Connection lost', exact: true })).waitFor();
        await page.locator('.device-list-header').getByRole('link', { name: 'Notifications', exact: true }).click();
        await page.getByRole('heading', { name: /^Notifications/ }).waitFor();
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
        await narrowRow(browser);
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
