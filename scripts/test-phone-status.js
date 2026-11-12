// Run with: node --test scripts/test-phone-status.js
// One status model for both kinds of phone (src/app/state/phoneStatus.ts) and one place for the
// status words (src/app/copy.ts): the one precedence over every combination of facts, the same
// status for the same facts on Android and on an iPhone, the session as a second mark, the
// connection words of the header, the card over the picture and the tool chip, the last known
// name, the capabilities table, and no older or local status word anywhere else in src/app.
// No browser and no phone.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
require.extensions['.css'] = () => {};
global.location = new URL('http://localhost:8000/');

const status = require('../src/app/state/phoneStatus');
const copy = require('../src/app/copy');
const { capabilities } = require('../src/app/state/capabilities');
const { activeCoreDeviceStream, activeStream } = require('../src/app/state/stream');
const devices = require('../src/app/state/devices');
const { ICONS } = require('../src/app/ui/icons');
const legacyStatus = require('../src/app/state/deviceStatus');
const legacyService = require('../src/app/state/streamService');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const ATTENTION = { kind: 'developer-mode', level: 'attention', message: copy.PROBLEM.developerMode };
const ERROR = { kind: 'session', level: 'error', message: copy.PROBLEM.sessionFailed };
const PROBLEM_SETS = { none: [], attention: [ATTENTION], error: [ERROR], both: [ERROR, ATTENTION] };

/** Every combination of the facts, each value of each fact once against every other. */
function* allFacts({ sessions = ['starting', 'running', 'failed', 'stopped', 'unknown'], problems = Object.keys(PROBLEM_SETS) } = {}) {
    for (const trusted of [true, false])
        for (const connected of [true, false])
            for (const session of sessions)
                for (const problem of problems)
                    for (const screen of ['on', 'asleep', 'unknown'])
                        for (const lock of ['locked', 'unlocked', 'unknown'])
                            for (const viewed of [false, true])
                                yield { trusted, connected, session, problems: PROBLEM_SETS[problem], screen, lock, viewed };
}

/** The statuses that apply to the facts, each on its own. The primary one is the first of these in the order. */
function applying(facts) {
    return {
        unauthorized: !facts.trusted,
        offline: !facts.connected,
        error: facts.session === 'failed' || facts.problems.some((problem) => problem.level === 'error'),
        starting: facts.session === 'starting',
        attention: facts.problems.some((problem) => problem.level === 'attention'),
        asleep: facts.screen === 'asleep',
        locked: facts.lock === 'locked',
        ready: true,
    };
}

// The adapters read the list entry. These write the same facts into each platform's descriptor.
let serial = 0;
function androidEntry(facts) {
    const udid = `PIXEL-${++serial}`;
    const pid = { running: 4242, stopped: -1, unknown: 0, starting: 0 }[facts.session];
    const descriptor = {
        udid,
        state: !facts.trusted ? 'unauthorized' : facts.connected ? 'device' : 'offline',
        pid,
        interfaces: [],
        'ro.product.manufacturer': 'Google',
        'ro.product.model': 'Pixel 9',
        'screen.power': { on: 'on', asleep: 'off', unknown: 'unknown' }[facts.screen],
        'device.locked': { locked: true, unlocked: false, unknown: 'unknown' }[facts.lock],
    };
    if (facts.screen !== 'unknown') descriptor['device.awake'] = facts.screen === 'on';
    const entry = { key: `android:${udid}`, trackerId: 'android', trackerName: 'Host', params: { type: 'android' }, descriptor };
    if (facts.session === 'starting') status.markStarting(entry.key);
    return entry;
}

function iphoneEntry(facts) {
    const udid = `IPHONE-${++serial}`;
    const descriptor = {
        udid,
        name: 'iPhone 13 Pro Max',
        model: 'iPhone 13 Pro Max',
        version: '27.2',
        state: !facts.trusted ? 'unauthorized' : facts.connected ? 'Connected' : 'disconnected',
        paired: facts.trusted,
        developerMode: !facts.problems.some((problem) => problem.kind === 'developer-mode'),
        session: { starting: 'starting', running: 'ready', failed: 'error', stopped: 'stopped' }[facts.session],
        'screen.power': { on: 'on', asleep: 'off', unknown: 'unknown' }[facts.screen],
        'device.locked': { locked: true, unlocked: false, unknown: 'unknown' }[facts.lock],
    };
    // The session problem of an iPhone is its failed session.
    if (facts.problems.some((problem) => problem.kind === 'session') && facts.session !== 'failed') return undefined;
    return { key: `ios:${udid}`, trackerId: 'ios', trackerName: 'Host', params: { type: 'ios' }, descriptor };
}

