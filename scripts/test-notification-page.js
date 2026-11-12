// Client-side pieces of the Notifications page that run without a browser.
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const path = require('node:path');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
require.extensions['.css'] = () => {};
const { requestJson, REQUEST_TIMEOUT_MS } = require('../src/app/client/request');
const { madeForServerKey, serverKeyBytes } = require('../src/common/pushKey');

test('a push subscription made for other server keys is recognised', () => {
    const bytes = Buffer.from(Array.from({ length: 65 }, (_, index) => (index * 7 + 250) % 256));
    const publicKey = bytes.toString('base64url');
    assert.match(publicKey, /[-_]/, 'the fixture covers the URL-safe alphabet');
    assert.deepEqual([...serverKeyBytes(publicKey)], [...bytes]);
    const held = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
    assert.equal(madeForServerKey(held(bytes), publicKey), true);
    const other = Buffer.from(bytes);
    other[64] ^= 1;
    assert.equal(madeForServerKey(held(other), publicKey), false, 'one differing byte is another key');
    assert.equal(madeForServerKey(held(bytes.subarray(0, 64)), publicKey), false);
    // A browser that does not report the key, or a server with none, gives no reason to resubscribe.
    for (const unknown of [null, undefined]) assert.equal(madeForServerKey(unknown, publicKey), true);
    assert.equal(madeForServerKey(held(bytes), ''), true);
    assert.equal(madeForServerKey(held(bytes), 'not base64 !'), true);
});

/** A server that answers after `delay` ms unless the request is aborted first. */
function slowServer(delay, reply = { ok: true }) {
    const calls = [];
    const fetch = (url, options) =>
        new Promise((resolve, reject) => {
            calls.push(url);
            const timer = setTimeout(() => resolve({ ok: true, status: 200, json: async () => reply }), delay);
            options.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
        });
    return { fetch, calls };
}

test('a 304 reply resolves to null and other failures keep their message', async () => {
    const originalFetch = global.fetch;
    try {
        global.fetch = async () => ({ ok: false, status: 304, json: async () => { throw Error('no body'); } });
        assert.equal(await requestJson('http://server/api/notifications/history?since=abc'), null);
        global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'Unknown notification device' }) });
        await assert.rejects(requestJson('http://server/x'), /Unknown notification device/);
        global.fetch = async () => ({ ok: false, status: 502, json: async () => { throw Error('not JSON'); } });
        await assert.rejects(requestJson('http://server/x'), /Request failed \(502\)/);
    } finally {
        global.fetch = originalFetch;
    }
});

test('a request waits as long as its caller allows, and 10 s by default', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const originalFetch = global.fetch;
    // The bulk route can work for 30 s; the page allows it 35 s.
    const server = slowServer(30000, { accepted: ['a'] });
    global.fetch = server.fetch;
    try {
        assert.equal(REQUEST_TIMEOUT_MS, 10000);
        const short = requestJson('http://server/api/notifications/history/actions', { method: 'POST' });
        const rejected = assert.rejects(short, /The server took too long to respond/);
        t.mock.timers.tick(10000);
        await rejected;

        const long = requestJson('http://server/api/notifications/history/actions', { method: 'POST' }, undefined, 35000);
        t.mock.timers.tick(30000);
        assert.deepEqual(await long, { accepted: ['a'] }, 'the reply at 30 s reaches the caller');

        const tooLong = requestJson('http://server/x', {}, undefined, 20000);
        const late = assert.rejects(tooLong, /The server took too long to respond/);
        t.mock.timers.tick(20000);
        await late;
    } finally {
        global.fetch = originalFetch;
        mock.timers.reset();
    }
});

// The view state of the page lives in its address (src/app/state/notificationPage.ts) and is
// written by src/app/state/notificationNav.ts. scripts/e2e-notifications.js covers the same in
// a browser.
const ORIGIN = 'http://phones.test:8000/';
const SCREEN = `${ORIGIN}#!action=device&udid=phone-a&view=screen`;

/**
 * A tab's session history, as much of it as the router uses. `pushState` and `replaceState` act
 * at once; `go` and `back` act when `settle()` runs and then fire `popstate` and `hashchange`.
 */
