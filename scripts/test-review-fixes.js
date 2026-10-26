// Regression coverage for the full repository review. Hardware and push providers are isolated.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const express = require('express');
const WS = require('ws');
const portfinder = require('portfinder');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-review-fixes-'));
process.env.WS_NOTIFICATION_DATA = temporary;
process.env.WS_SCRCPY_STREAM_CONFIG_PATH = path.join(temporary, 'streams.json');
global.__PATHNAME__ = '/';
require('ts-node').register({ transpileOnly: true });
require.extensions['.jar'] = () => {};
require.cache[require.resolve('../vendor/Genymobile/scrcpy/LICENSE')] = { exports: {} };
const { AccessControl } = require('../src/server/AccessControl');
const { NotificationService } = require('../src/server/notifications/NotificationService');
const { WebSocketServer } = require('../src/server/services/WebSocketServer');
const { startServices } = require('../src/server/services/startServices');
const { sendFileDownload } = require('../src/server/goog-device/filePush/FileDownload');
const { AdbUtils } = require('../src/server/goog-device/AdbUtils');
const { CoreDeviceRunner } = require('../src/server/appl-device/services/CoreDeviceRunner');
const { CoreDeviceProxy } = require('../src/server/appl-device/mw/CoreDeviceProxy');
const { RemoteWebsocketProxy } = require('../src/server/mw/RemoteWebsocketProxy');
const { Config } = require('../src/server/Config');
const { Multiplexer } = require('../src/packages/multiplexer/Multiplexer');
const tick = () => new Promise(resolve => setImmediate(resolve));
after(() => { CoreDeviceRunner.getInstance().release(); NotificationService.getInstance().release(); fs.rmSync(temporary, { recursive: true, force: true }); });
class Socket extends EventEmitter {
    OPEN = 1; CLOSED = 3; readyState = 1; bufferedAmount = 0; sent = [];
    addEventListener(name, cb) { this.on(name, cb); }
    removeEventListener(name, cb) { this.off(name, cb); }
    send(data) { assert.equal(this.readyState, 1, 'never send after close'); this.sent.push(data); }
    close() { this.readyState = 3; this.emit('close', {}); }
}
function pull() { const stream = new PassThrough(); stream.cancelled = 0; stream.cancel = () => stream.cancelled++; return stream; }

