// Server settings in isolated environments and temporary files. No phone or server is started.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('ts-node').register({ transpileOnly: true });
const {
    readSettings, getSettings, resetSettingsForTests, validateConfiguration, readConfiguration,
    settingsReport, childEnvironment, takeIosSettingsKey, IOS_KEY_ENV,
} = require('../src/server/Settings');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-settings-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('defaults keep the iPhone start budget, timeout units and host adb server', () => {
    const settings = readSettings({}, temporary);
    assert.equal(settings.dataDir, path.join(temporary, 'data'));
    assert.equal(settings.streamConfigPath, path.join(temporary, 'data', 'stream-config.json'));
    assert.equal(settings.legacyStreamConfigPath, path.join(temporary, 'stream-config.json'));
    assert.equal(settings.adbHost, '127.0.0.1');
    assert.equal(settings.adbPort, 5037);
    assert.equal(settings.iosTunnel, 'userspace');
    assert.equal(settings.iosServeWebBasePort, 18100);
    assert.equal(settings.iosSessionStartLimit, 3);
    assert.equal(settings.iosSessionStartWindowMs, 300000);
    assert.equal(settings.iosSessionCooldownMs, 30000);
    assert.equal(settings.iosDisplayWedgedTimeoutMs, 25000);
    assert.equal(settings.iosSignalReadyTimeoutMs, 35000);
    assert.equal(settings.iosClipboardTimeoutMs, undefined, 'each clipboard operation keeps its existing default');
    assert.equal(settings.iosUnlockFast, false);
    for (const key of ['iosPatchCheck', 'iosAudio', 'iosStateProbe', 'iosLockProbe', 'iosStateNotifications', 'iosUsbmuxListen', 'notificationsCollector'])
        assert.equal(settings[key], true, key);
    assert(Object.isFrozen(settings));
    assert(Object.isFrozen(settings.iosProbeArgs));
});

test('WS_DATA_DIR takes precedence and the old name and explicit stream path still work', () => {
    const old = readSettings({ WS_NOTIFICATION_DATA: 'old' }, temporary);
    assert.equal(old.dataDir, path.join(temporary, 'old'));
    const current = readSettings({ WS_DATA_DIR: 'new', WS_NOTIFICATION_DATA: 'old' }, temporary);
    assert.equal(current.dataDir, path.join(temporary, 'new'));
    assert.equal(current.streamConfigPath, path.join(temporary, 'new', 'stream-config.json'));
    const explicit = readSettings({ WS_NOTIFICATION_DATA: 'old', WS_SCRCPY_STREAM_CONFIG_PATH: 'kept.json' }, temporary);
    assert.equal(explicit.streamConfigPath, path.join(temporary, 'kept.json'));
    assert.equal(explicit.legacyStreamConfigPath, undefined);
    assert.equal(readSettings({ WS_DATA_DIR: '', WS_NOTIFICATION_DATA: 'old' }, temporary).dataDir, old.dataDir);
});

test('a bundled server uses app/data from both root and dist launches', () => {
    const app = path.join(temporary, 'app');
    const built = path.join(app, 'dist');
    fs.mkdirSync(built, { recursive: true });
    assert.equal(readSettings({}, app, built).dataDir, path.join(app, 'data'));
    assert.equal(readSettings({}, built, built).dataDir, path.join(app, 'data'));
    assert.equal(readSettings({ WS_DATA_DIR: 'private' }, built, built).dataDir, path.join(built, 'private'), 'explicit relative paths keep their meaning');
    fs.mkdirSync(path.join(built, 'data'));
    assert.equal(readSettings({}, built, built).dataDir, path.join(app, 'data'), 'an empty old directory is safe');
    fs.writeFileSync(path.join(built, 'data', 'fixture'), 'untouched');
    assert.throws(() => readSettings({}, built, built), /Existing data.*Set WS_DATA_DIR/);
    assert.throws(() => readSettings({}, app, built), /Existing data.*Set WS_DATA_DIR/, 'a root launch must not hide the former dist store');
    assert.equal(readSettings({ WS_NOTIFICATION_DATA: 'data' }, built, built).dataDir, path.join(built, 'data'), 'the legacy env name can explicitly select the former store');
    assert.equal(fs.readFileSync(path.join(built, 'data', 'fixture'), 'utf8'), 'untouched');
});

