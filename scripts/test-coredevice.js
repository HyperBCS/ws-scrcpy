// Run with: node scripts/test-coredevice.js
// The iOS screen path without an iPhone: the session runner and the WebSocket proxy are driven
// against scripts/fixtures/fake-pymobiledevice3.js, which speaks the real serve-web HTTP framing;
// the browser-side receiver, HID keyboard mapping, touch normalisation and HEVC frame gating run
// against mocked browser APIs.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

const FAKE = path.join(__dirname, 'fixtures', 'fake-pymobiledevice3.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-coredevice-'));
after(() => {
    // A failed assertion skips a test's own `runner.release()`; without this the fake serve-web
    // and its ffmpeg child would outlive the run.
    if (CoreDeviceRunner.hasInstance()) {
        CoreDeviceRunner.getInstance().release();
    }
    if (DeviceStateMonitor.hasInstance()) {
        DeviceStateMonitor.getInstance().release();
    }
    fs.rmSync(temporary, { recursive: true, force: true });
});

const { PyMobileDevice } = require('../src/server/appl-device/services/PyMobileDevice');
const { CoreDeviceRunner } = require('../src/server/appl-device/services/CoreDeviceRunner');
const { CoreDeviceProxy } = require('../src/server/appl-device/mw/CoreDeviceProxy');
const { DeviceStateMonitor } = require('../src/server/appl-device/services/DeviceStateMonitor');
const { splitStreamFrames, clampHid } = require('../src/common/CoreDeviceProtocol');

// The fake CLI is a node script; `PyMobileDevice.spawn*` execs the resolved path directly, so
// point it at a tiny shell shim that re-execs node with the fixture.
const shim = path.join(temporary, 'pymobiledevice3');
fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
PyMobileDevice.useBin(shim);
// The probes are Python scripts (python/probes/*.py) rather than CLI subcommands; these two env
// vars are their test seam, and the fake answers to each script's name in its place.
process.env.IOS_PROBE_CMD = shim;
// The probe's own name is passed through as its last argument, so the fake knows which one ran.
process.env.IOS_PROBE_ARGS = JSON.stringify([]);

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

class FakeSocket extends EventEmitter {
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 1;
    bufferedAmount = 0;
    sent = [];
    closes = [];
    addEventListener(name, listener) {
        this.on(name, listener);
    }
    removeEventListener(name, listener) {
        this.off(name, listener);
    }
    send(data) {
        this.sent.push(data);
    }
    close(code, reason) {
        this.closes.push({ code, reason });
        this.readyState = this.CLOSED;
        this.emit('close', {});
    }
    texts() {
        return this.sent.filter((item) => typeof item === 'string').map((item) => JSON.parse(item));
    }
    binaries() {
        return this.sent.filter((item) => typeof item !== 'string');
    }
    message(data) {
        this.emit('message', { data, type: 'message' });
    }
}

const logFile = path.join(temporary, 'calls.log');
const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : []);

test('the runner mounts the DDI, starts serve-web, waits for /codec and tears down after the last viewer', async () => {
    fs.rmSync(logFile, { force: true });
    await withEnv({ FAKE_LOG: logFile, FAKE_SERVE_DELAY_MS: '300' }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        const states = [];
        runner.on('status', (event) => states.push(event.state));
        const started = Date.now();
        const port = await runner.acquire('iphone-a');
        assert(Date.now() - started >= 250, 'acquire waits for the stream to be ready, not just for the process');
        assert.deepEqual(states, ['starting', 'starting', 'ready']);
        assert.equal(runner.getStatus('iphone-a').state, 'ready');
        const recorded = calls();
        assert(
            recorded.some((line) => line.includes('"mounter","auto-mount"')),
            'the DDI is mounted first',
        );
        assert(
            recorded.some((line) => line.includes('"serve-web"') && line.includes(`"${port}"`)),
            'serve-web gets the allocated port',
        );
        assert(
            recorded.some((line) => line.includes('"--bind","127.0.0.1"')),
            'serve-web is loopback only: its HID endpoints have no auth',
        );
        assert(
            recorded.some((line) => line.includes('"serve-web"') && line.includes('"--userspace"')),
            'serve-web brings up the iOS 17+ tunnel in-process: no root tunneld on the host',
        );
        const codec = await runner.request('iphone-a', 'GET', '/codec');
        assert.equal(codec.status, 200);
        assert.equal(JSON.parse(codec.body).codec, 'hev1.1.6.L120.90');
        // A second viewer joins the same process.
        const again = await runner.acquire('iphone-a');
        assert.equal(again, port);
        assert.equal(calls().filter((line) => line.includes('"serve-web"')).length, 1);
        runner.release('iphone-a');
        runner.release('iphone-a');
        assert.equal(
            runner.getStatus('iphone-a').state,
            'ready',
            'the session outlives the last viewer for the grace period',
        );
        runner.stopSession('iphone-a', 'test');
        assert.equal(runner.getStatus('iphone-a').state, 'stopped');
        await assert.rejects(runner.request('iphone-a', 'GET', '/codec'), /No screen session/);
        runner.release();
    });
});

test('a wedged display service (serve-web up, /codec stuck on 503) fails fast with a reboot hint', async () => {
    await withEnv({ FAKE_SERVE_DELAY_MS: '600000', IOS_DISPLAY_WEDGED_TIMEOUT_MS: '400' }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        const started = Date.now();
        await assert.rejects(runner.acquire('iphone-wedged'), /display service is stuck -- reboot the phone/);
        assert(Date.now() - started < 8000, 'it does not wait out the full readiness budget');
        assert.equal(runner.getStatus('iphone-wedged').state, 'error');
        runner.release();
    });
});

test('a start failure names Developer Mode and is not sticky', async () => {
    await withEnv({ FAKE_MOUNT_FAIL: 'devmode' }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        await assert.rejects(runner.acquire('iphone-b'), /Developer Mode is off/);
        assert.equal(runner.getStatus('iphone-b').state, 'error');
    });
    await withEnv({ FAKE_SERVE_EXIT: '3' }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        await assert.rejects(runner.acquire('iphone-b'), /displayservice unavailable/);
        assert.equal(runner.getStatus('iphone-b').state, 'error');
    });
    const runner = CoreDeviceRunner.getInstance();
    await runner.acquire('iphone-b');
    assert.equal(runner.getStatus('iphone-b').state, 'ready', 'the next viewer retries with a fresh process');
    runner.release();
});

test('the proxy sends status, codec and framed access units, forwards input, and releases its hold', async () => {
    fs.rmSync(logFile, { force: true });
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        const socket = new FakeSocket();
        const proxy = CoreDeviceProxy.processRequest(socket, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-c'),
        });
        assert(proxy);
        // Device audio shares the socket as type-3 frames (covered by its own tests below).
        const videoFrames = () => socket.binaries().map((frame) => Buffer.from(frame)).filter((frame) => frame[0] !== 3);
        for (let i = 0; i < 100 && videoFrames().length < 3; i++) await sleep(20);
        const texts = socket.texts();
        assert.equal(texts[0].type, 'status');
        assert.equal(texts[0].state, 'starting');
        assert(texts.some((m) => m.type === 'status' && m.state === 'ready'));
        const codec = texts.find((m) => m.type === 'codec');
        assert.equal(codec.codec, 'hev1.1.6.L120.90');
        assert.equal(Buffer.from(codec.description, 'base64').toString('hex'), '01020304');
        const frames = videoFrames();
        assert.deepEqual(
            frames.map((frame) => frame[0]),
            [0, 1, 2],
            'key, delta and reset-key frames arrive in order across chunk boundaries',
        );
        assert.equal(
            frames[0].subarray(1).toString('hex'),
            '00000003400 1aa00000004260 1bbcc'.replace(/ /g, ''),
            'the key frame keeps its length-prefixed NALUs',
        );
        assert.equal(frames[2].subarray(1).toString('hex'), '000000032601ee');

        // Input before the video stream is attached must never reach the phone: serve-web would
        // open the HID surfaces with the auth gate shut and then drop every later event.
        const early = new FakeSocket();
        const earlyProxy = CoreDeviceProxy.processRequest(early, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-c'),
        });
        assert(earlyProxy);
        early.message(JSON.stringify({ type: 'touch', op: 'tap', x: 1, y: 2 }));
        early.message(JSON.stringify({ type: 'key', usages: [4] }));
        early.message(JSON.stringify({ type: 'button', name: 'home' }));
        await sleep(200);
        assert.equal(
            calls().filter((line) => line.startsWith('post /touch') || line.startsWith('post /key')).length,
            0,
            'no HID request is sent before /stream.bin is attached',
        );
        early.close(1000, 'done');

        socket.message(JSON.stringify({ type: 'touch', op: 'contact', x: 70000, y: -5 }));
        socket.message(JSON.stringify({ type: 'touch', op: 'release', x: 100, y: 200 }));
        socket.message(JSON.stringify({ type: 'button', name: 'home' }));
        socket.message(JSON.stringify({ type: 'button', name: 'reboot' }));
        socket.message(JSON.stringify({ type: 'button', name: 'lock' }));
        socket.message(JSON.stringify({ type: 'key', usages: [4, 0xe1, 999, -1] }));
        socket.message(JSON.stringify({ type: 'clipboard', op: 'get' }));
        socket.message(JSON.stringify({ type: 'clipboard', op: 'set', text: 'hi', id: 7 }));
        socket.message(JSON.stringify({ type: 'rotate', direction: 'left', id: 8 }));
        socket.message('not json');
        for (
            let i = 0;
            i < 150 &&
            (socket.texts().filter((m) => m.type === 'result').length < 2 ||
                !calls().some((line) => line.includes('"lock","state":"up"')));
            i++
        ) {
            await sleep(20);
        }
        const posted = calls().filter((line) => line.startsWith('post '));
        assert(
            posted.includes('post /touch {"type":"contact","x":65535,"y":0}'),
            'touch coordinates are clamped to the HID range',
        );
        assert(posted.includes('post /touch {"type":"release","x":100,"y":200}'));
        assert.deepEqual(
            posted.filter((line) => line.includes('"home"')),
            ['post /button {"name":"home","state":"down"}', 'post /button {"name":"home","state":"up"}'],
            'a home press is a held down/up pair; serve-web\'s own 50 ms press does nothing on a Face ID phone',
        );
        assert(!posted.some((line) => line.includes('reboot')), 'unknown buttons never reach the device');
        assert.deepEqual(
            posted.filter((line) => line.includes('"lock"')),
            ['post /button {"name":"lock","state":"down"}', 'post /button {"name":"lock","state":"up"}'],
            'a lock press is a short down/up pair, not the CLI\'s 0.5 s hold (which is Siri on Face ID phones)',
        );
        assert(posted.includes('post /key {"usages":[4,225]}'), 'usages outside the 240-bit report are dropped');
        assert(posted.includes('post /clipboard {"text":"hi"}'));
        const clipboard = socket.texts().find((m) => m.type === 'clipboard');
        assert.equal(clipboard.text, 'from the phone');
        const results = socket.texts().filter((m) => m.type === 'result');
        // Replies are matched by id, so ordering between independent commands is not guaranteed:
        // the clipboard write waits its turn in the clipboard queue while `rotate` goes straight out.
        assert.deepEqual(
            results.map((m) => [m.id, m.ok]).sort((a, b) => a[0] - b[0]),
            [
                [7, true],
                [8, true],
            ],
        );
        const rotation = results.find((m) => m.id === 8);
        assert.equal(rotation.data.orientation, 'landscapeLeft');

        socket.close(1000, 'bye');
        await tick();
        assert.equal(
            runner.getStatus('iphone-c').state,
            'ready',
            'the grace period keeps the session for a returning viewer',
        );
        runner.release();
        assert.equal(runner.getStatus('iphone-c').state, 'stopped');
    });
});

