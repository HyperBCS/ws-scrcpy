const { settleMotion } = require('./ui-motion');
// Run against a built app: BASE=http://localhost:8000 node scripts/e2e-notifications.js
// API, device discovery, and push subscriptions are isolated fixtures. No real
// phone settings, Bluetooth state, or push providers are changed by these tests.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const browserName = process.env.BROWSER || 'chromium';
const BASE = process.env.BASE || 'http://localhost:8000/';
const SCREENSHOTS = process.env.SCREENSHOTS || '/tmp';
// Sticky-bar screenshots after scrolling. Run twice to compare: E2E_OUT=/tmp/ws-scrcpy-notifications/before and /after.
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-notifications';
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
// The page header is the shared AppBar in one row: the back control, the title with the iPhone
// shown, the unread count, Switch where more than one iPhone is linked, Search and Setup.
const HEADER = '.notifications-view > .kit-bar';
const headerBadge = page => page.locator(`${HEADER} .notification-unread-count`);
const backControl = page => page.locator(HEADER).getByRole('button', { name: 'Phones', exact: true });
const headerStatus = page => page.locator(`${HEADER} .kit-bar-status`);
const setupControl = page => page.locator(HEADER).getByRole('button', { name: 'Setup', exact: true });
const searchControl = page => page.locator(HEADER).getByRole('button', { name: 'Search', exact: true });
const switchControl = page => page.locator(HEADER).getByRole('button', { name: 'Switch iPhone', exact: true });
// The inbox filter is a segmented control: a radio group.
const segment = (page, name) => page.getByRole('radio', { name: name === 'Inbox' ? /^Inbox \d+$/ : name === 'Unread' ? /^Unread \d+$/ : name, exact: name === 'Archive' });
const pressed = async (page, name) => String(await segment(page, name).isChecked());
// Setup is shown while its control in the bar is pressed.
const setupShown = async page => String(await setupControl(page).getAttribute('aria-pressed'));
// The status has arrived once Setup is in the page: it stays mounted behind the inbox.
const statusLoaded = page => page.locator('#notification-sender-heading').waitFor({ state: 'attached' });
async function showSetup(page) {
    await statusLoaded(page);
    if ((await setupShown(page)) !== 'true') await setupControl(page).click();
    await page.getByRole('heading', { name: 'Send from an iPhone', exact: true }).waitFor();
}
async function showInbox(page) {
    await statusLoaded(page);
    if ((await setupShown(page)) === 'true') await setupControl(page).click();
    await page.locator('#notification-history-heading').waitFor();
}
/** The search row opens from the bar. */
async function searchField(page) {
    const field = page.getByRole('searchbox', { name: 'Search notifications', exact: true });
    if (!(await field.count())) await searchControl(page).click();
    await field.waitFor();
    return field;
}
/** The iPhone shown, from the sheet that Switch in the bar opens. */
async function switchIphone(page, name) {
    await switchControl(page).click();
    const sheet = page.getByRole('dialog', { name: 'Switch iPhone', exact: true });
    await sheet.waitFor();
    await sheet.getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
    await sheet.waitFor({ state: 'detached' });
}
/** The name of the iPhone the inbox shows, from the bar. */
const shownIphone = async page => (await headerStatus(page).textContent()).split(' · ')[0];
async function openCardMenu(page, title) {
    const trigger = article(page, title).getByRole('button', { name: `Actions for ${title}`, exact: true });
    // A menu follows a visible button. Finish Playwright's scroll before opening it.
    await trigger.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await trigger.click();
    const sheet = page.locator('dialog.kit-sheet[open], .kit-menu[role=menu]:not([data-exiting])');
    await sheet.waitFor();
    return sheet;
}
async function cardAction(page, title, name) {
    const sheet = await openCardMenu(page, title);
    await sheet.getByRole(await sheet.getAttribute('role') === 'menu' ? 'menuitem' : 'button', { name, exact: true }).click();
    await sheet.waitFor({ state: 'detached' });
}
// The shared confirm prompt ignores presses until its guard has passed.
async function confirmPrompt(scope, question, button) {
    const prompt = scope.getByRole('alertdialog', { name: question, exact: true });
    await prompt.waitFor();
    await prompt.locator('.kit-confirm-actions > .kit-button:not([aria-disabled])').first().waitFor();
    await prompt.getByRole('button', { name: button, exact: true }).click();
    return prompt;
}
// A phone action that is not a plain dismissal: the first tap arms it, the prompt confirms it.
async function confirmedCardAction(page, title, name, question, button) {
    const sheet = await openCardMenu(page, title);
    await sheet.getByRole('button', { name, exact: true }).click();
    await confirmPrompt(sheet, question, button);
    await sheet.waitFor({ state: 'detached' });
}
async function openToolbar(page) {
    await page.getByRole('button', { name: 'Notification actions', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.waitFor();
    return sheet;
}
async function toolbarAction(page, name) {
    if (name === 'Mark all read') { await page.getByRole('button', { name, exact: true }).click(); return; }
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
    await searchField(page);
    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Filter notifications', exact: true });
    await sheet.getByRole('combobox', { name: 'App', exact: true }).selectOption(app);
    await sheet.locator('.kit-sheet-close').click();
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
        viewport: { width: options.width || 390, height: options.height || 844 },
        // Phone-width fixtures use touch unless a test explicitly asks for a narrow mouse window.
        hasTouch: !options.mouse && (options.width || 390) < 1024,
        ...(options.ios ? {
            isMobile: true, hasTouch: true,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        } : {}),
    });
    await context.addInitScript(({ subscription, registered, storedSources, storedReceiver, ios, standalone, displayedKeys, workerHang, subscribedKey, subscribeNeedsGesture }) => {
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
        window.__lastTap = -Infinity;
        addEventListener('click', event => { if (event.isTrusted) window.__lastTap = performance.now(); }, true);
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
        // `subscribedKey` is the server key the browser's subscription was made for. With it set,
        // subscriptions report their key and a new one gets a new endpoint, as in a real browser.
        const bytes = key => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer;
        let renewals = 0;
        const makeSubscription = key => {
            const json = key && renewals ? { ...subscription, endpoint: `${subscription.endpoint}-renewed-${renewals}` } : subscription;
            return {
                ...json,
                ...(key ? { options: { userVisibleOnly: true, applicationServerKey: key } } : {}),
                toJSON: () => json,
                unsubscribe: async () => { counters.unsubscribeCalls++; active = null; return true; },
            };
        };
        let active = registered ? makeSubscription(subscribedKey && bytes(subscribedKey)) : null;
        PushManager.prototype.getSubscription = async () => active;
        PushManager.prototype.subscribe = async settings => {
            counters.subscribeCalls++;
            // Safari refuses to subscribe outside a tap, even with permission granted.
            if (subscribeNeedsGesture && !(performance.now() - window.__lastTap < 1000))
                throw new DOMException('Subscribing for push requires a user gesture', 'NotAllowedError');
            if (subscribedKey) renewals++;
            const key = settings.applicationServerKey;
            active = makeSubscription(subscribedKey && key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength));
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
    }, { subscription, registered: options.registered ?? true, storedSources: options.storedSources, storedReceiver: options.storedReceiver, ios: !!options.ios, standalone: !!options.standalone, displayedKeys: options.displayedKeys || [], workerHang: options.workerHang || '', subscribedKey: options.subscribedKey || '', subscribeNeedsGesture: !!options.subscribeNeedsGesture });
    const page = await context.newPage();
    if (options.clock) await page.clock.install();
    const state = {
        context, page, sources: options.sources ?? phones(), errors: [], saved: [], tests: [], removed: [],
        streams: [], disabled: 0, statusPolls: 0, pairingOpen: false, pairingRejected: !!options.pairingRejected, subscriptionError: options.subscriptionError || '',
        receivers: options.receivers, removedEndpoints: [], registeredEndpoints: new Set(),
        missingSubscription: !!options.missingSubscription, testError: '', operations: [],
        historyFetches: [], bulkDismissErrorSource: '', sourcePosts: [], sourceError: '', statuses: options.statuses || {}, feedError: options.feedError || '', publicKey: options.publicKey || subscription.keys.p256dh,
        notifications: structuredClone(options.notifications || []), readRequests: [], dismissed: [], actions: [], iconRequests: [], actionError: '', dismissError: '', summaryPolls: 0, bulkDismissed: [], bulkActions: [], bulkActionResult: null, restored: [], bulkRestored: [], statusError: '', holdNextMutation: false, releaseMutation: null,
    };
    page.on('pageerror', error => state.errors.push(error.message));
    await page.routeWebSocket('**', socket => {
        // One entry is one screen session started on a phone. The socket is left unanswered.
        const stream = new URL(socket.url()).searchParams;
        if (/^proxy-(adb|coredevice)$/.test(stream.get('action') || '')) return void state.streams.push(stream.get('udid'));
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
        // As on the server: the revision is a hash of what /history would send.
        const revision = crypto.createHash('sha1').update(JSON.stringify(state.notifications)).digest('hex').slice(0, 16);
        if (pathname.endsWith('/status')) {
            state.statusPolls++;
            if (state.statusError) return route.fulfill({ status: 502, json: { error: state.statusError } });
            reply = {
                publicKey: state.publicKey, sources: state.sources, bluetooth: options.bluetooth || [],
                statuses: Object.fromEntries(state.sources.map(s => [s.id, state.statuses[s.id] ?? 'Receiving notifications'])), pairing: null,
                pairingOpen: state.pairingOpen, pairingRejected: state.pairingRejected, error: state.feedError, delivery: { sent: 0, failed: 0, lastError: '' },
                // 'saved': the devices the page registered, as the server would list them.
                ...(state.receivers === 'saved' ? { receivers: [...state.registeredEndpoints].map(endpoint => ({ id: crypto.createHash('sha256').update(endpoint).digest('hex'), provider: 'Apple', sent: 0, failed: 0, lastError: '' })) } : state.receivers ? { receivers: state.receivers } : {}),
                historyRevision: revision, storedBySource: Object.fromEntries(state.sources.map(s => [s.id, state.notifications.filter(n => n.source === s.id).length])),
                unread, unreadBySource, retentionDays: 30, publicUrl: 'https://phone.example',
            };
        } else if (pathname.endsWith('/history') && request.method() === 'GET') {
            const since = new URL(request.url()).searchParams.get('since');
            state.historyFetches.push(since);
            if (since === revision) return route.fulfill({ status: 304 });
            reply = { revision, notifications: state.notifications };
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
        } else if (pathname.endsWith('/history/restore') && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.bulkRestored.push(body);
            const restored = [];
            for (const { key, read } of body.items) {
                const item = state.notifications.find(n => n.key === key && n.source === body.source);
                if (item) { item.dismissed = false; item.read = read; restored.push(key); }
            }
            reply = { ok: true, restored };
        } else if (pathname.endsWith('/history/dismiss') && request.method() === 'POST') {
            const body = request.postDataJSON();
            state.bulkDismissed.push(body);
            if (body.source === state.bulkDismissErrorSource) return route.fulfill({ status: 500, json: { error: 'Could not archive this iPhone.' } });
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
            else {
                state.missingSubscription = false;
                state.registeredEndpoints.add(state.saved.at(-1).subscription.endpoint);
            }
        } else if (pathname.endsWith('/subscriptions') && request.method() === 'DELETE') {
            state.disabled++;
            state.removedEndpoints.push(request.postDataJSON().endpoint);
            state.registeredEndpoints.delete(request.postDataJSON().endpoint);
        }
        else if (pathname.endsWith('/test') && request.method() === 'POST') {
            state.tests.push(request.postDataJSON());
            if (state.testError || state.missingSubscription) {
                status = 400;
                reply = { error: state.testError || 'Enable notifications on this device first' };
            }
        }
        else if (pathname.endsWith('/pair') && request.method() === 'POST') Object.assign(state, { pairingOpen: true, pairingRejected: false });
        else if (pathname.includes('/sources/') && request.method() === 'DELETE') {
            const id = decodeURIComponent(pathname.split('/').pop());
            state.removed.push(id);
            state.sources = state.sources.filter(s => s.id !== id);
        } else if (pathname.endsWith('/sources') && request.method() === 'POST') {
            const source = request.postDataJSON();
            state.sourcePosts.push(source);
            if (state.sourceError) { status = 400; reply = { error: state.sourceError }; }
            // As the server does: a changed iPhone keeps its place, a new one is added at the end.
            else state.sources = state.sources.some(s => s.id === source.id) ? state.sources.map(s => s.id === source.id ? source : s) : [...state.sources, source];
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
    const url = new URL(BASE); const source = options.source ?? (options.history && !options.allSources ? 'phone-a' : ''); url.hash = '!action=notifications' + (source ? '&source=' + encodeURIComponent(source) : '') + (options.notification ? '&notification=' + encodeURIComponent(options.notification) : '');
    if (options.beforeGoto) await options.beforeGoto(page);
    await page.goto(url.href);
    await statusLoaded(page);
    if (options.history) {
        await page.locator('#notification-history-heading').waitFor();
    } else {
        await showSetup(page);
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

async function missedPairingRequest(browser) {
    const f = await fixture(browser, { pairingRejected: true });
    try {
        const notice = f.page.getByRole('alert').filter({ hasText: 'An iPhone tried to pair while pairing was not open.' });
        await notice.waitFor();
        await f.page.getByRole('button', { name: 'Start Bluetooth pairing', exact: true }).click();
        await until(() => f.pairingOpen, 'pairing starts from the notice');
        await notice.waitFor({ state: 'detached' });
        await assertClean(f);
        console.log('PASS a pairing request outside the window is explained until pairing starts');
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
        assert.equal(await f.page.locator('.notification-source').getByText('Connected', { exact: true }).count(), 2);
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
    const f = await fixture(browser, { storedSources: ['phone-a', 'removed-phone'], storedReceiver: 'removed-phone', notifications: historyItems() });
    try {
        await openDetails(f.page, 'Choose phones and delivery options');
        const receiver = f.page.getByRole('combobox', { name: 'This app is open on', exact: true });
        await receiver.waitFor();
        assert.equal(await receiver.inputValue(), '', 'removed receiver identity is cleared, matching the visible default');
        assert.equal(await receiver.locator('option:checked').textContent(), 'A different phone, tablet or computer');
        // Each choice is a switch that applies at once, with Undo. No Save button is left.
        const sources = f.page.getByRole('group', { name: 'Get notifications from', exact: true });
        assert.equal(await sources.getByRole('switch').count(), 2);
        await until(() => f.saved.length === 1, 'the subscription is sent on load');
        await sources.getByRole('switch', { name: 'Phone B', exact: true }).check();
        await until(() => f.saved.length === 2, 'the iPhone is added at once');
        assert.deepEqual(f.saved.at(-1).sources, ['phone-a', 'phone-b']);
        const toast = f.page.locator('.kit-toast').filter({ hasText: 'Notification choices saved.' });
        await toast.getByRole('button', { name: 'Undo', exact: true }).waitFor();
        await receiver.selectOption('phone-b');
        await until(() => f.saved.at(-1).receiverSource === 'phone-b', 'the receiver is saved at once');
        assert.deepEqual(f.saved.at(-1).sources, ['phone-a', 'phone-b']);
        // Undo puts back the choice before, on the server and in the list.
        await toast.getByRole('button', { name: 'Undo', exact: true }).click();
        await until(() => f.saved.at(-1).receiverSource === '', 'Undo sends the earlier choice');
        await f.page.waitForFunction(() => document.querySelector('.notification-receiver select').value === '');
        await receiver.selectOption('phone-b');
        await until(() => f.saved.at(-1).receiverSource === 'phone-b', 'chosen again');
        assert.equal(await f.page.getByRole('button', { name: /^Save/ }).count(), 0, 'no Save button is left on Setup');
        assert.equal((await f.page.evaluate(() => window.__notificationFixture)).permissionRequests, 0, 'updating choices does not request permission again');

        await openDetails(f.page, 'Settings for Phone B');
        const settings = f.page.locator('details').filter({ has: f.page.locator('summary').filter({ hasText: 'Settings for Phone B' }) });
        // Turning text off erases stored text, so the box stays ticked until it is confirmed.
        const text = settings.getByRole('switch', { name: 'Include notification text', exact: true });
        await text.click();
        const erase = settings.getByRole('alertdialog', { name: 'Stop storing notification text from Phone B?', exact: true });
        await erase.waitFor();
        assert.match(await erase.textContent(), /The text of its 1 stored notification is erased from the server and cannot be restored\./);
        assert.equal(await text.isChecked(), true, 'the box stays ticked while the prompt is open');
        assert.ok(!f.operations.includes('POST sources'), 'unticking sends nothing by itself');
        await erase.getByRole('button', { name: 'Cancel', exact: true }).click();
        await erase.waitFor({ state: 'detached' });
        assert.ok(!f.operations.includes('POST sources'), 'Cancel sends nothing');
        assert.equal(await text.isChecked(), true);
        await text.click();
        await confirmPrompt(settings, 'Stop storing notification text from Phone B?', 'Erase text');
        await until(() => f.sources.find(s => s.id === 'phone-b')?.preview === false, 'the confirmed change reaches the API');
        await f.page.locator('.kit-toast').filter({ hasText: 'Notification text from Phone B is no longer stored.' }).getByRole('button', { name: 'Undo', exact: true }).waitFor();
        await f.page.waitForFunction(() => ![...document.querySelectorAll('.notifications-page .kit-switch')].every(input => input.checked));
        // Turning it back on loses nothing and applies at once.
        await text.click();
        await until(() => f.sources.find(s => s.id === 'phone-b')?.preview === true, 'ticking the box applies at once');

        // Remove iPhone sits apart from the settings, says what is lost and needs a confirming press.
        const remove = settings.locator('.notification-remove-source').getByRole('button', { name: 'Remove iPhone', exact: true }).and(f.page.locator('.kit-button-danger'));
        await remove.waitFor();
        assert.match(await settings.locator('.notification-remove-source').textContent(), /deletes its link and its 1 stored notification from the server/);
        await remove.click();
        const removal = settings.getByRole('alertdialog', { name: 'Remove Phone B and delete its 1 stored notification?', exact: true });
        await removal.waitFor();
        await f.page.waitForTimeout(300);
        assert.deepEqual(f.removed, [], 'one tap on Remove iPhone sends no request');
        await removal.getByRole('button', { name: 'Cancel', exact: true }).click();
        await removal.waitFor({ state: 'detached' });
        assert.deepEqual(f.removed, [], 'Cancel removes nothing');
        await remove.click();
        await confirmPrompt(settings, 'Remove Phone B and delete its 1 stored notification?', 'Remove iPhone');
        await until(() => f.removed.includes('phone-b'), 'source removal reaches the API');
        assert.deepEqual(f.removed, ['phone-b'], 'the confirmed removal is sent once');
        await f.page.locator('summary').filter({ hasText: 'Settings for Phone B' }).waitFor({ state: 'detached' });
        await openDetails(f.page, 'Choose phones and delivery options');
        assert.equal(await receiver.locator('option:checked').textContent(), 'A different phone, tablet or computer', 'removing the selected receiver restores a visible default option');
        // The removal also takes the iPhone out of this device's choices on the server.
        await f.page.waitForFunction(() => localStorage.getItem('notification-receiver-source') === '');
        assert.deepEqual(f.saved.at(-1).sources, ['phone-a']);
        assert.equal(f.saved.at(-1).receiverSource, '', 'unlinking the receiver clears the persisted identity');
        await f.page.getByRole('button', { name: 'Send test notification', exact: true }).waitFor();
        // Turning delivery off is undone with one tap, so it is not styled as a danger.
        assert.doesNotMatch(await f.page.getByRole('button', { name: 'Turn off on this device', exact: true }).getAttribute('class'), /danger/);
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
        assert.equal(await f.page.getByText('From Phone A', { exact: true }).isVisible(), true);
        await f.page.getByRole('group', { name: 'Get notifications from', exact: true }).getByRole('switch', { name: 'Phone B', exact: true }).check();
        await f.page.getByText('Notification choices saved.', { exact: true }).waitFor();
        await f.page.getByText('From Phone A, Phone B', { exact: true }).waitFor();
        assert.deepEqual(f.saved.at(-1).sources, ['phone-a', 'phone-b']);
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
        await until(() => f.saved.length === 1, 'the subscription is sent on load');
        const phoneB = f.page.getByRole('group', { name: 'Get notifications from', exact: true }).getByRole('switch', { name: 'Phone B', exact: true });
        f.subscriptionError = 'Unable to save these notification choices.';
        await phoneB.click();
        const error = f.page.getByRole('alert').filter({ hasText: f.subscriptionError });
        await error.waitFor();
        // A change the server refuses puts the switch back and says why.
        await f.page.waitForFunction(() => [...document.querySelectorAll('.notification-choices .kit-switch')].filter(input => input.checked).length === 1);
        assert.equal(await phoneB.isChecked(), false, 'the refused change is put back');
        assert.equal(await f.page.getByText('Notification choices saved.', { exact: true }).count(), 0);
        const before = f.statusPolls;
        await until(() => f.statusPolls > before, 'status polling continues after a failed operation');
        assert.equal(await error.isVisible(), true, 'a successful status poll cannot erase an action failure');
        f.subscriptionError = '';
        await phoneB.check();
        await f.page.getByText('Notification choices saved.', { exact: true }).waitFor();
        assert.equal(await error.count(), 0, 'successful retry clears the previous action error');
        assert.equal((await f.page.evaluate(() => window.__notificationFixture)).permissionRequests, 0);
        await assertClean(f);
        console.log('PASS notification action errors survive background polls and clear after a successful retry');
    } finally { await f.context.close(); }
}

/**
 * An iPhone's apps are switches in Setup: a change applies at once with Undo, a refused one is
 * put back with the reason, and an older allow-list reads "Only these apps" with Clear.
 */
async function appMuteList(browser) {
    const sources = phones();
    Object.assign(sources[0], { apps: ['com.example.chat', 'com.example.calendar'], muted: [{ app: 'com.example.games', name: 'Games' }] });
    const items = [...historyItems(), { key: 'a-games', source: 'phone-a', app: 'com.example.games', appName: 'Games', title: 'Level up', body: '', received: Date.now() - 86400000, read: true, dismissed: false, active: false }];
    const f = await fixture(browser, { sources, notifications: items, storedSources: ['phone-a'], storedReceiver: '' });
    const phoneA = () => f.sources.find(s => s.id === 'phone-a');
    const toast = text => f.page.locator('.kit-toast').filter({ hasText: text });
    try {
        await openDetails(f.page, 'Settings for Phone A');
        const settings = f.page.locator('details').filter({ has: f.page.locator('summary').filter({ hasText: 'Settings for Phone A' }) });
        // The older list is named, with the apps it lets through and a way to clear it.
        const only = settings.getByRole('region', { name: 'Only these apps', exact: true });
        await only.waitFor();
        assert.match(await only.textContent(), /An older list is still active\. Only Messages and Calendar come through\./);
        // The apps seen from this iPhone, each with a switch. Nothing is typed and nothing is saved by hand.
        await settings.locator('summary').filter({ hasText: /^Apps/ }).click();
        const list = settings.locator('.notification-app-switches');
        await list.locator('.kit-row').first().waitFor();
        assert.deepEqual(await list.locator('.kit-row-title').allTextContents(), ['Calendar', 'Games', 'Messages']);
        const appSwitch = name => settings.getByRole('switch', { name, exact: true });
        assert.deepEqual(await Promise.all(['Calendar', 'Games', 'Messages'].map(name => appSwitch(name).isChecked())), [true, false, true]);
        assert.equal(await settings.locator('summary').filter({ hasText: /^Apps/ }).locator('.kit-disclosure-note').textContent(), '1 muted');
        assert.equal(await f.page.getByRole('textbox').count(), 0, 'no app identifier is typed');
        assert.equal(await f.page.getByRole('button', { name: /^Save/ }).count(), 0, 'no Save button is left');
        await f.page.waitForFunction(() => document.querySelectorAll('.notification-app-switches .notification-app-icon img').length === 3);
        assert.ok(f.iconRequests.some(url => url.endsWith('/phone-a/com.example.games')), 'the icon of each app is asked for once the list is open');

        // Muting applies at once, with a toast and Undo.
        await appSwitch('Messages').click();
        await until(() => phoneA().muted.some(entry => entry.app === 'com.example.chat'), 'the mute is saved at once');
        assert.deepEqual(phoneA().muted, [{ app: 'com.example.games', name: 'Games' }, { app: 'com.example.chat', name: 'Messages' }]);
        assert.deepEqual(phoneA().apps, ['com.example.chat', 'com.example.calendar'], 'the older list is left as it is');
        await toast('Messages muted.').getByRole('button', { name: 'Undo', exact: true }).waitFor();
        assert.equal(await appSwitch('Messages').isChecked(), false);
        // The iPhone keeps its place in Setup, and the inbox shown without a choice is still its own.
        assert.deepEqual(await f.page.locator('.notification-source-name').allTextContents(), ['Phone A', 'Phone B'], 'a change does not move the iPhone');
        assert.deepEqual(f.sources.map(s => s.id), ['phone-a', 'phone-b']);
        await capture(f, 'setup-apps');
        await toast('Messages muted.').getByRole('button', { name: 'Undo', exact: true }).click();
        await until(() => !phoneA().muted.some(entry => entry.app === 'com.example.chat'), 'Undo unmutes');
        // The switches of Phone A, in the order of the list.
        const states = () => list.evaluate(el => [...el.querySelectorAll('.kit-switch')].map(input => input.checked).join());
        const settled = async (expected, message) => {
            for (const deadline = Date.now() + 8000; (await states()) !== expected && Date.now() < deadline;) await sleep(50);
            assert.equal(await states(), expected, message);
        };
        await settled('true,false,true', 'the switch is on again');

        // A change the server refuses is put back, and the page says why.
        f.sourceError = 'Notifications are off: the settings could not be saved.';
        const posts = f.sourcePosts.length;
        await appSwitch('Calendar').click();
        await f.page.getByRole('alert').filter({ hasText: f.sourceError }).waitFor();
        assert.equal(f.sourcePosts.length, posts + 1);
        await settled('true,false,true', 'the refused mute is put back');
        assert.equal(await appSwitch('Calendar').isChecked(), true);
        assert.equal(await toast('Calendar muted.').count(), 0);
        f.sourceError = '';

        // Clearing the older list applies at once and can be undone.
        await only.getByRole('button', { name: 'Clear the list and use muting', exact: true }).click();
        await until(() => phoneA().apps.length === 0, 'the list is cleared');
        await only.waitFor({ state: 'detached' });
        assert.deepEqual(phoneA().muted, [{ app: 'com.example.games', name: 'Games' }], 'the mute list is kept');
        await toast('The older list was cleared.').getByRole('button', { name: 'Undo', exact: true }).click();
        await until(() => phoneA().apps.length === 2, 'Undo puts the list back');
        await only.waitFor();
        for (const colorScheme of ['light', 'dark']) {
            await f.page.emulateMedia({ colorScheme });
            await settings.screenshot({ path: path.join(SCREENSHOTS, `ws-notifications-setup-apps-${colorScheme}.png`), animations: 'disabled' });
        }

        // With the settings of both iPhones open and a prompt armed, every id is used once and
        // each switch is named by its own row.
        await openDetails(f.page, 'Settings for Phone B');
        const settingsB = f.page.locator('details').filter({ has: f.page.locator('summary').filter({ hasText: 'Settings for Phone B' }) });
        await settingsB.locator('summary').filter({ hasText: /^Apps/ }).click();
        await settingsB.getByRole('switch', { name: 'Mail', exact: true }).waitFor();
        await settingsB.getByRole('button', { name: 'Remove iPhone', exact: true }).click();
        await settingsB.locator('.kit-confirm').waitFor();
        const faults = await f.page.evaluate(() => {
            const found = [];
            const uses = new Map();
            for (const el of document.querySelectorAll('[id]')) uses.set(el.id, (uses.get(el.id) || 0) + 1);
            for (const [id, count] of uses) if (count > 1) found.push(`id ${id} is used ${count} times`);
            for (const input of document.querySelectorAll('.notification-source [role="switch"]')) {
                const row = input.closest('.kit-row');
                for (const id of (input.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
                    if (!row?.contains(document.getElementById(id))) found.push(`a switch is named by #${id} outside its row`);
                }
            }
            return found;
        });
        assert.deepEqual(faults, []);
        await settingsB.getByRole('button', { name: 'Cancel', exact: true }).click();
        await settingsB.locator('.kit-confirm').waitFor({ state: 'detached' });
        assert.deepEqual(f.removed, []);
        await assertClean(f);
        console.log('PASS Setup lists the apps of an iPhone with a switch each; a change applies at once with Undo, a refused one is put back, and an older list reads Only these apps with Clear');
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
    const f = await fixture(browser, { storedSources: ['phone-a'], storedReceiver: '' });
    try {
        // The server drops the subscription after the page has loaded and registered it.
        await until(() => f.saved.length === 1, 'the subscription is registered when the app loads');
        Object.assign(f, { saved: [], operations: [], missingSubscription: true });
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

async function subscriptionRepairedOnLoad(browser) {
    const counters = f => f.page.evaluate(() => window.__notificationFixture);
    // Loading the app sends the subscription again with the saved choices; stale choices are left out.
    let f = await fixture(browser, { storedSources: ['phone-a', 'removed-phone'], storedReceiver: 'removed-phone' });
    try {
        await until(() => f.saved.length === 1, 'the app registers its subscription on load');
        assert.deepEqual(f.saved[0], { subscription, sources: ['phone-a'], receiverSource: '' });
        assert.deepEqual(await counters(f), { permissionRequests: 0, subscribeCalls: 0, unsubscribeCalls: 0 }, 'a subscription for the current key is kept');
        // Delivery is shown for each receiving device, found by the hash of its endpoint.
        const own = crypto.createHash('sha256').update(subscription.endpoint).digest('hex');
        f.receivers = [
            { id: 'a'.repeat(64), provider: 'Google', sent: 3, failed: 2, lastError: 'Push provider rejected delivery (403)' },
            { id: own, provider: 'Apple', sent: 5, failed: 0, lastError: '' },
        ];
        await openDetails(f.page, 'Delivery details');
        const rows = f.page.locator('.notification-receivers li');
        await rows.nth(1).waitFor();
        assert.match(await rows.nth(0).textContent(), /^Other device 1 Google push service · 3 accepted, 2 failedPush provider rejected delivery \(403\)$/);
        assert.match(await rows.nth(1).textContent(), /^This device Apple push service · 5 accepted$/);
        assert.equal(await f.page.getByText('The server has no record of this device', { exact: false }).count(), 0);
        // The server dropped this device while the page was open.
        f.receivers = [f.receivers[0]];
        await f.page.getByRole('alert').filter({ hasText: 'The server has no record of this device, so nothing can be delivered to it.' }).waitFor();
        await assertClean(f);
    } finally { await f.context.close(); }

    // A device that never enabled notifications here sends nothing.
    f = await fixture(browser, {});
    try {
        await sleep(300);
        assert.deepEqual(f.saved, []);
        assert.deepEqual(f.operations, []);
    } finally { await f.context.close(); }

    // The server has new keys (a data reset): the old subscription can never be delivered to.
    f = await fixture(browser, { storedSources: ['phone-a'], storedReceiver: '', subscribedKey: Buffer.alloc(65, 9).toString('base64url') });
    try {
        await until(() => f.saved.length === 1, 'the replacement subscription is registered');
        assert.deepEqual(await counters(f), { permissionRequests: 0, subscribeCalls: 1, unsubscribeCalls: 1 });
        assert.equal(f.saved[0].subscription.endpoint, `${subscription.endpoint}-renewed-1`);
        assert.deepEqual(f.removedEndpoints, [subscription.endpoint], 'the server is told to forget the old endpoint');
        await f.page.getByText('Notifications on', { exact: true }).waitFor();
        // The page uses the replacement from then on.
        await f.page.getByRole('button', { name: 'Send test notification', exact: true }).click();
        await until(() => f.tests.length === 1, 'the test is sent');
        assert.deepEqual(f.tests, [{ endpoint: `${subscription.endpoint}-renewed-1` }]);
        await assertClean(f);
    } finally { await f.context.close(); }

    // The same key again is not a reason to resubscribe.
    f = await fixture(browser, { storedSources: ['phone-a'], storedReceiver: '', subscribedKey: subscription.keys.p256dh });
    try {
        await until(() => f.saved.length === 1, 'the subscription is registered');
        assert.deepEqual(await counters(f), { permissionRequests: 0, subscribeCalls: 0, unsubscribeCalls: 0 });
    } finally { await f.context.close(); }

    // The page says so when the server could not be told.
    f = await fixture(browser, { storedSources: ['phone-a'], storedReceiver: '', subscriptionError: 'Subscription limit reached' });
    try {
        await f.page.getByRole('alert').filter({ hasText: 'This device could not be registered with the server: Subscription limit reached' }).waitFor();
    } finally { await f.context.close(); }
    console.log('PASS the push subscription is registered again on load, replaced when the server key changed, and reported per device');
}

async function subscriptionStateOnReturn(browser) {
    const counters = f => f.page.evaluate(() => window.__notificationFixture);
    const noRecord = f => f.page.getByText('The server has no record of this device', { exact: false });
    // Enabling shows no warning that the server lacks this device while the status catches up.
    let f = await fixture(browser, { registered: false, storedSources: ['phone-a'], storedReceiver: '', receivers: 'saved' });
    try {
        await f.page.getByRole('button', { name: 'Enable on this device', exact: true }).click();
        await f.page.getByText('Notifications enabled on this device.', { exact: true }).waitFor();
        await sleep(300);
        assert.equal(await noRecord(f).count(), 0);
        await openDetails(f.page, 'Delivery details');
        assert.equal(await f.page.locator('.notification-receivers li').filter({ hasText: 'This device' }).count(), 1, 'listed without waiting for the next poll');
        await assertClean(f);
    } finally { await f.context.close(); }

    // Turned off here after the app sent the subscription on load, the page says so after
    // leaving and coming back.
    f = await fixture(browser, { storedSources: ['phone-a'], storedReceiver: '', receivers: 'saved' });
    try {
        await until(() => f.saved.length === 1, 'the subscription is sent on load');
        await openDetails(f.page, 'Choose phones and delivery options');
        await f.page.getByRole('button', { name: 'Turn off on this device', exact: true }).click();
        await f.page.getByRole('button', { name: 'Enable on this device', exact: true }).waitFor();
        await f.page.evaluate(() => { location.hash = '!'; });
        await f.page.locator('#devices').waitFor();
        await f.page.evaluate(() => { location.hash = '!action=notifications'; });
        await showSetup(f.page);
        await f.page.getByText('Notifications off', { exact: true }).waitFor();
        await sleep(300);
        assert.equal(await f.page.getByText('Notifications on', { exact: true }).count(), 0, 'a stale subscription is not shown again');
        await assertClean(f);
    } finally { await f.context.close(); }

    // Safari needs a tap to subscribe. When the server's keys changed, the old subscription is
    // gone and the page asks for that tap instead of showing notifications as on.
    // It opens on the inbox, so no tap happens before the repair runs.
    f = await fixture(browser, { history: true, notifications: historyItems(), storedSources: ['phone-a'], storedReceiver: '', subscribedKey: Buffer.alloc(65, 9).toString('base64url'), subscribeNeedsGesture: true });
    try {
        await until(() => f.removedEndpoints.length === 1, 'the subscription for the old keys is removed');
        await f.page.waitForFunction(() => window.__notificationFixture.subscribeCalls === 1);
        await showSetup(f.page);
        const notice = f.page.getByRole('alert').filter({ hasText: 'Notifications stopped on this device because the server’s keys changed. Tap Enable on this device to turn them on again.' });
        await notice.waitFor();
        await f.page.getByText('Notifications off', { exact: true }).waitFor();
        assert.deepEqual(f.saved, []);
        const enable = f.page.getByRole('button', { name: 'Enable on this device', exact: true });
        assert.equal(await enable.isEnabled(), true);
        await enable.click();
        await f.page.getByText('Notifications enabled on this device.', { exact: true }).waitFor();
        assert.equal(f.saved.at(-1).subscription.endpoint, `${subscription.endpoint}-renewed-1`);
        assert.equal((await counters(f)).subscribeCalls, 2, 'one refused without a tap, one made by the tap');
        await assertClean(f);
    } finally { await f.context.close(); }
    console.log('PASS the page shows the browser’s subscription after a repair, a turn-off and a refused resubscribe');
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

        assert.equal(await shownIphone(f.page), 'Phone A', 'an explicit source shows one sending phone');
        await switchControl(f.page).click();
        const switcher = f.page.getByRole('dialog', { name: 'Switch iPhone', exact: true });
        assert.deepEqual(await switcher.locator('.notification-action-sheet-actions > .kit-button').allTextContents(), ['All iPhones · 3 unread', 'Phone A · 2 unread · Viewing', 'Phone B · 1 unread'], 'the switcher includes the combined feed and counts');
        await switcher.locator('.kit-sheet-close').click();
        await switcher.waitFor({ state: 'detached' });
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
        await segment(f.page, 'Unread').click();
        assert.equal(await article(f.page, 'Coffee at four?').count(), 0, 'read alerts leave the Unread filter');
        await article(f.page, 'Design review').waitFor();
        await toolbarAction(f.page, 'Mark all read');
        await f.page.getByText('No unread notifications', { exact: true }).waitFor();
        assert.deepEqual(f.readRequests.at(-1), { keys: ['a-calendar'], read: true });
        assert.equal(f.notifications.find(n => n.key === 'b-mail').read, false, 'mark all read respects the selected phone');
        assert.equal(await headerBadge(f.page).count(), 0, 'the page badge clears for the selected phone while the PWA badge retains other unread alerts');
        assert.equal(await f.page.evaluate(() => window.__notificationBadges.at(-1)), 1);

        await backControl(f.page).click();
        await f.page.getByRole('heading', { name: 'Phones', exact: true }).waitFor();
        await until(() => f.summaryPolls > 0, 'Devices loads the lightweight unread summary');
        const headerLink = f.page.locator('header.kit-bar-root a[href*=notifications]');
        assert.equal(await headerLink.getAttribute('href'), '#!action=notifications', 'Devices has a Notifications link that does not depend on a card');
        assert.equal(await headerLink.locator('.kit-badge').textContent(), '1', 'the header shows the total unread count');
        const card = id => f.page.locator(`article.device[data-device-key$=":${id}"]`);
        await card('phone-b').locator('.device-notification-history').waitFor();
        assert.equal(await card('phone-a').locator('.kit-badge').count(), 0);
        assert.equal(await card('phone-b').locator('.kit-badge').textContent(), '1');
        // An iPhone that does not send notifications here has no inbox, so its card has no button.
        await card('phone-c').waitFor();
        assert.equal(await card('phone-c').locator('.device-notification-history').count(), 0, 'an unconfigured device offers no inbox');
        await card('phone-b').locator('.device-notification-history').click();
        await f.page.locator('#notification-history-heading').waitFor();
        assert.equal(await shownIphone(f.page), 'Phone B');
        await toolbarAction(f.page, 'Mark all read');
        await f.page.waitForFunction(() => window.__notificationBadges.at(-1) === 0);
        assert.deepEqual(f.readRequests.at(-1), { keys: ['b-mail'], read: true });
        assert.equal(await headerBadge(f.page).count(), 0, 'the unread badge clears when every alert is read');
        await assertClean(f);
        console.log('PASS per-device history shows original icons; read actions update filters, shared counts and Home Screen badge');
    } finally { await f.context.close(); }
}

async function historyFetchedOnChange(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems() });
    try {
        await article(f.page, 'Coffee at four?').waitFor();
        assert.deepEqual(f.historyFetches, [''], 'the history is downloaded once when the page opens');
        const poll = async () => {
            const before = f.statusPolls;
            await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
            await until(() => f.statusPolls > before, 'the page polled the status');
        };
        for (let index = 0; index < 4; index++) await poll();
        await sleep(200);
        assert.equal(f.historyFetches.length, 1, 'polls that find nothing new do not download the history again');
        f.notifications.unshift({ key: 'a-new', source: 'phone-a', app: 'com.example.chat', appName: 'Messages', title: 'Running late', body: 'Ten minutes.', received: Date.now(), read: false, dismissed: false, active: true });
        await poll();
        await article(f.page, 'Running late').waitFor();
        assert.equal(f.historyFetches.length, 2, 'a changed revision fetches the history once');
        assert.match(f.historyFetches[1], /^[0-9a-f]{16}$/, 'the page names the revision it holds');
        assert.equal(await headerBadge(f.page).textContent(), '3');
        await poll();
        await sleep(200);
        assert.equal(f.historyFetches.length, 2);
        await assertClean(f);
        console.log('PASS the status poll carries no history; the history is fetched only when its revision changes');
    } finally { await f.context.close(); }
}

async function dismissKeepsHistory(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), displayedKeys: ['a-chat', 'b-mail'] });
    try {
        await cardAction(f.page, 'Coffee at four?', 'Archive');
        await article(f.page, 'Coffee at four?').waitFor({ state: 'detached' });
        assert.deepEqual(f.dismissed, ['a-chat']);
        assert.equal(await headerBadge(f.page).textContent(), '1');
        assert.deepEqual(await f.page.evaluate(() => window.__closedNotifications), ['a-chat'], 'local dismissal closes only the corresponding received push');
        await segment(f.page, 'Archive').click();
        const old = article(f.page, 'Coffee at four?');
        await old.getByText('Archived', { exact: true }).waitFor();
        assert.equal(await article(f.page, 'Design review').count(), 0, 'Archive shows only archived notifications');
        const archivedMenu = await openCardMenu(f.page, 'Coffee at four?');
        assert.equal(await archivedMenu.getByRole('button', { name: 'Archive', exact: true }).count(), 0);
        await archivedMenu.getByRole('button', { name: 'Move to inbox', exact: true }).click();
        await archivedMenu.waitFor({ state: 'detached' });
        assert.deepEqual(f.restored, [{ key: 'a-chat', read: true }]);
        await article(f.page, 'Coffee at four?').waitFor({ state: 'detached' });
        await segment(f.page, 'Inbox').click();
        await waitRead(f.page, 'Coffee at four?', true);
        assert.equal(f.notifications.length, 3, 'archiving preserves the historical record');
        assert.deepEqual(f.actions, [], 'local dismissal sends no Bluetooth action');
        await assertClean(f);
        console.log('PASS Archive clears the inbox and push and keeps the notification in Archive');
    } finally { await f.context.close(); }
}

async function labeledPhoneActions(browser) {
    const items = historyItems();
    items.push({ key: 'b-call', source: 'phone-b', app: 'com.apple.mobilephone', appName: 'Phone', title: 'Incoming call', body: 'Sam', received: Date.now(), read: false, dismissed: false, active: true, canDismiss: true, negativeActionLabel: 'Decline' });
    items.push({ key: 'b-clear', source: 'phone-b', app: 'com.example.chat', appName: 'Messages', title: 'Clearable alert', body: 'Seen.', received: Date.now() - 30000, read: true, dismissed: false, active: true, canDismiss: true, negativeActionLabel: 'Clear' });
    const f = await fixture(browser, { history: true, notifications: items, source: 'phone-b' });
    try {
        const initial = await openCardMenu(f.page, 'Incoming call');
        const decline = initial.getByRole('button', { name: 'Decline on iPhone', exact: true });
        await decline.waitFor();
        const layout = await initial.evaluate(el => {
            const heading = el.querySelector('.notification-action-sheet-group');
            const local = [...el.querySelectorAll('.notification-action-sheet-actions > button')].find(button => button.textContent === 'Archive');
            const phone = [...el.querySelectorAll('.notification-action-sheet-actions > button')].find(button => button.textContent === 'Decline on iPhone');
            return {
                heading: heading?.textContent, divider: heading ? parseFloat(getComputedStyle(heading).borderTopWidth) : 0,
                order: !!heading && !!local && !!phone && local.getBoundingClientRect().bottom <= heading.getBoundingClientRect().top && heading.getBoundingClientRect().bottom <= phone.getBoundingClientRect().top,
            };
        });
        assert.deepEqual(layout, { heading: 'On Phone B', divider: 1, order: true }, 'phone actions sit under a divider and a heading that names the phone');
        // One tap on Decline sends nothing: it arms a prompt whose buttons are elsewhere.
        await decline.click();
        const prompt = initial.getByRole('alertdialog', { name: 'Decline on Phone B?', exact: true });
        await prompt.waitFor();
        assert.match(await prompt.textContent(), /This runs on the iPhone for “Incoming call” and cannot be undone from here\./);
        const confirmBox = await prompt.getByRole('button', { name: 'Decline', exact: true }).boundingBox();
        const cancelBox = await prompt.getByRole('button', { name: 'Cancel', exact: true }).boundingBox();
        assert.ok(cancelBox.y > confirmBox.y, 'Cancel is the last button in the sheet');
        await f.page.waitForTimeout(300);
        assert.deepEqual(f.actions, [], 'one tap on a phone action other than Clear sends nothing');
        await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
        await prompt.waitFor({ state: 'detached' });
        assert.deepEqual(f.actions, [], 'Cancel sends nothing');
        assert.equal(await initial.getByRole('button', { name: 'Dismiss on iPhone', exact: true }).count(), 0, 'a decline call action is never mislabeled as simple dismissal');
        await initial.locator('.kit-sheet-close').click();
        const stale = await openCardMenu(f.page, 'A message from Alex');
        assert.equal(await stale.getByRole('button', { name: /on iPhone/ }).count(), 0, 'a stale alert has no source action');
        await stale.locator('.kit-sheet-close').click();
        // Closing the sheet disarms it: reopening shows no prompt.
        const armed = await openCardMenu(f.page, 'Incoming call');
        await armed.getByRole('button', { name: 'Decline on iPhone', exact: true }).click();
        await armed.getByRole('alertdialog').waitFor();
        await armed.locator('.kit-sheet-close').click();
        await armed.waitFor({ state: 'detached' });
        const reopened = await openCardMenu(f.page, 'Incoming call');
        assert.equal(await reopened.getByRole('alertdialog').count(), 0, 'closing the sheet disarms the phone action');
        await reopened.locator('.kit-sheet-close').click();
        await reopened.waitFor({ state: 'detached' });
        f.actionError = 'The iPhone disconnected. Reconnect and try again.';
        await confirmedCardAction(f.page, 'Incoming call', 'Decline on iPhone', 'Decline on Phone B?', 'Decline');
        await f.page.getByRole('alert').filter({ hasText: f.actionError }).waitFor();
        assert.deepEqual(f.actions, [{ key: 'b-call', expectedLabel: 'Decline' }]);
        assert.equal(await f.page.locator('.notification-phone-result').count(), 0, 'a refused action is not reported as sent');
        assert.equal(f.notifications.find(n => n.key === 'b-call').dismissed, false);
        assert.equal(await headerBadge(f.page).textContent(), '2', 'failed phone actions leave the selected phone’s history and unread count intact');
        f.actionError = '';
        await confirmedCardAction(f.page, 'Incoming call', 'Decline on iPhone', 'Decline on Phone B?', 'Decline');
        await f.page.locator('.notification-phone-result').getByText('Decline sent to Phone B.', { exact: true }).waitFor();
        // Clear is a plain dismissal: one tap sends it, and the result is reported the same way.
        await cardAction(f.page, 'Clearable alert', 'Clear on iPhone');
        await f.page.locator('.notification-phone-result').getByText('Clear sent to Phone B.', { exact: true }).waitFor();
        assert.deepEqual(f.actions.at(-1), { key: 'b-clear', expectedLabel: 'Clear' });
        const accepted = await openCardMenu(f.page, 'Incoming call');
        const sent = accepted.getByRole('button', { name: 'Action sent', exact: true });
        await sent.waitFor();
        assert.equal(await sent.isDisabled(), true);
        await accepted.locator('.kit-sheet-close').click();
        assert.equal(f.notifications.find(n => n.key === 'b-call').active, true, 'an accepted command is not presented as a confirmed phone removal');
        assert.equal(f.notifications.find(n => n.key === 'b-call').read, false);
        await assertClean(f);
        console.log('PASS phone action menus use the real iOS label, preserve failures, and do not pretend an accepted command removed the alert');
    } finally { await f.context.close(); }
}

async function confirmPromptLayouts(browser) {
    for (const [width, height, label] of [[390, 844, 'phone'], [1280, 800, 'desktop']]) {
        const items = historyItems();
        items.push({ key: 'b-call', source: 'phone-b', app: 'com.apple.mobilephone', appName: 'Phone', title: 'Incoming call', body: 'Sam', received: Date.now(), read: false, dismissed: false, active: true, canDismiss: true, negativeActionLabel: 'Decline' });
        const f = await fixture(browser, { notifications: items, width, height });
        try {
            const measure = scope => scope.evaluate(el => {
                const prompt = el.querySelector('.kit-confirm');
                const box = prompt.getBoundingClientRect();
                return {
                    inside: box.left >= 0 && box.right <= innerWidth,
                    overflow: prompt.scrollWidth > prompt.clientWidth + 1,
                    targets: [...prompt.querySelectorAll('button')].map(button => button.getBoundingClientRect().height),
                };
            });
            const check = (geometry, name) => {
                assert.equal(geometry.inside, true, `${name} prompt stays inside the ${label} viewport`);
                assert.equal(geometry.overflow, false, `${name} prompt does not overflow at ${label} width`);
                assert.ok(geometry.targets.every(target => target >= 44), `${name} prompt keeps 44px targets`);
            };
            await openDetails(f.page, 'Settings for Phone B');
            const source = f.page.locator('article.notification-source').filter({ hasText: 'Phone B' });
            await source.locator('.notification-remove-source').getByRole('button', { name: 'Remove iPhone', exact: true }).click();
            const removal = source.getByRole('alertdialog', { name: 'Remove Phone B and delete its 2 stored notifications?', exact: true });
            await removal.locator(':scope.kit-confirm-danger .kit-confirm-go:not([aria-disabled])').waitFor();
            check(await measure(source), 'Remove iPhone');
            for (const colorScheme of ['light', 'dark']) {
                await f.page.emulateMedia({ colorScheme });
                await source.screenshot({ path: path.join(SCREENSHOTS, `ws-notifications-remove-confirm-${label}-${colorScheme}.png`), animations: 'disabled' });
            }
            await f.page.emulateMedia({ colorScheme: 'light' });
            await source.getByRole('switch', { name: 'Include notification text', exact: true }).click();
            await removal.waitFor({ state: 'detached' });
            await source.getByRole('alertdialog', { name: 'Stop storing notification text from Phone B?', exact: true }).locator(':scope.kit-confirm-danger .kit-confirm-go:not([aria-disabled])').waitFor();
            check(await measure(source), 'Erase text');
            await source.screenshot({ path: path.join(SCREENSHOTS, `ws-notifications-erase-text-confirm-${label}-light.png`), animations: 'disabled' });
            assert.deepEqual(f.removed, []);
            assert.ok(!f.operations.includes('POST sources'), 'arming either prompt sends nothing');

            await showInbox(f.page);
            const params = new URL(f.page.url());
            params.hash = '!action=notifications&source=phone-b';
            await f.page.goto(params.href);
            let sheet = await openCardMenu(f.page, 'Incoming call');
            const decline = sheet.getByRole(width >= 1024 ? 'menuitem' : 'button', { name: 'Decline on iPhone', exact: true });
            const pressed = await decline.boundingBox();
            await decline.click();
            if (width >= 1024) sheet = f.page.getByRole('dialog', { name: 'Phone', exact: true });
            await sheet.locator('.kit-confirm-danger .kit-confirm-go:not([aria-disabled])').waitFor();
            check(await measure(sheet), 'Decline');
            // The sheet grows when the prompt appears. Wherever that moves things, the confirm
            // button must not end up where the first press landed.
            const confirm = await sheet.locator('.kit-confirm-danger .kit-confirm-go').boundingBox();
            assert.ok(
                confirm.y >= pressed.y + pressed.height || confirm.y + confirm.height <= pressed.y,
                `the confirm button is clear of the first press on ${label}: ${JSON.stringify({ pressed, confirm })}`,
            );
            for (const colorScheme of ['light', 'dark']) {
                await f.page.emulateMedia({ colorScheme });
                await f.page.screenshot({ path: path.join(SCREENSHOTS, `ws-notifications-phone-action-confirm-${label}-${colorScheme}.png`), animations: 'disabled' });
            }
            assert.deepEqual(f.actions, []);
            await assertClean(f);
        } finally { await f.context.close(); }
    }
    console.log('PASS confirm prompts fit phone and desktop widths in both themes and send nothing while armed');
}

async function notificationDeepLink(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), source: 'phone-b', notification: 'b-mail', displayedKeys: ['a-chat', 'b-mail'] });
    try {
        await until(() => f.readRequests.length === 1, 'opening a notification marks its one history record read');
        const opened = article(f.page, 'A message from Alex');
        await waitRead(f.page, 'A message from Alex', true);
        assert.match(await opened.getAttribute('class'), /highlighted/);
        assert.equal(await shownIphone(f.page), 'Phone B');
        assert.equal(await article(f.page, 'Coffee at four?').count(), 0);
        assert.deepEqual(f.readRequests, [{ keys: ['b-mail'], read: true }]);
        assert.equal(await headerBadge(f.page).count(), 0);
        assert.equal(await f.page.evaluate(() => window.__notificationBadges.at(-1)), 2);
        assert.deepEqual(await f.page.evaluate(() => window.__closedNotifications), ['b-mail']);
        assert.ok(f.notifications.filter(n => n.source === 'phone-a').every(n => !n.read));
        // The link is used once: the notification's name leaves the address, in the same entry.
        assert.equal(await f.page.evaluate(() => location.hash), '#!action=notifications&source=phone-b');
        assert.equal(await f.page.evaluate(() => history.length), 2, 'the tab has the blank page and this one');
        // A filter chosen afterwards and a reload do not open it again.
        await cardAction(f.page, 'A message from Alex', 'Mark unread');
        await waitRead(f.page, 'A message from Alex', false);
        await segment(f.page, 'Unread').click();
        await f.page.waitForFunction(() => location.hash === '#!action=notifications&source=phone-b&filter=unread');
        await f.page.reload();
        await opened.waitFor();
        await sleep(400);
        assert.equal(await pressed(f.page, 'Unread'), 'true');
        assert.doesNotMatch(await opened.getAttribute('class'), /highlighted/);
        assert.match(await opened.getAttribute('class'), /unread/);
        assert.deepEqual(f.readRequests, [{ keys: ['b-mail'], read: true }, { keys: ['b-mail'], read: false }], 'the notification is not marked read a second time');
        await assertClean(f);
        console.log('PASS notification deep links open the correct phone and mark only the selected alert read, once');
    } finally { await f.context.close(); }
}

async function feedStatusInInbox(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), statuses: { 'phone-a': 'Receiving notifications', 'phone-b': 'Bluetooth disconnected; waiting for iPhone' } });
    try {
        // The bar names the iPhone shown and its link, in the colour of the link's state.
        const state = headerStatus(f.page);
        await f.page.waitForFunction(() => document.querySelector('.notifications-view > .kit-bar .kit-bar-status')?.textContent === 'Phone A · Connected');
        assert.equal(await state.getAttribute('data-tone'), 'success');
        assert.equal(await f.page.locator('.notification-history-source .kit-banner').count(), 0, 'a live feed shows no notice');
        await capture(f, 'feed-connected');
        // The other iPhone lost its Bluetooth link: the bar and a notice say so.
        await switchIphone(f.page, 'Phone B');
        await f.page.waitForFunction(() => document.querySelector('.notifications-view > .kit-bar .kit-bar-status')?.textContent === 'Phone B · Reconnecting');
        assert.equal(await state.getAttribute('data-tone'), 'warning');
        await f.page.getByRole('status').filter({ hasText: 'New notifications from Phone B appear when it reconnects. Bluetooth disconnected; waiting for iPhone.' }).waitFor();
        await capture(f, 'feed-reconnecting');
        // Sharing switched off on the iPhone needs the owner.
        f.statuses['phone-b'] = 'Allow notification sharing in the iPhone Bluetooth settings';
        await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await f.page.waitForFunction(() => document.querySelector('.notifications-view > .kit-bar .kit-bar-status')?.textContent === 'Phone B · Action needed');
        await f.page.getByRole('alert').filter({ hasText: 'Phone B: Allow notification sharing in the iPhone Bluetooth settings.' }).waitFor();
        const colours = await f.page.evaluate(() => {
            const line = document.querySelector('.notifications-view > .kit-bar .kit-bar-status');
            // The error text colour, read from the token through an element that takes it.
            const probe = document.querySelector('.notifications-page').appendChild(document.createElement('span'));
            probe.style.cssText = 'transition: none; color: var(--danger-text)';
            const danger = getComputedStyle(probe).color;
            probe.remove();
            return {
                line: getComputedStyle(line).color,
                tone: line.dataset.tone,
                danger,
                banner: document.querySelectorAll('.notification-history-source .kit-banner-error').length,
            };
        });
        assert.equal(colours.tone, 'error', 'Action needed is the error tone of the bar');
        assert.equal(colours.line, colours.danger, 'Action needed uses the error colour');
        assert.equal(colours.banner, 1, 'and its message is the error banner');
        for (const colorScheme of ['light', 'dark']) {
            await f.page.emulateMedia({ colorScheme });
            await capture(f, `feed-attention-${colorScheme}`);
        }
        await f.page.emulateMedia({ colorScheme: 'light' });
        // A collector failure stops every iPhone's feed.
        f.feedError = 'Bluetooth unavailable: org.bluez.Error.NotReady';
        await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await f.page.getByRole('alert').filter({ hasText: 'Notifications are not being received. Bluetooth unavailable: org.bluez.Error.NotReady.' }).waitFor();
        // Setup uses the same three states.
        await showSetup(f.page);
        const badge = id => f.page.locator('.notification-source').filter({ has: f.page.getByRole('heading', { name: id, exact: true }) }).locator('.notification-badge');
        await badge('Phone B').getByText('Action needed', { exact: true }).waitFor();
        assert.equal(await badge('Phone A').textContent(), 'Connected');
        f.statuses['phone-b'] = 'Authorizing notifications';
        await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await badge('Phone B').getByText('Reconnecting', { exact: true }).waitFor();
        assert.equal(await f.page.getByText('Connecting…', { exact: true }).count(), 0);
        await assertClean(f);
        console.log('PASS the inbox shows whether each iPhone is connected, reconnecting or needs action, and when the feed has failed');
    } finally { await f.context.close(); }
}

