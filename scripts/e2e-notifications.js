const { settleMotion } = require('./ui-motion');
// Run against a built app: BASE=http://localhost:8000 node scripts/e2e-notifications.js
// API, device discovery, and push subscriptions are isolated fixtures. No real
// phone settings, Bluetooth state, or push providers are changed by these tests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const browserName = process.env.BROWSER || 'chromium';
const BASE = process.env.BASE || 'http://localhost:8000/';
const SCREENSHOTS = process.env.SCREENSHOTS || '/tmp';
const subscription = {
    endpoint: 'https://web.push.apple.com/notification-ui-fixture',
    keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') },
};
const phones = () => ['a', 'b'].map((id, i) => ({
    id: `phone-${id}`, name: `Phone ${id.toUpperCase()}`, address: `AA:BB:CC:DD:EE:0${i}`, apps: [], preview: true,
}));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const historyItems = () => [
    { key: 'a-chat', source: 'phone-a', app: 'com.example.chat', appName: 'Messages', title: 'Coffee at four?', body: 'Meet me outside the station.', received: Date.now(), read: false, dismissed: false, active: true, canDismiss: true, negativeActionLabel: 'Clear' },
    { key: 'a-calendar', source: 'phone-a', app: 'com.example.calendar', appName: 'Calendar', title: 'Design review', body: 'Starts in ten minutes.', received: Date.now() - 60000, read: false, dismissed: false, active: true },
    { key: 'b-mail', source: 'phone-b', app: 'com.example.mail', appName: 'Mail', title: 'A message from Alex', body: 'The updated itinerary is ready.', received: Date.now() - 120000, read: false, dismissed: false, active: false },
];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aELsAAAAASUVORK5CYII=', 'base64');
const article = (page, title) => page.locator('article.notification-history-item').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const headerBadge = page => page.locator('.notification-page-header .notification-unread-count');
async function openCardMenu(page, title) {
    await article(page, title).getByRole('button', { name: `Actions for ${title}`, exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.waitFor();
    return sheet;
}
async function cardAction(page, title, name) {
    const sheet = await openCardMenu(page, title);
    await sheet.getByRole('button', { name, exact: true }).click();
    await sheet.waitFor({ state: 'detached' });
}
async function openToolbar(page) {
    await page.getByRole('button', { name: 'Notification actions', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.waitFor();
    return sheet;
}
async function toolbarAction(page, name) {
    const sheet = await openToolbar(page);
    await sheet.getByRole('button', { name, exact: true }).click();
    await sheet.waitFor({ state: 'detached' });
}
async function waitRead(page, title, read) {
    await page.waitForFunction(({ title, read }) => {
        const card = [...document.querySelectorAll('article.notification-history-item')].find(el => el.querySelector('h3')?.textContent === title);
        return !!card && card.classList.contains('unread') === !read;
    }, { title, read });
}
async function setAppFilter(page, app) {
    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Filter notifications', exact: true });
    await sheet.getByRole('combobox', { name: 'App', exact: true }).selectOption(app);
    await sheet.getByRole('button', { name: 'Close actions', exact: true }).click();
    await sheet.waitFor({ state: 'detached' });
}

async function until(check, message, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (!check() && Date.now() < deadline) await sleep(50);
    assert.ok(check(), message);
}
async function openDetails(page, name) {
    await settleMotion(page);
    const summary = page.locator('summary').filter({ hasText: name });
    await summary.waitFor({ state: 'visible' });
    assert.equal(await summary.count(), 1, `one disclosure named ${name}`);
    if (!(await summary.evaluate(el => el.closest('details').open))) await summary.click();
}
async function assertClean(fixture) {
    assert.deepEqual(fixture.errors, [], 'no page errors or unexpected API requests');
    assert.equal(await fixture.page.evaluate(() => {
        const main = document.querySelector('main');
        return document.documentElement.scrollWidth > innerWidth || main.scrollWidth > main.clientWidth;
    }), false, 'the mobile view has no horizontal overflow');
}
async function capture(fixture, name) {
    await fs.mkdir(SCREENSHOTS, { recursive: true });
    await fixture.page.locator('main').evaluate(el => { el.scrollTop = 0; });
    await fixture.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await fixture.page.screenshot({ path: path.join(SCREENSHOTS, `ws-notifications-${name}.png`), animations: 'disabled' });
}
async function fixture(browser, options = {}) {
    const context = await browser.newContext({
        viewport: { width: options.width || 390, height: 844 },
        ...(options.ios ? {
            isMobile: true, hasTouch: true,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        } : {}),
    });
    await context.addInitScript(({ subscription, registered, storedSources, storedReceiver, ios, standalone, displayedKeys, workerHang }) => {
        if (storedSources !== undefined) localStorage.setItem('notification-sources', JSON.stringify(storedSources));
        if (storedReceiver !== undefined) localStorage.setItem('notification-receiver-source', storedReceiver);
        if (ios) Object.defineProperty(navigator, 'standalone', { configurable: true, value: standalone });
        if (standalone) {
            const originalMatchMedia = window.matchMedia.bind(window);
            window.matchMedia = query => {
                const result = originalMatchMedia(query);
                if (/\(\s*display-mode\s*:\s*standalone\s*\)/.test(query)) {
                    Object.defineProperty(result, 'matches', { configurable: true, value: true });
                }
                return result;
            };
        }
        window.__notificationBadges = [];
        window.__closedNotifications = [];
        window.__notificationWorkerCalls = { getRegistration: 0, getNotifications: 0 };
        Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: async count => { window.__notificationBadges.push(count); } });
        Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: async () => { window.__notificationBadges.push(0); } });
        Object.defineProperty(window, 'Notification', { configurable: true, value: function Notification() {} });
        Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} });
        const counters = window.__notificationFixture = { permissionRequests: 0, subscribeCalls: 0, unsubscribeCalls: 0 };
        let permission = registered ? 'granted' : 'default';
        Object.defineProperty(Notification, 'permission', { configurable: true, get: () => permission });
        const makeSubscription = () => ({
            ...subscription,
            toJSON: () => subscription,
            unsubscribe: async () => { counters.unsubscribeCalls++; active = null; return true; },
        });
        let active = registered ? makeSubscription() : null;
        PushManager.prototype.getSubscription = async () => active;
        PushManager.prototype.subscribe = async () => {
            counters.subscribeCalls++;
            active = makeSubscription();
            return active;
        };
        const registration = {
            pushManager: new PushManager(),
            getNotifications: async () => {
                window.__notificationWorkerCalls.getNotifications++;
                if (workerHang === 'notifications') return new Promise(() => {});
                return displayedKeys.map(key => ({ data: { notificationKey: key }, close: () => window.__closedNotifications.push(key) }));
            },
        };
        const worker = new EventTarget();
        worker.register = async () => registration;
        worker.getRegistration = async () => {
            window.__notificationWorkerCalls.getRegistration++;
            if (workerHang === 'registration') return new Promise(() => {});
            return registration;
        };
        worker.ready = Promise.resolve(registration);
        Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
        Notification.requestPermission = async () => {
            counters.permissionRequests++;
            permission = 'granted';
            return permission;
        };
    }, { subscription, registered: options.registered ?? true, storedSources: options.storedSources, storedReceiver: options.storedReceiver, ios: !!options.ios, standalone: !!options.standalone, displayedKeys: options.displayedKeys || [], workerHang: options.workerHang || '' });
    const page = await context.newPage();
    if (options.clock) await page.clock.install();
    const state = {
        context, page, sources: options.sources ?? phones(), errors: [], saved: [], tests: [], removed: [],
        disabled: 0, statusPolls: 0, pairingOpen: false, subscriptionError: '',
        missingSubscription: !!options.missingSubscription, testError: '', operations: [],
        notifications: structuredClone(options.notifications || []), readRequests: [], dismissed: [], actions: [], iconRequests: [], actionError: '', dismissError: '', summaryPolls: 0, bulkDismissed: [], bulkActions: [], bulkActionResult: null, restored: [], holdNextMutation: false, releaseMutation: null,
    };
    page.on('pageerror', error => state.errors.push(error.message));
    await page.routeWebSocket('**', socket => {
        socket.onMessage(data => {
            const request = Buffer.from(data);
            if (request.length < 5 || request[0] !== 4) return;
            const code = request.subarray(5).toString();
            const reply = message => {
                const body = Buffer.from(JSON.stringify(message));
                const response = Buffer.alloc(5 + body.length);
                response[0] = 32;
                response.writeUInt32LE(request.readUInt32LE(1), 1);
                body.copy(response, 5);
                socket.send(response);
            };
            if (code === 'HSTS') reply({ id: -1, type: 'hosts', data: { local: options.devices ? [{ type: 'ios' }] : [] } });
            if (code === 'ATRC') reply({ id: -1, type: 'devicelist', data: {
                id: 'notification-fixture', name: 'NUC fixture', list: ['a', 'b', 'c'].map(id => ({
                    udid: `phone-${id}`, name: `Phone ${id.toUpperCase()}`, model: 'iPhone', version: '27.0',
                    state: 'Connected', paired: true, developerMode: true, session: 'idle', 'screen.power': 'on',
                    'last.update.timestamp': Date.now(),
                })),
            } });
        });
    });
    await page.route('**/api/notifications/**', async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (request.method() !== 'GET') state.operations.push(`${request.method()} ${pathname.split('/').pop()}`);
        const unreadBySource = Object.fromEntries(state.sources.map(source => [source.id, state.notifications.filter(n => n.source === source.id && !n.read && !n.dismissed).length]));
        const unread = Object.values(unreadBySource).reduce((a, b) => a + b, 0);
        let reply = { ok: true }, status = 200;
        if (pathname.endsWith('/status')) {
            state.statusPolls++;
            reply = {
                publicKey: subscription.keys.p256dh, sources: state.sources, bluetooth: [],
                statuses: Object.fromEntries(state.sources.map(s => [s.id, 'Receiving notifications'])), pairing: null,
                pairingOpen: state.pairingOpen, error: '', delivery: { sent: 0, failed: 0, lastError: '' },
                notifications: state.notifications, unread, unreadBySource, retentionDays: 30, publicUrl: 'https://phone.example',
            };
        } else if (pathname.endsWith('/summary')) {
            state.summaryPolls++;
            reply = { sources: state.sources, unread, unreadBySource };
        } else if (pathname.includes('/icons/')) {
            state.iconRequests.push(pathname);
            return route.fulfill({ status: 200, contentType: 'image/png', body: png });
        } else if (pathname.endsWith('/history/read') && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.readRequests.push(body);
            state.notifications.forEach(n => {
                if (body.keys ? body.keys.includes(n.key) : body.source ? n.source === body.source : body.all === true) n.read = body.read !== false;
            });
        } else if (pathname.endsWith('/history/dismiss') && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.bulkDismissed.push(body);
            const dismissed = [];
            state.notifications.forEach(n => {
                if (n.source === body.source && body.keys.includes(n.key)) {
                    n.dismissed = true; n.read = true; dismissed.push(n.key);
                }
            });
            reply = { ok: true, dismissed };
        } else if (pathname.endsWith('/history/actions') && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.bulkActions.push(body);
            reply = { ok: true, ...(state.bulkActionResult || { accepted: body.items.map(n => n.key), skipped: [], failed: [], unprocessed: [] }) };
        } else if (/\/history\/[^/]+\/(dismiss|action|restore)$/.test(pathname) && request.method() === 'POST') {
            const parts = pathname.split('/');
            const key = decodeURIComponent(parts.at(-2));
            const item = state.notifications.find(n => n.key === key);
            if (!item) { status = 404; reply = { error: 'Notification not found.' }; }
            else if (parts.at(-1) === 'restore') {
                const body = request.postDataJSON();
                state.restored.push({ key, ...body }); item.dismissed = false; item.read = body.read !== false;
            } else if (parts.at(-1) === 'dismiss') {
                if (state.dismissError) { status = 500; reply = { error: state.dismissError }; }
                else { state.dismissed.push(key); item.dismissed = true; item.read = true; }
            } else {
                const body = request.postDataJSON();
                state.actions.push({ key, ...body });
                if (state.actionError || body?.expectedLabel !== item.negativeActionLabel) {
                    status = 400; reply = { error: state.actionError || 'Phone action changed. Refresh and try again.' };
                }
            }
        } else if (pathname.endsWith('/subscriptions') && request.method() === 'POST') {
            state.saved.push(request.postDataJSON());
            if (state.subscriptionError) { status = 400; reply = { error: state.subscriptionError }; }
            else state.missingSubscription = false;
        } else if (pathname.endsWith('/subscriptions') && request.method() === 'DELETE') state.disabled++;
        else if (pathname.endsWith('/test') && request.method() === 'POST') {
            state.tests.push(request.postDataJSON());
            if (state.testError || state.missingSubscription) {
                status = 400;
                reply = { error: state.testError || 'Enable notifications on this device first' };
            }
        }
        else if (pathname.endsWith('/pair') && request.method() === 'POST') state.pairingOpen = true;
        else if (pathname.includes('/sources/') && request.method() === 'DELETE') {
            const id = decodeURIComponent(pathname.split('/').pop());
            state.removed.push(id);
            state.sources = state.sources.filter(s => s.id !== id);
        } else if (pathname.endsWith('/sources') && request.method() === 'POST') {
            const source = request.postDataJSON();
            state.sources = [...state.sources.filter(s => s.id !== source.id), source];
        } else {
            const error = `Unexpected fixture request: ${request.method()} ${pathname}`;
            state.errors.push(error); status = 500; reply = { error };
        }
        if (state.holdNextMutation && request.method() === 'POST' && pathname.includes('/history/')) {
            state.holdNextMutation = false;
            await new Promise(resolve => { state.releaseMutation = resolve; });
            state.releaseMutation = null;
        }
        await route.fulfill({ status, json: reply });
    });
    const url = new URL(BASE); url.hash = '!action=notifications' + (options.source ? '&source=' + encodeURIComponent(options.source) : '') + (options.notification ? '&notification=' + encodeURIComponent(options.notification) : '');
    if (options.beforeGoto) await options.beforeGoto(page);
    await page.goto(url.href);
    await page.getByRole('button', { name: 'Setup & delivery', exact: true }).waitFor();
    if (options.history) {
        await page.locator('#notification-history-heading').waitFor();
    } else {
        await page.getByRole('button', { name: 'Setup & delivery', exact: true }).click();
        await page.getByRole('heading', { name: 'Send from an iPhone', exact: true }).waitFor();
        await page.getByText(options.registered === false ? 'Notifications off' : 'Notifications on', { exact: true }).waitFor();
    }
    return state;
}

