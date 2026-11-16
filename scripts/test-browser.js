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
    // A Files download is a browser navigation, which page.route cannot answer. The body names what was asked for.
    app.get('/api/files/download', (req, res) => res.attachment(path.posix.basename(String(req.query.path))).send(Buffer.from(`fixture download ${req.query.udid} ${req.query.path}`)));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const suites = process.argv.slice(2);
    const defaults = ['review-polish', 'notifications', 'motion', 'settings', 'sheets', 'switcher', 'unlock', 'tools', 'files', 'files-flows', 'files-kit', 'ios-typing', 'ios-settings', 'ios-reconnect', 'ios-input', 'audio-availability', 'confirm', 'sheet-chrome', 'home', 'android-stream', 'android-lifecycle', 'web-security', 'navigation', 'overlay-back', 'device-page', 'history-walk', 'kit', 'kit-sheet', 'kit-followups', 'phone-status', 'actions-sheet', 'controls', 'desktop-layout', 'screen-states', 'desktop-input', 'notification-inbox', 'ui-consistency', 'about-ui', 'show-touches', 'ios-colour', 'theme', 'atlas'];
    let kitServer;
    let kitAssets;
    try {
        if ((suites.length ? suites : defaults).some(suite => ['kit', 'kit-sheet', 'kit-followups'].includes(suite))) {
            // An explicit test-only build in a unique temporary directory. BASE stays on
            // dist/public even in mixed suites; no fixture asset can enter the deploy artifact.
            kitAssets = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'ws-scrcpy-kit-'));
            const build = spawn(process.execPath, [require.resolve('webpack/bin/webpack.js'), '--config',
                path.join(__dirname, '../webpack/ws-scrcpy.kit.ts')], {
                stdio: 'inherit', env: { ...process.env, KIT_FIXTURE_OUT: kitAssets },
            });
            const [code] = await once(build, 'exit');
            if (code !== 0) throw Error(`Kit fixture build failed (${code})`);
            const kitApp = express();
            kitApp.get('/api/notifications/summary', (_req, res) => res.json({ sources: [], unread: 0, unreadBySource: {} }));
            kitApp.use(express.static(kitAssets));
            kitServer = kitApp.listen(0, '127.0.0.1'); await once(kitServer, 'listening');
        }
        for (const suite of suites.length ? suites : defaults) {
            if (!/^[a-z-]+$/.test(suite)) throw Error('Invalid suite name');
            console.log(`Running ${suite} browser checks`);
            const child = spawn(process.execPath, [path.join(__dirname, `e2e-${suite}.js`)], {
                stdio: 'inherit', env: { ...process.env, BASE: `http://127.0.0.1:${server.address().port}/`, KIT_BASE: kitServer ? `http://127.0.0.1:${kitServer.address().port}/` : '' },
            });
            const timeout = setTimeout(() => child.kill('SIGTERM'), 240000);
            const [code] = await once(child, 'exit'); clearTimeout(timeout);
            if (code !== 0) throw Error(`${suite} failed (${code})`);
        }
    } finally {
        if (kitServer) { kitServer.closeAllConnections(); await new Promise(resolve => kitServer.close(resolve)); }
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        if (kitAssets) require('node:fs').rmSync(kitAssets, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
