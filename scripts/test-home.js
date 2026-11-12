// Run with: node --test scripts/test-home.js
// The Phones list, its cards and the switcher, without a browser: names and tab titles, the
// Notifications target, the attention and error statuses, the rules of a card (one status, at
// most one line under it and the action for each status), the row a card and the switcher share,
// the switcher keys, the tool filter, the installed-app name and colours, and what the list takes
// from the kit: the status chip, the unread badge, kit buttons, icons and messages.
// scripts/e2e-home.js and scripts/e2e-switcher.js cover the same changes in a browser.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
require.extensions['.css'] = () => {};
global.location = new URL('http://localhost:8000/');

const {
    devices,
    deviceName,
    supportsDeviceTools,
    findDeviceWithoutTools,
    canOpenScreen,
    findDeviceByUdid,
    isDeviceAvailable,
    reportedConnected,
} = require('../src/app/state/devices');
const { pageTitle, APP_NAME } = require('../src/app/state/pageTitle');
const { notificationsTarget, isNotificationSource } = require('../src/app/state/notificationsTarget');
const {
    getDeviceStatusInfo,
    getDeviceProblems,
    needsAttention,
    listSummary,
} = require('../src/app/state/deviceStatus');
const { isSwitcherShortcut, nextHighlight } = require('../src/app/state/switcherKeys');
const view = require('../src/app/state/deviceListView');
const { phoneCard } = require('../src/app/state/phoneCard');
const { cardCapabilities } = require('../src/app/state/capabilities');
const { markStarting, clearStarting } = require('../src/app/state/phoneStatus');
const { Chip, chipClass } = require('../src/app/ui/Chip');
const { Badge, badgeText } = require('../src/app/ui/Badge');
const { PhoneRow, platformLine } = require('../src/app/ui/PhoneRow');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/** Every element in a Preact tree, as { type, props }. Components without hooks are drawn. */
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

const android = (udid, extra = {}) => ({
    key: `android:${udid}`,
    trackerId: 'android',
    trackerName: 'Host',
    params: { type: 'android' },
    descriptor: {
        udid,
        state: 'device',
        pid: 123,
        interfaces: [],
        'ro.product.manufacturer': 'Google',
        'ro.product.model': 'Pixel 9 Pro',
        'screen.power': 'on',
        ...extra,
    },
});
const iphone = (udid, extra = {}) => ({
    key: `ios:${udid}`,
    trackerId: 'ios',
    trackerName: 'Host',
    params: { type: 'ios' },
    descriptor: {
        udid,
        name: 'iPhone 13 Pro Max',
        model: 'iPhone 13 Pro Max',
        version: '27.2',
        state: 'Connected',
        paired: true,
        developerMode: true,
        session: 'stopped',
        'screen.power': 'on',
        'device.locked': false,
        ...extra,
    },
});
const route = (params) => new URLSearchParams(params);

test('every page takes its tab title from one function with one format', () => {
    const list = [android('PIXEL-1'), iphone('IPHONE-1')];
    assert.equal(APP_NAME, 'ws-scrcpy');
    assert.equal(pageTitle(route({}), list), 'Phones · ws-scrcpy');
    assert.equal(pageTitle(route({ action: 'notifications', source: 'IPHONE-1' }), list), 'Notifications · ws-scrcpy');
    assert.equal(
        pageTitle(route({ action: 'stream', udid: 'PIXEL-1', player: 'webcodecs' }), list),
        'Google Pixel 9 Pro · Screen · ws-scrcpy',
    );
    assert.equal(
        pageTitle(route({ action: 'stream-coredevice', udid: 'IPHONE-1' }), list),
        'iPhone 13 Pro Max · Screen · ws-scrcpy',
    );
    assert.equal(
        pageTitle(route({ action: 'list-files', udid: 'PIXEL-1', path: '/sdcard/' }), list),
        'Google Pixel 9 Pro · Files · ws-scrcpy',
    );
    assert.equal(pageTitle(route({ action: 'shell', udid: 'PIXEL-1' }), list), 'Google Pixel 9 Pro · Shell · ws-scrcpy');
    // The title names the device like its card does, never by model alone.
    assert.equal(deviceName(list[0]), 'Google Pixel 9 Pro');
    // Before the device list arrives the serial stands in, in the same format.
    assert.equal(pageTitle(route({ action: 'shell', udid: 'PIXEL-1' }), []), 'PIXEL-1 · Shell · ws-scrcpy');
    // Unless this browser kept the phone's name when it last showed its page: a page reloaded
    // after a server restart is named before the list is back.
    require('../src/app/state/routes').rememberPhone('KEPT-1', 'ios', 'Bench iPhone');
    assert.equal(pageTitle(route({ action: 'device', udid: 'KEPT-1', view: 'screen' }), []), 'Bench iPhone · Screen · ws-scrcpy');
    // A serial shared by an Android device and an iPhone resolves by the page's platform.
    assert.equal(
        pageTitle(route({ action: 'stream', udid: 'SAME' }), [iphone('SAME'), android('SAME')]),
        'Google Pixel 9 Pro · Screen · ws-scrcpy',
    );
    // A Files or Shell link that names an iPhone is refused; its page still names the iPhone.
    assert.equal(pageTitle(route({ action: 'shell', udid: 'IPHONE-1' }), list), 'iPhone 13 Pro Max · Shell · ws-scrcpy');
    // A `title` parameter in a device link still replaces the whole title.
    assert.equal(pageTitle(route({ action: 'stream', udid: 'PIXEL-1', title: 'Kitchen tablet' }), list), 'Kitchen tablet');
    assert.equal(pageTitle(route({ title: 'Ignored' }), list), 'Phones · ws-scrcpy');
    // An unknown action falls back to Devices, like the router does.
    assert.equal(pageTitle(route({ action: 'devtools', udid: 'PIXEL-1' }), list), 'Phones · ws-scrcpy');
});