async function openScreenFromInbox(browser) {
    // Both links name the phone's page in its current form, on this server.
    const screenHash = '#!action=device&udid=phone-a&view=screen';
    const screenHref = new URL(screenHash, BASE).href;
    // The iPhones are connected by USB.
    let f = await fixture(browser, { history: true, notifications: historyItems(), devices: true });
    try {
        // The list's actions start with it, as each card's do.
        const actions = await openToolbar(f.page);
        const link = actions.locator('.notification-action-sheet-actions > :first-child');
        assert.equal(await link.textContent(), 'Open iPhone screen');
        assert.equal(await link.evaluate(el => el.href), screenHref);
        await actions.locator('.kit-sheet-close').click();
        await actions.waitFor({ state: 'detached' });
        assert.equal(await f.page.locator(HEADER).getByText(/Open/).count(), 0, 'the bar holds no screen link');
        const sheet = await openCardMenu(f.page, 'Coffee at four?');
        const first = sheet.locator('.notification-action-sheet-actions > :first-child');
        assert.equal(await first.textContent(), 'Open iPhone screen');
        assert.equal(await first.evaluate(el => el.href), screenHref);
        await sheet.locator('.kit-sheet-close').click();
        await sheet.waitFor({ state: 'detached' });
        // A touch double tap does nothing; Enter on the focused card opens the screen.
        const card = article(f.page, 'Coffee at four?');
        await card.evaluate(el => {
            el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', isPrimary: true }));
            el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });
        await sleep(200);
        assert.match(f.page.url(), /action=notifications/);
        await card.focus();
        await f.page.keyboard.press('Enter');
        await f.page.waitForFunction(hash => location.hash === hash, screenHash);
        // The iPhone's screen links back to its notifications, with the unread count.
        const back = f.page.locator('.kit-bar .notifications-link');
        await back.waitFor();
        assert.equal(await back.getAttribute('href'), '#!action=notifications&source=phone-a');
        await f.page.waitForFunction(() => document.querySelector('.kit-bar .notifications-link')?.getAttribute('aria-label') === 'Notifications, 1 unread');
        assert.equal(await back.locator('.kit-badge').textContent(), '1');
        await back.click();
        await f.page.locator('#notification-history-heading').waitFor();
        // A mouse double-click on a card opens it too.
        await article(f.page, 'Design review').locator('h3').dblclick();
        await f.page.waitForFunction(hash => location.hash === hash, screenHash);
        assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }

    // Not in the device list: the button says why it is off, and Enter explains instead.
    f = await fixture(browser, { history: true, notifications: historyItems() });
    try {
        const actions = await openToolbar(f.page);
        const button = actions.getByRole('button', { name: /^Open iPhone screen/ });
        assert.equal(await button.isDisabled(), true);
        const reason = 'Phone A is not connected to the NUC by USB.';
        assert.equal(await f.page.locator(`#${await button.getAttribute('aria-describedby')}`).textContent(), reason);
        await actions.locator('.kit-sheet-close').click();
        await actions.waitFor({ state: 'detached' });
        await article(f.page, 'Coffee at four?').focus();
        await f.page.keyboard.press('Enter');
        await f.page.locator('.notification-failure').getByText(reason, { exact: true }).waitFor();
        assert.match(f.page.url(), /action=notifications/);
        const sheet = await openCardMenu(f.page, 'Coffee at four?');
        const item = sheet.getByRole('button', { name: /^Open iPhone screen/ });
        assert.equal(await item.isDisabled(), true);
        assert.equal(await item.textContent(), 'Open iPhone screen');
        assert.equal(await sheet.locator(`#${await item.getAttribute('aria-describedby')}`).textContent(), reason);
        await sheet.locator('.kit-sheet-close').click();
        await assertClean(f);
    } finally { await f.context.close(); }
    console.log('PASS the iPhone screen opens from the list actions, a card menu, Enter or a double-click, and links back with the unread count');
}