test('stderr explanations pick the human line out of logs, rich error boxes and tracebacks', () => {
    assert.equal(
        PyMobileDevice.explain('2026-09-16 00:18:44 bcs-nuc pymobiledevice3.cli.mounter[53683] ERROR DeveloperDiskImage already mounted\n'),
        'DeveloperDiskImage already mounted',
    );
    assert.equal(
        PyMobileDevice.explain(
            'Usage: pymobiledevice3 developer core-device display serve-web [OPTIONS]\n' +
                "Try 'pymobiledevice3 developer core-device display serve-web -h' for help.\n" +
                '╭─ Error ──────────────────────────╮\n' +
                '│ No such option: --udid           │\n' +
                '╰──────────────────────────────────╯\n',
        ),
        'No such option: --udid',
    );
    assert.equal(
        PyMobileDevice.explain('Traceback (most recent call last):\n  File "x.py", line 1\nRuntimeError: AAC-ELD decode requires macOS (AudioToolbox)\n'),
        'RuntimeError: AAC-ELD decode requires macOS (AudioToolbox)',
    );
});

test('a proxy whose start fails reports it, closes the socket so the viewer retries, and stops listening', async () => {
    await withEnv({ FAKE_MOUNT_FAIL: 'devmode' }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        const socket = new FakeSocket();
        const proxy = CoreDeviceProxy.processRequest(socket, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-fail'),
        });
        assert(proxy);
        for (let i = 0; i < 100 && !socket.closes.length; i++) await sleep(20);
        const texts = socket.texts();
        const last = texts[texts.length - 1];
        assert.equal(last.type, 'status');
        assert.equal(last.state, 'error');
        assert.match(last.message, /Developer Mode is off/);
        assert.deepEqual(
            socket.closes,
            [{ code: 4009, reason: 'Stream unavailable' }],
            'the socket is closed so the viewer reconnects instead of sitting on the error',
        );
        // A released proxy must not keep relaying another viewer's session status.
        const before = socket.sent.length;
        runner.emit('status', { udid: 'iphone-fail', state: 'ready' });
        assert.equal(socket.sent.length, before, 'no further messages after release');
        runner.release();
    });
});

test('the debug service commands stop the session and remount the developer image', async (t) => {
    const { ControlCenter } = require('../src/server/appl-device/services/ControlCenter');
    const { ControlCenterCommand } = require('../src/common/ControlCenterCommand');
    const runner = CoreDeviceRunner.getInstance();
    t.mock.method(PyMobileDevice, 'runJson', async (args) => {
        if (args[0] === 'usbmux') return ['iphone-debug'];
        if (args[0] === 'lockdown') return { DeviceName: 'Dbg', ProductType: 'iPhone14,3', ProductVersion: '27.0' };
        if (args[0] === 'amfi') return true;
        throw new Error(`unexpected ${args.join(' ')}`);
    });
    const oneShots = [];
    t.mock.method(PyMobileDevice, 'runOneShot', async (args) => {
        oneShots.push(args.join(' '));
        return { code: 0, stdout: '', stderr: 'INFO DeveloperDiskImage already mounted' };
    });
    const stopped = [];
    t.mock.method(runner, 'stopSession', (udid, reason) => stopped.push({ udid, reason }));
    const tracker = new ControlCenter();
    await tracker.init();
    await tick();
    await tick();

    const command = (type) =>
        ControlCenterCommand.fromJSON(JSON.stringify({ id: 1, type, data: { udid: 'iphone-debug' } }));

    const restarted = await tracker.runCommand(command(ControlCenterCommand.RESTART_SESSION));
    assert.match(restarted, /Services restarted/, 'the viewer is told what to do next');
    assert.deepEqual(stopped.at(-1), { udid: 'iphone-debug', reason: 'Services restarted from the device list' });

    const mounted = await tracker.runCommand(command(ControlCenterCommand.REMOUNT_DDI));
    assert.match(mounted, /already mounted/, 'the CLI\'s own words come back to the card');
    assert(
        oneShots.some((line) => line.startsWith('mounter auto-mount')),
        'the image is remounted',
    );
    assert.equal(
        stopped.at(-1).reason,
        'Remounting the developer image',
        'the session is dropped first: it holds the image open',
    );
    tracker.release();
    runner.release();
});

test('restart-session kills serve-web so the next viewer gets a fresh process', async () => {
    fs.rmSync(logFile, { force: true });
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        const socket = new FakeSocket();
        const proxy = CoreDeviceProxy.processRequest(socket, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-restart'),
        });
        assert(proxy);
        for (let i = 0; i < 200 && !socket.texts().some((m) => m.type === 'codec'); i++) await sleep(20);
        assert.equal(runner.getStatus('iphone-restart').state, 'ready');
        assert.equal(calls().filter((line) => line.includes('"serve-web"')).length, 1);
        socket.message(JSON.stringify({ type: 'restart-session' }));
        await sleep(200);
        assert.equal(runner.getStatus('iphone-restart').state, 'stopped', 'the process is gone, not just the video');
        // A `restart` by contrast only pokes the running process.
        const next = new FakeSocket();
        CoreDeviceProxy.processRequest(next, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-restart'),
        });
        for (let i = 0; i < 200 && !next.texts().some((m) => m.type === 'codec'); i++) await sleep(20);
        assert.equal(calls().filter((line) => line.includes('"serve-web"')).length, 2, 'a second process was spawned');
        next.message(JSON.stringify({ type: 'restart' }));
        await sleep(300);
        assert(
            calls().some((line) => line.startsWith('post /restart')),
            'restart stays inside the process',
        );
        assert.equal(calls().filter((line) => line.includes('"serve-web"')).length, 2);
        runner.release();
    });
});

test('clipboard requests are serialised, and a third is refused rather than queued', async () => {
    await withEnv({ FAKE_LOG: logFile, FAKE_CLIPBOARD_HANG: '1', IOS_CLIPBOARD_TIMEOUT_MS: '300' }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        const socket = new FakeSocket();
        const proxy = CoreDeviceProxy.processRequest(socket, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-busy'),
        });
        assert(proxy);
        for (let i = 0; i < 200 && !socket.texts().some((m) => m.type === 'codec'); i++) await sleep(20);
        socket.message(JSON.stringify({ type: 'clipboard', op: 'get' })); // in flight (hangs)
        await sleep(300);
        socket.message(JSON.stringify({ type: 'clipboard', op: 'set', text: 'x', id: 8 })); // queued: allowed
        socket.message(JSON.stringify({ type: 'clipboard', op: 'get' })); // third: refused now
        await sleep(400);
        const refused = socket.texts().filter((m) => m.type === 'clipboard' && /still waiting/.test(m.error || ''));
        assert.equal(refused.length, 1, 'only the third request is refused');
        assert(
            !socket.texts().some((m) => m.type === 'result' && m.id === 8),
            'the queued write is still waiting its turn, not refused',
        );
        runner.release();
    });
});

test('a clipboard request that the phone never answers reports back instead of hanging silently', async () => {
    await withEnv({ FAKE_LOG: logFile, FAKE_CLIPBOARD_HANG: '1', IOS_CLIPBOARD_TIMEOUT_MS: '300' }, async () => {
        fs.rmSync(logFile, { force: true });
        const runner = CoreDeviceRunner.getInstance();
        const socket = new FakeSocket();
        const proxy = CoreDeviceProxy.processRequest(socket, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-clip'),
        });
        assert(proxy);
        for (let i = 0; i < 200 && !socket.texts().some((m) => m.type === 'codec'); i++) await sleep(20);
        // A `get` carries no id: before this fix its failure only reached the server console.
        socket.message(JSON.stringify({ type: 'clipboard', op: 'get' }));
        socket.message(JSON.stringify({ type: 'clipboard', op: 'set', text: 'x', id: 3 }));
        for (let i = 0; i < 400 && socket.texts().filter((m) => m.type === 'clipboard' || m.type === 'result').length < 2; i++) {
            await sleep(50);
        }
        const clip = socket.texts().find((m) => m.type === 'clipboard');
        assert(clip, 'the viewer is told the read failed');
        assert.equal(clip.text, null);
        assert.match(clip.error, /Reboot the phone/, 'and what is left to try');
        const result = socket.texts().find((m) => m.type === 'result' && m.id === 3);
        assert(result && !result.ok);
        assert.match(result.error, /Reboot the phone/);
        assert(
            fs.readFileSync(logFile, 'utf8').includes('pasteboard_restart.py'),
            'the wedged pasteboard daemon was restarted before giving up',
        );
        runner.release();
    });
});