test('compose keeps the old data variable for rollback and gives both names the same directory', () => {
    const { execFileSync } = require('node:child_process');
    const compose = require('yaml').parse(fs.readFileSync(path.join(__dirname, '../docker-compose.yml'), 'utf8'));
    for (const name of ['ws-scrcpy', 'ws-scrcpy-dev']) {
        const variables = compose.services[name].environment;
        for (const [env, directory, stream] of [
            [{}, '/app/data', '/app/data/stream-config.json'],
            [{ WS_NOTIFICATION_DATA: '/old' }, '/old', '/old/stream-config.json'],
            [{ WS_DATA_DIR: '/new', WS_NOTIFICATION_DATA: '/old' }, '/new', '/new/stream-config.json'],
            [{ WS_DATA_DIR: '/new', WS_SCRCPY_STREAM_CONFIG_PATH: '/explicit.json' }, '/new', '/explicit.json'],
        ]) {
            // These are the fixed parameter substitutions from the checked-in compose file.
            const expand = (key) => execFileSync('/bin/sh', ['-c', `printf '%s' "${variables[key]}"`], { env, encoding: 'utf8' });
            assert.equal(expand('WS_DATA_DIR'), directory);
            assert.equal(expand('WS_NOTIFICATION_DATA'), directory, 'old images keep the same data on rollback');
            assert.equal(expand('WS_SCRCPY_STREAM_CONFIG_PATH'), stream);
        }
    }
});

test('zero disables only the settings that already allowed it', () => {
    const settings = readSettings({ IOS_SESSION_START_LIMIT: '0', IOS_SESSION_COOLDOWN_MS: '0', IOS_AUDIO: '0', IOS_UNLOCK_FAST: '1' });
    assert.equal(settings.iosSessionStartLimit, 0);
    assert.equal(settings.iosSessionCooldownMs, 0);
    assert.equal(settings.iosAudio, false);
    assert.equal(settings.iosUnlockFast, true);
    for (const key of ['IOS_SESSION_START_WINDOW_MS', 'IOS_DISPLAY_WEDGED_TIMEOUT_MS', 'IOS_SIGNAL_READY_TIMEOUT_MS', 'IOS_CLIPBOARD_TIMEOUT_MS', 'ADB_PORT'])
        assert.throws(() => readSettings({ [key]: '0' }), new RegExp(key));
});

test('bad env values fail before a service starts and errors omit their values', () => {
    const bad = {
        IOS_STATE_PROBE: 'maybe', ADB_PORT: '5037tail', IOS_SERVE_WEB_BASE_PORT: '80',
        IOS_SESSION_START_LIMIT: '-1', IOS_SESSION_COOLDOWN_MS: 'NaN', IOS_SIGNAL_READY_TIMEOUT_MS: '1.5',
        IOS_PROBE_ARGS: '[1]', IOS_TUNNEL: 'unknown', WS_ALLOWED_HOSTS: 'https://wrong.example',
        WS_PUBLIC_URL: 'https://user:sentinel-secret@example.com',
        WS_PUSH_SUBJECT: 'http://example.com', WS_SCRCPY_PATHNAME: '//example.com',
    };
    for (const [key, value] of Object.entries(bad)) {
        assert.throws(() => readSettings({ [key]: value }), (error) => {
            assert(error.message.includes(key));
            assert(!error.message.includes(value));
            return true;
        });
    }
    assert.throws(() => readSettings({ IOS_PROBE_ARGS: '{broken' }), /IOS_PROBE_ARGS/);
    assert.throws(() => readSettings({ IOS_SESSION_START_WINDOW_MS: '2147483648' }), /IOS_SESSION_START_WINDOW_MS/);
});

