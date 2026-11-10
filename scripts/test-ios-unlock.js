// Run with: node --test scripts/test-ios-unlock.js
// The scheduled unlock without an iPhone: the driver (src/server/appl-device/services/UnlockDriver.ts)
// runs the real CoreDeviceRunner against scripts/fixtures/fake-pymobiledevice3.js with FAKE_LOG as
// the oracle, like scripts/test-coredevice.js; the scheduler (UnlockScheduler.ts) runs against an
// in-memory UnlockSettingsStore, a scripted driver and a fake monitor with an injected clock, and
// once against the real IosSettingsStore. Also covers the time-zone slot arithmetic,
// DeviceStateMonitor.readScreen/waitForLock, CoreDeviceProxy.hasInputOwner and
// NotificationService.notifySystem.
process.env.IOS_UNLOCK_FAST = '1';
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const webpush = require('web-push');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

const FAKE = path.join(__dirname, 'fixtures', 'fake-pymobiledevice3.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-unlock-'));
process.env.WS_NOTIFICATION_DATA = temporary;
process.env.WS_NOTIFICATIONS_COLLECTOR = '0';
process.env.WS_PUBLIC_URL = 'https://phone.example';
const originalSend = webpush.sendNotification;
after(() => {
    webpush.sendNotification = originalSend;
    if (UnlockScheduler.hasInstance()) {
        UnlockScheduler.getInstance().release();
    }
    if (CoreDeviceRunner.hasInstance()) {
        CoreDeviceRunner.getInstance().release();
    }
    if (DeviceStateMonitor.hasInstance()) {
        DeviceStateMonitor.getInstance().release();
    }
    fs.rmSync(temporary, { recursive: true, force: true });
});

// `npm test` runs this file alongside scripts/test-coredevice.js, whose sessions also start at
// 18100. Both processes can find that port free at once; the fake that loses the race exits with
// EADDRINUSE while this process's /codec poll is answered by the other's fake. Search elsewhere.
process.env.IOS_SERVE_WEB_BASE_PORT = '18500';

const { PyMobileDevice } = require('../src/server/appl-device/services/PyMobileDevice');
const { CoreDeviceRunner } = require('../src/server/appl-device/services/CoreDeviceRunner');
const { CoreDeviceProxy } = require('../src/server/appl-device/mw/CoreDeviceProxy');
const { DeviceStateMonitor } = require('../src/server/appl-device/services/DeviceStateMonitor');
const { UnlockDriver, pause } = require('../src/server/appl-device/services/UnlockDriver');
const { UnlockScheduler } = require('../src/server/appl-device/services/UnlockScheduler');
const {
    IosSettingsStore,
    IOS_SETTINGS_FILE,
    IOS_SETTINGS_BAD_FILE,
    IOS_SETTINGS_KEY_FILE,
} = require('../src/server/appl-device/services/IosSettingsStore');
const { NotificationService } = require('../src/server/notifications/NotificationService');
const { TypedEmitter } = require('../src/common/TypedEmitter');
const {
    DEFAULT_UNLOCK_TIME,
    UNLOCK_RETRY_MS,
    UNLOCK_URGENT_INTERVAL_MS,
    isValidUnlockSchedulePatch,
    lastUnlockSlotAt,
    nextUnlockRunAt,
    unlockOutcomeText,
} = require('../src/common/IosUnlockSchedule');

const shim = path.join(temporary, 'pymobiledevice3');
fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
PyMobileDevice.useBin(shim);
process.env.IOS_PROBE_CMD = shim;
process.env.IOS_PROBE_ARGS = JSON.stringify([]);

// Digits 2, 5, 8, 0: HID usages 0x1f, 0x22, 0x25, 0x27.
const PASSCODE = '2580';
const USAGES = [31, 34, 37, 39];
const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, what, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) await sleep(25);
    assert(predicate(), what);
};
const withEnv = async (env, run) => {
    const previous = {};
    for (const [key, value] of Object.entries(env)) {
        previous[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await run();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};
// Everything the code under test writes to the console, so a test can assert what is not there.
const captureConsole = () => {
    const lines = [];
    const originals = { log: console.log, error: console.error, warn: console.warn };
    for (const name of Object.keys(originals)) {
        console[name] = (...args) => lines.push(args.map(String).join(' '));
    }
    return {
        lines,
        text: () => lines.join('\n'),
        restore: () => Object.assign(console, originals),
    };
};

const logFile = path.join(temporary, 'calls.log');
const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : []);
const indexAfter = (lines, from, predicate, what) => {
    const index = lines.findIndex((line, n) => n > from && predicate(line));
    assert(index >= 0, `${what} appears after line ${from}`);
    return index;
};
const isTouch = (line) => line.startsWith('post /touch ') && !line.includes('"frame"');
const isKey = (line) => line.startsWith('post /key ');
const button = (name, state) => `post /button {"name":"${name}","state":"${state}"}`;

/**
 * The driver's view of the monitor: scripted screen reads and lock verdicts. `before` is the
 * fresh reading taken right before the digits, `locked` the one after them, and `relocked` the
 * readings after each Lock press (the last one repeats).
 */
const scriptedMonitor = ({ screens = ['on'], before = true, locked = false, relocked = true } = {}) => {
    const relocks = Array.isArray(relocked) ? relocked : [relocked];
    const monitor = {
        reads: 0,
        waits: [],
        lockedReads: 0,
        readScreen: async () => screens[Math.min(monitor.reads++, screens.length - 1)],
        waitForLock: async (_udid, want, timeoutMs) => {
            monitor.waits.push({ want, timeoutMs });
            if (!want) return locked;
            const index = monitor.lockedReads++;
            return index === 0 ? before : relocks[Math.min(index - 1, relocks.length - 1)];
        },
        getState: () => ({ 'screen.power': 'unknown', 'device.locked': 'unknown' }),
    };
    return monitor;
};

const runDriver = async (udid, { monitor = scriptedMonitor(), hasInputOwner = () => false, read, options } = {}) => {
    fs.rmSync(logFile, { force: true });
    const output = captureConsole();
    try {
        const runner = CoreDeviceRunner.getInstance();
        const driver = new UnlockDriver({ runner, monitor, hasInputOwner });
        const result = await driver.run(udid, read || (() => PASSCODE), options);
        return { result, lines: calls(), output: output.text(), runner };
    } finally {
        output.restore();
    }
};

// ------------------------------------------------------------------ driver

test('driver: the full HID sequence in order, one serve-web, and the session stops after the grace period', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const monitor = scriptedMonitor();
        let reads = 0;
        const { result, lines, output, runner } = await runDriver('iphone-unlock', {
            monitor,
            read: () => {
                reads++;
                return PASSCODE;
            },
        });
        assert.equal(result.outcome, 'unlocked', result.message);
        assert.equal(typeof result.verifiedAt, 'number');
        assert.equal(result.message, 'Locked again');
        assert.equal(result.typed, true);
        assert.equal(result.openedSession, true, 'this run started serve-web');
        assert.equal(reads, 1, 'the passcode is read once');

        const mount = lines.findIndex((line) => line.includes('"mounter","auto-mount"'));
        assert(mount >= 0, 'the DDI is mounted first');
        const serve = indexAfter(lines, mount, (line) => line.includes('"serve-web"'), 'serve-web');
        assert(!lines.some((line) => line.startsWith('post /restart')), 'a fresh session needs no /restart');
        const homeDown = indexAfter(lines, serve, (line) => line === button('home', 'down'), 'Home down');
        const homeUp = indexAfter(lines, homeDown, (line) => line === button('home', 'up'), 'Home up');
        assert.equal(lines.filter((line) => line.startsWith('post /button')).length, 4, 'Home and Lock only');

        const touches = lines.map((line, n) => [line, n]).filter(([line]) => isTouch(line));
        assert.equal(touches.length, 13, 'twelve contacts and one release');
        assert(touches[0][1] > homeUp, 'no touch before the wake');
        const ys = touches.map(([line]) => JSON.parse(line.slice('post /touch '.length)));
        assert(ys.slice(0, 12).every((body) => body.type === 'contact' && body.x === 0x8000));
        assert.equal(ys[0].y, 0xf800);
        assert(
            ys.slice(1, 12).every((body, n) => body.y === ys[n].y - 0x0ccc),
            'the swipe moves up in even steps',
        );
        assert.equal(ys[12].type, 'release');

        const keys = lines.map((line, n) => [line, n]).filter(([line]) => isKey(line));
        assert.equal(keys.length, USAGES.length * 2);
        assert(keys[0][1] > touches[12][1], 'digits follow the swipe');
        assert.deepEqual(
            keys.map(([line]) => JSON.parse(line.slice('post /key '.length)).usages),
            USAGES.flatMap((usage) => [[usage], []]),
            'each digit is one usage down, then an empty report',
        );
        const detach = indexAfter(lines, keys.at(-1)[1], (line) => line.startsWith('post /keyboard/detach'), 'detach');
        assert.equal(lines.filter((line) => line.startsWith('post /keyboard/detach')).length, 1);
        const lockDown = indexAfter(lines, detach, (line) => line === button('lock', 'down'), 'Lock down');
        const lockUp = indexAfter(lines, lockDown, (line) => line === button('lock', 'up'), 'Lock up');
        indexAfter(lines, lockUp, (line) => line.includes('"type":"frame"'), 'the all-fingers-up frame');
        assert.deepEqual(
            monitor.waits.map((wait) => wait.want),
            [true, false, true],
            'a fresh locked reading before the digits, verify after them, confirm the lock after Lock',
        );

        assert(!lines.join('\n').includes(PASSCODE), 'the passcode never reaches the fake log');
        assert(!output.includes(PASSCODE), 'the passcode never reaches the console');
        for (const step of ['home', 'swipe', 'lock check', 'digits (4)', 'verify', 'lock']) {
            assert(output.includes(`[iphone-unlock] ${step}`), `step "${step}" is logged by name`);
        }

        assert.equal(runner.getStatus('iphone-unlock').state, 'ready', 'the hold is released; the grace timer runs');
        await waitFor(
            () => runner.getStatus('iphone-unlock').state === 'stopped',
            'the runner stops serve-web after the grace period',
            20000,
        );
        assert.equal(calls().filter((line) => line.includes('"serve-web"')).length, 1, 'no second serve-web');
    });
});