async function onboarding(browser) {
    const f = await fixture(browser, { sources: [], registered: false });
    try {
        await f.page.getByRole('heading', { name: 'Receive on this device', exact: true }).waitFor();
        assert.equal(await f.page.locator('#notification-history-heading').count(), 0, 'first-time setup keeps history out of the way');
        await until(() => f.statusPolls > 0, 'initial setup status loaded');
        assert.equal(await f.page.locator('summary').filter({ hasText: 'Settings for Phone' }).count(), 0);
        const enable = f.page.getByRole('button', { name: 'Enable on this device', exact: true });
        await enable.waitFor();
        assert.equal(await enable.isDisabled(), true, 'a source must be linked before enabling');
        await f.page.getByText('Notifications off', { exact: true }).waitFor();
        await capture(f, 'setup');
        await f.page.getByRole('button', { name: 'Start Bluetooth pairing', exact: true }).click();
        await until(() => f.pairingOpen, 'pairing starts from the onboarding action');
        assert.equal((await f.page.evaluate(() => window.__notificationFixture)).permissionRequests, 0);
        assert.deepEqual(f.saved, []);
        await assertClean(f);
        console.log('PASS notification onboarding guides pairing before receiver activation');
    } finally { await f.context.close(); }
}

async function configuredReceiver(browser) {
    const f = await fixture(browser, { storedSources: ['phone-a', 'phone-b'], storedReceiver: '' });
    try {
        const test = f.page.getByRole('button', { name: 'Send test notification', exact: true });
        await test.waitFor();
        assert.equal(await f.page.getByRole('button', { name: 'Save changes', exact: true }).count(), 0, 'unchanged preferences do not show a save action');
        for (const name of ['Settings for Phone A', 'Settings for Phone B', 'Choose phones and delivery options']) {
            const summary = f.page.locator('summary').filter({ hasText: name });
            assert.equal(await summary.evaluate(el => el.closest('details').open), false, `${name} starts collapsed`);
        }
        assert.equal(await f.page.getByText('Connected', { exact: true }).count(), 2);
        await capture(f, 'configured');
        await f.page.emulateMedia({ colorScheme: 'dark' });
        await capture(f, 'configured-dark');
        await f.page.emulateMedia({ colorScheme: 'light' });
        await test.click();
        await f.page.getByText('Test notification queued. It should arrive on this device shortly.', { exact: true }).waitFor();
        assert.deepEqual(f.tests, [{ endpoint: subscription.endpoint }]);
        assert.deepEqual(await f.page.evaluate(() => window.__notificationFixture), { permissionRequests: 0, subscribeCalls: 0, unsubscribeCalls: 0 });
        await assertClean(f);
        console.log('PASS configured notification receiver shows connection status and sends a test without permission prompts');
    } finally { await f.context.close(); }
}

async function receiverChoicesAndUnlink(browser) {
    const f = await fixture(browser, { storedSources: ['phone-a', 'removed-phone'], storedReceiver: 'removed-phone' });
    try {
        await openDetails(f.page, 'Choose phones and delivery options');
        const receiver = f.page.getByRole('combobox', { name: 'This app is open on', exact: true });
        await receiver.waitFor();
        assert.equal(await receiver.inputValue(), '', 'removed receiver identity is cleared, matching the visible default');
        assert.equal(await receiver.locator('option:checked').textContent(), 'A different phone, tablet or computer');
        const sources = f.page.getByRole('group', { name: 'Get notifications from', exact: true });
        await sources.getByLabel('Phone B', { exact: true }).check();
        await receiver.selectOption('phone-b');
        await f.page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await f.page.getByText('Notification choices saved.', { exact: true }).waitFor();
        assert.deepEqual(f.saved.at(-1).sources, ['phone-a', 'phone-b']);
        assert.equal(f.saved.at(-1).receiverSource, 'phone-b');
        assert.equal((await f.page.evaluate(() => window.__notificationFixture)).permissionRequests, 0, 'updating choices does not request permission again');

        await openDetails(f.page, 'Settings for Phone B');
        const settings = f.page.locator('details').filter({ has: f.page.locator('summary').filter({ hasText: 'Settings for Phone B' }) });
        await settings.getByRole('button', { name: 'Remove iPhone', exact: true }).click();
        await until(() => f.removed.includes('phone-b'), 'source removal reaches the API');
        await f.page.locator('summary').filter({ hasText: 'Settings for Phone B' }).waitFor({ state: 'detached' });
        await openDetails(f.page, 'Choose phones and delivery options');
        assert.equal(await receiver.locator('option:checked').textContent(), 'A different phone, tablet or computer', 'removing the selected receiver restores a visible default option');
        await f.page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await f.page.waitForFunction(() => localStorage.getItem('notification-receiver-source') === '');
        assert.deepEqual(f.saved.at(-1).sources, ['phone-a']);
        assert.equal(f.saved.at(-1).receiverSource, '', 'unlinking the receiver clears the persisted identity');
        await f.page.getByRole('button', { name: 'Send test notification', exact: true }).waitFor();
        assert.equal(await f.page.getByRole('button', { name: 'Save changes', exact: true }).count(), 0);
        await f.page.getByRole('button', { name: 'Turn off on this device', exact: true }).click();
        await f.page.getByRole('button', { name: 'Enable on this device', exact: true }).waitFor();
        assert.equal(f.disabled, 1);
        assert.equal((await f.page.evaluate(() => window.__notificationFixture)).unsubscribeCalls, 1);
        await assertClean(f);
        console.log('PASS receiver choice saves and source removal preserve valid selections without permission prompts');
    } finally { await f.context.close(); }
}

