// Run with: node --test scripts/test-home.js
// The Devices page, its cards and the device switcher, without a browser: names and tab titles,
// the Notifications target, the attention and error statuses, the switcher keys, the tool filter,
// the installed-app name and colours, and what the list takes from the kit: the status chip, the
// unread badge, kit buttons, icons and messages. scripts/e2e-home.js and scripts/e2e-switcher.js
// cover the same changes in a browser.
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
const { Chip, chipClass } = require('../src/app/ui/Chip');
const { Badge, badgeText } = require('../src/app/ui/Badge');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

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

    // A running or starting stream still says so; the header count includes the phone anyway.
    const streaming = iphone('E', { session: 'ready', developerMode: false });
    assert.equal(status(streaming), 'streaming');
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
    assert.equal(listSummary(0, 0, 0), 'Waiting for devices');
    assert.equal(listSummary(2, 0, 0), 'No devices available');
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

test('the Devices page remembers its scroll position and open cards', () => {
    assert.equal(view.savedListScroll(), 0);
    assert.equal(view.wasCardOpen('android:PIXEL-1'), false);
    view.rememberListScroll(1407);
    view.rememberCardOpen('android:PIXEL-1', true);
    view.rememberCardOpen('ios:IPHONE-1', true);
    view.rememberCardOpen('ios:IPHONE-1', false);
    assert.equal(view.savedListScroll(), 1407);
    assert.equal(view.wasCardOpen('android:PIXEL-1'), true);
    assert.equal(view.wasCardOpen('ios:IPHONE-1'), false);
    view.rememberListScroll(0);
    view.rememberCardOpen('android:PIXEL-1', false);
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
        streaming: [iphone('G', { session: 'ready' }), 'Streaming', 'info'],
        attention: [iphone('H', { unlockSchedule: schedule }), 'Needs attention', 'warning'],
        error: [iphone('I', { session: 'error' }), 'Error', 'error'],
    };
    for (const [status, [entry, label, tone]] of Object.entries(cases)) {
        const info = getDeviceStatusInfo(entry);
        assert.deepEqual(info, { status, label, tone }, status);
        assert.match(info.label, /^[A-Z][a-z]+( [a-z]+)?…?$/, `${status} is said in words`);
    }
    assert.equal(/icon:|color:|[▶●▣☾◐○⚠✕]/.test(read('src/app/state/deviceStatus.ts')), false, 'the status module holds no glyph or colour');
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
    const parts = ['AsleepBanner', 'StreamServiceStatus', 'TrackerStatusNotice', 'ErrorBoundary', 'NotificationsLink', 'DeviceIcon'].map(
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
        'src/style/ui/ErrorBoundary.css', 'src/style/ui/DeviceIcon.css',
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
    // Messages: a banner for a condition, a status line under the control for an outcome.
    assert.match(read('src/app/ui/AsleepBanner.tsx'), /<Banner tone="info" action=/);
    assert.match(read('src/app/ui/AsleepBanner.tsx'), /<InlineStatus tone="error">Could not wake the screen\./);
    assert.match(read('src/app/ui/TrackerStatusNotice.tsx'), /<Banner>/);
    const card = read('src/app/views/DeviceCard.tsx');
    assert.equal(/device-unavailable-hint/.test(card), false, 'the grey paragraph for every outcome is gone');
    for (const place of ['developer-mode', 'restart-problem', 'refresh', 'restart', 'remount']) {
        assert.match(card, new RegExp(`\\{feedbackAt\\('${place}'\\)\\}`), `the outcome of ${place} shows under its control`);
    }
    assert.ok((card.match(/<ConfirmPrompt\b/g) || []).length > 0, 'a card asks with the confirm prompt');
    assert.doesNotMatch(card, /<ConfirmPrompt\s[^>]*\bkit\b/, 'which takes no kit prop: its look is the only one');
});