test('the Notifications control opens the inbox of the iPhone on screen, or the inbox with the total', () => {
    const summary = {
        unread: 5,
        unreadBySource: { 'IPHONE-1': 2, 'IPHONE-2': 3 },
        sources: [
            { id: 'IPHONE-1', name: 'iPhone' },
            { id: 'IPHONE-2', name: 'iPad' },
        ],
    };
    assert.deepEqual(notificationsTarget(summary), { href: '#!action=notifications', unread: 5 });
    assert.deepEqual(notificationsTarget(summary, 'IPHONE-1'), {
        href: '#!action=notifications&source=IPHONE-1',
        unread: 2,
    });
    // An iPhone that does not send notifications here has no inbox of its own.
    assert.deepEqual(notificationsTarget(summary, 'IPHONE-9'), { href: '#!action=notifications', unread: 5 });
    assert.equal(isNotificationSource(summary, 'IPHONE-2'), true);
    assert.equal(isNotificationSource(summary, 'IPHONE-9'), false);
    assert.deepEqual(notificationsTarget({ unread: 0, unreadBySource: {}, sources: [] }, 'IPHONE-1'), {
        href: '#!action=notifications',
        unread: 0,
    });
});

test('blocked and failed iPhones do not read as Ready', () => {
    const now = Date.UTC(2026, 10, 11, 12, 0);
    const status = (entry) => getDeviceStatusInfo(entry).status;
    const healthy = iphone('A');
    assert.equal(status(healthy), 'ready');
    assert.deepEqual(getDeviceProblems(healthy, now), []);
    assert.equal(needsAttention(healthy), false);

    const noDeveloperMode = iphone('B', { developerMode: false });
    assert.equal(status(noDeveloperMode), 'attention');
    assert.equal(getDeviceStatusInfo(noDeveloperMode).label, 'Needs attention');
    assert.deepEqual(
        getDeviceProblems(noDeveloperMode, now).map((problem) => [problem.kind, problem.level]),
        [['developer-mode', 'attention']],
    );
    // Not yet known is not a problem.
    assert.equal(status(iphone('B2', { developerMode: 'unknown' })), 'ready');

    const failed = iphone('C', { session: 'error', sessionMessage: 'The screen stream ended.' });
    assert.equal(status(failed), 'error');
    assert.equal(getDeviceStatusInfo(failed).label, 'Error');
    assert.deepEqual(getDeviceProblems(failed, now), [
        { kind: 'session', level: 'error', message: 'The screen stream ended.' },
    ]);
    assert.equal(getDeviceProblems(iphone('C2', { session: 'error' }), now)[0].message, 'The screen session failed.');

    const schedule = { enabled: true, time: '03:00', hasPasscode: true, lastUnlockedAt: now - 2 * 86400000 };
    const failedUnlock = iphone('D', {
        'screen.power': 'off',
        unlockSchedule: { ...schedule, lastRun: { at: now - 3600000, trigger: 'schedule', outcome: 'failed-wake' } },
    });
    assert.equal(status(failedUnlock), 'attention', 'a failed scheduled unlock outranks Asleep');
    assert.equal(getDeviceProblems(failedUnlock, now)[0].kind, 'unlock');
    assert.match(getDeviceProblems(failedUnlock, now)[0].message, /^Scheduled unlock 03:00 and 15:00 · /);
    assert.equal(status(iphone('D2', { 'screen.power': 'off', unlockSchedule: schedule })), 'asleep');
    assert.equal(
        status(iphone('D3', { unlockSchedule: { ...schedule, hasPasscode: false } })),
        'attention',
        'a schedule that cannot run needs attention',
    );
    assert.equal(status(iphone('D4', { unlockSchedule: { ...schedule, enabled: false, hasPasscode: false } })), 'ready');

    // A running session is a second mark and does not hide the problem; a starting one still
    // says so. The header count includes the phone anyway.
    const streaming = iphone('E', { session: 'ready', developerMode: false });
    assert.equal(status(streaming), 'attention');
    assert.equal(getDeviceStatusInfo(streaming).sessionRunning, true);
    assert.equal(needsAttention(streaming), true);
    assert.equal(status(iphone('E2', { session: 'starting', developerMode: false })), 'starting');

    // An unplugged or untrusted phone is not a problem on top of its own status.
    const offline = iphone('F', { state: 'Disconnected', session: 'error', developerMode: false });
    assert.equal(status(offline), 'offline');
    assert.deepEqual(getDeviceProblems(offline, now), []);
    assert.equal(status(iphone('G', { state: 'unauthorized', developerMode: false })), 'unauthorized');

    // Android devices report none of these.
    assert.deepEqual(getDeviceProblems(android('H'), now), []);
    assert.equal(status(android('H')), 'ready');
});

