// Client-side pieces of the Notifications page that run without a browser.
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const { requestJson, REQUEST_TIMEOUT_MS } = require('../src/app/client/request');
const { madeForServerKey, serverKeyBytes } = require('../src/common/pushKey');

test('a push subscription made for other server keys is recognised', () => {
    const bytes = Buffer.from(Array.from({ length: 65 }, (_, index) => (index * 7 + 250) % 256));
    const publicKey = bytes.toString('base64url');
    assert.match(publicKey, /[-_]/, 'the fixture covers the URL-safe alphabet');
    assert.deepEqual([...serverKeyBytes(publicKey)], [...bytes]);
    const held = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
    assert.equal(madeForServerKey(held(bytes), publicKey), true);
    const other = Buffer.from(bytes);
    other[64] ^= 1;
    assert.equal(madeForServerKey(held(other), publicKey), false, 'one differing byte is another key');
    assert.equal(madeForServerKey(held(bytes.subarray(0, 64)), publicKey), false);
    // A browser that does not report the key, or a server with none, gives no reason to resubscribe.
    for (const unknown of [null, undefined]) assert.equal(madeForServerKey(unknown, publicKey), true);
    assert.equal(madeForServerKey(held(bytes), ''), true);
    assert.equal(madeForServerKey(held(bytes), 'not base64 !'), true);
});

/** A server that answers after `delay` ms unless the request is aborted first. */
function slowServer(delay, reply = { ok: true }) {
    const calls = [];
    const fetch = (url, options) =>
        new Promise((resolve, reject) => {
            calls.push(url);
            const timer = setTimeout(() => resolve({ ok: true, status: 200, json: async () => reply }), delay);
            options.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
        });
    return { fetch, calls };
}

test('a 304 reply resolves to null and other failures keep their message', async () => {
    const originalFetch = global.fetch;
    try {
        global.fetch = async () => ({ ok: false, status: 304, json: async () => { throw Error('no body'); } });
        assert.equal(await requestJson('http://server/api/notifications/history?since=abc'), null);
        global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'Unknown notification device' }) });
        await assert.rejects(requestJson('http://server/x'), /Unknown notification device/);
        global.fetch = async () => ({ ok: false, status: 502, json: async () => { throw Error('not JSON'); } });
        await assert.rejects(requestJson('http://server/x'), /Request failed \(502\)/);
    } finally {
        global.fetch = originalFetch;
    }
});

test('a request waits as long as its caller allows, and 10 s by default', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const originalFetch = global.fetch;
    // The bulk route can work for 30 s; the page allows it 35 s.
    const server = slowServer(30000, { accepted: ['a'] });
    global.fetch = server.fetch;
    try {
        assert.equal(REQUEST_TIMEOUT_MS, 10000);
        const short = requestJson('http://server/api/notifications/history/actions', { method: 'POST' });
        const rejected = assert.rejects(short, /The server took too long to respond/);
        t.mock.timers.tick(10000);
        await rejected;

        const long = requestJson('http://server/api/notifications/history/actions', { method: 'POST' }, undefined, 35000);
        t.mock.timers.tick(30000);
        assert.deepEqual(await long, { accepted: ['a'] }, 'the reply at 30 s reaches the caller');

        const tooLong = requestJson('http://server/x', {}, undefined, 20000);
        const late = assert.rejects(tooLong, /The server took too long to respond/);
        t.mock.timers.tick(20000);
        await late;
    } finally {
        global.fetch = originalFetch;
        mock.timers.reset();
    }
});