test('paths, probe arguments, public URL, captions and boolean aliases are resolved centrally', () => {
    const settings = readSettings({
        WS_SCRCPY_CONFIG: 'config.yaml', WS_SCRCPY_PATHNAME: '/phones/',
        WS_PUBLIC_URL: 'https://phone.example/app/', WS_PUSH_SUBJECT: 'mailto:owner@example.com',
        WS_ALLOWED_HOSTS: 'Phone.Example, second.example', ADB_HOST: 'adb.example', ADB_PORT: '5038',
        IOS_PROBE_CMD: 'fixture', IOS_PROBE_ARGS: '["--fixture"]', IOS_TUNNEL: 'tunneld',
        IOS_LOCKED_CAPTIONS: ' Locked , Code eingeben ', IOS_PATCH_CHECK: 'false', WS_SCRCPY_DEBUG: 'true',
        WS_IOS_SETTINGS_KEY_FILE: 'outside/key',
    }, temporary);
    assert.equal(settings.configPath, 'config.yaml');
    assert.equal(settings.pathname, '/phones/');
    assert.equal(settings.publicUrl, 'https://phone.example/app/');
    assert.equal(settings.pushSubject, 'mailto:owner@example.com');
    assert.deepEqual(settings.allowedHosts, ['phone.example', 'second.example']);
    assert.deepEqual(settings.iosProbeArgs, ['--fixture']);
    assert.deepEqual(settings.iosLockedCaptions, ['locked', 'code eingeben']);
    assert.equal(settings.iosPatchCheck, false);
    assert.equal(settings.debug, true);
    assert.equal(settings.iosSettingsKeyFile, path.join(temporary, 'outside/key'));
});

test('the startup snapshot stays fixed until a fixture explicitly resets it', () => {
    const before = process.env.WS_DATA_DIR;
    try {
        process.env.WS_DATA_DIR = path.join(temporary, 'first');
        resetSettingsForTests();
        const first = getSettings();
        process.env.WS_DATA_DIR = path.join(temporary, 'second');
        assert.equal(getSettings(), first);
        resetSettingsForTests();
        assert.equal(getSettings().dataDir, path.join(temporary, 'second'));
    } finally {
        if (before === undefined) delete process.env.WS_DATA_DIR;
        else process.env.WS_DATA_DIR = before;
        resetSettingsForTests();
    }
});

test('YAML and JSON are validated before Config reads their server list', () => {
    const good = {
        runGoogTracker: false, runApplTracker: false, allowedHosts: ['phone.example'],
        server: [{ secure: false, port: 8012, redirectToSecure: { host: 'phone.example', port: 8443 } }],
        remoteHostList: [{ type: ['android', 'ios'], hostname: 'remote.example', port: 8443, secure: true, pathname: '/phones/', useProxy: true }],
    };
    for (const [name, content] of [
        ['config.json', JSON.stringify(good)],
        ['config.js', JSON.stringify(good)],
        ['config.yaml', require('yaml').stringify(good)],
    ]) {
        const file = path.join(temporary, name);
        fs.writeFileSync(file, content);
        assert.deepEqual(readConfiguration(file), good);
    }
    for (const value of [null, [], { server: {} }, { server: [] }, { server: [null] },
        { server: [{ port: '8000' }] }, { server: [{ port: 0 }] }, { server: [{ secure: 'false' }] },
        { server: [{ port: 8000 }, { port: 8000 }] }, { server: [{ secure: true }] },
        { runApplTracker: 'false' }, { allowedHosts: ['https://bad.example'] },
        { remoteHostList: [{ type: 'android', hostname: 'host.example', secure: true, port: '8443' }] },
        { remoteHostList: [{ type: 'other', hostname: 'host.example', secure: true, port: 8443 }] },
        { remoteHostList: [{ type: 'ios', hostname: 'host.example', secure: true, port: 8443, pathname: 'bad' }] }])
        assert.throws(() => validateConfiguration(value));
    const malformed = path.join(temporary, 'bad.yaml');
    fs.writeFileSync(malformed, 'server: [sentinel-secret');
    assert.throws(() => readConfiguration(malformed), (error) => !error.message.includes('sentinel-secret'));
    assert.throws(() => readConfiguration(path.join(temporary, 'missing.json')), /could not be read/);
});

test('TLS options reject conflicting credentials and malformed types without logging contents', () => {
    for (const options of [false, {}, { certPath: '/cert' }])
        assert.throws(() => validateConfiguration({ server: [{ secure: true, options }] }));
    for (const invalid of [{ passphrase: 123 }, { rejectUnauthorized: 'false' }, { cert: 12 },
        { cert: 'sentinel-secret' }, { key: 'sentinel-secret' }])
        assert.throws(() => validateConfiguration({ server: [{ secure: true,
            options: { certPath: '/cert', keyPath: '/key', ...invalid },
        }] }), (error) => !error.message.includes('sentinel-secret'));
    assert.doesNotThrow(() => validateConfiguration({ server: [{ secure: true, options: { certPath: '/cert', keyPath: '/key' } }] }));
});