test('a screen opens only on a connected device, and not on an iPhone with Developer Mode off', () => {
    assert.equal(canOpenScreen(android('A')), true);
    assert.equal(canOpenScreen(android('B', { state: 'offline' })), false);
    assert.equal(canOpenScreen(iphone('C')), true);
    assert.equal(canOpenScreen(iphone('D', { developerMode: false })), false);
    assert.equal(canOpenScreen(iphone('E', { developerMode: 'unknown' })), true, 'not yet known does not block');
    assert.equal(canOpenScreen(iphone('F', { state: 'disconnected' })), false);
    // A failed session or an unlock problem still lets the owner open the screen.
    assert.equal(canOpenScreen(iphone('G', { session: 'error' })), true);
});

test('the Devices header counts devices that need attention', () => {
    assert.equal(listSummary(0, 0, 0), 'Waiting for phones');
    assert.equal(listSummary(2, 0, 0), 'No phones available');
    assert.equal(listSummary(3, 3, 0), '3 available');
    assert.equal(listSummary(3, 3, 1), '3 available · 1 needs attention');
    assert.equal(listSummary(4, 3, 2), '3 available · 2 need attention');
});

test('Files and Shell are offered for Android devices only', () => {
    const pixel = android('PIXEL-1');
    const phone = iphone('IPHONE-1');
    assert.equal(supportsDeviceTools(pixel), true);
    assert.equal(supportsDeviceTools(phone), false);
    const previous = devices.value;
    try {
        devices.value = new Map([pixel, phone, iphone('SAME'), android('SAME')].map((entry) => [entry.key, entry]));
        assert.equal(findDeviceWithoutTools('IPHONE-1'), phone, 'a tool link that names an iPhone is refused');
        assert.equal(findDeviceWithoutTools('PIXEL-1'), undefined);
        assert.equal(findDeviceWithoutTools('NOT-LISTED'), undefined, 'an unknown serial may still be connecting');
        assert.equal(findDeviceWithoutTools('SAME'), undefined, 'a serial an Android device also has is allowed');
    } finally {
        devices.value = previous;
    }
});

test('the switcher shortcut and arrow keys', () => {
    const key = (extra) => ({
        key: 'k',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        defaultPrevented: false,
        ...extra,
    });
    assert.equal(isSwitcherShortcut(key({ ctrlKey: true })), true);
    assert.equal(isSwitcherShortcut(key({ metaKey: true, key: 'K' })), true);
    assert.equal(isSwitcherShortcut(key({})), false);
    assert.equal(isSwitcherShortcut(key({ ctrlKey: true, shiftKey: true })), false);
    assert.equal(isSwitcherShortcut(key({ ctrlKey: true, altKey: true })), false);
    assert.equal(isSwitcherShortcut(key({ ctrlKey: true, key: 'j' })), false);
    // The stream (keyboard capture) or the terminal already used the key: it stays theirs.
    assert.equal(isSwitcherShortcut(key({ ctrlKey: true, defaultPrevented: true })), false);

    const keys = ['a', 'b', 'c'];
    assert.equal(nextHighlight(keys, undefined, 1), 'a');
    assert.equal(nextHighlight(keys, undefined, -1), 'c');
    assert.equal(nextHighlight(keys, 'a', 1), 'b');
    assert.equal(nextHighlight(keys, 'c', 1), 'a');
    assert.equal(nextHighlight(keys, 'a', -1), 'c');
    assert.equal(nextHighlight(keys, 'filtered-out', 1), 'a');
    assert.equal(nextHighlight([], 'a', 1), undefined);
});