async function enablingReceiver(browser) {
    const f = await fixture(browser, { registered: false, storedSources: ['phone-a'], storedReceiver: '' });
    try {
        await f.page.getByRole('button', { name: 'Enable on this device', exact: true }).click();
        await f.page.getByText('Notifications enabled on this device.', { exact: true }).waitFor();
        assert.equal(f.saved.length, 1);
        assert.deepEqual(f.saved[0].sources, ['phone-a']);
        assert.deepEqual(await f.page.evaluate(() => window.__notificationFixture), { permissionRequests: 1, subscribeCalls: 1, unsubscribeCalls: 0 });
        await openDetails(f.page, 'Choose phones and delivery options');
        await f.page.getByRole('group', { name: 'Get notifications from', exact: true }).getByLabel('Phone B', { exact: true }).check();
        assert.equal(await f.page.getByText('From Phone A', { exact: true }).isVisible(), true, 'receiver status continues to show saved choices until the change is saved');
        assert.equal(await f.page.getByText('From Phone A, Phone B', { exact: true }).count(), 0);
        await f.page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await f.page.getByText('Notification choices saved.', { exact: true }).waitFor();
        await f.page.getByText('From Phone A, Phone B', { exact: true }).waitFor();
        assert.equal((await f.page.evaluate(() => window.__notificationFixture)).permissionRequests, 1);
        assert.equal((await f.page.evaluate(() => window.__notificationFixture)).subscribeCalls, 1);
        await assertClean(f);
        console.log('PASS enabling notifications requests permission once; subsequent saves reuse the subscription');
    } finally { await f.context.close(); }
}

async function errorsSurvivePolling(browser) {
    const f = await fixture(browser, { storedSources: ['phone-a'], storedReceiver: '' });
    try {
        await openDetails(f.page, 'Choose phones and delivery options');
        await f.page.getByRole('group', { name: 'Get notifications from', exact: true }).getByLabel('Phone B', { exact: true }).check();
        f.subscriptionError = 'Unable to save these notification choices.';
        await f.page.getByRole('button', { name: 'Save changes', exact: true }).click();
        const error = f.page.getByRole('alert').filter({ hasText: f.subscriptionError });
        await error.waitFor();
        const before = f.statusPolls;
        await until(() => f.statusPolls > before, 'status polling continues after a failed operation');
        assert.equal(await error.isVisible(), true, 'a successful status poll cannot erase an action failure');
        f.subscriptionError = '';
        await f.page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await f.page.getByText('Notification choices saved.', { exact: true }).waitFor();
        assert.equal(await error.count(), 0, 'successful retry clears the previous action error');
        assert.equal((await f.page.evaluate(() => window.__notificationFixture)).permissionRequests, 0);
        await assertClean(f);
        console.log('PASS notification action errors survive background polls and clear after a successful retry');
    } finally { await f.context.close(); }
}

async function iosInstallGate(browser) {
    const f = await fixture(browser, { registered: false, ios: true, storedSources: ['phone-a'] });
    try {
        const instructions = f.page.getByText(/Add to Home Screen/);
        await instructions.first().waitFor();
        assert.equal(await instructions.first().isVisible(), true);
        const enable = f.page.getByRole('button', { name: 'Enable on this device', exact: true });
        await enable.waitFor();
        assert.equal(await enable.isDisabled(), true, 'Safari browser tab cannot enable iOS PWA push');
        assert.equal((await f.page.evaluate(() => window.__notificationFixture)).permissionRequests, 0);
        assert.deepEqual(f.saved, []);
        await assertClean(f);
        console.log('PASS iOS Safari browser tabs show Home Screen instructions and block receiver activation');
    } finally { await f.context.close(); }
}

async function recoverMissingServerSubscription(browser) {
    const f = await fixture(browser, { storedSources: ['phone-a'], storedReceiver: '', missingSubscription: true });
    try {
        await f.page.getByRole('button', { name: 'Send test notification', exact: true }).click();
        await f.page.getByText('Test notification queued. It should arrive on this device shortly.', { exact: true }).waitFor();
        assert.deepEqual(f.operations, ['POST test', 'POST subscriptions', 'POST test'], 'a missing server registration is repaired once before retrying');
        assert.equal(f.saved.length, 1);
        assert.deepEqual(f.saved[0].sources, ['phone-a']);
        assert.equal(f.saved[0].receiverSource, '');
        assert.equal(f.saved[0].subscription.endpoint, subscription.endpoint);
        assert.deepEqual(await f.page.evaluate(() => window.__notificationFixture), { permissionRequests: 0, subscribeCalls: 0, unsubscribeCalls: 0 });
        f.testError = 'Fixture test delivery failed.';
        await f.page.getByRole('button', { name: 'Send test notification', exact: true }).click();
        await f.page.getByRole('alert').filter({ hasText: f.testError }).waitFor();
        assert.equal(f.saved.length, 1, 'unrelated test errors cannot silently re-register a subscription');
        assert.equal(f.tests.length, 3, 'unrelated test errors are not retried');
        await assertClean(f);
        console.log('PASS a missing server subscription is repaired without permission prompts; other test errors remain visible');
    } finally { await f.context.close(); }
}

async function perDeviceHistory(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), ios: true, standalone: true, devices: true });
    try {
        assert.equal(await headerBadge(f.page).textContent(), '2');
        await f.page.waitForFunction(() => document.querySelectorAll('.notification-app-icon img').length === 2 && [...document.querySelectorAll('.notification-app-icon img')].every(img => img.complete && img.naturalWidth > 0));
        assert.equal(f.iconRequests.length, 2, 'only the selected phone’s original app icons are requested');
        assert.ok(f.iconRequests.every(url => url.includes('/phone-a/')));
        await capture(f, `history-${browserName}-390`);
        await f.page.setViewportSize({ width: 320, height: 720 });
        await assertClean(f);
        await capture(f, `history-${browserName}-320`);
        await f.page.emulateMedia({ colorScheme: 'dark' });
        await capture(f, `history-${browserName}-dark`);
        await f.page.emulateMedia({ colorScheme: 'light' });
        await f.page.setViewportSize({ width: 390, height: 844 });

        const select = f.page.getByRole('combobox', { name: 'Device', exact: true });
        assert.equal(await select.inputValue(), 'phone-a', 'history defaults to one sending phone');
        assert.equal(await select.locator('option[value=""]').count(), 0, 'there is no combined All phones feed');
        assert.equal(await article(f.page, 'A message from Alex').count(), 0, 'filtering excludes other phones');
        assert.equal(await f.page.getByRole('region', { name: 'Phone A notification history', exact: true }).count(), 1);
        await cardAction(f.page, 'Coffee at four?', 'Mark read');
        await waitRead(f.page, 'Coffee at four?', true);
        assert.equal(await headerBadge(f.page).textContent(), '1');
        assert.deepEqual(f.readRequests.at(-1), { keys: ['a-chat'], read: true });
        assert.equal(await f.page.evaluate(() => window.__notificationBadges.at(-1)), 2);
        await cardAction(f.page, 'Coffee at four?', 'Mark unread');
        await waitRead(f.page, 'Coffee at four?', false);
        assert.equal(await headerBadge(f.page).textContent(), '2', 'marking unread restores the selected phone’s count');
        assert.deepEqual(f.readRequests.at(-1), { keys: ['a-chat'], read: false });
        await cardAction(f.page, 'Coffee at four?', 'Mark read');
        await waitRead(f.page, 'Coffee at four?', true);
        await f.page.getByRole('button', { name: 'Unread', exact: true }).click();
        assert.equal(await article(f.page, 'Coffee at four?').count(), 0, 'read alerts leave the Unread filter');
        await article(f.page, 'Design review').waitFor();
        await toolbarAction(f.page, 'Mark all read');
        await f.page.getByText('No unread notifications', { exact: true }).waitFor();
        assert.deepEqual(f.readRequests.at(-1), { keys: ['a-calendar'], read: true });
        assert.equal(f.notifications.find(n => n.key === 'b-mail').read, false, 'mark all read respects the selected phone');
        assert.equal(await headerBadge(f.page).count(), 0, 'the page badge clears for the selected phone while the PWA badge retains other unread alerts');
        assert.equal(await f.page.evaluate(() => window.__notificationBadges.at(-1)), 1);

        await f.page.getByRole('link', { name: '← Devices', exact: true }).click();
        await f.page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
        await until(() => f.summaryPolls > 0, 'Devices loads the lightweight unread summary');
        assert.equal(await f.page.locator('.device-list-header a[href*=notifications]').count(), 0, 'Devices has no global Notifications link');
        const card = id => f.page.locator(`article.device[data-device-key$=":${id}"]`);
        await card('phone-b').locator('.device-notification-history').waitFor();
        assert.equal(await card('phone-a').locator('.notification-unread-count').count(), 0);
        assert.equal(await card('phone-b').locator('.notification-unread-count').textContent(), '1');
        await card('phone-c').locator('.device-notification-history').click();
        await f.page.getByRole('heading', { name: 'Send from an iPhone', exact: true }).waitFor();
        assert.equal(await f.page.locator('#notification-history-heading').count(), 0, 'an unconfigured device opens setup, never another phone’s feed');
        await f.page.getByRole('link', { name: '← Devices', exact: true }).click();
        await card('phone-b').locator('.device-notification-history').click();
        await f.page.locator('#notification-history-heading').waitFor();
        assert.equal(await f.page.getByRole('combobox', { name: 'Device', exact: true }).inputValue(), 'phone-b');
        await toolbarAction(f.page, 'Mark all read');
        await f.page.waitForFunction(() => window.__notificationBadges.at(-1) === 0);
        assert.deepEqual(f.readRequests.at(-1), { keys: ['b-mail'], read: true });
        assert.equal(await headerBadge(f.page).count(), 0, 'the unread badge clears when every alert is read');
        await assertClean(f);
        console.log('PASS per-device history shows original icons; read actions update filters, shared counts and Home Screen badge');
    } finally { await f.context.close(); }
}

