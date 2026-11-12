// Run with: node --test scripts/test-routes.js
// The routes and the history policy, without a browser: both forms of a phone's address, the
// rewrite of the older form, the push links that are already delivered, the three verbs (open
// pushes, switch replaces, up goes back to the list or replaces with it), the earlier exports
// as shims, and the history entries of overlays. scripts/e2e-navigation.js covers the same in a
// browser, with stream sockets counted, and scripts/e2e-overlay-back.js drives the sheets.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
require.extensions['.css'] = () => {};

const ORIGIN = 'http://phones.test:8000/';
const SOCKET = 'ws://phones.test:8000/?action=proxy-adb&remote=tcp%3A8886&udid=PIXEL';

/**
 * A tab's session history. `pushState` and `replaceState` act at once; an assigned hash, Back,
 * Forward and `go` act in a later task and then fire `popstate` and, when the fragment changed,
 * `hashchange`, as browsers do. `settle()` runs the tasks that are due.
 */
function fakeBrowser(address, state = null, session = { entries: [{ url: new URL(address, ORIGIN), state }], index: 0 }) {
    const listeners = { popstate: new Set(), hashchange: new Set() };
    const tasks = [];
    const entries = session.entries;
    let index = session.index;
    let steps = 0;
    const fire = (type, event = {}) => [...(listeners[type] || [])].forEach((listener) => listener({ type, ...event }));
    const resolve = (url) => (url === undefined || url === null ? entries[index].url : new URL(url, entries[index].url));
    const traverse = (delta) => {
        steps++;
        tasks.push(() => {
            const to = index + delta;
            if (to < 0 || to >= entries.length) return;
            // Decided between the two entries as they are before the events: a popstate
            // handler that rewrites the address does not take the hashchange back.
            const changed = entries[to].url.hash !== entries[index].url.hash;
            index = to;
            fire('popstate');
            if (changed) fire('hashchange');
        });
    };
    const location = {
        get hash() {
            return entries[index].url.hash;
        },
        set hash(value) {
            const url = new URL(entries[index].url);
            url.hash = value;
            if (url.hash === entries[index].url.hash) return;
            // A fragment navigation: the entry exists at once, the events follow.
            entries.length = index + 1;
            entries.push({ url, state: null });
            index++;
            tasks.push(() => {
                fire('popstate');
                fire('hashchange');
            });
        },
        get href() {
            return entries[index].url.href;
        },
        get origin() {
            return entries[index].url.origin;
        },
        get pathname() {
            return entries[index].url.pathname;
        },
        get protocol() {
            return entries[index].url.protocol;
        },
        get hostname() {
            return entries[index].url.hostname;
        },
        get port() {
            return entries[index].url.port;
        },
        assigned: [],
        assign(url) {
            this.assigned.push(String(url));
        },
    };
    const history = {
        get state() {
            return entries[index].state;
        },
        get length() {
            return entries.length;
        },
        pushState(next, _unused, url) {
            const entry = { url: resolve(url), state: structuredClone(next) };
            entries.length = index + 1;
            entries.push(entry);
            index++;
        },
        replaceState(next, _unused, url) {
            entries[index] = { url: resolve(url), state: structuredClone(next) };
        },
        go: traverse,
        back: () => traverse(-1),
        forward: () => traverse(1),
    };
    const window = {
        addEventListener: (type, listener) => (listeners[type] ||= new Set()).add(listener),
        removeEventListener: (type, listener) => listeners[type]?.delete(listener),
    };
    return {
        window,
        location,
        history,
        settle() {
            while (tasks.length) tasks.shift()();
        },
        /** The owner presses something: a tap, or the key named. */
        press(key, isTrusted = true) {
            fire(key ? 'keydown' : 'pointerup', { key, isTrusted });
        },
        /** How many times `history.go`, `back` or `forward` was called. */
        get steps() {
            return steps;
        },
        /** The same tab after a reload: a new document on the same entries. */
        reloaded: () => fakeBrowser(undefined, undefined, { entries: entries.map((entry) => ({ ...entry })), index }),
        /** The fragment of every entry, oldest first. */
        hashes: () => entries.map((entry) => entry.url.hash),
        get index() {
            return index;
        },
        /** The fragments the browser's Back would show from here, nearest first. */
        behind: () =>
            entries
                .slice(0, index)
                .reverse()
                .map((entry) => entry.url.hash),
    };
}

function fakeStorage(values = {}) {
    const map = new Map(Object.entries(values));
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => void map.set(key, String(value)),
    };
}

/** Loads the app's route modules into a new tab that was opened on `address`. */
function open(address = '', { state = null, storage = fakeStorage(), browser = fakeBrowser(address, state) } = {}) {
    global.window = browser.window;
    global.location = browser.location;
    global.history = browser.history;
    global.localStorage = storage;
    const app = path.join(__dirname, '..', 'src', 'app') + path.sep;
    for (const key of Object.keys(require.cache)) if (key.startsWith(app)) delete require.cache[key];
    const router = require('../src/app/state/router');
    const routes = require('../src/app/state/routes');
    // What a view would have mounted: every value the route took, in order.
    const shown = [];
    router.route.subscribe((value) => shown.push(value.toString()));
    return { browser, router, routes, storage, shown };
}

const usp = (value) => new URLSearchParams(value);
/**
 * Lets the router finish what it puts off until the running code is done: the history entries
 * of overlays are made, and stepped back over, once per task.
 */
const tick = () => Promise.resolve();
/** The same, then the browser's tasks. */
async function settled(browser) {
    await tick();
    browser.settle();
}
const isStream = (hash) => /action=(device|stream)/.test(hash) && !/view=(files|shell)/.test(hash);