test('the key is consumed separately, never held in settings or inherited by children', () => {
    const before = process.env[IOS_KEY_ENV];
    const marker = 'settings-secret-sentinel';
    try {
        process.env[IOS_KEY_ENV] = marker;
        const settings = readSettings({ [IOS_KEY_ENV]: marker, WS_IOS_SETTINGS_KEY_FILE: '/sentinel-key-path',
            WS_PUBLIC_URL: 'https://phone.example/private-token' });
        assert(!JSON.stringify(settings).includes(marker));
        assert.equal(takeIosSettingsKey() === marker, true, 'the key is returned only to its consumer');
        assert.equal(process.env[IOS_KEY_ENV], undefined);
        process.env[IOS_KEY_ENV] = marker;
        const child = childEnvironment({ [IOS_KEY_ENV]: marker, PLAIN_FIXTURE: 'kept' });
        assert.equal(Object.hasOwn(child, IOS_KEY_ENV), false);
        assert.equal(child.PLAIN_FIXTURE, 'kept');
        assert.equal(child.PATH, process.env.PATH);
        const report = JSON.stringify(settingsReport(settings));
        for (const secret of [marker, '/sentinel-key-path', 'private-token']) assert(!report.includes(secret));
    } finally {
        if (before === undefined) delete process.env[IOS_KEY_ENV];
        else process.env[IOS_KEY_ENV] = before;
    }
});

test('an existing stream settings file is read and the next save moves to the data directory', () => {
    const cwd = process.cwd();
    const oldEnv = { WS_DATA_DIR: process.env.WS_DATA_DIR, WS_NOTIFICATION_DATA: process.env.WS_NOTIFICATION_DATA,
        WS_SCRCPY_STREAM_CONFIG_PATH: process.env.WS_SCRCPY_STREAM_CONFIG_PATH };
    const directory = path.join(temporary, 'legacy');
    fs.mkdirSync(directory);
    const original = JSON.stringify({ PHONE: { bitrate: 1234567 } });
    fs.writeFileSync(path.join(directory, 'stream-config.json'), original);
    try {
        process.chdir(directory);
        for (const key of Object.keys(oldEnv)) delete process.env[key];
        resetSettingsForTests();
        const module = require('../src/server/goog-device/StreamConfig');
        const store = module.streamConfig;
        assert.equal(store.get('PHONE').bitrate, 1234567);
        assert.equal(fs.existsSync(path.join(directory, 'data')), false, 'reading old settings writes nothing');
        store.set('PHONE', { bitrate: 2345678 });
        assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'data/stream-config.json'), 'utf8')).PHONE.bitrate, 2345678);
        assert.equal(fs.readFileSync(path.join(directory, 'stream-config.json'), 'utf8'), original, 'the former file remains for rollback');
    } finally {
        process.chdir(cwd);
        for (const [key, value] of Object.entries(oldEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        resetSettingsForTests();
    }
});

test('invalid IPv6 hosts fail before startup and adb receives an unbracketed address', () => {
    for (const value of ['[::1', '::1]', '[127.0.0.1]']) {
        assert.throws(() => readSettings({ WS_ALLOWED_HOSTS: value }), /WS_ALLOWED_HOSTS/);
        assert.throws(() => readSettings({ ADB_HOST: value }), /ADB_HOST/);
    }
    assert.equal(readSettings({ ADB_HOST: '[::1]' }).adbHost, '::1');
    assert.throws(() => validateConfiguration({ remoteHostList: [{
        type: 'ios', hostname: '::1', port: 8443, secure: true,
    }] }), /remoteHostList\[0\].hostname/);
    assert.throws(() => validateConfiguration({ server: [{ redirectToSecure: { host: '::1' } }] }),
        /server\[0\].redirectToSecure.host/);
    assert.doesNotThrow(() => validateConfiguration({ remoteHostList: [{
        type: 'ios', hostname: '[::1]', port: 8443, secure: true,
    }] }));
    for (const hostname of [' remote.example ', '[fe80::1%eth0]'])
        assert.throws(() => validateConfiguration({ remoteHostList: [{
            type: 'ios', hostname, port: 8443, secure: true,
        }] }), /remoteHostList\[0\].hostname/);
});