async function dismissKeepsHistory(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), displayedKeys: ['a-chat', 'b-mail'] });
    try {
        await cardAction(f.page, 'Coffee at four?', 'Dismiss here');
        await article(f.page, 'Coffee at four?').waitFor({ state: 'detached' });
        assert.deepEqual(f.dismissed, ['a-chat']);
        assert.equal(await headerBadge(f.page).textContent(), '1');
        assert.deepEqual(await f.page.evaluate(() => window.__closedNotifications), ['a-chat'], 'local dismissal closes only the corresponding received push');
        await f.page.getByRole('button', { name: 'All history', exact: true }).click();
        const old = article(f.page, 'Coffee at four?');
        await old.getByText('Dismissed here', { exact: true }).waitFor();
        const archivedMenu = await openCardMenu(f.page, 'Coffee at four?');
        assert.equal(await archivedMenu.getByRole('button', { name: 'Dismiss here', exact: true }).count(), 0);
        await archivedMenu.getByRole('button', { name: 'Move to inbox', exact: true }).click();
        await archivedMenu.waitFor({ state: 'detached' });
        assert.deepEqual(f.restored, [{ key: 'a-chat', read: true }]);
        await waitRead(f.page, 'Coffee at four?', true);
        assert.equal(f.notifications.length, 3, 'dismissal preserves the historical record');
        assert.deepEqual(f.actions, [], 'local dismissal sends no Bluetooth action');
        await assertClean(f);
        console.log('PASS Dismiss here clears the inbox and push while preserving All history');
    } finally { await f.context.close(); }
}

async function labeledPhoneActions(browser) {
    const items = historyItems();
    items.push({ key: 'b-call', source: 'phone-b', app: 'com.apple.mobilephone', appName: 'Phone', title: 'Incoming call', body: 'Sam', received: Date.now(), read: false, dismissed: false, active: true, canDismiss: true, negativeActionLabel: 'Decline' });
    const f = await fixture(browser, { history: true, notifications: items, source: 'phone-b' });
    try {
        const initial = await openCardMenu(f.page, 'Incoming call');
        await initial.getByRole('button', { name: 'Decline on iPhone', exact: true }).waitFor();
        assert.equal(await initial.getByRole('button', { name: 'Dismiss on iPhone', exact: true }).count(), 0, 'a decline call action is never mislabeled as simple dismissal');
        await initial.getByRole('button', { name: 'Close actions', exact: true }).click();
        const stale = await openCardMenu(f.page, 'A message from Alex');
        assert.equal(await stale.getByRole('button', { name: /on iPhone/ }).count(), 0, 'a stale alert has no source action');
        await stale.getByRole('button', { name: 'Close actions', exact: true }).click();
        f.actionError = 'The iPhone disconnected. Reconnect and try again.';
        await cardAction(f.page, 'Incoming call', 'Decline on iPhone');
        await f.page.getByRole('alert').filter({ hasText: f.actionError }).waitFor();
        assert.deepEqual(f.actions, [{ key: 'b-call', expectedLabel: 'Decline' }]);
        assert.equal(f.notifications.find(n => n.key === 'b-call').dismissed, false);
        assert.equal(await headerBadge(f.page).textContent(), '2', 'failed phone actions leave the selected phone’s history and unread count intact');
        f.actionError = '';
        await cardAction(f.page, 'Incoming call', 'Decline on iPhone');
        const accepted = await openCardMenu(f.page, 'Incoming call');
        const sent = accepted.getByRole('button', { name: 'Action sent', exact: true });
        await sent.waitFor();
        assert.equal(await sent.isDisabled(), true);
        await accepted.getByRole('button', { name: 'Close actions', exact: true }).click();
        assert.equal(f.notifications.find(n => n.key === 'b-call').active, true, 'an accepted command is not presented as a confirmed phone removal');
        assert.equal(f.notifications.find(n => n.key === 'b-call').read, false);
        await assertClean(f);
        console.log('PASS phone action menus use the real iOS label, preserve failures, and do not pretend an accepted command removed the alert');
    } finally { await f.context.close(); }
}

async function notificationDeepLink(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), source: 'phone-b', notification: 'b-mail', displayedKeys: ['a-chat', 'b-mail'] });
    try {
        await until(() => f.readRequests.length === 1, 'opening a notification marks its one history record read');
        const opened = article(f.page, 'A message from Alex');
        await waitRead(f.page, 'A message from Alex', true);
        assert.match(await opened.getAttribute('class'), /highlighted/);
        assert.equal(await f.page.getByRole('combobox', { name: 'Device', exact: true }).inputValue(), 'phone-b');
        assert.equal(await article(f.page, 'Coffee at four?').count(), 0);
        assert.deepEqual(f.readRequests, [{ keys: ['b-mail'], read: true }]);
        assert.equal(await headerBadge(f.page).count(), 0);
        assert.equal(await f.page.evaluate(() => window.__notificationBadges.at(-1)), 2);
        assert.deepEqual(await f.page.evaluate(() => window.__closedNotifications), ['b-mail']);
        assert.ok(f.notifications.filter(n => n.source === 'phone-a').every(n => !n.read));
        await assertClean(f);
        console.log('PASS notification deep links open the correct phone and mark only the selected alert read');
    } finally { await f.context.close(); }
}

async function confirmBulk(page, buttonName, accept, beforeAnswer) {
    const sheet = await openToolbar(page);
    const button = sheet.getByRole('button', { name: buttonName });
    await button.click();
    const dialog = page.getByRole('dialog', { name: /^Dismiss \d+ notification/ });
    await dialog.waitFor();
    const message = await dialog.innerText();
    if (beforeAnswer) beforeAnswer(message);
    await dialog.getByRole('button', { name: accept ? /^Dismiss (here|on phone)$/ : 'Cancel', exact: !accept }).click();
    await dialog.waitFor({ state: 'detached' });
    return message;
}

async function bulkDismissHere(browser) {
    const items = historyItems();
    for (let i = 0; i < 26; i++) items.push({ ...items[1], key: `a-older-${i}`, title: `Older alert ${i + 1}`, received: Date.now() - 180000 - i * 1000 });
    const expected = items.filter(n => n.source === 'phone-a').map(n => n.key).sort();
    const f = await fixture(browser, { history: true, notifications: items, source: 'phone-a', displayedKeys: ['a-chat', 'b-mail', 'a-older-25'] });
    try {
        const button = /^Dismiss all here/;
        const cancelled = await confirmBulk(f.page, button, false);
        assert.match(cancelled, /Phone A/);
        assert.match(cancelled, /28/);
        assert.deepEqual(f.bulkDismissed, [], 'cancelling confirmation sends no dismiss request');
        assert.ok(f.notifications.every(n => !n.dismissed));
        const accepted = await confirmBulk(f.page, button, true, () => {
            f.notifications.unshift({ ...historyItems()[0], key: 'a-arrived-during-confirmation', title: 'Arrived during confirmation' });
        });
        assert.match(accepted, /Phone A/);
        await until(() => f.bulkDismissed.length === 1, 'confirmed bulk dismissal reaches the API');
        await article(f.page, 'Arrived during confirmation').waitFor();
        assert.equal(f.bulkDismissed[0].source, 'phone-a');
        assert.deepEqual([...f.bulkDismissed[0].keys].sort(), expected, 'the exact confirmed snapshot includes older unrendered alerts and excludes new arrivals');
        assert.equal(f.notifications.find(n => n.key === 'b-mail').dismissed, false, 'bulk local dismissal cannot touch another phone');
        assert.equal(f.notifications.find(n => n.key === 'a-arrived-during-confirmation').dismissed, false);
        assert.equal(f.notifications.length, 30, 'history survives bulk dismissal');
        assert.deepEqual((await f.page.evaluate(() => window.__closedNotifications)).sort(), ['a-chat', 'a-older-25']);
        assert.equal(await headerBadge(f.page).textContent(), '1');
        assert.equal(await f.page.evaluate(() => window.__notificationBadges.at(-1)), 2);
        await f.page.getByRole('button', { name: 'All history', exact: true }).click();
        await article(f.page, 'Coffee at four?').getByText('Dismissed here', { exact: true }).waitFor();
        await assertClean(f);
        console.log('PASS bulk local dismissal confirms a per-phone snapshot, preserves history, and leaves later arrivals untouched');
    } finally { await f.context.close(); }
}

