const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/public/sw.js'), 'utf8');

const subscriptionOf = (endpoint, key) => ({
    endpoint,
    options: { applicationServerKey: key },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
});

function worker(options = {}) {
    const listeners = new Map();
    const shown = [];
    const badges = [];
    const messages = [];
    const opened = [];
    const navigated = [];
    const focused = [];
    const fetched = [];
    const order = [];
    const subscribed = [];
    let closed = 0;
    // Chromium gives a notification click one window interaction: focus() and openWindow() each
    // use it up, and the second of them is refused.
    let interaction = false;
    const interact = (what) => {
        if (!interaction) throw new DOMException(`Not allowed to ${what}.`, 'InvalidAccessError');
        interaction = false;
    };
    // `uncontrolled`: true for every window, or the URLs of the windows this worker does not control.
    const controlled = (url) => !(options.uncontrolled === true || options.uncontrolled?.includes(url));
    const windows = (options.windows || []).map((url) => ({
        url,
        navigate: async (target) => {
            order.push('navigate');
            if (!controlled(url) || options.navigateFailure)
                throw new TypeError("This service worker is not the client's active service worker.");
            navigated.push({ window: url, target });
        },
        focus: async () => {
            order.push('focus');
            interact('focus a window');
            focused.push(url);
        },
        postMessage: (message) => messages.push(message),
    }));
    const navigator = options.noBadges
        ? {}
        : {
              setAppBadge: async (count) => {
                  order.push('badge');
                  badges.push(count);
                  if (options.badgeFailure) throw Error('Badging unavailable');
              },
              clearAppBadge: async () => {
                  order.push('badge');
                  badges.push(0);
                  if (options.badgeFailure) throw Error('Badging unavailable');
              },
          };
    const scope = 'https://example.test/app/';
    const self = {
        location: new URL(scope + 'sw.js'),
        addEventListener: (name, handler) => listeners.set(name, handler),
        skipWaiting: async () => undefined,
        registration: {
            scope,
            showNotification: async (title, notification) => {
                order.push('notification');
                shown.push({ title, ...notification });
            },
            pushManager: {
                subscribe: async (settings) => {
                    subscribed.push(settings);
                    if (options.subscribeFailure) throw Error('Permission was withdrawn');
                    return subscriptionOf('https://web.push.apple.com/resubscribed');
                },
            },
        },
        clients: {
            claim: async () => undefined,
            matchAll: async ({ includeUncontrolled = false } = {}) =>
                windows.filter((client) => includeUncontrolled || controlled(client.url)),
            openWindow: async (target) => {
                order.push('open');
                interact('open a window');
                opened.push(target);
            },
        },
    };
    vm.runInNewContext(source, {
        self,
        navigator,
        URL,
        URLSearchParams,
        AbortController,
        setTimeout: (callback, duration) => setTimeout(callback, options.fastTimeout ? 0 : duration),
        clearTimeout,
        fetch: async (url, settings) => {
            order.push('fetch');
            fetched.push({ url: String(url), settings });
            if (options.waitForAbort)
                return await new Promise((_resolve, reject) => {
                    settings.signal.addEventListener('abort', () => reject(Error('Request timed out')));
                });
            if (options.fetchFailure) throw Error('Network unavailable');
            return { ok: options.summary !== undefined, json: async () => options.summary };
        },
    });
    async function dispatch(name, event) {
        const promises = [];
        listeners.get(name)({ ...event, waitUntil: (promise) => promises.push(promise) });
        await Promise.all(promises);
    }
    return {
        shown,
        badges,
        messages,
        opened,
        navigated,
        focused,
        fetched,
        order,
        subscribed,
        change: (event) => dispatch('pushsubscriptionchange', event),
        get closed() {
            return closed;
        },
        push: (payload) => dispatch('push', { data: payload === undefined ? null : { json: () => payload } }),
        click: (url) => {
            interaction = true;
            return dispatch('notificationclick', {
                notification: { data: { url }, close: () => closed++ },
            });
        },
    };
}

test('a real push displays the alert, records its history key, and updates the unread badge', async () => {
    const context = worker({ windows: ['https://example.test/app/#!action=notifications'] });
    await context.push({
        title: 'Calendar: Meeting',
        body: 'Starts in ten minutes',
        tag: 'calendar-alert',
        notificationKey: 'history-key',
        unreadCount: 7,
        url: '#!action=notifications&source=phone&notification=history-key',
    });
    assert.equal(context.shown.length, 1);
    assert.equal(context.shown[0].title, 'Calendar: Meeting');
    assert.equal(context.shown[0].body, 'Starts in ten minutes');
    assert.equal(context.shown[0].data.notificationKey, 'history-key');
    assert.equal(
        context.shown[0].data.url,
        'https://example.test/app/#!action=notifications&source=phone&notification=history-key',
    );
    assert.equal(context.shown[0].icon, 'https://example.test/app/icon-192.png');
    assert.deepEqual(context.badges, [7]);
    assert.equal(context.messages[0].type, 'notifications-changed');
});