test('a wedged pasteboard daemon is restarted and the read retried, so the viewer just gets the text', async () => {
    // The phone's dtpasteboardd takes a read and never answers it. Killing that daemon is the only
    // cure (a fresh serve-web reaches the same stuck process), so the proxy does it and asks again.
    await withEnv(
        { FAKE_LOG: logFile, FAKE_CLIPBOARD_HANG_FIRST: '1', IOS_CLIPBOARD_TIMEOUT_MS: '300' },
        async () => {
            fs.rmSync(logFile, { force: true });
            const runner = CoreDeviceRunner.getInstance();
            const socket = new FakeSocket();
            const proxy = CoreDeviceProxy.processRequest(socket, {
                action: 'proxy-coredevice',
                url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-wedged'),
            });
            assert(proxy);
            for (let i = 0; i < 200 && !socket.texts().some((m) => m.type === 'codec'); i++) await sleep(20);
            socket.message(JSON.stringify({ type: 'clipboard', op: 'get' }));
            for (let i = 0; i < 200 && !socket.texts().some((m) => m.type === 'clipboard'); i++) await sleep(20);
            const clip = socket.texts().find((m) => m.type === 'clipboard');
            assert(clip, 'the viewer gets a reply');
            assert.equal(clip.error, undefined, 'and no error, because the retry worked');
            assert.equal(clip.text, 'from the phone');
            const calls = fs.readFileSync(logFile, 'utf8');
            assert(calls.includes('pasteboard_restart.py'), 'the daemon was restarted');
            assert.equal(
                calls.split('\n').filter((line) => line.includes('pasteboard_restart.py')).length,
                1,
                'once, not per attempt',
            );
            runner.release();
        },
    );
});

test('a helper that answers "clipboard error" gets the same cure as one that hangs', async () => {
    // What serve-web reports when the pasteboard daemon is there but not answering its socket:
    // a 500 whose message is empty. Restarting the daemon fixes that one too.
    await withEnv(
        { FAKE_LOG: logFile, FAKE_CLIPBOARD_ERROR_FIRST: '1', IOS_CLIPBOARD_TIMEOUT_MS: '300' },
        async () => {
            fs.rmSync(logFile, { force: true });
            const runner = CoreDeviceRunner.getInstance();
            const socket = new FakeSocket();
            const proxy = CoreDeviceProxy.processRequest(socket, {
                action: 'proxy-coredevice',
                url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-clip-500'),
            });
            assert(proxy);
            for (let i = 0; i < 200 && !socket.texts().some((m) => m.type === 'codec'); i++) await sleep(20);
            socket.message(JSON.stringify({ type: 'clipboard', op: 'get' }));
            for (let i = 0; i < 200 && !socket.texts().some((m) => m.type === 'clipboard'); i++) await sleep(20);
            const clip = socket.texts().find((m) => m.type === 'clipboard');
            assert(clip && clip.error === undefined, 'the retry answered, so the viewer sees no error');
            assert.equal(clip.text, 'from the phone');
            assert(fs.readFileSync(logFile, 'utf8').includes('pasteboard_restart.py'));
            runner.release();
        },
    );
});

test('nothing to restart means the viewer is told the truth rather than sent in circles', async () => {
    await withEnv(
        {
            FAKE_LOG: logFile,
            FAKE_CLIPBOARD_HANG: '1',
            FAKE_PASTEBOARD_RESTART: 'none',
            IOS_CLIPBOARD_TIMEOUT_MS: '300',
        },
        async () => {
            fs.rmSync(logFile, { force: true });
            const runner = CoreDeviceRunner.getInstance();
            const socket = new FakeSocket();
            const proxy = CoreDeviceProxy.processRequest(socket, {
                action: 'proxy-coredevice',
                url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-no-daemon'),
            });
            assert(proxy);
            for (let i = 0; i < 200 && !socket.texts().some((m) => m.type === 'codec'); i++) await sleep(20);
            // A write, so the fake's log records each attempt (it logs POST bodies).
            socket.message(JSON.stringify({ type: 'clipboard', op: 'set', text: 'x', id: 5 }));
            for (let i = 0; i < 200 && !socket.texts().some((m) => m.type === 'result'); i++) await sleep(20);
            const result = socket.texts().find((m) => m.type === 'result' && m.id === 5);
            assert(result && !result.ok);
            assert.match(result.error, /Reboot the phone/);
            assert.equal(
                fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line.startsWith('post /clipboard'))
                    .length,
                1,
                'no retry against a daemon that was never restarted',
            );
            runner.release();
        },
    );
});

const FAKE_DECODER = path.join(__dirname, 'fixtures', 'fake-audio-decoder.js');
const AUDIO_PREFIX = 3;
const ENVELOPE = 23;
const decodeAudioPackets = (socket) =>
    socket
        .binaries()
        .map((frame) => Buffer.from(frame))
        .filter((frame) => frame[0] === AUDIO_PREFIX)
        .map((frame) => {
            const kind = frame[1 + 14];
            const timestamp = Number(frame.readBigUInt64BE(1 + 15));
            const payload = frame.subarray(1 + ENVELOPE);
            return kind === 2 ? { kind, metadata: JSON.parse(payload.toString()) } : { kind, timestamp, payload };
        });
const hasFfmpeg = () => {
    try {
        require('node:child_process').execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

test('audio fMP4: the init segment carries the 480-sample ELD config and each frame is one fragment', () => {
    const { audioInitSegment, audioSegment } = require('../src/server/appl-device/services/CoreDeviceAudio');
    const init = audioInitSegment();
    const boxes = [];
    const walk = (buffer, start, end, depth) => {
        for (let offset = start; offset + 8 <= end; ) {
            const size = buffer.readUInt32BE(offset);
            const type = buffer.toString('latin1', offset + 4, offset + 8);
            boxes.push(type);
            if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'dinf'].includes(type)) {
                walk(buffer, offset + 8, offset + size, depth + 1);
            } else if (type === 'stsd') {
                walk(buffer, offset + 16, offset + size, depth + 1);
            } else if (type === 'mp4a') {
                walk(buffer, offset + 36, offset + size, depth + 1);
            }
            offset += size;
        }
    };
    walk(init, 0, init.length, 0);
    assert.deepEqual(
        boxes,
        ['ftyp', 'moov', 'mvhd', 'trak', 'tkhd', 'mdia', 'mdhd', 'hdlr', 'minf', 'smhd', 'dinf', 'dref', 'stbl', 'stsd', 'mp4a', 'esds', 'stts', 'stsc', 'stsz', 'stco', 'mvex', 'trex'],
    );
    const esds = init.indexOf('esds', 0, 'latin1');
    assert.ok(init.subarray(esds).includes(Buffer.from([0x05, 0x04, 0xf8, 0xe6, 0x50, 0x00])), 'the DecoderSpecificInfo is the 480-sample ELD config, not Apple\'s 512 cookie');
    const au = Buffer.from('89ffffffff636db4c8', 'hex');
    const segment = audioSegment(au, 7, 6 * 480);
    const moofSize = segment.readUInt32BE(0);
    assert.equal(segment.toString('latin1', 4, 8), 'moof');
    assert.equal(segment.toString('latin1', moofSize + 4, moofSize + 8), 'mdat');
    assert.equal(segment.readUInt32BE(moofSize), 8 + au.length);
    assert.ok(segment.subarray(moofSize + 8).equals(au), 'the access unit is carried verbatim');
    const trun = segment.indexOf('trun', 0, 'latin1');
    assert.equal(segment.readUInt32BE(trun + 8), 1, 'one sample per fragment');
    assert.equal(segment.readInt32BE(trun + 12), moofSize + 8, 'data offset points at the mdat payload');
    assert.equal(segment.readUInt32BE(trun + 16), 480, 'sample duration');
    assert.equal(segment.readUInt32BE(trun + 20), au.length, 'sample size');
    const tfdt = segment.indexOf('tfdt', 0, 'latin1');
    assert.equal(Number(segment.readBigUInt64BE(tfdt + 8)), 6 * 480, 'decode time in samples');
    const mfhd = segment.indexOf('mfhd', 0, 'latin1');
    assert.equal(segment.readUInt32BE(mfhd + 8), 7);
});

test('audio relay: raw AAC-ELD frames are decoded once and fanned out as 20 ms raw packets', async () => {
    await withEnv({ IOS_AUDIO_DECODER: FAKE_DECODER }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        const socket = new FakeSocket();
        const proxy = CoreDeviceProxy.processRequest(socket, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-audio'),
        });
        assert(proxy);
        for (let i = 0; i < 200 && decodeAudioPackets(socket).filter((p) => p.kind === 0).length < 5; i++) await sleep(20);
        const packets = decodeAudioPackets(socket);
        assert.equal(packets[0].kind, 2);
        assert.equal(packets[0].metadata.status, 'pending');
        const ready = packets.find((p) => p.kind === 2 && p.metadata.status === 'ready');
        assert.ok(ready, 'audio is announced ready once /audio.bin answers');
        assert.equal(ready.metadata.codec, 'raw');
        assert.equal(ready.metadata.sampleRate, 48000);
        assert.equal(ready.metadata.channels, 2);
        const samples = packets.filter((p) => p.kind === 0);
        assert.ok(samples.length >= 5);
        samples.forEach((sample, index) => {
            assert.equal(sample.payload.length, 3840, '20 ms of s16le stereo per packet');
            assert.equal(sample.timestamp, index * 20000, 'timestamps advance by 20 ms from zero');
        });
        assert.equal(samples[0].payload.readInt16LE(0), 1000, 'decoder output is carried verbatim');
        assert.equal(samples[0].payload.readInt16LE(2), -1000);
        // A second viewer shares the same decoder and gets the current metadata straight away.
        const second = new FakeSocket();
        const secondProxy = CoreDeviceProxy.processRequest(second, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-audio'),
        });
        assert(secondProxy);
        for (let i = 0; i < 100 && decodeAudioPackets(second).filter((p) => p.kind === 0).length < 2; i++) await sleep(20);
        const secondPackets = decodeAudioPackets(second);
        assert.equal(secondPackets[0].kind, 2);
        assert.equal(secondPackets[0].metadata.status, 'ready', 'a late viewer starts from the live state');
        assert.ok(secondPackets.some((p) => p.kind === 0));
        assert.equal(calls().filter((line) => line.includes('fake-audio-decoder')).length, 0);
        socket.close(1000, 'bye');
        second.close(1000, 'bye');
        await tick();
        runner.release();
    });
});

