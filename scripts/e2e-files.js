/* eslint-disable */
// BASE=http://127.0.0.1:8000 E2E_OUT=/tmp/ws-scrcpy-files node scripts/e2e-files.js
// Exercises the real nested FSLS/SEND protocol against an in-memory fixture only. Folder
// operations (MKDR/MOVE/COPY/DELE) are answered by the fixture: no device is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-files';
const UDID = 'files-fixture';
const ROOT = '/data/local/tmp';
function frame(type, id, payload = Buffer.alloc(0)) {
    const buffer = Buffer.alloc(5 + payload.length);
    buffer[0] = type;
    buffer.writeUInt32LE(id, 1);
    payload.copy(buffer, 5);
    return buffer;
}
function close(id, code = 1000) {
    const data = Buffer.alloc(6);
    data.writeUInt16LE(code);
    return frame(8, id, data);
}
function stat(mode, size = 0) {
    const data = Buffer.alloc(16);
    data.write('STAT');
    data.writeUInt32LE(mode, 4);
    data.writeUInt32LE(size, 8);
    data.writeUInt32LE(1700000000, 12);
    return data;
}
function dent(name, mode, size = 0) {
    const text = Buffer.from(name);
    const data = Buffer.alloc(20 + text.length);
    data.write('DENT');
    data.writeUInt32LE(mode, 4);
    data.writeUInt32LE(size, 8);
    data.writeUInt32LE(1700000000, 12);
    data.writeUInt32LE(text.length, 16);
    text.copy(data, 20);
    return data;
}
function fail(message) {
    const text = Buffer.from(message);
    const data = Buffer.alloc(8 + text.length);
    data.write('FAIL');
    data.writeUInt32LE(text.length, 4);
    text.copy(data, 8);
    return data;
}
const DIR = 0o40755;
const FILE = 0o100644;
/** Reads one `length(u32 LE) + utf8` field, the framing the client uses for every path. */
function readString(data, offset) {
    const length = data.readUInt32LE(offset);
    return { value: data.subarray(offset + 4, offset + 4 + length).toString('utf8'), offset: offset + 4 + length };
}
async function fixture(page) {
    const files = new Map([
        [ROOT + '/notes.txt', Buffer.from('Mock download contents\n')],
        [ROOT + '/photo.png', Buffer.alloc(2048)],
        [ROOT + '/.hidden-cache', Buffer.from('x')],
    ]);
    const dirs = new Set(['/', '/data', '/data/local', ROOT, ROOT + '/empty', ROOT + '/denied', ROOT + '/archive']);
    const traffic = {
        requests: [], operations: [], closed: [], fsChannels: 0, uploads: [], hold: false, pending: null,
        holdList: false, releaseList: null,
    };
    await page.routeWebSocket('**', (socket) => {
        const fileRoots = new Set();
        const uploads = new Map();
        let nextPush = 1;
        const json = (id, data) => socket.send(frame(32, id, Buffer.from(JSON.stringify(data))));
        socket.onMessage((raw) => {
            const buffer = Buffer.from(raw);
            const type = buffer[0];
            const id = buffer.readUInt32LE(1);
            const payload = buffer.subarray(5);
            if (type === 4) {
                const code = payload.subarray(0, 4).toString();
                if (code === 'HSTS') json(id, { id: -1, type: 'hosts', data: { local: [{ type: 'android' }] } });
                if (code === 'GTRC')
                    json(id, {
                        id: -1,
                        type: 'devicelist',
                        data: {
                            id: 'files-tracker',
                            name: 'Fixture host',
                            list: [
                                {
                                    udid: UDID,
                                    state: 'device',
                                    pid: 42,
                                    interfaces: [],
                                    'ro.product.model': 'Files test phone',
                                    'ro.product.manufacturer': 'Fixture',
                                    'ro.build.version.sdk': '36',
                                    'screen.power': 'on',
                                    'device.awake': true,
                                },
                            ],
                        },
                    });
                if (code === 'FSLS') {
                    fileRoots.add(id);
                    traffic.fsChannels++;
                }
            } else if (type === 8) {
                traffic.closed.push({ root: id });
            } else if (type === 64 && fileRoots.has(id)) {
                const innerType = payload[0],
                    channel = payload.readUInt32LE(1),
                    data = payload.subarray(5);
                const send = (body) => socket.send(frame(64, id, frame(16, channel, body)));
                const end = (code = 1000) => socket.send(frame(64, id, close(channel, code)));
                if (innerType === 8) {
                    traffic.closed.push({ root: id, channel });
                    return;
                }
                if (innerType === 4) {
                    const cmd = data.subarray(0, 4).toString();
                    if (cmd === 'SEND') {
                        uploads.set(channel, { id: nextPush++, chunks: [] });
                        return;
                    }
                    if (cmd === 'MKDR' || cmd === 'MOVE' || cmd === 'COPY' || cmd === 'DELE') {
                        const operation = { cmd, paths: [] };
                        if (cmd === 'DELE') {
                            let offset = 8;
                            for (let i = 0; i < data.readUInt32LE(4); i++) {
                                const item = readString(data, offset);
                                offset = item.offset;
                                operation.paths.push(item.value);
                            }
                            operation.paths.forEach((target) => {
                                files.delete(target);
                                dirs.delete(target);
                            });
                        } else if (cmd === 'MKDR') {
                            operation.paths.push(readString(data, 4).value);
                            dirs.add(operation.paths[0]);
                        } else {
                            const from = readString(data, 4);
                            const to = readString(data, from.offset);
                            operation.paths.push(from.value, to.value);
                            if (from.value.endsWith('/denied')) {
                                traffic.operations.push(operation);
                                send(fail('Operation not permitted by fixture'));
                                end();
                                return;
                            }
                            if (files.has(from.value)) {
                                files.set(to.value, files.get(from.value));
                                if (cmd === 'MOVE') files.delete(from.value);
                            } else if (dirs.has(from.value)) {
                                dirs.add(to.value);
                                if (cmd === 'MOVE') dirs.delete(from.value);
                            }
                        }
                        traffic.operations.push(operation);
                        send(Buffer.from('DONE'));
                        end();
                        return;
                    }
                    const destination = data.subarray(8, 8 + data.readUInt32LE(4)).toString();
                    traffic.requests.push({ cmd, destination });
                    if (cmd === 'STAT') {
                        send(
                            stat(
                                dirs.has(destination) ? DIR : files.has(destination) ? FILE : 0,
                                files.get(destination)?.length || 0,
                            ),
                        );
                        end();
                    } else if (cmd === 'LIST') {
                        if (traffic.holdList) {
                            traffic.releaseList = () => {
                                traffic.releaseList = null;
                                if (destination === '/') {
                                    send(dent('data', DIR));
                                    send(dent('sdcard', 0o120777));
                                }
                                end(0);
                            };
                            return;
                        }
                        if (destination === '/') {
                            send(dent('data', DIR));
                            end(0);
                            return;
                        }
                        if (destination.endsWith('/denied')) {
                            send(fail('Permission denied by fixture'));
                            end();
                            return;
                        }
                        for (const directory of dirs)
                            if (path.posix.dirname(directory) === destination)
                                send(dent(path.posix.basename(directory), DIR));
                        for (const [file, bytes] of files)
                            if (path.posix.dirname(file) === destination)
                                send(dent(path.posix.basename(file), FILE, bytes.length));
                        if (destination === ROOT)
                            send(dent('a_very_long_file_name_'.repeat(5) + '.txt', FILE, 123456));
                        end(0);
                    } else if (cmd === 'RECV') {
                        send(Buffer.concat([Buffer.from('DATA'), files.get(destination) || Buffer.alloc(0)]));
                        send(Buffer.from('DONE'));
                        end();
                    }
                } else if (innerType === 16 && uploads.has(channel)) {
                    const upload = uploads.get(channel);
                    const state = data[3];
                    const reply = (code) => {
                        const response = Buffer.alloc(3);
                        response.writeInt16BE(upload.id);
                        response.writeInt8(code, 2);
                        send(response);
                    };
                    if (state === 0) {
                        if (traffic.hold) {
                            traffic.pending = { root: id, channel };
                            return;
                        }
                        reply(1);
                    } else if (state === 1) {
                        upload.path = data.subarray(10, 10 + data.readUInt16BE(8)).toString();
                        upload.size = data.readUInt32BE(4);
                        traffic.uploads.push(upload.path);
                        reply(0);
                    } else if (state === 2) {
                        upload.chunks.push(data.subarray(8, 8 + data.readUInt32BE(4)));
                        reply(0);
                    } else if (state === 3) {
                        files.set(upload.path, Buffer.concat(upload.chunks));
                        reply(0);
                        end();
                    }
                }
            }
        });
    });
    return { files, dirs, traffic };
}