test('the Devices page remembers its scroll position and the card a page was opened from, and a card has no disclosure to remember', () => {
    assert.equal(view.savedListScroll(), 0);
    view.rememberListScroll(1407);
    assert.equal(view.savedListScroll(), 1407);
    view.rememberListScroll(0);
    // The card is focused once on the way back, not on every later return.
    assert.equal(view.takeOpenedCard(), undefined);
    view.rememberOpenedCard({ key: 'android:A', control: '#!action=device&udid=A&view=screen' });
    assert.deepEqual(view.takeOpenedCard(), { key: 'android:A', control: '#!action=device&udid=A&view=screen' });
    assert.equal(view.takeOpenedCard(), undefined);
    assert.deepEqual(Object.keys(view).sort(), ['listState', 'rememberListScroll', 'rememberOpenedCard', 'savedListScroll', 'takeOpenedCard']);
});

test('loading, empty and stale are three different states of the list (U-home-8)', () => {
    const live = { stale: undefined };
    const stale = { stale: true };
    // Before the first list nothing says that no phone is connected, also once the server has
    // named its trackers.
    assert.equal(view.listState([], false, 'connecting'), 'loading');
    assert.equal(view.listState([], false, 'connected'), 'loading');
    // A first list with no phone in it.
    assert.equal(view.listState([], true, 'connected'), 'empty');
    // The phones of a list that is reconnecting stay, as stale, whatever the host list says.
    assert.equal(view.listState([live, stale], true, 'connected'), 'stale');
    assert.equal(view.listState([stale], true, 'disconnected'), 'stale');
    assert.equal(view.listState([live], true, 'connected'), 'ready');
    // No phone and no server.
    assert.equal(view.listState([], true, 'disconnected'), 'disconnected');
    assert.equal(view.listState([], false, 'error'), 'disconnected');
    const states = new Set([view.listState([], false, 'connected'), view.listState([], true, 'connected'), view.listState([stale], true, 'disconnected')]);
    assert.equal(states.size, 3, 'three different states');
});

test('a stale card says what the phone last reported, never Offline, and cannot open a screen', () => {
    const now = Date.UTC(2026, 10, 11, 12, 0);
    const staleOf = (entry) => ({ ...entry, stale: true });
    const cases = [
        [android('S1', { 'ro.build.version.release': '16', 'battery.level': 80 }), 'ready'],
        [android('S2', { 'screen.power': 'off' }), 'asleep'],
        [iphone('S3', { session: 'ready' }), 'ready'],
        [iphone('S4', { unlockSchedule: { enabled: true, time: '03:00', hasPasscode: false } }), 'attention'],
    ];
    for (const [entry, status] of cases) {
        const live = phoneCard(entry, true, now);
        const card = phoneCard(staleOf(entry), true, now);
        assert.equal(card.status.status, status, `${entry.key}: the status it last had`);
        assert.deepEqual([card.line?.kind, card.wake, [...card.tools]], [live.line?.kind, live.wake, [...live.tools]], `${entry.key}: the same line, Wake and tools, which the card turns off`);
        assert.equal(card.openScreen, false, `${entry.key}: Open screen is off`);
        assert.equal(isDeviceAvailable(staleOf(entry)), false);
        assert.equal(reportedConnected(staleOf(entry)), true, 'it was connected when last listed');
    }
    // The row: dimmed, its chip names the status as the last known one, and its platform line
    // keeps the battery it showed.
    const pixel = android('S5', { 'ro.build.version.release': '16', 'battery.level': 80 });
    const row = elements(PhoneRow({ entry: staleOf(pixel) }));
    assert.match(row[0].props.class, /\bphone-row-stale\b/);
    assert.doesNotMatch(elements(PhoneRow({ entry: pixel }))[0].props.class, /stale/);
    assert.equal(row.find((node) => /kit-chip/.test(node.props.class || '')).props.title, 'Last known status: Ready');
    assert.equal(platformLine(staleOf(pixel)), 'Android 16 · 80%');
    // The pages of one phone do not take a stale entry; the list and the switcher show it.
    const previous = devices.value;
    try {
        devices.value = new Map([[pixel.key, staleOf(pixel)]]);
        assert.equal(findDeviceByUdid('S5'), undefined);
        assert.equal(canOpenScreen(staleOf(pixel)), false);
    } finally {
        devices.value = previous;
    }
});

