/* eslint-disable */
// BASE=http://127.0.0.1:8000 SERIAL=<udid> node scripts/e2e-files-device.js
//
// The only Files test that touches real hardware. Every listing is compared against `adb ls`, and
// every mutation happens inside one uniquely named scratch folder under /data/local/tmp -- the
// directory ws-scrcpy already owns -- which the test refuses to run over and removes at the end.
// Nothing outside that folder is created, renamed or deleted.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SERIAL = process.env.SERIAL;
const SCRATCH = 'ws-scrcpy-explorer-check';
const adb = (...args) => execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8' }).trim();
const exists = (p) => adb('shell', `[ -e "${p}" ] && echo yes || echo no`) === 'yes';
// The toolbar exists on a desktop; a phone reaches the same commands through the Actions menu.
async function command(page, button, item = button) {
    const toolbar = page.locator('.fx-commands').getByRole('button', { name: button, exact: true });
    if (await toolbar.isVisible()) return toolbar.click();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.locator('.fx-menu').waitFor();
    await page.locator('.fx-menu').getByRole('menuitem', { name: item, exact: true }).click();
}

(async () => {
    assert(SERIAL, 'SERIAL is required');
    // Never run against a leftover from an interrupted attempt.
    assert(!exists(`/data/local/tmp/${SCRATCH}`), 'scratch folder must not exist before the test');
    assert(!exists(`/data/local/tmp/${SCRATCH}-renamed`), 'renamed scratch folder must not exist before the test');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = new URL(BASE);
    url.hash = '!' + new URLSearchParams({ action: 'list-files', udid: SERIAL, path: '/data/local/tmp' });
    await page.goto(url.toString());
    page.setDefaultTimeout(20000);
    await page.locator('.file-explorer').waitFor();
    console.log('explorer mounted');
    await page.locator('.tool-connection.connected').waitFor({ state: 'attached' });
    console.log('connected');
    await page.locator('.file-explorer[data-listing="ready"]').waitFor();
    console.log('listing settled');

    const shown = async () => (await page.locator('.fx-row[data-name]').evaluateAll((rows) => rows.map((r) => r.dataset.name))).sort();
    const onDevice = () =>
        adb('shell', 'ls -A /data/local/tmp')
            .split(/\s+/)
            .filter((n) => n && !n.startsWith('.'))
            .sort();
    assert.deepEqual(await shown(), onDevice(), '/data/local/tmp listing matches adb ls');
    console.log('PASS listing matches the device:', (await shown()).length, 'items');

    // New folder
    await command(page, 'New folder');
    await page.locator('.fx-dialog input[name="value"]').fill(SCRATCH);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator(`.fx-row[data-name="${SCRATCH}"]`).waitFor();
    assert(exists(`/data/local/tmp/${SCRATCH}`), 'the device really created the folder');
    console.log('PASS New folder created a real directory on the device');

    // Rename
    await page.locator(`.fx-row[data-name="${SCRATCH}"] .fx-row-menu`).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.locator('.fx-dialog input[name="value"]').fill(`${SCRATCH}-renamed`);
    await page.getByRole('button', { name: 'Rename', exact: true }).last().click();
    await page.locator(`.fx-row[data-name="${SCRATCH}-renamed"]`).waitFor();
    assert(exists(`/data/local/tmp/${SCRATCH}-renamed`) && !exists(`/data/local/tmp/${SCRATCH}`), 'the device renamed it');
    console.log('PASS Rename moved the real directory');

    // Upload a file into it, then read it back off the device.
    await page.locator(`.fx-row[data-name="${SCRATCH}-renamed"] .entry-name a`).click();
    await page.locator('.fx-crumb[aria-current="page"]').filter({ hasText: `${SCRATCH}-renamed` }).waitFor();
    await page.locator('.file-explorer[data-listing="ready"]').waitFor();
    await page.locator('input[type=file]').setInputFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('explorer upload\n') });
    await page.locator('.fx-row[data-name="hello.txt"]').waitFor();
    assert.equal(adb('shell', `cat /data/local/tmp/${SCRATCH}-renamed/hello.txt`), 'explorer upload', 'uploaded bytes landed on the device');
    console.log('PASS Upload wrote the real bytes into the new folder');

    // Download it back through the explorer.
    const download = page.waitForEvent('download');
    await page.locator('.fx-row[data-name="hello.txt"] .entry-name a').click();
    const file = await download;
    assert.equal(require('node:fs').readFileSync(await file.path(), 'utf8'), 'explorer upload\n', 'download round-trips');
    console.log('PASS Download round-tripped the file');

    // Properties reflect real device metadata.
    await page.locator('.fx-row[data-name="hello.txt"] .fx-row-menu').click();
    await page.getByRole('menuitem', { name: 'Properties', exact: true }).click();
    const properties = await page.locator('.fx-properties').innerText();
    assert(properties.includes('16 bytes'), `properties show the real size: ${properties}`);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    console.log('PASS Properties report the device size');

    // Delete the whole scratch folder from its parent.
    await page.getByRole('button', { name: 'Up one folder', exact: true }).click();
    await page.locator(`.fx-row[data-name="${SCRATCH}-renamed"]`).waitFor();
    await page.locator(`.fx-row[data-name="${SCRATCH}-renamed"] .fx-row-menu`).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await page.locator(`.fx-row[data-name="${SCRATCH}-renamed"]`).waitFor({ state: 'detached' });
    assert(!exists(`/data/local/tmp/${SCRATCH}-renamed`), 'the device removed the folder and its contents');
    console.log('PASS Delete removed the real directory tree');

    // Quick access reaches internal storage, read-only.
    await page.getByRole('button', { name: 'Quick access', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Internal storage', exact: true }).click();
    await page.locator('.fx-crumb[aria-current="page"]').filter({ hasText: 'sdcard' }).waitFor();
    await page.locator('.file-explorer[data-listing="ready"]').waitFor();
    const sdcard = (await page.locator('.fx-row[data-name]').evaluateAll((rows) => rows.map((r) => r.dataset.name))).sort();
    const sdcardDevice = adb('shell', 'ls -A /sdcard').split(/\s+/).filter((n) => n && !n.startsWith('.')).sort();
    assert.deepEqual(sdcard, sdcardDevice, '/sdcard listing matches adb ls');
    console.log('PASS Internal storage listing matches the device:', sdcard.length, 'items');

    assert.deepEqual(errors, [], 'no browser errors');
    await browser.close();
    console.log('PASS hardware file explorer checks complete; scratch folder removed');
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
