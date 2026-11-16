// Serves built assets and a synthetic notification summary for isolated browser fixtures.
// Production never loads this server, and it does not expose any device middleware.
//
//   node scripts/test-browser.js [--jobs=N] [suite …]
//
// Each suite is its own process with its own browser and its own mocked phones, against one
// static server, so several run at once. --jobs=N (or TEST_BROWSER_JOBS=N) says how many;
// --jobs=1 runs them one after another. Every suite runs even when one fails, and the last
// lines name the ones that failed.
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const DEFAULTS = ['review-polish', 'notifications', 'motion', 'settings', 'sheets', 'switcher', 'unlock', 'tools', 'files', 'files-flows', 'files-kit', 'ios-typing', 'ios-settings', 'ios-reconnect', 'ios-input', 'audio-availability', 'confirm', 'sheet-chrome', 'home', 'android-stream', 'android-lifecycle', 'web-security', 'navigation', 'overlay-back', 'device-page', 'history-walk', 'kit', 'kit-sheet', 'kit-followups', 'phone-status', 'actions-sheet', 'controls', 'desktop-layout', 'screen-states', 'desktop-input', 'notification-inbox', 'ui-consistency', 'about-ui', 'show-touches', 'ios-colour', 'theme', 'atlas'];
const KIT_SUITES = ['kit', 'kit-sheet', 'kit-followups'];
/** One suite may take this long. A suite that takes longer is stopped and counts as failed. */
const SUITE_TIMEOUT = 240000;
/** How long each suite took last time, so the longest start first and the run ends sooner. */
const TIMES = path.join(os.tmpdir(), 'ws-scrcpy-browser-times.json');

/** The suites to run and how many at once, from the command line. */
function options(argv) {
    const suites = [];
    let jobs = Number(process.env.TEST_BROWSER_JOBS) || 0;
    for (const arg of argv) {
        const count = /^--jobs=(\d+)$/.exec(arg);
        if (count) {
            jobs = Number(count[1]);
        } else if (/^[a-z][a-z-]*$/.test(arg)) {
            suites.push(arg);
        } else {
            throw Error(`Invalid suite name or option: ${arg}`);
        }
    }
    // The suites wait more than they compute: one for each processor, and no more than sixteen.
    const fits = Math.max(1, Math.min(16, os.availableParallelism()));
    return { suites: suites.length ? suites : DEFAULTS, jobs: Math.max(1, jobs || fits) };
}

function lastTimes() {
    try {
        return JSON.parse(fs.readFileSync(TIMES, 'utf8'));
    } catch {
        return {};
    }
}

/** A static server on a free port of this machine. */
async function serve(root, routes = () => {}) {
    const app = express();
    app.get('/api/notifications/summary', (_req, res) => res.json({ sources: [], unread: 0, unreadBySource: {} }));
    app.use(express.static(root));
    routes(app);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
}

async function stop(server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}

const seconds = (value) => `${value.toFixed(1)} s`;