async function bulkDismissPhone(browser) {
    const items = historyItems();
    items[1].canDismiss = true; items[1].negativeActionLabel = 'Dismiss notification';
    items[2].active = true; items[2].canDismiss = true; items[2].negativeActionLabel = 'Clear';
    items.push({ ...items[0], key: 'a-call', title: 'Incoming call', appName: 'Phone', negativeActionLabel: 'Decline' });
    items.push({ ...items[0], key: 'a-stale', title: 'Old cleared alert', active: false });
    const f = await fixture(browser, { history: true, notifications: items, source: 'phone-a', displayedKeys: ['a-chat', 'a-calendar', 'b-mail'] });
    try {
        const button = /^Dismiss all on (iPhone|phone)/;
        const cancelled = await confirmBulk(f.page, button, false);
        assert.match(cancelled, /Phone A/);
        assert.match(cancelled, /2/);
        assert.deepEqual(f.bulkActions, [], 'cancelling performs no phone actions');
        f.bulkActionResult = { accepted: ['a-chat'], skipped: [], failed: [{ key: 'a-calendar', error: 'The phone did not accept this action.' }], unprocessed: [] };
        await confirmBulk(f.page, button, true, () => {
            f.notifications.unshift({ ...items[0], key: 'a-new-clear', title: 'New clearable alert' });
        });
        await until(() => f.bulkActions.length === 1, 'confirmed bulk phone action reaches the API');
        await f.page.getByRole('alert').filter({ hasText: '1 not sent or not confirmed.' }).waitFor();
        const sentMenu = await openCardMenu(f.page, 'Coffee at four?');
        await sentMenu.getByRole('button', { name: 'Action sent', exact: true }).waitFor();
        await sentMenu.getByRole('button', { name: 'Close actions', exact: true }).click();
        assert.deepEqual(f.bulkActions, [{ source: 'phone-a', items: [{ key: 'a-chat', expectedLabel: 'Clear' }, { key: 'a-calendar', expectedLabel: 'Dismiss notification' }] }], 'bulk phone dismissal excludes Decline calls, stale alerts, other phones, and new arrivals');
        const retryMenu = await openCardMenu(f.page, 'Design review');
        assert.equal(await retryMenu.getByRole('button', { name: 'Dismiss notification on iPhone', exact: true }).isEnabled(), true, 'a failed member remains retryable');
        await retryMenu.getByRole('button', { name: 'Close actions', exact: true }).click();
        const callMenu = await openCardMenu(f.page, 'Incoming call');
        assert.equal(await callMenu.getByRole('button', { name: 'Decline on iPhone', exact: true }).isEnabled(), true, 'other phone actions remain individual and explicit');
        await callMenu.getByRole('button', { name: 'Close actions', exact: true }).click();
        assert.ok(f.notifications.every(n => !n.dismissed), 'accepted Bluetooth requests are not falsely represented as removal');
        assert.deepEqual(await f.page.evaluate(() => window.__closedNotifications), ['a-chat'], 'only accepted members close matching received pushes');
        await f.page.getByRole('alert').filter({ hasText: '1 not sent or not confirmed.' }).waitFor();
        assert.ok(await f.page.getByText(/The phone did not accept this action/).count(), 'partial failures are reported');
        await assertClean(f);
        console.log('PASS bulk phone dismissal confirms only safe labeled actions and reports partial failures without hiding unrelated alerts');
    } finally { await f.context.close(); }
}

async function compactLongNotification(browser) {
    const items = historyItems().slice(0, 1);
    items[0].body = Array.from({ length: 12 }, (_, i) => `Detail ${i + 1}: long notification text stays available when you need to read it.`).join('\n');
    const f = await fixture(browser, { history: true, sources: phones().slice(0, 1), notifications: items, width: 320 });
    try {
        assert.equal(await f.page.getByRole('combobox', { name: 'Device', exact: true }).count(), 0, 'a single phone needs no redundant device selector');
        const item = article(f.page, 'Coffee at four?');
        const body = item.locator('.notification-preview');
        await item.getByRole('button', { name: 'Show more', exact: true }).waitFor();
        const compact = await body.boundingBox();
        await item.getByRole('button', { name: 'Show more', exact: true }).click();
        await item.getByRole('button', { name: 'Show less', exact: true }).waitFor();
        const expanded = await body.boundingBox();
        assert.ok(expanded.height > compact.height * 2, 'the full text expands beyond the compact preview');
        await item.getByRole('button', { name: 'Show less', exact: true }).click();
        await item.getByRole('button', { name: 'Show more', exact: true }).waitFor();
        await assertClean(f);
        await capture(f, `compact-${browserName}-320`);
        console.log('PASS compact notification previews retain expandable full text on narrow screens');
    } finally { await f.context.close(); }
}

async function accessibleActionMenus(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), width: 320, ios: true, standalone: true });
    try {
        const trigger = article(f.page, 'Coffee at four?').getByRole('button', { name: 'Actions for Coffee at four?', exact: true });
        await trigger.focus();
        await trigger.press('Enter');
        let sheet = f.page.getByRole('dialog', { name: 'Messages', exact: true });
        await sheet.waitFor();
        assert.equal(await sheet.evaluate(el => el.matches(':modal')), true, 'actions use the native modal top layer');
        for (let i = 0; i < 7; i++) {
            await f.page.keyboard.press('Tab');
            assert.equal(await sheet.evaluate(el => el.contains(document.activeElement)), true, 'keyboard focus stays in the sheet');
        }
        await f.page.evaluate(() => document.querySelector('input[type="search"]')?.focus());
        assert.equal(await sheet.evaluate(el => el.contains(document.activeElement)), true, 'the background is inert');
        await f.page.keyboard.press('Escape');
        await sheet.waitFor({ state: 'detached' });
        assert.equal(await trigger.evaluate(el => document.activeElement === el), true, 'Escape restores focus to the invoking control');
        sheet = await openCardMenu(f.page, 'Coffee at four?');
        await f.page.mouse.click(2, 2);
        await sheet.waitFor({ state: 'detached' });
        sheet = await openCardMenu(f.page, 'Coffee at four?');
        const geometry = await sheet.evaluate(el => ({ height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width, viewportHeight: innerHeight, viewportWidth: innerWidth, targets: [...el.querySelectorAll('button')].map(button => button.getBoundingClientRect().height) }));
        assert.ok(geometry.height <= geometry.viewportHeight * .75 + 1);
        assert.ok(geometry.width <= geometry.viewportWidth);
        assert.ok(geometry.targets.every(height => height >= 44));
        await capture(f, `menu-${browserName}-320`);
        await f.page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
        await capture(f, `menu-${browserName}-dark`);
        await sheet.getByRole('button', { name: 'Close actions', exact: true }).click();
        assert.deepEqual(f.actions, []); assert.deepEqual(f.dismissed, []); assert.deepEqual(f.readRequests, []);
        await assertClean(f);
        console.log('PASS action sheets trap focus, make the background inert, restore focus and close on Escape/backdrop');
    } finally { await f.context.close(); }
}