test('a test push or missing unread count never clears an existing badge', async () => {
    const context = worker();
    await context.push({ title: 'A device alert', unreadCount: 4 });
    await context.push({ title: 'Test notification', tag: 'test' });
    await context.push();
    assert.equal(context.shown.length, 3);
    assert.deepEqual(context.badges, [4]);
    assert.equal(context.fetched.length, 1, 'test and fallback alerts do not refresh or change the badge');
});

test('a delayed push uses the latest shared unread count before setting its badge', async () => {
    const context = worker({ summary: { unread: 0 } });
    await context.push({ title: 'Read elsewhere', unreadCount: 6 });
    assert.deepEqual(context.badges, [0]);
    assert.deepEqual(context.order, ['notification', 'fetch', 'badge']);
    assert.equal(context.fetched[0].url, 'https://example.test/app/api/notifications/summary');
    assert.equal(context.fetched[0].settings.cache, 'no-store');
});

test('offline, unauthenticated, malformed, or timed-out summary requests fall back to the push count', async () => {
    for (const options of [
        {},
        { fetchFailure: true },
        { summary: { unread: -2 } },
        { summary: { unread: '0' } },
        { summary: null },
        { waitForAbort: true, fastTimeout: true },
    ]) {
        const context = worker(options);
        await context.push({ unreadCount: 3 });
        assert.equal(context.shown.length, 1);
        assert.deepEqual(context.badges, [3]);
    }
});

test('an explicit zero unread count clears the badge, while invalid counts are ignored', async () => {
    const context = worker();
    await context.push({ unreadCount: 0 });
    for (const count of [-1, 1.5, '3', NaN, Infinity]) await context.push({ unreadCount: count });
    assert.deepEqual(context.badges, [0]);
    assert.equal(context.shown.length, 6);
});

test('badge errors and unsupported badging do not prevent showing or refreshing alerts', async () => {
    for (const option of [{ badgeFailure: true }, { noBadges: true }]) {
        const context = worker({ ...option, windows: ['https://example.test/app/'] });
        await context.push({ unreadCount: 2 });
        await context.push({ unreadCount: 0 });
        assert.equal(context.shown.length, 2);
        assert.equal(context.messages.length, 2);
    }
});

test('push URLs only set an app route, and cannot replace the origin or scope', async () => {
    const context = worker();
    for (const target of ['https://outside.test/', '//outside.test/', '/elsewhere/']) {
        await context.push({ url: target });
        assert.equal(context.shown.at(-1).data.url, 'https://example.test/app/#!action=notifications');
    }
});

test('a replaced push subscription is sent to the server under its old endpoint', async () => {
    const key = new Uint8Array([4, 1, 2, 3]).buffer;
    const old = subscriptionOf('https://web.push.apple.com/old', key);
    const posted = (context) =>
        context.fetched.map(({ url, settings }) => ({ url, method: settings.method, body: JSON.parse(settings.body) }));

    // The browser already made the new subscription.
    const given = worker({ windows: ['https://example.test/app/'] });
    await given.change({ oldSubscription: old, newSubscription: subscriptionOf('https://web.push.apple.com/new', key) });
    assert.deepEqual(given.subscribed, [], 'no second subscription is made');
    assert.deepEqual(posted(given), [
        {
            url: 'https://example.test/app/api/notifications/subscriptions',
            method: 'POST',
            body: { subscription: { endpoint: 'https://web.push.apple.com/new', keys: { p256dh: 'p', auth: 'a' } }, replaces: 'https://web.push.apple.com/old' },
        },
    ]);
    assert.deepEqual(given.messages.map((message) => message.type), ['notifications-changed'], 'an open page is told to refresh');

    // The browser only reports the loss: subscribe again with the same server key.
    const lost = worker();
    await lost.change({ oldSubscription: old, newSubscription: null });
    assert.equal(lost.subscribed.length, 1);
    assert.equal(lost.subscribed[0].userVisibleOnly, true);
    assert.equal(lost.subscribed[0].applicationServerKey, key);
    assert.equal(posted(lost)[0].body.subscription.endpoint, 'https://web.push.apple.com/resubscribed');
    assert.equal(posted(lost)[0].body.replaces, 'https://web.push.apple.com/old');

    // Nothing identifies the server's record, or the browser refuses: left for the app to repair.
    for (const [options, event] of [
        [{}, { oldSubscription: null, newSubscription: null }],
        [{}, {}],
        [{ subscribeFailure: true }, { oldSubscription: old, newSubscription: null }],
        [{ fetchFailure: true }, { oldSubscription: old, newSubscription: subscriptionOf('https://web.push.apple.com/new', key) }],
    ]) {
        const context = worker({ ...options, windows: ['https://example.test/app/'] });
        await context.change(event);
        assert.equal(context.fetched.filter(({ settings }) => !options.fetchFailure && settings.method === 'POST').length, 0);
        assert.equal(context.messages.length, 1, 'the page is still told');
    }
});

