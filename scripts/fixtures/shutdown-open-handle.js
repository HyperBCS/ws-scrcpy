#!/usr/bin/env node
/* eslint-disable */
// For scripts/test-android-server.js: the real Shutdown handlers around one service that
// releases cleanly but leaves a listening socket open, the way a forgotten child process or
// stream socket would. Prints "harness ready", then waits for SIGTERM.
const path = require('node:path');
const net = require('node:net');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

const { Shutdown } = require(path.join(__dirname, '..', '..', 'src', 'server', 'Shutdown'));

Shutdown.EXIT_BACKSTOP_MS = 300;
const service = { getName: () => 'fixture service', start: async () => undefined, release() {} };
new Shutdown([service]).install();

net.createServer().listen(0, '127.0.0.1', () => console.log('harness ready'));
