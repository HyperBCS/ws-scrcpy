const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const source = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../src/app/state/notifications.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;

const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function cleanup(worker) {
    const timers = new Map();
    let nextTimer = 0;
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module,
        exports: module.exports,
        require: name => {
            if (name === '@preact/signals') return { signal: value => ({ value }) };
            if (name === './router') return { route: { value: new URLSearchParams() } };
            throw Error(`Unexpected dependency ${name}`);
        },
        URL,
        window: { location: { href: 'https://example.test/app/' } },
        navigator: worker ? { serviceWorker: worker } : {},
        setTimeout: (callback, milliseconds) => {
            const id = ++nextTimer;
            timers.set(id, { callback, milliseconds });
            return id;
        },
        clearTimeout: id => timers.delete(id),
    });
    return {
        close: module.exports.closeReadNotifications,
        timers,
        expire() {
            for (const [id, timer] of [...timers]) {
                timers.delete(id);
                timer.callback();
            }
        },
    };
}

test('a stuck registration lookup returns immediately and cannot start a late tray query', async () => {
    const registration = deferred();
    let registrations = 0;
    let queries = 0;
    const context = cleanup({ getRegistration: () => { registrations++; return registration.promise; } });
    assert.equal(context.close(['first']), undefined, 'cleanup is not an awaited UI dependency');
    context.close(['second']);
    await settle();
    assert.equal(registrations, 1, 'concurrent cleanup requests share one browser query');
    assert.equal(context.timers.size, 1);
    assert.equal([...context.timers.values()][0].milliseconds, 1000);
    context.expire();
    await settle();
    registration.resolve({ getNotifications: () => { queries++; return []; } });
    await settle();
    assert.equal(queries, 0, 'registration finishing after the deadline cannot continue stale work');
    assert.equal(context.timers.size, 0);
});

test('a stuck getNotifications call expires, ignores late results, and allows later cleanup', async () => {
    const notifications = deferred();
    const closed = [];
    let queries = 0;
    const context = cleanup({ getRegistration: async () => ({ getNotifications: () => {
        queries++;
        return queries === 1
            ? notifications.promise
            : [{ data: { notificationKey: 'new' }, close: () => closed.push('new') }];
    } }) });
    assert.equal(context.close(['old']), undefined);
    await settle();
    context.expire();
    await settle();
    context.close(['new']);
    await settle();
    notifications.resolve([{ data: { notificationKey: 'old' }, close: () => closed.push('old') }]);
    await settle();
    assert.equal(queries, 2);
    assert.deepEqual(closed, ['new']);
    assert.equal(context.timers.size, 0);
});

test('cleanup coalesces keys received during one query and only closes their alerts', async () => {
    const notifications = deferred();
    const closed = [];
    let queries = 0;
    const context = cleanup({ getRegistration: async () => ({ getNotifications: () => {
        queries++;
        return notifications.promise;
    } }) });
    context.close(['first']);
    await settle();
    context.close(['second', 'first']);
    notifications.resolve(['first', 'second', 'unrelated'].map(key => ({
        data: { notificationKey: key }, close: () => closed.push(key),
    })));
    await settle();
    assert.equal(queries, 1);
    assert.deepEqual(closed, ['first', 'second']);
    assert.equal(context.timers.size, 0);
});

test('registration and tray query failures are contained and do not poison later cleanup', async () => {
    const closed = [];
    let calls = 0;
    const context = cleanup({ getRegistration: async () => {
        calls++;
        if (calls === 1) throw Error('Registration unavailable');
        if (calls === 2) return { getNotifications: () => { throw Error('Tray unavailable'); } };
        return { getNotifications: async () => [{ data: { notificationKey: 'third' }, close: () => closed.push('third') }] };
    } });
    for (const key of ['first', 'second', 'third']) {
        context.close([key]);
        await settle();
        assert.equal(context.timers.size, 0);
    }
    assert.deepEqual(closed, ['third']);
});

test('a rejected promise arriving after timeout stays contained', async () => {
    const notifications = deferred();
    const context = cleanup({ getRegistration: async () => ({ getNotifications: () => notifications.promise }) });
    context.close(['first']);
    await settle();
    context.expire();
    await settle();
    notifications.reject(Error('Late browser failure'));
    await settle();
    assert.equal(context.timers.size, 0);
});

test('one failed close does not prevent closing other matched notifications', async () => {
    const closed = [];
    const context = cleanup({ getRegistration: async () => ({ getNotifications: async () => [
        { data: { notificationKey: 'first' }, close: () => { throw Error('Cannot close'); } },
        { data: { notificationKey: 'second' }, close: () => closed.push('second') },
    ] }) });
    context.close(['first', 'second']);
    await settle();
    assert.deepEqual(closed, ['second']);
});

test('no service worker or no selected notifications requires no cleanup work', async () => {
    const unsupported = cleanup();
    assert.equal(unsupported.close(['first']), undefined);
    assert.equal(unsupported.timers.size, 0);
    let calls = 0;
    const empty = cleanup({ getRegistration: async () => { calls++; return undefined; } });
    empty.close([]);
    await settle();
    assert.equal(calls, 0);
    assert.equal(empty.timers.size, 0);
});
