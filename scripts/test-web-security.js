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

// ------------------------------------------------------------------ Stream links (C-client-stream-2)

test('a link cannot choose the socket host unless the connection is proxied', async () => {
    await startServer();
    const { BaseClient } = require('../src/app/client/BaseClient');
    const { ManagerClient } = require('../src/app/client/ManagerClient');
    const { CoreDeviceReceiver } = require('../src/app/applDevice/client/CoreDeviceReceiver');
    const originalOpen = ManagerClient.prototype.openNewConnection;
    ManagerClient.prototype.openNewConnection = () => undefined;
    try {
        const crafted = new URLSearchParams(
            'action=stream-coredevice&udid=PHONE&hostname=attacker.example&port=443&secure=true&pathname=/collect',
        );
        const params = BaseClient.parseParameters(crafted);
        assert.deepEqual(
            [params.hostname, params.port, params.secure, params.pathname, params.useProxy],
            [undefined, undefined, undefined, undefined, undefined],
        );
        const receiver = new CoreDeviceReceiver({ ...params, udid: 'PHONE' });
        assert.equal(receiver.url.origin, 'wss://app.example:8443', "the socket goes to the page's own server");
        assert.equal(receiver.url.pathname, '/');
        receiver.stop();

        const viaProxy = new URLSearchParams(crafted);
        viaProxy.set('useProxy', 'true');
        const proxied = new CoreDeviceReceiver({ ...BaseClient.parseParameters(viaProxy), udid: 'PHONE' });
        assert.equal(proxied.url.origin, 'wss://app.example:8443', 'a proxied link still connects to this server');
        assert.equal(proxied.url.searchParams.get('action'), 'proxy-ws');
        assert.equal(new URL(proxied.url.searchParams.get('ws')).host, 'attacker.example', 'which checks the host');
        proxied.stop();
    } finally {
        ManagerClient.prototype.openNewConnection = originalOpen;
    }
});

test('the server proxy refuses a host that is not configured', async () => {
    await startServer();
    const { Config } = require('../src/server/Config');
    const config = Config.getInstance();
    assert.equal(config.getProxyHost(new URL('wss://attacker.example/?action=proxy-coredevice&udid=PHONE')), undefined);
    assert.ok(config.getProxyHost(new URL('wss://proxied.example:8443/?action=proxy-coredevice&udid=PHONE')));
});

test('an Android stream link is refused when its socket is not this server', async () => {
    await startServer();
    const { ManagerClient } = require('../src/app/client/ManagerClient');
    const { StreamReceiverScrcpy } = require('../src/app/googDevice/client/StreamReceiverScrcpy');
    const { streamSocketUrl } = require('../src/app/googDevice/client/deviceInterfaces');
    const originalOpen = ManagerClient.prototype.openNewConnection;
    ManagerClient.prototype.openNewConnection = () => undefined;
    const receiver = (ws, extra = {}) =>
        new StreamReceiverScrcpy({ action: 'stream', udid: 'PHONE', player: 'mse', ws, ...extra });
    try {
        const local = { type: 'android', secure: true, hostname: 'app.example', port: 8443, pathname: '/' };
        const own = streamSocketUrl('PHONE', local);
        assert.equal(own, 'wss://app.example:8443/?action=proxy-adb&remote=tcp%3A8886&udid=PHONE');
        const accepted = receiver(own);
        assert.equal(accepted.url.toString(), own);
        accepted.stop();

        for (const ws of [
            'wss://attacker.example/?action=proxy-adb&remote=tcp%3A8886&udid=PHONE',
            'wss://app.example:9000/?action=proxy-adb&remote=tcp%3A8886&udid=PHONE',
            'wss://app.example.attacker.example:8443/',
            'wss://app.example:8443@attacker.example/',
            'ws://app.example:8443/?action=proxy-adb&remote=tcp%3A8886&udid=PHONE',
            // What the card offered while the direct option existed.
            'ws://192.168.1.42:8886/',
        ]) {
            assert.throws(() => receiver(ws), /connects to another server/, ws);
        }

        // A device on a configured remote host: the socket is this server's proxy.
        const remote = 'wss://proxied.example:8443/?action=proxy-adb&remote=tcp%3A8886&udid=PHONE';
        const proxied = receiver(remote, { useProxy: true });
        assert.equal(proxied.url.origin, 'wss://app.example:8443');
        assert.equal(proxied.url.searchParams.get('ws'), remote);
        proxied.stop();
    } finally {
        ManagerClient.prototype.openNewConnection = originalOpen;
    }
});

// ------------------------------------------------------------------ Connection default (C-server-core-8, U-home-1)

