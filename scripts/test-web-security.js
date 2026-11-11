// Run with: node --test scripts/test-web-security.js
// Cross-site and connection checks from the 2026-11-10 review: the Host allowlist, the frame and
// connection headers, the WebSocket heartbeat, and where a stream link may send its socket.
// The HTTP server listens on a free loopback port from a temporary config. No device is used.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WS = require('ws');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-web-security-'));
const configPath = path.join(temporary, 'config.json');
const publicDir = path.join(temporary, 'public');
fs.mkdirSync(publicDir);
fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>fixture</title>');

process.env.WS_NOTIFICATION_DATA = path.join(temporary, 'data');
process.env.WS_NOTIFICATIONS_COLLECTOR = '0';
process.env.WS_SCRCPY_STREAM_CONFIG_PATH = path.join(temporary, 'streams.json');
process.env.WS_PUBLIC_URL = 'https://phone.example';
process.env.WS_ALLOWED_HOSTS = 'From-Env.example, second-env.example';
process.env.WS_SCRCPY_CONFIG = configPath;
// Webpack defines this constant; HttpServer reads it when the module loads.
global.__PATHNAME__ = '/';
// The client modules read the page address.
global.location = new URL('https://app.example:8443/');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A port that was free a moment ago. The config file needs a number before the server starts. */
async function freePort() {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

let started;
/** Starts the real HttpServer and WebSocketServer once, on a loopback port of their own. */
function startServer() {
    if (!started) {
        started = (async () => {
            const port = await freePort();
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    server: [{ secure: false, port }],
                    allowedHosts: ['Configured.Example'],
                    remoteHostList: [
                        { type: 'android', secure: true, hostname: 'direct.example', port: 8443 },
                        { type: 'android', secure: true, hostname: 'proxied.example', port: 8443, useProxy: true },
                    ],
                }),
            );
            require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
            // Webpack treats these imports as assets. Node only needs the surrounding classes.
            require.extensions['.jar'] = () => {};
            require.cache[require.resolve('../vendor/Genymobile/scrcpy/LICENSE')] = { exports: {} };
            const { Config } = require('../src/server/Config');
            assert.equal(Config.getInstance().servers[0].port, port, 'the temporary config is the one in use');
            const { HttpServer } = require('../src/server/services/HttpServer');
            const { WebSocketServer } = require('../src/server/services/WebSocketServer');
            const { NotificationService } = require('../src/server/notifications/NotificationService');
            HttpServer.setPublicDir(publicDir);
            WebSocketServer.heartbeatMs = 40;
            const httpServer = HttpServer.getInstance();
            await httpServer.start();
            const sockets = WebSocketServer.getInstance();
            const accepted = [];
            sockets.registerMw({
                processRequest(ws, params) {
                    if (params.action !== 'hold') return undefined;
                    accepted.push(ws);
                    ws.send('connected');
                    return {};
                },
            });
            await sockets.start();
            return { port, httpServer, sockets, accepted, NotificationService };
        })();
    }
    return started;
}

after(async () => {
    if (started) {
        const { httpServer, sockets, NotificationService } = await started;
        for (const server of sockets.getServers()) for (const client of server.clients) client.terminate();
        sockets.release();
        for (const { server } of await httpServer.getServers()) server.closeAllConnections();
        httpServer.release();
        NotificationService.getInstance().release();
    }
    fs.rmSync(temporary, { recursive: true, force: true });
});

/** One GET with a chosen Host header; `fetch` does not allow setting it. */
async function get(port, pathname, headers = {}) {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, headers, agent: false });
    request.end();
    const [response] = await once(request, 'response');
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    return { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() };
}

/** The result of a WebSocket upgrade: the first message, or the HTTP status of a refusal. */
function upgrade(port, headers, options = {}) {
    return new Promise((resolve, reject) => {
        const socket = new WS(`ws://127.0.0.1:${port}/?action=hold`, { headers, ...options });
        socket.on('unexpected-response', (_request, response) => {
            response.resume();
            socket.terminate();
            resolve(response.statusCode);
        });
        socket.on('message', (data) => resolve({ socket, text: data.toString() }));
        socket.on('error', () => undefined);
        setTimeout(() => reject(Error('upgrade timed out')), 2000).unref();
    });
}

// ------------------------------------------------------------------ Host allowlist (C-server-core-3)

test('a rebound name is refused although its Origin matches its Host', async () => {
    await startServer();
    const { allowsHost, allowsOrigin, allowsRequest } = require('../src/server/requestOrigin');
    const request = (host, origin) => ({ headers: { host, ...(origin ? { origin } : {}) }, socket: {} });

    const rebound = request('evil.example:8000', 'http://evil.example:8000');
    assert.equal(allowsOrigin(rebound), true, 'the Origin check alone passes, which was the defect');
    assert.equal(allowsHost(rebound), false);
    assert.equal(allowsRequest(rebound), false);

    for (const host of [
        '10.10.10.5:8000',
        '127.0.0.1',
        '[::1]:8000',
        'localhost:8000',
        'LOCALHOST',
        os.hostname(),
        `${os.hostname().toUpperCase()}:8000`,
        `${os.hostname().split('.')[0]}.local:8000`,
        'phone.example',
        'phone.example:8000',
        'configured.example:8000',
        'from-env.example',
        'second-env.example:8443',
    ]) {
        assert.equal(allowsHost(request(host)), true, `${host} is one of this server's names`);
    }
    for (const host of [
        undefined,
        '',
        'evil.example',
        'phone.example.evil.example',
        'evil.example:8000/phone.example',
        'user@localhost',
        'localhost.evil.example',
        'direct.example:8443',
        'not a host',
    ]) {
        assert.equal(allowsHost(request(host)), false, `${host} is refused`);
    }
    assert.equal(allowsRequest(request('10.10.10.5:8000', 'http://10.10.10.5:8000')), true);
    assert.equal(allowsRequest(request('10.10.10.5:8000', 'http://evil.example:8000')), false);
    assert.equal(allowsRequest(request('10.10.10.5:8000', 'https://phone.example')), true, 'behind the TLS proxy');
});