async function deepLinkScrollsAndFades(browser) {
    // Newest first, as the server sends them: the opened one has twelve newer ones above it and
    // twelve older ones below, so it can be brought to the middle.
    const mail = historyItems()[2];
    const around = (prefix, from) => Array.from({ length: 12 }, (_, i) => ({ ...mail, key: `b-${prefix}-${i}`, title: `${prefix} ${i + 1}`, received: mail.received + from - i * 1000 }));
    const items = [...historyItems().slice(0, 2), ...around('Newer', 60000), mail, ...around('Older', -1000)];
    const f = await fixture(browser, { history: true, notifications: items, source: 'phone-b', notification: 'b-mail' });
    try {
        const card = article(f.page, 'A message from Alex');
        await f.page.waitForFunction(() => document.querySelector('article.notification-history-item.highlighted'));
        const box = await card.evaluate(el => { const rect = el.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, middle: (rect.top + rect.bottom) / 2, height: innerHeight }; });
        assert.ok(box.top >= 0 && box.bottom <= box.height, `the opened notification is on screen: ${JSON.stringify(box)}`);
        assert.ok(Math.abs(box.middle - box.height / 2) < box.height / 4, `and near the middle: ${JSON.stringify(box)}`);
        await sleep(4600);
        assert.doesNotMatch(await card.getAttribute('class'), /highlighted/, 'the outline fades after a few seconds');
        await assertClean(f);
        console.log('PASS a notification opened from a push is scrolled to the middle and its outline fades');
    } finally { await f.context.close(); }
}