test('an Android device has one route, whatever addresses it reports', async () => {
    await startServer();
    const { streamSocketUrl } = require('../src/app/googDevice/client/deviceInterfaces');
    const interfaces = require('../src/app/googDevice/client/deviceInterfaces');
    assert.deepEqual(Object.keys(interfaces), ['streamSocketUrl'], 'no interface list and no saved choice');
    const params = { type: 'android', secure: true, hostname: 'app.example', port: 8443, pathname: '/' };
    const url = new URL(streamSocketUrl('emulator-5554', params));
    assert.equal(url.host, 'app.example:8443');
    assert.equal(url.searchParams.get('action'), 'proxy-adb');
    assert.equal(url.searchParams.get('udid'), 'emulator-5554');
    const flags = JSON.parse(fs.readFileSync(path.join(__dirname, '../webpack/default.build.config.json'), 'utf8'));
    assert.equal('SCRCPY_LISTENS_ON_ALL_INTERFACES' in flags, false, 'the build flag is gone');
});

// ------------------------------------------------------------------ Notifications (C-notifications-14, -15)

test('notification requests are not limited per address', async () => {
    const { port } = await startServer();
    // Tailscale Serve forwards every HTTPS client from 127.0.0.1. The limit was 180 a minute.
    const statuses = new Set();
    for (let index = 0; index < 200; index++) {
        statuses.add((await get(port, '/api/notifications/summary')).status);
    }
    assert.deepEqual([...statuses], [200]);
});

