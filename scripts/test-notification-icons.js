const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
require('ts-node').register({ transpileOnly: true });
const { NotificationIcons } = require('../src/server/notifications/NotificationIcons');
const { PyMobileDevice } = require('../src/server/appl-device/services/PyMobileDevice');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-notification-icons-'));
const originalProbe = PyMobileDevice.probeCommand;
after(() => {
    PyMobileDevice.probeCommand = originalProbe;
    fs.rmSync(temporary, { recursive: true, force: true });
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aELsAAAAASUVORK5CYII=', 'base64');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
let next = 0;
function fixture() {
    const dir = path.join(temporary, String(next++));
    fs.mkdirSync(dir);
    const log = path.join(dir, 'requests');
    const script = path.join(dir, 'probe.js');
    fs.writeFileSync(script, `
const fs = require('node:fs');
const [log, app] = [process.argv[2], process.argv.at(-1)];
fs.appendFileSync(log, 'start ' + app + '\\n');
setTimeout(() => {
    fs.appendFileSync(log, 'end ' + app + '\\n');
    if (app.endsWith('.missing')) process.exit(1);
    if (app.endsWith('.bad')) { process.stdout.write('<svg></svg>'); return; }
    if (app.endsWith('.large')) { process.stdout.write(Buffer.alloc(2 * 1024 * 1024)); return; }
    const image = Buffer.from('${png.toString('base64')}', 'base64');
    if (app.endsWith('.huge')) image.writeUInt32BE(4096, 16);
    process.stdout.write(image);
}, 80);
`);
    PyMobileDevice.probeCommand = name => {
        assert.equal(name, 'notification_icon.py');
        return { command: process.execPath, args: [script, log] };
    };
    return { dir, log, icons: new NotificationIcons(dir), requests: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
}

test('icon requests coalesce, persist private PNGs, and use the cache without a phone', async () => {
    const f = fixture();
    const [one, two] = await Promise.all([f.icons.get('iphone', 'com.example'), f.icons.get('iphone', 'com.example')]);
    assert.deepEqual(one, png);
    assert.deepEqual(two, png);
    assert.equal(f.requests().filter(line => line.startsWith('start')).length, 1);
    const directory = path.join(f.dir, 'notification-icons', hash('iphone'));
    const file = path.join(directory, hash('com.example') + '.png');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    PyMobileDevice.probeCommand = () => { throw Error('Phone disconnected'); };
    assert.deepEqual(await new NotificationIcons(f.dir).get('iphone', 'com.example'), png);
});

test('invalid input, unsupported images and failed lookups cannot become cached icons', async () => {
    const f = fixture();
    for (const [source, app] of [['../iphone', 'com.example'], ['iphone', '../app'], ['iphone', 'a'.repeat(257)], ['iphone', 'com.example\n']]) {
        assert.equal(await f.icons.get(source, app), null);
    }
    assert.deepEqual(f.requests(), []);
    for (const app of ['com.missing', 'com.bad', 'com.large', 'com.huge']) {
        assert.equal(await f.icons.get('iphone', app), null);
        assert.equal(await f.icons.get('iphone', app), null);
    }
    assert.equal(f.requests().filter(line => line.startsWith('start')).length, 4, 'failures are cached for repeat UI requests');
    assert.equal(fs.existsSync(path.join(f.dir, 'notification-icons')), false);
});

test('concurrent different icons limit USB requests and deletion invalidates pending results', async () => {
    const f = fixture();
    const images = await Promise.all(Array.from({ length: 5 }, (_, i) => f.icons.get('iphone', `com.app${i}`)));
    assert.ok(images.every(image => image.equals(png)));
    let active = 0;
    let maximum = 0;
    for (const entry of f.requests()) {
        active += entry.startsWith('start') ? 1 : -1;
        maximum = Math.max(maximum, active);
    }
    assert.equal(maximum, 2);
    const pending = f.icons.get('iphone', 'com.new');
    f.icons.removeSource('iphone');
    assert.equal(await pending, null);
    assert.equal(fs.existsSync(path.join(f.dir, 'notification-icons', hash('iphone'))), false, 'removal cannot be undone by an in-flight USB result');
    assert.deepEqual(await f.icons.get('iphone', 'com.new'), png, 'a re-added source can fetch again');
});

test('no lookup is started for a phone that is not on USB, and nothing is held against it', async () => {
    const f = fixture();
    let reachable = true;
    NotificationIcons.setPhoneCheck(udid => { assert.equal(udid, 'iphone'); return reachable; });
    try {
        assert.deepEqual(await f.icons.get('iphone', 'com.cached'), png);
        reachable = false;
        for (let i = 0; i < 30; i++) assert.equal(await f.icons.get('iphone', `com.app${i}`), null);
        assert.equal(f.requests().filter(line => line.startsWith('start')).length, 1, 'only the first icon ran the probe');
        assert.equal(f.icons.failures.size, 0);
        assert.deepEqual(await f.icons.get('iphone', 'com.cached'), png, 'an icon already on disk needs no phone');
        reachable = true;
        assert.deepEqual(await f.icons.get('iphone', 'com.app0'), png, 'the icon loads once the phone is back');
    } finally { NotificationIcons.setPhoneCheck(() => undefined); }
});

test('a missing icon is remembered for an hour only when the phone answered', async () => {
    const f = fixture();
    const remembered = async app => {
        const before = Date.now();
        assert.equal(await f.icons.get('iphone', app), null);
        const [expires] = [...f.icons.failures.values()].slice(-1);
        return Math.round((expires - before) / 60000);
    };
    try {
        assert.equal(await remembered('com.first.missing'), 1, 'not known whether the phone is attached');
        NotificationIcons.setPhoneCheck(() => true);
        assert.equal(await remembered('com.second.missing'), 60);
        assert.equal(await remembered('com.bad'), 60);
        assert.equal(await remembered('com.large'), 1, 'a lookup that was cut short is tried again soon');
        const count = f.requests().length;
        assert.equal(await f.icons.get('iphone', 'com.second.missing'), null);
        assert.equal(f.requests().length, count);
    } finally { NotificationIcons.setPhoneCheck(() => undefined); }
});

test('the iPhone tracker says when it has listed the attached phones', async () => {
    const { ControlCenter } = require('../src/server/appl-device/services/ControlCenter');
    const tracker = new ControlCenter();
    // Only the listing step runs; nothing here starts pymobiledevice3.
    tracker.listUdids = async () => [];
    tracker.initialized = true;
    assert.equal(tracker.hasPolled(), false);
    await tracker.poll();
    assert.equal(tracker.hasPolled(), true);
    assert.equal(tracker.getDescriptor('iphone'), undefined);
});

test('the cache retains at most 100 icons per source and replaces corrupt cached files', async () => {
    const f = fixture();
    const directory = path.join(f.dir, 'notification-icons', hash('iphone'));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (let i = 0; i < 100; i++) {
        const file = path.join(directory, hash(`com.old${i}`) + '.png');
        fs.writeFileSync(file, png, { mode: 0o600 });
        fs.utimesSync(file, new Date(1000 + i), new Date(1000 + i));
    }
    assert.deepEqual(await f.icons.get('iphone', 'com.new'), png);
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.png')).length, 100);
    assert.equal(fs.existsSync(path.join(directory, hash('com.old0') + '.png')), false);
    const file = path.join(directory, hash('com.new') + '.png');
    fs.writeFileSync(file, '<html>bad cached data</html>');
    assert.deepEqual(await f.icons.get('iphone', 'com.new'), png);
    assert.deepEqual(fs.readFileSync(file), png);
});