test('driver: a screen that stays dark after Home and Lock is failed-wake and gets no touch', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const monitor = scriptedMonitor({ screens: ['off', 'off'] });
        const { result, lines, runner } = await runDriver('iphone-dark', { monitor });
        assert.equal(result.outcome, 'failed-wake', result.message);
        assert.equal(monitor.reads, 2);
        const homeUp = lines.indexOf(button('home', 'up'));
        assert(homeUp >= 0);
        indexAfter(lines, homeUp, (line) => line === button('lock', 'down'), 'the Lock fallback');
        assert.equal(lines.filter((line) => line.startsWith('post /button')).length, 4);
        assert(!lines.some((line) => line.startsWith('post /touch')), 'no touch is sent to a dark screen');
        assert(!lines.some((line) => isKey(line)), 'no digits');
        assert.deepEqual(monitor.waits, [], 'nothing to verify');
        runner.stopSession('iphone-dark');
    });
});

test('driver: a dark screen that Lock wakes continues normally', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const monitor = scriptedMonitor({ screens: ['off', 'on'] });
        const { result, lines, runner } = await runDriver('iphone-dark-then-on', { monitor });
        assert.equal(result.outcome, 'unlocked', result.message);
        assert.equal(lines.filter((line) => line.startsWith('post /button')).length, 6, 'Home, Lock to wake, Lock');
        assert.equal(lines.filter(isTouch).length, 13);
        runner.stopSession('iphone-dark-then-on');
    });
});

test('driver: a screen that cannot be read gets no touch and no Lock press; one late reading on is enough', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const monitor = scriptedMonitor({ screens: ['unknown', 'unknown'] });
        const { result, lines, runner } = await runDriver('iphone-unreadable-screen', { monitor });
        assert.equal(result.outcome, 'failed-wake', result.message);
        assert.equal(result.message, 'The screen state could not be read');
        assert.equal(monitor.reads, 2, 'read once more before giving up');
        assert.deepEqual(
            lines.filter((line) => line.startsWith('post /button')),
            [button('home', 'down'), button('home', 'up')],
            'Lock could put an awake phone to sleep, so it is not pressed',
        );
        assert(!lines.some((line) => line.startsWith('post /touch')), 'no touch without a reading of on');
        assert(!lines.some((line) => isKey(line)), 'no digits');
        runner.stopSession('iphone-unreadable-screen');
    });
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const monitor = scriptedMonitor({ screens: ['unknown', 'on'] });
        const { result, lines, runner } = await runDriver('iphone-late-screen', { monitor });
        assert.equal(result.outcome, 'unlocked', result.message);
        assert.equal(lines.filter(isTouch).length, 13);
        runner.stopSession('iphone-late-screen');
    });
});

const lockPresses = (lines) => lines.filter((line) => line === button('lock', 'down')).length;

test('driver: a phone that reads unlocked after Lock gets one more Lock press and is left-unlocked if that fails too', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const { result, lines, runner } = await runDriver('iphone-stays-awake', {
            monitor: scriptedMonitor({ relocked: false }),
        });
        assert.equal(result.outcome, 'left-unlocked', result.message);
        assert.equal(result.message, 'The phone still reads unlocked after Lock');
        assert.equal(typeof result.verifiedAt, 'number');
        assert.equal(lockPresses(lines), 2, 'Lock is pressed once more, and only once');
        runner.stopSession('iphone-stays-awake');
    });
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const { result, lines, runner } = await runDriver('iphone-second-press', {
            monitor: scriptedMonitor({ relocked: [false, true] }),
        });
        assert.equal(result.outcome, 'unlocked', result.message);
        assert.equal(result.message, 'Locked again');
        assert.equal(lockPresses(lines), 2);
        runner.stopSession('iphone-second-press');
    });
    await withEnv({ FAKE_LOG: logFile }, async () => {
        // Rejected by the reading after the digits, yet unlocked after Lock: the phone is open.
        const monitor = scriptedMonitor({ locked: true, relocked: false });
        const { result, runner } = await runDriver('iphone-late-unlock', { monitor });
        assert.equal(result.outcome, 'left-unlocked', result.message);
        assert.equal(result.message, 'The phone still reads unlocked after Lock');
        runner.stopSession('iphone-late-unlock');
    });
});

test('driver: an unreadable lock state after an unlock is left-unlocked, without a second Lock press', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const { result, lines, runner } = await runDriver('iphone-relock-unknown', {
            monitor: scriptedMonitor({ relocked: 'unknown' }),
        });
        assert.equal(result.outcome, 'left-unlocked', result.message);
        assert.equal(result.message, 'Lock not confirmed');
        assert.equal(lockPresses(lines), 1, 'a second press could wake a phone that did lock');
        runner.stopSession('iphone-relock-unknown');
    });
});

test('driver: still locked after the digits is failed-rejected, and Lock is still pressed', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const monitor = scriptedMonitor({ locked: true });
        const { result, lines, runner } = await runDriver('iphone-locked', { monitor });
        assert.equal(result.outcome, 'failed-rejected', result.message);
        assert.equal(result.typed, true, 'the scheduler must know the passcode was typed');
        assert.equal(result.message, undefined, '"Locked again" is only reported after an unlock');
        assert.equal(result.verifiedAt, undefined);
        const detach = lines.findIndex((line) => line.startsWith('post /keyboard/detach'));
        assert(detach >= 0);
        const lockDown = indexAfter(lines, detach, (line) => line === button('lock', 'down'), 'Lock down');
        indexAfter(lines, lockDown, (line) => line === button('lock', 'up'), 'Lock up');
        assert.equal(lockPresses(lines), 1);
        runner.stopSession('iphone-locked');
    });
});

test('driver: an unreadable lock state after the digits is unverified, with no verifiedAt, and Lock is still pressed', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const monitor = scriptedMonitor({ locked: 'unknown', relocked: 'unknown' });
        const { result, lines, runner } = await runDriver('iphone-unverified', { monitor });
        assert.equal(result.outcome, 'unverified', result.message);
        assert.equal(result.typed, true);
        assert.equal(result.verifiedAt, undefined);
        assert.equal(result.message, 'Lock state could not be read after the passcode. Lock not confirmed');
        assert(lines.includes(button('lock', 'up')));
        runner.stopSession('iphone-unverified');
    });
});

test('driver: the lock is read again right before the digits; unlocked or unreadable types nothing', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        let reads = 0;
        const monitor = scriptedMonitor({ before: false });
        const { result, lines, runner } = await runDriver('iphone-opened-meanwhile', {
            monitor,
            read: () => {
                reads++;
                return PASSCODE;
            },
        });
        assert.equal(result.outcome, 'already-unlocked', result.message);
        assert.equal(typeof result.verifiedAt, 'number');
        assert.equal(result.typed, false);
        assert.equal(reads, 0, 'the passcode is not even read');
        assert(!lines.some(isKey), 'no digit reaches a phone someone has unlocked');
        assert.equal(lockPresses(lines), 0, 'and it is not locked under them');
        assert.deepEqual(
            monitor.waits.map((wait) => wait.want),
            [true],
        );
        runner.stopSession('iphone-opened-meanwhile');
    });
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const monitor = scriptedMonitor({ before: 'unknown' });
        const { result, lines, runner } = await runDriver('iphone-lock-unreadable', { monitor });
        assert.equal(result.outcome, 'unverified', result.message);
        assert.match(result.message, /passcode was not entered/);
        assert.equal(result.typed, false);
        assert(!lines.some(isKey), 'no digits without a reading of locked');
        assert.equal(lockPresses(lines), 0);
        runner.stopSession('iphone-lock-unreadable');
    });
});

test('driver: a step that fails after the digits still presses Lock', async () => {
    await withEnv({ FAKE_LOG: logFile, FAKE_POST_FAIL: '/keyboard/detach' }, async () => {
        const { result, lines, runner } = await runDriver('iphone-detach-fails');
        assert.equal(result.outcome, 'failed-session', result.message);
        assert.match(result.message, /^digits: \/keyboard\/detach answered 500\. Locked again$/);
        assert.equal(result.typed, true);
        const lastKey = lines.findLastIndex(isKey);
        const lockDown = indexAfter(lines, lastKey, (line) => line === button('lock', 'down'), 'Lock down');
        indexAfter(lines, lockDown, (line) => line === button('lock', 'up'), 'Lock up');
        assert.equal(runner.sessions.get('iphone-detach-fails').holders, 0, 'the hold is released');
        runner.stopSession('iphone-detach-fails');
    });
    await withEnv({ FAKE_LOG: logFile, FAKE_POST_FAIL: '/keyboard/detach' }, async () => {
        // The digits did unlock it, and it does not read locked after two presses.
        const { result, lines, runner } = await runDriver('iphone-detach-fails-open', {
            monitor: scriptedMonitor({ relocked: false }),
        });
        assert.equal(result.outcome, 'left-unlocked', result.message);
        assert.match(result.message, /^digits: .*The phone still reads unlocked after Lock$/);
        assert.equal(lockPresses(lines), 2);
        runner.stopSession('iphone-detach-fails-open');
    });
    // The last digit's post fails: it may have reached the phone and submitted the passcode, so
    // the run counts as typed and is not retried. An earlier digit's failure submits nothing.
    const lastDigit = `/key {"usages":[${USAGES.at(-1)}]}`;
    await withEnv({ FAKE_LOG: logFile, FAKE_POST_FAIL: lastDigit }, async () => {
        const { result, lines, runner } = await runDriver('iphone-last-digit-fails');
        assert.equal(result.outcome, 'failed-session', result.message);
        assert.equal(result.typed, true, 'the last digit may have been taken');
        assert.equal(lockPresses(lines), 1);
        runner.stopSession('iphone-last-digit-fails');
    });
    const firstDigit = `/key {"usages":[${USAGES[0]}]}`;
    await withEnv({ FAKE_LOG: logFile, FAKE_POST_FAIL: firstDigit }, async () => {
        const { result, lines, runner } = await runDriver('iphone-first-digit-fails');
        assert.equal(result.outcome, 'failed-session', result.message);
        assert.equal(result.typed, false, 'nothing was submitted, so the retry may type it');
        assert.equal(lines.filter(isKey).length, 1);
        assert.equal(lockPresses(lines), 1);
        runner.stopSession('iphone-first-digit-fails');
    });
});

