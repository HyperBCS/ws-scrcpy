// Run with: node --test scripts/test-ios-settings-store.js
// The iPhone settings store (src/server/appl-device/services/IosSettingsStore.ts) and the four
// unlock commands in the iOS ControlCenter, against a temp data directory; no device required.
// The scheduler is a fake throughout: its own behaviour is covered by scripts/test-ios-unlock.js.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-ios-settings-'));
const previousEnv = {
    WS_NOTIFICATION_DATA: process.env.WS_NOTIFICATION_DATA,
    IOS_STATE_PROBE: process.env.IOS_STATE_PROBE,
};
// The store defaults to the data directory; the monitor must not probe anything from here.
process.env.WS_NOTIFICATION_DATA = path.join(temporary, 'data');
process.env.IOS_STATE_PROBE = '0';

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

const {
    IosSettingsStore,
    IOS_SETTINGS_FILE,
    IOS_SETTINGS_BAD_FILE,
    IOS_SETTINGS_KEY_FILE,
    IOS_SETTINGS_KEY_ENV,
} = require('../src/server/appl-device/services/IosSettingsStore');
const { DEFAULT_UNLOCK_TIME, nextUnlockRunAt, localTimeZone } = require('../src/common/IosUnlockSchedule');
const { ControlCenterCommand } = require('../src/common/ControlCenterCommand');
const { ControlCenter: IosControlCenter } = require('../src/server/appl-device/services/ControlCenter');
const { UnlockScheduler } = require('../src/server/appl-device/services/UnlockScheduler');
const { PyMobileDevice } = require('../src/server/appl-device/services/PyMobileDevice');
const { CoreDeviceRunner } = require('../src/server/appl-device/services/CoreDeviceRunner');
const { DeviceStateMonitor } = require('../src/server/appl-device/services/DeviceStateMonitor');
const { DeviceTracker } = require('../src/server/appl-device/mw/DeviceTracker');
const { DeviceState } = require('../src/common/DeviceState');

