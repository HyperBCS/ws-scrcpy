// Serves built assets and a synthetic notification summary for isolated browser fixtures.
// Production never loads this server, and it does not expose any device middleware.
const express = require('express');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
async function main() {
    const app = express();
    app.get('/api/notifications/summary', (_req, res) => res.json({ sources: [], unread: 0, unreadBySource: {} }));
    app.use(express.static(path.join(__dirname, '../dist/public')));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const suites = process.argv.slice(2);
    const defaults = ['review-polish', 'notifications', 'motion', 'settings', 'sheets', 'switcher', 'unlock', 'tools', 'files', 'ios-typing', 'audio-availability'];
    try {
        for (const suite of suites.length ? suites : defaults) {
            if (!/^[a-z-]+$/.test(suite)) throw Error('Invalid suite name');
            console.log(`Running ${suite} browser checks`);
            const child = spawn(process.execPath, [path.join(__dirname, `e2e-${suite}.js`)], {
                stdio: 'inherit', env: { ...process.env, BASE: `http://127.0.0.1:${server.address().port}/` },
            });
            const timeout = setTimeout(() => child.kill('SIGTERM'), 240000);
            const [code] = await once(child, 'exit'); clearTimeout(timeout);
            if (code !== 0) throw Error(`${suite} failed (${code})`);
        }
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