test('a card has one status, at most one line under it, and the action for that status', () => {
    const now = Date.UTC(2026, 10, 11, 12, 0);
    const card = (entry, playable = true) => {
        const model = phoneCard(entry, playable, now);
        return {
            status: model.status.status,
            line: model.line?.kind,
            action: model.line?.action,
            open: model.openScreen,
            wake: model.wake,
            tools: [...model.tools],
            inUse: model.status.sessionRunning,
        };
    };
    const ANDROID_TOOLS = ['files', 'shell'];
    const cases = [
        // Android: a running stream service is the In use mark, and no line.
        ['android running', android('A1'), { status: 'ready', open: true, tools: ANDROID_TOOLS, inUse: true }],
        // An idle phone: the stream service is stopped or not known yet. No line and no Start;
        // Open screen starts the service.
        ['android stopped', android('A2', { pid: -1 }), { status: 'ready', open: true, tools: ANDROID_TOOLS }],
        ['android unknown service', android('A3', { pid: 0 }), { status: 'ready', open: true, tools: ANDROID_TOOLS }],
        // Asleep: Wake beside the status, and no line.
        ['android asleep', android('A4', { pid: -1, 'screen.power': 'off' }), { status: 'asleep', open: true, wake: true, tools: ANDROID_TOOLS }],
        ['android locked', android('A5', { pid: -1, 'device.locked': true }), { status: 'locked', open: true, tools: ANDROID_TOOLS }],
        // Not reachable: the hint is the line, Open screen is disabled, no tools and no Wake.
        ['android offline', android('A6', { state: 'offline', pid: -1, 'screen.power': 'off' }), { status: 'offline', line: 'offline', open: false }],
        ['android unauthorized', android('A7', { state: 'unauthorized', pid: -1 }), { status: 'unauthorized', line: 'unauthorized', open: false }],
        // No player in this browser: the line says why Open screen is disabled.
        ['android no player', android('A8'), { status: 'ready', line: 'player', open: false, tools: ANDROID_TOOLS, inUse: true }, false],
        // iPhone: no stream service line, no Wake and no tools; a running session is In use.
        ['iphone ready', iphone('I1'), { status: 'ready', open: true }],
        ['iphone session', iphone('I2', { session: 'ready' }), { status: 'ready', open: true, inUse: true }],
        ['iphone asleep', iphone('I3', { 'screen.power': 'off' }), { status: 'asleep', open: true }],
        ['iphone starting', iphone('I4', { session: 'starting' }), { status: 'starting', open: true }],
        ['iphone developer mode', iphone('I5', { developerMode: false }), { status: 'attention', line: 'developer-mode', action: 'enable-developer-mode', open: false }],
        ['iphone failed', iphone('I6', { session: 'error' }), { status: 'error', line: 'session', action: 'restart-services', open: true }],
        // A failed session and Developer Mode off: the line says why the screen cannot open.
        ['iphone failed, developer mode', iphone('I7', { session: 'error', developerMode: false }), { status: 'error', line: 'developer-mode', action: 'enable-developer-mode', open: false }],
        ['iphone unlock', iphone('I8', { unlockSchedule: { enabled: true, time: '03:00', hasPasscode: false } }), { status: 'attention', line: 'unlock', action: 'open-settings', open: true }],
        ['iphone offline', iphone('I9', { state: 'disconnected', unlockSchedule: { enabled: true, time: '03:00', hasPasscode: false } }), { status: 'offline', line: 'offline', open: false }],
        ['iphone unauthorized', iphone('I10', { state: 'unauthorized' }), { status: 'unauthorized', line: 'unauthorized', open: false }],
        // The browser's players do not matter to an iPhone.
        ['iphone without a player', iphone('I11'), { status: 'ready', open: true }, false],
    ];
    for (const [label, entry, expected, playable] of cases) {
        assert.deepEqual(card(entry, playable), { line: undefined, action: undefined, wake: false, tools: [], inUse: false, ...expected }, label);
    }
    // The Starting flag, set by Start in Settings: Starting is the status, and there is no line.
    const starting = android('A9', { pid: -1 });
    markStarting(starting.key);
    try {
        assert.deepEqual([card(starting).status, card(starting).line], ['starting', undefined]);
    } finally {
        clearStarting(starting.key);
    }
    // What a kind of phone offers on its card.
    assert.deepEqual(cardCapabilities('android'), { wake: true, player: true });
    assert.deepEqual(cardCapabilities('ios'), { wake: false, player: false });
});

