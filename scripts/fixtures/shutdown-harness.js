#!/usr/bin/env node
// A stand-in for src/server/index.ts, for scripts/test-coredevice.js: one fake iPhone session, the
// real CoreDeviceRunner and the real Shutdown handlers, ended the way the mode says.
//   throw   an uncaught exception
//   reject  an unhandled promise rejection
//   signal  waits for the test to send signals
//   exit    process.exit(3) with no shutdown at all (only the runner's exit hook runs)
//   late    like signal, and on SIGTERM asks for a second phone's session once the runner has
//           been released; prints whether that was refused
// HARNESS_PYMOBILEDEVICE3 is the fake CLI. Prints "harness ready" once the session is up.
const path = require('node:path');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

const src = path.join(__dirname, '..', '..', 'src', 'server');
const { PyMobileDevice } = require(path.join(src, 'appl-device', 'services', 'PyMobileDevice'));
const { CoreDeviceRunner } = require(path.join(src, 'appl-device', 'services', 'CoreDeviceRunner'));
const { Shutdown } = require(path.join(src, 'Shutdown'));

const mode = process.argv[2];
PyMobileDevice.useBin(process.env.HARNESS_PYMOBILEDEVICE3);
process.env.IOS_SESSION_START_LIMIT = '0';

const runner = CoreDeviceRunner.getInstance();
const shutdown = new Shutdown([runner]);
shutdown.addWaiter({
    pending: () => CoreDeviceRunner.hasChildren(),
    closed: () => CoreDeviceRunner.childrenClosed(),
    budgetMs: () => CoreDeviceRunner.shutdownBudgetMs(),
});
// As in src/server/index.ts.
CoreDeviceRunner.setShutdownCheck(() => shutdown.isStopping());
if (mode !== 'exit') {
    shutdown.install();
}
if (mode === 'late') {
    // Added after `install()`, so it runs once Shutdown's own handler has released the runner.
    process.on('SIGTERM', () => {
        CoreDeviceRunner.getInstance()
            .acquire('iphone-late')
            .then(
                () => console.log('late acquire started'),
                (error) => console.log(`late acquire refused: ${error.message}`),
            );
    });
}

runner.acquire('iphone-harness').then(() => {
    console.log('harness ready');
    if (mode === 'throw') {
        setTimeout(() => {
            throw new Error('harness boom');
        }, 10);
    } else if (mode === 'reject') {
        Promise.reject(new Error('harness boom'));
    } else if (mode === 'exit') {
        process.exit(3);
    }
});