function fakeBrowser(address) {
    const listeners = { popstate: new Set(), hashchange: new Set() };
    const tasks = [];
    const entries = [{ url: new URL(address, ORIGIN), state: null }];
    let index = 0;
    const fire = (type) => [...listeners[type]].forEach((listener) => listener({ type }));
    const here = () => entries[index].url;
    const go = (delta) =>
        tasks.push(() => {
            if (index + delta < 0 || index + delta >= entries.length) return;
            const from = here().hash;
            index += delta;
            fire('popstate');
            if (here().hash !== from) fire('hashchange');
        });
    const write = (replace) => (state, _unused, url) => {
        const entry = { url: url === undefined ? here() : new URL(url, here()), state: structuredClone(state) };
        if (!replace) entries.length = ++index;
        entries[index] = entry;
    };
    global.window = {
        addEventListener: (type, listener) => listeners[type]?.add(listener),
        removeEventListener: (type, listener) => listeners[type]?.delete(listener),
    };
    global.location = {
        get hash() { return here().hash; },
        get href() { return here().href; },
        get origin() { return here().origin; },
        get pathname() { return here().pathname; },
    };
    global.history = {
        get state() { return entries[index].state; },
        pushState: write(false),
        replaceState: write(true),
        go,
        back: () => go(-1),
    };
    global.localStorage = { getItem: () => null, setItem: () => undefined };
    return {
        hashes: () => entries.map((entry) => entry.url.hash),
        get index() { return index; },
        settle() { while (tasks.length) tasks.shift()(); },
    };
}

/** Loads the route modules into a new tab that was opened on `address`. */
function openTab(address = '') {
    const browser = fakeBrowser(address);
    const app = path.join(__dirname, '..', 'src', 'app') + path.sep;
    for (const key of Object.keys(require.cache)) if (key.startsWith(app)) delete require.cache[key];
    return {
        browser,
        router: require('../src/app/state/router'),
        page: require('../src/app/state/notificationPage'),
        nav: require('../src/app/state/notificationNav'),
    };
}

const DEFAULT_VIEW = { source: '', panel: 'history', filter: 'inbox', app: '', q: '', notification: '' };

test('the Notifications address carries the iPhone, the panel, the filter, the app and the search text', () => {
    const { page } = openTab();
    const view = { source: 'phone-b', panel: 'setup', filter: 'archive', app: 'com.example.mail', q: 'coffee at 4 & more', notification: '' };
    const address = page.notificationRoute(view);
    assert.equal(address.toString(), 'action=notifications&source=phone-b&panel=setup&filter=archive&app=com.example.mail&q=coffee+at+4+%26+more');
    assert.deepEqual(page.readNotificationPage(address), view);
    // Defaults are left out, so the plain link is the plain inbox.
    assert.equal(page.notificationRoute().toString(), 'action=notifications');
    assert.equal(page.notificationRoute(DEFAULT_VIEW).toString(), 'action=notifications');
    assert.equal(page.notificationRoute({ filter: 'unread' }).toString(), 'action=notifications&filter=unread');
    assert.deepEqual(page.readNotificationPage(new URLSearchParams('action=notifications')), DEFAULT_VIEW);
    // A value the page does not have is the default.
    assert.deepEqual(page.readNotificationPage(new URLSearchParams('action=notifications&panel=other&filter=all')), DEFAULT_VIEW);
});

test('each part of the view is read from the address the tab opens on', () => {
    for (const [address, expected] of [
        ['#!action=notifications&source=phone-b', { source: 'phone-b' }],
        ['#!action=notifications&panel=setup', { panel: 'setup' }],
        ['#!action=notifications&filter=unread', { filter: 'unread' }],
        ['#!action=notifications&app=com.example.chat', { app: 'com.example.chat' }],
        ['#!action=notifications&q=design+review', { q: 'design review' }],
        ['#!action=notifications&source=phone-a&panel=setup&filter=archive&app=com.example.chat&q=four', { source: 'phone-a', panel: 'setup', filter: 'archive', app: 'com.example.chat', q: 'four' }],
    ]) {
        const { router, page } = openTab(address);
        assert.deepEqual(page.readNotificationPage(router.route.value), { ...DEFAULT_VIEW, ...expected }, address);
    }
});

