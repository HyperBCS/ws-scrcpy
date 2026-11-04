// Run with: node --test scripts/test-ios-settings-store.js
// The iPhone settings store (src/server/appl-device/services/IosSettingsStore.ts) and the four
// unlock commands in the iOS ControlCenter, against a temp data directory; no device required.
// Placeholder until W1 lands: the file is registered in `npm test` so the suite shape is fixed.
const { test } = require('node:test');

test.todo('IosSettingsStore: files, encryption round-trip, key handling and unlock commands (W1)');
