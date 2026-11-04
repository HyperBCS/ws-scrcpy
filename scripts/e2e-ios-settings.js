/* eslint-disable */
// BASE=http://127.0.0.1:8000 node scripts/e2e-ios-settings.js
// The iPhone settings panel (Settings button on the iOS card, scheduled unlock rows, passcode
// field) against fixture sockets: every tracker command is captured in the browser, nothing
// reaches a phone. Runs under scripts/test-browser.js as the `ios-settings` suite.
// Placeholder until W3 lands: it only confirms the suite is wired and exits 0.
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';

(async () => {
    console.log('PASS iOS settings placeholder (no checks yet) against', BASE);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