test('the private app link comes from WS_PUBLIC_URL only', async () => {
    await startServer();
    const { privateAppUrl } = require('../src/app/state/privateApp');
    assert.equal(privateAppUrl('https://phone.example'), 'https://phone.example/#!action=notifications');
    assert.equal(privateAppUrl('https://phone.example/app/'), 'https://phone.example/app/#!action=notifications');
    assert.equal(privateAppUrl(''), '', 'no address configured, no link');
    assert.equal(privateAppUrl(undefined), '');
    assert.equal(privateAppUrl('not a url'), '');
    const view = fs.readFileSync(path.join(__dirname, '../src/app/views/NotificationsView.tsx'), 'utf8');
    assert.doesNotMatch(view, /https?:\/\/[^'"\s]*\.ts\.net/, 'no host name is built into the client');
});

// ------------------------------------------------------------------ Build output (C-server-core-13)

test('client chunks carry a content hash and only the client directory is cleaned', async () => {
    await startServer();
    const { frontend, backend, CLIENT_DIST_PATH, SERVER_DIST_PATH } = require('../webpack/ws-scrcpy.common');
    const client = frontend();
    assert.equal(client.output.path, CLIENT_DIST_PATH);
    assert.match(client.output.chunkFilename, /\[contenthash\]/);
    assert.equal(client.output.clean, true, 'chunks of earlier builds are removed');
    const styles = client.plugins.find((plugin) => plugin.constructor.name === 'MiniCssExtractPlugin');
    assert.match(styles.options.chunkFilename, /\[contenthash\]/);
    // With no configuration the server keeps data/ and stream-config.json in its working
    // directory, which is dist/ under `npm start`. Cleaning that would delete them.
    const server = backend();
    assert.equal(server.output.path, SERVER_DIST_PATH);
    assert.equal(server.output.clean, undefined);
    assert.notEqual(path.relative(SERVER_DIST_PATH, CLIENT_DIST_PATH), '', 'the two builds have separate directories');
});

// ------------------------------------------------------------------ Lint coverage (C-server-core-15)

test('lint checks the test scripts and the service worker', async () => {
    const { ESLint } = require('eslint');
    const root = path.join(__dirname, '..');
    const eslint = new ESLint({ cwd: root });
    const rulesFor = async (file, code) => {
        const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
        return result.messages.map((message) => message.ruleId);
    };
    // A misspelt name in a test used to pass lint, because every .js file was ignored.
    assert.deepEqual(await rulesFor('scripts/test-example.js', 'asert.equal(1, 1);\n'), ['no-undef']);
    assert.deepEqual(await rulesFor('scripts/e2e-example.js', 'const unused = document.title;\n'), ['no-unused-vars']);
    assert.deepEqual(await rulesFor('src/public/sw.js', 'self.addEventListener("push", () => missing());\n'), [
        'no-undef',
    ]);
    assert.deepEqual(await rulesFor('scripts/e2e-example.js', 'console.log(location.href, process.env.BASE);\n'), []);
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    assert.match(scripts.lint, /\bscripts\//, 'npm run lint covers scripts/');
});

// ------------------------------------------------------------------ Deployment (C-server-core-10, P1-carry-stop-grace)

const repo = (...parts) => path.join(__dirname, '..', ...parts);
function composeServices() {
    const compose = require('yaml').parse(fs.readFileSync(repo('docker-compose.yml'), 'utf8'));
    return Object.entries(compose.services);
}

test('docker stop waits longer than the server needs to stop the phone sessions', async () => {
    await startServer();
    const { CoreDeviceRunner } = require('../src/server/appl-device/services/CoreDeviceRunner');
    const budgetSeconds = CoreDeviceRunner.shutdownBudgetMs() / 1000;
    assert.equal(budgetSeconds, 70, 'a change to the budget has to be carried into docker-compose.yml');
    for (const [name, service] of composeServices()) {
        const grace = /^(\d+)s$/.exec(service.stop_grace_period);
        assert.ok(grace, `${name} sets stop_grace_period in seconds`);
        assert.ok(
            Number(grace[1]) >= budgetSeconds + 10,
            `${name}: ${service.stop_grace_period} leaves 10 s over the ${budgetSeconds} s budget`,
        );
    }
});

test('the containers run with an init process, a loopback health check and no raw sockets', () => {
    const services = composeServices();
    assert.deepEqual(services.map(([name]) => name).sort(), ['ws-scrcpy', 'ws-scrcpy-dev']);
    for (const [name, service] of services) {
        assert.equal(service.init, true, `${name} reaps orphaned children`);
        assert.deepEqual(service.cap_drop, ['NET_RAW'], name);
        assert.equal(service.privileged, undefined, name);
        assert.equal(service.user, undefined, `${name} starts as root so the entrypoint can hand the volume over`);
        assert.ok(service.group_add.length, `${name} joins the host bluetooth group`);
        const check = service.healthcheck.test;
        assert.equal(check[0], 'CMD');
        assert.match(check.join(' '), /http:\/\/127\.0\.0\.1:8000\//, `${name} checks over loopback`);
        // The check has to be valid JavaScript, or every container is reported unhealthy.
        assert.doesNotThrow(() => new Function(check[check.length - 1]), name);
    }
    for (const file of ['Dockerfile', 'Dockerfile.dev']) {
        const text = fs.readFileSync(repo(file), 'utf8');
        assert.match(text, /^ENTRYPOINT \["ws-scrcpy-entrypoint"\]$/m, `${file} starts through the entrypoint`);
        assert.match(text, /config\/docker-entrypoint\.sh/, file);
        assert.doesNotMatch(text, /maintainer/i, `${file} names no upstream maintainer`);
    }
});

test('secrets and local state stay out of the image build context', () => {
    const ignored = fs
        .readFileSync(repo('.dockerignore'), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
    for (const entry of ['adbkeys', 'certs', 'config.https.yaml', 'stream-config.json', 'logs', 'data', '.git']) {
        assert.ok(ignored.includes(entry), `${entry} is in .dockerignore`);
    }
    assert.equal(ignored.includes('config'), false, 'the entrypoint in config/ is still copied');
});

/** Runs the entrypoint with stand-ins for the commands that need root. Returns what they were asked to do. */
function runEntrypoint(t, { uid, args, env = {} }) {
    const { execFileSync } = require('node:child_process');
    const bin = fs.mkdtempSync(path.join(temporary, 'entrypoint-'));
    const log = path.join(bin, 'calls.log');
    const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub('id', `echo ${uid}`);
    stub('mkdir', `echo "mkdir $*" >> "${log}"`);
    stub('chown', `echo "chown $*" >> "${log}"`);
    stub('getent', 'echo "node:x:1000:1000::/home/node:/bin/bash"');
    // The real setpriv changes the user and then runs what follows `--`.
    stub(
        'setpriv',
        `echo "setpriv $*" >> "${log}"\nwhile [ "$1" != "--" ]; do shift; done\nshift\necho "HOME=$HOME" >> "${log}"\nexec "$@"`,
    );
    const output = execFileSync('/bin/sh', [repo('config/docker-entrypoint.sh'), ...args], {
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: '/root', ...env },
        encoding: 'utf8',
    });
    return { output, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
}

test('the entrypoint hands the data volume to the node user and drops root before the server starts', (t) => {
    const started = runEntrypoint(t, { uid: 0, args: ['echo', 'server', 'started'] });
    assert.deepEqual(started.calls, [
        'mkdir -p /app/data',
        'chown -R node:node /app/data',
        'setpriv --reuid=node --regid=node --keep-groups -- echo server started',
        'HOME=/home/node',
    ]);
    assert.equal(started.output, 'server started\n', 'the command runs after the drop, with its arguments');

    const elsewhere = runEntrypoint(t, { uid: 0, args: ['true'], env: { WS_NOTIFICATION_DATA: '/srv/data' } });
    assert.deepEqual(elsewhere.calls.slice(0, 2), ['mkdir -p /srv/data', 'chown -R node:node /srv/data']);

    // Started as another user (compose `user:`): nothing to change, and no attempt to.
    const unprivileged = runEntrypoint(t, { uid: 1000, args: ['echo', 'server', 'started'] });
    assert.deepEqual(unprivileged.calls, []);
    assert.equal(unprivileged.output, 'server started\n');
    assert.ok(fs.statSync(repo('config/docker-entrypoint.sh')).mode & 0o111, 'the script is executable');
});

// ------------------------------------------------------------------ adb server (C-server-core-4)

/** Speaks enough of the adb host protocol for forwards. Each connection carries one request. */
async function fakeAdbServer(forwards) {
    const requests = [];
    const value = (text) => text.length.toString(16).padStart(4, '0').toUpperCase() + text;
    const server = net.createServer((socket) => {
        let buffered = '';
        socket.on('error', () => undefined);
        socket.on('data', (chunk) => {
            buffered += chunk.toString();
            if (buffered.length < 4 || buffered.length < 4 + parseInt(buffered.slice(0, 4), 16)) return;
            const request = buffered.slice(4);
            requests.push(request);
            if (request.endsWith(':list-forward')) socket.end('OKAY' + value(forwards.join('\n') + '\n'));
            else if (request.includes(':killforward:localfilesystem:/refused'))
                socket.end('FAIL' + value('cannot remove listener'));
            else if (request.includes(':killforward:')) socket.end('OKAYOKAY');
            else socket.end('FAIL' + value('unsupported in the fixture'));
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { requests, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Points adbkit at `port` and puts a fake `adb` first on PATH that records every time it runs. */
function adbEnvironment(t, port) {
    const bin = fs.mkdtempSync(path.join(temporary, 'bin-'));
    const marker = path.join(bin, 'adb-was-run');
    fs.writeFileSync(path.join(bin, 'adb'), `#!/bin/sh\necho "$@" >> "${marker}"\n`, { mode: 0o755 });
    const previous = { PATH: process.env.PATH, ADB_PORT: process.env.ADB_PORT, ADB_HOST: process.env.ADB_HOST };
    process.env.PATH = `${bin}${path.delimiter}${previous.PATH}`;
    process.env.ADB_PORT = String(port);
    process.env.ADB_HOST = '127.0.0.1';
    t.after(() => {
        for (const [key, original] of Object.entries(previous)) {
            if (original === undefined) delete process.env[key];
            else process.env[key] = original;
        }
    });
    return { adbRuns: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []) };
}

test('a refused adb connection does not start an adb server', async (t) => {
    await startServer();
    const { AdbExtended, NO_ADB_BINARY } = require('../src/server/goog-device/adb');
    // Nothing listens here, as after a host reboot before the host adb server is up.
    const { adbRuns } = adbEnvironment(t, await freePort());
    const client = AdbExtended.createClient();
    assert.equal(client.options.bin, NO_ADB_BINARY);
    assert.equal(fs.existsSync(NO_ADB_BINARY), false);
    await assert.rejects(
        client.listDevices(),
        /The adb server at 127\.0\.0\.1:\d+ is not running\. Start it on the host/,
    );
    await assert.rejects(client.trackDevices(), /is not running/, 'the tracker gets the same answer and retries later');
    await pause(200);
    assert.deepEqual(adbRuns(), [], 'no `adb start-server` was run');
});

test('legacy forwards are removed over the adb protocol, not with the adb client', async (t) => {
    await startServer();
    const { AdbUtils } = require('../src/server/goog-device/AdbUtils');
    const adb = await fakeAdbServer([
        'PHONE localfilesystem:/tmp/old-socket localabstract:scrcpy',
        'PHONE tcp:27183 localabstract:scrcpy',
        'OTHER localfilesystem:/tmp/other-socket localabstract:scrcpy',
    ]);
    t.after(adb.close);
    const { adbRuns } = adbEnvironment(t, adb.port);
    await AdbUtils.removeFileSocketForwards('PHONE');
    assert.deepEqual(adb.requests, [
        'host-serial:PHONE:list-forward',
        'host-serial:PHONE:killforward:localfilesystem:/tmp/old-socket',
    ]);

    const refusing = await fakeAdbServer(['PHONE localfilesystem:/refused localabstract:scrcpy']);
    t.after(refusing.close);
    process.env.ADB_PORT = String(refusing.port);
    await assert.rejects(AdbUtils.removeFileSocketForwards('PHONE'), /cannot remove listener/);
    await pause(100);
    assert.deepEqual(adbRuns(), [], 'the adb client was never spawned');
});