async function richNotificationMedia(browser) {
    const items = historyItems().slice(0, 1);
    const host = 'https://media.example.test';
    items[0].body = `Photo: ${host}/photo.png?token=fixture\nAudio: ${host}/voice.wav\nVideo: ${host}/clip.mp4\nBroken: ${host}/missing.jpg\nWebsite: https://example.test/story\n<img src=x onerror=alert(1)>`;
    const requests = [];
    // One second of silent PCM: exercise a real browser decoder without network or hardware.
    const wav = Buffer.alloc(44 + 16000);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
    // One second of a solid blue H.264 frame, generated with ffmpeg's color filter.
    const mp4 = await fs.readFile(path.join(__dirname, 'fixtures/notification-video.mp4'));
    const f = await fixture(browser, {
        history: true, notifications: items, ios: true, standalone: true, width: 320,
        beforeGoto: page => page.route(`${host}/**`, route => {
            const url = new URL(route.request().url());
            requests.push(url.href);
            if (url.pathname === '/photo.png') return route.fulfill({ contentType: 'image/png', body: png });
            if (url.pathname === '/voice.wav') return route.fulfill({ contentType: 'audio/wav', body: wav });
            if (url.pathname === '/clip.mp4') return route.fulfill({ contentType: 'video/mp4', body: mp4 });
            return route.fulfill({ status: 404, body: '' });
        }),
    });
    try {
        const card = article(f.page, 'Coffee at four?');
        const media = card.locator('.notification-media');
        const photo = media.filter({ hasText: 'photo.png' });
        const audio = media.filter({ hasText: 'voice.wav' });
        const video = media.filter({ hasText: 'clip.mp4' });
        const broken = media.filter({ hasText: 'missing.jpg' });
        assert.equal(await media.count(), 4);
        assert.equal(await card.locator('.notification-preview a').count(), 5, 'message web links are clickable');
        assert.equal(await card.locator('.notification-preview img, .notification-preview script').count(), 0, 'app text never becomes HTML');
        assert.equal(await card.locator('audio, video, .notification-media img').count(), 0, 'media is not mounted before a tap');
        assert.deepEqual(requests, [], 'no automatic media requests');
        const link = photo.getByRole('link', { name: 'Open image' });
        assert.equal(await link.getAttribute('href'), `${host}/photo.png?token=fixture`);
        assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
        await photo.getByRole('button', { name: 'Load image from media.example.test', exact: true }).click();
        await f.page.waitForFunction(() => document.querySelector('.notification-media img')?.naturalWidth > 0);
        assert.equal(requests[0], `${host}/photo.png?token=fixture`, 'signed URL is retained');
        await capture(f, 'rich-media');
        await photo.getByRole('button', { name: 'Hide image from media.example.test', exact: true }).click();
        assert.equal(await photo.locator('img').count(), 0);

        await audio.getByRole('button', { name: 'Load audio from media.example.test', exact: true }).click();
        await f.page.waitForFunction(() => document.querySelector('.notification-media audio')?.readyState >= 1);
        assert.equal(await audio.locator('audio').evaluate(el => el.controls && el.paused && !el.autoplay), true);
        // Gestures on the player and its surrounding caption must not dismiss the card.
        const gestures = await touchSequence(f.page, audio, { dx: -130 });
        assert.equal(gestures.movesPrevented.some(Boolean), false);
        assert.deepEqual(f.operations, [], 'using media does not mark read or dismiss');
        await audio.locator('audio').evaluate(async el => { window.__testMediaPlayer = el; await el.play(); });
        await audio.getByRole('button', { name: 'Hide audio from media.example.test', exact: true }).click();
        await f.page.waitForFunction(() => window.__testMediaPlayer.paused && !window.__testMediaPlayer.hasAttribute('src'));

        await video.getByRole('button', { name: 'Load video from media.example.test', exact: true }).click();
        await f.page.waitForFunction(() => document.querySelector('.notification-media video')?.readyState >= 1);
        assert.equal(await video.locator('video').evaluate(el => el.controls && el.playsInline && el.paused && !el.autoplay), true);
        await video.locator('video').evaluate(async el => { window.__testMediaPlayer = el; await el.play(); });
        await f.page.waitForFunction(() => window.__testMediaPlayer.currentTime > 0);
        await video.getByRole('button', { name: 'Hide video from media.example.test', exact: true }).click();
        await f.page.waitForFunction(() => window.__testMediaPlayer.paused && !window.__testMediaPlayer.hasAttribute('src'));
        await broken.getByRole('button', { name: 'Load image from media.example.test', exact: true }).click();
        await broken.getByRole('status').waitFor();
        await broken.getByRole('button', { name: 'Retry image from media.example.test', exact: true }).click();
        await broken.getByRole('status').waitFor();

        // A notification edit drops loaded media, even when the URL is unchanged.
        await photo.getByRole('button', { name: 'Load image from media.example.test', exact: true }).click();
        f.notifications[0].body += '\nEdited message';
        await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await photo.getByRole('button', { name: 'Load image from media.example.test', exact: true }).waitFor();
        assert.equal(await photo.locator('img').count(), 0);
        // Preview disabling also protects against stale API text reaching the browser.
        f.sources[0].preview = false;
        await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await f.page.getByText('Previews off.', { exact: true }).waitFor();
        assert.equal(await f.page.locator('.notification-media, .notification-preview a, .notification-preview h3').count(), 0);
        await assertClean(f);
        console.log('PASS rich media loads on demand, plays audio, handles failures, respects privacy and leaves gestures alone');
    } finally { await f.context.close(); }
}

async function searchAndFilters(browser) {
    const items = historyItems();
    items[0].title = 'Café plans';
    const f = await fixture(browser, { history: true, notifications: items });
    try {
        const search = f.page.getByRole('searchbox', { name: 'Search notifications', exact: true });
        await search.fill('CAFE station');
        await article(f.page, 'Café plans').waitFor();
        assert.equal(await article(f.page, 'Design review').count(), 0, 'all search tokens match across title/body, ignoring case and accents');
        await search.fill('');
        await setAppFilter(f.page, 'com.example.calendar');
        await article(f.page, 'Design review').waitFor();
        assert.equal(await article(f.page, 'Café plans').count(), 0);
        await search.fill('station');
        assert.equal(await f.page.locator('article.notification-history-item').count(), 0, 'app and text filters combine');
        await f.page.getByRole('button', { name: 'Unread', exact: true }).click();
        await f.page.evaluate(() => { location.hash = '!action=notifications&source=phone-b&notification=b-mail'; });
        await waitRead(f.page, 'A message from Alex', true);
        assert.equal(await search.inputValue(), '', 'opening a specific alert resets stale search text');
        assert.equal(await f.page.getByRole('button', { name: 'Inbox', exact: true }).getAttribute('aria-pressed'), 'true');
        await f.page.getByRole('button', { name: /^Filters/ }).click();
        const sheet = f.page.getByRole('dialog', { name: 'Filter notifications', exact: true });
        assert.equal(await sheet.getByRole('combobox', { name: 'App', exact: true }).inputValue(), '', 'source/deep-link changes clear the app filter');
        await sheet.getByRole('button', { name: 'Close actions', exact: true }).click();
        await assertClean(f);
        console.log('PASS notification search and app/status filters combine, while deep links reset filters to reveal their alert');
    } finally { await f.context.close(); }
}

async function bulkRespectsFilters(browser) {
    const items = historyItems();
    items[0].title = 'Family dinner';
    items[1].title = 'Family meeting';
    items.push({ ...items[0], key: 'a-read-family', title: 'Family photo', read: true });
    const f = await fixture(browser, { history: true, notifications: items });
    try {
        await f.page.getByRole('searchbox', { name: 'Search notifications', exact: true }).fill('family');
        await setAppFilter(f.page, 'com.example.chat');
        await f.page.getByRole('button', { name: 'Unread', exact: true }).click();
        await article(f.page, 'Family dinner').waitFor();
        assert.equal(await f.page.locator('article.notification-history-item').count(), 1);
        const question = await confirmBulk(f.page, /^Dismiss all here/, true);
        assert.match(question, /1 notification/);
        await until(() => f.bulkDismissed.length === 1, 'filtered bulk request arrives');
        assert.deepEqual(f.bulkDismissed, [{ source: 'phone-a', keys: ['a-chat'] }]);
        assert.ok(f.notifications.filter(n => n.key !== 'a-chat').every(n => !n.dismissed), 'hidden app/status/source records are untouched');
        await assertClean(f);
        console.log('PASS bulk dismissal respects combined search, app, status and device filters');
    } finally { await f.context.close(); }
}

async function touchSequence(page, card, { dx, dy = 0, cancel = false, pointerNoise = false, verticalThenHorizontal = false, identifier = 71, cancelableMoves = true } = {}) {
    await card.scrollIntoViewIfNeeded();
    return card.evaluate((node, { dx, dy, cancel, pointerNoise, verticalThenHorizontal, identifier, cancelableMoves }) => {
        const target = node.querySelector('h3') || node;
        const box = target.getBoundingClientRect();
        const x = dx < 0 ? box.right - 35 : box.left + 35;
        const y = box.top + box.height / 2;
        const createTouch = (offsetX, offsetY) => {
            const data = { identifier, target, clientX: x + offsetX, clientY: y + offsetY, pageX: x + offsetX + scrollX, pageY: y + offsetY + scrollY, screenX: x + offsetX, screenY: y + offsetY };
            if (typeof document.createTouch === 'function') return document.createTouch(window, target, data.identifier, data.pageX, data.pageY, data.screenX, data.screenY);
            return new Touch(data);
        };
        const list = items => typeof document.createTouchList === 'function' ? document.createTouchList(...items) : items;
        const touch = (type, offsetX, offsetY) => {
            const point = createTouch(offsetX, offsetY);
            const active = type === 'touchend' || type === 'touchcancel' ? [] : [point];
            const event = new TouchEvent(type, { bubbles: true, cancelable: type !== 'touchmove' || cancelableMoves, touches: list(active), targetTouches: list(active), changedTouches: list([point]) });
            target.dispatchEvent(event);
            return event.defaultPrevented;
        };
        const pointer = (type, offsetX = 0, offsetY = 0, eventTarget = target) => eventTarget.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerId: 23, pointerType: 'touch', isPrimary: true, button: 0,
            buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, clientX: x + offsetX, clientY: y + offsetY,
        }));
        if (pointerNoise) pointer('pointerdown');
        const startPrevented = touch('touchstart', 0, 0);
        const smallMovePrevented = touch('touchmove', 3, 2);
        const movesPrevented = [];
        for (let step = 1; step <= 5; step++) {
            const offsetX = dx * step / 5;
            const offsetY = dy * step / 5;
            if (pointerNoise) pointer('pointermove', offsetX, offsetY);
            movesPrevented.push(touch('touchmove', offsetX, offsetY));
            if (pointerNoise && step === 2) {
                pointer('pointercancel', offsetX, offsetY);
                pointer('lostpointercapture', offsetX, offsetY, node);
                // Some Home Screen compatibility events omit pointerType entirely.
                node.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 23 }));
                node.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 23 }));
            }
        }
        if (verticalThenHorizontal) movesPrevented.push(touch('touchmove', 140, dy));
        if (pointerNoise) pointer('pointerup', dx, dy);
        touch(cancel ? 'touchcancel' : 'touchend', verticalThenHorizontal ? 140 : dx, dy);
        if (pointerNoise) {
            // Duplicate compatibility events arriving after the authoritative touchend must also be ignored.
            pointer('pointerdown'); pointer('pointermove', dx, dy); pointer('pointerup', dx, dy);
        }
        return { identifier: createTouch(0, 0).identifier, startPrevented, smallMovePrevented, movesPrevented };
    }, { dx, dy, cancel, pointerNoise, verticalThenHorizontal, identifier, cancelableMoves });
}