after(() => {
    if (CoreDeviceRunner.hasInstance()) {
        CoreDeviceRunner.getInstance().release();
    }
    if (DeviceStateMonitor.hasInstance()) {
        DeviceStateMonitor.getInstance().release();
    }
    fs.rmSync(temporary, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const withEnv = (env, run) => {
    const previous = {};
    for (const [key, value] of Object.entries(env)) {
        previous[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    const restore = () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
    try {
        const result = run();
        return result && typeof result.then === 'function' ? result.finally(restore) : (restore(), result);
    } catch (error) {
        restore();
        throw error;
    }
};

let counter = 0;
const freshDir = () => path.join(temporary, `store-${++counter}`);
const readJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, IOS_SETTINGS_FILE), 'utf8'));
const writeJson = (dir, value) => fs.writeFileSync(path.join(dir, IOS_SETTINGS_FILE), JSON.stringify(value));
const mode = (file) => fs.statSync(file).mode & 0o777;
const DAY = 24 * 3600 * 1000;

test('the data directory and both files are private, and the passcode is never on disk in clear', () => {
    const store = new IosSettingsStore();
    assert.equal(store.directory, path.join(temporary, 'data'), 'defaults to the data directory');
    store.load();
    store.load();
    assert.equal(mode(store.directory), 0o700);
    assert.equal(fs.existsSync(path.join(store.directory, IOS_SETTINGS_FILE)), false, 'nothing is written on load');

    const status = store.setPasscode('iphone-a', '135790');
    assert.equal(mode(path.join(store.directory, IOS_SETTINGS_FILE)), 0o600);
    assert.equal(mode(path.join(store.directory, IOS_SETTINGS_KEY_FILE)), 0o600);
    assert.equal(fs.readFileSync(path.join(store.directory, IOS_SETTINGS_KEY_FILE)).length, 32);
    const raw = fs.readFileSync(path.join(store.directory, IOS_SETTINGS_FILE), 'utf8');
    assert.equal(raw.includes('135790'), false);
    assert.equal(raw.includes(Buffer.from('135790').toString('base64')), false);
    assert(raw.includes('"iv"') && raw.includes('"tag"') && raw.includes('"data"'));
    assert.deepEqual(status, {
        enabled: false,
        time: DEFAULT_UNLOCK_TIME,
        hasPasscode: true,
        serverTimeZone: localTimeZone(),
    });
    assert.equal('passcode' in status, false, 'the status never carries the passcode');
    assert.equal(store.readPasscode('iphone-a'), '135790');
    assert.equal(
        fs.readdirSync(store.directory).some((name) => name.endsWith('.tmp')),
        false,
    );
    assert.deepEqual(store.listUdids(), ['iphone-a']);
    store.release();
});

test('ciphertext is bound to its device and its key; a failure says so without the passcode', () => {
    const dir = freshDir();
    const store = new IosSettingsStore(dir);
    store.setPasscode('iphone-a', '246813');
    const file = readJson(dir);
    assert.equal(file.version, 1);
    const record = file.devices['iphone-a'].unlock;
    assert.equal(Buffer.from(record.passcode.iv, 'base64').length, 12);
    assert.equal(Buffer.from(record.passcode.tag, 'base64').length, 16);

    // Same ciphertext under another udid: the AAD does not match.
    file.devices['iphone-b'] = { unlock: { enabled: true, time: '04:30', passcode: record.passcode } };
    // Same udid, one byte of the ciphertext changed.
    const tampered = Buffer.from(record.passcode.data, 'base64');
    tampered[0] ^= 0xff;
    file.devices['iphone-c'] = {
        unlock: { enabled: false, time: '03:00', passcode: { ...record.passcode, data: tampered.toString('base64') } },
    };
    writeJson(dir, file);

    const again = new IosSettingsStore(dir);
    assert.equal(again.readPasscode('iphone-a'), '246813');
    for (const udid of ['iphone-b', 'iphone-c']) {
        assert.throws(
            () => again.readPasscode(udid),
            (error) => {
                assert.match(error.message, /^Stored passcode unreadable/);
                assert.equal(error.message.includes('246813'), false);
                assert.doesNotMatch(error.message, /\d{4,}/);
                return true;
            },
        );
    }
    // getSchedule does not decrypt, so a wrong key is only found out by readPasscode.
    assert.equal(again.getSchedule('iphone-b').hasPasscode, true);
    assert.throws(() => again.readPasscode('iphone-none'), /No passcode stored/);
    // A second write produces a new IV for the same device.
    again.setPasscode('iphone-a', '246813');
    assert.notEqual(readJson(dir).devices['iphone-a'].unlock.passcode.iv, record.passcode.iv);
    assert.equal(again.readPasscode('iphone-a'), '246813');
});

test('the key file is created once, shared by every device and read back by a fresh store', () => {
    const dir = freshDir();
    const keyFile = path.join(dir, IOS_SETTINGS_KEY_FILE);
    const store = new IosSettingsStore(dir);
    store.load();
    assert.equal(fs.existsSync(keyFile), false, 'no key before the first passcode');
    store.updateSchedule('iphone-a', { enabled: true });
    assert.equal(fs.existsSync(keyFile), false, 'a schedule change needs no key');

    store.setPasscode('iphone-a', '1111');
    const key = fs.readFileSync(keyFile);
    store.setPasscode('iphone-b', '2222');
    assert.deepEqual(fs.readFileSync(keyFile), key, 'the second device reuses the key');

    const cleared = store.clearPasscode('iphone-a');
    assert.equal(cleared.hasPasscode, false);
    assert.equal(cleared.enabled, true, 'clearing the passcode leaves the switch alone');
    assert.equal(cleared.nextRunAt, undefined);
    assert.equal('passcode' in readJson(dir).devices['iphone-a'].unlock, false);
    assert.deepEqual(fs.readFileSync(keyFile), key, 'clearing never rotates the key');
    assert.throws(() => store.readPasscode('iphone-a'), /No passcode stored/);

    const again = new IosSettingsStore(dir);
    assert.equal(again.readPasscode('iphone-b'), '2222');
    assert.deepEqual(again.listUdids().sort(), ['iphone-a', 'iphone-b']);
    assert.deepEqual(fs.readFileSync(keyFile), key);
});

test('WS_IOS_SETTINGS_KEY replaces the key file; an unusable value is reported, not echoed', () => {
    const dir = freshDir();
    const hex = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
    withEnv({ [IOS_SETTINGS_KEY_ENV]: hex }, () => {
        const store = new IosSettingsStore(dir);
        store.setPasscode('iphone-env', '975310');
        assert.equal(fs.existsSync(path.join(dir, IOS_SETTINGS_KEY_FILE)), false, 'no key file with the env key');
        assert.equal(store.readPasscode('iphone-env'), '975310');
    });
    withEnv({ [IOS_SETTINGS_KEY_ENV]: hex.toUpperCase() }, () => {
        assert.equal(new IosSettingsStore(dir).readPasscode('iphone-env'), '975310', 'hex case does not matter');
    });
    withEnv({ [IOS_SETTINGS_KEY_ENV]: 'b'.repeat(64) }, () => {
        assert.throws(() => new IosSettingsStore(dir).readPasscode('iphone-env'), /Stored passcode unreadable/);
    });
    withEnv({ [IOS_SETTINGS_KEY_ENV]: 'short' }, () => {
        const errors = [];
        const original = console.error;
        console.error = (line) => errors.push(String(line));
        try {
            const store = new IosSettingsStore(dir);
            const status = store.getSchedule('iphone-env');
            assert.equal(status.hasPasscode, false);
            store.getSchedule('iphone-env');
            assert.throws(
                () => store.setPasscode('iphone-env', '975310'),
                (error) => !error.message.includes('975310') && /64 hex/.test(error.message),
            );
            assert.equal(
                fs.existsSync(path.join(dir, IOS_SETTINGS_KEY_FILE)),
                false,
                'a bad env key never falls back to a file',
            );
        } finally {
            console.error = original;
        }
        assert.equal(
            errors.filter((line) => line.includes(IOS_SETTINGS_KEY_ENV)).length,
            1,
            'reported once, not on every status read',
        );
        assert.equal(
            errors.some((line) => line.includes('975310')),
            false,
        );
    });
    // Without the env key the ciphertext is unreadable, which is reported and not thrown.
    assert.equal(new IosSettingsStore(dir).getSchedule('iphone-env').hasPasscode, false);
});

test('ciphertext without its key is reported through the status and never thrown at startup', () => {
    const dir = freshDir();
    const store = new IosSettingsStore(dir);
    store.updateSchedule('iphone-k', { enabled: true, time: '05:45' });
    store.setPasscode('iphone-k', '4321');
    store.recordRun('iphone-k', { at: 1700000000000, trigger: 'schedule', outcome: 'unlocked' });
    assert.equal(store.getSchedule('iphone-k').hasPasscode, true);
    fs.rmSync(path.join(dir, IOS_SETTINGS_KEY_FILE));

    for (const candidate of [store, new IosSettingsStore(dir)]) {
        candidate.load();
        const status = candidate.getSchedule('iphone-k');
        assert.equal(status.hasPasscode, false);
        assert.equal(status.enabled, true, 'the switch is left as it was');
        assert.equal(status.time, '05:45');
        assert.equal(status.nextRunAt, undefined, 'no run can happen without the key');
        assert.equal(status.lastRun.message, 'Stored passcode unreadable: key file missing');
        assert.equal(status.lastRun.outcome, 'skipped-no-passcode', 'not the outcome of the run that had a key');
        assert.equal(status.lastRun.trigger, 'schedule');
        assert(status.lastRun.at > 1700000000000, 'as of the time the store was read');
        assert.throws(() => candidate.readPasscode('iphone-k'), /key file missing/);
        assert.deepEqual(candidate.listUdids(), ['iphone-k']);
        assert.deepEqual(candidate.getProblems(), [
            'Stored passcode unreadable: key file missing. Scheduled unlock cannot run until the passcode is saved again.',
        ]);
    }
    // A device with ciphertext and no run yet still gets a readable lastRun.
    const file = readJson(dir);
    delete file.devices['iphone-k'].unlock.lastRun;
    writeJson(dir, file);
    const unseen = new IosSettingsStore(dir).getSchedule('iphone-k');
    assert.equal(unseen.hasPasscode, false);
    assert.equal(unseen.lastRun.message, 'Stored passcode unreadable: key file missing');
    assert.equal(typeof unseen.lastRun.at, 'number');
    // Entering the passcode again writes a new key and works as before.
    const reentered = new IosSettingsStore(dir);
    assert.equal(reentered.setPasscode('iphone-k', '8765').hasPasscode, true);
    assert.equal(reentered.readPasscode('iphone-k'), '8765');
    assert.deepEqual(reentered.getProblems(), []);
});

test('the time zone is stored with the schedule; a record without one is server time and says so', () => {
    const dir = freshDir();
    const store = new IosSettingsStore(dir);
    store.setPasscode('iphone-z', '4321');
    const legacy = store.updateSchedule('iphone-z', { enabled: true, time: '03:00' });
    assert.equal(legacy.timeZone, undefined);
    assert.equal(legacy.serverTimeZone, localTimeZone(), 'the panel can name the server zone');
    assert(Math.abs(legacy.nextRunAt - nextUnlockRunAt('03:00', Date.now())) <= 1000);

    const zoned = store.updateSchedule('iphone-z', { time: '03:00', timeZone: 'Pacific/Auckland' });
    assert.equal(zoned.timeZone, 'Pacific/Auckland');
    assert.equal(zoned.serverTimeZone, undefined);
    assert(Math.abs(zoned.nextRunAt - nextUnlockRunAt('03:00', Date.now(), 'Pacific/Auckland')) <= 1000);
    assert.equal(readJson(dir).devices['iphone-z'].unlock.timeZone, 'Pacific/Auckland');
    assert.equal(new IosSettingsStore(dir).getSchedule('iphone-z').timeZone, 'Pacific/Auckland', 'survives a reload');
    assert.equal(
        store.updateSchedule('iphone-z', { enabled: false }).timeZone,
        'Pacific/Auckland',
        'a patch without a zone keeps it',
    );

    // A zone this runtime does not know is dropped on load rather than trusted.
    const file = readJson(dir);
    file.devices['iphone-z'].unlock.timeZone = 'Mars/Olympus_Mons';
    writeJson(dir, file);
    assert.equal(new IosSettingsStore(dir).getSchedule('iphone-z').timeZone, undefined);
});

test('a rejected passcode is marked in the status, stops nextRunAt, and is cleared by saving or removing the passcode', () => {
    const dir = freshDir();
    const store = new IosSettingsStore(dir);
    store.setPasscode('iphone-r', '4321');
    store.updateSchedule('iphone-r', { enabled: true });
    assert.equal(store.getSchedule('iphone-r').passcodeRejected, undefined);
    store.setRunState('iphone-r', { passcodeRejectedAt: 1700000000000, unconfirmedAttempts: 1, deadlineWarnedFor: 5 });
    const rejected = new IosSettingsStore(dir).getSchedule('iphone-r');
    assert.equal(rejected.passcodeRejected, true, 'survives a restart');
    assert.equal(rejected.hasPasscode, true);
    assert.equal(rejected.nextRunAt, undefined, 'no run is announced while it is rejected');
    assert.deepEqual(store.getRunState('iphone-r'), {
        passcodeRejectedAt: 1700000000000,
        unconfirmedAttempts: 1,
        deadlineWarnedFor: 5,
    });

    const saved = store.setPasscode('iphone-r', '8765');
    assert.equal(saved.passcodeRejected, undefined);
    assert.equal(typeof saved.nextRunAt, 'number');
    assert.deepEqual(store.getRunState('iphone-r'), { deadlineWarnedFor: 5 }, 'the mark belongs to the old passcode');

    store.setRunState('iphone-r', { passcodeRejectedAt: 1700000000000, deadlineWarnedFor: undefined });
    assert.deepEqual(store.getRunState('iphone-r'), { passcodeRejectedAt: 1700000000000 });
    assert.equal(store.clearPasscode('iphone-r').passcodeRejected, undefined);
    assert.deepEqual(store.getRunState('iphone-r'), {});
});

test('defaults, schedule patches, nextRunAt and the scheduler bookkeeping survive a reload', () => {
    const dir = freshDir();
    const store = new IosSettingsStore(dir);
    assert.deepEqual(store.getSchedule('iphone-new'), {
        enabled: false,
        time: DEFAULT_UNLOCK_TIME,
        hasPasscode: false,
    });
    assert.deepEqual(store.getRunState('iphone-new'), {});
    assert.deepEqual(store.listUdids(), []);

    const before = Date.now();
    const enabled = store.updateSchedule('iphone-s', { enabled: true });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.nextRunAt, undefined, 'no next run without a passcode');
    const armed = store.setPasscode('iphone-s', '0000');
    assert(armed.nextRunAt > before, 'the next run is in the future');
    assert(armed.nextRunAt <= Date.now() + DAY, 'and within a day');
    assert.equal(nextUnlockRunAt('03:00', before) > before && nextUnlockRunAt('03:00', before) <= before + DAY, true);

    const timed = store.updateSchedule('iphone-s', { time: '23:15' });
    assert.equal(timed.time, '23:15');
    const expected = nextUnlockRunAt('23:15', Date.now());
    assert(Math.abs(timed.nextRunAt - expected) <= 1000);
    assert.equal(new Date(timed.nextRunAt).getHours(), 23);
    assert.equal(new Date(timed.nextRunAt).getMinutes(), 15);
    assert.equal(store.updateSchedule('iphone-s', { enabled: false }).nextRunAt, undefined);
    assert.equal(store.updateSchedule('iphone-s', { enabled: true, time: '06:00' }).time, '06:00');
    assert.equal(store.getSchedule('iphone-s').running, undefined, 'the store never claims a run is in progress');

    const run = { at: 1700000001000, trigger: 'manual', outcome: 'failed-still-locked', message: 'Lock not confirmed' };
    store.recordUnlockedAt('iphone-s', 1700000000000);
    store.recordRun('iphone-s', run);
    store.setRetryAt('iphone-s', 1700000600000);
    store.setLastSlotAt('iphone-s', 1699999000000);
    assert.deepEqual(store.getRunState('iphone-s'), {
        lastUnlockedAt: 1700000000000,
        retryAt: 1700000600000,
        lastSlotAt: 1699999000000,
    });

    const again = new IosSettingsStore(dir);
    again.load();
    const status = again.getSchedule('iphone-s');
    assert.equal(status.enabled, true);
    assert.equal(status.time, '06:00');
    assert.equal(status.hasPasscode, true);
    assert.equal(status.lastUnlockedAt, 1700000000000);
    assert.deepEqual(status.lastRun, run);
    assert.equal('retryAt' in status, false, 'the retry is scheduler bookkeeping, not public status');
    assert.deepEqual(again.getRunState('iphone-s'), store.getRunState('iphone-s'));
    again.setRetryAt('iphone-s', undefined);
    assert.deepEqual(again.getRunState('iphone-s'), { lastUnlockedAt: 1700000000000, lastSlotAt: 1699999000000 });
    assert.equal('retryAt' in readJson(dir).devices['iphone-s'].unlock, false);
    // The copy handed out is not the stored object.
    again.getSchedule('iphone-s').lastRun.message = 'changed by a caller';
    assert.equal(again.getSchedule('iphone-s').lastRun.message, 'Lock not confirmed');
});

test('a damaged settings file is logged, kept as .bad and reported; a foreign one is filtered; neither throws', () => {
    const errors = [];
    const original = console.error;
    console.error = (line) => errors.push(String(line));
    try {
        const broken = freshDir();
        fs.mkdirSync(broken, { recursive: true });
        fs.writeFileSync(path.join(broken, IOS_SETTINGS_FILE), '{not json');
        const store = new IosSettingsStore(broken);
        store.load();
        assert.deepEqual(store.getSchedule('iphone-x'), {
            enabled: false,
            time: DEFAULT_UNLOCK_TIME,
            hasPasscode: false,
        });
        assert.deepEqual(store.getProblems(), [
            'ios-settings.json could not be read, so no scheduled unlock is set. It was kept as ios-settings.json.bad.',
        ]);
        assert.equal(
            fs.existsSync(path.join(broken, IOS_SETTINGS_FILE)),
            false,
            'moved aside, not left to be overwritten',
        );
        assert.equal(store.updateSchedule('iphone-x', { time: '01:00' }).time, '01:00');
        assert.equal(readJson(broken).devices['iphone-x'].unlock.time, '01:00', 'the next write starts a new file');
        assert.equal(
            fs.readFileSync(path.join(broken, IOS_SETTINGS_BAD_FILE), 'utf8'),
            '{not json',
            'the unreadable file is still there after that write',
        );

        const foreign = freshDir();
        fs.mkdirSync(foreign, { recursive: true });
        writeJson(foreign, {
            version: 1,
            devices: {
                good: { unlock: { enabled: true, time: '02:00', lastUnlockedAt: 5, retryAt: 'soon' } },
                bad: { unlock: { enabled: 'yes', time: '02:00' } },
                worse: { unlock: { enabled: true, time: '25:00' } },
                empty: {},
                list: [],
            },
        });
        const picky = new IosSettingsStore(foreign);
        assert.deepEqual(picky.listUdids(), ['good']);
        assert.deepEqual(picky.getRunState('good'), { lastUnlockedAt: 5 });
        assert.equal(picky.getSchedule('bad').enabled, false);
        assert.deepEqual(picky.getProblems(), [], 'a readable file with unusable entries is not a problem to push');
        assert.equal(fs.existsSync(path.join(foreign, IOS_SETTINGS_BAD_FILE)), false);

        const wrongVersion = freshDir();
        fs.mkdirSync(wrongVersion, { recursive: true });
        writeJson(wrongVersion, { version: 2, devices: { x: { unlock: { enabled: true, time: '02:00' } } } });
        assert.deepEqual(new IosSettingsStore(wrongVersion).listUdids(), []);
    } finally {
        console.error = original;
    }
    assert.equal(errors.length, 2, 'one line for the broken file, one for the unknown version');
    assert(errors.every((line) => line.startsWith('[IosSettingsStore]')));
});

test('the singleton is dropped by release and only by its own release', () => {
    const first = IosSettingsStore.getInstance();
    assert.equal(IosSettingsStore.hasInstance(), true);
    assert.equal(IosSettingsStore.getInstance(), first);
    new IosSettingsStore(freshDir()).release();
    assert.equal(IosSettingsStore.hasInstance(), true, 'a test instance does not drop the singleton');
    first.release();
    assert.equal(IosSettingsStore.hasInstance(), false);
});

const unlockCommand = (type, data) => ControlCenterCommand.fromJSON(JSON.stringify({ id: 7, type, data }));

test('the four unlock commands reply with the scheduler result as JSON and nothing else', async () => {
    const udid = 'iphone-cmd';
    const center = Object.create(IosControlCenter.prototype);
    center.tracked = new Map([[udid, { descriptor: { udid, state: DeviceState.CONNECTED }, detailsAt: 0 }]]);
    const status = { enabled: true, time: '03:00', hasPasscode: true, nextRunAt: 1700000000000 };
    const result = { at: 1700000000000, trigger: 'manual', outcome: 'unlocked', message: 'Locked again' };
    const calls = [];
    center.scheduler = {
        updateSchedule: (id, patch) => (calls.push(['updateSchedule', id, patch]), status),
        setPasscode: (id, passcode) => (calls.push(['setPasscode', id, passcode]), status),
        clearPasscode: (id) => (calls.push(['clearPasscode', id]), status),
        runNow: async (id, trigger, options) => {
            calls.push(['runNow', id, trigger, options]);
            await tick();
            return result;
        },
    };

    const replies = [
        await center.runCommand(
            unlockCommand('update_unlock_schedule', { udid, schedule: { enabled: true, extra: 'dropped' } }),
        ),
        await center.runCommand(
            unlockCommand('update_unlock_schedule', { udid, schedule: { time: '04:00', timeZone: 'Europe/Berlin' } }),
        ),
        await center.runCommand(unlockCommand('set_unlock_passcode', { udid, passcode: '0987654321' })),
        await center.runCommand(unlockCommand('clear_unlock_passcode', { udid })),
        await center.runCommand(unlockCommand('run_unlock_now', { udid })),
        await center.runCommand(unlockCommand('run_unlock_now', { udid, keepUnlocked: true, extra: 'dropped' })),
        await center.runCommand(unlockCommand('run_unlock_now', { udid, keepUnlocked: 'yes' })),
    ];
    for (const reply of replies) assert.equal(typeof reply, 'string', 'the tracker forwards strings as-is');
    assert.deepEqual(replies.slice(0, 4).map(JSON.parse), [status, status, status, status]);
    assert.deepEqual(replies.slice(4).map(JSON.parse), [result, result, result]);
    assert.deepEqual(calls, [
        ['updateSchedule', udid, { enabled: true }],
        ['updateSchedule', udid, { time: '04:00', timeZone: 'Europe/Berlin' }],
        ['setPasscode', udid, '0987654321'],
        ['clearPasscode', udid],
        ['runNow', udid, 'manual', { keepUnlocked: false }],
        ['runNow', udid, 'manual', { keepUnlocked: true }],
        ['runNow', udid, 'manual', { keepUnlocked: false }],
    ]);

    // A refused run (cooldown) reaches the browser as the command's error.
    center.scheduler.runNow = () => Promise.reject(new Error('Try again in 90 s.'));
    await assert.rejects(center.runCommand(unlockCommand('run_unlock_now', { udid })), /Try again in 90 s\./);

    await assert.rejects(
        center.runCommand(unlockCommand('run_unlock_now', { udid: 'iphone-other' })),
        /Device with udid:"iphone-other" not found/,
    );
    center.scheduler = undefined;
    for (const [type, data] of [
        ['update_unlock_schedule', { udid, schedule: { enabled: false } }],
        ['set_unlock_passcode', { udid, passcode: '1234' }],
        ['clear_unlock_passcode', { udid }],
        ['run_unlock_now', { udid }],
    ]) {
        await assert.rejects(
            center.runCommand(unlockCommand(type, data)),
            /^Error: Scheduled unlock is not available$/,
        );
    }
});

test('an invalid passcode, time or device id is rejected without the value in the message', () => {
    for (const passcode of ['123', 'abcdef', '12345678901', 1234, '12 34', '', null, undefined]) {
        assert.throws(
            () => unlockCommand('set_unlock_passcode', { udid: 'iphone-v', passcode }),
            (error) => error.message === 'Invalid passcode: use 4 to 10 digits',
        );
    }
    for (const schedule of [
        { time: '25:00' },
        { time: '3:00' },
        { enabled: 'yes' },
        { time: '03:00', timeZone: 'Nowhere/Special' },
        { timeZone: 'UTC' },
        {},
        { other: 1 },
        'x',
        null,
    ]) {
        assert.throws(
            () => unlockCommand('update_unlock_schedule', { udid: 'iphone-v', schedule }),
            (error) => {
                assert.equal(
                    error.message,
                    'Invalid "schedule" value: expected "enabled" (boolean) or "time" (HH:MM), with an optional "timeZone"',
                );
                return true;
            },
        );
    }
    for (const type of ['update_unlock_schedule', 'set_unlock_passcode', 'clear_unlock_passcode', 'run_unlock_now']) {
        assert.throws(
            () => unlockCommand(type, { schedule: { enabled: true }, passcode: '1234' }),
            /Missing device id/,
        );
    }
    const valid = unlockCommand('set_unlock_passcode', { udid: 'iphone-v', passcode: '00001111' });
    assert.equal(valid.getPasscode(), '00001111');
    assert.equal(valid.getUnlockSchedule(), undefined);
    assert.deepEqual(
        unlockCommand('update_unlock_schedule', { udid: 'iphone-v', schedule: { time: '00:00' } }).getUnlockSchedule(),
        {
            time: '00:00',
        },
    );
});

test('the tracker log names the command and device, never the message body', async () => {
    const errors = [];
    const sent = [];
    const tracker = Object.create(DeviceTracker.prototype);
    tracker.sendMessage = (message) => sent.push(message);
    tracker.icc = {
        runCommand: async (command) => {
            if (command.getType() === 'set_unlock_passcode') throw new Error('Scheduled unlock is not available');
            return 'ok';
        },
    };
    const original = console.error;
    console.error = (line) => errors.push(String(line));
    try {
        const message = (body) =>
            tracker.onSocketMessage({ data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
        // Rejected by validation: the body never reaches ControlCenter.
        message({ id: 1, type: 'set_unlock_passcode', data: { udid: 'iphone-log', passcode: 'ab12cd' } });
        message({ id: 2, type: 'set_unlock_passcode', data: { udid: 'iphone-log', passcode: '12' } });
        // Valid, rejected by ControlCenter: the reply carries the error, the log the type and udid.
        message({ id: 3, type: 'set_unlock_passcode', data: { udid: 'iphone-log', passcode: '2468135790' } });
        message({ id: 4, type: 'run_unlock_now', data: { udid: 'iphone-log' } });
        message('not json at all 5555');
        message({ id: 6, type: { nested: '7777' }, data: { udid: 'iphone-log' } });
        await tick();
        await tick();
    } finally {
        console.error = original;
    }
    assert.equal(errors.length, 5, 'every rejection is logged once');
    for (const line of errors) {
        assert.equal(line.includes('ab12cd'), false);
        assert.equal(line.includes('2468135790'), false);
        assert.equal(line.includes('5555'), false);
        assert.equal(line.includes('7777'), false);
        assert.doesNotMatch(line, /"passcode"\s*:|"data"\s*:/, 'the data object is not printed');
    }
    const count = (pattern) => errors.filter((line) => pattern.test(line)).length;
    assert.equal(
        count(/Rejected "set_unlock_passcode" for iphone-log\. Error: Invalid passcode: use 4 to 10 digits$/),
        2,
    );
    assert.equal(
        count(/Command "set_unlock_passcode" for iphone-log failed\. Error: Scheduled unlock is not available$/),
        1,
    );
    assert.equal(
        count(/Rejected unparseable message\. Error: not valid JSON$/),
        1,
        'JSON.parse quotes its input; that text is dropped',
    );
    assert.equal(count(/Rejected "no type" for iphone-log\. Error: Unknown command/), 1);
    sent.sort((a, b) => a.id - b.id);
    assert.deepEqual(sent, [
        {
            id: 3,
            type: 'set_unlock_passcode',
            data: { udid: 'iphone-log', error: 'Scheduled unlock is not available' },
        },
        { id: 4, type: 'run_unlock_now', data: { udid: 'iphone-log', result: 'ok' } },
    ]);
});

function fakeScheduler(started, status) {
    const scheduler = new EventEmitter();
    scheduler.start = (options) => started.push(options);
    scheduler.getStatus = (udid) => ({ ...status, time: udid.length > 0 ? status.time : '' });
    scheduler.release = () => started.push('released');
    return scheduler;
}

function mockDeviceList(t, udid) {
    t.mock.method(PyMobileDevice, 'runJson', async (args) => {
        if (args[0] === 'usbmux') return [udid];
        if (args[0] === 'lockdown') return { DeviceName: 'Sched', ProductType: 'iPhone14,3', ProductVersion: '27.2' };
        if (args[0] === 'amfi') return true;
        throw new Error(`unexpected ${args.join(' ')}`);
    });
}

test('ControlCenter starts the scheduler, mirrors its status onto the descriptor and stops it before the monitor', async (t) => {
    const udid = 'iphone-sched';
    mockDeviceList(t, udid);
    const started = [];
    const status = { enabled: true, time: '03:00', hasPasscode: true, nextRunAt: 1700000000000 };
    const scheduler = fakeScheduler(started, status);
    t.mock.method(UnlockScheduler, 'getInstance', () => scheduler);
    const tracker = new IosControlCenter();
    const seen = [];
    tracker.on('device', (device) => seen.push(JSON.parse(JSON.stringify(device))));
    await tracker.init();
    await tick();
    await tick();

    assert.equal(started.length, 1, 'started once, after the monitor listeners');
    assert.equal(typeof started[0].isConnected, 'function');
    const connected = seen.at(-1);
    assert.equal(connected.state, DeviceState.CONNECTED);
    assert.deepEqual(connected.unlockSchedule, status, 'refreshDetails seeds the status');
    assert.equal(started[0].isConnected(udid), true);
    assert.equal(started[0].isConnected('iphone-absent'), false);
    assert.equal(
        seen.find((d) => d.state === 'unauthorized')?.unlockSchedule,
        undefined,
        'nothing before lockdown answered',
    );

    const update = { ...status, running: true, lastRun: { at: 1, trigger: 'manual', outcome: 'already-unlocked' } };
    const count = seen.length;
    scheduler.emit('status', { udid, status: update });
    assert.equal(seen.length, count + 1, 'a status event is one device broadcast');
    assert.deepEqual(seen.at(-1).unlockSchedule, update);
    assert.notEqual(tracker.getDescriptor(udid).unlockSchedule, update, 'the descriptor holds a copy');
    assert.equal(seen.at(-1)['last.update.timestamp'] >= connected['last.update.timestamp'], true);
    scheduler.emit('status', { udid: 'iphone-absent', status: update });
    assert.equal(seen.length, count + 1, 'an untracked device is ignored');

    // While disconnected the status is not stamped on the card; isConnected answers accordingly.
    t.mock.method(PyMobileDevice, 'runJson', async (args) => (args[0] === 'usbmux' ? [] : {}));
    await tracker.poll();
    assert.equal(started[0].isConnected(udid), false);
    scheduler.emit('status', { udid, status });
    assert.deepEqual(tracker.getDescriptor(udid).unlockSchedule, update, 'left as it was');

    const order = [];
    const monitor = DeviceStateMonitor.getInstance();
    const monitorRelease = t.mock.method(monitor, 'release', () => order.push('monitor'));
    scheduler.release = () => order.push('scheduler');
    tracker.release();
    assert.deepEqual(order, ['scheduler', 'monitor']);
    assert.equal(scheduler.listenerCount('status'), 0, 'the status listener is removed');
    monitorRelease.mock.restore();
    monitor.release();
    CoreDeviceRunner.getInstance().release();
    // A released tracker refuses the unlock commands instead of touching a stopped scheduler.
    tracker.tracked.set(udid, { descriptor: { udid, state: DeviceState.CONNECTED }, detailsAt: 0 });
    await assert.rejects(
        tracker.runCommand(unlockCommand('run_unlock_now', { udid })),
        /Scheduled unlock is not available/,
    );
});

test('a scheduler that fails to start is logged once and leaves device tracking working', async (t) => {
    const udid = 'iphone-nosched';
    mockDeviceList(t, udid);
    const started = [];
    const scheduler = fakeScheduler(started, { enabled: false, time: '03:00', hasPasscode: false });
    scheduler.start = () => {
        throw new Error('not implemented');
    };
    t.mock.method(UnlockScheduler, 'getInstance', () => scheduler);
    const errors = t.mock.method(console, 'error', () => {});
    const tracker = new IosControlCenter();
    await tracker.init();
    await tick();
    await tick();
    assert.deepEqual(
        errors.mock.calls.map((call) => call.arguments[0]),
        ['[ControlCenter] scheduled unlock unavailable: not implemented'],
    );
    const device = tracker.getDescriptor(udid);
    assert.equal(device.state, DeviceState.CONNECTED, 'tracking does not depend on the scheduler');
    assert.equal(device.unlockSchedule, undefined);
    assert.equal(scheduler.listenerCount('status'), 0);
    await assert.rejects(
        tracker.runCommand(unlockCommand('update_unlock_schedule', { udid, schedule: { enabled: true } })),
        /Scheduled unlock is not available/,
    );
    tracker.release();
    assert.deepEqual(started, [], 'a scheduler that never started is not released');
    CoreDeviceRunner.getInstance().release();
});