test('the row of a phone is the head of its card and its switcher row: one chip, no serial, no tracker', () => {
    const rowOf = (entry, props = {}) => elements(PhoneRow({ entry, ...props }));
    const text = (nodes) => nodes.flatMap((node) => [node.props.children].flat().filter((child) => typeof child === 'string' || typeof child === 'number')).join(' ');
    const chips = (nodes) => nodes.filter((node) => /\bkit-chip\b/.test(node.props.class || ''));
    const pixel = android('SERIAL-PIXEL', { 'ro.build.version.release': '16', 'battery.level': 80, 'battery.charging': false });
    const nodes = rowOf(pixel);
    assert.deepEqual(chips(nodes).map((chip) => [chip.props.children, chip.props['data-status']]), [['Ready', 'ready']], 'one status chip');
    assert.match(text(nodes), /Google Pixel 9 Pro/);
    assert.equal(platformLine(pixel), 'Android 16 · 80%');
    assert.equal(platformLine(android('C', { 'ro.build.version.release': '15', 'battery.level': 35, 'battery.charging': true })), 'Android 15 · 35% · Charging');
    assert.equal(platformLine(android('D', { 'ro.build.version.release': '16', 'battery.level': 80, state: 'offline' })), 'Android 16', 'no stale level for a phone that is away');
    assert.equal(platformLine(iphone('I')), 'iOS 27.2', 'an iPhone reports no battery');
    assert.doesNotMatch(text(nodes), /SERIAL-PIXEL|Host/, 'no serial and no tracker name');
    // A running session is a mark after the platform line, never a second chip.
    assert.match(text(nodes), /In use/);
    assert.doesNotMatch(text(rowOf(android('STOPPED', { pid: -1 }))), /In use/);
    for (const entry of [android('X', { 'screen.power': 'off' }), iphone('Y', { session: 'ready', developerMode: false }), iphone('Z', { state: 'disconnected' })]) {
        assert.equal(chips(rowOf(entry)).length, 1, `${entry.key}: one chip`);
    }
    // The switcher's current phone: Viewing in place of the status chip.
    const viewing = rowOf(pixel, { chip: Chip({ tone: 'info', children: 'Viewing' }) });
    assert.deepEqual(chips(viewing).map((chip) => chip.props.children), ['Viewing']);
    // The unread count, with its words for a reader that does not see the badge.
    assert.equal(rowOf(pixel).some((node) => /kit-badge/.test(node.props.class || '')), false, 'nothing for no unread');
    const unread = rowOf(iphone('I'), { unread: 3 });
    assert.equal(unread.find((node) => /kit-badge/.test(node.props.class || '')).props.children, '3');
    assert.match(text(unread), /3 unread/);
});