const row = (page, name) => page.locator(`.fx-row[data-name="${name}"]`);
// Ctrl+click toggles one row's selection on every pointer type, so a single helper covers all
// five layouts. Touch-only selection (Select mode plus checkboxes) is exercised separately.
// The toolbar exists on a desktop; a phone reaches the same commands through the Actions menu.
async function command(page, button, item = button) {
    const toolbar = page.locator('.fx-commands').getByRole('button', { name: button, exact: true });
    if (await toolbar.isVisible()) return toolbar.click();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.locator('.fx-menu').waitFor();
    await page.locator('.fx-menu').getByRole(item === 'Select items' ? 'menuitemcheckbox' : 'menuitem', { name: item, exact: true }).click();
}
async function openViewMenu(page) {
    await command(page, 'View', 'View options…');
    await page.locator('.fx-menu [data-menu="view"]').first().waitFor();
}
async function fillFilter(page, text) {
    const input = page.locator('.fx-filter-input');
    if (!(await input.isVisible())) await page.getByRole('button', { name: 'Filter this folder', exact: true }).click();
    await input.fill(text);
}

// A mouse selects on one click and opens on two; a touch tap opens immediately.
async function open(page, name) {
    const anchor = page.locator(`.fx-row[data-name="${name}"] .entry-name a`);
    const coarse = await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
    if (coarse) await anchor.click();
    else await anchor.dblclick();
}