async function unlinkedDeepLink(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), devices: true });
    try {
        await backControl(f.page).click();
        await f.page.getByRole('heading', { name: 'Phones', exact: true }).waitFor();
        const card = id => f.page.locator(`article.device[data-device-key$=":${id}"]`);
        await card('phone-a').locator('.device-notification-history').waitFor();
        // The card of an unlinked iPhone has no inbox button; a link that names it opens setup.
        await card('phone-c').waitFor();
        assert.equal(await card('phone-c').locator('.device-notification-history').count(), 0, 'an unlinked iPhone has no inbox button');
        await f.page.evaluate(() => { location.hash = '#!action=notifications&source=phone-c'; });
        await f.page.getByRole('heading', { name: 'Send from an iPhone', exact: true }).waitFor();
        const add = f.page.locator('details.notification-pairing');
        await f.page.waitForFunction(() => document.querySelector('details.notification-pairing')?.open);
        await add.getByText('Phone C is not linked yet. Follow these steps to receive its notifications.', { exact: true }).waitFor();
        assert.equal(await add.getByRole('combobox', { name: 'iPhone connected to the NUC by USB', exact: true }).inputValue(), 'phone-c');
        assert.equal(await f.page.getByText('Connect an iPhone to receive its', { exact: false }).count(), 0);
        await capture(f, 'unlinked-source');
        // The inbox stays open for the linked iPhones: Setup in the bar goes back to it.
        assert.equal(await setupShown(f.page), 'true');
        assert.equal(await setupControl(f.page).isEnabled(), true);
        await setupControl(f.page).click();
        await f.page.locator('#notification-history-heading').waitFor();
        assert.equal(await shownIphone(f.page), 'All iPhones');
        assert.doesNotMatch(f.page.url(), /phone-c/);
        await article(f.page, 'Coffee at four?').waitFor();
        await assertClean(f);
        console.log('PASS an unlinked iPhone opens the linking steps while the inbox stays open for the linked ones');
    } finally { await f.context.close(); }
}

