const { settleMotion } = require('./ui-motion');
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
const LARGE = '/data/local/large';
const SHARED = '/sdcard/Download';
// The name the page header shows for the fixture phone; destructive questions repeat it.
const DEVICE = 'Fixture Files test phone';
function frame(type, id, payload = Buffer.alloc(0)) {
    const buffer = Buffer.alloc(5 + payload.length);
    buffer[0] = type;
    buffer.writeUInt32LE(id, 1);
    payload.copy(buffer, 5);
    return buffer;
}
function close(id, code = 1000, reason = '') {
    const text = Buffer.from(reason);
    const data = Buffer.alloc(6 + text.length);
    data.writeUInt16LE(code);
    data.writeUInt32LE(text.length, 2);
    text.copy(data, 6);
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
    const dirs = new Set(['/', '/data', '/data/local', ROOT, ROOT + '/empty', ROOT + '/denied', ROOT + '/archive', LARGE, '/sdcard', SHARED, SHARED + '/Camera']);
    files.set(SHARED + '/notes.txt', Buffer.from('Shared notes\n'));
    // Shared storage ignores case in names; everything else on the device does not.
    const folded = (target) => (target.startsWith('/sdcard/') ? target.toLowerCase() : target);
    const taken = (target) => {
        for (const file of files.keys()) if (folded(file) === folded(target)) return { file };
        for (const directory of dirs) if (folded(directory) === folded(target)) return { directory };
        return undefined;
    };
    // True sizes of files too large to hold in memory. LIST states them modulo 4 GiB, as adb does.
    const sizes = new Map([[LARGE + '/film.mkv', 5 * 1024 ** 3 + 7]]);
    files.set(LARGE + '/film.mkv', Buffer.alloc(0));
    files.set(LARGE + '/clip.mp4', Buffer.alloc(64));
    const traffic = {
        requests: [], operations: [], closed: [], fsChannels: 0, uploads: [], starts: [], hold: false, pending: null,
        holdList: false, releaseList: null, holdStat: false, releaseStat: null,
        // Uploads between START and their end, the most there ever were at once, and CANCELs.
        sending: new Set(), mostSending: 0, cancels: [],
        // While set, APPEND acknowledgements wait in `heldAppends` until `releaseAppends()`.
        holdAppends: false, heldAppends: [],
        releaseAppends() {
            const held = traffic.heldAppends.splice(0);
            held.forEach((release) => release());
        },
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
                    traffic.sending.delete(channel);
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
                            // Like the server: a taken name is refused unless the request ends
                            // with the replace byte, and a folder is never replaced.
                            if (data.length > to.offset && data[to.offset] === 1) operation.replace = true;
                            if (dirs.has(to.value) || (files.has(to.value) && !operation.replace)) {
                                traffic.operations.push(operation);
                                send(fail('An item with this name already exists.'));
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
                        const answer = () => {
                            send(
                                stat(
                                    dirs.has(destination) ? DIR : files.has(destination) ? FILE : 0,
                                    files.get(destination)?.length || 0,
                                ),
                            );
                            end();
                        };
                        if (traffic.holdStat) {
                            traffic.releaseStat = () => {
                                traffic.releaseStat = null;
                                answer();
                            };
                            return;
                        }
                        answer();
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
                                send(dent(path.posix.basename(file), FILE, (sizes.get(file) ?? bytes.length) % 2 ** 32));
                        if (destination === ROOT)
                            send(dent('a_very_long_file_name_'.repeat(5) + '.txt', FILE, 123456));
                        end(0);
                    } else if (cmd === 'SIZE') {
                        for (const [file, size] of sizes) {
                            if (path.posix.dirname(file) !== destination) continue;
                            const name = Buffer.from(path.posix.basename(file));
                            const record = Buffer.alloc(16 + name.length);
                            record.write('SIZE');
                            record.writeUInt32LE(size % 2 ** 32, 4);
                            record.writeUInt32LE(Math.floor(size / 2 ** 32), 8);
                            record.writeUInt32LE(name.length, 12);
                            name.copy(record, 16);
                            send(record);
                        }
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
                            traffic.pending = { root: id, channel, release: () => reply(1) };
                            return;
                        }
                        reply(1);
                    } else if (state === 1) {
                        const nameEnd = 10 + data.readUInt16BE(8);
                        upload.path = data.subarray(10, nameEnd).toString();
                        upload.size = data.readUInt32BE(4);
                        const overwrite = data.length > nameEnd && data[nameEnd] === 1;
                        traffic.uploads.push(upload.path);
                        traffic.starts.push({ path: upload.path, overwrite });
                        // Like the server: START is refused, with the reason in the close frame.
                        const existing = taken(upload.path);
                        if (existing?.directory || (existing?.file && !overwrite)) {
                            socket.send(
                                frame(64, id, close(channel, 4013, 'An item with this name already exists.')),
                            );
                            return;
                        }
                        traffic.sending.add(channel);
                        traffic.mostSending = Math.max(traffic.mostSending, traffic.sending.size);
                        reply(0);
                    } else if (state === 2) {
                        upload.chunks.push(data.subarray(8, 8 + data.readUInt32BE(4)));
                        if (traffic.holdAppends) traffic.heldAppends.push(() => reply(0));
                        else reply(0);
                    } else if (state === 3) {
                        // A replace removes the file that held the name, however it was spelled.
                        const replaced = taken(upload.path)?.file;
                        if (replaced) files.delete(replaced);
                        files.set(upload.path, Buffer.concat(upload.chunks));
                        traffic.sending.delete(channel);
                        reply(0);
                        end();
                    } else if (state === 4) {
                        // Like the server: a cancelled upload is dropped, and nothing is saved.
                        traffic.cancels.push(upload.path);
                        traffic.sending.delete(channel);
                    }
                }
            }
        });
    });
    return { files, dirs, sizes, traffic };
}