test('audio relay: the unpatched helper\'s 503 becomes a disabled status with the setup hint', async () => {
    await withEnv({ FAKE_AUDIO: 'unpatched', IOS_AUDIO_DECODER: FAKE_DECODER }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        const socket = new FakeSocket();
        const proxy = CoreDeviceProxy.processRequest(socket, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-noaudio'),
        });
        assert(proxy);
        const settled = () =>
            decodeAudioPackets(socket).some((p) => p.kind === 2 && p.metadata.status !== 'pending') &&
            socket.binaries().some((frame) => Buffer.from(frame)[0] !== AUDIO_PREFIX);
        for (let i = 0; i < 200 && !settled(); i++) await sleep(20);
        const final = decodeAudioPackets(socket).filter((p) => p.kind === 2).pop();
        assert.equal(final.metadata.status, 'disabled');
        assert.match(final.metadata.message, /npm run setup:ios/);
        assert.ok(socket.binaries().some((frame) => Buffer.from(frame)[0] !== AUDIO_PREFIX), 'video still flows');
        socket.close(1000, 'bye');
        await tick();
        runner.release();
    });
});

test('audio relay: IOS_AUDIO=0 tells the viewer audio is off instead of leaving it pending', async () => {
    await withEnv({ IOS_AUDIO: '0' }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        const socket = new FakeSocket();
        const proxy = CoreDeviceProxy.processRequest(socket, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-audio-off'),
        });
        assert(proxy);
        for (let i = 0; i < 200 && decodeAudioPackets(socket).length < 1; i++) await sleep(20);
        const packets = decodeAudioPackets(socket);
        assert.equal(packets.length, 1);
        assert.equal(packets[0].metadata.status, 'disabled');
        assert.match(packets[0].metadata.message, /IOS_AUDIO=0/);
        socket.close(1000, 'bye');
        await tick();
        runner.release();
    });
});

test('audio relay: real ffmpeg decodes the iPhone AAC-ELD fixture into audible PCM', { skip: !hasFfmpeg() && 'ffmpeg is not installed' }, async () => {
    await withEnv({ IOS_AUDIO_DECODER: undefined }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        const socket = new FakeSocket();
        const proxy = CoreDeviceProxy.processRequest(socket, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-ffmpeg'),
        });
        assert(proxy);
        // The fixture is 2 s of audio; wait for most of it so the check covers real frames.
        for (let i = 0; i < 400 && decodeAudioPackets(socket).filter((p) => p.kind === 0).length < 60; i++) await sleep(20);
        const packets = decodeAudioPackets(socket);
        assert.ok(!packets.some((p) => p.kind === 2 && p.metadata.status === 'error'), `no decoder error: ${JSON.stringify(packets.filter((p) => p.kind === 2).map((p) => p.metadata))}`);
        const samples = packets.filter((p) => p.kind === 0);
        assert.ok(samples.length >= 60, `expected at least 1.2 s of PCM, got ${samples.length * 20} ms`);
        let sum = 0;
        let count = 0;
        for (const sample of samples) {
            for (let offset = 0; offset < sample.payload.length; offset += 2) {
                const value = sample.payload.readInt16LE(offset);
                sum += value * value;
                count++;
            }
        }
        const rms = Math.sqrt(sum / count);
        assert.ok(rms > 500, `decoded audio should carry signal, rms=${rms.toFixed(0)}`);
        socket.close(1000, 'bye');
        await tick();
        runner.release();
    });
});

test('browser side: the CoreDevice receiver routes audio packets to the audio events, not the video decoder', () => {
    installBrowserMocks();
    const { CoreDeviceReceiver } = require('../src/app/applDevice/client/CoreDeviceReceiver');
    const { parseAudioPacket } = require('../src/app/client/audioPacket');
    const { CoreDeviceAudioRelay } = require('../src/server/appl-device/services/CoreDeviceAudio');
    const receiver = Object.create(CoreDeviceReceiver.prototype);
    const events = [];
    receiver.emit = (name, payload) => events.push([name, payload]);
    receiver.stopped = false;
    const metadata = CoreDeviceAudioRelay.packet(2, 0n, Buffer.from(JSON.stringify({ status: 'ready', codec: 'raw', sampleRate: 48000, channels: 2 })));
    const sample = CoreDeviceAudioRelay.packet(0, 20000n, Buffer.from([1, 2, 3, 4]));
    const toArrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
    receiver.onSocketMessage({ data: toArrayBuffer(Buffer.concat([Buffer.from([3]), metadata])) });
    receiver.onSocketMessage({ data: toArrayBuffer(Buffer.concat([Buffer.from([3]), sample])) });
    receiver.onSocketMessage({ data: toArrayBuffer(Buffer.from([0, 9, 9])) });
    receiver.onSocketMessage({ data: toArrayBuffer(Buffer.concat([Buffer.from([3]), Buffer.from('short')])) });
    assert.deepEqual(events.map(([name]) => name), ['audioMetadata', 'audio', 'video', 'audioMetadata']);
    assert.equal(events[0][1].codec, 'raw');
    assert.equal(events[1][1].timestamp, 20000);
    assert.deepEqual(Array.from(events[1][1].data), [1, 2, 3, 4]);
    assert.equal(events[3][1].status, 'error', 'a malformed audio packet only degrades the audio status');
    assert.equal(receiver.getAudioMetadata().status, 'error');
    assert.equal(parseAudioPacket(toArrayBuffer(sample)).frame.timestamp, 20000, 'the shared parser reads the envelope at offset 0 too');
});

test('stream frames split correctly on any chunk boundary', () => {
    const frame = (type, payload) => {
        const body = Buffer.concat([Buffer.from([type]), Buffer.from(payload)]);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(body.length, 0);
        return Buffer.concat([length, body]);
    };
    const stream = Buffer.concat([frame(0, [1, 2, 3]), frame(1, [4]), frame(2, [])]);
    for (let cut = 0; cut <= stream.length; cut++) {
        const first = splitStreamFrames(new Uint8Array(stream.subarray(0, cut)));
        const merged = Buffer.concat([Buffer.from(first.rest), stream.subarray(cut)]);
        const second = splitStreamFrames(new Uint8Array(merged));
        const all = [...first.frames, ...second.frames].map((f) => Buffer.from(f).toString('hex'));
        assert.deepEqual(all, ['00010203', '0104', '02'], `cut at ${cut}`);
        assert.equal(second.rest.length, 0);
    }
    assert.equal(clampHid(65535.4), 65535);
    assert.equal(clampHid(NaN), 0);
});

test('browser side: client points map onto the video, including letterbox bands and off-canvas drags', () => {
    const { clientPointToVideo } = require('../src/app/applDevice/touchMath');
    const video = { width: 1296, height: 2816 };
    // Canvas exactly the video's aspect: 324x704 at (10, 20).
    const box = { left: 10, top: 20, width: 324, height: 704 };
    assert.deepEqual(clientPointToVideo(10, 20, box, video), { x: 0, y: 0 });
    assert.deepEqual(clientPointToVideo(10 + 162, 20 + 352, box, video), { x: 648, y: 1408 });
    assert.deepEqual(clientPointToVideo(10 + 324, 20 + 704, box, video), { x: 1296, y: 2816 });
    // Finger slides past the right edge mid-drag: clamped onto the picture, not dropped.
    assert.deepEqual(clientPointToVideo(500, 20 + 352, box, video), { x: 1296, y: 1408 });
    // A wider canvas letterboxes the portrait picture in the middle.
    const wide = { left: 0, top: 0, width: 1000, height: 704 };
    assert.deepEqual(clientPointToVideo(500, 352, wide, video), { x: 648, y: 1408 });
    assert.deepEqual(clientPointToVideo(0, 352, wide, video), { x: 0, y: 1408 });
    // The bug this replaces: coordinates read off a spread event object were undefined.
    assert.equal(clientPointToVideo(undefined, undefined, box, video), undefined);
    assert.equal(clientPointToVideo(5, 5, { left: 0, top: 0, width: 0, height: 0 }, video), undefined);
});