async function swipe(page, card, dx, dy = 0, cancel = false) {
    await card.scrollIntoViewIfNeeded();
    const rect = await card.boundingBox();
    const x = dx < 0 ? rect.x + rect.width - 50 : rect.x + 50;
    const titleRect = await card.locator('h3').boundingBox();
    const y = titleRect ? titleRect.y + titleRect.height / 2 : rect.y + rect.height / 2;
    if (browserName === 'chromium') {
        const session = await page.context().newCDPSession(page);
        const point = (offsetX, offsetY) => [{ x: x + offsetX, y: y + offsetY, radiusX: 1, radiusY: 1, force: 1, id: 1 }];
        try {
            await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(0, 0) });
            for (let step = 1; step <= 5; step++) {
                await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(dx * step / 5, dy * step / 5) });
                await sleep(16);
            }
            await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
        } finally { await session.detach(); }
    } else {
        await touchSequence(page, card, { dx, dy, cancel });
    }
}

async function swipeAndUndo(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), ios: true, standalone: true });
    try {
        let card = article(f.page, 'Coffee at four?');
        await swipe(f.page, card, 130);
        await waitRead(f.page, 'Coffee at four?', true);
        assert.deepEqual(f.readRequests.at(-1), { keys: ['a-chat'], read: true });
        await f.page.getByRole('button', { name: 'Undo', exact: true }).click();
        await waitRead(f.page, 'Coffee at four?', false);
        assert.deepEqual(f.readRequests.at(-1), { keys: ['a-chat'], read: false });
        const before = f.readRequests.length;
        await swipe(f.page, card, 120, 0, true);
        await swipe(f.page, card, 0, 90);
        assert.equal(f.readRequests.length, before, 'cancelled gestures and vertical scrolling cannot mark a notification read');
        assert.deepEqual(f.dismissed, []);
        await swipe(f.page, card, -130);
        await card.waitFor({ state: 'detached' });
        assert.deepEqual(f.dismissed, ['a-chat']);
        assert.deepEqual(f.actions, [], 'a swipe never performs a source-phone action');
        await f.page.getByRole('button', { name: 'Undo', exact: true }).click();
        card = article(f.page, 'Coffee at four?');
        await card.waitFor();
        await waitRead(f.page, 'Coffee at four?', false);
        assert.deepEqual(f.restored.at(-1), { key: 'a-chat', read: false }, 'undo restores the prior unread state as well as the inbox item');
        assert.equal(f.notifications.find(n => n.key === 'b-mail').read, false);
        await assertClean(f);
        console.log(`PASS ${browserName === 'chromium' ? 'real mobile touch' : 'WebKit native TouchEvent handler'} swipes toggle read/dismiss locally, ignore scrolling/cancellation, and support Undo`);
    } finally { await f.context.close(); }
}

async function swipeMotionAndFailure(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), ios: true, standalone: true });
    try {
        const card = article(f.page, 'Coffee at four?');
        // Pause the exit halfway to inspect the visible gesture without timing races.
        await f.page.evaluate(() => {
            const animate = Element.prototype.animate;
            window.__cardAnimations = [];
            Element.prototype.animate = function (...args) {
                const animation = animate.apply(this, args);
                if (this.matches('article.notification-history-item') && args[0].at(-1).opacity === 0) {
                    window.__cardAnimations.push(animation);
                    animation.pause();
                    animation.currentTime = animation.effect.getTiming().duration / 2;
                }
                return animation;
            };
        });
        f.dismissError = 'Could not dismiss. Try again.';
        const origin = await card.boundingBox();
        await touchSequence(f.page, card, { dx: -130 });
        const exiting = await card.boundingBox();
        assert(exiting.x < origin.x - 96, 'a committed swipe continues beyond the finger offset');
        assert.deepEqual(f.dismissed, [], 'the item stays in place until its visible exit finishes');
        await touchSequence(f.page, card, { dx: -130 });
        assert.equal(await f.page.evaluate(() => window.__cardAnimations.length), 1, 'repeated input cannot start a second dismissal');
        await f.page.evaluate(() => window.__cardAnimations[0].finish());
        await f.page.getByRole('alert').filter({ hasText: f.dismissError }).waitFor();
        await f.page.waitForFunction(() => {
            const node = document.querySelector('article.notification-history-item');
            return node && node.getAttribute('aria-busy') !== 'true' && new DOMMatrix(getComputedStyle(node).transform).m41 === 0;
        });
        assert.deepEqual(f.dismissed, [], 'a failed dismissal leaves the alert in the inbox');
        await waitRead(f.page, 'Coffee at four?', false);
        // Reduced motion performs the same action and Undo without an off-screen animation.
        await f.page.emulateMedia({ reducedMotion: 'reduce' });
        f.dismissError = '';
        await touchSequence(f.page, card, { dx: -130 });
        await card.waitFor({ state: 'detached' });
        assert.equal(await f.page.evaluate(() => window.__cardAnimations.length), 1, 'reduced motion skips the exit animation');
        assert.deepEqual(f.dismissed, ['a-chat']);
        await f.page.getByRole('button', { name: 'Undo', exact: true }).click();
        await card.waitFor();
        await waitRead(f.page, 'Coffee at four?', false);
        await f.page.emulateMedia({ reducedMotion: 'no-preference' });
        await touchSequence(f.page, card, { dx: -130 });
        await f.page.evaluate(() => { location.hash = '!'; });
        await f.page.locator('#devices').waitFor();
        await sleep(250);
        assert.deepEqual(f.dismissed, ['a-chat'], 'leaving during an exit cancels its pending action');
        await assertClean(f);
        console.log('PASS swipe completion stays visible, ignores duplicate input, restores failed actions and respects reduced motion and navigation');
    } finally { await f.context.close(); }
}

async function delayedActionDoesNotCrossDevices(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems() });
    try {
        f.holdNextMutation = true;
        await cardAction(f.page, 'Coffee at four?', 'Dismiss here');
        await until(() => !!f.releaseMutation, 'the fixture holds the first phone’s mutation response');
        // The select is intentionally disabled while saving; history/deep-link navigation can still change routes.
        await f.page.evaluate(() => { location.hash = '!action=notifications&source=phone-b'; });
        await article(f.page, 'A message from Alex').waitFor();
        const polls = f.statusPolls;
        f.releaseMutation();
        await until(() => f.statusPolls > polls, 'the delayed action finishes and refreshes status');
        await f.page.waitForFunction(() => !document.querySelector('button[aria-label="Notification actions"]')?.disabled);
        assert.equal(await f.page.getByRole('button', { name: 'Undo', exact: true }).count(), 0, 'a late response must not offer another phone’s Undo action');
        assert.equal(f.notifications.find(n => n.key === 'b-mail').dismissed, false);
        assert.deepEqual(f.restored, []);
        await f.page.getByRole('combobox', { name: 'Device', exact: true }).selectOption('phone-a');
        assert.equal(await f.page.getByRole('button', { name: 'Undo', exact: true }).count(), 0, 'returning to the first phone cannot resurrect a stale Undo action');
        await assertClean(f);
        console.log('PASS delayed action responses cannot expose a stale Undo after switching phones');
    } finally { if (f.releaseMutation) f.releaseMutation(); await f.context.close(); }
}

async function standaloneTouchNotifications(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), ios: true, standalone: true });
    try {
        assert.deepEqual(await f.page.evaluate(() => ({ standalone: navigator.standalone, displayMode: matchMedia('(display-mode: standalone)').matches, touch: 'ontouchstart' in window })), { standalone: true, displayMode: true, touch: true });
        let card = article(f.page, 'Coffee at four?');
        const gesture = await touchSequence(f.page, card, { dx: 130, identifier: 0 });
        assert.equal(gesture.identifier, 0, 'zero remains a valid native touch identifier');
        await waitRead(f.page, 'Coffee at four?', true);
        assert.deepEqual(f.readRequests, [{ keys: ['a-chat'], read: true }]);
        assert.equal(gesture.startPrevented, false, 'touchstart must leave native taps and scrolling available');
        assert.equal(gesture.smallMovePrevented, false, 'small undecided movements must not block native scrolling');
        assert.ok(gesture.movesPrevented.some(Boolean), 'horizontal intent consumes the touchmove with a non-passive listener');
        await f.page.getByRole('button', { name: 'Undo', exact: true }).click();
        await waitRead(f.page, 'Coffee at four?', false);
        // Captured from the physical Home Screen app: signed IDs are valid, not cancellation sentinels.
        const signed = await touchSequence(f.page, card, { dx: 130, identifier: -1790170905 });
        assert.equal(signed.identifier, -1790170905, 'the browser event preserves the signed physical-device identifier');
        await waitRead(f.page, 'Coffee at four?', true);
        assert.deepEqual(f.readRequests.at(-1), { keys: ['a-chat'], read: true });
        assert.equal(f.readRequests.length, 3, 'the signed-ID gesture commits exactly once');
        await f.page.getByRole('button', { name: 'Undo', exact: true }).click();
        await waitRead(f.page, 'Coffee at four?', false);
        await touchSequence(f.page, card, { dx: -130, identifier: 0 });
        await card.waitFor({ state: 'detached' });
        assert.deepEqual(f.dismissed, ['a-chat']);
        assert.deepEqual(f.actions, [], 'touch-only swipes still never perform source-phone actions');
        await f.page.getByRole('button', { name: 'Undo', exact: true }).click();
        card = article(f.page, 'Coffee at four?');
        await card.waitFor();
        await waitRead(f.page, 'Coffee at four?', false);
        assert.deepEqual(f.restored.at(-1), { key: 'a-chat', read: false });
        await assertClean(f);
        console.log('PASS standalone touch-only notification swipes accept zero/signed physical IDs, preserve scrolling intent, and support Undo');
    } finally { await f.context.close(); }
}

