// Imports fixture setup with test bodies disabled. No phone command, child tool or socket can run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const childProcess = require('node:child_process');
const Module = require('node:module');
const { fileURLToPath } = require('node:url');

const fixtures = new Set([
    'test-android-server.js', 'test-coredevice.js', 'test-crash-paths.js',
    'test-ios-settings-store.js', 'test-ios-unlock.js', 'test-notification-service.js',
    'test-notifications.js', 'test-review-fixes.js', 'test-server-regressions.js',
    'test-settings.js', 'test-web-security.js',
]);
const fixture = process.argv[2];
assert(fixtures.has(fixture), 'only an audited unit fixture may be imported');
const sandbox = process.env.TMPDIR;
assert(sandbox && path.basename(sandbox).startsWith('ws-scrcpy-fixture-isolation-'));
const poison = path.join(sandbox, 'poison');
assert.equal(process.env.WS_DATA_DIR, poison);
assert.equal(process.env.WS_NOTIFICATION_DATA, poison);

let poisonAccesses = 0;
function guard(value) {
    const file = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
    if (typeof file !== 'string') return;
    const resolved = path.resolve(file);
    if (resolved === poison || resolved.startsWith(poison + path.sep)) {
        poisonAccesses++;
        process.exitCode = 1;
        throw Error('Fixture accessed the inherited poison data directory');
    }
}
for (const name of ['accessSync', 'appendFileSync', 'chmodSync', 'copyFileSync', 'existsSync',
    'lstatSync', 'mkdirSync', 'openSync', 'opendirSync', 'readFileSync', 'readdirSync',
    'readlinkSync', 'realpathSync', 'renameSync', 'rmSync', 'rmdirSync', 'statSync',
    'truncateSync', 'unlinkSync', 'utimesSync', 'writeFileSync']) {
    const original = fs[name];
    fs[name] = function (...args) {
        guard(args[0]);
        if (name === 'copyFileSync' || name === 'renameSync') guard(args[1]);
        return original.apply(this, args);
    };
}
for (const name of ['access', 'appendFile', 'copyFile', 'createReadStream', 'createWriteStream',
    'lstat', 'mkdir', 'open', 'opendir', 'readFile', 'readdir', 'readlink', 'realpath',
    'rename', 'rm', 'rmdir', 'stat', 'truncate', 'unlink', 'utimes', 'writeFile']) {
    const original = fs[name];
    if (typeof original === 'function') fs[name] = function (...args) {
        guard(args[0]);
        if (name === 'copyFile' || name === 'rename') guard(args[1]);
        return original.apply(this, args);
    };
    const promise = fs.promises[name];
    if (typeof promise === 'function') fs.promises[name] = function (...args) {
        guard(args[0]);
        if (name === 'copyFile' || name === 'rename') guard(args[1]);
        return promise.apply(this, args);
    };
}
const forbidden = () => {
    process.exitCode = 1;
    const error = Error('Fixture setup must not start a tool or socket');
    process.stderr.write(error.stack + '\n');
    throw error;
};
for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'fork', 'spawn', 'spawnSync'])
    childProcess[name] = forbidden;
// A registration-time availability check gets a stand-in result, never a real decoder.
childProcess.execFileSync = (command, args) => {
    if (command === 'ffmpeg' && Array.isArray(args) && args.length === 1 && args[0] === '-version')
        return Buffer.alloc(0);
    return forbidden();
};
net.Server.prototype.listen = forbidden;
net.Socket.prototype.connect = forbidden;
const noop = () => {};
const load = Module._load;
Module._load = function (request, ...args) {
    if (request === 'node:test') return { test: noop, after: noop, before: noop, beforeEach: noop, afterEach: noop, mock: {} };
    if (request === 'node-pty') return { spawn: forbidden };
    return load.call(this, request, ...args);
};

require('ts-node').register({ transpileOnly: true });
try {
    require(path.join(__dirname, '..', fixture));
    const { getSettings } = require('../../src/server/Settings');
    const directory = getSettings().dataDir;
    const relative = path.relative(sandbox, directory);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'fixture data stays inside its sandbox');
    assert.notEqual(directory, poison, 'fixture overrides the inherited canonical data path');
    assert.equal(directory, path.resolve(process.env.WS_DATA_DIR), 'canonical fixture path is explicit');
    assert.equal(directory, path.resolve(process.env.WS_NOTIFICATION_DATA), 'both names select the fixture path');
    assert.equal(poisonAccesses, 0, 'fixture setup never accesses inherited data');
    process.stdout.write('Fixture data directory stays isolated\n');
} catch (error) {
    // Some fixtures install an uncaught-exception listener; report probe failures ourselves.
    process.stderr.write(String(error.stack || error) + '\n');
    process.exitCode = 1;
}