/** A link to an iPhone that is not linked opens Setup, and the page stays there once it is linked. */
async function linkingStaysOnSetup(browser) {
    const bluetooth = [{ address: 'AA:BB:CC:DD:EE:0C', name: 'Phone C', paired: true, connected: true }];
    const f = await fixture(browser, { history: true, notifications: historyItems(), devices: true, bluetooth });
    try {
        await article(f.page, 'Coffee at four?').waitFor();
        await f.page.evaluate(() => { location.hash = '#!action=notifications&source=phone-c'; });
        await f.page.getByRole('heading', { name: 'Send from an iPhone', exact: true }).waitFor();
        // The address names the panel that is shown, in the entry the link made.
        await f.page.waitForFunction(() => location.hash === '#!action=notifications&source=phone-c&panel=setup');
        const entries = await f.page.evaluate(() => history.length);
        const add = f.page.locator('details.notification-pairing');
        await f.page.waitForFunction(() => document.querySelector('details.notification-pairing')?.open);
        assert.equal(await add.getByRole('combobox', { name: 'iPhone connected to the NUC by USB', exact: true }).inputValue(), 'phone-c');
        await add.getByRole('combobox', { name: 'The same iPhone in Bluetooth', exact: true }).selectOption('AA:BB:CC:DD:EE:0C');
        await add.getByRole('button', { name: 'Use this iPhone', exact: true }).click();
        await f.page.getByText('iPhone connected. Now enable notifications on the device receiving them.', { exact: true }).waitFor();
        assert.ok(f.sources.some(source => source.id === 'phone-c'), 'the iPhone is linked');
        await sleep(300);
        // The next step, receiving on this device, is on Setup.
        assert.equal(await setupShown(f.page), 'true', 'the page stays on Setup once the iPhone is linked');
        assert.equal(await f.page.locator('#notification-history-heading').count(), 0);
        assert.equal(await f.page.evaluate(() => location.hash), '#!action=notifications&source=phone-c&panel=setup');
        // A reload stays there too, and its inbox is one press away.
        await f.page.reload();
        await f.page.getByRole('heading', { name: 'Send from an iPhone', exact: true }).waitFor();
        assert.equal(await setupShown(f.page), 'true');
        await showInbox(f.page);
        assert.equal(await shownIphone(f.page), 'Phone C');
        await f.page.waitForFunction(() => location.hash === '#!action=notifications&source=phone-c');
        assert.equal(await f.page.evaluate(() => history.length), entries, 'no history entry was added');
        await assertClean(f);
        console.log('PASS a link to an iPhone that is not linked opens Setup, and the page stays on Setup once it is linked');
    } finally { await f.context.close(); }
}

async function phoneActionsOutlastDefaultTimeout(browser) {
    // The server may wait 15 s for the iPhone on one action and work 30 s on a bulk one.
    const items = historyItems();
    items[1].canDismiss = true; items[1].negativeActionLabel = 'Clear';
    const f = await fixture(browser, { history: true, notifications: items, clock: true });
    try {
        f.holdNextMutation = true;
        await cardAction(f.page, 'Coffee at four?', 'Clear on iPhone');
        await until(() => !!f.releaseMutation, 'the fixture holds the action');
        await f.page.clock.fastForward(16000);
        assert.equal(await f.page.locator('.notification-failure').count(), 0, 'no failure while the server is still working');
        f.releaseMutation();
        await f.page.locator('.notification-phone-result').getByText('Clear sent to Phone A.', { exact: true }).waitFor();

        f.holdNextMutation = true;
        await confirmBulk(f.page, 'Clear all on iPhone', true);
        await until(() => !!f.releaseMutation, 'the fixture holds the bulk action');
        await f.page.clock.fastForward(31000);
        assert.equal(await f.page.locator('.notification-failure').count(), 0, 'no failure while the bulk action runs');
        assert.equal(await f.page.getByRole('status').filter({ hasText: 'Clearing on Phone A…' }).count(), 1);
        f.releaseMutation();
        await f.page.locator('.notification-phone-result').getByText('Clear sent to Phone A for 1 notification.', { exact: true }).waitFor();
        await assertClean(f);
        console.log('PASS phone actions wait as long as the server may take');
    } finally { if (f.releaseMutation) f.releaseMutation(); await f.context.close(); }
}

async function confirmBulk(page, buttonName, accept, beforeAnswer) {
    const sheet = await openToolbar(page);
    const button = sheet.getByRole('button', { name: buttonName });
    await button.click();
    // The confirm prompt opens in the same sheet; its button ignores presses for the first 500 ms.
    const dialog = sheet.getByRole('alertdialog', { name: /^Clear \d+ notifications? on / });
    await dialog.waitFor();
    const message = await dialog.innerText();
    if (beforeAnswer) beforeAnswer(message);
    if (accept) {
        await dialog.locator('.kit-confirm-actions > .kit-button:not([aria-disabled])').first().waitFor();
        await dialog.getByRole('button', { name: 'Clear on iPhone', exact: true }).click();
    } else {
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        await sheet.locator('.kit-sheet-close').click();
    }
    await sheet.waitFor({ state: 'detached' });
    return message;
}