test('invalid TLS values and file credentials fail while Config is built without echoing contents', () => {
    for (const options of [
        { minVersion: 'not-a-version' }, { maxVersion: 'not-a-version' },
        { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.2' }, { ciphers: 'not-a-cipher' },
        { ecdhCurve: 12 }, { key: 12 },
    ]) {
        assert.throws(() => validateConfiguration({ server: [{ secure: true,
            options: { certPath: '/fixture-cert', keyPath: '/fixture-key', ...options },
        }] }), /server\[0\].options/);
    }
    const { Config } = require('../src/server/Config');
    const cert = path.join(temporary, 'invalid-cert');
    const key = path.join(temporary, 'invalid-key');
    fs.writeFileSync(cert, 'invalid-credential-sentinel');
    fs.writeFileSync(key, 'invalid-credential-sentinel');
    assert.throws(() => Config.initConfig({ server: [{ secure: true,
        options: { certPath: cert, keyPath: key },
    }] }), (error) => /server\[0\].options/.test(error.message) && !error.message.includes('sentinel'));
});

test('every direct audio, icon and adb child filters a key set after module loading', async (t) => {
    const cp = require('node:child_process');
    const { EventEmitter } = require('node:events');
    const { CoreDeviceAudioRelay } = require('../src/server/appl-device/services/CoreDeviceAudio');
    const { NotificationIcons } = require('../src/server/notifications/NotificationIcons');
    const { PyMobileDevice } = require('../src/server/appl-device/services/PyMobileDevice');
    require.extensions['.jar'] = () => {};
    require.cache[require.resolve('../vendor/Genymobile/scrcpy/LICENSE')] = { exports: {} };
    const { Device } = require('../src/server/goog-device/Device');
    const inherited = [];
    t.mock.method(cp, 'spawn', (_command, _args, options) => {
        inherited.push(options.env || process.env);
        const child = new EventEmitter();
        child.pid = 123;
        child.stdin = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => child.emit('close', 0));
        return child;
    });
    t.mock.method(cp, 'execFile', (_command, _args, options, callback) => {
        inherited.push(options.env || process.env);
        queueMicrotask(() => callback(null, Buffer.alloc(0)));
    });
    t.mock.method(PyMobileDevice, 'probeCommand', () => ({ command: 'fixture', args: [] }));
    const before = process.env[IOS_KEY_ENV];
    try {
        process.env[IOS_KEY_ENV] = 'child-filter-sentinel';
        const relay = Object.create(CoreDeviceAudioRelay.prototype);
        relay.startDecoder();
        await new NotificationIcons(temporary).get('fixture-phone', 'com.fixture');
        const phone = Object.create(Device.prototype);
        Object.assign(phone, { udid: 'fixture-phone', audioLaunchGeneration: 0,
            connectionGeneration: 0, servicePidRevision: 0, connected: false, TAG: '[fixture-phone]', setServerPid: () => {} });
        await phone.runShellCommandAdb('fixture');
        await assert.rejects(phone.launchServer('fixture', false), /exited before it was ready/);
        assert.equal(inherited.length, 4);
        for (const env of inherited) {
            assert.equal(Object.hasOwn(env, IOS_KEY_ENV), false, 'a child must not inherit the stored key');
            assert.equal(env.PATH, process.env.PATH);
        }
    } finally {
        if (before === undefined) delete process.env[IOS_KEY_ENV];
        else process.env[IOS_KEY_ENV] = before;
    }
});


test('probe argument null characters fail before starting a child', () => {
    assert.throws(() => readSettings({ IOS_PROBE_ARGS: JSON.stringify(['invalid\0argument']) }),
        /IOS_PROBE_ARGS/);
});

test('fully qualified host names keep their trailing dot', () => {
    const settings = readSettings({ WS_ALLOWED_HOSTS: 'Phone.Example.', ADB_HOST: 'Adb.Example.' });
    assert.deepEqual(settings.allowedHosts, ['phone.example.']);
    assert.equal(settings.adbHost, 'adb.example.');
    assert.doesNotThrow(() => validateConfiguration({ allowedHosts: ['phone.example.'],
        server: [{ redirectToSecure: { host: 'phone.example.' } }],
        remoteHostList: [{ type: 'ios', hostname: 'remote.example.', port: 8443, secure: true }],
    }));
});