test('the iPhone, the panel, the filter, the app and the search text are each written into the same history entry', () => {
    const { browser, router, page, nav } = openTab('#!');
    router.openRoute(page.notificationRoute());
    assert.deepEqual(browser.hashes(), ['#!', '#!action=notifications']);
    for (const [change, address] of [
        [{ source: 'phone-b' }, '#!action=notifications&source=phone-b'],
        [{ panel: 'setup' }, '#!action=notifications&source=phone-b&panel=setup'],
        [{ panel: 'history' }, '#!action=notifications&source=phone-b'],
        [{ filter: 'unread' }, '#!action=notifications&source=phone-b&filter=unread'],
        [{ app: 'com.example.mail' }, '#!action=notifications&source=phone-b&filter=unread&app=com.example.mail'],
        [{ q: 'itinerary' }, '#!action=notifications&source=phone-b&filter=unread&app=com.example.mail&q=itinerary'],
        [{ filter: 'inbox', app: '', q: '' }, '#!action=notifications&source=phone-b'],
    ]) {
        assert.equal(nav.changeNotificationPage(change), address.slice(2));
        assert.deepEqual(browser.hashes(), ['#!', address], `${JSON.stringify(change)} is a replace`);
        assert.equal(browser.index, 1);
        assert.deepEqual(page.readNotificationPage(router.route.value), page.readNotificationPage(new URLSearchParams(address.slice(2))), 'the route the views read follows');
    }
    // One step back leaves the page: no earlier choice is in between.
    history.back();
    browser.settle();
    assert.equal(location.hash, '#!');
});

test('a delivered push link opens its notification once, and a filter written afterwards does not open it again', () => {
    const { browser, router, page, nav } = openTab('#!action=notifications&source=phone-a&notification=a-chat');
    assert.deepEqual(page.readNotificationPage(router.route.value), { ...DEFAULT_VIEW, source: 'phone-a', notification: 'a-chat' });
    // A filter written before the notification has been found keeps the request.
    nav.changeNotificationPage({ filter: 'unread' });
    assert.equal(page.readNotificationPage(router.route.value).notification, 'a-chat');
    // The page found it: it shows the list that holds it and takes its name out of the address.
    nav.changeNotificationPage({ notification: '', filter: 'inbox', app: '', q: '' });
    assert.deepEqual(browser.hashes(), ['#!action=notifications&source=phone-a'], 'in the entry the link opened');
    assert.equal(page.readNotificationPage(router.route.value).notification, '');
    for (const change of [{ filter: 'unread' }, { q: 'coffee' }, { app: 'com.example.chat' }, { panel: 'setup' }, { source: 'phone-b' }]) {
        nav.changeNotificationPage(change);
        assert.equal(page.readNotificationPage(router.route.value).notification, '', `${JSON.stringify(change)} does not bring it back`);
        assert.doesNotMatch(location.hash, /notification=/);
    }
    assert.equal(browser.hashes().length, 1);
    // The alert link of a push is still the list.
    assert.equal(openTab('#!action=').router.route.value.get('action'), '');
});

test('a change that arrives after the page is left does not put Notifications back', () => {
    const { browser, router, page, nav } = openTab('#!');
    assert.equal(nav.changeNotificationPage({ q: 'late' }), undefined, 'nothing is written on the list');
    assert.deepEqual(browser.hashes(), ['#!']);
    router.openRoute(page.notificationRoute());
    // The back control was pressed and the search text is written before the browser has moved.
    router.goUp();
    nav.changeNotificationPage({ q: 'late' });
    browser.settle();
    assert.equal(location.hash, '#!');
    assert.deepEqual(browser.hashes(), ['#!', '#!action=notifications'], 'the entry that was left is as it was');
    assert.equal(router.route.value.toString(), '');
});

test('opening a screen from the inbox writes the search text first and keeps the place for the return with Back', () => {
    const { browser, router, page, nav } = openTab('#!');
    router.openRoute(page.notificationRoute({ source: 'phone-a', filter: 'archive' }));
    assert.equal(nav.takeNotificationScroll(), undefined, 'an inbox opened from the list starts at the top');
    nav.openScreenFromNotifications(SCREEN, 'four', { top: 640, limit: 50 });
    assert.deepEqual(browser.hashes(), ['#!', '#!action=notifications&source=phone-a&filter=archive&q=four', '#!action=device&udid=phone-a&view=screen']);
    assert.equal(browser.index, 2, 'the screen is a new entry');
    assert.equal(nav.takeNotificationScroll(), undefined, 'nothing to restore on the screen');
    history.back();
    browser.settle();
    assert.deepEqual(page.readNotificationPage(router.route.value), { ...DEFAULT_VIEW, source: 'phone-a', filter: 'archive', q: 'four' });
    assert.deepEqual(nav.takeNotificationScroll(), { top: 640, limit: 50 });
    assert.equal(nav.takeNotificationScroll(), undefined, 'the place is used once');

    // From the screen to the list with the back control, then the inbox again: a new visit.
    nav.openScreenFromNotifications(SCREEN, 'four', { top: 320, limit: 25 });
    router.goUp();
    browser.settle();
    assert.equal(location.hash, '#!');
    router.openRoute(page.notificationRoute({ source: 'phone-a', filter: 'archive', q: 'four' }));
    assert.equal(nav.takeNotificationScroll(), undefined, 'an inbox opened from the list starts at the top');
});