test('driver: a Lock press that fails is repeated once; if it cannot be pressed the phone is left-unlocked', async () => {
    const lockDownBody = '"name":"lock","state":"down"';
    await withEnv({ FAKE_LOG: logFile, FAKE_POST_FAIL: lockDownBody, FAKE_POST_FAIL_COUNT: '1' }, async () => {
        const { result, lines, runner } = await runDriver('iphone-lock-fails-once');
        assert.equal(result.outcome, 'unlocked', result.message);
        assert.equal(result.message, 'Locked again');
        assert.equal(lockPresses(lines), 2, 'the failed press and its one repeat');
        assert.equal(lines.filter((line) => line === button('lock', 'up')).length, 1, 'only the repeat completed');
        runner.stopSession('iphone-lock-fails-once');
    });
    await withEnv({ FAKE_LOG: logFile, FAKE_POST_FAIL: lockDownBody }, async () => {
        const { result, lines, output, runner } = await runDriver('iphone-lock-fails', {
            monitor: scriptedMonitor({ relocked: 'unknown' }),
        });
        assert.equal(result.outcome, 'left-unlocked', result.message);
        assert.equal(result.message, 'Lock could not be pressed');
        assert.equal(lockPresses(lines), 2, 'never a third press');
        assert.match(output, /lock failed: \/button answered 500/);
        runner.stopSession('iphone-lock-fails');
    });
});

test('driver: keepUnlocked types for a viewer without waiting for their input and does not press Lock', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        let asked = 0;
        const monitor = scriptedMonitor();
        const { result, lines, runner } = await runDriver('iphone-keep', {
            monitor,
            options: { keepUnlocked: true },
            hasInputOwner: () => {
                asked++;
                return true;
            },
        });
        assert.equal(result.outcome, 'unlocked', result.message);
        assert.equal(result.message, undefined);
        assert.equal(asked, 0, 'the request comes from the viewer');
        assert.equal(lines.filter(isKey).length, USAGES.length * 2);
        assert.equal(lockPresses(lines), 0, 'the phone stays unlocked for the viewer');
        assert.deepEqual(
            monitor.waits.map((wait) => wait.want),
            [true, false],
        );
        runner.stopSession('iphone-keep');
    });
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const { result, lines, runner } = await runDriver('iphone-keep-rejected', {
            monitor: scriptedMonitor({ locked: true }),
            options: { keepUnlocked: true },
        });
        assert.equal(result.outcome, 'failed-rejected', result.message);
        assert.equal(lockPresses(lines), 0);
        runner.stopSession('iphone-keep-rejected');
    });
});

test('driver: a session that is already ready gets /restart before any input', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        await runner.acquire('iphone-viewer');
        try {
            const { result, lines } = await runDriver('iphone-viewer');
            assert.equal(result.outcome, 'unlocked', result.message);
            assert.equal(result.openedSession, false, 'a shared session is not a new one');
            const restart = lines.findIndex((line) => line.startsWith('post /restart'));
            assert(restart >= 0, '/restart is sent');
            indexAfter(lines, restart, (line) => line === button('home', 'down'), 'Home after /restart');
            assert(!lines.some((line) => line.includes('"serve-web"')), 'the viewer session is shared, not restarted');
            assert.equal(runner.getStatus('iphone-viewer').state, 'ready', 'the viewer keeps its session');
        } finally {
            runner.release('iphone-viewer');
            runner.stopSession('iphone-viewer');
        }
    });
});

test('driver: a session that fails to start is failed-session with the CLI reason, and no input is sent', async () => {
    await withEnv({ FAKE_LOG: logFile, FAKE_MOUNT_FAIL: 'other' }, async () => {
        const { result, lines } = await runDriver('iphone-nomount');
        assert.equal(result.outcome, 'failed-session', result.message);
        assert.match(result.message, /Developer Disk Image/);
        assert(!lines.some((line) => line.startsWith('post ')), 'nothing is posted');
    });
    await withEnv({ FAKE_LOG: logFile, FAKE_SERVE_EXIT: '3' }, async () => {
        const { result, runner } = await runDriver('iphone-noserve');
        assert.equal(result.outcome, 'failed-session', result.message);
        assert.match(result.message, /displayservice unavailable/);
        assert.equal(runner.getStatus('iphone-noserve').state, 'error');
    });
});

test('driver: a viewer still holding the input surface after three waits skips the run without a session', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        let asked = 0;
        const { result, lines } = await runDriver('iphone-busy', {
            hasInputOwner: () => {
                asked++;
                return true;
            },
        });
        assert.equal(asked, 4, 'three waits, then one last look');
        assert.equal(result.outcome, 'skipped-viewer', result.message);
        assert.equal(result.openedSession, false);
        assert.deepEqual(lines, [], 'no serve-web, no Home, no digits');
    });
    await withEnv({ FAKE_LOG: logFile }, async () => {
        let asked = 0;
        const { result, runner } = await runDriver('iphone-busy-then-free', { hasInputOwner: () => ++asked < 3 });
        assert.equal(result.outcome, 'unlocked', 'a viewer who stops in time only delays the run');
        runner.stopSession('iphone-busy-then-free');
    });
});

test('driver: a passcode that cannot be read types nothing, puts the phone back to sleep and names no digits', async () => {
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const { result, lines, output, runner } = await runDriver('iphone-noread', {
            read: () => {
                throw new Error('Stored passcode unreadable: key file missing');
            },
        });
        assert.equal(result.outcome, 'failed-still-locked', result.message);
        assert.match(result.message, /^Passcode not entered: Stored passcode unreadable/);
        assert(!lines.some(isKey), 'no key report');
        assert(!lines.some((line) => line.startsWith('post /keyboard/detach')), 'no keyboard was attached');
        assert(lines.includes(button('lock', 'up')), 'the phone is put back to sleep');
        assert(!output.includes('digits ('));
        runner.stopSession('iphone-noread');
    });
});

test('driver: the phone dropping the HID channel mid-swipe is failed-session naming the step, and the hold is released', async () => {
    await withEnv({ FAKE_LOG: logFile, FAKE_TOUCH_DROP_AFTER: '3' }, async () => {
        const { result, lines, runner } = await runDriver('iphone-drop');
        assert.equal(result.outcome, 'failed-session', result.message);
        assert.match(result.message, /^swipe: /);
        assert(!lines.some(isKey), 'the digits are never typed');
        assert.equal(result.typed, false);
        assert.equal(lockPresses(lines), 0, 'nothing was typed, so nothing needs locking');
        assert(
            lines.some((line) => line.includes('"type":"frame"')),
            'the all-fingers-up frame is still attempted',
        );
        const session = runner.sessions.get('iphone-drop');
        assert.equal(session.holders, 0, 'the driver released its hold');
        runner.stopSession('iphone-drop');
    });
});

test('pause: IOS_UNLOCK_FAST shortens every pause; without it the default applies', async () => {
    let started = Date.now();
    await pause('test', 500);
    assert(Date.now() - started < 200, 'fast mode');
    await withEnv({ IOS_UNLOCK_FAST: undefined }, async () => {
        started = Date.now();
        await pause('test', 60);
        assert(Date.now() - started >= 55, 'default pause');
    });
});

// ------------------------------------------------------------------ monitor helpers

test('monitor: readScreen reads the backlight once without touching the cached state', async () => {
    fs.rmSync(logFile, { force: true });
    const monitor = new DeviceStateMonitor();
    try {
        await withEnv({ FAKE_LOG: logFile, FAKE_SCREEN: 'off' }, async () => {
            assert.equal(await monitor.readScreen('iphone-read'), 'off');
        });
        await withEnv({ FAKE_LOG: logFile, FAKE_SCREEN: 'on' }, async () => {
            assert.equal(await monitor.readScreen('iphone-read'), 'on');
        });
        assert.equal(calls().filter((line) => line.includes('"diagnostics","ioregistry"')).length, 2);
        assert.equal(monitor.getState('iphone-read')['screen.power'], 'unknown', 'not watched, nothing cached');
        assert(!monitor.isWatching('iphone-read'));
    } finally {
        monitor.release();
    }
});

test('monitor: waitForLock resolves on a matching reading, at timeout otherwise, and unknown when it cannot read', async () => {
    fs.rmSync(logFile, { force: true });
    const monitor = new DeviceStateMonitor();
    const udid = 'iphone-wait';
    try {
        assert.equal(await monitor.waitForLock(udid, false, 1000), 'unknown', 'not watched');
        await withEnv(
            { FAKE_LOG: logFile, FAKE_SCREEN: 'on', FAKE_NOTIFICATION_STATE: '1', IOS_STATE_NOTIFICATIONS: '0' },
            async () => {
                monitor.watch(udid, { version: '27.2', language: 'en-US' });
                await waitFor(
                    () => monitor.getState(udid)['device.locked'] === true,
                    'the first read sees a locked phone',
                );

                await withEnv({ FAKE_NOTIFICATION_STATE: '0' }, async () => {
                    const started = Date.now();
                    assert.equal(await monitor.waitForLock(udid, false, 5000), false, 'a changed reading');
                    assert(Date.now() - started < 4000, 'resolved by the reading, not the timeout');
                    const again = Date.now();
                    assert.equal(await monitor.waitForLock(udid, false, 5000), false, 'an unchanged reading');
                    assert(Date.now() - again < 4000, 'a confirming read resolves without a state event');
                });
                await withEnv({ FAKE_NOTIFICATION_STATE: '1' }, async () => {
                    const started = Date.now();
                    assert.equal(await monitor.waitForLock(udid, false, 700), true, 'the latest value at timeout');
                    assert(Date.now() - started >= 650, 'waited for the timeout');
                    // A state event during the wait resolves it early.
                    const pending = monitor.waitForLock(udid, false, 5000);
                    await sleep(150);
                    monitor.emit('state', { udid, 'screen.power': 'on', 'device.locked': false });
                    const before = Date.now();
                    assert.equal(await pending, false);
                    assert(Date.now() - before < 500);
                });
                await withEnv({ FAKE_NOTIFICATION_FAIL: 'notification service unavailable' }, async () => {
                    const started = Date.now();
                    assert.equal(await monitor.waitForLock(udid, true, 5000), 'unknown', 'a failed read');
                    assert(Date.now() - started < 4000);
                });
                await withEnv({ IOS_LOCK_PROBE: '0' }, async () => {
                    const reads = calls().filter((line) => line.includes('"get-state"')).length;
                    assert.equal(await monitor.waitForLock(udid, true, 1000), 'unknown', 'lock probe off');
                    await sleep(100);
                    assert.equal(calls().filter((line) => line.includes('"get-state"')).length, reads, 'no read');
                });
            },
        );
    } finally {
        monitor.release();
    }
});

