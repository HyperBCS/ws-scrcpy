// Run with: IOS_UNLOCK_FAST=1 node --test scripts/test-ios-unlock.js
// The scheduled unlock driver and scheduler (src/server/appl-device/services/UnlockDriver.ts,
// UnlockScheduler.ts) against scripts/fixtures/fake-pymobiledevice3.js, with FAKE_LOG as the
// oracle like scripts/test-coredevice.js; no device required.
// Placeholder until W2 lands: the file is registered in `npm test` so the suite shape is fixed.
const { test } = require('node:test');

test.todo('UnlockDriver and UnlockScheduler: HID sequence, skip rules, retry and push (W2)');