test('notification clicks focus, then navigate, an existing app window', async () => {
    const context = worker({ windows: ['https://example.test/app/#!action=devices'] });
    const target = 'https://example.test/app/#!action=notifications&notification=history-key';
    await context.click(target);
    assert.equal(context.closed, 1);
    assert.deepEqual(context.navigated, [{ window: 'https://example.test/app/#!action=devices', target }]);
    assert.deepEqual(context.order, ['focus', 'navigate'], 'focus is requested while the tap still counts as a gesture');
    assert.deepEqual(context.opened, []);
});

test('notification clicks prefer the window already on Notifications and leave device sessions alone', async () => {
    const target = 'https://example.test/app/#!action=notifications&source=phone&notification=history-key';
    const stream = 'https://example.test/app/#!action=stream-coredevice&udid=phone';
    const inbox = 'https://example.test/app/#!action=notifications&source=other';
    const list = 'https://example.test/app/';
    const preferred = worker({ windows: [stream, list, inbox] });
    await preferred.click(target);
    assert.deepEqual(preferred.navigated, [{ window: inbox, target }]);
    assert.deepEqual(preferred.focused, [inbox]);
    assert.deepEqual(preferred.opened, []);

    const idle = worker({ windows: [stream, list] });
    await idle.click(target);
    assert.deepEqual(idle.navigated, [{ window: list, target }], 'the device list may be navigated');

    for (const busy of [
        stream,
        'https://example.test/app/#!action=stream&udid=android&player=mse',
        'https://example.test/app/#!action=shell&udid=android',
        'https://example.test/app/#!action=list-files&udid=android&path=%2Fsdcard',
    ]) {
        const context = worker({ windows: [busy] });
        await context.click(target);
        assert.deepEqual(context.navigated, [], `${busy} keeps its session`);
        assert.deepEqual(context.focused, []);
        assert.deepEqual(context.opened, [target], 'the notification opens in a window of its own');
    }
});

test('a window this worker does not control falls back to a new window', async () => {
    const inbox = 'https://example.test/app/#!action=notifications';
    const target = 'https://example.test/app/#!action=notifications&notification=history-key';
    const context = worker({ windows: [inbox], uncontrolled: true });
    await context.click(target);
    assert.deepEqual(context.navigated, []);
    // Focusing it first would use up the one window interaction the tap allows.
    assert.deepEqual(context.order, ['open'], 'the window it cannot navigate is not focused first');
    assert.deepEqual(context.opened, [target], 'the tap never does nothing');

    // A controlled window is still preferred over one the worker cannot navigate.
    const list = 'https://example.test/app/';
    const mixed = worker({ windows: [inbox, list], uncontrolled: [inbox] });
    await mixed.click(target);
    assert.deepEqual(mixed.navigated, [{ window: list, target }]);
    assert.deepEqual(mixed.opened, []);

    // Navigation can still fail after focus. A new window is tried; a refusal is not an error.
    const failing = worker({ windows: [list], navigateFailure: true });
    await failing.click(target);
    assert.deepEqual(failing.order, ['focus', 'navigate', 'open']);
    assert.deepEqual(failing.focused, [list], 'the app window is at least brought forward');
});

test('windows of another app on the same origin are not reused', async () => {
    const context = worker({ windows: ['https://example.test/other/#!action=notifications'] });
    const target = 'https://example.test/app/#!action=notifications';
    await context.click(target);
    assert.deepEqual(context.navigated, []);
    assert.deepEqual(context.opened, [target]);
});

test('notification clicks open a new app window if needed and reject unsafe destinations', async () => {
    const context = worker();
    const target = 'https://example.test/app/#!action=notifications';
    await context.click(target);
    assert.deepEqual(context.opened, [target]);
    for (const unsafe of [
        'https://outside.test/app/',
        'https://example.test/elsewhere/',
        'https://example.test/application/',
        'javascript:alert(1)',
        'invalid URL',
    ])
        await context.click(unsafe);
    assert.deepEqual(context.opened, [target]);
    assert.deepEqual(context.navigated, []);
});