async function select(page, ...names) {
    await page.locator('.fx-items').press('Escape');
    for (const name of names) await row(page, name).locator('.entry-name a').click({ modifiers: ['Control'] });
    await page.waitForFunction(
        (count) => document.querySelectorAll('.fx-row.selected').length === count,
        names.length,
    );
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        for (const [label, width, height, touch] of [
            ['phone320', 320, 568, true],
            // iPhone 17 Pro Max, the owner's phone: 440x956 CSS pixels in both orientations.
            ['iphone17pm', 440, 956, true],
            ['iphone17pm-landscape', 956, 440, true],
            ['desktop', 1280, 900, false],
            ['wide', 1600, 900, false],
        ]) {
            const context = await browser.newContext({
                viewport: { width, height },
                isMobile: touch,
                hasTouch: touch,
                acceptDownloads: true,
                colorScheme: 'dark',
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            const { files, dirs, traffic } = await fixture(page);
            const url = new URL(BASE);
            url.hash = `!${new URLSearchParams({ action: 'list-files', udid: UDID, path: ROOT })}`;
            await page.goto(url.toString());
            await page.getByRole('link', { name: 'Download notes.txt', exact: true }).waitFor();
            await page.locator('.tool-connection.connected').waitFor({ state: 'attached' });
            assert.equal(await page.locator('.file-listing-client').count(), 1, 'one embedded client');
            assert.equal(await page.locator('.stream-header').count(), 1, 'shared tool header remains visible');
            assert.equal(
                await page.locator('.tool-navigation button').allInnerTexts().then((list) => list.join(',')),
                'Files,Shell',
                'the tools navigation offers Files and Shell only',
            );

            // Layout: nothing may overflow sideways, and touch builds keep 44px targets.
            const geometry = await page.locator('.file-listing-client').evaluate((el) => ({
                width: el.clientWidth,
                scrollWidth: el.scrollWidth,
                doc: document.documentElement.scrollWidth,
                viewport: innerWidth,
            }));
            assert(geometry.scrollWidth <= geometry.width + 1, 'long names do not widen Files');
            assert(geometry.doc <= geometry.viewport + 1, 'no document overflow');
            // A phone shows only the address bar, history and two icon buttons; the command bar
            // is a desktop affair.
            const upload = page.getByRole('button', { name: 'Upload files to this folder', exact: true });
            const actions = page.getByRole('button', { name: 'Actions', exact: true });
            if (width <= 700) {
                assert.equal(await upload.isVisible(), false, 'phone hides the command bar');
                assert.equal(await page.locator('.fx-commands').isVisible(), false, 'phone hides the command bar');
                const address = await page.locator('.fx-address').boundingBox();
                const explorer = await page.locator('.file-explorer').boundingBox();
                assert(address.width >= explorer.width - 16, 'the address bar takes a whole line on a phone');
                const actionsBox = await actions.boundingBox();
                assert(actionsBox.height >= 44 && actionsBox.width >= 44, `actions target ${actionsBox.height}`);
                assert.equal(await page.locator('.fx-filter-input').isVisible(), false, 'filter hides until asked for');
            } else {
                assert.equal(await actions.isVisible(), false, 'desktop keeps the command bar, not the Actions menu');
                const uploadBox = await upload.boundingBox();
                assert(uploadBox.height >= (touch ? 44 : 28), `upload target ${uploadBox.height}`);
            }
            const slashes = await page.locator('.fx-breadcrumb').evaluateAll((navs) =>
                Array.from(navs[0].querySelectorAll('.fx-crumb-separator')).map((el) => getComputedStyle(el).fontFamily),
            );
            const rootCrumb = page.locator('.fx-crumb-root');
            assert.equal(await rootCrumb.innerText(), '/', 'the root crumb is a slash');
            const rootFace = await rootCrumb.evaluate((el) => getComputedStyle(el).fontFamily);
            assert(slashes.every((family) => family === rootFace), 'the root slash and every separator share one face');
            assert.equal(await page.locator('.fx-crumb-ellipsis').count(), 0, 'the full path is always shown');
            assert.equal(
                (await page.locator('.fx-crumb').allInnerTexts()).join(' '),
                '/ data local tmp',
                'every segment of the path is a crumb',
            );
            // The home button lives with the navigation buttons, never inside the address box
            // (below 360px it yields its slot; the "/" crumb still reaches the root).
            assert.equal(await page.locator('.fx-address .fx-home').count(), 0, 'home is outside the address box');
            assert.equal(await page.locator('.fx-history .fx-home').count(), 1, 'home sits with navigation');
            // Quick access is a sidebar where it fits and the Places menu everywhere else.
            const sidebar = page.locator('.fx-places');
            if (await sidebar.isVisible()) {
                const places = await page.locator('.fx-place').evaluateAll((items) =>
                    items.map((item) => item.getBoundingClientRect().height),
                );
                assert(places.length >= 8, 'the quick access sidebar lists the common device folders');
                assert.equal(await page.getByRole('button', { name: 'Quick access' }).isVisible(), false);
            } else {
                await page.getByRole('button', { name: 'Quick access', exact: true }).click();
                const places = await page.locator('.fx-menu [data-menu="place"]').evaluateAll((items) =>
                    items.map((item) => item.getBoundingClientRect().height),
                );
                assert(places.length >= 8, 'the Places menu lists the common device folders');
                if (touch) assert(places.every((height) => height >= 44), 'Places rows are touch sized');
                await page.keyboard.press('Escape');
                await page.locator('.fx-menu').waitFor({ state: 'hidden' });
            }
            assert(
                (await page.locator('.fx-crumb[aria-current="page"]').innerText()) === 'tmp',
                'the breadcrumb marks the current folder',
            );
            // Hidden items are off by default, like Explorer.
            assert.equal(await row(page, '.hidden-cache').count(), 0, 'dotfiles stay hidden by default');
            assert(
                (await page.locator('.fx-counts').innerText()).includes('hidden'),
                'the status bar admits how many items are hidden',
            );
            const mountBox = await page.locator('.tool-mount').boundingBox();
            const firstRow = await page.locator('.fx-row').first().boundingBox();
            if (process.env.FX_MEASURE)
                console.log(
                    label,
                    JSON.stringify(
                        await page.evaluate(() => {
                            const out = { viewport: innerHeight };
                            for (const sel of ['.stream-header','.tool-navigation','.tool-mount','.fx-chrome','.fx-bar-address','.fx-bar-commands','.fx-places','.fx-items','.fx-statusbar','thead','.fx-row']) {
                                const el = document.querySelector(sel);
                                out[sel] = el ? Math.round(el.getBoundingClientRect().height) : null;
                            }
                            return out;
                        }),
                    ),
                );
            assert(firstRow.y + 44 < mountBox.y + mountBox.height, 'initial viewport exposes a complete file target');
            await page.screenshot({ path: path.join(OUT, label + '-files.png') });

            // View menu: layouts, sorting and hidden items all persist through the menu.
            await openViewMenu(page);
            await page.getByRole('menuitemcheckbox', { name: 'Hidden items' }).click();
            await row(page, '.hidden-cache').waitFor();
            await page.getByRole('menuitemradio', { name: 'Tiles' }).click();
            await page.waitForFunction(() => document.querySelector('.file-explorer').dataset.view === 'tiles');
            await page.screenshot({ path: path.join(OUT, label + '-tiles.png') });
            await page.getByRole('menuitemradio', { name: 'Details' }).click();
            await page.getByRole('menuitemcheckbox', { name: 'Hidden items' }).click();
            await page.keyboard.press('Escape');
            await page.locator('.fx-menu').waitFor({ state: 'hidden' });
            assert.equal(await row(page, '.hidden-cache').count(), 0, 'hidden items toggle back off');

            // Sorting: folders always lead, and both the View menu and the (wide-layout) column
            // headers change the order.
            const names = async () => page.locator('.fx-row .fx-name').allInnerTexts();
            const biggest = 'a_very_long_file_name_'.repeat(5) + '.txt';
            assert.deepEqual((await names()).slice(0, 3), ['archive', 'denied', 'empty'], 'folders sort first');
            await openViewMenu(page);
            await page.getByRole('menuitemradio', { name: 'Size', exact: true }).click();
            await page.keyboard.press('Escape');
            const bySize = await names();
            assert.deepEqual(bySize.slice(0, 3), ['archive', 'denied', 'empty'], 'folders lead every sort');
            assert.equal(bySize.at(-1), biggest, 'largest file sorts last');
            await openViewMenu(page);
            await page.getByRole('menuitemradio', { name: 'Descending', exact: true }).click();
            await page.keyboard.press('Escape');
            assert.equal((await names())[3], biggest, 'Descending flips the order');
            const headerSort = page.getByRole('button', { name: 'Name', exact: true });
            if (await headerSort.isVisible()) {
                await headerSort.click();
                assert.deepEqual(
                    (await names()).slice(0, 3),
                    ['archive', 'denied', 'empty'],
                    'a newly chosen column starts ascending',
                );
                await headerSort.click();
                assert.deepEqual(
                    (await names()).slice(0, 3),
                    ['empty', 'denied', 'archive'],
                    'clicking the same header flips the direction',
                );
                await headerSort.click();
            } else {
                await openViewMenu(page);
                await page.getByRole('menuitemradio', { name: 'Name', exact: true }).click();
                await page.getByRole('menuitemradio', { name: 'Ascending', exact: true }).click();
                await page.keyboard.press('Escape');
            }
            assert.deepEqual((await names()).slice(0, 3), ['archive', 'denied', 'empty'], 'order is restored');

            // Filter narrows the current folder without touching the device.
            const requestsBeforeFilter = traffic.requests.length;
            await fillFilter(page, 'notes');
            await page.waitForFunction(() => document.querySelectorAll('.fx-row').length === 1);
            assert.equal(traffic.requests.length, requestsBeforeFilter, 'filtering is local to the listing');
            assert((await page.locator('.fx-counts').innerText()).includes('of'), 'the count shows the filtered total');
            await fillFilter(page, '');
            await row(page, 'photo.png').waitFor();

            // Navigation: folders, errors, Up, the browser's own Back and the history buttons.
            const channelsBefore = traffic.fsChannels;
            await open(page, 'empty');
            await page.getByText('This folder is empty.', { exact: true }).first().waitFor();
            assert.equal(await page.locator('.fx-row:not(.fx-empty-row)').count(), 0, 'empty folder clears old entries');
            assert.equal(traffic.fsChannels, channelsBefore, 'directory navigation preserves client connection');
            await page.getByRole('button', { name: 'Back', exact: true }).click();
            await row(page, 'notes.txt').waitFor();
            await page.getByRole('button', { name: 'Forward', exact: true }).click();
            await page.getByText('This folder is empty.', { exact: true }).first().waitFor();
            await page.goBack();
            await row(page, 'notes.txt').waitFor();
            assert.equal(traffic.fsChannels, channelsBefore, 'browser Back keeps the same Files client');
            assert.equal(
                await page.evaluate(() => performance.getEntriesByType('navigation').length),
                1,
                'folder changes never navigate the page',
            );
            // History survives a page reload: Forward is still offered and still works.
            await page.reload();
            await page.locator('.file-explorer[data-listing="ready"]').waitFor();
            await row(page, 'notes.txt').waitFor();
            assert.equal(
                await page.getByRole('button', { name: 'Forward', exact: true }).isDisabled(),
                false,
                'Forward remembers the folder after a reload',
            );
            await page.getByRole('button', { name: 'Forward', exact: true }).click();
            await page.getByText('This folder is empty.', { exact: true }).first().waitFor();
            await page.getByRole('button', { name: 'Back', exact: true }).click();
            await row(page, 'notes.txt').waitFor();
            await open(page, 'denied');
            await page.getByRole('alert').filter({ hasText: 'Permission denied by fixture' }).waitFor();
            await page.getByRole('button', { name: 'Up one folder', exact: true }).click();
            await row(page, 'notes.txt').waitFor();

            // Home navigates to the root, and the folder switch keeps the old rows on screen until
            // the new ones arrive instead of flashing an empty list.
            traffic.holdList = true;
            const homeButton = page.locator('.fx-history .fx-home');
            if (await homeButton.isVisible()) await homeButton.click();
            else await page.locator('.fx-crumb-root').click();
            await page.locator('.file-explorer.fx-loading').waitFor();
            assert(
                (await page.locator('.fx-row[data-name]').count()) > 0,
                'previous rows stay visible while the next folder loads',
            );
            traffic.holdList = false;
            traffic.releaseList?.();
            await page.locator('.fx-crumb-root[aria-current="page"]').waitFor();
            await page.locator('.file-explorer[data-listing="ready"]').waitFor();
            assert.equal((await page.locator('.fx-crumb').allInnerTexts()).join(''), '/', 'Home opened the device root');
            await open(page, 'data');
            await open(page, 'local');
            await open(page, 'tmp');
            await row(page, 'notes.txt').waitFor();

            // Address bar: the pencil swaps the crumbs for a field holding the whole path, already
            // selected, so typing replaces it; Enter navigates there and the crumbs come back.
            await page.getByRole('button', { name: 'Type a folder path', exact: true }).click();
            const addressInput = page.locator('.fx-address-input');
            assert.equal(await page.locator('.fx-breadcrumb').isVisible(), false, 'the crumbs give way to the field');
            assert.equal(await page.locator('.fx-address-clear').count(), 0, 'no clear button');
            assert.deepEqual(
                await addressInput.evaluate((el) => [el.selectionStart, el.selectionEnd, el.value.length]),
                [0, ROOT.length, ROOT.length],
                'editing selects the entire path',
            );
            await page.locator('.fx-address-input').fill(ROOT + '/archive');
            await page.locator('.fx-address-input').press('Enter');
            // The hash carries the path percent-encoded, so decode before comparing.
            await page.waitForFunction((root) => decodeURIComponent(location.hash).includes(root + '/archive'), ROOT);
            await page.locator('.fx-crumb[aria-current="page"]').filter({ hasText: 'archive' }).waitFor();
            assert.equal(await addressInput.isVisible(), false, 'the field leaves once the path is entered');
            await page.getByRole('button', { name: 'Up one folder', exact: true }).click();
            await row(page, 'notes.txt').waitFor();

            // New folder, rename and delete each send one framed operation and re-list.
            await command(page, 'New folder');
            await page.locator('.fx-dialog input[name="value"]').fill('reports');
            await page.getByRole('button', { name: 'Create', exact: true }).click();
            await row(page, 'reports').waitFor();
            assert.deepEqual(
                traffic.operations.at(-1),
                { cmd: 'MKDR', paths: [ROOT + '/reports'] },
                'New folder sends one MKDR for the current folder',
            );

            await select(page, 'reports');
            await command(page, 'Rename');
            await page.locator('.fx-dialog input[name="value"]').fill('reports-2026');
            await page.getByRole('button', { name: 'Rename', exact: true }).last().click();
            await row(page, 'reports-2026').waitFor();
            assert.deepEqual(traffic.operations.at(-1), {
                cmd: 'MOVE',
                paths: [ROOT + '/reports', ROOT + '/reports-2026'],
            });

            // Copy and paste into another folder, then move it back with Cut.
            await select(page, 'notes.txt');
            await command(page, 'Copy');
            await open(page, 'archive');
            await page.locator('.fx-crumb[aria-current="page"]').filter({ hasText: 'archive' }).waitFor();
            await command(page, 'Paste');
            await row(page, 'notes.txt').waitFor();
            assert.deepEqual(traffic.operations.at(-1), {
                cmd: 'COPY',
                paths: [ROOT + '/notes.txt', ROOT + '/archive/notes.txt'],
            });
            assert(files.has(ROOT + '/notes.txt'), 'Copy leaves the original in place');

            // Delete needs a confirmation and removes only the selected item.
            await select(page, 'notes.txt');
            await command(page, 'Delete');
            await page.getByText('This cannot be undone.', { exact: false }).waitFor();
            await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
            await page.getByText('This folder is empty.', { exact: true }).first().waitFor();
            assert.deepEqual(traffic.operations.at(-1), { cmd: 'DELE', paths: [ROOT + '/archive/notes.txt'] });
            await page.getByRole('button', { name: 'Up one folder', exact: true }).click();
            await row(page, 'notes.txt').waitFor();

            // A refused operation reports the device's own message and changes nothing.
            const operationsBeforeRefusal = traffic.operations.length;
            await select(page, 'denied');
            await command(page, 'Rename');
            await page.locator('.fx-dialog input[name="value"]').fill('allowed');
            await page.getByRole('button', { name: 'Rename', exact: true }).last().click();
            await page.getByRole('alert').filter({ hasText: 'Operation not permitted by fixture' }).waitFor();
            assert.equal(traffic.operations.length, operationsBeforeRefusal + 1, 'one attempt, no retry');
            assert(dirs.has(ROOT + '/denied'), 'the refused folder keeps its name');

            // A cancelled dialog sends nothing at all.
            const operationsBeforeCancel = traffic.operations.length;
            await command(page, 'New folder');
            await page.locator('.fx-dialog input[name="value"]').fill('never-created');
            await page.getByRole('button', { name: 'Cancel', exact: true }).click();
            await page.locator('.fx-dialog').waitFor({ state: 'hidden' });
            assert.equal(traffic.operations.length, operationsBeforeCancel, 'Cancel sends no operation');

            // Multi-select: the per-row menu, then a two-item delete.
            await command(page, 'Select', 'Select items');
            await page.locator('.fx-row[data-name="photo.png"] .fx-check').click();
            await page.locator('.fx-row[data-name="empty"] .fx-check').click();
            await page.waitForFunction(() => document.querySelectorAll('.fx-row.selected').length === 2);
            assert(
                (await page.locator('.fx-counts').innerText()).includes('2 selected'),
                'the status bar counts the selection',
            );
            await command(page, 'Delete');
            await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
            await page.locator('.fx-row[data-name="photo.png"]').waitFor({ state: 'detached' });
            assert.deepEqual(new Set(traffic.operations.at(-1).paths), new Set([ROOT + '/photo.png', ROOT + '/empty']));
            assert.equal(traffic.operations.at(-1).cmd, 'DELE');
            await command(page, 'Select', 'Select items');

            // Properties reads the stat data already in the listing.
            await page.locator('.fx-row[data-name="notes.txt"] .fx-row-menu').click();
            await page.getByRole('menuitem', { name: 'Properties', exact: true }).click();
            const properties = await page.locator('.fx-properties').innerText();
            assert(properties.includes('notes.txt') && properties.includes(ROOT), 'properties name the exact path');
            assert(properties.includes('rw-r--r--'), 'properties show the device permissions');
            await page.getByRole('button', { name: 'Close', exact: true }).click();
            await page.locator('.fx-dialog').waitFor({ state: 'hidden' });

            // Download and upload keep the original byte-level protocol.
            const downloadPromise = page.waitForEvent('download');
            await open(page, 'notes.txt');
            const download = await downloadPromise;
            assert.equal(download.suggestedFilename(), 'notes.txt');
            assert.equal(
                fs.readFileSync(await download.path(), 'utf8'),
                'Mock download contents\n',
                'download bytes preserved',
            );
            const chooserPromise = page.waitForEvent('filechooser');
            await command(page, 'Upload files to this folder', 'Upload files');
            const chooser = await chooserPromise;
            await chooser.setFiles({
                name: 'mobile-upload.txt',
                mimeType: 'text/plain',
                buffer: Buffer.from('Picker upload bytes'),
            });
            await page.getByRole('link', { name: 'Download mobile-upload.txt', exact: true }).waitFor();
            assert.equal(
                files.get(ROOT + '/mobile-upload.txt').toString(),
                'Picker upload bytes',
                'picker uses current directory and unchanged SEND protocol',
            );
            await page
                .locator('input[type=file]')
                .setInputFiles({ name: 'empty-file.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
            await page.getByRole('link', { name: 'Download empty-file.txt', exact: true }).waitFor();
            assert.equal(
                files.get(ROOT + '/empty-file.txt').length,
                0,
                'empty picker file completes without an APPEND packet',
            );
            traffic.hold = true;
            await page.locator('input[type=file]').setInputFiles({
                name: 'pending-upload.txt',
                mimeType: 'text/plain',
                buffer: Buffer.from('Never sent'),
            });
            await page.waitForFunction(() =>
                document.querySelector('.file-listing-upload-progress')?.textContent.includes('pending-upload'),
            );
            await page.getByRole('button', { name: 'Back to devices', exact: true }).click();
            await page.locator('.file-listing-client').waitFor({ state: 'detached' });
            assert(traffic.pending, 'fixture left allocation pending');
            assert(
                traffic.closed.some(
                    (item) => item.root === traffic.pending.root && item.channel === traffic.pending.channel,
                ),
                'unmount closes upload channel before ID allocation',
            );
            assert(
                traffic.closed.some((item) => item.root === traffic.pending.root && item.channel === undefined),
                'unmount closes Files parent channel',
            );
            assert(!files.has(ROOT + '/pending-upload.txt'), 'pending upload never wrote bytes');
            assert.equal(
                await page.locator('.fx-menu, .fx-dialog[open]').count(),
                0,
                'menus and dialogs leave with the explorer',
            );
            assert.deepEqual(errors, [], 'no browser errors');
            await context.close();
            console.log(
                'PASS',
                label,
                'explorer layout, views, sorting, filtering, history, folder operations, transfers and cleanup',
            );
        }
    } finally {
        await browser.close();
    }
}
if (require.main === module)
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });

module.exports = { fixture };
