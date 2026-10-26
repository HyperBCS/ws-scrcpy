const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/public/sw.js'), 'utf8');

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
    let closed = 0;
    const windows = (options.windows || []).map((url) => ({
        url,
        navigate: async (target) => navigated.push(target),
        focus: async () => focused.push(url),
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
        },
        clients: {
            claim: async () => undefined,
            matchAll: async () => windows,
            openWindow: async (target) => opened.push(target),
        },
    };
    vm.runInNewContext(source, {
        self,
        navigator,
        URL,
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
        get closed() {
            return closed;
        },
        push: (payload) => dispatch('push', { data: payload === undefined ? null : { json: () => payload } }),
        click: (url) =>
            dispatch('notificationclick', {
                notification: { data: { url }, close: () => closed++ },
            }),
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

test('notification clicks navigate and focus an existing app window', async () => {
    const context = worker({ windows: ['https://example.test/app/#!action=devices'] });
    const target = 'https://example.test/app/#!action=notifications&notification=history-key';
    await context.click(target);
    assert.equal(context.closed, 1);
    assert.deepEqual(context.navigated, [target]);
    assert.equal(context.focused.length, 1);
    assert.deepEqual(context.opened, []);
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