/** Shows the phone in this browser for the length of `run`, as the stream views do. */
function viewing(entry, viewed, run) {
    const signal = entry.params.type === 'android' ? activeStream : activeCoreDeviceStream;
    signal.value = viewed ? { params: { udid: entry.descriptor.udid }, client: {} } : undefined;
    try {
        return run();
    } finally {
        signal.value = undefined;
    }
}

const statusOf = (entry, viewed) => viewing(entry, viewed, () => status.getDeviceStatusInfo(entry));

test('one precedence for both kinds of phone, in the order the owner chose', () => {
    assert.deepEqual(status.PHONE_STATUS_ORDER, ['unauthorized', 'offline', 'error', 'starting', 'attention', 'asleep', 'locked', 'ready']);
    assert.deepEqual(Object.keys(copy.STATUS), status.PHONE_STATUS_ORDER, 'copy.ts names every status, in the same order');
    let count = 0;
    for (const facts of allFacts()) {
        const apply = applying(facts);
        const expected = status.PHONE_STATUS_ORDER.find((kind) => apply[kind]);
        const result = status.derivePhoneStatus(facts);
        assert.equal(result.status, expected, JSON.stringify(facts));
        assert.equal(result.label, copy.STATUS[expected]);
        count++;
    }
    assert.equal(count, 2 * 2 * 5 * 4 * 3 * 3 * 2);
});

test('each platform reads its facts from the list and gets the status of those facts', () => {
    for (const facts of allFacts({ problems: ['none'] })) {
        if (facts.session !== 'failed') {
            const entry = androidEntry(facts);
            assert.deepEqual(statusOf(entry, facts.viewed), status.derivePhoneStatus(facts), `Android ${JSON.stringify(facts)}`);
            status.clearStarting(entry.key);
        }
    }
    for (const facts of allFacts({ sessions: ['starting', 'running', 'failed', 'stopped'] })) {
        const entry = iphoneEntry(facts);
        if (!entry) continue;
        assert.deepEqual(statusOf(entry, facts.viewed), status.derivePhoneStatus(facts), `iPhone ${JSON.stringify(facts)}`);
    }
});

test('the same facts give the same status, label, tone and marks on Android and on an iPhone', () => {
    let compared = 0;
    for (const facts of allFacts({ sessions: ['starting', 'running', 'stopped'], problems: ['none'] })) {
        const pixel = androidEntry(facts);
        const phone = iphoneEntry(facts);
        assert.deepEqual(statusOf(pixel, facts.viewed), statusOf(phone, facts.viewed), JSON.stringify(facts));
        status.clearStarting(pixel.key);
        compared++;
    }
    assert.equal(compared, 2 * 2 * 3 * 3 * 3 * 2);
    // What only an iPhone reports is said in the same place of the same order.
    const blocked = { trusted: true, connected: true, session: 'running', problems: [ATTENTION], screen: 'asleep', lock: 'locked', viewed: false };
    assert.equal(statusOf(iphoneEntry(blocked), false).status, 'attention', 'Needs attention keeps its place above Asleep');
});

test('a running session or a viewer is a second mark and never the status', () => {
    for (const facts of allFacts()) {
        const watched = status.derivePhoneStatus({ ...facts, viewed: true });
        const unwatched = status.derivePhoneStatus({ ...facts, viewed: false });
        assert.deepEqual(
            [watched.status, watched.label, watched.tone, watched.screen, watched.lock],
            [unwatched.status, unwatched.label, unwatched.tone, unwatched.screen, unwatched.lock],
            JSON.stringify(facts),
        );
        const reachable = facts.trusted && facts.connected;
        assert.equal(watched.sessionRunning, reachable);
        assert.equal(unwatched.sessionRunning, reachable && facts.session === 'running');
    }
    // The cases of the review: a live session no longer hides Asleep or Locked, on either platform.
    for (const make of [androidEntry, iphoneEntry]) {
        const base = { trusted: true, connected: true, session: 'running', problems: [], viewed: false };
        const asleep = statusOf(make({ ...base, screen: 'asleep', lock: 'locked' }), false);
        assert.deepEqual([asleep.status, asleep.sessionRunning], ['asleep', true]);
        const locked = statusOf(make({ ...base, screen: 'on', lock: 'locked' }), false);
        assert.deepEqual([locked.status, locked.sessionRunning], ['locked', true]);
        const ready = statusOf(make({ ...base, screen: 'on', lock: 'unlocked' }), true);
        assert.deepEqual([ready.status, ready.label, ready.sessionRunning], ['ready', 'Ready', true]);
    }
    assert.equal(Object.values(copy.STATUS).includes('Streaming'), false, 'Streaming is not a status');
});

