// Run with: node --test scripts/test-routes.js
// The routes and the history policy, without a browser: both forms of a phone's address, the
// rewrite of the older form, the push links that are already delivered, the three verbs (open
// pushes, switch replaces, up goes back to the list or replaces with it), the earlier exports
// as shims, and the history entries of overlays. scripts/e2e-navigation.js covers the same in a
// browser, with stream sockets counted.
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
function fakeBrowser(address, state = null) {
    const listeners = { popstate: new Set(), hashchange: new Set() };
    const tasks = [];
    const entries = [{ url: new URL(address, ORIGIN), state }];
    let index = 0;
    const fire = (type) => [...listeners[type]].forEach((listener) => listener({ type }));
    const resolve = (url) => (url === undefined || url === null ? entries[index].url : new URL(url, entries[index].url));
    const traverse = (delta) =>
        tasks.push(() => {
            const to = index + delta;
            if (to < 0 || to >= entries.length) return;
            const from = entries[index].url.hash;
            index = to;
            fire('popstate');
            if (entries[index].url.hash !== from) fire('hashchange');
        });
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
        addEventListener: (type, listener) => listeners[type]?.add(listener),
        removeEventListener: (type, listener) => listeners[type]?.delete(listener),
    };
    return {
        window,
        location,
        history,
        settle() {
            while (tasks.length) tasks.shift()();
        },
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
function open(address = '', { state = null, storage = fakeStorage() } = {}) {
    const browser = fakeBrowser(address, state);
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

test('Files keeps its older address until the explorer reads the new one', () => {
    // FileListingClient looks for action=list-files in location.hash before it adds a folder step.
    const { routes } = open();
    const old = 'action=list-files&udid=PIXEL&path=%2Fsdcard%2FDCIM';
    assert.equal(routes.canonicalRoute(usp(old)).toString(), old);
    assert.deepEqual(routes.parseRoute(usp(old)), { page: 'device', udid: 'PIXEL', view: 'files', platform: 'android' });
    // A link in the new form opens Files too, under the address the explorer reads.
    assert.equal(routes.canonicalRoute(usp('action=device&udid=PIXEL&view=files&path=%2Fsdcard%2FDCIM')).toString(), old);
    assert.equal(routes.deviceRoute('PIXEL', 'files', { path: '/sdcard/DCIM' }).toString(), old);
    assert.equal(routes.clientParams(usp(old)).toString(), old);
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
    const files = open('#!action=list-files&udid=PIXEL&path=%2Fsdcard');
    files.router.replaceRoute(usp('action=list-files&udid=PIXEL&path=%2Fsdcard'), { files: { id: 'run', index: 0 } });
    files.router.pushRoute(usp('action=list-files&udid=PIXEL&path=%2Fsdcard%2FDCIM'), { ...files.browser.history.state, files: { id: 'run', index: 1 } });
    assert.equal(files.browser.hashes().length, 2);
    assert.deepEqual(files.browser.history.state.files, { id: 'run', index: 1 });
    assert.equal(files.browser.history.state.nav.index, 1);
    files.router.pushRoute(usp('action=list-files&udid=PIXEL&path=%2Fsdcard%2FDCIM'));
    assert.equal(files.browser.hashes().length, 2, 'a push to the address that is shown adds nothing');
    files.router.replaceRoute(usp('action=list-files&udid=PIXEL&path=%2Fsdcard%2FDCIM%2FCamera'));
    assert.equal(files.browser.hashes().length, 2);
    assert.deepEqual(files.browser.history.state.files, { id: 'run', index: 1 }, 'replaceRoute keeps the state of the entry');
    assert.deepEqual(files.shown.at(-1), 'action=list-files&udid=PIXEL&path=%2Fsdcard%2FDCIM%2FCamera');
    files.router.switchRoute({ action: 'device', udid: 'PIXEL', view: 'shell' });
    assert.equal(files.browser.history.state.files, undefined, 'another view does not inherit the explorer state');
    files.browser.history.back();
    files.browser.settle();
    assert.equal(files.shown.at(-1), 'action=list-files&udid=PIXEL&path=%2Fsdcard', 'Back between folder steps still moves the route');
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

test('a reload keeps the place in history, so up still goes back', () => {
    const first = open('#!');
    first.router.openRoute({ action: 'device', udid: 'IPHONE', view: 'screen' });
    // The same tab after a reload: one document, the same entries and states.
    const state = first.browser.history.state;
    const reloaded = open('#!action=device&udid=IPHONE&view=screen', { state });
    assert.deepEqual(reloaded.browser.history.state.nav, state.nav);
});

test('uploads in progress: the owner is asked before a verb or the browser leaves the page', async () => {
    const { browser, router, shown } = open('#!action=list-files&udid=PIXEL&path=%2Fsdcard');
    let answer = false;
    let asked = 0;
    const guard = {
        blocks: (next) => next.get('action') !== 'list-files',
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
    assert.equal(browser.location.hash, '#!action=list-files&udid=PIXEL&path=%2Fsdcard', 'refused: the page stays');
    router.pushRoute(usp('action=list-files&udid=PIXEL&path=%2Fsdcard%2FDCIM'));
    assert.equal(asked, 1, 'a folder step is not leaving');

    // The browser's Back has already moved when the app hears of it.
    browser.location.hash = '#!action=shell&udid=PIXEL';
    browser.settle();
    await Promise.resolve();
    assert.equal(asked, 2);
    assert.equal(browser.location.hash, '#!action=list-files&udid=PIXEL&path=%2Fsdcard%2FDCIM', 'the address of the page is put back');
    assert.equal(shown.at(-1), 'action=list-files&udid=PIXEL&path=%2Fsdcard%2FDCIM');

    assert.deepEqual(browser.behind(), ['#!action=list-files&udid=PIXEL&path=%2Fsdcard'], 'the refused page is not what Back leads to');

    answer = true;
    router.openRoute({ action: 'device', udid: 'PIXEL', view: 'shell' });
    await Promise.resolve();
    browser.settle();
    assert.equal(asked, 3);
    assert.equal(shown.at(-1), 'action=device&udid=PIXEL&view=shell', 'allowed: the page is left');

    // The browser's own Back and a tab that assigns the hash, refused and then allowed.
    const tab = open('#!');
    tab.router.openRoute(usp('action=list-files&udid=PIXEL&path=%2Fsdcard'));
    const answers = [false, true, false, true];
    tab.router.setLeaveGuard({ blocks: (next) => next.get('action') !== 'list-files', ask: () => Promise.resolve(answers.shift()) });
    const settled = async () => {
        tab.browser.settle();
        await Promise.resolve();
        tab.browser.settle();
    };
    tab.browser.history.back();
    await settled();
    assert.equal(tab.browser.index, 1, 'Back refused: still on Files');
    assert.equal(tab.shown.at(-1), 'action=list-files&udid=PIXEL&path=%2Fsdcard');
    tab.browser.history.back();
    await settled();
    assert.equal(tab.browser.index, 0, 'Back allowed: the list');
    assert.equal(tab.shown.at(-1), '');

    tab.router.openRoute(usp('action=list-files&udid=PIXEL&path=%2Fsdcard'));
    tab.router.setLeaveGuard({ blocks: (next) => next.get('action') !== 'list-files', ask: () => Promise.resolve(answers.shift()) });
    tab.browser.location.hash = '#!action=shell&udid=PIXEL';
    await settled();
    assert.equal(tab.browser.location.hash, '#!action=list-files&udid=PIXEL&path=%2Fsdcard', 'tab refused: still on Files');
    tab.browser.location.hash = '#!action=shell&udid=PIXEL';
    await settled();
    assert.equal(tab.shown.at(-1), 'action=device&udid=PIXEL&view=shell', 'tab allowed: Shell');
    assert.deepEqual(tab.browser.behind(), ['#!action=list-files&udid=PIXEL&path=%2Fsdcard', '#!']);
});

test('an overlay has a history entry: Back closes it and leaves the page alone', () => {
    const { browser, router, shown } = open('#!');
    router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    const page = browser.location.hash;
    const closed = [];
    router.pushOverlay(() => closed.push('actions'));
    assert.deepEqual(browser.hashes(), ['#!', page, page], 'the entry has the address of the page');
    router.pushOverlay(() => closed.push('confirm'));
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

test('an overlay that closes by itself steps back over its entry', () => {
    const { browser, router } = open('#!');
    const closed = [];
    const sheet = router.pushOverlay(() => closed.push('settings'));
    assert.equal(browser.index, 1);
    sheet.release();
    sheet.release();
    browser.settle();
    assert.equal(browser.index, 0, 'the close button, the backdrop and Escape end where history.back() would');
    assert.deepEqual(closed, [], 'the overlay was closed already; it is not told again');

    // One sheet replaces another in the same task: the second entry waits for the first to be left.
    const first = router.pushOverlay(() => closed.push('first'));
    first.release();
    router.pushOverlay(() => closed.push('second'));
    browser.settle();
    assert.deepEqual(browser.hashes(), ['#!', '#!'], 'one overlay entry, not two');
    assert.equal(browser.index, 1);
    browser.history.back();
    browser.settle();
    assert.deepEqual(closed, ['second']);
    assert.equal(browser.index, 0);
});

test('an overlay that closes by itself takes the overlays opened from it along', () => {
    // A sheet with a confirm on top: the sheet closes by its own button.
    const { browser, router, shown } = open('#!');
    router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    const closed = [];
    const sheet = router.pushOverlay(() => closed.push('sheet'));
    const confirm = router.pushOverlay(() => closed.push('confirm'));
    assert.equal(browser.index, 3);
    sheet.release();
    assert.deepEqual(closed, ['confirm'], 'the confirm has lost its entry, so it is told to close');
    confirm.release();
    browser.settle();
    assert.equal(browser.index, 1, 'both entries are stepped back over');
    assert.deepEqual(closed, ['confirm']);

    // Neither is still open when the page changes, and Back from the page is the list.
    router.switchRoute({ action: 'device', udid: 'IPHONE', view: 'screen' });
    browser.settle();
    assert.deepEqual(closed, ['confirm']);
    assert.deepEqual(browser.behind(), ['#!']);
    assert.equal(shown.at(-1), 'action=device&udid=IPHONE&view=screen');
});

test('a route change closes every overlay, and the new address is written on the page entry', () => {
    // Switch phone is a sheet: choosing a phone replaces the page under the sheet, not the sheet's entry.
    const { browser, router, shown } = open('#!');
    router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    const closed = [];
    router.pushOverlay(() => closed.push('switcher'));
    router.switchRoute({ action: 'device', udid: 'IPHONE', view: 'screen' });
    assert.deepEqual(closed, ['switcher'], 'the overlay closes at once');
    browser.settle();
    assert.deepEqual(browser.hashes().slice(0, 2), ['#!', '#!action=device&udid=IPHONE&view=screen']);
    assert.equal(browser.index, 1);
    assert.deepEqual(browser.behind(), ['#!'], 'Back from the new phone is the list, not the phone before');
    assert.deepEqual(shown.slice(-2), ['action=device&udid=PIXEL&view=screen', 'action=device&udid=IPHONE&view=screen']);

    // Open from inside an overlay, and up from inside an overlay.
    router.pushOverlay(() => closed.push('menu'));
    router.openRoute({ action: 'notifications', source: 'IPHONE' });
    browser.settle();
    assert.deepEqual(browser.hashes(), ['#!', '#!action=device&udid=IPHONE&view=screen', '#!action=notifications&source=IPHONE']);
    router.pushOverlay(() => closed.push('card menu'));
    router.goUp();
    browser.settle();
    assert.deepEqual(closed, ['switcher', 'menu', 'card menu']);
    assert.equal(browser.index, 0);
    assert.equal(browser.location.hash, '#!');

    // An address that arrives from outside the router (a link, a typed address) closes them too.
    router.pushOverlay(() => closed.push('settings'));
    browser.location.hash = '#!action=notifications';
    browser.settle();
    assert.deepEqual(closed, ['switcher', 'menu', 'card menu', 'settings']);
    // Up from there still finds the list, with the left-over overlay entry between them.
    router.goUp();
    browser.settle();
    assert.equal(browser.index, 0);
});

test('a page reloaded with an overlay open goes back to the page entry', () => {
    const first = open('#!');
    first.router.openRoute({ action: 'device', udid: 'PIXEL', view: 'screen' });
    first.router.pushOverlay(() => {});
    assert.equal(first.browser.history.state.nav.overlay, 1);
    // The reloaded document starts on the overlay's entry, with the page entry below it.
    const browser = fakeBrowser('#!');
    browser.history.pushState({ nav: { index: 1, below: 0 } }, '', '#!action=device&udid=PIXEL&view=screen');
    browser.history.pushState(first.browser.history.state, '');
    global.window = browser.window;
    global.location = browser.location;
    global.history = browser.history;
    for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}src${path.sep}app${path.sep}`)) delete require.cache[key];
    require('../src/app/state/router');
    browser.settle();
    assert.equal(browser.index, 1, 'Back is not spent on an overlay that is no longer open');
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

test('AppBar and TabStrip are the stream header and the tool tabs, with their class names', () => {
    const { browser } = open('#!');
    const { AppBar, AppBarStatus } = require('../src/app/ui/AppBar');
    const { TabStrip } = require('../src/app/ui/TabStrip');
    const { DEVICE_TABS } = require('../src/app/state/routes');

    const bar = elements(AppBar({ title: 'Pixel 9', status: AppBarStatus({ connected: true, children: 'Connected' }), children: 'actions' }));
    const classes = bar.map((element) => element.props.class).filter(Boolean);
    assert.deepEqual(classes, ['stream-header', 'stream-header-back', 'stream-header-device', 'stream-header-status connected', 'stream-header-status-dot']);
    const back = bar.find((element) => element.props.class === 'stream-header-back');
    assert.equal(back.props['aria-label'], 'Phones', 'the back control is named after the list');
    assert.equal(bar.find((element) => element.type === 'strong').props.children, 'Pixel 9');
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
    assert.deepEqual(strip.slice(0, 2).map((element) => [element.type, element.props.class]), [['nav', 'tool-navigation'], ['div', 'tool-tabs']]);
    assert.equal(strip[0].props['aria-label'], 'Device views');
    const tabs = strip.filter((element) => element.type === 'button');
    assert.deepEqual(tabs.map((tab) => [tab.props.children, tab.props['aria-current']]), [['Screen', undefined], ['Files', 'page'], ['Shell', undefined]]);
    tabs[2].props.onClick();
    assert.deepEqual(picked, ['shell']);
});