test('the installed app has one name and the colours of the page', () => {
    const manifest = JSON.parse(read('src/public/manifest.json'));
    const html = read('src/public/index.html');
    const tokens = read('src/style/tokens.css');
    assert.equal(manifest.name, APP_NAME);
    assert.equal(manifest.short_name, APP_NAME);
    assert.match(html, new RegExp(`<title>${APP_NAME}</title>`));
    assert.match(read('src/public/sw.js'), new RegExp(`message\\.title \\|\\| '${APP_NAME}'`));

    // The page is painted with --surface; the browser bar matches it.
    const [light, dark] = [...tokens.matchAll(/--surface:\s*(#[0-9a-f]{6});/gi)].map((match) => match[1]);
    assert.ok(light && dark, 'tokens.css defines the page colour for both themes');
    const theme = (scheme) =>
        html.match(new RegExp(`name="theme-color" content="(#[0-9a-f]{6})" media="\\(prefers-color-scheme: ${scheme}\\)"`, 'i'))?.[1];
    assert.equal(theme('light'), light);
    assert.equal(theme('dark'), dark);
    // A manifest holds one colour. The dark one is used: the splash screen leads into the stream,
    // which is dark in both themes.
    assert.equal(manifest.theme_color, dark);
    assert.equal(manifest.background_color, dark);

    const shortcut = manifest.shortcuts.find((item) => item.name === 'Notifications');
    assert.ok(shortcut, 'the manifest has a Notifications shortcut');
    const target = new URL(shortcut.url, 'https://phone.example/app/');
    assert.equal(target.pathname, '/app/', 'the shortcut stays inside the app scope');
    assert.equal(target.hash, '#!action=notifications');
});

test('the switcher is on the kit sheet, and its search field is the kit field', () => {
    const list = read('src/style/views/DeviceList.css');
    const switcher = read('src/style/views/DeviceSwitcherSheet.css');
    const source = read('src/app/views/DeviceSwitcherSheet.tsx');
    assert.equal(/\.device-search\b/.test(list), false, 'Devices has no search field, so no search rule');
    // The search row keeps its own height inside the column: it once took a flex-basis as height.
    const rule = switcher.match(/\.device-switcher-search \{([^}]*)\}/)?.[1] || '';
    assert.match(rule, /flex:\s*0 0 auto;/);
    assert.equal(/height:/.test(rule), false, 'the height is the kit field\'s, not a number of its own');
    assert.match(source, /<input\s+ref=\{searchRef\}\s+class="kit-field"\s+type="search"/);
    assert.equal(/class="device-search/.test(source), false);
    assert.match(source, /from '\.\.\/ui\/Sheet'/);
    assert.equal(/BottomSheet|bottom-sheet/.test(source + switcher), false, 'nothing of the older sheet is left');
});

test('a status is words and a chip tone, with no glyph and no colour of its own', () => {
    const schedule = { enabled: true, time: '03:00', hasPasscode: false };
    const cases = {
        ready: [android('A'), 'Ready', 'success'],
        asleep: [android('B', { 'screen.power': 'off' }), 'Asleep', 'info'],
        locked: [android('C', { 'device.locked': true }), 'Locked', 'info'],
        offline: [android('D', { state: 'offline' }), 'Offline', 'neutral'],
        unauthorized: [android('E', { state: 'unauthorized' }), 'Unauthorized', 'error'],
        starting: [iphone('F', { session: 'starting' }), 'Starting…', 'warning'],
        attention: [iphone('H', { unlockSchedule: schedule }), 'Needs attention', 'warning'],
        error: [iphone('I', { session: 'error' }), 'Error', 'error'],
    };
    for (const [status, [entry, label, tone]] of Object.entries(cases)) {
        const info = getDeviceStatusInfo(entry);
        assert.deepEqual({ status: info.status, label: info.label, tone: info.tone }, { status, label, tone }, status);
        assert.match(info.label, /^[A-Z][a-z]+( [a-z]+)?…?$/, `${status} is said in words`);
    }
    // A running session is not a status of its own: the phone is Ready, with a second mark.
    const running = getDeviceStatusInfo(iphone('G', { session: 'ready' }));
    assert.deepEqual([running.status, running.label, running.sessionRunning], ['ready', 'Ready', true]);
    for (const file of ['src/app/state/phoneStatus.ts', 'src/app/copy.ts']) {
        assert.equal(/color:|[▶●▣☾◐○⚠✕]/.test(read(file)), false, `${file} holds no glyph or colour`);
    }
});

test('the status chip and the unread badge of the kit', () => {
    assert.equal(chipClass(), 'kit-chip');
    assert.equal(chipClass('neutral'), 'kit-chip');
    for (const tone of ['success', 'info', 'warning', 'error']) assert.equal(chipClass(tone), `kit-chip kit-chip-${tone}`);
    const chip = Chip({ tone: 'warning', class: 'device-status', attributes: { 'data-status': 'attention' }, children: 'Needs attention' });
    assert.equal(chip.type, 'span');
    assert.equal(chip.props.class, 'kit-chip kit-chip-warning device-status');
    assert.equal(chip.props['data-status'], 'attention');
    assert.equal(chip.props.children, 'Needs attention');
    const chipRules = read('src/style/kit/Chip.css');
    for (const tone of ['success', 'info', 'warning', 'error']) assert.match(chipRules, new RegExp(`\\.kit-chip-${tone} \\{`), `${tone} has a rule`);
    assert.match(chipRules, /font-size: var\(--font-size-12\);/);

    assert.equal(badgeText(0), '');
    assert.equal(badgeText(-1), '');
    assert.equal(badgeText(1), '1');
    assert.equal(badgeText(99), '99');
    assert.equal(badgeText(100), '99+');
    assert.equal(Badge({ count: 0 }), null, 'nothing is drawn for zero');
    const badge = Badge({ count: 120 });
    assert.equal(badge.props.class, 'kit-badge');
    assert.equal(badge.props.children, '99+');
    // The control it sits on says the count in its name, so the badge is not read out twice.
    assert.equal(badge.props['aria-hidden'], 'true');
    const bell = read('src/app/ui/NotificationsLink.tsx');
    assert.match(bell, /aria-label=\{unread \? `Notifications, \$\{unread\} unread` : 'Notifications'\}/);
    assert.match(bell, /<Badge count=\{unread\} \/>/);
    assert.match(bell, /iconButtonClass\(/);
});

test('the list, its cards, the switcher and the notices take their controls, icons and messages from the kit', () => {
    const views = ['src/app/views/DeviceList.tsx', 'src/app/views/DeviceCard.tsx', 'src/app/views/DeviceSwitcherSheet.tsx'];
    const parts = ['PhoneRow', 'WakeButton', 'StreamServiceStatus', 'TrackerStatusNotice', 'ErrorBoundary', 'NotificationsLink', 'DeviceIcon'].map(
        (name) => `src/app/ui/${name}.tsx`,
    );
    for (const file of [...views, ...parts]) {
        const source = read(file);
        assert.equal(/<svg\b/.test(source), false, `${file} draws no icon of its own`);
        assert.equal(/<button\b[^>]*class=/.test(source.replace(/class=\{`device-switcher-item[^`]*`\}/, '')), false, `${file} has no button look of its own`);
        assert.equal(/[☾⚠✕▶●▣◐○→←]/.test(source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), false, `${file} has no text glyph`);
        assert.equal(/ui-button|action-button|wake-button|device-problem-action|screen-failed-button|control-button/.test(source), false, `${file} uses no older button class`);
    }
    const styles = [
        'src/style/views/DeviceList.css', 'src/style/views/DeviceSwitcherSheet.css', 'src/style/ui/StreamServiceStatus.css',
        'src/style/ui/ErrorBoundary.css', 'src/style/ui/DeviceIcon.css', 'src/style/ui/PhoneRow.css',
    ];
    for (const file of styles) {
        const rules = read(file);
        assert.equal(/\.(ui-button|desc-block|action-button|wake-button|device-problem-action|screen-failed-button|control-button)\b/.test(rules), false, `${file} styles no button of its own`);
        assert.equal(/content:\s*'[^']/.test(rules), false, `${file} draws no glyph`);
        assert.equal(/--(device|text-color|main-bg|status-|button-|control-border|header-bg|radius-control|radius-panel|accent-solid|progress)/.test(rules), false, `${file} reads role tokens only`);
    }
    // The bell is the kit's icon button and badge. Where it hides on a narrow phone is a rule of the phone's page.
    for (const gone of ['src/style/ui/AsleepBanner.css', 'src/style/ui/TrackerStatusNotice.css', 'src/style/ui/NotificationsLink.css']) {
        assert.equal(fs.existsSync(path.join(root, gone)), false, `${gone} is deleted`);
    }
    // The header of the list is the kit bar, with the bell and Reload as icon buttons.
    const list = read('src/app/views/DeviceList.tsx');
    assert.match(list, /<AppBar\s+root\s+title=\{LIST_PAGE_NAME\}/);
    assert.match(list, /<IconButton icon="refresh" label="Reload"/);
    // Messages: a banner for a condition, a status line under the control for an outcome. The
    // asleep banner is gone: Wake is a button beside the status, its outcome a status line.
    assert.equal(fs.existsSync(path.join(root, 'src/app/ui/AsleepBanner.tsx')), false, 'the asleep banner is gone');
    const wake = read('src/app/ui/WakeButton.tsx');
    assert.match(wake, /<InlineStatus tone="error">Could not wake the screen\./);
    assert.match(wake, /wakeDevice\(tracker, udid\)/, 'the wake request is the one of googDevice/client/wake.ts');
    assert.doesNotMatch(wake, /<Banner\b/);
    assert.match(read('src/app/ui/TrackerStatusNotice.tsx'), /<Banner>/);
    const card = read('src/app/views/DeviceCard.tsx');
    assert.equal(/device-unavailable-hint/.test(card), false, 'the grey paragraph for every outcome is gone');
    // One outcome at a time, under the line whose button sent the command.
    assert.equal((card.match(/<InlineStatus\b/g) || []).length, 1, 'the outcome of a command has one place');
    for (const place of ['developer-mode', 'restart']) {
        assert.match(card, new RegExp(`setFeedback\\(\\{\\s*place: '${place}'`), `${place} reports its outcome there`);
    }
    assert.ok((card.match(/<ConfirmPrompt\b/g) || []).length > 0, 'a card asks with the confirm prompt');
    assert.doesNotMatch(card, /<ConfirmPrompt\s[^>]*\bkit\b/, 'which takes no kit prop: its look is the only one');
    // The disclosure, the serial and the platform checks of the card are gone.
    assert.doesNotMatch(card, /AnimatedDetails|<details|device-details|device-serial|trackerName/);
    assert.doesNotMatch(card, /params\.type === '(android|ios)'/, 'the card reads capabilities, not the platform');
    // Words say phone. The buttons in place of Open screen are gone.
    for (const file of [...views, 'src/app/ui/PhoneRow.tsx', 'src/app/ui/WakeButton.tsx']) {
        const strings = read(file).match(/'[^'\n]*'|"[^"\n]*"|>[^<>{}\n]+</g) || [];
        // Words, not names: "devices-page", id="devices" and data-device-key name parts of the page.
        const said = strings.filter(
            (text) => (/\s/.test(text) || text.startsWith('>')) && /(^|[^-\w])[Dd]evices?(?![-\w])/.test(text),
        );
        assert.deepEqual(said, [], `${file} says phone, not device`);
    }
    assert.doesNotMatch(card, /Device unavailable|Waiting for trust|Browser cannot play/);
});