const row = (page, name) => page.locator(`.fx-row[data-name="${name}"]`);
// Ctrl+click toggles one row's selection on every pointer type, so a single helper covers all
// five layouts. Touch-only selection (Select mode plus checkboxes) is exercised separately.
// The toolbar exists on a desktop; a phone reaches the same commands through the Actions menu.
// The command bar scrolls sideways on a short screen and the list scrolls, and a menu closes
// when its button is scrolled away. The owner sees a button before pressing it, so the page is
// at rest by then: the button is brought into view, and the scroll is over, before the press.
async function pressAtRest(page, button) {
    await button.evaluate((element) => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await button.click();
}
async function command(page, button, item = button) {
    const toolbar = page.locator('.fx-commands').getByRole('button', { name: button, exact: true });
    if (await toolbar.isVisible()) return pressAtRest(page, toolbar);
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

// Types a path into the address bar.
async function goTo(page, target) {
    await page.getByRole('button', { name: 'Type a folder path', exact: true }).click();
    await page.locator('.fx-address-input').fill(target);
    await page.locator('.fx-address-input').press('Enter');
    await page.locator(`.file-explorer[data-listing="ready"] .fx-crumb[aria-current="page"]`).filter({ hasText: path.posix.basename(target) }).waitFor();
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

// The name-conflict dialog: its title, the answers on offer, and where the keyboard starts.
async function conflict(page, question, answers) {
    // "Replace “a”?" is asked as "Replace “a” on <device>?".
    const title = question.endsWith('?') ? `${question.slice(0, -1)} on ${DEVICE}?` : `${question} on ${DEVICE}`;
    const dialog = page.locator('.fx-dialog[open]');
    await dialog.getByRole('heading', { name: title, exact: true }).waitFor();
    assert.deepEqual(await dialog.locator('.fx-dialog-actions button').allInnerTexts(), answers);
    assert.equal(
        await page.evaluate(() => document.activeElement?.textContent),
        'Keep both',
        'the keyboard starts on the answer that loses nothing',
    );
    if (answers.includes('Replace')) {
        assert.equal(await dialog.locator('[value="replace"]').isDisabled(), true, 'Replace starts guarded');
    }
    return dialog;
}
async function answer(page, name) {
    await page.locator('.fx-dialog[open]').getByRole('button', { name, exact: true }).click();
    await page.locator('.fx-dialog').waitFor({ state: 'hidden' });
}
async function until(page, check, what) {
    for (let attempt = 0; attempt < 250; attempt++) {
        if (check()) return;
        await page.waitForTimeout(20);
    }
    assert.fail(`Timed out waiting for ${what}`);
}
// No upload row left and the folder listed again.
const settled = (page) =>
    page.waitForFunction(
        () =>
            !document.querySelector('.file-listing-upload-progress') &&
            document.querySelector('.file-listing-client')?.dataset.listing === 'ready',
    );

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
            const address = (folder) => `#!${new URLSearchParams({ action: 'device', udid: UDID, view: 'files', path: folder })}`;
            url.hash = address(ROOT);
            await page.goto(url.toString());
            await page.getByRole('link', { name: 'Download notes.txt', exact: true }).waitFor();
            assert.equal(await page.evaluate(() => location.hash), address(ROOT), 'Files keeps the address of the phone page');
            await page.locator('.tool-connection.connected').waitFor({ state: 'attached' });
            assert.equal(await page.locator('.file-listing-client').count(), 1, 'one embedded client');
            assert.equal(await page.locator('.kit-bar').count(), 1, 'shared tool header remains visible');
            assert.equal(
                await page.locator('.kit-tabs .kit-tab').allInnerTexts().then((list) => list.join(',')),
                'Screen,Files,Shell',
                'the tabs of the phone\'s page: the screen, then the tools',
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
                await settleMotion(page);
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
                            for (const sel of ['.kit-bar','.kit-tabs','.tool-mount','.fx-chrome','.fx-bar-address','.fx-bar-commands','.fx-places','.fx-items','.fx-statusbar','thead','.fx-row']) {
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
            const entriesBefore = await page.evaluate(() => history.state.nav.index);
            assert.equal(
                await row(page, 'empty').locator('.entry-name a').getAttribute('href'),
                new URL(address(ROOT + '/empty'), BASE).toString(),
                'a folder row links to its folder on the phone page',
            );
            await open(page, 'empty');
            await page.getByText('This folder is empty.', { exact: true }).first().waitFor();
            assert.equal(await page.evaluate(() => location.hash), address(ROOT + '/empty'), 'a folder step is written in the same form');
            assert.equal(await page.evaluate(() => history.state.nav.index), entriesBefore + 1, 'and is one history entry');
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
            // The failed folder offers its own Up button; this is the toolbar's.
            await page.locator('.fx-history').getByRole('button', { name: 'Up one folder', exact: true }).click();
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

            // A file of 4 GiB or more: the listing wraps its size, and the explorer corrects it.
            await goTo(page, LARGE);
            await row(page, 'film.mkv').waitFor();
            await page.waitForFunction(
                () => document.querySelector('.fx-row[data-name="film.mkv"] .entry-size')?.textContent === '5.0 GB',
            );
            assert.equal(await row(page, 'clip.mp4').locator('.entry-size').innerText(), '64 B');
            await select(page, 'film.mkv');
            await pressAtRest(page, row(page, 'film.mkv').locator('.fx-row-menu'));
            await page.getByRole('menuitem', { name: 'Properties', exact: true }).click();
            assert(
                (await page.locator('.fx-properties').innerText()).includes((5 * 1024 ** 3 + 7).toLocaleString('en-US')),
                'Properties shows the full byte count',
            );
            await page.getByRole('button', { name: 'Close', exact: true }).click();
            await page.locator('.fx-dialog').waitFor({ state: 'hidden' });
            // A large file downloads the same way as a small one, and says that it started.
            const largeDownload = page.waitForEvent('download');
            await open(page, 'film.mkv');
            assert.equal((await largeDownload).suggestedFilename(), 'film.mkv');
            await page.getByText('Download of film.mkv started in your browser.', { exact: true }).waitFor();
            await goTo(page, ROOT);
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

            // Pasting over a name that is taken asks first, with the same dialog as an upload.
            const pastesBefore = traffic.operations.length;
            await command(page, 'Paste');
            await conflict(page, 'Replace “notes.txt”?', ['Skip', 'Keep both', 'Replace']);
            await answer(page, 'Skip');
            await page.getByRole('status').filter({ hasText: 'Skipped notes.txt.' }).waitFor();
            assert.equal(traffic.operations.length, pastesBefore, 'Skip sends no operation');
            files.set(ROOT + '/archive/notes.txt', Buffer.from('Archived earlier'));
            await command(page, 'Paste');
            await conflict(page, 'Replace “notes.txt”?', ['Skip', 'Keep both', 'Replace']);
            await answer(page, 'Replace');
            await until(page, () => traffic.operations.length > pastesBefore, 'the replacing paste');
            assert.deepEqual(traffic.operations.at(-1), {
                cmd: 'COPY',
                paths: [ROOT + '/notes.txt', ROOT + '/archive/notes.txt'],
                replace: true,
            });
            assert.equal(files.get(ROOT + '/archive/notes.txt').toString(), 'Mock download contents\n');
            await page.locator('.file-listing-client[data-listing="ready"]').waitFor();
            // A copy pasted into its own folder has nothing to replace; it can only be kept.
            await select(page, 'notes.txt');
            await command(page, 'Copy');
            await command(page, 'Paste');
            await conflict(page, '“notes.txt” already exists', ['Skip', 'Keep both']);
            await answer(page, 'Keep both');
            await row(page, 'notes (1).txt').waitFor();
            assert.deepEqual(traffic.operations.at(-1), {
                cmd: 'COPY',
                paths: [ROOT + '/archive/notes.txt', ROOT + '/archive/notes (1).txt'],
            });
            files.delete(ROOT + '/archive/notes (1).txt');
            // A folder does not replace a file, and a kept copy of it keeps its whole name.
            dirs.add(ROOT + '/photos.2026');
            files.set(ROOT + '/archive/photos.2026', Buffer.from('A file named like the folder'));
            await page.getByRole('button', { name: 'Up one folder', exact: true }).click();
            await row(page, 'photos.2026').waitFor();
            await page.locator('.file-listing-client[data-listing="ready"]').waitFor();
            await select(page, 'photos.2026');
            await command(page, 'Copy');
            await open(page, 'archive');
            await page.locator('.fx-crumb[aria-current="page"]').filter({ hasText: 'archive' }).waitFor();
            await page.locator('.file-listing-client[data-listing="ready"]').waitFor();
            await command(page, 'Paste');
            await conflict(page, '“photos.2026” already exists', ['Skip', 'Keep both']);
            await answer(page, 'Keep both');
            await row(page, 'photos.2026 (1)').waitFor();
            assert.deepEqual(traffic.operations.at(-1), {
                cmd: 'COPY',
                paths: [ROOT + '/photos.2026', ROOT + '/archive/photos.2026 (1)'],
            });
            dirs.delete(ROOT + '/photos.2026');
            dirs.delete(ROOT + '/archive/photos.2026 (1)');
            files.delete(ROOT + '/archive/photos.2026');

            // Delete needs a confirmation and removes only the selected item.
            await select(page, 'notes.txt');
            await command(page, 'Delete');
            await page.getByText('This cannot be undone.', { exact: false }).waitFor();
            await page
                .locator('.fx-dialog[open]')
                .getByRole('heading', { name: `Delete “notes.txt” from ${DEVICE}?`, exact: true })
                .waitFor();
            // Cancel is the default, and the red button ignores presses for the first 500 ms.
            assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'Cancel is focused');
            assert.equal(await page.locator('.fx-dialog [value="confirm"]').isDisabled(), true, 'Delete starts guarded');
            assert.equal(traffic.operations.at(-1).cmd, 'COPY', 'opening the dialog deletes nothing');
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
            // The delete ended selection mode: no checkboxes, and a tap opens again.
            await page.locator('.file-explorer:not(.fx-selecting)').waitFor();

            // Properties reads the stat data already in the listing.
            await pressAtRest(page, page.locator('.fx-row[data-name="notes.txt"] .fx-row-menu'));
            await page.getByRole('menuitem', { name: 'Properties', exact: true }).click();
            const properties = await page.locator('.fx-properties').innerText();
            assert(properties.includes('notes.txt') && properties.includes(ROOT), 'properties name the exact path');
            assert(properties.includes('rw-r--r--'), 'properties show the device permissions');
            await page.getByRole('button', { name: 'Close', exact: true }).click();
            await page.locator('.fx-dialog').waitFor({ state: 'hidden' });

            // Every download goes through the browser, whatever its size, and says that it started.
            const requestsBeforeDownload = traffic.requests.length;
            const downloadPromise = page.waitForEvent('download');
            await open(page, 'notes.txt');
            const download = await downloadPromise;
            assert.equal(download.suggestedFilename(), 'notes.txt');
            // A download is a browser navigation, which page.route cannot answer. The fixture
            // server in test-browser.js answers with the device and path it was asked for.
            assert.equal(
                fs.readFileSync(await download.path(), 'utf8'),
                `fixture download ${UDID} ${ROOT}/notes.txt`,
                'the browser asks the download endpoint for this device and path',
            );
            await page.getByText('Download of notes.txt started in your browser.', { exact: true }).waitFor();
            assert.equal(
                traffic.requests.slice(requestsBeforeDownload).filter((request) => request.cmd === 'RECV').length,
                0,
                'no bytes travel over the Files channel',
            );
            assert.equal(await page.locator('.file-listing-progress').count(), 0, 'the browser shows the progress');
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

            // An upload never replaces a file on its own. The owner is asked, per name.
            const original = 'Mock download contents\n';
            const pick = (...list) =>
                page.locator('input[type=file]').setInputFiles(
                    list.map(([name, text]) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })),
                );
            const uploaded = (name) => page.getByRole('link', { name: `Download ${name}`, exact: true }).waitFor();
            const startsBefore = traffic.starts.length;
            await pick(['notes.txt', 'Replacement']);
            const question = await conflict(page, 'Replace “notes.txt”?', ['Skip', 'Keep both', 'Replace']);
            await settleMotion(page);
            // The dialog element covers the window. Its panel is the sheet that is seen.
            const questionBox = await question.locator('.kit-sheet-panel').boundingBox();
            assert(questionBox.x >= 0 && questionBox.x + questionBox.width <= width, 'the dialog fits the screen');
            assert(questionBox.y >= 0 && questionBox.y + questionBox.height <= height + 0.5, 'and its height');
            for (const button of await question.locator('.fx-dialog-actions button').all()) {
                const box = await button.boundingBox();
                assert(box.height >= 44, `conflict answer height ${box.height}`);
                assert(
                    box.x >= questionBox.x && box.x + box.width <= questionBox.x + questionBox.width + 0.5,
                    'every answer stays inside the dialog',
                );
            }
            await page.screenshot({ path: path.join(OUT, label + '-conflict.png') });
            // Closing the dialog skips the file: nothing is sent and nothing changes.
            await page.keyboard.press('Escape');
            await page.locator('.fx-dialog').waitFor({ state: 'hidden' });
            await page.getByRole('status').filter({ hasText: 'Skipped notes.txt.' }).waitFor();
            assert.equal(traffic.starts.length, startsBefore, 'a skipped upload sends no START');
            assert.equal(files.get(ROOT + '/notes.txt').toString(), original);

            // A dropped file is asked about in the same way as a picked one.
            await page.evaluate(() => {
                const data = new DataTransfer();
                data.items.add(new File(['Dropped'], 'notes.txt', { type: 'text/plain' }));
                document
                    .querySelector('.file-listing-client')
                    .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
            });
            await conflict(page, 'Replace “notes.txt”?', ['Skip', 'Keep both', 'Replace']);
            await answer(page, 'Skip');
            assert.equal(traffic.starts.length, startsBefore, 'a skipped drop sends no START');
            assert.equal(files.get(ROOT + '/notes.txt').toString(), original);

            await pick(['notes.txt', 'Second copy']);
            await conflict(page, 'Replace “notes.txt”?', ['Skip', 'Keep both', 'Replace']);
            await answer(page, 'Keep both');
            await uploaded('notes (1).txt');
            assert.equal(files.get(ROOT + '/notes (1).txt').toString(), 'Second copy');
            assert.equal(files.get(ROOT + '/notes.txt').toString(), original, 'Keep both leaves the original alone');
            assert.deepEqual(traffic.starts.at(-1), { path: ROOT + '/notes (1).txt', overwrite: false });

            // One answer can cover every conflict in the batch; free names go through unasked.
            await pick(['notes.txt', 'Third copy'], ['fresh.txt', 'Fresh'], ['mobile-upload.txt', 'Other bytes']);
            const several = await conflict(page, 'Replace “notes.txt”?', ['Skip', 'Keep both', 'Replace']);
            await several.getByLabel('Do the same for the other conflict', { exact: true }).check();
            await page.screenshot({ path: path.join(OUT, label + '-conflict-several.png') });
            await answer(page, 'Keep both');
            await Promise.all([uploaded('notes (2).txt'), uploaded('fresh.txt'), uploaded('mobile-upload (1).txt')]);
            assert.equal(files.get(ROOT + '/notes (2).txt').toString(), 'Third copy');
            assert.equal(files.get(ROOT + '/mobile-upload (1).txt').toString(), 'Other bytes');
            assert.equal(files.get(ROOT + '/fresh.txt').toString(), 'Fresh');
            assert.equal(files.get(ROOT + '/notes.txt').toString(), original);
            assert.equal(files.get(ROOT + '/mobile-upload.txt').toString(), 'Picker upload bytes');

            // Without the checkbox, each conflict gets its own question in turn.
            await pick(['notes.txt', 'Fourth copy'], ['empty-file.txt', 'No longer empty']);
            await conflict(page, 'Replace “notes.txt”?', ['Skip', 'Keep both', 'Replace']);
            await page.locator('.fx-dialog[open]').getByRole('button', { name: 'Skip', exact: true }).click();
            await conflict(page, 'Replace “empty-file.txt”?', ['Skip', 'Keep both', 'Replace']);
            await answer(page, 'Keep both');
            await uploaded('empty-file (1).txt');
            assert.equal(files.get(ROOT + '/empty-file (1).txt').toString(), 'No longer empty');
            assert.equal(files.get(ROOT + '/empty-file.txt').length, 0);
            assert.equal(files.get(ROOT + '/notes.txt').toString(), original);
            await settled(page);

            // Replace is an explicit answer, and the only upload that carries the overwrite flag.
            await pick(['notes.txt', 'Replacement']);
            await conflict(page, 'Replace “notes.txt”?', ['Skip', 'Keep both', 'Replace']);
            await answer(page, 'Replace');
            await until(page, () => files.get(ROOT + '/notes.txt').toString() === 'Replacement', 'the replacement');
            await settled(page);
            assert.deepEqual(traffic.starts.at(-1), { path: ROOT + '/notes.txt', overwrite: true });
            assert.equal(traffic.starts.filter((start) => start.overwrite).length, 1);

            // A folder is never replaced.
            await pick(['archive', 'A file named like the folder']);
            await conflict(page, '“archive” already exists', ['Skip', 'Keep both']);
            await answer(page, 'Keep both');
            await uploaded('archive (1)');
            assert(dirs.has(ROOT + '/archive'), 'the folder is still there');

            // Two files with one name in one batch: only the first is sent, and the owner is told.
            await pick(['twice.txt', 'First'], ['twice.txt', 'Second']);
            await page.getByRole('alert').filter({ hasText: '“twice.txt” was added more than once.' }).waitFor();
            assert.equal(files.get(ROOT + '/twice.txt').toString(), 'First');
            assert.equal(traffic.starts.filter((start) => start.path === ROOT + '/twice.txt').length, 1);
            await settled(page);

            // The listing can be out of date. The server still refuses, and the owner sees why.
            files.set(ROOT + '/late.txt', Buffer.from('Device copy'));
            await pick(['late.txt', 'Browser copy']);
            await page
                .getByRole('alert')
                .filter({ hasText: 'late.txt: An item with this name already exists.' })
                .waitFor();
            assert.equal(files.get(ROOT + '/late.txt').toString(), 'Device copy', 'the file on the device is kept');
            assert.deepEqual(traffic.starts.at(-1), { path: ROOT + '/late.txt', overwrite: false });
            // The folder is listed again, so trying a second time asks first.
            await row(page, 'late.txt').waitFor();
            await settled(page);
            assert.equal(
                await page.locator('.kit-toast[role="alert"] .kit-toast-message').innerText(),
                'late.txt: An item with this name already exists.',
            );
            await pick(['late.txt', 'Browser copy']);
            await conflict(page, 'Replace “late.txt”?', ['Skip', 'Keep both', 'Replace']);
            await answer(page, 'Skip');
            // A refusal in a batch stays on screen after the files that did upload.
            files.set(ROOT + '/later.txt', Buffer.from('Device copy'));
            await pick(['later.txt', 'Browser copy'], ['on-time.txt', 'On time']);
            await uploaded('on-time.txt');
            await settled(page);
            assert.equal(
                await page.locator('.kit-toast[role="alert"] .kit-toast-message').innerText(),
                'later.txt: An item with this name already exists.',
                'the failure is still shown after the folder is listed again',
            );
            assert.equal(files.get(ROOT + '/later.txt').toString(), 'Device copy');
            assert.equal(files.get(ROOT + '/on-time.txt').toString(), 'On time');

            // An answer belongs to the folder it was given in. Here the explorer moves to another
            // folder while the question is open: a change within the page leaves the question
            // open. The file still goes to the folder that was checked, and the same name in the
            // other folder is left alone.
            files.set(ROOT + '/archive/notes.txt', Buffer.from('Never asked about'));
            await pick(['notes.txt', 'Answered for tmp']);
            await conflict(page, 'Replace “notes.txt”?', ['Skip', 'Keep both', 'Replace']);
            traffic.holdStat = true;
            await page.evaluate((target) => {
                const params = new URLSearchParams(location.hash.replace(/^#!/, ''));
                params.set('path', target);
                location.hash = `#!${params}`;
            }, ROOT + '/archive');
            await until(page, () => traffic.releaseStat, 'the folder change');
            traffic.holdStat = false;
            assert.equal(await page.locator('.fx-dialog[open]').count(), 1, 'the question stays open while the folder changes');
            traffic.hold = true;
            await answer(page, 'Replace');
            await until(page, () => traffic.pending, 'the upload to ask for a push id');
            traffic.releaseStat();
            await page.locator('.fx-crumb[aria-current="page"]').filter({ hasText: 'archive' }).waitFor();
            traffic.hold = false;
            traffic.pending.release();
            traffic.pending = null;
            await until(page, () => traffic.starts.length && traffic.starts.at(-1).overwrite, 'the START');
            assert.deepEqual(traffic.starts.at(-1), { path: ROOT + '/notes.txt', overwrite: true });
            await until(page, () => files.get(ROOT + '/notes.txt').toString() === 'Answered for tmp', 'the upload');
            await settled(page);
            assert.equal(files.get(ROOT + '/archive/notes.txt').toString(), 'Never asked about');
            assert.equal(await page.evaluate(() => history.state?.nav?.overlay), undefined, 'the tab is on the folder entry, not on an entry of the question');
            files.delete(ROOT + '/archive/notes.txt');
            await page.getByRole('button', { name: 'Up one folder', exact: true }).click();
            await row(page, 'notes.txt').waitFor();
            await settled(page);

            // A question has a history entry of its own. The browser's Back closes it, which
            // skips the file: nothing is sent, and the folder stays where it was. The owner
            // presses Upload before choosing files; `setInputFiles` makes no press, so a key
            // stands in for it. Without a press since the last step through history the
            // question gets no entry (Chrome would skip one), and Back would leave Files.
            const startsBeforeBack = traffic.starts.length;
            const notesBeforeBack = files.get(ROOT + '/notes.txt').toString();
            await page.keyboard.press('Shift');
            await pick(['notes.txt', 'Never sent']);
            await conflict(page, 'Replace “notes.txt”?', ['Skip', 'Keep both', 'Replace']);
            await page.goBack();
            await page.locator('.fx-dialog').waitFor({ state: 'hidden' });
            await page.locator('.kit-toast .kit-toast-message').filter({ hasText: 'Skipped notes.txt.' }).waitFor();
            assert.equal(await page.evaluate(() => location.hash), address(ROOT), 'Back closed the question, not the folder');
            assert.equal(traffic.starts.length, startsBeforeBack, 'nothing was sent');
            assert.equal(files.get(ROOT + '/notes.txt').toString(), notesBeforeBack);
            await settled(page);
            traffic.hold = true;
            await page.locator('input[type=file]').setInputFiles({
                name: 'pending-upload.txt',
                mimeType: 'text/plain',
                buffer: Buffer.from('Never sent'),
            });
            await page.waitForFunction(() =>
                document.querySelector('.file-listing-upload-progress')?.textContent.includes('pending-upload'),
            );
            // Leaving with an upload in progress asks first, and stops it only when told to.
            await page.getByRole('button', { name: 'Phones', exact: true }).click();
            const leave = page.locator('.fx-dialog[open]');
            await leave.getByRole('heading', { name: `Stop the upload to ${DEVICE}?`, exact: true }).waitFor();
            await page.waitForTimeout(550);
            await leave.getByRole('button', { name: 'Stop and leave', exact: true }).click();
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

module.exports = { fixture, pressAtRest, DEVICE, SHARED };