test('proxy: hasInputOwner reflects the touch and keyboard owner maps', () => {
    assert.equal(CoreDeviceProxy.hasInputOwner('iphone-owner'), false);
    CoreDeviceProxy.touchOwners.set('iphone-owner', {});
    assert.equal(CoreDeviceProxy.hasInputOwner('iphone-owner'), true);
    CoreDeviceProxy.touchOwners.delete('iphone-owner');
    assert.equal(CoreDeviceProxy.hasInputOwner('iphone-owner'), false);
    CoreDeviceProxy.keyboardOwners.set('iphone-owner', {});
    assert.equal(CoreDeviceProxy.hasInputOwner('iphone-owner'), true);
    CoreDeviceProxy.keyboardOwners.delete('iphone-owner');
    assert.equal(CoreDeviceProxy.hasInputOwner('iphone-owner'), false);
    assert.equal(CoreDeviceProxy.hasInputOwner('iphone-other'), false);
});

// ------------------------------------------------------------------ push

test('push: notifySystem queues one job per subscription, preparePush honours system: keys, nothing enters history', async () => {
    const service = new NotificationService();
    const app = express();
    service.mount(app, '/');
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/notifications`;
    const api = (url, body) =>
        fetch(base + url, {
            method: body ? 'POST' : 'GET',
            headers: { 'content-type': 'application/json' },
            body: body && JSON.stringify(body),
        });
    const subscription = (endpoint) => ({
        endpoint,
        keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') },
    });
    const endpoints = ['https://web.push.apple.com/one', 'https://web.push.apple.com/two'];
    const delivered = [];
    webpush.sendNotification = async (sub, payload) => {
        delivered.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    };
    try {
        for (const endpoint of endpoints) {
            assert.equal(
                (await api('/subscriptions', { subscription: subscription(endpoint), sources: [], receiverSource: '' }))
                    .status,
                200,
            );
        }
        const payload = { title: 'iPhone unlock', body: 'Phone not reachable', tag: 'ios-unlock-x', url: '#!action=' };
        service.notifySystem({ ...payload, extra: 'dropped' });
        assert.equal(service.push.pending, 2, 'one queue per subscription');
        await waitFor(() => delivered.length === 2, 'both subscriptions receive the push');
        assert.deepEqual(delivered.map((item) => item.endpoint).sort(), endpoints);
        assert.deepEqual(delivered[0].payload, payload, 'the payload is sent as given, nothing else');
        assert.equal(service.feed.size, 0, 'not stored in history');
        const status = await (await api('/status')).json();
        assert.deepEqual(status.notifications, []);

        const id = crypto.createHash('sha256').update(endpoints[0]).digest('hex');
        assert.deepEqual(service.preparePush(id, 'system:abc', '{"x":1}').payload, '{"x":1}');
        assert.equal(service.preparePush(id, 'system:abc'), undefined, 'a system job without a payload sends nothing');
        assert.equal(
            service.preparePush(id, 'systemless', '{"x":1}'),
            undefined,
            'other keys still go through the feed',
        );

        service.release();
        service.notifySystem(payload);
        await tick();
        assert.equal(delivered.length, 2, 'a released service sends nothing');
    } finally {
        service.release();
        server.close();
    }
});

// ------------------------------------------------------------------ scheduler

/** `UnlockSettingsStore` in memory. Keeps the passcode base64-encoded so a leak of the object is visible as such. */
class MemoryStore {
    constructor(now) {
        this.now = now;
        this.devices = new Map();
        this.problems = [];
        this.reads = 0;
        this.loads = 0;
        this.releases = 0;
    }
    record(udid) {
        let record = this.devices.get(udid);
        if (!record) {
            record = { enabled: false, time: DEFAULT_UNLOCK_TIME };
            this.devices.set(udid, record);
        }
        return record;
    }
    load() {
        this.loads++;
    }
    getProblems() {
        return this.problems;
    }
    listUdids() {
        return [...this.devices.keys()];
    }
    getSchedule(udid) {
        const record = this.devices.get(udid) || { enabled: false, time: DEFAULT_UNLOCK_TIME };
        const status = { enabled: record.enabled, time: record.time, hasPasscode: !!record.passcode };
        if (record.timeZone) status.timeZone = record.timeZone;
        if (status.hasPasscode && record.passcodeRejectedAt !== undefined) status.passcodeRejected = true;
        if (record.lastUnlockedAt !== undefined) status.lastUnlockedAt = record.lastUnlockedAt;
        if (record.lastRun) status.lastRun = { ...record.lastRun };
        if (status.enabled && status.hasPasscode && !status.passcodeRejected) {
            status.nextRunAt = nextUnlockRunAt(record.time, this.now(), record.timeZone);
        }
        return status;
    }
    getRunState(udid) {
        const record = this.devices.get(udid) || {};
        return {
            lastUnlockedAt: record.lastUnlockedAt,
            retryAt: record.retryAt,
            lastSlotAt: record.lastSlotAt,
            passcodeRejectedAt: record.passcodeRejectedAt,
            unconfirmedAttempts: record.unconfirmedAttempts,
            deadlineWarnedFor: record.deadlineWarnedFor,
        };
    }
    updateSchedule(udid, patch) {
        Object.assign(this.record(udid), patch);
        return this.getSchedule(udid);
    }
    setPasscode(udid, passcode) {
        const record = this.record(udid);
        record.passcode = Buffer.from(passcode).toString('base64');
        delete record.passcodeRejectedAt;
        delete record.unconfirmedAttempts;
        return this.getSchedule(udid);
    }
    clearPasscode(udid) {
        const record = this.record(udid);
        delete record.passcode;
        delete record.passcodeRejectedAt;
        delete record.unconfirmedAttempts;
        return this.getSchedule(udid);
    }
    readPasscode(udid) {
        this.reads++;
        const record = this.devices.get(udid);
        if (!record || !record.passcode) throw new Error('No passcode stored');
        return Buffer.from(record.passcode, 'base64').toString();
    }
    recordUnlockedAt(udid, at) {
        this.record(udid).lastUnlockedAt = at;
    }
    recordRun(udid, result) {
        this.record(udid).lastRun = { ...result };
    }
    setRetryAt(udid, at) {
        if (at === undefined) delete this.record(udid).retryAt;
        else this.record(udid).retryAt = at;
    }
    setLastSlotAt(udid, at) {
        this.record(udid).lastSlotAt = at;
    }
    setRunState(udid, patch) {
        const record = this.record(udid);
        for (const [field, value] of Object.entries(patch)) {
            if (value === undefined) delete record[field];
            else record[field] = value;
        }
    }
    release() {
        this.releases++;
    }
}

class FakeMonitor extends TypedEmitter {
    constructor() {
        super();
        this.states = new Map();
    }
    getState(udid) {
        return this.states.get(udid) || { 'screen.power': 'unknown', 'device.locked': 'unknown' };
    }
    set(udid, locked) {
        const state = { 'screen.power': 'on', 'device.locked': locked };
        this.states.set(udid, state);
        this.emit('state', { udid, ...state });
    }
}

/** Scripted results, one per run; `unlocked` by default. Asserts that runs never overlap. */
class FakeDriver {
    constructor(store, now) {
        this.store = store;
        this.now = now;
        this.results = [];
        this.calls = [];
        this.options = [];
        this.active = 0;
        this.overlapped = false;
    }
    async run(udid, readPasscode, options) {
        this.active++;
        if (this.active > 1) this.overlapped = true;
        this.calls.push(udid);
        this.options.push(options);
        const before = this.store.reads;
        const passcode = readPasscode();
        assert.equal(this.store.reads, before + 1, 'the thunk reads the store');
        assert.equal(passcode, PASSCODE);
        await sleep(10);
        this.active--;
        const next = this.results.shift();
        if (next instanceof Error) throw next;
        return next || { outcome: 'unlocked', verifiedAt: this.now() };
    }
}

const makeScheduler = ({ time = Date.now(), connected = () => true } = {}) => {
    let clock = time;
    const now = () => clock;
    const store = new MemoryStore(now);
    const driver = new FakeDriver(store, now);
    const monitor = new FakeMonitor();
    const pushes = [];
    const statuses = [];
    const scheduler = new UnlockScheduler({ store, driver, monitor, notify: (payload) => pushes.push(payload), now });
    scheduler.on('status', (event) => statuses.push(event));
    scheduler.start({ isConnected: connected });
    return {
        scheduler,
        store,
        driver,
        monitor,
        pushes,
        statuses,
        now,
        setClock: (value) => (clock = value),
        tick: () => scheduler.tick(),
        // Resolves once every queued run has ended.
        settle: async () => {
            await scheduler.chain;
            await tick();
        },
    };
};

const armed = (ctx, udid, time = '03:00') => {
    ctx.store.updateSchedule(udid, { enabled: true, time });
    ctx.store.setPasscode(udid, PASSCODE);
    ctx.monitor.set(udid, true);
};

test('scheduler: a due slot runs once, the same slot never twice, a slot older than two hours not at all', async () => {
    const slot = lastUnlockSlotAt('03:00', Date.now());
    const ctx = makeScheduler({ time: slot + 10 * MINUTE });
    const udid = 'iphone-slot';
    try {
        armed(ctx, udid);
        assert.equal(ctx.store.loads, 1, 'start loads the store');
        ctx.tick();
        await ctx.settle();
        assert.deepEqual(ctx.driver.calls, [udid]);
        const record = ctx.store.devices.get(udid);
        assert.equal(record.lastSlotAt, slot, 'the slot is marked used');
        assert.equal(record.lastRun.outcome, 'unlocked');
        assert.equal(record.lastRun.trigger, 'schedule');
        assert.equal(record.lastUnlockedAt, slot + 10 * MINUTE, 'lastUnlockedAt comes from verifiedAt');
        assert.equal(record.retryAt, undefined);

        ctx.setClock(slot + 11 * MINUTE);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 1, 'the same slot does not run twice');

        // The next day, three hours late: the slot is skipped, not run at 06:00.
        ctx.setClock(slot + 24 * HOUR + 3 * HOUR);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 1);
        assert.equal(ctx.store.devices.get(udid).lastSlotAt, slot, 'a missed slot is not marked');

        // The day after, on time: yesterday's own unlock does not count as recent.
        ctx.setClock(slot + 48 * HOUR + 30 * 1000);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 2);

        // The following night the previous unlock was 23 h 59 m ago: still a run, not skipped-recent.
        ctx.setClock(slot + 72 * HOUR + 5 * 1000);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 3, 'a daily schedule runs every night');
        assert.equal(ctx.pushes.length, 0, 'nothing to report');
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: a scheduled run is skipped for disabled, no passcode, disconnected and recent; manual runs ignore the first and last', async () => {
    const udid = 'iphone-skips';
    let connected = true;
    const ctx2 = makeScheduler({ connected: () => connected });
    try {
        const { scheduler, store, driver, monitor, pushes } = ctx2;
        monitor.set(udid, true);
        assert.equal((await scheduler.runNow(udid, 'schedule')).outcome, 'skipped-disabled');
        assert.equal(
            (await scheduler.runNow(udid, 'manual')).outcome,
            'skipped-no-passcode',
            'manual ignores disabled',
        );
        store.setPasscode(udid, PASSCODE);
        assert.equal((await scheduler.runNow(udid, 'schedule')).outcome, 'skipped-disabled');
        store.updateSchedule(udid, { enabled: true });

        connected = false;
        const disconnected = await scheduler.runNow(udid, 'schedule');
        assert.equal(disconnected.outcome, 'skipped-disconnected');
        assert.match(disconnected.message, /unlock it once on the phone/);
        assert.equal(pushes.length, 1, 'a scheduled run on an unreachable phone is pushed');
        assert.equal(store.devices.get(udid).retryAt, ctx2.now() + UNLOCK_RETRY_MS, 'and retried once');
        store.setRetryAt(udid, undefined);
        assert.equal((await scheduler.runNow(udid, 'manual')).outcome, 'skipped-disconnected');
        assert.equal(pushes.length, 1, 'a manual run is not pushed');
        assert.equal(store.devices.get(udid).retryAt, undefined, 'or retried');
        connected = true;

        store.recordUnlockedAt(udid, ctx2.now() - HOUR);
        assert.equal((await scheduler.runNow(udid, 'schedule')).outcome, 'skipped-recent');
        assert.equal(driver.calls.length, 0, 'no session so far');
        assert.equal(pushes.length, 1, 'skipped-recent is not pushed');
        assert.equal((await scheduler.runNow(udid, 'manual')).outcome, 'unlocked', 'manual ignores recent');
        assert.deepEqual(driver.calls, [udid]);
        assert.equal(store.devices.get(udid).retryAt, undefined);
    } finally {
        ctx2.scheduler.release();
    }
});

test('scheduler: an unlocked phone is already-unlocked without a session and records lastUnlockedAt', async () => {
    const ctx = makeScheduler();
    const udid = 'iphone-open';
    try {
        armed(ctx, udid);
        ctx.monitor.set(udid, false);
        delete ctx.store.devices.get(udid).lastUnlockedAt;
        const result = await ctx.scheduler.runNow(udid, 'schedule');
        assert.equal(result.outcome, 'already-unlocked', result.message);
        assert.equal(ctx.driver.calls.length, 0);
        assert.equal(ctx.store.devices.get(udid).lastUnlockedAt, ctx.now());
        assert.equal(ctx.pushes.length, 0);
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: a failed scheduled run is pushed and retried once ten minutes later, never a third time', async () => {
    const slot = lastUnlockSlotAt('03:00', Date.now());
    const start = slot + 2 * MINUTE;
    const ctx = makeScheduler({ time: start });
    const udid = 'iphone-retry';
    try {
        armed(ctx, udid);
        ctx.driver.results.push({ outcome: 'failed-session', message: 'home: timed out' }, { outcome: 'failed-wake' });
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 1);
        const record = ctx.store.devices.get(udid);
        assert.equal(record.lastRun.outcome, 'failed-session');
        assert.equal(record.retryAt, start + UNLOCK_RETRY_MS, 'one retry, ten minutes later');
        assert.equal(record.lastUnlockedAt, undefined);
        const status = ctx.scheduler.getStatus(udid);
        assert.equal(status.nextRunAt, start + UNLOCK_RETRY_MS, 'the retry shows as the next run');
        assert.equal(ctx.pushes.length, 1);
        assert.deepEqual(ctx.pushes[0], {
            title: 'iPhone unlock',
            body: `${unlockOutcomeText('failed-session')}. home: timed out`,
            tag: `ios-unlock-${udid}`,
            url: '#!action=',
        });

        ctx.setClock(start + 5 * MINUTE);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 1, 'not before the retry is due');

        ctx.setClock(start + UNLOCK_RETRY_MS);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 2, 'the retry runs');
        assert.equal(record.retryAt, undefined, 'a failed retry is not retried again');
        assert.equal(record.lastRun.outcome, 'failed-wake');
        assert.equal(ctx.pushes.length, 2);
        assert.equal(ctx.pushes[1].body, unlockOutcomeText('failed-wake'));
        assert.equal(ctx.scheduler.getStatus(udid).nextRunAt, nextUnlockRunAt('03:00', ctx.now()), 'next: tomorrow');

        for (const offset of [UNLOCK_RETRY_MS * 2, UNLOCK_RETRY_MS * 3, HOUR]) {
            ctx.setClock(start + offset);
            ctx.tick();
            await ctx.settle();
        }
        assert.equal(ctx.driver.calls.length, 2, 'no third attempt that night');

        // A retry left over from before a long outage is dropped, like a missed slot.
        ctx.store.setRetryAt(udid, start - 3 * HOUR);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 2);
        assert.equal(record.retryAt, undefined, 'the stale retry is cleared');
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: a failed manual run is neither pushed nor retried; unverified and failed-session scheduled runs are', async () => {
    const ctx = makeScheduler();
    const udid = 'iphone-manual';
    try {
        armed(ctx, udid);
        ctx.driver.results.push({ outcome: 'failed-session', message: 'mount: nope' });
        const manual = await ctx.scheduler.runNow(udid, 'manual');
        assert.equal(manual.outcome, 'failed-session');
        assert.equal(manual.message, 'mount: nope');
        assert.equal(ctx.pushes.length, 0);
        assert.equal(ctx.store.devices.get(udid).retryAt, undefined);

        ctx.driver.results.push({ outcome: 'unverified', message: 'Lock state could not be read' });
        assert.equal((await ctx.scheduler.runNow(udid, 'schedule')).outcome, 'unverified');
        assert.equal(ctx.pushes.length, 1);
        assert.equal(ctx.store.devices.get(udid).retryAt, ctx.now() + UNLOCK_RETRY_MS);
        assert.equal(ctx.store.devices.get(udid).lastUnlockedAt, undefined, 'unverified does not count as an unlock');
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: a locked -> unlocked transition persists lastUnlockedAt; unknown -> unlocked does not', async () => {
    const ctx = makeScheduler();
    const udid = 'iphone-faceid';
    try {
        ctx.monitor.set(udid, 'unknown');
        ctx.monitor.set(udid, false);
        assert.equal(ctx.store.devices.get(udid), undefined, 'unknown -> false records nothing');
        ctx.monitor.set(udid, true);
        ctx.monitor.set(udid, false);
        assert.equal(ctx.store.devices.get(udid).lastUnlockedAt, ctx.now());
        assert.equal(ctx.statuses.at(-1).udid, udid, 'the transition is broadcast');
        assert.equal(ctx.statuses.at(-1).status.lastUnlockedAt, ctx.now());

        ctx.setClock(ctx.now() + HOUR);
        ctx.monitor.set(udid, true);
        ctx.scheduler.release();
        ctx.monitor.set(udid, false);
        assert.notEqual(ctx.store.devices.get(udid).lastUnlockedAt, ctx.now(), 'release unsubscribes');
        assert.equal(ctx.store.releases, 1, 'release releases the store');
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: runs are serialised across devices, status is broadcast at start and end, and the passcode stays out of it', async () => {
    const ctx = makeScheduler();
    const output = captureConsole();
    try {
        armed(ctx, 'iphone-one');
        armed(ctx, 'iphone-two');
        ctx.statuses.length = 0;
        const [one, two] = await Promise.all([
            ctx.scheduler.runNow('iphone-one', 'manual'),
            ctx.scheduler.runNow('iphone-two', 'manual'),
        ]);
        assert.equal(ctx.driver.overlapped, false, 'one run at a time');
        assert.deepEqual(ctx.driver.calls, ['iphone-one', 'iphone-two']);
        assert.equal(one.outcome, 'unlocked');
        assert.equal(two.outcome, 'unlocked');
        assert.deepEqual(ctx.store.devices.get('iphone-one').lastRun, one, 'the reply is what was recorded');
        assert.deepEqual(ctx.scheduler.getStatus('iphone-two').lastRun, two);

        const forOne = ctx.statuses.filter((event) => event.udid === 'iphone-one').map((event) => event.status);
        assert.equal(forOne[0].running, true, 'running from the moment the run is queued');
        assert.equal(forOne.at(-1).running, undefined, 'not running once it ended');
        assert.deepEqual(forOne.at(-1).lastRun, one);
        const forTwo = ctx.statuses.filter((event) => event.udid === 'iphone-two').map((event) => event.status);
        assert.equal(forTwo[0].running, true, 'a queued run also shows as running');
        assert.equal(forTwo.at(-1).running, undefined);

        assert.equal(ctx.scheduler.getStatus('iphone-one').running, undefined);
        assert.equal(ctx.store.reads, 2, 'the passcode is read once per run');
        const everything = JSON.stringify(ctx.statuses) + JSON.stringify([one, two]) + output.text();
        assert(!everything.includes(PASSCODE), 'the passcode is in no status, result or log line');
        assert(!everything.includes(Buffer.from(PASSCODE).toString('base64')));
        assert.match(output.text(), /\[UnlockScheduler\] \[iphone-one\] manual unlocked in \d+ ms/);
    } finally {
        output.restore();
        ctx.scheduler.release();
    }
});

test('scheduler: getStatus has defaults for an unknown device, the mutating methods broadcast what they return', async () => {
    const ctx = makeScheduler();
    const udid = 'iphone-status';
    try {
        assert.deepEqual(ctx.scheduler.getStatus(udid), {
            enabled: false,
            time: DEFAULT_UNLOCK_TIME,
            hasPasscode: false,
        });
        const updated = ctx.scheduler.updateSchedule(udid, { enabled: true, time: '04:30' });
        assert.deepEqual(updated, { enabled: true, time: '04:30', hasPasscode: false });
        assert.deepEqual(ctx.statuses.at(-1), { udid, status: updated });
        const stored = ctx.scheduler.setPasscode(udid, PASSCODE);
        assert.equal(stored.hasPasscode, true);
        assert.equal(stored.nextRunAt, nextUnlockRunAt('04:30', ctx.now()));
        assert.deepEqual(ctx.statuses.at(-1), { udid, status: stored });
        assert(!JSON.stringify(stored).includes(PASSCODE));
        const cleared = ctx.scheduler.clearPasscode(udid);
        assert.deepEqual(cleared, { enabled: true, time: '04:30', hasPasscode: false });
        assert.deepEqual(ctx.statuses.at(-1), { udid, status: cleared });
        assert.equal(ctx.store.devices.get(udid).passcode, undefined);
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: a driver that throws still ends the run with a recorded result', async () => {
    const ctx = makeScheduler();
    const output = captureConsole();
    const udid = 'iphone-throws';
    try {
        armed(ctx, udid);
        ctx.driver.results.push(new Error('programming error'));
        const result = await ctx.scheduler.runNow(udid, 'manual');
        assert.equal(result.outcome, 'failed-session', result.message);
        assert.equal(result.message, 'programming error');
        assert.deepEqual(ctx.store.devices.get(udid).lastRun, result);
        assert.equal(ctx.scheduler.getStatus(udid).running, undefined);
        ctx.setClock(ctx.now() + 3 * MINUTE);
        assert.equal((await ctx.scheduler.runNow(udid, 'manual')).outcome, 'unlocked', 'the queue is not stuck');
    } finally {
        output.restore();
        ctx.scheduler.release();
    }
});

test('scheduler: start throws when the store cannot load, and the singleton drops on release', () => {
    const scheduler = new UnlockScheduler({
        store: {
            load() {
                throw new Error('not implemented');
            },
        },
        monitor: new FakeMonitor(),
    });
    assert.throws(() => scheduler.start({ isConnected: () => true }), /not implemented/);
    assert.equal(UnlockScheduler.hasInstance(), false);
    const singleton = UnlockScheduler.getInstance();
    assert.equal(UnlockScheduler.hasInstance(), true);
    singleton.release();
    assert.equal(UnlockScheduler.hasInstance(), false);
});

test('scheduler: a failed start leaves no listener behind, and a store that cannot write never sticks or throws', async () => {
    const monitor = new FakeMonitor();
    const broken = new UnlockScheduler({ store: { load() {} }, monitor });
    // The interval is created after the state listener; a timer without `unref` fails the start there.
    const realSetInterval = global.setInterval;
    global.setInterval = () => 1;
    try {
        assert.throws(() => broken.start({ isConnected: () => true }), /unref/);
    } finally {
        global.setInterval = realSetInterval;
    }
    assert.equal(monitor.emitter.listenerCount('state'), 0, 'the state listener is removed again');

    const ctx = makeScheduler();
    const udid = 'iphone-readonly';
    const output = captureConsole();
    try {
        armed(ctx, udid);
        const fail = () => {
            throw new Error('EROFS: read-only file system');
        };
        ctx.store.recordRun = fail;
        ctx.store.recordUnlockedAt = fail;
        ctx.store.setLastSlotAt = fail;
        const result = await ctx.scheduler.runNow(udid, 'manual');
        assert.equal(result.outcome, 'unlocked', 'the run result is still returned');
        assert.equal(ctx.scheduler.getStatus(udid).running, undefined, 'the panel does not stay on running');
        assert.doesNotThrow(() => ctx.monitor.set(udid, false), 'a lock transition does not throw into the monitor');
        ctx.setClock(lastUnlockSlotAt('03:00', Date.now()) + MINUTE);
        assert.doesNotThrow(() => ctx.tick(), 'the timer callback does not throw');
        assert.match(output.text(), /could not record the run: EROFS/);
        assert.match(output.text(), /could not record the unlock: EROFS/);
        assert.match(output.text(), /schedule check failed: EROFS/);
    } finally {
        output.restore();
        ctx.scheduler.release();
    }
});

test('scheduler: a rejected passcode is typed once, never retried, and every later run is skipped until it is saved again', async () => {
    const slot = lastUnlockSlotAt('03:00', Date.now());
    const ctx = makeScheduler({ time: slot + 2 * MINUTE });
    const udid = 'iphone-rejected';
    try {
        armed(ctx, udid);
        ctx.driver.results.push({ outcome: 'failed-rejected', typed: true });
        ctx.tick();
        await ctx.settle();
        const record = ctx.store.devices.get(udid);
        assert.equal(ctx.driver.calls.length, 1);
        assert.equal(record.lastRun.outcome, 'failed-rejected');
        assert.equal(record.retryAt, undefined, 'a run that typed the passcode is not retried');
        assert.equal(record.passcodeRejectedAt, ctx.now());
        assert.equal(ctx.pushes.length, 1);
        assert.equal(
            ctx.pushes[0].body,
            'Failed: the stored passcode was rejected. Scheduled unlock is paused until the passcode is saved again',
        );
        let status = ctx.scheduler.getStatus(udid);
        assert.equal(status.passcodeRejected, true, 'the panel is told');
        assert.equal(status.nextRunAt, undefined, 'no next run while paused');

        // Five more nights, with the ten-minute mark in between: the passcode is never typed again.
        for (let night = 1; night <= 5; night++) {
            for (const offset of [MINUTE, MINUTE + UNLOCK_RETRY_MS]) {
                ctx.setClock(slot + night * 24 * HOUR + offset);
                ctx.tick();
                await ctx.settle();
            }
            assert.equal(record.lastRun.outcome, 'skipped-rejected');
            assert.equal(ctx.pushes.length, 1 + night, 'one reminder a night');
        }
        assert.equal(ctx.driver.calls.length, 1, 'one attempt per stored passcode');
        assert.equal(ctx.store.reads, 1);
        assert.equal((await ctx.scheduler.runNow(udid, 'manual')).outcome, 'skipped-rejected', 'Run now is held too');
        assert.equal(ctx.driver.calls.length, 1);

        // Saving the passcode again lifts it; the slot that already passed is not run.
        status = ctx.scheduler.setPasscode(udid, PASSCODE);
        assert.equal(status.passcodeRejected, undefined);
        assert.equal(status.nextRunAt, nextUnlockRunAt('03:00', ctx.now()));
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 1);
        ctx.setClock(slot + 6 * 24 * HOUR + MINUTE);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 2, 'the next night runs with the new passcode');
        assert.equal(record.lastRun.outcome, 'unlocked');
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: a typed run that cannot confirm the unlock is not retried, and the second in a row pauses the schedule', async () => {
    const slot = lastUnlockSlotAt('03:00', Date.now());
    const ctx = makeScheduler({ time: slot + MINUTE });
    const udid = 'iphone-unconfirmed';
    try {
        armed(ctx, udid);
        const unverified = {
            outcome: 'unverified',
            message: 'Lock state could not be read after the passcode',
            typed: true,
        };
        const record = ctx.store.devices.get(udid);
        const night = async (n, result) => {
            if (result) ctx.driver.results.push(result);
            for (const offset of [MINUTE, MINUTE + UNLOCK_RETRY_MS]) {
                ctx.setClock(slot + n * 24 * HOUR + offset);
                ctx.tick();
                await ctx.settle();
            }
        };
        await night(0, unverified);
        assert.equal(ctx.driver.calls.length, 1, 'no retry after the digits were typed');
        assert.equal(record.unconfirmedAttempts, 1);
        assert.equal(record.passcodeRejectedAt, undefined, 'one unconfirmed run does not pause anything');

        await night(1);
        assert.equal(ctx.driver.calls.length, 2);
        assert.equal(record.unconfirmedAttempts, undefined, 'a confirmed unlock clears the count');

        await night(2, { outcome: 'failed-session', message: 'digits: /keyboard/detach answered 500', typed: true });
        await night(3, unverified);
        assert.equal(ctx.driver.calls.length, 4);
        assert.equal(typeof record.passcodeRejectedAt, 'number', 'two in a row are treated as a rejected passcode');
        const runPushes = ctx.pushes.filter((push) => push.tag === `ios-unlock-${udid}`);
        assert.equal(
            runPushes.at(-1).body,
            'Lock state not confirmed. Lock state could not be read after the passcode. Scheduled unlock is paused until the passcode is saved again',
        );
        await night(4);
        assert.equal(ctx.driver.calls.length, 4);
        assert.equal(record.lastRun.outcome, 'skipped-rejected');
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: Run now joins a run in progress, cools down after a session-opening run and is capped', async () => {
    const ctx = makeScheduler();
    const udid = 'iphone-run-now';
    try {
        armed(ctx, udid);
        const start = ctx.now();
        const first = ctx.scheduler.runNow(udid, 'manual');
        const second = ctx.scheduler.runNow(udid, 'manual');
        assert.equal(second, first, 'a second press gets the same promise');
        assert.equal(ctx.scheduler.getStatus(udid).running, true);
        assert.deepEqual(await second, await first);
        assert.equal(ctx.driver.calls.length, 1, 'one run, one display session');

        await assert.rejects(ctx.scheduler.runNow(udid, 'manual'), /Try again in 120 s\.$/);
        ctx.setClock(start + 90 * 1000);
        await assert.rejects(ctx.scheduler.runNow(udid, 'manual'), /Try again in 30 s\.$/);
        assert.equal(ctx.driver.calls.length, 1, 'a refused run opens nothing');
        assert.equal(ctx.store.devices.get(udid).lastRun.at, start, 'and is not recorded as a run');

        // Scheduled runs are not refused, but they count toward three per five minutes.
        ctx.store.recordUnlockedAt(udid, start - 30 * HOUR);
        await ctx.scheduler.runNow(udid, 'schedule');
        ctx.setClock(start + 2 * MINUTE);
        ctx.store.recordUnlockedAt(udid, start - 30 * HOUR);
        await ctx.scheduler.runNow(udid, 'schedule');
        assert.equal(ctx.driver.calls.length, 3);
        ctx.setClock(start + 4.5 * MINUTE);
        await assert.rejects(
            ctx.scheduler.runNow(udid, 'manual'),
            /Try again in 30 s\.$/,
            'past the cooldown, held by the cap until the first run is five minutes old',
        );
        ctx.setClock(start + 5 * MINUTE);
        assert.equal((await ctx.scheduler.runNow(udid, 'manual')).outcome, 'unlocked');
        assert.equal(ctx.driver.calls.length, 4);

        // A run that shared a viewer's session opened nothing, so nothing cools down after it.
        const other = 'iphone-run-now-viewer';
        armed(ctx, other);
        ctx.driver.results.push({ outcome: 'unlocked', verifiedAt: ctx.now(), openedSession: false });
        await ctx.scheduler.runNow(other, 'manual', { keepUnlocked: true });
        assert.deepEqual(ctx.driver.options.at(-1), { keepUnlocked: true }, 'the option reaches the driver');
        await ctx.scheduler.runNow(other, 'manual');
        assert.deepEqual(ctx.driver.options.at(-1), { keepUnlocked: false });
        // Nor does a run that was skipped before the driver.
        const idle = 'iphone-run-now-open';
        armed(ctx, idle);
        ctx.monitor.set(idle, false);
        assert.equal((await ctx.scheduler.runNow(idle, 'manual')).outcome, 'already-unlocked');
        assert.equal((await ctx.scheduler.runNow(idle, 'manual')).outcome, 'already-unlocked');
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: a phone left unlocked is pushed for manual runs too, counts as an unlock and is not retried', async () => {
    const ctx = makeScheduler();
    const udid = 'iphone-left-open';
    try {
        armed(ctx, udid);
        const left = { outcome: 'left-unlocked', message: 'The phone still reads unlocked after Lock', typed: true };
        ctx.driver.results.push({ ...left, verifiedAt: ctx.now() });
        assert.equal((await ctx.scheduler.runNow(udid, 'manual')).outcome, 'left-unlocked');
        assert.equal(ctx.pushes.length, 1, 'a manual run is pushed for this outcome');
        assert.equal(
            ctx.pushes[0].body,
            'Unlocked, but the phone did not lock again. The phone still reads unlocked after Lock',
        );
        const record = ctx.store.devices.get(udid);
        assert.equal(record.lastUnlockedAt, ctx.now(), 'the unlock itself happened');
        assert.equal(record.passcodeRejectedAt, undefined);

        delete record.lastUnlockedAt;
        ctx.driver.results.push({ ...left, verifiedAt: ctx.now() });
        assert.equal((await ctx.scheduler.runNow(udid, 'schedule')).outcome, 'left-unlocked');
        assert.equal(ctx.pushes.length, 2);
        assert.equal(record.retryAt, undefined, 'the passcode worked; typing it again fixes nothing');
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: a viewer in the way is retried once without a push; an unlocked phone found by the driver counts as unlocked', async () => {
    const ctx = makeScheduler();
    const udid = 'iphone-viewer-busy';
    try {
        armed(ctx, udid);
        ctx.driver.results.push({ outcome: 'skipped-viewer', openedSession: false });
        assert.equal((await ctx.scheduler.runNow(udid, 'schedule')).outcome, 'skipped-viewer');
        assert.equal(ctx.pushes.length, 0);
        assert.equal(ctx.store.devices.get(udid).retryAt, ctx.now() + UNLOCK_RETRY_MS);
        ctx.driver.results.push({ outcome: 'already-unlocked', verifiedAt: ctx.now() - 5 });
        assert.equal((await ctx.scheduler.runNow(udid, 'manual')).outcome, 'already-unlocked');
        assert.equal(ctx.store.devices.get(udid).lastUnlockedAt, ctx.now() - 5);
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: turning the schedule on, or changing its time, after the slot does not run until the next slot', async () => {
    const slot = lastUnlockSlotAt('03:00', Date.now());
    const ctx = makeScheduler({ time: slot + HOUR });
    const udid = 'iphone-late-on';
    try {
        ctx.monitor.set(udid, true);
        ctx.scheduler.setPasscode(udid, PASSCODE);
        const status = ctx.scheduler.updateSchedule(udid, { enabled: true });
        assert.equal(status.nextRunAt, nextUnlockRunAt('03:00', ctx.now()));
        for (const offset of [HOUR + MINUTE, HOUR + 2 * MINUTE]) {
            ctx.setClock(slot + offset);
            ctx.tick();
            await ctx.settle();
        }
        assert.equal(ctx.driver.calls.length, 0, 'the slot an hour ago is not used');
        assert.equal(ctx.store.devices.get(udid).lastSlotAt, slot);

        ctx.setClock(status.nextRunAt + MINUTE);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 1, 'the first run is the one shown as Next run');

        // Half an hour after that run, the time is moved to a quarter of an hour ago.
        const moved = new Date(status.nextRunAt + 15 * MINUTE);
        const time = `${String(moved.getHours()).padStart(2, '0')}:${String(moved.getMinutes()).padStart(2, '0')}`;
        ctx.setClock(status.nextRunAt + 30 * MINUTE);
        delete ctx.store.devices.get(udid).lastUnlockedAt;
        ctx.store.setRetryAt(udid, ctx.now() + MINUTE);
        ctx.scheduler.updateSchedule(udid, { time });
        assert.equal(ctx.store.devices.get(udid).retryAt, undefined, 'a pending retry is dropped with the old time');
        ctx.setClock(status.nextRunAt + 32 * MINUTE);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 1, 'no second run that night');

        // Storing a passcode with the switch already on behaves the same way.
        const other = 'iphone-late-passcode';
        ctx.monitor.set(other, true);
        ctx.store.updateSchedule(other, { enabled: true });
        ctx.scheduler.setPasscode(other, PASSCODE);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 1);
    } finally {
        ctx.scheduler.release();
    }
});

test('schedule: slots are computed in the stored time zone, across daylight-saving changes', () => {
    const utc = (...fields) => Date.UTC(...fields);
    const noon = utc(2026, 10, 10, 12, 0);
    // New York is UTC-5 in November: 03:00 there is 08:00 UTC.
    assert.equal(nextUnlockRunAt('03:00', noon, 'America/New_York'), utc(2026, 10, 11, 8, 0));
    assert.equal(lastUnlockSlotAt('03:00', noon, 'America/New_York'), utc(2026, 10, 10, 8, 0));
    // Kolkata is UTC+5:30: 03:00 there is 21:30 UTC the day before.
    assert.equal(nextUnlockRunAt('03:00', noon, 'Asia/Kolkata'), utc(2026, 10, 10, 21, 30));
    assert.equal(lastUnlockSlotAt('03:00', noon, 'Asia/Kolkata'), utc(2026, 10, 9, 21, 30));
    assert.equal(nextUnlockRunAt('12:00', noon, 'UTC'), noon + 24 * HOUR, 'strictly after now');
    assert.equal(lastUnlockSlotAt('12:00', noon, 'UTC'), noon, 'at or before now');

    // Clocks go forward in New York on 2026-03-08: that night is 23 hours long.
    const beforeSpring = utc(2026, 2, 7, 8, 0);
    assert.equal(nextUnlockRunAt('03:00', beforeSpring, 'America/New_York'), beforeSpring + 23 * HOUR);
    assert.equal(
        lastUnlockSlotAt('03:00', beforeSpring + 23 * HOUR + MINUTE, 'America/New_York'),
        beforeSpring + 23 * HOUR,
    );
    // And back on 2026-11-01: 25 hours.
    const beforeAutumn = utc(2026, 9, 31, 7, 0);
    assert.equal(nextUnlockRunAt('03:00', beforeAutumn, 'America/New_York'), beforeAutumn + 25 * HOUR);
    // 02:30 does not exist on 2026-03-08. The slot still happens once that night, and the
    // following night is back on the clock (02:30 EDT is 06:30 UTC).
    const skipped = nextUnlockRunAt('02:30', utc(2026, 2, 7, 12, 0), 'America/New_York');
    assert(skipped > utc(2026, 2, 8, 6, 0) && skipped < utc(2026, 2, 8, 8, 0), new Date(skipped).toISOString());
    assert.equal(nextUnlockRunAt('02:30', skipped, 'America/New_York'), utc(2026, 2, 9, 6, 30));
    assert.equal(lastUnlockSlotAt('02:30', skipped, 'America/New_York'), skipped);

    // Without a zone the arithmetic is server local time, as before zones were stored.
    const local = new Date(nextUnlockRunAt('04:05', noon));
    assert.deepEqual([local.getHours(), local.getMinutes()], [4, 5]);

    assert.equal(isValidUnlockSchedulePatch({ time: '03:00', timeZone: 'Europe/Berlin' }), true);
    assert.equal(isValidUnlockSchedulePatch({ enabled: true, timeZone: 'UTC' }), true);
    assert.equal(isValidUnlockSchedulePatch({ time: '03:00', timeZone: 'Mars/Olympus_Mons' }), false);
    assert.equal(isValidUnlockSchedulePatch({ time: '03:00', timeZone: 7 }), false);
    assert.equal(isValidUnlockSchedulePatch({ timeZone: 'UTC' }), false, 'a zone alone changes nothing');
});

test("scheduler: a schedule with a zone runs at that zone's time, and changing the zone does not run the passed slot", async () => {
    const zone = 'Asia/Kolkata';
    const slot = lastUnlockSlotAt('03:00', Date.now(), zone);
    const ctx = makeScheduler({ time: slot + MINUTE });
    const udid = 'iphone-zoned';
    try {
        ctx.monitor.set(udid, true);
        ctx.store.setPasscode(udid, PASSCODE);
        ctx.store.updateSchedule(udid, { enabled: true, time: '03:00', timeZone: zone });
        assert.equal(ctx.scheduler.getStatus(udid).nextRunAt, nextUnlockRunAt('03:00', ctx.now(), zone));
        assert.equal(ctx.scheduler.getStatus(udid).timeZone, zone);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 1, 'a minute after 03:00 in Kolkata');
        assert.equal(ctx.store.devices.get(udid).lastSlotAt, slot);

        // Re-saved from a browser in another zone, right after that zone's 03:00.
        const other = 'America/New_York';
        const otherSlot = lastUnlockSlotAt('03:00', ctx.now() + 24 * HOUR, other);
        ctx.setClock(otherSlot + MINUTE);
        delete ctx.store.devices.get(udid).lastUnlockedAt;
        const status = ctx.scheduler.updateSchedule(udid, { time: '03:00', timeZone: other });
        assert.equal(status.timeZone, other);
        assert.equal(status.nextRunAt, nextUnlockRunAt('03:00', ctx.now(), other));
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 1, 'the slot that passed a minute ago in the new zone is not used');
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: the 72-hour deadline is pushed once at 36 hours and runs outside the slot window past 48', async () => {
    // Three hours after the slot: outside the window, so only the deadline can start a run.
    const base = lastUnlockSlotAt('03:00', Date.now()) + 3 * HOUR;
    let connected = true;
    const ctx = makeScheduler({ time: base, connected: () => connected });
    const udid = 'iphone-deadline';
    try {
        armed(ctx, udid);
        const record = ctx.store.devices.get(udid);
        record.lastSlotAt = base;
        const unlockedAt = base - 37 * HOUR - MINUTE;
        ctx.store.recordUnlockedAt(udid, unlockedAt);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.pushes.length, 1);
        assert.deepEqual(ctx.pushes[0], {
            title: 'iPhone unlock',
            body: 'Not unlocked for 37 hours. iOS restarts the phone in about 35 hours unless it is unlocked.',
            tag: `ios-unlock-deadline-${udid}`,
            url: '#!action=',
        });
        assert.equal(ctx.driver.calls.length, 0, 'under 48 hours the slot window still applies');
        ctx.setClock(base + MINUTE);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.pushes.length, 1, 'pushed once for that unlock');

        // 49 hours: a run outside the window. It fails; no ten-minute retry, the next try is two hours on.
        const urgent = unlockedAt + 49 * HOUR;
        ctx.setClock(urgent);
        record.lastSlotAt = urgent;
        ctx.driver.results.push({ outcome: 'failed-wake' });
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 1, 'a run outside the slot window');
        assert.equal(record.lastRun.outcome, 'failed-wake');
        assert.equal(record.retryAt, undefined);
        assert.equal(ctx.pushes.length, 2, 'its failure is pushed');
        for (const offset of [MINUTE, UNLOCK_RETRY_MS, UNLOCK_URGENT_INTERVAL_MS - MINUTE]) {
            ctx.setClock(urgent + offset);
            ctx.tick();
            await ctx.settle();
        }
        assert.equal(ctx.driver.calls.length, 1, 'not again within two hours');

        // An unplugged phone is not tried, and neither is one that reads unlocked.
        ctx.setClock(urgent + UNLOCK_URGENT_INTERVAL_MS);
        connected = false;
        ctx.tick();
        await ctx.settle();
        connected = true;
        ctx.monitor.states.set(udid, { 'screen.power': 'on', 'device.locked': false });
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 1);
        ctx.monitor.states.set(udid, { 'screen.power': 'off', 'device.locked': true });
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.driver.calls.length, 2, 'two hours later, connected and locked');
        assert.equal(record.lastRun.outcome, 'unlocked');
        assert.equal(record.lastUnlockedAt, ctx.now());
        assert.equal(ctx.pushes.length, 2);

        // A paused schedule cannot run: the warning says so, and nothing is typed.
        const paused = 'iphone-deadline-paused';
        armed(ctx, paused);
        Object.assign(ctx.store.devices.get(paused), {
            lastSlotAt: ctx.now(),
            lastUnlockedAt: ctx.now() - 73 * HOUR,
            passcodeRejectedAt: ctx.now() - 60 * HOUR,
        });
        ctx.tick();
        await ctx.settle();
        assert.equal(
            ctx.pushes.at(-1).body,
            'Not unlocked for 73 hours. iOS has probably restarted it; unlock it once on the phone. Scheduled unlock is paused until the passcode is saved again.',
        );
        assert.equal(ctx.driver.calls.length, 2);
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler: a schedule that is on without a usable passcode is pushed at its slot, and store problems at the first tick', async () => {
    const slot = lastUnlockSlotAt('03:00', Date.now());
    const ctx = makeScheduler({ time: slot + MINUTE });
    const udid = 'iphone-no-passcode';
    try {
        ctx.store.problems = ['ios-settings.json could not be read, so no scheduled unlock is set.'];
        ctx.store.updateSchedule(udid, { enabled: true });
        ctx.monitor.set(udid, true);
        const output = captureConsole();
        try {
            ctx.tick();
            await ctx.settle();
        } finally {
            output.restore();
        }
        assert.deepEqual(ctx.pushes[0], {
            title: 'iPhone unlock',
            body: 'ios-settings.json could not be read, so no scheduled unlock is set.',
            tag: 'ios-unlock-store',
            url: '#!action=',
        });
        assert.equal(ctx.pushes.length, 2);
        assert.equal(ctx.pushes[1].body, 'Skipped: no passcode stored');
        const record = ctx.store.devices.get(udid);
        assert.equal(record.lastRun.outcome, 'skipped-no-passcode');
        assert.equal(record.retryAt, undefined, 'nothing to retry');
        assert.equal(ctx.driver.calls.length, 0);
        ctx.setClock(slot + 2 * MINUTE);
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.pushes.length, 2, 'once per slot, and the store problems once per start');
    } finally {
        ctx.scheduler.release();
    }
});

test('scheduler with the real store: a lost key file or a damaged settings file is pushed, and the file is kept', async () => {
    const directory = path.join(temporary, 'real-store');
    const udid = 'iphone-real-store';
    const zone = 'UTC';
    let clock = lastUnlockSlotAt('03:00', Date.now(), zone) + 5 * MINUTE;
    const make = () => {
        const pushes = [];
        const runs = [];
        const monitor = new FakeMonitor();
        monitor.set(udid, true);
        const scheduler = new UnlockScheduler({
            store: new IosSettingsStore(directory),
            driver: {
                run: async (id, readPasscode) => {
                    runs.push(readPasscode());
                    return { outcome: 'unlocked', verifiedAt: clock };
                },
            },
            monitor,
            notify: (payload) => pushes.push(payload),
            now: () => clock,
        });
        scheduler.start({ isConnected: () => true });
        return { scheduler, pushes, runs, tick: () => scheduler.tick(), settle: () => scheduler.chain.then(tick) };
    };
    const output = captureConsole();
    let ctx = make();
    try {
        ctx.scheduler.setPasscode(udid, PASSCODE);
        const status = ctx.scheduler.updateSchedule(udid, { enabled: true, time: '03:00', timeZone: zone });
        assert.equal(status.timeZone, zone);
        assert.equal(status.serverTimeZone, undefined);
        ctx.tick();
        await ctx.settle();
        assert.deepEqual(ctx.runs, [], 'turned on five minutes after the slot: nothing runs');
        clock += 24 * HOUR;
        ctx.tick();
        await ctx.settle();
        assert.deepEqual(ctx.runs, [PASSCODE], 'the real store decrypts for the next slot');
        assert.equal(ctx.pushes.length, 0);
        ctx.scheduler.release();

        // The key file is gone after a restart (volume restored without it).
        fs.rmSync(path.join(directory, IOS_SETTINGS_KEY_FILE));
        ctx = make();
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.pushes.length, 1);
        assert.match(ctx.pushes[0].body, /^Stored passcode unreadable: key file missing\. Scheduled unlock cannot run/);
        clock += 24 * HOUR;
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.pushes.length, 2, 'and the slot that cannot run says so');
        assert.equal(ctx.pushes[1].body, 'Skipped: no passcode stored. Stored passcode unreadable: key file missing');
        assert.deepEqual(ctx.runs, []);
        ctx.scheduler.release();

        // The settings file is damaged: kept aside, reported, and not overwritten by the next write.
        const file = path.join(directory, IOS_SETTINGS_FILE);
        const damaged = fs.readFileSync(file, 'utf8').slice(0, -20);
        fs.writeFileSync(file, damaged);
        ctx = make();
        ctx.tick();
        await ctx.settle();
        assert.equal(ctx.pushes.length, 1);
        assert.match(ctx.pushes[0].body, /^ios-settings\.json could not be read.*kept as ios-settings\.json\.bad\.$/);
        ctx.scheduler.updateSchedule(udid, { enabled: false });
        assert.equal(fs.readFileSync(path.join(directory, IOS_SETTINGS_BAD_FILE), 'utf8'), damaged);
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).devices[udid].unlock.enabled, false);
        assert(!output.text().includes(PASSCODE));
    } finally {
        output.restore();
        ctx.scheduler.release();
    }
});

test('scheduler with the real driver: a manual run against the fake phone unlocks, records and logs no digits', async () => {
    fs.rmSync(logFile, { force: true });
    const output = captureConsole();
    const udid = 'iphone-end-to-end';
    let ctx;
    try {
        await withEnv({ FAKE_LOG: logFile }, async () => {
            const runner = CoreDeviceRunner.getInstance();
            const monitor = Object.assign(new FakeMonitor(), scriptedMonitor());
            let clock = Date.now();
            const now = () => clock;
            const store = new MemoryStore(now);
            const pushes = [];
            const driver = new UnlockDriver({ runner, monitor, hasInputOwner: () => false });
            const scheduler = new UnlockScheduler({ store, driver, monitor, notify: (p) => pushes.push(p), now });
            ctx = { scheduler };
            scheduler.start({ isConnected: () => true });
            store.updateSchedule(udid, { enabled: true });
            store.setPasscode(udid, PASSCODE);
            monitor.set(udid, true);
            const result = await scheduler.runNow(udid, 'manual');
            assert.equal(result.outcome, 'unlocked', result.message);
            assert.equal(result.message, 'Locked again');
            assert.equal(typeof store.devices.get(udid).lastUnlockedAt, 'number');
            assert.equal(store.reads, 1);
            assert.equal(pushes.length, 0);
            const lines = calls();
            assert.equal(lines.filter(isKey).length, USAGES.length * 2);
            assert(lines.includes(button('lock', 'up')));
            assert(!lines.join('\n').includes(PASSCODE));
            assert(!output.text().includes(PASSCODE));
            assert.match(
                output.text(),
                /\[UnlockScheduler\] \[iphone-end-to-end\] manual unlocked \(Locked again\) in \d+ ms/,
            );
            runner.stopSession(udid);
        });
    } finally {
        output.restore();
        ctx?.scheduler.release();
    }
});