async function main() {
    const { suites, jobs } = options(process.argv.slice(2));
    const atOnce = Math.min(jobs, suites.length);
    // A Files download is a browser navigation, which page.route cannot answer. The body names what was asked for.
    const server = await serve(path.join(__dirname, '../dist/public'), (app) => app.get('/api/files/download', (req, res) =>
        res.attachment(path.posix.basename(String(req.query.path))).send(Buffer.from(`fixture download ${req.query.udid} ${req.query.path}`))));
    let kitServer;
    let kitAssets;
    const running = new Set();
    let stopping = false;
    // Stopped from outside: the suites go too, each closing its own browser.
    const stopAll = () => {
        stopping = true;
        running.forEach((child) => child.kill('SIGTERM'));
    };
    process.on('SIGINT', stopAll);
    process.on('SIGTERM', stopAll);
    try {
        if (suites.some((suite) => KIT_SUITES.includes(suite))) {
            // An explicit test-only build in a unique temporary directory. BASE stays on
            // dist/public even in mixed suites; no fixture asset can enter the deploy artifact.
            kitAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-kit-'));
            const build = spawn(process.execPath, [require.resolve('webpack/bin/webpack.js'), '--config',
                path.join(__dirname, '../webpack/ws-scrcpy.kit.ts')], {
                stdio: 'inherit', env: { ...process.env, KIT_FIXTURE_OUT: kitAssets },
            });
            const [code] = await once(build, 'exit');
            if (code !== 0) throw Error(`Kit fixture build failed (${code})`);
            kitServer = await serve(kitAssets);
        }
        const env = {
            ...process.env,
            BASE: `http://127.0.0.1:${server.address().port}/`,
            KIT_BASE: kitServer ? `http://127.0.0.1:${kitServer.address().port}/` : '',
        };
        /** One suite in its own process. Alone it writes as it goes; beside others, in one piece at its end. */
        const run = (suite) => new Promise((resolve) => {
            const started = Date.now();
            const alone = atOnce === 1;
            if (alone) console.log(`Running ${suite} browser checks`);
            const child = spawn(process.execPath, [path.join(__dirname, `e2e-${suite}.js`)], {
                stdio: alone ? 'inherit' : ['ignore', 'pipe', 'pipe'], env,
            });
            running.add(child);
            const output = [];
            child.stdout?.on('data', (chunk) => output.push(chunk));
            child.stderr?.on('data', (chunk) => output.push(chunk));
            let timedOut = false;
            const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, SUITE_TIMEOUT);
            child.on('close', (code) => {
                clearTimeout(timeout);
                running.delete(child);
                const took = (Date.now() - started) / 1000;
                const passed = code === 0;
                const end = passed ? `${suite} passed in ${seconds(took)}`
                    : timedOut ? `${suite} FAILED: stopped after ${SUITE_TIMEOUT / 1000} s`
                        : `${suite} FAILED (${code}) after ${seconds(took)}`;
                const text = Buffer.concat(output).toString();
                console.log(alone ? end : `Running ${suite} browser checks\n${text}${text && !text.endsWith('\n') ? '\n' : ''}${end}`);
                resolve({ suite, passed, took });
            });
        });
        const before = lastTimes();
        // The longest first; a suite with no time yet counts as long.
        const queue = suites.map((suite, index) => ({ suite, index }))
            .sort((a, b) => (before[b.suite] ?? Infinity) - (before[a.suite] ?? Infinity) || a.index - b.index)
            .map(({ suite }) => suite);
        const started = Date.now();
        const results = [];
        await Promise.all(Array.from({ length: atOnce }, async () => {
            while (queue.length && !stopping) {
                results.push(await run(queue.shift()));
            }
        }));
        const took = (Date.now() - started) / 1000;
        const failed = results.filter((result) => !result.passed).map((result) => result.suite);
        try {
            fs.writeFileSync(TIMES, JSON.stringify({ ...before, ...Object.fromEntries(
                results.filter((result) => result.passed).map((result) => [result.suite, Math.round(result.took)])) }));
        } catch {
            // The times only order the next run.
        }
        if (results.length > 1) {
            const slowest = [...results].sort((a, b) => b.took - a.took).slice(0, 5)
                .map((result) => `${result.suite} ${seconds(result.took)}`).join(', ');
            console.log(`${results.length} suites in ${seconds(took)}, ${atOnce} at a time: ${results.length - failed.length} passed, ${failed.length} failed. Slowest: ${slowest}`);
        }
        if (stopping) throw Error(`Stopped with ${queue.length} suites not run`);
        if (failed.length) throw Error(`Failed: ${failed.join(', ')}`);
    } finally {
        if (kitServer) await stop(kitServer);
        await stop(server);
        if (kitAssets) fs.rmSync(kitAssets, { recursive: true, force: true });
    }
}
main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