test('every older phone address is rewritten to the phone and its view, and both forms are read alike', () => {
    const { routes } = open();
    const cases = [
        [
            `action=stream&udid=PIXEL&player=webcodecs&ws=${encodeURIComponent(SOCKET)}&fitToScreen=true`,
            `action=device&udid=PIXEL&view=screen&player=webcodecs&ws=${encodeURIComponent(SOCKET)}&fitToScreen=true`,
            { page: 'device', udid: 'PIXEL', view: 'screen' },
            'android',
        ],
        [
            'action=stream-coredevice&udid=IPHONE',
            'action=device&udid=IPHONE&view=screen',
            { page: 'device', udid: 'IPHONE', view: 'screen' },
            'ios',
        ],
        ['action=shell&udid=PIXEL', 'action=device&udid=PIXEL&view=shell', { page: 'device', udid: 'PIXEL', view: 'shell' }, 'android'],
        [
            'action=shell&udid=PIXEL&hostname=10.0.0.5&port=8000&pathname=%2F&secure=false&useProxy=true',
            'action=device&udid=PIXEL&view=shell&hostname=10.0.0.5&port=8000&pathname=%2F&secure=false&useProxy=true',
            { page: 'device', udid: 'PIXEL', view: 'shell' },
            'android',
        ],
    ];
    for (const [old, current, page, platform] of cases) {
        assert.equal(routes.canonicalRoute(usp(old)).toString(), usp(current).toString(), old);
        assert.deepEqual(routes.parseRoute(usp(old)), { ...page, platform }, `${old} is read as the same page`);
        assert.deepEqual(routes.parseRoute(usp(current)), page);
        const kept = usp(current);
        assert.equal(routes.canonicalRoute(kept), kept, 'an address in the new form is left as it is');
        // The clients still parse the older action, which is also the action of their sockets.
        assert.equal(routes.clientParams(usp(current), platform).toString(), usp(old).toString());
    }
    // An address that names no view, or one that does not exist, is the screen.
    assert.equal(routes.canonicalRoute(usp('action=device&udid=PIXEL')).toString(), 'action=device&udid=PIXEL&view=screen');
    assert.deepEqual(routes.parseRoute(usp('action=device&udid=PIXEL&view=kitchen')), { page: 'device', udid: 'PIXEL', view: 'screen' });
    assert.equal(routes.deviceRoute('PIXEL', 'shell').toString(), 'action=device&udid=PIXEL&view=shell');
    assert.equal(routes.deviceRoute('PIXEL', 'screen', { player: 'mse', ws: undefined }).toString(), 'action=device&udid=PIXEL&view=screen&player=mse');
    // Anything else is the list, as it was: no udid, or an action the app does not have.
    for (const other of ['', 'action=', 'action=device', 'action=stream', 'action=devtools&udid=PIXEL', 'title=x'])
        assert.deepEqual(routes.parseRoute(usp(other)), { page: 'list' }, `"${other}" is the list`);
});

test('Files has the address of the phone page, and its older address is rewritten to it', () => {
    // FileListingClient reads the route, so Files keeps no address of its own.
    const { routes } = open();
    const old = 'action=list-files&udid=PIXEL&path=%2Fsdcard%2FDCIM';
    const current = 'action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM';
    assert.equal(routes.canonicalRoute(usp(old)).toString(), current);
    assert.deepEqual(routes.parseRoute(usp(old)), { page: 'device', udid: 'PIXEL', view: 'files', platform: 'android' });
    assert.deepEqual(routes.parseRoute(usp(current)), { page: 'device', udid: 'PIXEL', view: 'files' });
    const kept = usp(current);
    assert.equal(routes.canonicalRoute(kept), kept, 'a link in the new form is left as it is');
    assert.equal(routes.deviceRoute('PIXEL', 'files', { path: '/sdcard/DCIM' }).toString(), current);
    // The explorer still opens its socket under the older action.
    assert.equal(routes.clientParams(usp(current)).toString(), old);
    // An older Files link still opens Files: it is rewritten in place before a view reads it.
    const tab = open(`#!${old}`);
    assert.equal(tab.browser.location.hash, `#!${current}`);
    assert.equal(tab.browser.hashes().length, 1);
    assert.deepEqual(tab.shown, [current]);
});

test('the tabs of a phone page and the name of the list are the ones the owner chose', () => {
    const { routes } = open();
    assert.equal(routes.LIST_PAGE_NAME, 'Phones');
    assert.deepEqual(routes.DEVICE_TABS.android.map((tab) => tab.title), ['Screen', 'Files', 'Shell']);
    assert.deepEqual(routes.DEVICE_TABS.ios.map((tab) => tab.title), ['Screen']);
});

test('an older link is rewritten in place before anything reads the route', () => {
    for (const [old, current, platform] of [
        [`#!action=stream&udid=PIXEL&player=mse&ws=${encodeURIComponent(SOCKET)}`, `#!action=device&udid=PIXEL&view=screen&player=mse&ws=${encodeURIComponent(SOCKET)}`, 'android'],
        ['#!action=stream-coredevice&udid=IPHONE', '#!action=device&udid=IPHONE&view=screen', 'ios'],
        ['#!action=shell&udid=PIXEL', '#!action=device&udid=PIXEL&view=shell', undefined],
    ]) {
        const { browser, routes, shown } = open(old);
        assert.deepEqual(browser.hashes(), [usp(current.slice(2)).toString()].map((value) => `#!${value}`), 'the one entry has the new address');
        assert.deepEqual(shown, [usp(current.slice(2)).toString()], 'the route has had one value: no view mounts twice');
        // The older address named the platform. The new one does not, so this browser keeps it.
        const udid = usp(current.slice(2)).get('udid');
        assert.equal(routes.rememberedPhone(udid)?.platform, platform);
    }
});

test('what an older link said about the platform survives a reload, and blocked storage does not break the page', () => {
    const first = open('#!action=stream-coredevice&udid=IPHONE');
    const reloaded = open('#!action=device&udid=IPHONE&view=screen', { storage: first.storage });
    assert.equal(reloaded.routes.rememberedPhone('IPHONE').platform, 'ios');
    reloaded.routes.rememberPhone('IPHONE', 'ios', 'Bench iPhone');
    reloaded.routes.rememberPhone('IPHONE', 'ios');
    assert.deepEqual(open('', { storage: first.storage }).routes.rememberedPhone('IPHONE'), { platform: 'ios', name: 'Bench iPhone' });
    assert.equal(open('', { storage: fakeStorage({ 'ws-scrcpy.phones': '{broken' }) }).routes.rememberedPhone('IPHONE'), undefined);

    const blocked = {
        getItem: () => {
            throw Error('blocked');
        },
        setItem: () => {
            throw Error('blocked');
        },
    };
    const { routes, shown } = open('#!action=stream-coredevice&udid=IPHONE', { storage: blocked });
    assert.deepEqual(shown, ['action=device&udid=IPHONE&view=screen']);
    assert.equal(routes.rememberedPhone('IPHONE').platform, 'ios', 'it is still known for as long as the page is open');
});