async function compatibilityPointerEventsDoNotDoubleAct(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), ios: true, standalone: true });
    try {
        const card = article(f.page, 'Coffee at four?');
        await touchSequence(f.page, card, { dx: 130, pointerNoise: true });
        await waitRead(f.page, 'Coffee at four?', true);
        assert.deepEqual(f.readRequests, [{ keys: ['a-chat'], read: true }], 'touch plus compatibility pointer events produces exactly one read action');
        assert.deepEqual(f.dismissed, []);
        await f.page.getByRole('button', { name: 'Undo', exact: true }).click();
        await waitRead(f.page, 'Coffee at four?', false);
        await touchSequence(f.page, card, { dx: -130, pointerNoise: true });
        await card.waitFor({ state: 'detached' });
        assert.deepEqual(f.dismissed, ['a-chat'], 'pointer cancellation/capture loss cannot cancel or duplicate the authoritative touch gesture');
        assert.equal(f.readRequests.length, 2, 'the compatibility stream cannot toggle read again');
        assert.deepEqual(f.actions, []);
        await assertClean(f);
        console.log('PASS compatibility pointercancel/capture-loss events cannot cancel TouchEvents or duplicate notification actions');
    } finally { await f.context.close(); }
}

async function nativeTouchCancellationAndMultifinger(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), ios: true, standalone: true });
    try {
        const card = article(f.page, 'Coffee at four?');
        const vertical = await touchSequence(f.page, card, { dx: 0, dy: 90, verticalThenHorizontal: true });
        assert.equal(vertical.startPrevented, false);
        assert.equal(vertical.smallMovePrevented, false);
        assert.ok(vertical.movesPrevented.every(value => !value), 'vertical intent keeps native scrolling throughout the gesture');
        await touchSequence(f.page, card, { dx: 130, cancel: true });
        const uncancelable = await touchSequence(f.page, card, { dx: 130, cancelableMoves: false });
        assert.ok(uncancelable.movesPrevented.every(value => !value));
        await f.page.evaluate(() => {
            const cards = [...document.querySelectorAll('article.notification-history-item')];
            const a = cards[0].querySelector('h3');
            const b = cards[1].querySelector('h3');
            const create = (target, identifier, dx = 0) => {
                const rect = target.getBoundingClientRect();
                const x = rect.left + 35 + dx, y = rect.top + rect.height / 2;
                return typeof document.createTouch === 'function'
                    ? document.createTouch(window, target, identifier, x + scrollX, y + scrollY, x, y)
                    : new Touch({ target, identifier, clientX: x, clientY: y, pageX: x + scrollX, pageY: y + scrollY });
            };
            const list = items => typeof document.createTouchList === 'function' ? document.createTouchList(...items) : items;
            const dispatch = (target, type, active, changed) => target.dispatchEvent(new TouchEvent(type, {
                bubbles: true, cancelable: true, touches: list(active), changedTouches: list(changed),
                targetTouches: list(active.filter(point => point.target === target)),
            }));
            let first = create(a, 0);
            const second = create(b, 1);
            dispatch(a, 'touchstart', [first], [first]);
            first = create(a, 0, 35);
            dispatch(a, 'touchmove', [first], [first]);
            dispatch(b, 'touchstart', [first, second], [second]);
            dispatch(b, 'touchend', [first], [second]);
            first = create(a, 0, 140);
            dispatch(a, 'touchmove', [first], [first]);
            dispatch(a, 'touchend', [], [first]);
            // A new single-finger sequence must also stop if the PWA is backgrounded.
            first = create(a, 0);
            dispatch(a, 'touchstart', [first], [first]);
            first = create(a, 0, 90);
            dispatch(a, 'touchmove', [first], [first]);
            window.dispatchEvent(new Event('pagehide'));
            dispatch(a, 'touchend', [], [first]);
        });
        await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepEqual(f.readRequests, [], 'vertical, cancelled, uncancelable, multi-finger and backgrounded touches cannot commit a read action');
        assert.deepEqual(f.dismissed, []);
        // Cancellation must not leave the next deliberate single-finger swipe stuck.
        await touchSequence(f.page, card, { dx: 130 });
        await waitRead(f.page, 'Coffee at four?', true);
        assert.equal(f.readRequests.length, 1);
        await assertClean(f);
        console.log('PASS native touch scrolling, cancellation, multi-finger input and page suspension never act on notifications');
    } finally { await f.context.close(); }
}

async function hangingCleanupSwipes(browser, workerHang) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), ios: true, standalone: true, workerHang, displayedKeys: ['a-chat', 'a-calendar'] });
    f.page.setDefaultTimeout(3000);
    try {
        await swipe(f.page, article(f.page, 'Coffee at four?'), 130);
        await until(() => f.readRequests.length === 1, 'the read mutation reached the server');
        await f.page.waitForFunction(() => { const button = document.querySelector('button[aria-label="Notification actions"]'); return !!button && !button.disabled; }, undefined, { timeout: 700 });
        await waitRead(f.page, 'Coffee at four?', true);
        await f.page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
        assert.deepEqual(f.readRequests, [{ keys: ['a-chat'], read: true }]);
        const calls = await f.page.evaluate(() => window.__notificationWorkerCalls);
        assert.ok(calls.getRegistration > 0, 'push cleanup attempted registration lookup');
        if (workerHang === 'notifications') assert.ok(calls.getNotifications > 0, 'push cleanup reached the hanging notification lookup');
        const calendar = article(f.page, 'Design review');
        await swipe(f.page, calendar, -130);
        await calendar.waitFor({ state: 'detached' });
        assert.deepEqual(f.dismissed, ['a-calendar'], 'a second swipe remains usable while the first push cleanup never resolves');
        await f.page.getByRole('button', { name: 'Undo', exact: true }).click();
        await calendar.waitFor();
        await waitRead(f.page, 'Design review', false);
        assert.deepEqual(f.restored, [{ key: 'a-calendar', read: false }], 'Undo remains independent of the stalled worker');
        assert.deepEqual(f.actions, []);
        assert.equal(await headerBadge(f.page).textContent(), '1');
        await assertClean(f);
        console.log(`PASS never-resolving service-worker ${workerHang} cleanup cannot block the next swipe or Undo`);
    } finally { await f.context.close(); }
}

async function hangingRegistrationCleanup(browser) {
    await hangingCleanupSwipes(browser, 'registration');
}

async function hangingNotificationCleanup(browser) {
    await hangingCleanupSwipes(browser, 'notifications');
}

async function hangingWorkerDeepLink(browser) {
    for (const workerHang of ['registration', 'notifications']) {
        const f = await fixture(browser, { history: true, notifications: historyItems(), ios: true, standalone: true, workerHang, source: 'phone-a', notification: 'a-chat', displayedKeys: ['a-chat'] });
        f.page.setDefaultTimeout(3000);
        try {
            await until(() => f.readRequests.length === 1, 'the deep-link read mutation reached the server');
            await f.page.waitForFunction(() => { const button = document.querySelector('button[aria-label="Notification actions"]'); return !!button && !button.disabled; }, undefined, { timeout: 700 });
            await waitRead(f.page, 'Coffee at four?', true);
            assert.deepEqual(f.readRequests, [{ keys: ['a-chat'], read: true }], 'a push deep link auto-marks only its alert on initial mount');
            const calendar = article(f.page, 'Design review');
            await swipe(f.page, calendar, -130);
            await calendar.waitFor({ state: 'detached' });
            await f.page.getByRole('button', { name: 'Undo', exact: true }).click();
            await calendar.waitFor();
            await waitRead(f.page, 'Design review', false);
            assert.deepEqual(f.dismissed, ['a-calendar']);
            assert.deepEqual(f.restored, [{ key: 'a-calendar', read: false }]);
            const calls = await f.page.evaluate(() => window.__notificationWorkerCalls);
            assert.ok(calls.getRegistration > 0);
            if (workerHang === 'notifications') assert.ok(calls.getNotifications > 0);
            await assertClean(f);
        } finally { await f.context.close(); }
    }
    console.log('PASS push deep-link auto-read cannot freeze initial PWA gestures when either service-worker lookup stalls');
}

async function main() {
    const browser = await ({ chromium, webkit }[browserName] || chromium).launch({ headless: true });
    try {
        const cases = [onboarding, configuredReceiver, receiverChoicesAndUnlink, enablingReceiver, errorsSurvivePolling,
            iosInstallGate, recoverMissingServerSubscription, perDeviceHistory, dismissKeepsHistory, labeledPhoneActions,
            notificationDeepLink, bulkDismissHere, bulkDismissPhone, compactLongNotification, accessibleActionMenus, richNotificationMedia,
            searchAndFilters, bulkRespectsFilters, swipeAndUndo, swipeMotionAndFailure, delayedActionDoesNotCrossDevices, standaloneTouchNotifications,
            compatibilityPointerEventsDoNotDoubleAct, nativeTouchCancellationAndMultifinger, hangingRegistrationCleanup,
            hangingNotificationCleanup, hangingWorkerDeepLink];
        const selected = process.env.SCENARIO ? cases.filter(run => run.name === process.env.SCENARIO) : cases;
        assert.ok(selected.length, 'SCENARIO must name an existing fixture case');
        for (const run of selected) await run(browser);
    } finally { await browser.close(); }
}
module.exports = { fixture, article, historyItems, touchSequence, cardAction, openCardMenu };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