test('a screen or lock the phone does not report stays unknown and is never asleep or locked', () => {
    // An iPhone whose state probe is off (IOS_STATE_PROBE=0) reports neither, or 'unknown'.
    for (const extra of [{ 'screen.power': 'unknown', 'device.locked': 'unknown' }, { 'screen.power': undefined, 'device.locked': undefined }]) {
        const entry = iphoneEntry({ trusted: true, connected: true, session: 'running', problems: [], screen: 'on', lock: 'unlocked', viewed: false });
        Object.assign(entry.descriptor, extra);
        const info = status.getDeviceStatusInfo(entry);
        assert.deepEqual(
            [info.status, info.screen, info.lock, info.sessionRunning],
            ['ready', 'unknown', 'unknown', true],
            JSON.stringify(extra),
        );
        assert.equal(status.screenFact(info.screen), 'Unknown');
        assert.equal(status.lockFact(info.lock), 'Unknown');
    }
    // An Android phone whose dumpsys says nothing about the screen.
    const pixel = androidEntry({ trusted: true, connected: true, session: 'stopped', problems: [], screen: 'unknown', lock: 'unknown', viewed: false });
    assert.deepEqual([status.getDeviceStatusInfo(pixel).status, status.getDeviceStatusInfo(pixel).screen], ['ready', 'unknown']);
    // A phone that is not connected has no screen or lock to report.
    const away = status.derivePhoneStatus({ trusted: true, connected: false, session: 'stopped', problems: [], screen: 'asleep', lock: 'locked', viewed: false });
    assert.deepEqual([away.status, away.screen, away.lock], ['offline', 'unknown', 'unknown']);
});

test('the optimistic Start flag counts until the phone confirms its stream service', () => {
    const facts = { trusted: true, connected: true, session: 'stopped', problems: [], screen: 'asleep', lock: 'unknown', viewed: false };
    const pixel = androidEntry(facts);
    assert.equal(status.getDeviceStatusInfo(pixel).status, 'asleep');
    status.markStarting(pixel.key);
    assert.equal(status.isDeviceStarting(pixel.key), true);
    assert.equal(status.getDeviceStatusInfo(pixel).status, 'starting', 'Starting ranks above Asleep, as on an iPhone');
    pixel.descriptor.pid = 4242;
    assert.deepEqual([status.getDeviceStatusInfo(pixel).status, status.getDeviceStatusInfo(pixel).sessionRunning], ['asleep', true], 'a confirmed pid ends Starting');
    status.clearStarting(pixel.key);
    assert.equal(status.isDeviceStarting(pixel.key), false);
    // The older import paths still work.
    assert.equal(legacyStatus.getDeviceStatusInfo, status.getDeviceStatusInfo);
    assert.equal(legacyStatus.markStarting, status.markStarting);
    assert.equal(legacyService.getStreamServiceStatus, status.getStreamServiceStatus);
    assert.equal(legacyService.hasRunningStreamService, status.hasRunningStreamService);
});

test('the list header keeps its summary and its count of phones that need attention', () => {
    assert.equal(status.listSummary(0, 0, 0), 'Waiting for devices');
    assert.equal(status.listSummary(2, 0, 0), 'No devices available');
    assert.equal(status.listSummary(3, 3, 1), '3 available · 1 needs attention');
    assert.equal(status.listSummary(4, 3, 2), '3 available · 2 need attention');
    const running = iphoneEntry({ trusted: true, connected: true, session: 'running', problems: [ATTENTION], screen: 'on', lock: 'unlocked', viewed: false });
    assert.equal(status.needsAttention(running), true);
    assert.deepEqual(status.getDeviceProblems(running).map((problem) => problem.kind), ['developer-mode']);
    const failed = iphoneEntry({ trusted: true, connected: true, session: 'failed', problems: [], screen: 'on', lock: 'unlocked', viewed: false });
    assert.deepEqual(status.getDeviceProblems(failed), [{ kind: 'session', level: 'error', message: copy.PROBLEM.sessionFailed }]);
    assert.equal(status.needsAttention(androidEntry({ trusted: true, connected: true, session: 'running', problems: [], screen: 'on', lock: 'unlocked', viewed: false })), false);
});