test('push links that are already delivered open the same pages', () => {
    const { routes } = open();
    const banner = 'action=notifications&source=phone-a&notification=history-key';
    assert.deepEqual(routes.parseRoute(usp(banner)), { page: 'notifications' });
    assert.deepEqual(routes.parseRoute(usp('action=notifications&source=phone-a&udid=phone-a')), { page: 'notifications' });
    assert.deepEqual(routes.parseRoute(usp('action=')), { page: 'list' });
    for (const hash of [`#!${banner}`, '#!action=notifications', '#!action=', '#!', '']) {
        const { browser, shown } = open(hash);
        assert.deepEqual(browser.hashes(), [hash], `${hash || 'no fragment'} is left as delivered`);
        assert.deepEqual(shown, [hash.replace(/^#!/, '')]);
    }
});

test('open pushes, switch replaces, and up goes back to the list', () => {
    const { browser, router, shown } = open('#!');
    router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    assert.deepEqual(browser.hashes(), ['#!', '#!action=device&udid=PIXEL&view=screen'], 'open adds an entry');
    router.switchRoute(usp('action=device&udid=PIXEL&view=shell'));
    assert.deepEqual(browser.hashes(), ['#!', '#!action=device&udid=PIXEL&view=shell'], 'switch changes the entry');
    router.switchRoute({ action: 'stream-coredevice', udid: 'IPHONE' });
    assert.deepEqual(browser.hashes(), ['#!', '#!action=device&udid=IPHONE&view=screen'], 'a verb takes either form');
    router.openRoute({ action: 'device', udid: 'IPHONE', view: 'screen' });
    assert.equal(browser.hashes().length, 2, 'opening the page that is shown adds nothing');

    router.goUp();
    browser.settle();
    assert.equal(browser.index, 0, 'up went back to the list entry');
    assert.equal(browser.hashes().length, 2, 'and added none');
    assert.deepEqual(browser.behind(), [], 'Back from the list has nothing of the app to show');
    assert.deepEqual(shown, ['', 'action=device&udid=PIXEL&view=screen', 'action=device&udid=PIXEL&view=shell', 'action=device&udid=IPHONE&view=screen', 'action=device&udid=IPHONE&view=screen', '']);
});

test('up on a page the tab was opened on replaces it with the list', () => {
    const { browser, router, shown } = open('#!action=stream-coredevice&udid=IPHONE');
    router.goUp();
    browser.settle();
    assert.deepEqual(browser.hashes(), ['#!'], 'the entry of the stream is the list now');
    assert.deepEqual(shown, ['action=device&udid=IPHONE&view=screen', '']);
    router.goUp();
    browser.settle();
    assert.deepEqual(browser.hashes(), ['#!'], 'up on the list does nothing');
});

test('the earlier exports are shims: returning to the list no longer adds an entry', () => {
    const { browser, router } = open('#!');
    router.navigate({ action: 'stream', udid: 'PIXEL', player: 'mse', ws: SOCKET });
    assert.equal(browser.hashes().length, 2, 'navigate opens');
    assert.match(browser.location.hash, /^#!action=device&udid=PIXEL&view=screen&player=mse&ws=/);
    router.goToDeviceList();
    browser.settle();
    assert.equal(browser.hashes().length, 2, 'goToDeviceList pushed an entry before');
    assert.equal(browser.index, 0);
    assert.deepEqual(browser.behind().filter(isStream), [], 'Back after the in-app Back never shows a stream');

    // Files: a folder step pushes with its own state, a corrected address replaces, and the
    // router's bookkeeping and the explorer's share history.state.
    const files = open('#!action=device&udid=PIXEL&view=files&path=%2Fsdcard');
    files.router.replaceRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard'), { files: { id: 'run', index: 0 } });
    files.router.pushRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM'), { ...files.browser.history.state, files: { id: 'run', index: 1 } });
    assert.equal(files.browser.hashes().length, 2);
    assert.deepEqual(files.browser.history.state.files, { id: 'run', index: 1 });
    assert.equal(files.browser.history.state.nav.index, 1);
    files.router.pushRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM'));
    assert.equal(files.browser.hashes().length, 2, 'a push to the address that is shown adds nothing');
    files.router.replaceRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM%2FCamera'));
    assert.equal(files.browser.hashes().length, 2);
    assert.deepEqual(files.browser.history.state.files, { id: 'run', index: 1 }, 'replaceRoute keeps the state of the entry');
    assert.deepEqual(files.shown.at(-1), 'action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM%2FCamera');
    files.router.switchRoute({ action: 'device', udid: 'PIXEL', view: 'shell' });
    assert.equal(files.browser.history.state.files, undefined, 'another view does not inherit the explorer state');
    files.browser.history.back();
    files.browser.settle();
    assert.equal(files.shown.at(-1), 'action=device&udid=PIXEL&view=files&path=%2Fsdcard', 'Back between folder steps still moves the route');
});

test('views that still assign location.hash: up goes to the list, not to the stream before', () => {
    const { browser, router, shown } = open('#!');
    // A card link, then two Switches. Each is an assigned hash in the older form, so each is an
    // entry of its own until the views call the router (step 3b).
    browser.location.hash = `#!action=stream&udid=PIXEL&player=mse&ws=${encodeURIComponent(SOCKET)}`;
    browser.settle();
    assert.match(browser.location.hash, /^#!action=device&udid=PIXEL&view=screen&player=mse/, 'the assigned address is rewritten in place');
    assert.equal(browser.hashes().length, 2);
    browser.location.hash = '#!action=stream-coredevice&udid=IPHONE';
    browser.settle();
    browser.location.hash = '#!action=shell&udid=PIXEL';
    browser.settle();
    assert.equal(browser.hashes().length, 4);
    const before = shown.length;
    router.goUp();
    browser.settle();
    assert.equal(browser.index, 0, 'up lands on the list entry, three entries back');
    assert.deepEqual(shown.slice(before), [''], 'no stream was shown on the way');
    assert.deepEqual(browser.behind(), []);
});

test('a tab opened on a phone, then switched by an assigned hash: up leaves no stream behind the list', () => {
    const { browser, router, shown } = open('#!action=stream-coredevice&udid=IPHONE');
    browser.location.hash = '#!action=stream-coredevice&udid=IPHONE-2';
    browser.settle();
    router.goUp();
    browser.settle();
    assert.equal(browser.index, 0, 'the first entry the app has in the tab');
    assert.equal(browser.location.hash, '#!', 'is the list now');
    assert.deepEqual(browser.behind().filter(isStream), []);
    assert.deepEqual(shown, ['action=device&udid=IPHONE&view=screen', 'action=device&udid=IPHONE-2&view=screen', '']);
});

test('a screen opened from a notification: up is the list, the browser Back is the notification', () => {
    const { browser, router } = open('#!');
    router.openRoute({ action: 'notifications', source: 'IPHONE' });
    router.navigate({ action: 'stream-coredevice', udid: 'IPHONE' });
    assert.deepEqual(browser.behind(), ['#!action=notifications&source=IPHONE', '#!']);
    router.goUp();
    browser.settle();
    assert.equal(browser.location.hash, '#!');
    assert.equal(browser.index, 0);
});

test('a write made while up is under way waits for it, and a step the browser never reports is given up', async () => {
    // The back control, then a card at once: the new page is opened from the list entry, so
    // the phone that was shown is not left behind the list.
    const { browser, router } = open('#!');
    router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    router.goUp();
    router.openRoute({ action: 'device', udid: 'IPHONE', view: 'screen' });
    assert.equal(browser.location.hash, '#!action=device&udid=PIXEL&view=screen', 'nothing is written before the list is reached');
    browser.settle();
    assert.deepEqual(browser.hashes(), ['#!', '#!action=device&udid=IPHONE&view=screen']);
    assert.deepEqual(browser.behind(), ['#!']);

    // An entry that says the list is two steps back when it is not there (an entry left from an
    // earlier version of the app): the browser does nothing and reports nothing. After the wait
    // the page becomes the list in place, and writes are no longer held.
    const stale = open('#!action=device&udid=PIXEL&view=screen', { state: { nav: { index: 2, below: 0 } } });
    stale.router.goUp();
    stale.browser.settle();
    assert.equal(stale.browser.location.hash, '#!action=device&udid=PIXEL&view=screen');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepEqual(stale.browser.hashes(), ['#!']);
    assert.equal(stale.shown.at(-1), '');
    stale.router.openRoute({ action: 'device', udid: 'IPHONE', view: 'screen' });
    assert.deepEqual(stale.browser.hashes(), ['#!', '#!action=device&udid=IPHONE&view=screen']);
});

test('a change within the page written while up is under way is dropped, so the page is not shown again', () => {
    // Files answers a folder step just after the back control: the corrected path and the step
    // belong to Files, which is no longer shown once the list is reached.
    const { browser, router, shown } = open('#!');
    router.openRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard'));
    router.goUp();
    router.replaceRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard%2F'));
    router.pushRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM'));
    browser.settle();
    assert.equal(browser.location.hash, '#!', 'the list is shown');
    assert.equal(browser.index, 0);
    assert.deepEqual(browser.hashes(), ['#!', '#!action=device&udid=PIXEL&view=files&path=%2Fsdcard'], 'the list entry is not overwritten');
    assert.equal(shown.at(-1), '');

    // Another player for the stream that is being left: no stream is started again.
    const stream = open('#!');
    stream.router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    stream.router.goUp();
    stream.router.navigate({ action: 'device', udid: 'PIXEL', view: 'screen', player: 'mse' });
    stream.browser.settle();
    assert.equal(stream.browser.location.hash, '#!');
    assert.deepEqual(stream.shown.filter(isStream), ['action=device&udid=PIXEL&view=screen']);

    // Without a step under way, a change within the page is written at once.
    const files = open('#!action=device&udid=PIXEL&view=files&path=%2Fsdcard');
    files.router.replaceRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard%2F'));
    assert.equal(files.browser.location.hash, '#!action=device&udid=PIXEL&view=files&path=%2Fsdcard%2F');
});

test('a page change is another page or view, not a folder, a corrected path or a filter', () => {
    const { browser, router, routes } = open('#!action=device&udid=PIXEL&view=files&path=%2Fsdcard');
    const changes = [];
    router.onPageChange(() => changes.push(browser.location.hash));
    router.replaceRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard%2F'));
    router.pushRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM'));
    browser.history.back();
    browser.settle();
    assert.deepEqual(changes, [], 'Files folders and a corrected path are the same page');
    router.switchRoute({ action: 'device', udid: 'PIXEL', view: 'shell' });
    router.switchRoute({ action: 'device', udid: 'PIXEL-2', view: 'shell' });
    router.openRoute({ action: 'notifications' });
    router.switchRoute({ action: 'notifications', filter: 'unread' });
    router.goUp();
    browser.settle();
    assert.deepEqual(changes, [
        '#!action=device&udid=PIXEL&view=shell',
        '#!action=device&udid=PIXEL-2&view=shell',
        '#!action=notifications',
        '#!',
    ]);
    // Both forms of an address are the same page.
    assert.equal(routes.samePage(usp('action=stream-coredevice&udid=IPHONE'), usp('action=device&udid=IPHONE&view=screen')), true);
    assert.equal(routes.samePage(usp('action=device&udid=PIXEL&view=screen&player=mse'), usp('action=device&udid=PIXEL&view=screen')), true);
    assert.equal(routes.samePage(usp(''), usp('action=')), true);
    assert.equal(routes.samePage(usp('action=device&udid=PIXEL&view=screen'), usp('action=device&udid=PIXEL&view=files')), false);
});

test('a reload keeps the place in history, so up still goes back', () => {
    const first = open('#!');
    first.router.openRoute({ action: 'device', udid: 'IPHONE', view: 'screen' });
    // The same tab after a reload: one document, the same entries and states.
    const state = first.browser.history.state;
    const reloaded = open('#!action=device&udid=IPHONE&view=screen', { state });
    assert.deepEqual(reloaded.browser.history.state.nav, state.nav);
});

test('uploads in progress: the owner is asked before a verb or the browser leaves the page', async () => {
    const { browser, router, shown } = open('#!action=device&udid=PIXEL&view=files&path=%2Fsdcard');
    let answer = false;
    let asked = 0;
    const guard = {
        blocks: (next) => next.get('view') !== 'files',
        ask: () => {
            asked++;
            return Promise.resolve(answer);
        },
    };
    router.setLeaveGuard(guard);
    router.goToDeviceList();
    await Promise.resolve();
    browser.settle();
    assert.equal(asked, 1);
    assert.equal(browser.location.hash, '#!action=device&udid=PIXEL&view=files&path=%2Fsdcard', 'refused: the page stays');
    router.pushRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM'));
    assert.equal(asked, 1, 'a folder step is not leaving');

    // The browser's Back has already moved when the app hears of it.
    browser.location.hash = '#!action=shell&udid=PIXEL';
    browser.settle();
    await Promise.resolve();
    assert.equal(asked, 2);
    assert.equal(browser.location.hash, '#!action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM', 'the address of the page is put back');
    assert.equal(shown.at(-1), 'action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM');

    assert.deepEqual(browser.behind(), ['#!action=device&udid=PIXEL&view=files&path=%2Fsdcard'], 'the refused page is not what Back leads to');

    answer = true;
    router.openRoute({ action: 'device', udid: 'PIXEL', view: 'shell' });
    await Promise.resolve();
    browser.settle();
    assert.equal(asked, 3);
    assert.equal(shown.at(-1), 'action=device&udid=PIXEL&view=shell', 'allowed: the page is left');

    // The browser's own Back and a tab that assigns the hash, refused and then allowed.
    const tab = open('#!');
    tab.router.openRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard'));
    const answers = [false, true, false, true];
    tab.router.setLeaveGuard({ blocks: (next) => next.get('view') !== 'files', ask: () => Promise.resolve(answers.shift()) });
    const settled = async () => {
        tab.browser.settle();
        await Promise.resolve();
        tab.browser.settle();
    };
    tab.browser.history.back();
    await settled();
    assert.equal(tab.browser.index, 1, 'Back refused: still on Files');
    assert.equal(tab.shown.at(-1), 'action=device&udid=PIXEL&view=files&path=%2Fsdcard');
    tab.browser.history.back();
    await settled();
    assert.equal(tab.browser.index, 0, 'Back allowed: the list');
    assert.equal(tab.shown.at(-1), '');

    tab.router.openRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard'));
    tab.router.setLeaveGuard({ blocks: (next) => next.get('view') !== 'files', ask: () => Promise.resolve(answers.shift()) });
    tab.browser.location.hash = '#!action=shell&udid=PIXEL';
    await settled();
    assert.equal(tab.browser.location.hash, '#!action=device&udid=PIXEL&view=files&path=%2Fsdcard', 'tab refused: still on Files');
    tab.browser.location.hash = '#!action=shell&udid=PIXEL';
    await settled();
    assert.equal(tab.shown.at(-1), 'action=device&udid=PIXEL&view=shell', 'tab allowed: Shell');
    assert.deepEqual(tab.browser.behind(), ['#!action=device&udid=PIXEL&view=files&path=%2Fsdcard', '#!']);
});

test('an overlay has a history entry: Back closes it and leaves the page alone', async () => {
    const { browser, router, shown } = open('#!');
    router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    const page = browser.location.hash;
    const closed = [];
    router.pushOverlay(() => closed.push('actions'));
    await tick();
    assert.deepEqual(browser.hashes(), ['#!', page, page], 'the entry has the address of the page');
    router.pushOverlay(() => closed.push('confirm'));
    await tick();
    assert.equal(browser.hashes().length, 4);
    const routes = shown.length;

    browser.history.back();
    browser.settle();
    assert.deepEqual(closed, ['confirm'], 'Back closes the top overlay only');
    browser.history.back();
    browser.settle();
    assert.deepEqual(closed, ['confirm', 'actions']);
    assert.equal(browser.index, 1, 'the page is still the entry that is shown');
    assert.equal(shown.length, routes, 'and the route did not change, so the stream was not touched');

    // Forward lands on an entry whose overlay is gone. It is stepped back over.
    browser.history.forward();
    browser.settle();
    assert.equal(browser.index, 1);
    assert.deepEqual(closed, ['confirm', 'actions']);
});

test('an overlay that closes by itself steps back over its entry', async () => {
    const { browser, router } = open('#!');
    const closed = [];
    const sheet = router.pushOverlay(() => closed.push('settings'));
    assert.equal(browser.index, 0, 'the entry is made when the running code is done');
    await tick();
    assert.equal(browser.index, 1);
    sheet.release();
    sheet.release();
    await settled(browser);
    assert.equal(browser.index, 0, 'the close button, the backdrop and Escape end where history.back() would');
    assert.deepEqual(closed, [], 'the overlay was closed already; it is not told again');
    assert.equal(browser.steps, 1);

    // One sheet takes the place of another in the same task (Actions to Unlock). The entry is
    // kept: no step back, and no new entry made after one, which a browser could take for an
    // entry added without a press.
    const first = router.pushOverlay(() => closed.push('first'));
    await tick();
    const entry = browser.history.state;
    first.release();
    const second = router.pushOverlay(() => closed.push('second'));
    await settled(browser);
    assert.deepEqual(browser.hashes(), ['#!', '#!'], 'one overlay entry, not two');
    assert.equal(browser.index, 1);
    // The other order: the router hears of the new one first.
    const third = router.pushOverlay(() => closed.push('third'));
    second.release();
    await settled(browser);
    assert.equal(browser.index, 1, 'one entry is left');
    assert.equal(browser.history.state, entry, 'the same entry: none was added in its place');
    assert.equal(browser.steps, 1, 'and no step through history was made');
    assert.deepEqual(closed, [], 'the newer overlay is not told to close');
    browser.history.back();
    browser.settle();
    assert.deepEqual(closed, ['third']);
    assert.equal(browser.index, 0);
    third.release();
    await settled(browser);
    assert.equal(browser.index, 0, 'an overlay that Back closed has no entry left to step over');
});

test('overlays stack: one that closes under another leaves the other open, with an entry', async () => {
    // The controls panel with a sheet opened from it: the panel closes, the sheet stays.
    const { browser, router, shown } = open('#!');
    router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    const closed = [];
    const panel = router.pushOverlay(() => closed.push('panel'));
    router.pushOverlay(() => closed.push('sheet'));
    const confirm = router.pushOverlay(() => closed.push('confirm'));
    await tick();
    assert.equal(browser.index, 4);
    assert.equal(browser.history.state.nav.overlay, 3, 'the entries count up from the page');
    panel.release();
    await settled(browser);
    assert.deepEqual(closed, [], 'the two above it stay open');
    assert.equal(browser.index, 3, 'one entry fewer');

    // Back closes the top one, then the next: last opened, first closed.
    browser.history.back();
    browser.settle();
    assert.deepEqual(closed, ['confirm']);
    confirm.release();
    await settled(browser);
    assert.equal(browser.index, 2, 'releasing an overlay that Back closed changes nothing');
    browser.history.back();
    browser.settle();
    assert.deepEqual(closed, ['confirm', 'sheet']);
    assert.equal(browser.index, 1, 'the page is the entry that is shown');
    assert.equal(shown.at(-1), 'action=device&udid=PIXEL&view=screen');

    // Released from the top down, as a sheet with a dialog in it unmounts.
    const one = router.pushOverlay(() => closed.push('one'));
    const two = router.pushOverlay(() => closed.push('two'));
    await tick();
    assert.equal(browser.index, 3);
    two.release();
    one.release();
    await settled(browser);
    assert.equal(browser.index, 1);
    assert.deepEqual(closed, ['confirm', 'sheet']);

    // None is open when the page changes, and Back from the page is the list.
    router.switchRoute({ action: 'device', udid: 'IPHONE', view: 'screen' });
    browser.settle();
    assert.deepEqual(closed, ['confirm', 'sheet']);
    assert.deepEqual(browser.behind(), ['#!']);
    assert.equal(shown.at(-1), 'action=device&udid=IPHONE&view=screen');
});

test('a change within the page made while an overlay is open keeps it open and ends up on the page entry', async () => {
    const sdcard = 'action=device&udid=PIXEL&view=files&path=%2Fsdcard';
    const corrected = 'action=device&udid=PIXEL&view=files&path=%2Fsdcard%2F';
    const { browser, router, shown } = open('#!');
    router.openRoute(usp(sdcard));
    const closed = [];
    router.pushOverlay(() => closed.push('dialog'));
    await tick();
    // A listing arrives and corrects the path, and Files tags the entry with its own state.
    router.replaceRoute(usp(corrected), { ...browser.history.state, files: { id: 'run', index: 0 } });
    assert.deepEqual(closed, [], 'the dialog stays open');
    assert.equal(browser.steps, 0, 'and no step through history is made');
    assert.equal(browser.index, 2);
    assert.equal(shown.at(-1), corrected, 'the route has the new address at once');
    assert.equal(browser.history.state.nav.overlay, 1, 'the tab is still on the overlay entry');
    // The same address with other state, as Files writes when a listing is shown.
    router.replaceRoute(usp(corrected), { ...browser.history.state, files: { id: 'run', index: 1 } });
    assert.deepEqual(closed, []);
    const routes = shown.length;

    // Back closes the dialog. The page entry now has the corrected path and the state.
    browser.history.back();
    browser.settle();
    assert.deepEqual(closed, ['dialog']);
    assert.equal(browser.index, 1);
    assert.deepEqual(browser.hashes().slice(0, 2), ['#!', `#!${corrected}`], 'the address is on the entry of the page');
    assert.deepEqual(browser.history.state, { nav: { index: 1, below: 0 }, files: { id: 'run', index: 1 } });
    assert.equal(shown.length, routes, 'the route is not set again, so the page is not mounted again');
    assert.deepEqual(browser.behind(), ['#!'], 'Back from the page is the list, not the path before');

    // Two overlays, a filter written from the top one, and both closed by their own buttons.
    const inbox = open('#!');
    inbox.router.openRoute({ action: 'notifications', source: 'IPHONE' });
    const sheet = inbox.router.pushOverlay(() => closed.push('sheet'));
    const menu = inbox.router.pushOverlay(() => closed.push('menu'));
    await tick();
    inbox.router.switchRoute({ action: 'notifications', source: 'IPHONE', filter: 'unread' });
    assert.equal(inbox.browser.steps, 0);
    assert.equal(inbox.shown.at(-1), 'action=notifications&source=IPHONE&filter=unread');
    menu.release();
    await settled(inbox.browser);
    assert.equal(inbox.browser.index, 2);
    assert.equal(inbox.browser.location.hash, '#!action=notifications&source=IPHONE&filter=unread', 'the entry of the sheet below takes it');
    sheet.release();
    await settled(inbox.browser);
    assert.equal(inbox.browser.index, 1);
    assert.deepEqual(inbox.browser.hashes().slice(0, 2), ['#!', '#!action=notifications&source=IPHONE&filter=unread']);
    assert.deepEqual(inbox.browser.history.state.nav, { index: 1, below: 0 });
    assert.deepEqual(closed, ['dialog'], 'neither was told to close');
    assert.equal(inbox.shown.filter((value) => value.includes('filter=unread')).length, 1);

    // Another page from under an overlay with such a change: the page entry takes the change
    // first, so Back from the new page shows the filter that was chosen.
    inbox.router.pushOverlay(() => closed.push('actions'));
    await tick();
    inbox.router.switchRoute({ action: 'notifications', source: 'IPHONE', filter: 'all' });
    inbox.router.openRoute({ action: 'device', udid: 'IPHONE', view: 'screen' });
    assert.deepEqual(closed, ['dialog', 'actions'], 'another page closes the overlay');
    inbox.browser.settle();
    assert.deepEqual(inbox.browser.hashes(), ['#!', '#!action=notifications&source=IPHONE&filter=all', '#!action=device&udid=IPHONE&view=screen']);

    // A step within the page that adds an entry (a Files folder) still closes the overlays.
    const files = open(`#!${sdcard}`);
    files.router.pushOverlay(() => closed.push('menu'));
    await tick();
    files.router.pushRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM'));
    files.browser.settle();
    assert.deepEqual(closed, ['dialog', 'actions', 'menu']);
    assert.deepEqual(files.browser.hashes(), [`#!${sdcard}`, '#!action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM']);

    // A reload while the change is still on the overlay's entry: the page entry takes it then.
    const tab = open('#!');
    tab.router.openRoute(usp(sdcard));
    tab.router.pushOverlay(() => {});
    await tick();
    tab.router.replaceRoute(usp(corrected));
    const again = open('', { browser: tab.browser.reloaded() });
    again.browser.settle();
    assert.equal(again.browser.index, 1);
    assert.deepEqual(again.browser.hashes().slice(0, 2), ['#!', `#!${corrected}`]);
    assert.deepEqual(again.shown, [corrected], 'the reloaded page is shown once, under the corrected address');
});

test('a sheet that code opens without a press adds no entry, and still closes with its page', async () => {
    const { browser, router } = open('#!');
    const { openOverlay } = require('../src/app/ui/overlayHistory');
    router.openRoute({ action: 'device', udid: 'IPHONE', view: 'screen' });
    const closed = [];
    // Nothing has been pressed since the page loaded. Chrome would skip such an entry on Back,
    // and the stream page with it.
    openOverlay(() => closed.push('by code'));
    await tick();
    assert.equal(browser.hashes().length, 2, 'no entry');
    browser.history.back();
    browser.settle();
    assert.equal(browser.index, 0, 'Back leaves the page');
    assert.deepEqual(closed, ['by code'], 'and the sheet closes with it');

    // After a press an overlay has an entry. Escape is no press to a browser, and neither is
    // an event a script made.
    const presses = [
        [() => browser.press('Escape'), 0],
        [() => browser.press(undefined, false), 0],
        [() => browser.press(), 1],
        [() => browser.press('k'), 1],
    ];
    for (const [press, entries] of presses) {
        press();
        const sheet = openOverlay(() => closed.push('sheet'));
        await tick();
        assert.equal(browser.index, entries);
        sheet.release();
        await settled(browser);
        assert.equal(browser.index, 0);
    }

    // A press made before the last Back does not count, as it does not to Chrome.
    browser.press();
    openOverlay(() => closed.push('first'));
    await tick();
    assert.equal(browser.index, 1);
    browser.history.back();
    browser.settle();
    assert.deepEqual(closed, ['by code', 'first']);
    const late = openOverlay(() => closed.push('late'));
    await tick();
    assert.equal(browser.index, 0, 'no entry for a sheet opened after Back without a press');
    late.release();
    // Nor one made before a step the router took itself (a sheet closed by its button).
    browser.press();
    const second = openOverlay(() => closed.push('second'));
    await tick();
    assert.equal(browser.index, 1);
    second.release();
    await settled(browser);
    const after = openOverlay(() => closed.push('after a step'));
    await tick();
    assert.equal(browser.index, 0);
    after.release();

    // A caller can say so itself, either way.
    const forced = openOverlay(() => closed.push('forced'), { entry: true });
    await tick();
    assert.equal(browser.index, 1);
    forced.release();
    await settled(browser);
    browser.press();
    const plain = openOverlay(() => closed.push('plain'), { entry: false });
    await tick();
    assert.equal(browser.index, 0);

    // One without an entry on top of one with: Back closes both, the top one first.
    const steps = browser.steps;
    const under = router.pushOverlay(() => closed.push('under'));
    router.pushOverlay(() => closed.push('over'), { entry: false });
    await tick();
    assert.equal(browser.index, 1);
    closed.length = 0;
    browser.history.back();
    browser.settle();
    assert.deepEqual(closed, ['over', 'under'], 'what was opened on top of it goes with it');
    assert.equal(browser.index, 0);
    under.release();
    // The one opened before them has no entry and is still open. A change within the page
    // leaves it open; another page closes it.
    router.switchRoute({ action: '' });
    assert.deepEqual(closed, ['over', 'under']);
    router.openRoute({ action: 'notifications' });
    assert.deepEqual(closed, ['over', 'under', 'plain']);
    plain.release();
    await settled(browser);
    assert.equal(browser.steps, steps + 1, 'releasing an overlay without an entry makes no step');
});

test('an overlay that may not close now stays open on Back, and closes with its page', async () => {
    // Stream settings while a change is being applied, and a sheet with a confirm prompt in it.
    const { browser, router, shown } = open('#!');
    router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    const closed = [];
    let busy = true;
    let asked = 0;
    router.pushOverlay(() => closed.push('settings'), { stays: () => (asked++, busy) });
    await tick();
    const entries = browser.hashes().length;
    browser.history.back();
    browser.settle();
    assert.equal(asked, 1);
    assert.deepEqual(closed, [], 'the sheet is not closed');
    assert.equal(browser.index, 2, 'the tab is on the entry of the sheet again');
    assert.equal(browser.hashes().length, entries, 'by a step forward: no entry is added');
    assert.equal(shown.at(-1), 'action=device&udid=PIXEL&view=screen', 'the page under it is not left');
    // Back closes it once it may close.
    busy = false;
    browser.history.back();
    browser.settle();
    assert.deepEqual(closed, ['settings']);
    assert.equal(browser.index, 1);

    // Another page closes it whatever it says: a sheet never shows over another page.
    busy = true;
    router.pushOverlay(() => closed.push('applying'), { stays: () => busy });
    await tick();
    router.goUp();
    browser.settle();
    assert.deepEqual(closed, ['settings', 'applying']);
    assert.equal(browser.location.hash, '#!');
    // Also when the browser goes there in one step, past the page.
    router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    router.pushOverlay(() => closed.push('held'), { stays: () => true });
    await tick();
    browser.history.go(-2);
    browser.settle();
    assert.deepEqual(closed, ['settings', 'applying', 'held']);
    assert.equal(browser.index, 0);
});

test('a route change closes every overlay, and the new address is written on the page entry', async () => {
    // Switch phone is a sheet: choosing a phone replaces the page under the sheet, not the sheet's entry.
    const { browser, router, shown } = open('#!');
    router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    const closed = [];
    router.pushOverlay(() => closed.push('switcher'));
    await tick();
    router.switchRoute({ action: 'device', udid: 'IPHONE', view: 'screen' });
    assert.deepEqual(closed, ['switcher'], 'the overlay closes at once');
    browser.settle();
    assert.deepEqual(browser.hashes().slice(0, 2), ['#!', '#!action=device&udid=IPHONE&view=screen']);
    assert.equal(browser.index, 1);
    assert.deepEqual(browser.behind(), ['#!'], 'Back from the new phone is the list, not the phone before');
    assert.deepEqual(shown.slice(-2), ['action=device&udid=PIXEL&view=screen', 'action=device&udid=IPHONE&view=screen']);
    // Forward reaches the switcher's entry, which still has the address of the phone before. It
    // is stepped back over, and the phone before is not shown on the way: its stream would start.
    assert.equal(browser.hashes()[2], '#!action=device&udid=PIXEL&view=screen', 'the entry of the switcher is ahead');
    const routes = shown.length;
    browser.history.forward();
    browser.settle();
    assert.equal(browser.index, 1);
    assert.equal(browser.location.hash, '#!action=device&udid=IPHONE&view=screen');
    assert.equal(shown.length, routes, 'nothing else is shown');
    assert.deepEqual(browser.behind(), ['#!']);

    // Open from inside an overlay, and up from inside an overlay.
    router.pushOverlay(() => closed.push('menu'));
    await tick();
    router.openRoute({ action: 'notifications', source: 'IPHONE' });
    browser.settle();
    assert.deepEqual(browser.hashes(), ['#!', '#!action=device&udid=IPHONE&view=screen', '#!action=notifications&source=IPHONE']);
    router.pushOverlay(() => closed.push('card menu'));
    await tick();
    router.goUp();
    browser.settle();
    assert.deepEqual(closed, ['switcher', 'menu', 'card menu']);
    assert.equal(browser.index, 0);
    assert.equal(browser.location.hash, '#!');

    // An address that arrives from outside the router (a link, a typed address) closes them too.
    router.pushOverlay(() => closed.push('settings'));
    await tick();
    browser.location.hash = '#!action=notifications';
    browser.settle();
    assert.deepEqual(closed, ['switcher', 'menu', 'card menu', 'settings']);
    // Up from there still finds the list, with the left-over overlay entry between them.
    router.goUp();
    browser.settle();
    assert.equal(browser.index, 0);
});

test('a page reloaded with an overlay open goes back to the page entry', async () => {
    const first = open('#!');
    first.router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    first.router.pushOverlay(() => {});
    await tick();
    assert.equal(first.browser.history.state.nav.overlay, 1);
    // The reloaded document starts on the overlay's entry, with the page entry below it.
    const { browser, shown } = open('', { browser: first.browser.reloaded() });
    browser.settle();
    assert.equal(browser.index, 1, 'Back is not spent on an overlay that is no longer open');
    assert.deepEqual(shown, ['action=device&udid=PIXEL&view=screen'], 'the page is shown once');
    // Forward from there is the entry of an overlay that is gone. It is stepped back over.
    browser.history.forward();
    browser.settle();
    assert.equal(browser.index, 1);
    assert.deepEqual(browser.behind(), ['#!'], 'and Back leaves the page in one step');
});

test('links: a phone link names the phone and the view only, and following one goes through the router', () => {
    const { browser } = open('#!');
    const links = require('../src/app/state/links');
    const local = { type: 'android', secure: false, hostname: 'phones.test', port: 8000, pathname: '/' };
    const screen = links.deviceHref('PIXEL', 'screen', local);
    assert.equal(screen, 'http://phones.test:8000/#!action=device&udid=PIXEL&view=screen', 'no player and no socket in the link');
    assert.equal(links.deviceHref('PIXEL', 'shell', local), 'http://phones.test:8000/#!action=device&udid=PIXEL&view=shell');
    const proxied = links.deviceHref('PIXEL', 'screen', { type: 'android', secure: false, hostname: '10.0.0.5', port: 8000, pathname: '/', useProxy: true });
    assert.equal(proxied, 'http://phones.test:8000/#!action=device&udid=PIXEL&view=screen&hostname=10.0.0.5&port=8000&pathname=%2F&secure=false&useProxy=true');

    links.followLink(screen, 'open');
    assert.deepEqual(browser.hashes(), ['#!', '#!action=device&udid=PIXEL&view=screen']);
    links.followLink(proxied, 'switch');
    assert.equal(browser.hashes().length, 2, 'switch changes the entry');
    assert.match(browser.location.hash, /useProxy=true$/);
    links.followLink('http://other.test:8000/#!action=device&udid=PIXEL&view=screen', 'open');
    assert.deepEqual(browser.location.assigned, ['http://other.test:8000/#!action=device&udid=PIXEL&view=screen'], 'another host is a browser navigation');
});

test('the tab title is the same for both forms of an address', () => {
    open();
    const { pageTitle } = require('../src/app/state/pageTitle');
    const list = [
        { params: { type: 'ios' }, descriptor: { udid: 'IPHONE', name: 'Bench iPhone' } },
        { params: { type: 'android' }, descriptor: { udid: 'PIXEL', 'ro.product.manufacturer': 'Google', 'ro.product.model': 'Pixel 9' } },
    ];
    for (const [old, current, title] of [
        ['action=stream&udid=PIXEL&player=mse', 'action=device&udid=PIXEL&view=screen', 'Google Pixel 9 · Screen · ws-scrcpy'],
        ['action=stream-coredevice&udid=IPHONE', 'action=device&udid=IPHONE&view=screen', 'Bench iPhone · Screen · ws-scrcpy'],
        ['action=shell&udid=PIXEL', 'action=device&udid=PIXEL&view=shell', 'Google Pixel 9 · Shell · ws-scrcpy'],
        ['action=list-files&udid=PIXEL', 'action=device&udid=PIXEL&view=files', 'Google Pixel 9 · Files · ws-scrcpy'],
        ['action=shell&udid=IPHONE', 'action=device&udid=IPHONE&view=shell', 'Bench iPhone · Shell · ws-scrcpy'],
    ]) {
        assert.equal(pageTitle(usp(old), list), title);
        assert.equal(pageTitle(usp(current), list), title);
    }
    assert.equal(pageTitle(usp('action=device&udid=GONE&view=screen'), list), 'GONE · Screen · ws-scrcpy');
});

/** Every element in a Preact tree, as { type, props }. */
function elements(node, found = []) {
    if (Array.isArray(node)) node.forEach((child) => elements(child, found));
    else if (node && typeof node === 'object') {
        if (typeof node.type === 'function') elements(node.type(node.props), found);
        else {
            if (typeof node.type === 'string') found.push(node);
            elements(node.props?.children, found);
        }
    }
    return found;
}

test('AppBar and TabStrip are the kit bar and the kit tabs, with their class names', () => {
    const { browser } = open('#!');
    const { AppBar, AppBarStatus } = require('../src/app/ui/AppBar');
    const { TabStrip } = require('../src/app/ui/TabStrip');
    const { DEVICE_TABS } = require('../src/app/state/routes');

    const bar = elements(AppBar({ title: 'Pixel 9', status: AppBarStatus({ children: 'Connected' }), children: 'actions' }));
    const classes = bar.map((element) => element.props.class).filter(Boolean);
    assert.deepEqual(classes, ['kit-bar', 'kit-bar-back', 'kit-icon', 'kit-bar-back-label', 'kit-bar-title', 'kit-bar-name', 'kit-bar-status']);
    const back = bar.find((element) => element.props.class === 'kit-bar-back');
    assert.equal(back.props['aria-label'], 'Phones', 'the back control is named after the list');
    assert.equal(bar.find((element) => element.type === 'h1').props.children, 'Pixel 9');
    assert.equal(bar.find((element) => element.props.class === 'kit-bar-status').props.role, 'status');
    // The back control is up: with nothing below this page, the list replaces it.
    browser.location.hash = '#!action=shell&udid=PIXEL';
    browser.settle();
    back.props.onClick({ type: 'click' });
    browser.settle();
    assert.equal(browser.location.hash, '#!');
    assert.equal(browser.index, 0);
    let custom = 0;
    elements(AppBar({ title: 'Inbox', backLabel: 'Notifications', onBack: () => custom++ }))[1].props.onClick({});
    assert.equal(custom, 1);

    const picked = [];
    const strip = elements(
        TabStrip({
            label: 'Device views',
            tabs: DEVICE_TABS.android.map((tab) => ({ id: tab.view, title: tab.title })),
            current: 'files',
            onSelect: (id) => picked.push(id),
            children: 'Connected',
        }),
    );
    assert.deepEqual(strip.slice(0, 2).map((element) => [element.type, element.props.class]), [['nav', 'kit-tabs'], ['div', 'kit-tabs-list']]);
    assert.ok(strip.filter((element) => element.type === 'button').every((tab) => tab.props.class === 'kit-tab'));
    assert.equal(strip[0].props['aria-label'], 'Device views');
    const tabs = strip.filter((element) => element.type === 'button');
    assert.deepEqual(tabs.map((tab) => [tab.props.children, tab.props['aria-current']]), [['Screen', undefined], ['Files', 'page'], ['Shell', undefined]]);
    tabs[2].props.onClick();
    assert.deepEqual(picked, ['shell']);
});
