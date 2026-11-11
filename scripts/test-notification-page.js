// Client-side pieces of the Notifications page that run without a browser.
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const { requestJson, REQUEST_TIMEOUT_MS } = require('../src/app/client/request');

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