test('browser side: keyboard usages, typed text and touch normalisation', () => {
    const { hidUsageForCode, keyboardReportsForText } = require('../src/app/applDevice/hidKeyboard');
    assert.equal(hidUsageForCode('KeyA'), 0x04);
    assert.equal(hidUsageForCode('Digit0'), 0x27);
    assert.equal(hidUsageForCode('F12'), 0x45);
    assert.equal(hidUsageForCode('MetaLeft'), 0xe3);
    assert.equal(hidUsageForCode('Unknown'), undefined);
    const { reports, skipped } = keyboardReportsForText('Hi!\né');
    assert.deepEqual(
        reports,
        [[0xe1], [0xe1, 0x0b], [0xe1], [], [0x0c], [], [0xe1], [0xe1, 0x1e], [0xe1], [], [0x28], []],
        'Shift arrives in its own report before the key and is released after it; every press is followed by a release',
    );
    assert.deepEqual(skipped, ['é']);
    // iOS Smart Punctuation rewrites what the user typed on the phone keyboard; those characters
    // must come out as the plain keys the user actually pressed, not be skipped.
    const { HID_USAGE, asciiEquivalent } = require('../src/app/applDevice/hidKeyboard');
    assert.equal(asciiEquivalent('it\u2019s \u201cok\u201d \u2014 done\u2026\u00a0'), 'it\'s "ok" - done... ');
    const smart = keyboardReportsForText('it\u2019s');
    assert.deepEqual(smart.skipped, []);
    assert.deepEqual(smart.reports, [[0x0c], [], [0x17], [], [0x34], [], [0x16], []]);
    assert.deepEqual(keyboardReportsForText('caf\u00e9').skipped, ['\u00e9'], 'accents are reported, not folded');
    // Editing keys the Type text sheet presses by name, plus the navigation block.
    assert.equal(hidUsageForCode('Delete'), HID_USAGE.DELETE_FORWARD);
    assert.equal(hidUsageForCode('Home'), 0x4a);
    assert.equal(hidUsageForCode('End'), 0x4d);
    assert.equal(hidUsageForCode('NumpadEnter'), 0x58);
    assert.equal(HID_USAGE.ARROW_LEFT, hidUsageForCode('ArrowLeft'));
    assert.equal(HID_USAGE.ARROW_RIGHT, hidUsageForCode('ArrowRight'));
});

test('HID input leaves the proxy one report at a time, in the order it arrived', async () => {
    const keyLog = path.join(temporary, 'keys.log');
    fs.rmSync(keyLog, { force: true });
    const posts = () =>
        (fs.existsSync(keyLog) ? fs.readFileSync(keyLog, 'utf8').trim().split('\n') : []).filter((line) =>
            line.startsWith('post /key') || line.startsWith('post /touch'),
        );
    // The fake answers every /key after 150 ms. Without serialisation all reports would be logged
    // at once; with it, each one is posted only after the previous answer.
    await withEnv({ FAKE_LOG: keyLog, FAKE_SLOW_KEY_MS: '150' }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        const socket = new FakeSocket();
        const proxy = CoreDeviceProxy.processRequest(socket, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-keys'),
        });
        assert(proxy);
        for (let i = 0; i < 100 && socket.binaries().length < 3; i++) await sleep(20);
        // Shift, Shift+H, Shift, release, then a touch and a plain key: a press/release pair
        // and a modifier that must not overtake each other.
        socket.message(JSON.stringify({ type: 'key', usages: [0xe1] }));
        socket.message(JSON.stringify({ type: 'key', usages: [0xe1, 0x0b] }));
        socket.message(JSON.stringify({ type: 'key', usages: [0xe1] }));
        socket.message(JSON.stringify({ type: 'key', usages: [] }));
        socket.message(JSON.stringify({ type: 'touch', op: 'tap', x: 1, y: 2 }));
        socket.message(JSON.stringify({ type: 'key', usages: [0x0c] }));
        await sleep(60);
        assert.deepEqual(posts(), ['post /key {"usages":[225]}'], 'the second report waits for the first answer');
        for (let i = 0; i < 100 && posts().length < 6; i++) await sleep(20);
        assert.deepEqual(posts(), [
            'post /key {"usages":[225]}',
            'post /key {"usages":[225,11]}',
            'post /key {"usages":[225]}',
            'post /key {"usages":[]}',
            'post /touch {"type":"tap","x":1,"y":2}',
            'post /key {"usages":[12]}',
        ]);
        socket.close(1000, 'bye');
        await tick();
        runner.release();
    });
});

test('browser side: the receiver decodes both message kinds and reconnects until stopped', async () => {
    global.location = new URL('http://localhost:8000/');
    global.atob = (value) => Buffer.from(value, 'base64').toString('binary');
    const sockets = [];
    class MockWebSocket {
        static OPEN = 1;
        static CONNECTING = 0;
        static CLOSED = 3;
        OPEN = 1;
        CONNECTING = 0;
        CLOSED = 3;
        readyState = 0;
        sent = [];
        constructor(url) {
            this.url = url;
            sockets.push(this);
        }
        addEventListener(name, listener) {
            this[`on_${name}`] = listener;
        }
        send(data) {
            this.sent.push(data);
        }
        close() {
            this.readyState = 3;
            this.on_close?.({});
        }
    }
    global.WebSocket = MockWebSocket;
    const timers = [];
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
    };
    try {
        const { CoreDeviceReceiver } = require('../src/app/applDevice/client/CoreDeviceReceiver');
        const receiver = new CoreDeviceReceiver({ action: 'proxy-coredevice', udid: 'iphone-d' });
        assert.equal(sockets.length, 1);
        assert(sockets[0].url.includes('action=proxy-coredevice') && sockets[0].url.includes('udid=iphone-d'));
        const events = [];
        for (const name of ['connected', 'disconnected', 'status', 'codec', 'video', 'clipboard', 'result']) {
            receiver.on(name, (data) => events.push([name, data]));
        }
        sockets[0].readyState = 1;
        sockets[0].on_open();
        sockets[0].on_message({ data: JSON.stringify({ type: 'status', state: 'ready' }) });
        sockets[0].on_message({
            data: JSON.stringify({ type: 'codec', codec: 'hev1', description: Buffer.from([9, 8]).toString('base64') }),
        });
        sockets[0].on_message({ data: new Uint8Array([0, 1, 2]).buffer });
        sockets[0].on_message({ data: JSON.stringify({ type: 'clipboard', text: 'x' }) });
        sockets[0].on_message({ data: 'garbage' });
        assert.deepEqual(
            events.map((e) => e[0]),
            ['connected', 'status', 'codec', 'video', 'clipboard'],
        );
        assert.deepEqual(Array.from(events[2][1].description), [9, 8]);
        assert.deepEqual(Array.from(events[3][1]), [0, 1, 2]);
        assert.equal(receiver.isReady(), true);
        assert.equal(receiver.send({ type: 'pli' }), true);
        assert.equal(JSON.parse(sockets[0].sent[0]).type, 'pli');
        sockets[0].close();
        assert.equal(events[events.length - 1][0], 'disconnected');
        assert.equal(timers.length, 1, 'a close schedules one reconnect');
        timers[0].callback();
        assert.equal(sockets.length, 2, 'the reconnect opens a fresh socket');
        receiver.stop();
        sockets[1].close();
        assert.equal(timers.length, 1, 'no reconnect after stop()');
    } finally {
        global.setTimeout = realSetTimeout;
    }
});


// Static assets pulled in by the client modules (icons, touch-point images) are not code.
for (const ext of ['.svg', '.png', '.css']) {
    require.extensions[ext] = (module) => {
        module.exports = '';
    };
}

/** The browser globals the client modules touch when constructed in Node. Idempotent. */
function installBrowserMocks() {
    if (global.__browserMocks) {
        return global.__browserMocks;
    }
    class MockDecoder {
        state = 'unconfigured';
        chunks = [];
        constructor(init) {
            this.init = init;
            MockDecoder.instances.push(this);
        }
        configure(config) {
            this.state = 'configured';
            this.config = config;
        }
        decode(chunk) {
            this.chunks.push(chunk);
        }
        close() {
            this.state = 'closed';
        }
        static instances = [];
        static isConfigSupported = async () => ({ supported: true });
    }
    class MockChunk {
        constructor(init) {
            Object.assign(this, init);
        }
    }
    const element = () => ({
        getContext: () => ({ drawImage() {} }),
        classList: { add() {} },
        style: {},
        listeners: {},
        setAttribute() {},
        removeAttribute() {},
        addEventListener(name, fn) {
            this.listeners[name] = fn;
        },
        removeEventListener() {},
        appendChild() {},
        remove() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        play: async () => {},
        toDataURL: () => 'data:,',
    });
    global.VideoDecoder = MockDecoder;
    global.EncodedVideoChunk = MockChunk;
    global.requestAnimationFrame = () => 1;
    global.cancelAnimationFrame = () => {};
    global.document = {
        createElement: element,
        body: { addEventListener() {}, removeEventListener() {}, clientWidth: 1000, clientHeight: 800 },
    };
    global.window = global;
    global.localStorage = { getItem: () => null, setItem() {} };
    global.navigator = { userAgent: 'node', platform: 'Linux' };
    global.Image = class {
        set src(_) {
            /* never loads */
        }
    };
    global.URL.createObjectURL = () => 'blob:mock';
    global.URL.revokeObjectURL = () => {};
    global.performance = global.performance || { now: () => Date.now() };
    global.__browserMocks = { MockDecoder, element };
    return global.__browserMocks;
}

// hvcC record from the bench iPhone 13 Pro Max (iOS 27.0): hev1.1.6.L150.B0, 1296x2816.
const REAL_HVCC = Buffer.from('AQFgAAAAsAAAAAAAlvAA/P34+AAACwMgAAEAGEABHAH//wFgAAADALAAAAMAAAMAlgzAkCEAAQA/QgERAWAAAAMAsAAAAwAAAwCWSACiIALAWIDO5FIYufxPwv6G/UP+qCP1UE/qqCv1VQX+qqgz9VVSm4EBAQBAIgABAAhEAUgHLwWyQA==', 'base64');

function parseBoxes(bytes, offset = 0, end = bytes.length) {
    const boxes = [];
    while (offset + 8 <= end) {
        const size = bytes.readUInt32BE(offset);
        const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
        const box = { type, size, start: offset };
        if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'dinf'].includes(type)) {
            box.children = parseBoxes(bytes, offset + 8, offset + size);
        } else if (type === 'stsd') {
            box.children = parseBoxes(bytes, offset + 16, offset + size);
        } else if (type === 'hev1' || type === 'hvc1') {
            box.children = parseBoxes(bytes, offset + 8 + 78, offset + size);
        }
        boxes.push(box);
        offset += size;
    }
    return boxes;
}
const find = (boxes, path) => path.split('/').reduce((list, type) => (list.find((b) => b.type === type) || {}).children || [], boxes);