async function bulkArchiveAndUndo(browser) {
    const items = historyItems();
    for (let i = 0; i < 26; i++) items.push({ ...items[1], key: `a-older-${i}`, title: `Older alert ${i + 1}`, received: Date.now() - 180000 - i * 1000, read: i % 2 === 0 });
    const phoneA = items.filter(n => n.source === 'phone-a');
    const states = list => list.map(n => [n.key, n.read]).sort();
    const f = await fixture(browser, { history: true, notifications: items, source: 'phone-a', displayedKeys: ['a-chat', 'b-mail', 'a-older-25'] });
    try {
        const sheet = await openToolbar(f.page);
        // Not seen by the page yet: it must not join the set taken when Archive all is pressed.
        f.notifications.unshift({ ...historyItems()[0], key: 'a-arrived-after', title: 'Arrived after the tap' });
        await sheet.getByRole('button', { name: 'Archive all', exact: true }).click();
        await sheet.waitFor({ state: 'detached' });
        assert.equal(await f.page.getByRole('alertdialog').count(), 0, 'archiving here asks for no confirmation');
        await until(() => f.bulkDismissed.length === 1, 'the bulk archive reaches the API');
        await article(f.page, 'Arrived after the tap').waitFor();
        assert.equal(f.bulkDismissed[0].source, 'phone-a');
        assert.deepEqual([...f.bulkDismissed[0].keys].sort(), phoneA.map(n => n.key).sort(), 'the snapshot includes older unrendered notifications and leaves out later arrivals');
        assert.equal(f.notifications.find(n => n.key === 'b-mail').dismissed, false, 'archiving cannot touch another phone');
        assert.equal(f.notifications.find(n => n.key === 'a-arrived-after').dismissed, false);
        assert.equal(f.notifications.length, 30, 'history survives archiving');
        assert.deepEqual((await f.page.evaluate(() => window.__closedNotifications)).sort(), ['a-chat', 'a-older-25']);
        assert.equal(await headerBadge(f.page).textContent(), '1');
        assert.equal(await f.page.evaluate(() => window.__notificationBadges.at(-1)), 2);
        // Undo, as for one notification: every one comes back with the read state it had.
        const undo = f.page.locator('.notification-undo');
        await undo.getByText('Archived 28 notifications from Phone A', { exact: true }).waitFor();
        await undo.getByRole('button', { name: 'Undo', exact: true }).click();
        await until(() => f.bulkRestored.length === 1, 'Undo reaches the API');
        assert.equal(f.bulkRestored[0].source, 'phone-a');
        assert.deepEqual(states(f.bulkRestored[0].items), states(phoneA));
        await article(f.page, 'Coffee at four?').waitFor();
        await f.page.waitForFunction(() => document.querySelector('.notifications-view > .kit-bar .notification-unread-count')?.textContent === '16');
        // Mark all read can be undone too.
        await toolbarAction(f.page, 'Mark all read');
        await undo.getByText('Marked 16 notifications read', { exact: true }).waitFor();
        const marked = f.readRequests.at(-1);
        assert.equal(marked.keys.length, 16);
        await undo.getByRole('button', { name: 'Undo', exact: true }).click();
        await until(() => f.readRequests.length === 2, 'Undo of Mark all read reaches the API');
        assert.deepEqual(f.readRequests.at(-1), { keys: marked.keys, read: false });
        await f.page.waitForFunction(() => document.querySelector('.notifications-view > .kit-bar .notification-unread-count')?.textContent === '16');
        await segment(f.page, 'Archive').click();
        await f.page.getByText('No archived notifications', { exact: true }).waitFor();
        await assertClean(f);
        console.log('PASS Archive all and Mark all read act on a per-phone snapshot at once and can be undone');
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
        const button = 'Clear all on iPhone';
        // The confirmation says what happens on the iPhone and here, starts on Cancel, and
        // its confirm button is filled red in both themes.
        for (const colorScheme of ['light', 'dark']) {
            await f.page.emulateMedia({ colorScheme });
            const sheet = await openToolbar(f.page);
            await sheet.getByRole('button', { name: button, exact: true }).click();
            const prompt = sheet.getByRole('alertdialog', { name: 'Clear 2 notifications on Phone A?', exact: true });
            await prompt.waitFor();
            assert.match(await prompt.textContent(), /They are removed from the iPhone and cannot be brought back there\. They stay here, marked as read\./);
            const look = await prompt.evaluate(el => {
                const [confirm, cancel] = el.querySelectorAll('.kit-confirm-actions > .kit-button');
                const rgb = value => value.match(/\d+/g).slice(0, 3).map(Number);
                return { focus: document.activeElement === cancel, confirm: rgb(getComputedStyle(confirm).backgroundColor), cancel: getComputedStyle(cancel).backgroundColor, text: getComputedStyle(confirm).color, label: confirm.textContent };
            });
            assert.equal(look.focus, true, 'focus starts on Cancel');
            assert.equal(look.label, 'Clear on iPhone');
            assert.ok(look.confirm[0] > 150 && look.confirm[1] < 80 && look.confirm[2] < 80, `the confirm button is red in ${colorScheme}: ${look.confirm}`);
            assert.notEqual(look.cancel, `rgb(${look.confirm.join(', ')})`);
            assert.equal(look.text, 'rgb(255, 255, 255)');
            await f.page.screenshot({ path: path.join(SCREENSHOTS, `ws-notifications-bulk-confirm-${colorScheme}.png`), animations: 'disabled' });
            await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
            await prompt.waitFor({ state: 'detached' });
            await sheet.locator('.kit-sheet-close').click();
            await sheet.waitFor({ state: 'detached' });
        }
        await f.page.emulateMedia({ colorScheme: 'light' });
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
        await sentMenu.locator('.kit-sheet-close').click();
        assert.deepEqual(f.bulkActions, [{ source: 'phone-a', items: [{ key: 'a-chat', expectedLabel: 'Clear' }, { key: 'a-calendar', expectedLabel: 'Dismiss notification' }] }], 'bulk phone dismissal excludes Decline calls, stale alerts, other phones, and new arrivals');
        const retryMenu = await openCardMenu(f.page, 'Design review');
        assert.equal(await retryMenu.getByRole('button', { name: 'Dismiss notification on iPhone', exact: true }).isEnabled(), true, 'a failed member remains retryable');
        await retryMenu.locator('.kit-sheet-close').click();
        const callMenu = await openCardMenu(f.page, 'Incoming call');
        assert.equal(await callMenu.getByRole('button', { name: 'Decline on iPhone', exact: true }).isEnabled(), true, 'other phone actions remain individual and explicit');
        await callMenu.locator('.kit-sheet-close').click();
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
        assert.equal(await switchControl(f.page).count(), 0, 'a single iPhone needs no switcher');
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

// Chromium offsets a sticky child by the scroll container's own padding-top, so the search bar used to stop
// 12 px (phone) or 20 px (desktop) below the scrollport edge with a strip of list items visible above it.
const stickyFixtureItems = () => Array.from({ length: 25 }, (_, i) => ({
    key: `a-sticky-${i}`, source: 'phone-a', app: 'com.example.chat', appName: 'Messages', title: `Message ${i + 1}`,
    body: 'Long inbox fixture item.', received: Date.now() - i * 60000, read: false, dismissed: false, active: true, canDismiss: true, negativeActionLabel: 'Clear',
}));
async function measureSticky(page, selector) {
    await page.locator('main').evaluate(el => { el.scrollTop = 900; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.evaluate(selector => {
        const main = document.querySelector('main.notifications-page');
        const bar = document.querySelector(selector);
        const mainTop = main.getBoundingClientRect().top;
        const barTop = bar.getBoundingClientRect().top;
        const itemsAbove = [...document.querySelectorAll('.notification-history-item')].filter(item => {
            const rect = item.getBoundingClientRect();
            return Math.min(rect.bottom, barTop) - Math.max(rect.top, mainTop) > 1;
        }).length;
        return { scrollTop: main.scrollTop, mainTop, barTop, gap: barTop - mainTop, itemsAbove };
    }, selector);
}
async function stickyBarsReachScrollTop(browser) {
    for (const [width, height] of [[390, 844], [1280, 900]]) {
        const f = await fixture(browser, { history: true, notifications: stickyFixtureItems(), width, height });
        try {
            await article(f.page, 'Message 25').waitFor();
            const padding = await f.page.evaluate(() => [
                getComputedStyle(document.querySelector('main.notifications-page')).paddingTop,
                getComputedStyle(document.querySelector('.notification-page-header')).paddingTop,
            ]);
            // In the inbox the sticky bar's own padding is the space under the page's bar: all of
            // it on a phone, and 8 of the 12 px from 600 px.
            assert.deepEqual(padding, ['0px', width <= 420 ? '0px' : '4px'], `the block at the top of the page, not the scroller, carries the top padding at ${width} px`);
            const tools = await measureSticky(f.page, '.notification-history-tools');
            if (width === 390) {
                await fs.mkdir(OUT, { recursive: true });
                await f.page.screenshot({ path: path.join(OUT, 'notifications-sticky-tools-390.png'), animations: 'disabled' });
            }
            assert.ok(tools.scrollTop >= 900, `the inbox scrolls by 900 px at ${width} px (got ${tools.scrollTop})`);
            assert.ok(Math.abs(tools.gap) <= 1, `the search bar sits at the scrollport top at ${width} px (gap ${tools.gap} px)`);
            assert.equal(tools.itemsAbove, 0, `no list item shows above the search bar at ${width} px`);
            // A failed action is reported at the bottom of the screen, above the list, with Retry.
            f.dismissError = 'Could not dismiss. Try again.';
            await cardAction(f.page, 'Message 20', 'Archive');
            const failure = f.page.locator('.notification-failure[role="alert"]').filter({ hasText: f.dismissError });
            await failure.waitFor();
            await settleMotion(f.page);
            assert.ok(await f.page.locator('main').evaluate(el => el.scrollTop > 400), 'the list is scrolled down');
            const covered = await failure.evaluate(el => {
                const box = el.getBoundingClientRect();
                const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                return { inside: box.top >= 0 && box.bottom <= innerHeight, onTop: el.contains(top) };
            });
            assert.deepEqual(covered, { inside: true, onTop: true }, `the failure stays visible after scrolling at ${width} px`);
            if (width === 390) {
                await f.page.screenshot({ path: path.join(OUT, 'notifications-failure-390.png'), animations: 'disabled' });
            }
            f.dismissError = '';
            await failure.getByRole('button', { name: 'Retry', exact: true }).click();
            await until(() => f.dismissed.includes('a-sticky-19'), 'Retry repeats the action');
            await failure.waitFor({ state: 'detached' });
            await f.page.locator('.notification-undo').getByText('Archived', { exact: true }).waitFor();
            // A lost connection is shown inside the search bar, so scrolling cannot hide it.
            f.statusError = 'Bad gateway';
            await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
            const lost = f.page.locator('.notification-history-tools [role="alert"]').filter({ hasText: 'Connection interrupted.' });
            await lost.waitFor();
            await settleMotion(f.page);
            const notice = await measureSticky(f.page, '.notification-history-tools');
            assert.ok(Math.abs(notice.gap) <= 1, `the search bar and its notice sit at the scrollport top at ${width} px (gap ${notice.gap} px)`);
            assert.equal(await lost.evaluate(el => { const box = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(box.left + 10, box.top + box.height / 2)); }), true, 'nothing covers the connection notice');
            f.statusError = '';
            await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
            await lost.waitFor({ state: 'detached' });
            f.dismissError = '';
            await assertClean(f);
            console.log(`PASS sticky search bar and connection notice reach the scrollport top, and failures stay visible, at ${width}x${height}`);
        } finally { await f.context.close(); }
    }
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
        const geometry = await sheet.locator('.kit-sheet-panel').evaluate(el => ({ height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width, viewportHeight: innerHeight, viewportWidth: innerWidth, targets: [...el.querySelectorAll('button')].map(button => button.getBoundingClientRect().height) }));
        assert.ok(geometry.height <= geometry.viewportHeight * .75 + 1);
        assert.ok(geometry.width <= geometry.viewportWidth);
        assert.ok(geometry.targets.every(height => height >= 44));
        await capture(f, `menu-${browserName}-320`);
        await f.page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
        await capture(f, `menu-${browserName}-dark`);
        await sheet.locator('.kit-sheet-close').click();
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
        const search = await searchField(f.page);
        await search.fill('CAFE station');
        await article(f.page, 'Café plans').waitFor();
        assert.equal(await article(f.page, 'Design review').count(), 0, 'all search tokens match across title/body, ignoring case and accents');
        await search.fill('');
        await setAppFilter(f.page, 'com.example.calendar');
        await article(f.page, 'Design review').waitFor();
        assert.equal(await article(f.page, 'Café plans').count(), 0);
        await search.fill('station');
        assert.equal(await f.page.locator('article.notification-history-item').count(), 0, 'app and text filters combine');
        await segment(f.page, 'Unread').click();
        await f.page.evaluate(() => { location.hash = '!action=notifications&source=phone-b&notification=b-mail'; });
        await waitRead(f.page, 'A message from Alex', true);
        assert.equal(await search.inputValue(), '', 'opening a specific alert resets stale search text');
        assert.equal(await pressed(f.page, 'Inbox'), 'true');
        await f.page.getByRole('button', { name: /^Filters/ }).click();
        const sheet = f.page.getByRole('dialog', { name: 'Filter notifications', exact: true });
        assert.equal(await sheet.getByRole('combobox', { name: 'App', exact: true }).inputValue(), '', 'source/deep-link changes clear the app filter');
        await sheet.locator('.kit-sheet-close').click();
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
        await (await searchField(f.page)).fill('family');
        await setAppFilter(f.page, 'com.example.chat');
        await segment(f.page, 'Unread').click();
        await article(f.page, 'Family dinner').waitFor();
        assert.equal(await f.page.locator('article.notification-history-item').count(), 1);
        const sheet = await openToolbar(f.page);
        assert.equal(await sheet.getByText('1 notification in this view.', { exact: true }).count(), 1);
        await sheet.getByRole('button', { name: 'Archive all', exact: true }).click();
        await until(() => f.bulkDismissed.length === 1, 'filtered bulk request arrives');
        assert.deepEqual(f.bulkDismissed, [{ source: 'phone-a', keys: ['a-chat'] }]);
        assert.ok(f.notifications.filter(n => n.key !== 'a-chat').every(n => !n.dismissed), 'hidden app/status/source records are untouched');
        await assertClean(f);
        console.log('PASS Archive all respects combined search, app, status and device filters');
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
        await cardAction(f.page, 'Coffee at four?', 'Archive');
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
        await switchIphone(f.page, 'Phone A');
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

const manyItems = () => [
    ...Array.from({ length: 60 }, (_, i) => ({
        ...stickyFixtureItems()[0], key: `a-many-${i}`, title: `Message ${i + 1}`, received: Date.now() - i * 60000,
        ...(i % 2 ? {} : { app: 'com.example.mail', appName: 'Mail' }),
    })),
    historyItems()[2],
];

/** The page header is the shared one, and its back control ends on the list without a new entry. */
async function sharedHeader(browser) {
    for (const [width, height] of [[390, 844], [1280, 800]]) {
        const f = await fixture(browser, { history: true, notifications: manyItems(), devices: true, width, height });
        const { page } = f;
        try {
            await article(page, 'Message 1').waitFor();
            const header = page.locator(HEADER);
            assert.equal(await header.locator('h1.kit-bar-name').textContent(), 'Notifications');
            assert.equal(await backControl(page).getAttribute('title'), 'Phones');
            assert.equal(await page.getByRole('link', { name: /Devices/ }).count(), 0, 'the link that added a history entry is gone');
            assert.equal(await headerBadge(page).textContent(), '60');
            // One row: back, the title with the iPhone shown and its unread count in words, Switch
            // (two iPhones are linked), Search and Setup, all on one line. No count stands alone.
            const row = await header.evaluate(el => [...el.children].map(child => {
                const box = child.getBoundingClientRect();
                return { name: child.getAttribute('aria-label') || child.textContent.trim(), top: Math.round(box.top), bottom: Math.round(box.bottom) };
            }));
            assert.deepEqual(row.map(item => item.name), ['Phones', 'NotificationsPhone A · Connected · 60 unread', 'Switch iPhone', 'Search', 'Setup']);
            assert.ok(row.every(item => item.top >= 0 && item.bottom <= 61 && item.top < row[0].bottom), `one row at ${width} px: ${JSON.stringify(row)}`);
            const firstCard = await article(page, 'Message 1').evaluate(el => el.getBoundingClientRect().top);
            // The bar, 8 px, the filter row, 8 px and the day label: 16 px lower than at f734c43.
            if (width === 390) assert.ok(firstCard <= 146, `the first notification starts within 146 px of the top (${firstCard})`);
            // The header stays in place and the page scrolls under it.
            await page.locator('main').evaluate(el => { el.scrollTop = 900; });
            const bar = await header.boundingBox();
            const main = await page.locator('main.notifications-page').boundingBox();
            assert.deepEqual([bar.x, bar.y, bar.width], [0, 0, width], `the header spans the top at ${width} px`);
            assert.equal(main.y, bar.height, 'the page starts under the header');
            assert.ok(Math.abs(main.y + main.height - height) <= 1, 'and ends at the bottom of the window');
            await fs.mkdir(OUT, { recursive: true });
            for (const colorScheme of ['light', 'dark']) {
                await page.emulateMedia({ colorScheme });
                await page.locator('main').evaluate(el => { el.scrollTop = 0; });
                await page.screenshot({ path: path.join(OUT, `notifications-header-${width}-${colorScheme}.png`), animations: 'disabled' });
                await showSetup(page);
                await settleMotion(page);
                assert.equal(await headerStatus(page).textContent(), 'Setup & delivery');
                await page.screenshot({ path: path.join(OUT, `notifications-header-setup-${width}-${colorScheme}.png`), animations: 'disabled' });
                await showInbox(page);
                await article(page, 'Message 1').waitFor();
                await settleMotion(page);
            }
            await page.emulateMedia({ colorScheme: 'light' });
            await assertClean(f);

            // To the list, to the inbox again, and from there to the iPhone's screen.
            await backControl(page).click();
            await page.locator('#devices').waitFor();
            assert.equal(await page.evaluate(() => location.hash), '#!');
            await page.locator('header.kit-bar-root .notifications-link').click();
            await article(page, 'Message 1').waitFor();
            await switchIphone(page, 'Phone A');
            await (await openToolbar(page)).getByRole('link', { name: 'Open iPhone screen', exact: true }).click();
            await page.locator('.stream-view').waitFor();
            await sleep(350);
            assert.deepEqual(f.streams, ['phone-a'], 'one stream socket for the open');
            // From the phone's screen: the bell, then the back control of Notifications.
            await page.locator('.kit-bar .notifications-link').click();
            await article(page, 'Message 1').waitFor();
            const entries = await page.evaluate(() => history.length);
            await backControl(page).click();
            await page.locator('#devices').waitFor();
            assert.equal(await page.evaluate(() => history.length), entries, 'the back control adds no entry');
            assert.equal(await page.evaluate(() => history.state.nav.index), 0, 'it goes back to the list entry the tab already had');
            // Back from the list leaves the app. It does not show the phone's screen again.
            await page.goBack().catch(() => undefined);
            await sleep(300);
            assert.ok(!page.url().startsWith(BASE), `Back from the list leaves the app (${page.url()})`);
            assert.deepEqual(f.streams, ['phone-a'], 'Back started no stream');
            assert.deepEqual(f.errors, []);
            console.log(`PASS the Notifications header is the shared one at ${width}x${height}; its back control ends on the list and Back from there starts no stream`);
        } finally { await f.context.close(); }
    }
}

/**
 * With two iPhones linked, Switch in the bar is the kit's compact button with its word, as on the
 * header of a phone's page, and the bar stays one row from 320 px. With one iPhone there is none.
 */
async function switchButtonInBar(browser) {
    for (const [width, height] of [[320, 720], [440, 956], [1440, 900]]) {
        const f = await fixture(browser, { history: true, notifications: historyItems(), width, height });
        const { page } = f;
        try {
            await article(page, 'Coffee at four?').waitFor();
            await settleMotion(page);
            const header = page.locator(HEADER);
            const button = switchControl(page);
            const look = await button.evaluate(el => ({
                text: el.textContent.trim(), compact: el.matches('.kit-button.kit-button-compact.notification-switch'),
                popup: el.getAttribute('aria-haspopup'),
            }));
            assert.deepEqual(look, { text: 'Switch', compact: true, popup: 'dialog' }, `Switch is the compact button with its word at ${width} px`);
            const row = await header.evaluate(el => {
                const bar = el.getBoundingClientRect();
                return { height: Math.round(bar.height), children: [...el.children].map(child => {
                    const box = child.getBoundingClientRect();
                    return { name: child.getAttribute('aria-label') || child.textContent.trim(), top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), right: Math.round(box.right) };
                }) };
            });
            assert.deepEqual(row.children.map(item => item.name), ['Phones', 'NotificationsPhone A · Connected · 2 unread', 'Switch iPhone', 'Search', 'Setup']);
            assert.ok(row.height <= 61 && row.children.every(item => item.top >= 0 && item.bottom <= 61 && item.top < row.children[0].bottom), `one row at ${width} px: ${JSON.stringify(row)}`);
            assert.ok(row.children.every((item, i) => !i || item.left >= row.children[i - 1].right) && row.children.at(-1).right <= width, `nothing overlaps or leaves the bar at ${width} px: ${JSON.stringify(row)}`);
            // From the owner's phone width up, the title and the status line are whole. At 320 px both are cut short.
            if (width >= 440) {
                const cut = await header.evaluate(el => [...el.querySelectorAll('.kit-bar-name, .kit-bar-status')].filter(text => text.scrollWidth > text.clientWidth).map(text => text.textContent));
                assert.deepEqual(cut, [], `nothing in the title is cut short at ${width} px`);
            }
            await fs.mkdir(OUT, { recursive: true });
            for (const colorScheme of ['light', 'dark']) {
                await page.emulateMedia({ colorScheme });
                await page.screenshot({ path: path.join(OUT, `notifications-switch-${width}-${colorScheme}.png`), animations: 'disabled' });
            }
            await page.emulateMedia({ colorScheme: 'light' });
            await button.click();
            const sheet = page.getByRole('dialog', { name: 'Switch iPhone', exact: true });
            await sheet.waitFor();
            await sheet.locator('.kit-sheet-close').click();
            await sheet.waitFor({ state: 'detached' });
            await assertClean(f);
        } finally { await f.context.close(); }
    }
    const single = await fixture(browser, { history: true, sources: phones().slice(0, 1), notifications: historyItems().slice(0, 2), width: 440, height: 956 });
    try {
        await article(single.page, 'Coffee at four?').waitFor();
        const header = single.page.locator(HEADER);
        assert.equal(await header.getByRole('button', { name: /Switch/ }).count(), 0, 'one iPhone: no Switch in the bar');
        assert.equal(await header.locator('.notification-switch').count(), 0);
        await assertClean(single);
    } finally { await single.context.close(); }
    console.log('PASS with two iPhones Switch is the compact button with its word and the bar is one row at 320, 440 and 1440 px; with one iPhone there is none');
}

/** The iPhone, the panel, the filter, the app and the search text are in the address, in one history entry. */
async function viewStateInAddress(browser) {
    const f = await fixture(browser, {
        history: true, notifications: manyItems(), devices: true,
        beforeGoto: page => page.addInitScript(() => {
            window.__historyWrites = { push: 0, replace: 0 };
            for (const kind of ['push', 'replace']) {
                const write = history[`${kind}State`].bind(history);
                history[`${kind}State`] = (...args) => { window.__historyWrites[kind]++; return write(...args); };
            }
        }),
    });
    const { page } = f;
    try {
        const hashIs = expected => page.waitForFunction(value => location.hash === value, expected);
        // The back stack, not `history.length`: the entry the Filters sheet had stays ahead of the
        // page once the sheet has closed, and `history.length` counts it.
        const entries = () => page.evaluate(() => history.state.nav.index);
        const shown = () => page.locator('article.notification-history-item').count();
        const search = page.getByRole('searchbox', { name: 'Search notifications', exact: true });
        const main = page.locator('main.notifications-page');
        await article(page, 'Message 1').waitFor();
        const start = await entries();

        // The iPhone switcher.
        await switchIphone(page, 'Phone B');
        await article(page, 'A message from Alex').waitFor();
        await hashIs('#!action=notifications&source=phone-b');
        await switchIphone(page, 'Phone A');
        await hashIs('#!action=notifications&source=phone-a');
        // Back closes the switcher and leaves the iPhone shown and the page's entry as they were.
        await switchControl(page).click();
        const switcher = page.getByRole('dialog', { name: 'Switch iPhone', exact: true });
        await switcher.waitFor();
        await settleMotion(page);
        await page.goBack();
        await switcher.waitFor({ state: 'hidden' });
        await hashIs('#!action=notifications&source=phone-a');
        await page.waitForFunction(index => history.state?.nav?.index === index, start);
        assert.equal(await shownIphone(page), 'Phone A');
        // The panel. A reload on Setup stays on Setup.
        await showSetup(page);
        await hashIs('#!action=notifications&source=phone-a&panel=setup');
        await page.reload();
        await page.getByRole('heading', { name: 'Send from an iPhone', exact: true }).waitFor();
        assert.equal(await setupShown(page), 'true', 'a reload on Setup stays on Setup');
        assert.equal(await page.locator('#notification-history-heading').count(), 0);
        await showInbox(page);
        await hashIs('#!action=notifications&source=phone-a');
        // The filter.
        await segment(page, 'Archive').click();
        await hashIs('#!action=notifications&source=phone-a&filter=archive');
        await segment(page, 'Unread').click();
        await hashIs('#!action=notifications&source=phone-a&filter=unread');
        await segment(page, 'Inbox').click();
        await hashIs('#!action=notifications&source=phone-a');
        // The app.
        await setAppFilter(page, 'com.example.chat');
        await hashIs('#!action=notifications&source=phone-a&app=com.example.chat');
        // The search text: the list follows each key, the address is written once after a pause.
        await searchField(page);
        const before = await page.evaluate(() => ({ ...window.__historyWrites }));
        await search.pressSequentially('Message 1', { delay: 30 });
        assert.equal(await shown(), 5, 'the list is filtered as the text is typed');
        await hashIs('#!action=notifications&source=phone-a&app=com.example.chat&q=Message+1');
        await sleep(500);
        assert.deepEqual(await page.evaluate(() => ({ ...window.__historyWrites })), { push: before.push, replace: before.replace + 1 }, 'nine keys are one history write');
        assert.equal(await entries(), start, 'the iPhone switcher, the panel, the filter, the app and the search text add no history entry');
        // A reload shows the same inbox.
        await page.reload();
        await article(page, 'Message 10').waitFor();
        assert.equal(await searchControl(page).getAttribute('aria-pressed'), 'true', 'text in the address opens the search row');
        assert.equal(await search.inputValue(), 'Message 1');
        assert.equal(await page.getByRole('button', { name: /^Filters/ }).textContent(), 'Filters · 1');
        assert.equal(await shown(), 5);
        await page.locator('.notification-search-summary').getByRole('button', { name: 'Clear filters', exact: true }).click();
        await hashIs('#!action=notifications&source=phone-a');
        assert.equal(await search.inputValue(), '');

        // "Open screen" pressed right after typing: the text is in the address before the page is left.
        await segment(page, 'Unread').click();
        await search.fill('Message');
        await (await openToolbar(page)).getByRole('link', { name: 'Open iPhone screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        assert.equal(await page.evaluate(() => location.hash), '#!action=device&udid=phone-a&view=screen');
        assert.equal(await entries(), start + 1, 'the screen is one new entry');
        await sleep(350);
        assert.deepEqual(f.streams, ['phone-a'], 'exactly one stream socket for the open');
        await page.goBack();
        await article(page, 'Message 1').waitFor();
        const view = '#!action=notifications&source=phone-a&filter=unread&q=Message';
        assert.equal(await page.evaluate(() => location.hash), view);
        assert.equal(await search.inputValue(), 'Message');
        assert.equal(await pressed(page, 'Unread'), 'true');
        assert.equal(await setupShown(page), 'false');

        // From a card's sheet, far down a list that was made longer: Back returns to the same place.
        await page.getByRole('button', { name: /^Show older notifications/ }).click();
        await page.waitForFunction(() => document.querySelectorAll('article.notification-history-item').length === 50);
        await article(page, 'Message 40').scrollIntoViewIfNeeded();
        const sheet = await openCardMenu(page, 'Message 40');
        const top = await main.evaluate(el => el.scrollTop);
        assert.ok(top > 1000, `the list is scrolled far down (${top})`);
        await sheet.getByRole('link', { name: 'Open iPhone screen', exact: true }).click();
        await page.locator('.stream-view').waitFor();
        assert.equal(await entries(), start + 1);
        await sleep(350);
        assert.deepEqual(f.streams, ['phone-a', 'phone-a'], 'exactly one stream socket for each open');
        await page.goBack();
        await article(page, 'Message 41').waitFor();
        assert.equal(await article(page, 'Message 40').count(), 0, 'opening the screen marks its notification read, so it leaves Unread');
        assert.deepEqual(f.readRequests.at(-1), { keys: ['a-many-39'], read: true });
        assert.equal(await shown(), 50, 'as many notifications are listed as before');
        assert.ok(Math.abs(await main.evaluate(el => el.scrollTop) - top) <= 2, `the list is where it was (${await main.evaluate(el => el.scrollTop)}, was ${top})`);
        assert.equal(await page.getByRole('dialog').count(), 0, 'no sheet is open');
        assert.equal(await page.evaluate(() => location.hash), view);
        assert.equal(await search.inputValue(), 'Message');
        assert.equal(await pressed(page, 'Unread'), 'true');
        await sleep(350);
        assert.deepEqual(f.streams, ['phone-a', 'phone-a'], 'Back started no stream');
        // An inbox opened from the list starts at the top.
        await backControl(page).click();
        await page.locator('#devices').waitFor();
        await page.locator('header.kit-bar-root .notifications-link').click();
        await article(page, 'Message 1').waitFor();
        assert.equal(await main.evaluate(el => el.scrollTop), 0);
        assert.equal(await shown(), 25);
        assert.deepEqual(f.errors, []);
        // The search row opens from the bar with the field in focus, and closing it clears the search.
        assert.equal(await search.count(), 0, 'the search row is closed until it is asked for');
        await searchControl(page).click();
        await page.waitForFunction(() => document.activeElement?.matches('input[type="search"]'));
        await search.fill('Message 3');
        await hashIs('#!action=notifications&q=Message+3');
        await searchControl(page).click();
        await hashIs('#!action=notifications');
        assert.equal(await search.count(), 0);
        assert.equal(await shown(), 25);
        // Search pressed on Setup shows the inbox with the field in focus. The inbox has gone
        // from the page by then.
        await showSetup(page);
        await settleMotion(page);
        await page.locator('#notification-history-heading').waitFor({ state: 'detached' });
        await searchControl(page).click();
        await page.locator('#notification-history-heading').waitFor();
        await hashIs('#!action=notifications');
        await page.waitForFunction(() => document.activeElement?.matches('input[type="search"]'));
        assert.equal(await searchControl(page).getAttribute('aria-pressed'), 'true');
        console.log('PASS the iPhone, the panel, the filter, the app and the search text are in the address without new history entries; a reload and Back from a screen show the same inbox at the same place');
    } finally { await f.context.close(); }
}

// The role tokens that are colours. Nothing on the page may show any other colour.
const COLOUR_TOKENS = [
    'surface', 'surface-raised', 'surface-sunken', 'surface-inverse', 'border', 'border-strong', 'text', 'text-muted',
    'accent', 'accent-text', 'accent-soft', 'accent-pressed', 'on-accent', 'on-inverse', 'danger-text', 'danger-fill',
    'success-text', 'success-fill', 'warning-text', 'warning-fill', 'info-text', 'info-fill', 'neutral-text', 'neutral-fill', 'scrim',
];
/**
 * What the page draws, as a list of faults: every button, field, switch, disclosure and message
 * is a kit part, and every colour, type size and radius is a token's. The unread count in the
 * bar is left out: it is the bell's badge, which the list owns.
 */
function auditKit(tokens) {
    const faults = [];
    const view = document.querySelector('.notifications-view');
    const name = (el) => `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') || '').split(' ')[0]} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}"`;
    // The browser keeps boxes for what a closed disclosure holds and does not draw it.
    const folded = (el) => {
        for (let details = el.closest('details:not([open])'); details; details = details.parentElement?.closest('details:not([open])')) {
            if (!details.querySelector(':scope > summary')?.contains(el)) return true;
        }
        return false;
    };
    const drawn = (el) => el.getClientRects().length > 0 && !folded(el);
    for (const el of view.querySelectorAll('button, a')) {
        if (!el.matches('.kit-button, .kit-icon-button, .kit-bar-back, .kit-toast-action, .kit-toast-close, a.notification-link')) faults.push(`a button or link that is not the kit's: ${name(el)}`);
        if (el.matches('.kit-icon-button') && !(el.getAttribute('aria-label') || '').trim()) faults.push(`an icon button without a name: ${name(el)}`);
    }
    for (const el of view.querySelectorAll('.kit-button, .kit-icon-button')) {
        if (!drawn(el)) continue;
        const compact = el.matches('.kit-button-compact, .kit-icon-button-compact') && !matchMedia('(pointer: coarse)').matches;
        const height = Math.round(el.getBoundingClientRect().height);
        if (height !== (compact ? 32 : 44)) faults.push(`${height}px high: ${name(el)}`);
    }
    for (const el of view.querySelectorAll('input, select, textarea')) {
        if (el.matches('.kit-switch[role="switch"], .kit-check > input[type="checkbox"], .kit-segment > input[type="radio"]')) continue;
        if (!el.matches('.kit-field')) faults.push(`a field that is not the kit's: ${name(el)}`);
        else if (getComputedStyle(el).fontSize !== '16px') faults.push(`a field at ${getComputedStyle(el).fontSize}: ${name(el)}`);
        else if (drawn(el) && Math.round(el.getBoundingClientRect().height) !== 44) faults.push(`a field ${el.getBoundingClientRect().height}px high: ${name(el)}`);
    }
    for (const el of view.querySelectorAll('details')) if (!el.matches('.kit-disclosure')) faults.push(`a disclosure that is not the kit's: ${name(el)}`);
    for (const el of view.querySelectorAll('dialog')) if (!el.matches('.kit-sheet')) faults.push(`a dialog that is not the kit sheet: ${name(el)}`);
    for (const el of view.querySelectorAll('[role="alert"], [role="status"]')) {
        if (!el.matches('.kit-banner, .kit-status, .kit-toast, .kit-field-error, .kit-bar-status, .notification-empty, .notification-search-summary')) faults.push(`a message that is not the kit's: ${name(el)}`);
    }
    if (view.querySelectorAll('[class*="confirm-prompt"], [class*="app-toast"], .ui-button, .notification-primary, .notification-danger, .stream-header').length) faults.push('a class of the older controls is still on the page');

    const probe = view.appendChild(document.createElement('span'));
    probe.style.transition = 'none';
    const allowed = new Set(tokens.map((token) => {
        probe.style.color = `var(--${token})`;
        return getComputedStyle(probe).color;
    }));
    const length = (property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim();
    const radii = ['0px', length('--radius-sm'), length('--radius-md'), length('--radius-lg'), length('--radius-full')];
    probe.remove();
    const parse = (value) => {
        const parts = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(value);
        return parts ? { r: +parts[1], g: +parts[2], b: +parts[3], a: parts[4] === undefined ? 1 : +parts[4] } : undefined;
    };
    const colour = (style, property, where) => {
        const value = style[property];
        const parts = parse(value);
        if (!parts) faults.push(`${property} ${value} cannot be read: ${where}`);
        else if (parts.a !== 0 && !allowed.has(value)) faults.push(`${property} ${value} is not a role token: ${where}`);
    };
    const luminance = ({ r, g, b }) => {
        const channel = (value) => (value / 255 <= 0.03928 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const contrast = (first, second) => {
        const [high, low] = [luminance(parse(first)), luminance(parse(second))].sort((a, b) => b - a);
        return (high + 0.05) / (low + 0.05);
    };
    // The colour behind an element: the nearest solid fill. The text of a segment lies over the
    // radio button that draws the chosen fill.
    const behind = (el) => {
        for (let node = el; node; node = node.parentElement) {
            for (const layer of node.matches('.kit-segment > span') ? [node.previousElementSibling, node] : [node]) {
                if (parse(getComputedStyle(layer).backgroundColor)?.a === 1) return getComputedStyle(layer).backgroundColor;
            }
        }
        return getComputedStyle(document.body).backgroundColor;
    };
    const dimmed = (el) => {
        for (let node = el; node && node !== view.parentElement; node = node.parentElement) {
            if (node.matches(':disabled, [aria-disabled="true"]') || Number(getComputedStyle(node).opacity) < 1) return true;
        }
        return false;
    };
    for (const el of view.querySelectorAll('*')) {
        // What is not drawn (a closed sheet, the panel that is not shown) is measured when it is.
        // A heading for assistive technology only is never drawn.
        if (!drawn(el) || el.closest('.notification-unread-count, .visually-hidden, option')) continue;
        if (el.closest('svg') && el.tagName !== 'svg') continue;
        const field = el.matches('.kit-field');
        const text = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
        for (const pseudo of [undefined, '::before', '::after']) {
            const style = getComputedStyle(el, pseudo);
            if (pseudo && (style.content === 'none' || style.content === 'normal')) continue;
            const where = `${name(el)}${pseudo || ''}`;
            for (const corner of ['borderTopLeftRadius', 'borderBottomRightRadius']) {
                if (!radii.includes(style[corner])) faults.push(`${corner} ${style[corner]} is not a radius token: ${where}`);
            }
            if (!pseudo && (field || text || el.tagName === 'svg')) colour(style, 'color', where);
            colour(style, 'backgroundColor', where);
            for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
                if (parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none') colour(style, `border${side}Color`, where);
            }
        }
        if (!field && !text) continue;
        const style = getComputedStyle(el);
        if (!(field ? ['16px'] : ['12px', '13px', '15px', '17px', '20px', '24px']).includes(style.fontSize)) faults.push(`font size ${style.fontSize}: ${name(el)}`);
        if (dimmed(el)) continue;
        if (contrast(style.color, behind(el)) < 4.5) faults.push(`text contrast ${contrast(style.color, behind(el)).toFixed(2)}:1 (${style.color} on ${behind(el)}): ${name(el)}`);
        // The edge that makes a field findable.
        if (field && contrast(style.borderTopColor, behind(el.parentElement)) < 3) faults.push(`border contrast under 3:1: ${name(el)}`);
    }
    if (document.querySelectorAll('h1').length !== 1) faults.push(`${document.querySelectorAll('h1').length} h1 elements`);
    return faults;
}

/** The page on the kit: its controls, its tabs, its sheet, its toast, and no colour or size of its own. */
async function kitControls(browser) {
    for (const [width, height, ios] of [[390, 844, true], [1280, 800, false]]) {
        const items = historyItems();
        items.push({ key: 'a-call', source: 'phone-a', app: 'com.apple.mobilephone', appName: 'Phone', title: 'Incoming call', body: 'Sam', received: Date.now() - 30000, read: true, dismissed: false, active: true, canDismiss: true, negativeActionLabel: 'Decline' });
        const f = await fixture(browser, { history: true, notifications: items, devices: true, width, height, ios, standalone: ios, storedSources: ['phone-a', 'phone-b'], storedReceiver: '' });
        const { page } = f;
        const label = `${width} px`;
        try {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const audit = async (state) => {
                for (const colorScheme of ['light', 'dark']) {
                    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
                    if (!ios) await page.mouse.move(0, 0);
                    await settleMotion(page);
                    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                    assert.deepEqual(await page.evaluate(auditKit, COLOUR_TOKENS), [], `${label}, ${colorScheme}, ${state}`);
                }
            };
            await article(page, 'Coffee at four?').waitFor();
            await audit('the inbox');
            assert.equal(await page.locator('h1').textContent(), 'Notifications');
            assert.equal(await backControl(page).getAttribute('title'), 'Phones');

            // The inbox filter is the kit's segmented control: a radio group. Setup and Search are
            // icon buttons in the bar that stay pressed while they are open.
            const control = page.getByRole('radiogroup', { name: 'Notification view', exact: true });
            assert.equal(await control.evaluate(el => el.matches('.kit-segmented.kit-segmented-full')), true, `${label}: the filter is the kit's segmented control`);
            assert.deepEqual(await control.locator('.kit-segment').allTextContents(), ['Inbox 3', 'Unread 2', 'Archive']);
            assert.equal(await page.locator('.notifications-page .kit-segmented').count(), 1);
            for (const button of [setupControl(page), searchControl(page)]) {
                assert.equal(await button.evaluate(el => el.matches('.kit-icon-button.kit-icon-button-bare')), true);
                assert.equal(await button.getAttribute('aria-pressed'), 'false');
            }
            await segment(page, 'Inbox').focus();
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => /[&]filter=unread\b/.test(location.hash));
            assert.equal(await pressed(page, 'Unread'), 'true', `${label}: the arrow keys move the filter`);
            await page.keyboard.press('ArrowLeft');
            await page.waitForFunction(() => !/filter=/.test(location.hash));

            // The actions of a notification are in the kit sheet. A close request (Back on
            // Android) with a prompt armed cancels the prompt first, and closes the sheet next.
            const sheet = page.locator('dialog.kit-sheet[open]');
            await article(page, 'Incoming call').getByRole('button', { name: 'Actions for Incoming call', exact: true }).click();
            if (!ios) await page.getByRole('menu').getByRole('menuitem', { name: 'Decline on iPhone', exact: true }).click();
            await sheet.waitFor();
            assert.equal(await sheet.count(), 1);
            assert.equal(await sheet.evaluate(el => el.matches(':modal')), true, `${label}: the sheet is a modal dialog`);
            assert.equal(await page.getByRole('dialog', { name: 'Phone', exact: true }).count(), 1, `${label}: the dialog is named by its title`);
            if (ios) await sheet.getByRole('button', { name: 'Decline on iPhone', exact: true }).click();
            await sheet.locator('.kit-confirm.kit-confirm-danger').waitFor();
            await audit('a sheet with a prompt');
            const closeRequest = () => sheet.evaluate(el => el.dispatchEvent(new Event('cancel', { cancelable: true })));
            await closeRequest();
            await sheet.locator('.kit-confirm').waitFor({ state: 'detached' });
            await page.waitForTimeout(150);
            assert.equal(await sheet.isVisible(), true, `${label}: a close request with a prompt armed leaves the sheet open`);
            await closeRequest();
            await sheet.waitFor({ state: 'hidden' });
            assert.deepEqual(f.actions, [], `${label}: nothing was sent to the iPhone`);
            // A sheet hands focus back to the control that opened it. When there is none to go
            // back to (Archive removes it with its notification), focus goes to the actions
            // button of the list. Here the sheet is opened with nothing in focus.
            await page.evaluate(() => document.activeElement?.blur());
            await article(page, 'Incoming call').getByRole('button', { name: 'Actions for Incoming call', exact: true }).evaluate(el => el.click());
            const reopened = ios ? sheet : page.getByRole('menu');
            await reopened.waitFor();
            await page.keyboard.press('Escape');
            await reopened.waitFor({ state: 'hidden' });
            if (ios) await page.waitForFunction(() => document.activeElement?.matches('.notification-history-tools .notification-menu-button'));
            else await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Actions for Incoming call');

            // Archive answers with the kit toast, and Undo on it puts the notification back.
            await cardAction(page, 'Coffee at four?', 'Archive');
            const toast = page.locator('.kit-toast.notification-undo');
            await toast.locator('.kit-toast-message').getByText('Archived', { exact: true }).waitFor();
            await article(page, 'Coffee at four?').waitFor({ state: 'detached' });
            await audit('the toast');
            const undo = toast.locator('button.kit-toast-action');
            assert.equal(await undo.textContent(), 'Undo');
            assert.equal(await toast.locator('button.kit-toast-close').getAttribute('aria-label'), 'Dismiss undo notice');
            assert.equal(await undo.evaluate(el => getComputedStyle(el).borderTopWidth), '0px', `${label}: no rule of the page reaches the toast's buttons`);
            // A notice waits while a sheet is open: at the foot of a phone's screen it would
            // cover the sheet's last action. It comes back once the sheet has gone.
            await page.getByRole('button', { name: 'Notification actions', exact: true }).click();
            await sheet.waitFor();
            await toast.waitFor({ state: 'detached', timeout: 3000 });
            assert.equal(await page.locator('.kit-toast').count(), 0, `${label}: no notice over the sheet`);
            await page.keyboard.press('Escape');
            await sheet.waitFor({ state: 'hidden' });
            await toast.locator('.kit-toast-message').getByText('Archived', { exact: true }).waitFor();
            await undo.click();
            await article(page, 'Coffee at four?').waitFor();
            assert.deepEqual(f.restored, [{ key: 'a-chat', read: false }], `${label}: Undo restores the notification as it was`);
            await toast.waitFor({ state: 'detached' });

            // Setup, with its disclosures open.
            await showSetup(page);
            assert.equal(await setupControl(page).getAttribute('aria-pressed'), 'true');
            for (const name of ['Settings for Phone B', 'Add another iPhone', 'Choose phones and delivery options', 'Delivery details']) await openDetails(page, name);
            await page.locator('summary:visible').filter({ hasText: /^Apps/ }).click();
            const preview = page.getByRole('switch', { name: 'Include notification text', exact: true });
            assert.equal(await preview.evaluate(el => el.matches('input.kit-switch')), true, `${label}: a setting that applies at once is a switch`);
            assert.equal(await page.getByRole('group', { name: 'Get notifications from', exact: true }).locator('input.kit-switch[role="switch"]').count(), 2);
            assert.equal(await page.getByRole('switch', { name: 'Mail', exact: true }).evaluate(el => el.matches('input.kit-switch')), true, `${label}: each app is a switch`);
            assert.equal(await page.getByRole('textbox').count(), 0, `${label}: no app identifier is typed`);
            await audit('Setup');
            await assertClean(f);
        } finally { await f.context.close(); }
    }
    console.log('PASS every control of the page is a kit part, with the token colours, sizes, radii and contrast, in both themes at phone and desktop width');
}

async function main() {
    const browser = await ({ chromium, webkit }[browserName] || chromium).launch({ headless: true });
    try {
        const cases = [onboarding, missedPairingRequest, configuredReceiver, receiverChoicesAndUnlink, enablingReceiver, errorsSurvivePolling, appMuteList,
            iosInstallGate, recoverMissingServerSubscription, subscriptionRepairedOnLoad, subscriptionStateOnReturn, perDeviceHistory, historyFetchedOnChange, dismissKeepsHistory, labeledPhoneActions, confirmPromptLayouts,
            notificationDeepLink, deepLinkScrollsAndFades, unlinkedDeepLink, feedStatusInInbox, openScreenFromInbox, phoneActionsOutlastDefaultTimeout, bulkArchiveAndUndo, bulkDismissPhone, compactLongNotification, stickyBarsReachScrollTop, accessibleActionMenus, richNotificationMedia,
            searchAndFilters, bulkRespectsFilters, swipeAndUndo, swipeMotionAndFailure, delayedActionDoesNotCrossDevices, standaloneTouchNotifications,
            compatibilityPointerEventsDoNotDoubleAct, nativeTouchCancellationAndMultifinger, hangingRegistrationCleanup,
            hangingNotificationCleanup, hangingWorkerDeepLink, sharedHeader, switchButtonInBar, viewStateInAddress, linkingStaysOnSetup, kitControls];
        const selected = process.env.SCENARIO ? cases.filter(run => run.name === process.env.SCENARIO) : cases;
        assert.ok(selected.length, 'SCENARIO must name an existing fixture case');
        for (const run of selected) await run(browser);
    } finally { await browser.close(); }
}
module.exports = { fixture, article, historyItems, touchSequence, cardAction, openCardMenu, showSetup, showInbox, searchField, switchIphone };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