test('a foreign Host gets 403 before any route, for pages, the API and WebSocket upgrades', async () => {
    const { port } = await startServer();
    const foreign = { Host: 'evil.example:8000' };
    for (const pathname of ['/', '/index.html', '/api/notifications/summary', '/api/files/download?udid=x&path=/x']) {
        const refused = await get(port, pathname, foreign);
        assert.equal(refused.status, 403, `${pathname} is refused`);
        assert.match(refused.body, /Host not allowed/);
        assert.doesNotMatch(refused.body, /fixture/);
    }
    assert.equal((await get(port, '/')).status, 200);
    assert.equal((await get(port, '/', { Host: 'phone.example' })).status, 200);
    assert.equal((await get(port, '/api/notifications/summary')).status, 200);

    assert.equal(await upgrade(port, { Host: 'evil.example:8000', Origin: 'http://evil.example:8000' }), 403);
    assert.equal(await upgrade(port, { Host: 'evil.example:8000' }), 403, 'also without an Origin');
    assert.equal(await upgrade(port, { Origin: 'https://another.example' }), 403, 'the Origin check still applies');
    const own = await upgrade(port, { Origin: `http://127.0.0.1:${port}` });
    assert.equal(own.text, 'connected');
    own.socket.terminate();
});

// ------------------------------------------------------------------ Frame and connection headers (C-server-core-7)

test('every response forbids framing and limits connections to this server', async () => {
    const { port } = await startServer();
    for (const [pathname, status] of [
        ['/', 200],
        ['/index.html', 200],
        ['/api/notifications/summary', 200],
        ['/api/files/download', 400],
    ]) {
        const response = await get(port, pathname);
        assert.equal(response.status, status, pathname);
        assert.equal(response.headers['x-frame-options'], 'DENY', pathname);
        assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/, pathname);
    }
    // Express writes its own, stricter policy on the error page it generates.
    const missing = await get(port, '/missing.js');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['x-frame-options'], 'DENY');
    assert.equal(missing.headers['content-security-policy'], "default-src 'none'");
    const refused = await get(port, '/', { Host: 'evil.example' });
    assert.equal(refused.headers['content-security-policy'], undefined, 'a refused name is not echoed into a header');

    const policy = (await get(port, '/', { Host: 'phone.example' })).headers['content-security-policy'];
    const connect = policy
        .split(';')
        .map((part) => part.trim().split(/\s+/))
        .find((part) => part[0] === 'connect-src');
    assert.deepEqual(
        connect.slice(1).sort(),
        ["'self'", 'ws://phone.example', 'wss://direct.example:8443', 'wss://phone.example'].sort(),
        'this server, and the remote host the browser reaches without the proxy',
    );
    const local = (await get(port, '/')).headers['content-security-policy'];
    assert.match(local, new RegExp(` ws://127\\.0\\.0\\.1:${port} wss://127\\.0\\.0\\.1:${port}`));
    assert.doesNotMatch(local, /proxied\.example|evil/);
});

// ------------------------------------------------------------------ Heartbeat (C-server-core-9)

test('a client that stops answering pings is closed; one that answers stays', async () => {
    const { port, accepted } = await startServer();
    const silent = await upgrade(port, {}, { autoPong: false });
    const alive = await upgrade(port, {});
    const [silentServerSide, aliveServerSide] = accepted.slice(-2);
    let released = false;
    silentServerSide.on('close', () => (released = true));
    let pings = 0;
    alive.socket.on('ping', () => pings++);

    // 40 ms between pings: two unanswered ones, then the close on the third round.
    const [code] = await Promise.race([
        once(silent.socket, 'close'),
        pause(1500).then(() => {
            throw Error('the silent client was never closed');
        }),
    ]);
    assert.equal(code, 1006, 'the server ended the connection without a close handshake');
    await pause(20);
    assert.equal(released, true, "the server side saw 'close', which is what releases its middleware");

    await pause(200);
    assert.ok(pings >= 4, `the answering client kept being pinged (${pings})`);
    assert.equal(alive.socket.readyState, WS.OPEN);
    assert.equal(aliveServerSide.readyState, WS.OPEN);
    alive.socket.terminate();
});

test('stopping the service stops the heartbeat', async () => {
    const { WebSocketServer } = require('../src/server/services/WebSocketServer');
    const server = http.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    // A separate instance, so the shared one keeps serving the other tests.
    const service = new (class extends WebSocketServer {})();
    service.attachToServer({ server, port: server.address().port });
    assert.equal(service.heartbeats.size, 1);
    service.release();
    assert.equal(service.heartbeats.size, 0);
    await new Promise((resolve) => server.close(resolve));
});