test('fMP4 remux: the init segment wraps the hvcC verbatim and the SPS size is read out of it', () => {
    const { buildHevcInitSegment, parseHevcSpsSize, hevcMimeCandidates, hvccNalus } = require('../src/app/player/hevcFmp4');
    assert.deepEqual(parseHevcSpsSize(new Uint8Array(REAL_HVCC)), { width: 1296, height: 2816 });
    assert.deepEqual(hvccNalus(new Uint8Array(REAL_HVCC)).map((n) => n.type), [32, 33, 34], 'VPS, SPS, PPS');
    const init = Buffer.from(buildHevcInitSegment({ sampleEntry: 'hev1', hvcC: new Uint8Array(REAL_HVCC), width: 1296, height: 2816 }));
    const top = parseBoxes(init);
    assert.deepEqual(top.map((b) => b.type), ['ftyp', 'moov']);
    assert.deepEqual(find(top, 'moov').map((b) => b.type), ['mvhd', 'trak', 'mvex']);
    assert.deepEqual(find(top, 'moov/trak/mdia/minf/stbl').map((b) => b.type), ['stsd', 'stts', 'stsc', 'stsz', 'stco']);
    const entry = find(top, 'moov/trak/mdia/minf/stbl/stsd')[0];
    assert.equal(entry.type, 'hev1');
    const hvcC = entry.children[0];
    assert.equal(hvcC.type, 'hvcC');
    assert.deepEqual(init.subarray(hvcC.start + 8, hvcC.start + hvcC.size), REAL_HVCC, 'the decoder record is passed through untouched');
    // Sample entry width/height sit 24 bytes into the visual sample entry body.
    assert.equal(init.readUInt16BE(entry.start + 8 + 24), 1296);
    assert.equal(init.readUInt16BE(entry.start + 8 + 26), 2816);
    assert.equal(find(top, 'moov/mvex')[0].type, 'trex');
    assert.deepEqual(
        hevcMimeCandidates('hev1.1.6.L150.B0').map((c) => c.mime),
        ['video/mp4; codecs="hev1.1.6.L150.B0"', 'video/mp4; codecs="hvc1.1.6.L150.B0"'],
    );
    assert.equal(parseHevcSpsSize(new Uint8Array([1, 2, 3])), undefined);
});

test('fMP4 remux: each access unit becomes one moof+mdat with the right sample flags and data offset', () => {
    const { buildHevcMediaSegment } = require('../src/app/player/hevcFmp4');
    const au = new Uint8Array([0, 0, 0, 3, 0x26, 0x01, 0xaa, 0, 0, 0, 2, 0x02, 0x01]);
    for (const isKeyFrame of [true, false]) {
        const seg = Buffer.from(buildHevcMediaSegment({ accessUnit: au, sequenceNumber: 7, decodeTime: 123456, duration: 50000, isKeyFrame }));
        const top = parseBoxes(seg);
        assert.deepEqual(top.map((b) => b.type), ['moof', 'mdat']);
        const [mfhd, traf] = find(top, 'moof');
        assert.equal(seg.readUInt32BE(mfhd.start + 12), 7, 'sequence number');
        const [tfhd, tfdt, trun] = traf.children.length ? traf.children : find(top, 'moof/traf');
        assert.equal(tfhd.type, 'tfhd');
        assert.equal(seg.readUInt32BE(tfhd.start + 8) & 0xffffff, 0x020000, 'default-base-is-moof');
        assert.equal(tfdt.type, 'tfdt');
        assert.equal(Number(seg.readBigUInt64BE(tfdt.start + 12)), 123456);
        assert.equal(trun.type, 'trun');
        assert.equal(seg.readUInt32BE(trun.start + 12), 1, 'one sample');
        const dataOffset = seg.readUInt32BE(trun.start + 16);
        assert.equal(dataOffset, top[0].size + 8, 'data offset lands on the first mdat payload byte');
        assert.deepEqual(seg.subarray(dataOffset, dataOffset + au.length), Buffer.from(au));
        assert.equal(seg.readUInt32BE(trun.start + 20), 50000, 'duration');
        assert.equal(seg.readUInt32BE(trun.start + 24), au.length, 'size');
        assert.equal(seg.readUInt32BE(trun.start + 28), isKeyFrame ? 0x02000000 : 0x01010000, 'sync / non-sync flags');
    }
});

test('browser side: the MSE player feeds init + key frames through a SourceBuffer and re-inits on reset keys', () => {
    const buffers = [];
    class MockSourceBuffer {
        updating = false; appended = []; listeners = {}; mode = 'segments';
        addEventListener(name, fn) { this.listeners[name] = fn; }
        removeEventListener() {}
        appendBuffer(data) { this.appended.push(Buffer.from(data)); this.updating = true; }
        finish() { this.updating = false; this.listeners.updateend?.(); }
        remove() {}
    }
    class MockMediaSource {
        static isTypeSupported = (mime) => mime.includes('hvc1'); // a browser that only admits hvc1
        readyState = 'closed'; listeners = {};
        addEventListener(name, fn) { this.listeners[name] = fn; }
        removeEventListener() {}
        addSourceBuffer(mime) { this.mime = mime; const sb = new MockSourceBuffer(); buffers.push(sb); return sb; }
        endOfStream() { this.readyState = 'ended'; }
        open() { this.readyState = 'open'; this.listeners.sourceopen?.(); }
    }
    const { element } = installBrowserMocks();
    const sources = [];
    global.MediaSource = class extends MockMediaSource { constructor() { super(); sources.push(this); } };
    global.MediaSource.isTypeSupported = MockMediaSource.isTypeSupported;
    const video = Object.assign(element(), { buffered: { length: 0 }, currentTime: 0, paused: true, videoWidth: 0, videoHeight: 0 });
    const realCreate = global.document.createElement;
    global.document.createElement = (tag) => (tag === 'video' ? video : realCreate(tag));
    global.setInterval = () => 1; global.clearInterval = () => {};
    try {
        const { MseHevcPlayer } = require('../src/app/player/MseHevcPlayer');
        assert.deepEqual(MseHevcPlayer.mimeFor('hev1.1.6.L150.B0'), { mime: 'video/mp4; codecs="hvc1.1.6.L150.B0"', sampleEntry: 'hvc1' });
        const player = new MseHevcPlayer('iphone-f');
        const sizes = [];
        player.on('input-video-resize', (info) => sizes.push([info.videoSize.width, info.videoSize.height]));
        player.configure('hev1.1.6.L150.B0', new Uint8Array(REAL_HVCC));
        player.play();
        player.pushFrame(new Uint8Array([1, 0, 0, 0, 1, 0xaa])); // delta before any key: dropped, even before sourceopen
        sources[0].open();
        assert.equal(sources[0].mime, 'video/mp4; codecs="hvc1.1.6.L150.B0"', 'the SourceBuffer uses the spelling the browser accepted');
        assert.equal(buffers[0].mode, 'sequence');
        assert.equal(buffers[0].appended.length, 1, 'init segment goes first');
        assert.equal(buffers[0].appended[0].subarray(4, 8).toString('latin1'), 'ftyp');
        assert.ok(buffers[0].appended[0].includes(Buffer.from('hvc1', 'latin1')), 'sample entry matches the accepted mime');
        player.pushFrame(new Uint8Array([1, 0, 0, 0, 1, 0xbb])); // still no key
        player.pushFrame(new Uint8Array([0, 0, 0, 0, 1, 0xcc])); // key: queued while the init append is in flight
        player.pushFrame(new Uint8Array([1, 0, 0, 0, 1, 0xdd])); // delta after the key: queued too
        assert.equal(buffers[0].appended.length, 1, 'nothing is appended while updating');
        buffers[0].finish();
        assert.equal(buffers[0].appended.length, 2, 'queued segments are flushed as one append');
        const flushed = parseBoxes(buffers[0].appended[1]);
        assert.deepEqual(flushed.map((b) => b.type), ['moof', 'mdat', 'moof', 'mdat'], 'key + delta, the pre-key deltas never made it');
        buffers[0].finish();
        player.pushFrame(new Uint8Array([2, 0, 0, 0, 1, 0xee])); // reset key: init segment again, then the frame
        assert.deepEqual(parseBoxes(buffers[0].appended[2]).map((b) => b.type), ['ftyp', 'moov'], 'a fresh init segment goes out first');
        buffers[0].finish();
        assert.deepEqual(parseBoxes(buffers[0].appended[3]).map((b) => b.type), ['moof', 'mdat'], 'then the reset key frame');
        const resetSegment = buffers[0].appended[3];
        const resetTrun = find(parseBoxes(resetSegment), 'moof/traf').find((b) => b.type === 'trun');
        assert.equal(resetSegment.readUInt32BE(resetTrun.start + 28), 0x02000000, 'as a sync sample');
        video.videoWidth = 1296; video.videoHeight = 2816; video.listeners.resize();
        video.listeners.resize();
        assert.deepEqual(sizes, [[1296, 2816]], 'ScreenInfo follows the decoded picture once per size change');
        assert.deepEqual([player.getScreenInfo().videoSize.width, player.getScreenInfo().videoSize.height], [1296, 2816]);
        player.stop();
    } finally {
        global.document.createElement = realCreate;
    }
});