test('HTTP sign-in remembers LAN access; WS upgrades require the same session and origin', async () => {
    const service = NotificationService.getInstance();
    const app = express();
    service.access.mount(app, '/'); service.mount(app, '/');
    app.get('/private', service.access.requireAccess, (_req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    const wss = WebSocketServer.getInstance().attachToServer({ server, port: 0 });
    WebSocketServer.getInstance().registerMw({ processRequest(socket) { socket.send('connected'); return {}; } });
    server.listen(0, '0.0.0.0'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const key = service.store.token;
    async function upgrade(headers) {
        return new Promise((resolve, reject) => {
            const socket = new WS(base.replace('http:', 'ws:'), { headers });
            socket.on('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode); });
            socket.on('message', data => { socket.close(); resolve(data.toString()); });
            socket.on('error', () => {});
            setTimeout(() => { if (socket.readyState === WS.CONNECTING) { socket.terminate(); reject(Error('upgrade timed out')); } }, 1000).unref();
        });
    }
    try {
        assert.equal((await fetch(`${base}/private`)).status, 401);
        assert.equal(await upgrade({ Origin: base }), 401);
        const response = await fetch(`${base}/api/access`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
        assert.equal(response.status, 200);
        const raw = response.headers.get('set-cookie');
        assert.match(raw, /HttpOnly/); assert.match(raw, /SameSite=Strict/); assert.doesNotMatch(raw, /Secure/);
        const cookie = raw.split(';')[0];
        assert.equal((await fetch(`${base}/private`, { headers: { Cookie: cookie, Origin: base } })).status, 200);
        assert.equal(await upgrade({ Cookie: cookie, Origin: base }), 'connected');
        assert.equal(await upgrade({ Authorization: `Bearer ${key}` }), 'connected');
        assert.equal(await upgrade({ Cookie: cookie, Origin: 'https://attacker.example' }), 403);
        assert.equal(await upgrade({ Cookie: cookie + 'tampered', Origin: base }), 401);
        assert.equal((await fetch(`${base}/api/notifications/history/read`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: 'malformed gzip' })).status, 401);
        assert.equal((await fetch(`${base}/api/access`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: 'malformed gzip' })).status, 415);
        assert.equal((await fetch(`${base}/api/access`)).status, 200, 'malformed bodies do not crash the server');
    } finally { for (const client of wss.clients) client.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('LAN origin follows the requested host; Tailscale identity is accepted only from the local proxy', () => {
    const access = new AccessControl('key', 'https://host.example');
    const request = { headers: { host: '192.168.1.12:8000', origin: 'http://192.168.1.12:8000', authorization: 'Bearer key' }, socket: { remoteAddress: '192.168.1.8' } };
    assert.equal(access.authorized(request), true);
    delete request.headers.authorization;
    request.headers['tailscale-user-login'] = 'owner@example.com';
    assert.equal(access.authorized(request), false);
    request.socket.remoteAddress = '127.0.0.1'; request.headers.origin = 'https://host.example';
    assert.equal(access.authorized(request), true);
    request.headers.origin = 'https://attacker.example'; assert.equal(access.authorized(request), false);
});

test('download cancellation covers opening, late data/error, and backpressure', async () => {
    const channel = new Socket(); let open;
    const work = sendFileDownload(() => new Promise(resolve => open = resolve), channel);
    channel.close(); const stream = pull(); open(stream); await work;
    assert.equal(stream.cancelled, 1); assert.equal(stream.destroyed, true);
    stream.emit('error', Error('late adb error')); assert.equal(channel.sent.length, 0);
    const slow = new Socket(); slow.bufferedAmount = 2 * 1024 * 1024;
    const active = pull(); const running = sendFileDownload(async () => active, slow);
    active.write(Buffer.alloc(32)); await tick(); active.write(Buffer.alloc(32)); await tick();
    assert.equal(slow.sent.length, 1, 'a blocked channel stops consuming ADB data');
    slow.close(); await running;
    assert.equal(active.cancelled, 1); assert.equal(slow.listenerCount('close'), 0);
});

test('completed downloads send DONE and retain no channel listeners', async () => {
    const channel = new Socket(), stream = pull();
    const running = sendFileDownload(async () => stream, channel);
    stream.end(Buffer.from('hello')); await running;
    assert.deepEqual(channel.sent.map(data => data.toString()), ['DATAhello', 'DONE']);
    assert.equal(stream.cancelled, 0); assert.equal(channel.listenerCount('close'), 0);
});

test('copy and move preserve an existing file, folder, or dangling symlink and report a conflict', async () => {
    const original = AdbUtils.runFileOperation;
    AdbUtils.runFileOperation = async (_serial, command) => execFileSync('/bin/sh', ['-c', command], { stdio: 'pipe' });
    try {
        for (const method of ['move', 'copy']) {
            const from = path.join(temporary, `${method}-source`); fs.writeFileSync(from, 'source');
            for (const kind of ['file', 'directory', 'symlink']) {
                const to = path.join(temporary, `${method}-${kind}`);
                if (kind === 'file') fs.writeFileSync(to, 'destination');
                else if (kind === 'directory') fs.mkdirSync(to);
                else fs.symlinkSync('missing', to);
                await assert.rejects(AdbUtils[method]('fake', from, to));
                assert.equal(fs.readFileSync(from, 'utf8'), 'source');
                if (kind === 'file') assert.equal(fs.readFileSync(to, 'utf8'), 'destination');
                if (kind === 'directory') assert.deepEqual(fs.readdirSync(to), []);
                if (kind === 'symlink') assert.equal(fs.readlinkSync(to), 'missing');
            }
            const to = path.join(temporary, `${method}-success`);
            await AdbUtils[method]('fake', from, to); assert.equal(fs.readFileSync(to, 'utf8'), 'source');
        }
    } finally { AdbUtils.runFileOperation = original; }
});

test('concurrent cold opens reserve one iOS session before choosing its port', async () => {
    const runner = new CoreDeviceRunner(); const original = portfinder.getPortPromise; let selectPort; let starts = 0;
    portfinder.getPortPromise = () => new Promise(resolve => selectPort = resolve);
    runner.bringUp = async () => { starts++; };
    try {
        const first = runner.acquire('same'), second = runner.acquire('same');
        assert.equal(runner.sessions.size, 1); assert.equal(runner.sessions.get('same').holders, 2);
        selectPort(12345); assert.deepEqual(await Promise.all([first, second]), [12345, 12345]); assert.equal(starts, 1);
    } finally { runner.release(); portfinder.getPortPromise = original; }
});

test('malformed iOS JSON is contained and dropped video resumes only on a reset keyframe', async () => {
    const socket = new Socket(), proxy = new CoreDeviceProxy(socket, 'fake');
    for (const value of ['null', '[]', '{}', '"key"', '{', '{"type":"key","usages":null}', '{"type":"touch","x":null}']) {
        assert.doesNotThrow(() => socket.emit('message', { type: 'message', data: value }));
    }
    const stream = new PassThrough(); stream.statusCode = 200;
    const runner = proxy.runner, original = runner.openStream;
    runner.openStream = async () => stream; let plis = 0; proxy.requestKeyframe = () => plis++;
    const frame = type => { const bytes = Buffer.alloc(6); bytes.writeUInt32BE(2); bytes[4] = type; bytes[5] = 42; return bytes; };
    try {
        await proxy.attachStream(); socket.sent.length = 0;
        socket.bufferedAmount = 5 * 1024 * 1024; stream.write(frame(1));
        socket.bufferedAmount = 0; stream.write(frame(1));
        assert.equal(socket.sent.length, 0); assert.ok(plis > 0);
        stream.write(frame(0)); stream.write(frame(1));
        assert.deepEqual(socket.sent.map(data => data[0]), [2, 1]);
    } finally { runner.openStream = original; proxy.released = true; stream.destroy(); }
});

test('startup awaits each service and retains partially started instances for cleanup', async () => {
    const running = [], calls = []; let finish;
    const first = { start: () => { calls.push('first'); return new Promise(resolve => finish = resolve); } };
    const second = { start: async () => { calls.push('second'); throw Error('failed'); } };
    const work = startServices([first, second].map(instance => ({ getInstance: () => instance })), running, () => false);
    await tick(); assert.deepEqual(calls, ['first']); finish(); await assert.rejects(work, /failed/);
    assert.deepEqual(calls, ['first', 'second']); assert.deepEqual(running, [first, second]);
});

test('multiplexed channels expose underlying socket backpressure', () => {
    const socket = new Socket(); const mux = Multiplexer.wrap(socket); socket.bufferedAmount = 123456;
    assert.equal(mux.bufferedAmount, 123456); assert.equal(mux.createChannel().bufferedAmount, 123456); mux.close();
});

test('remote proxy carries text and multiplexed binary messages and only allows configured hosts', async () => {
    const upstream = new WS.Server({ port: 0 }); await once(upstream, 'listening');
    let authorization;
    upstream.on('connection', (socket, request) => { authorization = request.headers.authorization; socket.on('message', (data, binary) => socket.send(data, { binary })); });
    const target = new URL(`ws://127.0.0.1:${upstream.address().port}/`);
    const config = Config.getInstance(); const before = config.fullConfig.remoteHostList;
    config.fullConfig.remoteHostList = [{ hostname: target.hostname, port: Number(target.port), secure: false, pathname: '/', type: 'android', useProxy: true, accessKey: 'remote-key' }];
    const frontend = new WS.Server({ port: 0 }); await once(frontend, 'listening');
    frontend.on('connection', socket => new RemoteWebsocketProxy(socket, target, 'remote-key'));
    const client = new WS(`ws://127.0.0.1:${frontend.address().port}`); client.on('error', () => {});
    try {
        assert.ok(config.getProxyHost(target)); assert.equal(config.getProxyHost(new URL('ws://127.0.0.1:1/')), undefined);
        assert.equal(JSON.stringify(config.getHostList()).includes('remote-key'), false);
        await once(client, 'open');
        client.send('text'); let [data, binary] = await once(client, 'message'); assert.equal(data.toString(), 'text'); assert.equal(binary, false);
        client.send(Buffer.from([0, 255, 42])); [data, binary] = await once(client, 'message'); assert.deepEqual(data, Buffer.from([0, 255, 42])); assert.equal(binary, true);
        assert.equal(authorization, 'Bearer remote-key');
    } finally { config.fullConfig.remoteHostList = before; client.terminate(); for (const server of [frontend, upstream]) { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); } }
});

test('an initial Android tracker failure retries and shutdown cancels further retries', async () => {
    const { ControlCenter } = require('../src/server/goog-device/services/ControlCenter');
    const center = new ControlCenter(); let attempts = 0;
    center.waitAfterError = 5; center.init = async () => { if (++attempts === 1) throw Error('ADB not ready'); };
    await center.start(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(attempts, 2); center.release(); center.restartTracker(); assert.equal(center.restartTimeoutId, undefined);
});

test('Android closes a saturated viewer instead of buffering unbounded video', () => {
    const { WebsocketProxy } = require('../src/server/mw/WebsocketProxy');
    const socket = new Socket(); const proxy = new WebsocketProxy(socket);
    socket.bufferedAmount = 21 * 1024 * 1024;
    assert.equal(proxy.sendPacket(Buffer.from('video')), false); assert.equal(socket.readyState, socket.CLOSED);
    assert.deepEqual(socket.sent, []);
});

test('HTTP downloads stream bytes with attachment headers and cancel ADB when the browser leaves', async () => {
    const { mountFileDownloads } = require('../src/server/goog-device/filePush/HttpDownload');
    const app = express(); mountFileDownloads(app, '/', new AccessControl('key'));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/api/files/download?udid=fake&path=/sdcard/example.txt`;
    const original = AdbUtils.pipePullFile; let stream;
    AdbUtils.pipePullFile = async () => { stream = pull(); process.nextTick(() => stream.write('bytes')); return stream; };
    try {
        assert.equal((await fetch(url)).status, 401);
        const response = await fetch(url, { headers: { Authorization: 'Bearer key' } });
        assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment; filename="example.txt"/);
        const reader = response.body.getReader(); assert.equal(Buffer.from((await reader.read()).value).toString(), 'bytes');
        await reader.cancel(); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(stream.destroyed, true); assert.equal(stream.cancelled, 1);
        const next = await fetch(url, { headers: { Authorization: 'Bearer key' } }); stream.end('done'); assert.equal(await next.text(), 'bytesdone');
    } finally { AdbUtils.pipePullFile = original; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a service completing after shutdown is released again before startup continues', async () => {
    let finish, stopping = false, releases = 0;
    const service = { start: () => new Promise(resolve => finish = resolve), release: () => releases++ };
    const work = startServices([{ getInstance: () => service }], [], () => stopping);
    stopping = true; finish(); await work; assert.equal(releases, 1);
});

test('file download buffers include pending Blob URLs in their memory bound', () => {
    const { FileDownloads } = require('../src/app/googDevice/client/FileDownloads');
    const previous = global.document, links = [];
    global.document = { body: { appendChild() {} }, createElement: () => ({ click() { links.push(this.href); }, remove() {} }) };
    const downloads = new FileDownloads(file => new URL(`https://example.test/api/files/download?path=${encodeURIComponent(file)}`));
    try {
        assert.equal(downloads.start('/one', 2), true); assert.equal(downloads.append('/one', Buffer.from('ok')), 2);
        downloads.finish('/one', 'one');
        assert.equal(downloads.start('/two', 2), true);
        assert.equal(downloads.start('/three', 2), false, 'completed Blob URLs still count toward the bound');
        assert.equal(downloads.start('/large', 17 * 1024 * 1024), false, 'large files stream directly');
        assert.equal(downloads.append('/two', Buffer.alloc(17 * 1024 * 1024)), undefined, 'a growing file switches to native streaming');
        assert.equal(downloads.buffers.size, 0); assert.equal(links.filter(link => link.startsWith('https:')).length, 3);
    } finally { downloads.release(); global.document = previous; }
});

test('ADB pull ownership is returned before bytes arrive and supports an empty file', async () => {
    const { AdbExtended } = require('../src/server/goog-device/adb');
    const original = AdbExtended.createClient, transfer = pull();
    AdbExtended.createClient = () => ({ pull: async () => transfer });
    try {
        const result = await Promise.race([AdbUtils.pipePullFile('fake', '/empty'), new Promise((_, reject) => setTimeout(() => reject(Error('waited for data before returning ownership')), 100))]);
        assert.equal(result, transfer); assert.equal(result.listenerCount('readable'), 0);
        const channel = new Socket(); const work = sendFileDownload(async () => result, channel); transfer.end(); await work;
        assert.deepEqual(channel.sent.map(data => data.toString()), ['DONE']);
    } finally { AdbExtended.createClient = original; transfer.destroy(); }
});

test('trusted LAN access needs no key and never trusts a forwarded client address', () => {
    const access = new AccessControl('key', '', '10.10.10.0/24, fd12:3456::/64');
    const request = address => ({ headers: { host: '10.10.10.5:8000', origin: 'http://10.10.10.5:8000' }, socket: { remoteAddress: address } });
    for (const address of ['10.10.10.1', '10.10.10.254', '::ffff:10.10.10.9', '::ffff:a0a:a09', 'fd12:3456::8']) {
        assert.equal(access.authorized(request(address)), true, address);
    }
    for (const address of ['10.10.9.9', '10.10.11.1', '192.168.1.5', '203.0.113.8', '127.0.0.1', 'fd12:3457::8', '']) {
        const incoming = request(address);
        incoming.headers['x-forwarded-for'] = '10.10.10.8'; incoming.headers.forwarded = 'for=10.10.10.8';
        assert.equal(access.authorized(incoming), false, address);
        incoming.headers.authorization = 'Bearer key'; assert.equal(access.authorized(incoming), true);
    }
    const crossOrigin = request('10.10.10.8'); crossOrigin.headers.origin = 'https://another.example';
    assert.equal(access.authorized(crossOrigin), false);
    const native = request('10.10.10.8'); delete native.headers.origin; assert.equal(access.authorized(native), true);
    assert.equal(new AccessControl('key', '', '').authorized(request('10.10.10.8')), false);
    for (const invalid of ['10.10.10.0', '10.10.10.0/33', '10.10.10.0/-1', 'localhost/24', '::1/129', '10.10.10.0/24/extra']) {
        assert.throws(() => new AccessControl('key', '', invalid), /Invalid trusted network/);
    }
});

test('trusted connections bypass browser sign-in, HTTP API auth and WebSocket auth together', async () => {
    const service = NotificationService.getInstance(), previous = service.accessControl;
    // Use loopback as this test's trusted subnet; deployment trusts only the configured LAN.
    const access = new AccessControl(service.store.token, '', '127.0.0.1/32');
    service.accessControl = access;
    const app = express(); access.mount(app, '/'); service.mount(app, '/');
    const server = http.createServer(app), wss = WebSocketServer.getInstance().attachToServer({ server, port: 0 });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const response = await fetch(`${base}/api/access`);
        assert.deepEqual(await response.json(), { authenticated: true });
        assert.equal(response.headers.get('set-cookie'), null, 'trusted access does not need a session');
        assert.equal((await fetch(`${base}/api/notifications/summary`)).status, 200);
        assert.equal((await fetch(`${base}/api/notifications/summary`, { headers: { Origin: 'https://another.example' } })).status, 403);
        const socket = new WS(base.replace('http:', 'ws:'), { origin: base });
        const [data] = await once(socket, 'message'); assert.equal(data.toString(), 'connected'); socket.close();
    } finally {
        service.accessControl = previous;
        for (const client of wss.clients) client.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
});