test('every word of the model comes from copy.ts', () => {
    const fromCopy = (group) => Object.values(group).flatMap((value) => (typeof value === 'object' ? Object.values(value) : [value]));
    for (const kind of status.PHONE_STATUS_ORDER) {
        const facts = { trusted: kind !== 'unauthorized', connected: kind !== 'offline', session: kind === 'starting' ? 'starting' : kind === 'error' ? 'failed' : 'stopped', problems: kind === 'attention' ? [ATTENTION] : [], screen: kind === 'asleep' ? 'asleep' : 'on', lock: kind === 'locked' ? 'locked' : 'unlocked', viewed: false };
        assert.equal(status.derivePhoneStatus(facts).label, copy.STATUS[kind]);
    }
    const connectionWords = [...fromCopy(copy.CONNECTION), ...fromCopy(copy.SCREEN_CONNECTION)];
    for (const state of ['connecting', 'connected', 'reconnecting', 'offline', 'failed', 'stopped']) {
        assert.equal(status.connectionStatus(state).label, copy.CONNECTION[state]);
        for (const detail of Object.keys(copy.SCREEN_CONNECTION)) assert.ok(connectionWords.includes(status.connectionStatus(state, detail).label));
    }
    for (const state of ['running', 'stopped', 'starting', 'offline', 'unauthorized', 'unknown']) {
        const descriptor = { running: { state: 'device', pid: 7 }, stopped: { state: 'device', pid: -1 }, starting: { state: 'device', pid: 0 }, offline: { state: 'offline', pid: 0 }, unauthorized: { state: 'unauthorized', pid: 0 }, unknown: { state: 'device', pid: 0 } }[state];
        const info = status.getStreamServiceStatus(descriptor, state === 'starting');
        assert.deepEqual(info, { state, ...copy.STREAM_SERVICE[state] });
        assert.match(info.description, /stream service/);
        assert.doesNotMatch(info.description, /streaming|device/, `${state}: the tooltip says stream service and phone`);
    }
    // Fact lists print words, not raw values.
    assert.deepEqual(['starting', 'ready', 'error', 'stopped', undefined].map(status.sessionFact), ['Starting', 'Running', 'Failed', 'Stopped', 'Stopped']);
    assert.deepEqual([true, false].map(status.yesNoFact), ['Yes', 'No']);
    assert.deepEqual([true, false, 'unknown', undefined].map(status.onOffFact), ['On', 'Off', 'Unknown', 'Unknown']);
    assert.deepEqual(['on', 'asleep', 'unknown'].map(status.screenFact), ['On', 'Asleep', 'Unknown']);
    assert.deepEqual(['locked', 'unlocked', 'unknown'].map(status.lockFact), ['Locked', 'Unlocked', 'Unknown']);
    // The screen and lock words: one word and one sentence each.
    assert.equal(copy.SCREEN.asleep, 'Asleep');
    assert.equal(copy.SCREEN.asleepSentence, 'Screen is asleep');
    assert.equal(copy.LOCK.locked, 'Locked');
    assert.equal(copy.LOCK.notice, 'Phone locked');
    // The swipe text only where the phone reports no passcode lock. A lock it does not report may
    // still ask for the passcode.
    assert.deepEqual([true, false, 'unknown', undefined].map(status.lockNotice), ['Phone locked', 'Swipe up to unlock', 'Phone locked', 'Phone locked']);
    assert.match(read('src/app/views/LockScreenNotice.tsx'), /\{lockNotice\(locked\)\}/, 'the notice takes its text from the model');
    // Every stream service text says stream service and phone.
    const serviceTexts = Object.values(copy.STREAM_SERVICE).flatMap((value) => (typeof value === 'object' ? Object.values(value) : [value]));
    assert.ok(serviceTexts.includes(copy.STREAM_SERVICE.stoppedMessage));
    assert.deepEqual(serviceTexts.filter((text) => /device|streaming/i.test(text)), []);
    // The model's source says no word of its own: every string in it is a name, not a phrase.
    const source = read('src/app/state/phoneStatus.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/^import[\s\S]*?from '[^']*';$/gm, '');
    const literals = [...source.matchAll(/'([^'\n]*)'|`([^`]*)`/g)].map((match) => match[1] ?? match[2]);
    assert.ok(literals.length > 20);
    assert.deepEqual(literals.filter((text) => text !== '' && !/^[a-z][A-Za-z.-]*$/.test(text)), [], 'phoneStatus.ts has no phrase of its own');
});

test('the connection has one word per state, a red failure, a grey missing phone and an amber wait', () => {
    const tones = { connecting: 'warning', connected: 'success', reconnecting: 'warning', offline: 'neutral', failed: 'error', stopped: 'neutral' };
    for (const [state, tone] of Object.entries(tones)) {
        const info = status.connectionStatus(state);
        assert.deepEqual([info.state, info.tone], [state, tone]);
        assert.ok(info.icon in ICONS, `${state} names an icon of the set`);
    }
    const screen = (facts) => {
        const info = status.screenConnection({ connected: false, hasConnected: false, ...facts });
        return [info.state, info.label, info.tone];
    };
    // Android: a first connection, then a drop. The header and the card over the picture print this one value.
    assert.deepEqual(screen({}), ['connecting', 'Connecting…', 'warning']);
    assert.deepEqual(screen({ connected: true, hasConnected: true }), ['connected', 'Connected', 'success']);
    assert.deepEqual(screen({ hasConnected: true }), ['reconnecting', 'Reconnecting…', 'warning'], 'a page that was connected says Reconnecting');
    assert.deepEqual(screen({ startError: true }), ['failed', 'Unable to connect', 'error']);
    assert.deepEqual(screen({ serviceStopped: true, hasConnected: true }), ['stopped', 'Stopped', 'neutral']);
    assert.deepEqual(screen({ phoneOffline: true, hasConnected: true }), ['offline', 'Offline', 'neutral'], 'an unplugged phone is grey');
    // iPhone: the causes it knows keep their words and take the tone of their state.
    assert.deepEqual(screen({ sessionStarting: true }), ['connecting', 'Starting the phone stream…', 'warning']);
    assert.deepEqual(screen({ sessionStarting: true, hasConnected: true }), ['reconnecting', 'Reconnecting…', 'warning']);
    assert.deepEqual(screen({ decoderError: true }), ['failed', 'No picture', 'error']);
    assert.deepEqual(screen({ failure: { state: 'error', trying: false } }), ['failed', 'Stream unavailable', 'error'], 'Stream unavailable is a failure, in red');
    assert.deepEqual(screen({ failure: { state: 'stopped', trying: false } }), ['stopped', 'Stream stopped', 'neutral']);
    assert.deepEqual(screen({ failure: { state: 'error', trying: true }, hasConnected: true }), ['connecting', 'Trying again…', 'warning']);
    assert.deepEqual(screen({ failure: { state: 'error', trying: false }, connected: true }), ['failed', 'Stream unavailable', 'error'], 'the card wins over a stale Connected');

    const tool = (facts) => status.toolConnection({ failed: false, connected: false, lost: '', phoneOffline: false, ...facts }).label;
    assert.equal(tool({}), 'Connecting…');
    assert.equal(tool({ connected: true }), 'Connected');
    assert.equal(tool({ lost: 'reconnecting' }), 'Reconnecting…');
    assert.equal(tool({ lost: 'ended' }), 'Stopped');
    assert.equal(tool({ lost: 'closed' }), 'Unable to connect');
    assert.equal(tool({ lost: 'closed', phoneOffline: true }), 'Offline');
    assert.equal(tool({ failed: true }), 'Unable to connect');
});

test('the header and the card over the picture print the same connection value', () => {
    for (const file of ['src/app/views/StreamView.tsx', 'src/app/views/CoreDeviceStreamView.tsx']) {
        const source = read(file);
        assert.match(source, /const connection = screenConnection\(\{/, `${file} derives its connection once`);
        assert.match(source, /<AppBarStatus tone=\{connection\.tone\}>\{connection\.label\}<\/AppBarStatus>/, `${file}: the header prints it`);
        assert.match(source, /<SleepOverlay[^>]*connection=\{connection\}/, `${file}: the card over the picture prints it`);
    }
    // The screen fact comes from the model on the card and on the screen alike. No view reads the
    // screen's descriptor fields to decide that a phone is asleep.
    for (const file of ['src/app/views/StreamView.tsx', 'src/app/views/CoreDeviceStreamView.tsx', 'src/app/views/DeviceCard.tsx', 'src/app/views/DeviceSwitcherSheet.tsx', 'src/app/views/SleepOverlay.tsx']) {
        assert.doesNotMatch(read(file), /\['screen\.power'\]|\['device\.awake'\]/, `${file} reads the screen from the model`);
    }
    for (const file of ['src/app/views/StreamView.tsx', 'src/app/views/CoreDeviceStreamView.tsx']) {
        assert.match(read(file), /const screenOff = [^;]*getDeviceStatusInfo\(entry\)\.screen === 'asleep'/, `${file}: the sleep card follows the screen fact`);
    }
    const overlay = read('src/app/views/SleepOverlay.tsx');
    assert.match(overlay, /\{connection\.label\}/);
    assert.doesNotMatch(overlay, /hasConnected/, 'the card keeps no connection state of its own');
    assert.match(read('src/app/views/ToolView.tsx'), /\{connection\.label\}/);
});

test('a phone that drops out of the list keeps its last name', () => {
    const tracker = {};
    const pixel = { udid: 'NAME-PIXEL', state: 'device', pid: 1, interfaces: [], 'ro.product.manufacturer': 'Google', 'ro.product.model': 'Pixel 9' };
    assert.equal(devices.phoneName('NAME-PIXEL'), 'NAME-PIXEL', 'the serial until the list arrives');
    devices.setTrackerDevices('android', 'Host', { type: 'android' }, tracker, [pixel]);
    const listed = devices.findDeviceByUdid('NAME-PIXEL');
    assert.equal(devices.phoneName('NAME-PIXEL', listed), 'Google Pixel 9');
    // Unplugged with the page open: the tracker drops it, and the header keeps the name.
    devices.setTrackerDevices('android', 'Host', { type: 'android' }, tracker, []);
    assert.equal(devices.findDeviceByUdid('NAME-PIXEL'), undefined);
    assert.equal(devices.phoneName('NAME-PIXEL'), 'Google Pixel 9');
    // Listed again without its properties (untrusted): the last name, where the card says what it can.
    devices.updateTrackerDevice('android', 'Host', { type: 'android' }, tracker, { udid: 'NAME-PIXEL', state: 'unauthorized', pid: -1, interfaces: [] });
    const bare = devices.findDeviceByUdid('NAME-PIXEL');
    assert.equal(devices.deviceName(bare), 'Android device');
    assert.equal(devices.phoneName('NAME-PIXEL', bare), 'Google Pixel 9');
    // An iPhone the same way.
    devices.setTrackerDevices('ios', 'Host', { type: 'ios' }, tracker, [{ udid: 'NAME-IPHONE', state: 'Connected', name: 'Bench iPhone', model: 'iPhone 13 Pro Max', version: '27.2' }]);
    devices.removeTrackerDevices('ios');
    assert.equal(devices.phoneName('NAME-IPHONE'), 'Bench iPhone');
    assert.equal(devices.phoneName('NEVER-LISTED'), 'NEVER-LISTED');
    devices.devices.value = new Map();
    // The headers and the tab title choose the name with it.
    for (const file of ['src/app/views/StreamView.tsx', 'src/app/views/CoreDeviceStreamView.tsx', 'src/app/views/ToolView.tsx', 'src/app/state/pageTitle.ts']) {
        assert.match(read(file), /phoneName\(/, `${file} names the phone with phoneName`);
    }
});

test('the capabilities table says what each kind of phone can do today', () => {
    assert.deepEqual(capabilities('android'), {
        files: true, shell: true, panels: true, rotate: false, clipboardRead: true, clipboardPaste: true,
        unlock: 'passcode-field', power: ['power-key'], scheduledUnlock: false, streamQuality: true, typeText: true,
    });
    assert.deepEqual(capabilities('ios'), {
        files: false, shell: false, panels: false, rotate: true, clipboardRead: true, clipboardPaste: false,
        unlock: 'server-passcode', power: ['side-button', 'reboot', 'shutdown'], scheduledUnlock: true, streamQuality: false, typeText: true,
    });
    const pixel = { params: { type: 'android' }, descriptor: { udid: 'P' } };
    const phone = { params: { type: 'ios' }, descriptor: { udid: 'I' } };
    assert.equal(capabilities(pixel), capabilities('android'));
    assert.equal(capabilities(phone), capabilities('ios'));
    assert.deepEqual([devices.supportsDeviceTools(pixel), devices.supportsDeviceTools(phone)], [true, false]);

    // Each value against the code that does it.
    const android = { actions: read('src/app/views/ActionsSheet.tsx'), settings: read('src/app/views/SettingsSheet.tsx'), toolbox: read('src/app/googDevice/toolbox/GoogToolBox.ts'), unlock: read('src/app/views/UnlockSheet.tsx') };
    const ios = { actions: read('src/app/views/ApplActionsSheet.tsx'), settings: read('src/app/views/ApplSettingsSheet.tsx'), toolbox: read('src/app/applDevice/toolbox/ApplToolBox.ts'), unlock: read('src/app/views/ApplUnlockSheet.tsx') };
    const tools = read('src/app/views/ToolView.tsx');
    assert.match(tools, /view: 'files'/);
    assert.match(tools, /view: 'shell'/);
    // The one Actions sheet shows its rows by this table; each platform's wrapper sends.
    assert.match(read('src/app/views/actions/PhoneActionsSheet.tsx'), /capabilities\(adapter\.platform\)/);
    assert.match(android.actions, /TYPE_EXPAND_NOTIFICATION_PANEL/);
    assert.doesNotMatch(ios.actions, /panel/i);
    assert.match(ios.actions, /client\.rotate\(/);
    assert.doesNotMatch(android.actions + android.toolbox, /[Rr]otate/);
    assert.match(android.actions, /createGetClipboardCommand\(/);
    assert.match(ios.actions, /client\.requestClipboard\(\)/);
    assert.match(android.actions, /createSetClipboardCommand\(text, true\)/, 'Android pastes into the focused field');
    assert.match(ios.actions, /client\.setClipboard\(text\)/, 'an iPhone only sets its clipboard');
    assert.match(android.unlock, /type="password"/);
    assert.doesNotMatch(ios.unlock, /<input/, 'the iPhone uses the passcode stored on the server');
    assert.match(ios.unlock, /runUnlockNow\(/);
    assert.match(android.toolbox, /title: 'Power'/);
    assert.match(ios.toolbox, /title: 'Lock', name: 'lock', icon: 'power'/);
    assert.match(ios.actions, /ControlCenterCommand\.REBOOT_DEVICE/);
    assert.match(ios.actions, /ControlCenterCommand\.SHUTDOWN_DEVICE/);
    assert.doesNotMatch(android.actions, /REBOOT|SHUTDOWN/);
    assert.match(ios.settings, /title="Scheduled unlock"/);
    assert.doesNotMatch(android.settings, /Scheduled unlock/);
    assert.match(android.settings, /title="Stream quality"/);
    assert.doesNotMatch(ios.settings, /Stream quality/);
    for (const platform of [android, ios]) assert.match(platform.toolbox, /new ToolBoxButton\('Type text'/);
});

test('no older status word and no status literal is left outside copy.ts', () => {
    const OLDER = ['Screen is off', 'Screen is asleep.', 'Device locked', 'Lock screen active', 'streaming service', 'Connecting to device…', 'Connecting…', 'Reconnecting…', "'Streaming'"];
    const found = [];
    const walk = (dir) => {
        for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            const file = `${dir}/${item.name}`;
            if (item.isDirectory()) walk(file);
            else if (/\.(ts|tsx)$/.test(item.name) && file !== 'src/app/copy.ts') {
                const source = read(file);
                for (const word of OLDER) if (source.includes(word)) found.push(`${file}: ${word}`);
            }
        }
    };
    walk('src/app');
    assert.deepEqual(found, []);
    const words = read('src/app/copy.ts');
    for (const word of ['Connecting…', 'Reconnecting…']) assert.ok(words.includes(word), `copy.ts holds ${word}`);
});