test('browser side: decoder selection prefers WebCodecs, falls back to MSE, and honours the override', async () => {
    installBrowserMocks();
    global.MediaSource = global.MediaSource || class {};
    const { StreamClientCoreDevice } = require('../src/app/applDevice/client/StreamClientCoreDevice');
    const desc = new Uint8Array(REAL_HVCC);
    global.VideoDecoder.isConfigSupported = async () => ({ supported: true });
    global.MediaSource.isTypeSupported = () => true;
    assert.equal(await StreamClientCoreDevice.chooseDecoder('hev1.1.6.L150.B0', desc), 'hevc');
    assert.equal(await StreamClientCoreDevice.chooseDecoder('hev1.1.6.L150.B0', desc, 'mse'), 'mse');
    global.VideoDecoder.isConfigSupported = async () => ({ supported: false });
    assert.equal(await StreamClientCoreDevice.chooseDecoder('hev1.1.6.L150.B0', desc), 'mse', 'no WebCodecs HEVC -> MSE');
    global.MediaSource.isTypeSupported = () => false;
    assert.equal(await StreamClientCoreDevice.chooseDecoder('hev1.1.6.L150.B0', desc), undefined);
    const saved = global.VideoDecoder;
    delete global.VideoDecoder; // plain-http Chrome: no WebCodecs at all
    global.window.isSecureContext = false;
    global.MediaSource.isTypeSupported = () => true;
    assert.equal(await StreamClientCoreDevice.chooseDecoder('hev1.1.6.L150.B0', desc), 'mse');
    global.MediaSource.isTypeSupported = () => false;
    assert.match(StreamClientCoreDevice.explainNoDecoder('hev1.1.6.L150.B0'), /https:\/\//, 'the plain-http case points at the https listener');
    global.VideoDecoder = saved;
});

test('browser side: a mouse button released outside the canvas still ends the touch', () => {
    installBrowserMocks();
    const windowListeners = {};
    global.window.addEventListener = (name, fn) => { windowListeners[name] = fn; };
    global.window.removeEventListener = (name) => { delete windowListeners[name]; };
    global.TouchEvent = undefined;
    const canvas = { getContext: () => ({}), addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: 324, clientHeight: 704 };
    const ScreenInfo = require('../src/app/ScreenInfo').default;
    const Rect = require('../src/app/Rect').default;
    const Size = require('../src/app/Size').default;
    const player = { getTouchableElement: () => canvas, getScreenInfo: () => new ScreenInfo(new Rect(0, 0, 1296, 2816), new Size(1296, 2816), 0) };
    const sent = [];
    const target = { sendTouch: (op, x, y) => sent.push([op, x, y]) };
    const { CoreDeviceInteractionHandler } = require('../src/app/applDevice/CoreDeviceInteractionHandler');
    // Moves are coalesced per animation frame; flush explicitly like the browser would between events.
    const rafQueue = [];
    global.requestAnimationFrame = (fn) => rafQueue.push(fn);
    global.cancelAnimationFrame = () => rafQueue.splice(0);
    const frame = () => rafQueue.splice(0).forEach((fn) => fn());
    const handler = new CoreDeviceInteractionHandler(player, target);
    class MockMouseEvent { constructor(type, x, y, button = 0) { Object.assign(this, { type, clientX: x, clientY: y, button, target: canvas, preventDefault() {} }); } }
    global.MouseEvent = MockMouseEvent;
    handler.onInteraction(new MockMouseEvent('mousedown', 162, 352));
    frame();
    assert.deepEqual(sent, [['contact', 648, 1408]]);
    assert.ok(windowListeners.mousemove && windowListeners.mouseup, 'a held button is followed on window, not just on the canvas');
    windowListeners.mousemove(new MockMouseEvent('mousemove', 900, 352)); // far right of the canvas
    frame();
    assert.deepEqual(sent[1], ['contact', 1296, 1408], 'off-canvas moves ride the picture edge');
    windowListeners.mouseup(new MockMouseEvent('mouseup', 900, 900)); // released outside
    assert.deepEqual(sent[2], ['release', 1296, 2816]);
    assert.ok(!windowListeners.mousemove && !windowListeners.mouseup, 'window listeners are removed after the release');
    // Coming back over the canvas with the button up must not resume the contact.
    handler.onInteraction(new MockMouseEvent('mousemove', 100, 100));
    frame();
    assert.equal(sent.length, 3, 'a plain move after the release sends nothing');
    handler.release();
});

test('browser side: the HEVC player gates deltas on a key frame and rebuilds on a reset key', () => {
    const { MockDecoder } = installBrowserMocks();
    MockDecoder.isConfigSupported = async () => ({ supported: true });
    const decoders = MockDecoder.instances;
    decoders.length = 0;
    const { WebCodecsHevcPlayer } = require('../src/app/player/WebCodecsHevcPlayer');
    const player = new WebCodecsHevcPlayer('iphone-e');
    player.configure('hev1', new Uint8Array([1]));
    player.play();
    player.pushFrame(new Uint8Array([1, 0xaa]));
    assert.equal(decoders[0].chunks.length, 0, 'a delta before any key frame is dropped');
    player.pushFrame(new Uint8Array([0, 0xbb]));
    player.pushFrame(new Uint8Array([1, 0xcc]));
    assert.deepEqual(
        decoders[0].chunks.map((c) => c.type),
        ['key', 'delta'],
    );
    player.pushFrame(new Uint8Array([2, 0xdd]));
    assert.equal(decoders.length, 2, 'a reset key frame rebuilds the decoder');
    assert.deepEqual(
        decoders[1].chunks.map((c) => c.type),
        ['key'],
    );
    assert.equal(decoders[0].state, 'closed');
    player.stop();
    assert.equal(decoders[1].state, 'closed');
});

// ---------------------------------------------------------------- screen / lock state (iOS)

test('the state monitor reads the screen from the backlight and the lock from the accessibility captions', () => {
    const backlight = (value) => ({ IOClass: 'AppleARMBacklight', IODisplayParameters: { brightness: { value } } });
    assert.equal(DeviceStateMonitor.screenPowerFromBacklight(backlight(1)), 'on');
    assert.equal(DeviceStateMonitor.screenPowerFromBacklight(backlight(0)), 'off');
    assert.equal(DeviceStateMonitor.screenPowerFromBacklight([{ IOClass: 'Other' }, backlight(4000)]), 'on');
    assert.equal(DeviceStateMonitor.screenPowerFromBacklight({ IOClass: 'AppleARMBacklight' }), 'unknown');
    assert.equal(DeviceStateMonitor.screenPowerFromBacklight(null), 'unknown');

    const items = (...captions) => captions.map((caption) => ({ caption, spoken_description: caption }));
    assert.equal(DeviceStateMonitor.lockedFromAccessibilityItems(items('1:38 AM', 'Locked', 'Camera, Button')), true);
    assert.equal(DeviceStateMonitor.lockedFromAccessibilityItems(items('Enter Passcode', '1', 'Cancel')), true);
    assert.equal(
        DeviceStateMonitor.lockedFromAccessibilityItems(items('1:38 AM', 'Unlocked', 'Camera, Button')),
        false,
        'Face ID has recognised the owner: swiping up needs no passcode',
    );
    assert.equal(DeviceStateMonitor.lockedFromAccessibilityItems(items('Safari', 'Messages'), 'en-GB'), false);
    assert.equal(DeviceStateMonitor.lockedFromAccessibilityItems(items('Safari', 'Messages'), undefined), false);
    assert.equal(
        DeviceStateMonitor.lockedFromAccessibilityItems(items('1:38', 'Gesperrt', 'Kamera, Taste'), 'de-DE'),
        'unknown',
        'a lock screen in a language the table does not know must not read as unlocked',
    );
    assert.equal(DeviceStateMonitor.lockedFromAccessibilityItems([], 'en-US'), 'unknown');
    assert.equal(DeviceStateMonitor.lockedFromAccessibilityItems('nonsense', 'en-US'), 'unknown');
    process.env.IOS_LOCKED_CAPTIONS = 'Gesperrt, Code eingeben';
    try {
        assert.equal(DeviceStateMonitor.lockedFromAccessibilityItems(items('1:38', 'Gesperrt'), 'de-DE'), true);
        assert.equal(
            DeviceStateMonitor.lockedFromAccessibilityItems(items('Safari', 'Nachrichten'), 'de-DE'),
            false,
            'with the localized captions supplied, their absence means unlocked',
        );
    } finally {
        delete process.env.IOS_LOCKED_CAPTIONS;
    }

    assert.equal(
        DeviceStateMonitor.notificationName('{"Command": "RelayNotification", "Name": "com.apple.springboard.lockstate"}'),
        'com.apple.springboard.lockstate',
    );
    assert.equal(DeviceStateMonitor.notificationName('2026-09-16 05:36:00 host pymobiledevice3 INFO connected'), undefined);
    assert.equal(DeviceStateMonitor.notificationName('{"broken'), undefined);
});

test('the state monitor probes on watch, re-probes on SpringBoard notifications and stops with the device', async () => {
    fs.rmSync(logFile, { force: true });
    const monitor = DeviceStateMonitor.getInstance();
    const states = [];
    const onState = (event) => states.push(event);
    monitor.on('state', onState);
    const waitFor = async (predicate, what) => {
        for (let i = 0; i < 200 && !predicate(); i++) await sleep(25);
        assert(predicate(), what);
    };
    try {
        await withEnv(
            { FAKE_LOG: logFile, FAKE_SCREEN: 'off', FAKE_LOCK: 'locked', FAKE_NOTIFY: 'com.apple.springboard.hasBlankedScreen' },
            async () => {
                monitor.watch('iphone-s', { language: 'en-US' });
                assert.deepEqual(monitor.getState('iphone-s'), { 'screen.power': 'unknown', 'device.locked': 'unknown' });
                await waitFor(() => states.length >= 1, 'the first probe reports a state');
                assert.deepEqual(states[0], { udid: 'iphone-s', 'screen.power': 'off', 'device.locked': true });
                const recorded = calls();
                assert(
                    recorded.some((line) => line.includes('"diagnostics","ioregistry","--ioclass","AppleARMBacklight"')),
                    'the screen comes from the backlight IORegistry entry',
                );
                assert(
                    recorded.some((line) => line.includes('"lockstate.py"')),
                    'the lock comes from the silent probe, not the CLI walk that draws a highlight',
                );
                assert(
                    !recorded.some((line) => line.includes('list-items')),
                    'the CLI walk, which leaves the on-device inspector overlay on, is never used',
                );
                assert(
                    recorded.some((line) => line.includes('"notification","observe","com.apple.springboard.hasBlankedScreen"')),
                    'SpringBoard notifications are observed for the device',
                );
                // The fake observer relays hasBlankedScreen 200 ms in; the monitor must read the
                // device again (the notification carries no direction) -- a second backlight read.
                await waitFor(
                    () => calls().filter((line) => line.includes('"diagnostics","ioregistry"')).length >= 2,
                    'a screen notification triggers a fresh probe',
                );
            },
        );
        await withEnv({ FAKE_LOG: logFile, FAKE_SCREEN: 'on', FAKE_LOCK: 'unlocked' }, async () => {
            monitor.refresh('iphone-s');
            await waitFor(
                () => states.some((event) => event['screen.power'] === 'on' && event['device.locked'] === false),
                'an explicit refresh reports the new state',
            );
        });
        await withEnv({ FAKE_LOG: logFile, FAKE_SCREEN: 'on', FAKE_LOCK: 'foreign' }, async () => {
            monitor.watch('iphone-s', { language: 'de-DE' });
            monitor.refresh('iphone-s');
            await waitFor(
                () => states.some((event) => event['device.locked'] === 'unknown' && event['screen.power'] === 'on'),
                'an unrecognised lock screen reads as unknown, never as unlocked',
            );
        });
        const observers = () => calls().filter((line) => line.includes('"notification","observe"')).length;
        const before = observers();
        monitor.unwatch('iphone-s');
        await sleep(300);
        assert.equal(monitor.isWatching('iphone-s'), false);
        assert.equal(observers(), before, 'no observer is respawned after unwatch');
        assert.deepEqual(monitor.getState('iphone-s'), { 'screen.power': 'unknown', 'device.locked': 'unknown' });
    } finally {
        monitor.off('state', onState);
        monitor.unwatch('iphone-s');
    }
});

test('the state monitor can be switched off, and the lock walk on its own', async () => {
    fs.rmSync(logFile, { force: true });
    await withEnv({ FAKE_LOG: logFile, IOS_STATE_PROBE: '0' }, async () => {
        const monitor = DeviceStateMonitor.getInstance();
        monitor.watch('iphone-off');
        await sleep(150);
        assert.equal(monitor.isWatching('iphone-off'), false);
        assert.equal(calls().length, 0, 'nothing is spawned when the probe is disabled');
    });
    await withEnv({ FAKE_LOG: logFile, IOS_LOCK_PROBE: '0', IOS_STATE_NOTIFICATIONS: '0', FAKE_SCREEN: 'on' }, async () => {
        const monitor = DeviceStateMonitor.getInstance();
        const states = [];
        const onState = (event) => states.push(event);
        monitor.on('state', onState);
        try {
            monitor.watch('iphone-screen-only');
            for (let i = 0; i < 200 && states.length === 0; i++) await sleep(25);
            assert.deepEqual(states[0], { udid: 'iphone-screen-only', 'screen.power': 'on', 'device.locked': 'unknown' });
            assert(!calls().some((line) => line.includes('lockstate')), 'the lock probe is skipped');
            assert(!calls().some((line) => line.includes('"notification","observe"')), 'no observer process');
        } finally {
            monitor.off('state', onState);
            monitor.unwatch('iphone-screen-only');
        }
    });
});

// ---------------------------------------------------------- Home / Lock button hold (iOS)

test('Home and Lock are sent as a held down/up pair, because serve-web\'s own press is too short', async () => {
    fs.rmSync(logFile, { force: true });
    await withEnv({ FAKE_LOG: logFile }, async () => {
        const runner = CoreDeviceRunner.getInstance();
        const socket = new FakeSocket();
        const proxy = CoreDeviceProxy.processRequest(socket, {
            action: 'proxy-coredevice',
            url: new URL('ws://localhost/?action=proxy-coredevice&udid=iphone-buttons'),
        });
        assert(proxy);
        for (let i = 0; i < 100 && socket.binaries().length < 1; i++) await sleep(20);

        // A 50 ms Home (serve-web's `press`) does nothing at all on a Face ID phone: measured on an
        // iPhone 13 Pro Max, it fails at 50 ms and works from 100 ms, so the proxy holds it itself.
        socket.message(JSON.stringify({ type: 'button', name: 'home' }));
        for (let i = 0; i < 200 && calls().filter((line) => line.includes('"home"')).length < 2; i++) await sleep(20);
        assert.deepEqual(
            calls().filter((line) => line.includes('"home"')),
            ['post /button {"name":"home","state":"down"}', 'post /button {"name":"home","state":"up"}'],
            'Home is a down/up pair, never a bare press',
        );

        fs.rmSync(logFile, { force: true });
        socket.message(JSON.stringify({ type: 'button', name: 'lock' }));
        for (let i = 0; i < 200 && calls().filter((line) => line.includes('"lock"')).length < 2; i++) await sleep(20);
        assert.deepEqual(
            calls().filter((line) => line.includes('"lock"')),
            ['post /button {"name":"lock","state":"down"}', 'post /button {"name":"lock","state":"up"}'],
            'and so is Lock, whose own press is long enough to start Siri instead',
        );

        // A button the phone accepts as a plain tap still goes straight through.
        fs.rmSync(logFile, { force: true });
        socket.message(JSON.stringify({ type: 'button', name: 'volume-up' }));
        for (let i = 0; i < 100 && !calls().some((line) => line.includes('"volume-up"')); i++) await sleep(20);
        assert.deepEqual(calls().filter((line) => line.startsWith('post ')), [
            'post /button {"name":"volume-up","state":"press"}',
        ]);

        // The app switcher was removed: iOS gives no way to open it on a Face ID phone from here,
        // and the pseudo button must not survive as something that silently does nothing.
        fs.rmSync(logFile, { force: true });
        socket.message(JSON.stringify({ type: 'button', name: 'app-switcher' }));
        await sleep(200);
        assert.deepEqual(calls().filter((line) => line.startsWith('post ')), [], 'an unknown button is dropped');

        socket.close(1000, 'bye');
        await tick();
        runner.release();
    });
});

test('the lock state is never polled while the phone is awake and unlocked', async () => {
    fs.rmSync(logFile, { force: true });
    const monitor = DeviceStateMonitor.getInstance();
    const states = [];
    const onState = (event) => states.push(event);
    monitor.on('state', onState);
    const lockProbes = () => calls().filter((line) => line.includes('"lockstate.py"')).length;
    const waitFor = async (predicate, what) => {
        for (let i = 0; i < 200 && !predicate(); i++) await sleep(25);
        assert(predicate(), what);
    };
    try {
        await withEnv(
            { FAKE_LOG: logFile, FAKE_SCREEN: 'on', FAKE_LOCK: 'unlocked', IOS_STATE_NOTIFICATIONS: '0' },
            async () => {
                monitor.watch('iphone-awake', { language: 'en-US' });
                await waitFor(() => states.length >= 1, 'the first probe reports a state');
                assert.deepEqual(states[0], { udid: 'iphone-awake', 'screen.power': 'on', 'device.locked': false });
                const after = lockProbes();
                assert.equal(after, 1, 'exactly one lock probe on watch');

                // Someone opens the stream and taps around an unlocked phone. The screen keeps
                // being polled; the lock must not be, or the accessibility daemon is driven over
                // the app they are using (which is what drew a highlight box on every poll).
                monitor.setSessionActive('iphone-awake', true);
                for (let i = 0; i < 6; i++) {
                    monitor.pokeInput('iphone-awake');
                    monitor.pokeButton('iphone-awake');
                    await sleep(120);
                }
                await waitFor(
                    () => calls().filter((line) => line.includes('"diagnostics","ioregistry"')).length >= 2,
                    'the screen is still polled while a session is active',
                );
                await sleep(2500);
                assert.equal(lockProbes(), after, 'no further lock probe while awake and unlocked');

                // Asking explicitly still works -- that is the Unlock button and GET_LOCK_STATE.
                monitor.refresh('iphone-awake');
                await waitFor(() => lockProbes() === after + 1, 'an explicit refresh probes the lock');
            },
        );
        // Once the phone locks or goes dark, input is worth following again (a passcode may be
        // getting typed through the stream).
        await withEnv({ FAKE_LOG: logFile, FAKE_SCREEN: 'off', FAKE_LOCK: 'locked' }, async () => {
            monitor.refresh('iphone-awake');
            await waitFor(
                () => states.some((event) => event['screen.power'] === 'off' && event['device.locked'] === true),
                'the dark, locked state is reported',
            );
            const before = lockProbes();
            monitor.pokeInput('iphone-awake');
            await waitFor(() => lockProbes() > before, 'input on a locked phone re-reads the lock');
        });
    } finally {
        monitor.off('state', onState);
        monitor.unwatch('iphone-awake');
    }
});

test('a lock probe that fails leaves the screen state alone and reports the lock as unknown', async () => {
    fs.rmSync(logFile, { force: true });
    const monitor = DeviceStateMonitor.getInstance();
    const states = [];
    const onState = (event) => states.push(event);
    monitor.on('state', onState);
    try {
        await withEnv(
            {
                FAKE_LOG: logFile,
                FAKE_SCREEN: 'on',
                FAKE_LOCK_FAIL: 'the accessibility daemon did not answer',
                IOS_STATE_NOTIFICATIONS: '0',
            },
            async () => {
                monitor.watch('iphone-broken-lock', { language: 'en-US' });
                for (let i = 0; i < 200 && states.length === 0; i++) await sleep(25);
                assert.deepEqual(states[0], {
                    udid: 'iphone-broken-lock',
                    'screen.power': 'on',
                    'device.locked': 'unknown',
                });
            },
        );
    } finally {
        monitor.off('state', onState);
        monitor.unwatch('iphone-broken-lock');
    }
});