// The mute list of Setup (src/app/state/notificationSources.ts). "Mute this app" on a card's menu
// calls setAppMuted too.
function sourceSettings() {
    openTab('#!action=notifications&panel=setup');
    global.window.location = global.location;
    return require('../src/app/state/notificationSources');
}
const phoneA = { id: 'phone-a', address: 'AA:BB:CC:DD:EE:00', name: 'Phone A', apps: [], preview: true };
const seen = (app, appName, received, source = 'phone-a') => ({ key: `${app}-${received}`, source, app, appName, received, session: 's', uid: 1, event: 'added', read: false, dismissed: false, active: true });

test('Setup lists the apps seen from an iPhone, by their newest name, with the muted ones that sent nothing since', () => {
    const { seenApps } = sourceSettings();
    const items = [seen('com.example.chat', 'Messages', 3), seen('com.example.chat', 'Chat', 1), seen('com.example.mail', 'Mail', 2), seen('com.example.other', 'Other', 4, 'phone-b')];
    assert.deepEqual(seenApps(phoneA, items), [
        { app: 'com.example.mail', name: 'Mail', muted: false, listed: true },
        { app: 'com.example.chat', name: 'Messages', muted: false, listed: true },
    ]);
    // Settings saved before the mute list existed have none; a muted app keeps its name.
    const muted = { ...phoneA, apps: ['com.example.mail'], muted: [{ app: 'com.example.games', name: 'Games' }, { app: 'com.example.chat', name: 'Old name' }] };
    assert.deepEqual(seenApps(muted, items), [
        { app: 'com.example.games', name: 'Games', muted: true, listed: false },
        { app: 'com.example.mail', name: 'Mail', muted: false, listed: true },
        { app: 'com.example.chat', name: 'Messages', muted: true, listed: false },
    ]);
});

test('muting changes only the mute list, and the whole record is saved in the shape the server takes', async () => {
    const { withAppMuted, setAppMuted, isAppMuted } = sourceSettings();
    const muted = withAppMuted(phoneA, 'com.example.chat', 'Messages', true);
    assert.deepEqual(muted, { ...phoneA, muted: [{ app: 'com.example.chat', name: 'Messages' }] });
    assert.equal(isAppMuted(muted, 'com.example.chat'), true);
    assert.deepEqual(withAppMuted(withAppMuted(muted, 'com.example.mail', 'Mail', true), 'com.example.chat', 'Messages', true).muted.map((entry) => entry.app), ['com.example.mail', 'com.example.chat'], 'one entry per app');
    assert.deepEqual(withAppMuted(muted, 'com.example.chat', 'Messages', false), { ...phoneA, muted: [] });
    assert.deepEqual(phoneA, { id: 'phone-a', address: 'AA:BB:CC:DD:EE:00', name: 'Phone A', apps: [], preview: true }, 'the record given is not changed');
    const sent = [];
    const originalFetch = global.fetch;
    try {
        global.fetch = async (url, options) => {
            sent.push([new URL(url).pathname, options.method, JSON.parse(options.body)]);
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        };
        await setAppMuted({ ...phoneA, apps: ['com.example.chat'] }, 'com.example.chat', 'Messages', true);
        assert.deepEqual(sent, [['/api/notifications/sources', 'POST', { ...phoneA, apps: ['com.example.chat'], muted: [{ app: 'com.example.chat', name: 'Messages' }] }]]);
        global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'Invalid notification source' }) });
        await assert.rejects(setAppMuted(phoneA, 'com.example.chat', 'Messages', true), /Invalid notification source/, 'a refusal keeps its reason');
    } finally {
        global.fetch = originalFetch;
    }
});
