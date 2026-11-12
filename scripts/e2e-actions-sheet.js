// node scripts/test-browser.js actions-sheet      (E2E_OUT=/tmp/ws-scrcpy-actions-sheet for screenshots)
// The one Actions sheet of both kinds of phone (src/app/views/actions/): the same groups in the
// same order, no way out of the page, the words from one table, one clipboard group, and what
// each one-shot action sends. Phone width and desktop, light and dark.
// SCENARIO=<name> runs one scenario. SCENARIO=messages, the check of what the actions send, also
// passes on a build from before the sheet was one, which is how its expectations were taken.
// Every socket is a fixture. No phone, adb or pymobiledevice3 is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
const { settleMotion } = require('./ui-motion');

// Only through test-browser.js, which serves the build on a port of its own.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js actions-sheet');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-actions-sheet-'));
const ROOT = path.join(__dirname, '..');
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const ANDROID_UDID = 'fixture-android-actions';
const ANDROID_NAME = 'Fixture Pixel';
const IOS_UDID = 'fixture-iphone-actions';
const IOS_NAME = 'iPhone fixture';
// The most clipboard text either phone takes, in UTF-8 bytes (src/app/ui/clipboardLimit.ts).
const LIMIT = (1 << 18) - 14;
const TOO_LONG = 'This text is too long to send. The limit is 256 KB.';
const NO_ANSWER = 'No answer from the phone. Check that it is still connected.';
const PHONE_TEXT = 'Text from the phone';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The groups in their fixed order. Settings is the untitled group at the end.
const ORDER = ['Clipboard', 'Screen', 'Lock', 'Power', ''];
// Each row as [group, title, description, buttons]. Read, Unlock, Lock and Settings are the same
// actions on both, so they read the same.
const READ = ['Clipboard', "Read the phone's clipboard", 'Copy from the phone to this browser.', ['Read', 'Copy here']];
const LOCK = ['Lock', 'Lock the phone', 'Turns the screen off with the side button.', ['Lock']];
const SETTINGS = ['', 'Settings', '', ['Open']];
// The last row of Screen on both; its lines show on Show (scripts/e2e-ios-input.js).
const MOUSE = ['Screen', 'Mouse and keyboard', 'What the mouse does on this phone.', ['Show']];
const ROWS = {
    android: [
        READ,
        ['Clipboard', 'Paste text on the phone', 'Tap a field on the phone, then paste.', ['Paste']],
        ['Screen', 'Notifications', '', ['Open']],
        ['Screen', 'Quick settings', '', ['Open']],
        ['Screen', 'Collapse panels', '', ['Collapse']],
        MOUSE,
        ['Lock', 'Unlock the phone', "Enter the phone's PIN or password.", ['Unlock']],
        LOCK,
        SETTINGS,
    ],
    ios: [
        READ,
        ['Clipboard', 'Send text to the phone', 'Copy to the phone, then paste in a field.', ['Send to phone']],
        ['Clipboard', 'Type text', 'Type into the focused field on the phone.', ['Open']],
        ['Screen', 'Rotate', 'Apps with a fixed orientation may ignore this.', ['Left', 'Right']],
        ['Screen', 'Refresh picture', 'Refresh a smeared picture.', ['Refresh']],
        ['Screen', 'Restart video', 'For frozen or broken video.', ['Restart video']],
        ['Screen', 'Reconnect', 'Reconnect video, touch and keyboard.', ['Reconnect']],
        MOUSE,
        ['Lock', 'Unlock the phone', 'Uses the passcode stored on the server.', ['Unlock']],
        LOCK,
        ['Power', 'Reboot', 'Reconnects after restarting. If a passcode is set, unlock on the phone.', ['Reboot']],
        ['Power', 'Shut down', 'Power it on using the phone’s button.', ['Shut down']],
        SETTINGS,
    ],
};

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

/** What an Android phone sends back for GET_CLIPBOARD. */
function clipboardMessage(text) {
    const body = Buffer.from(text);
    const frame = Buffer.alloc(14 + 5 + body.length);
    frame.write('scrcpy_message');
    frame.writeInt32BE(body.length, 15);
    body.copy(frame, 19);
    return frame;
}

const androidPhone = (extra = {}) => ({
    udid: ANDROID_UDID, state: 'device', pid: 123, interfaces: [], 'ro.product.model': 'Pixel',
    'ro.product.manufacturer': 'Fixture', 'ro.build.version.release': '16', 'ro.build.version.sdk': '36',
    'ro.product.cpu.abi': 'arm64-v8a', 'screen.power': 'on', 'device.awake': true, 'battery.level': 80,
    'battery.charging': false, 'device.locked': false, 'keyguard.showing': false, 'keyguard.occluded': false, ...extra,
});
const iphone = (extra = {}) => ({
    udid: IOS_UDID, name: IOS_NAME, state: 'Connected', model: 'iPhone 13 Pro Max', version: '27.2', paired: true,
    developerMode: true, session: 'ready', 'screen.power': 'on', 'device.locked': false,
    unlockSchedule: { enabled: false, time: '03:00', hasPasscode: false, serverTimeZone: 'UTC' }, ...extra,
});

/**
 * One phone's screen on fixture sockets. `sent` holds what the page sent on the stream socket
 * (Android: control messages as bytes; iPhone: JSON messages), `commands` the tracker commands.
 * The fixture answers a clipboard read with `clipboard` unless it is null, and a request
 * with an id through `handlers.onStream`. `handlers.device(next)` sends a new device list.
 */
async function open(browser, platform, { mobile = false, dark = false, clipboard = PHONE_TEXT } = {}) {
    const context = await browser.newContext({
        viewport: mobile ? PHONE : DESKTOP, isMobile: mobile, hasTouch: mobile, colorScheme: dark ? 'dark' : 'light',
    });
    // Copy here: the copied text, without the browser's clipboard permission.
    await context.addInitScript(() => {
        Object.defineProperty(Object.getPrototypeOf(navigator), 'clipboard', {
            configurable: true,
            get: () => ({ writeText: async (text) => { window.__copied = text; } }),
        });
    });
    const page = await context.newPage();
    const errors = [];
    const sent = [];
    const commands = [];
    const handlers = { onStream: undefined, onCommand: undefined, device: undefined };
    // `stream` is the stream socket; with `refuse` set, a new one is closed at once. `tracker`
    // is the socket the last tracker command came on.
    const fixture = { clipboard, stream: undefined, refuse: false, tracker: undefined };
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', (socket) => {
        const action = new URL(socket.url()).searchParams.get('action');
        if ((action === 'proxy-adb' || action === 'proxy-coredevice') && fixture.refuse) {
            socket.close();
            return;
        }
        if (action === 'proxy-adb') {
            fixture.stream = socket;
            socket.onMessage((data) => {
                const packet = Buffer.from(data);
                sent.push(packet);
                if (packet[0] === 8 && fixture.clipboard !== null) socket.send(clipboardMessage(fixture.clipboard));
            });
            setTimeout(() => socket.send(initialStreamPacket()), 100);
            return;
        }
        if (action === 'proxy-coredevice') {
            fixture.stream = socket;
            socket.onMessage((data) => {
                if (typeof data !== 'string') return;
                const message = JSON.parse(data);
                sent.push(message);
                if (message.type === 'clipboard' && message.op === 'get' && fixture.clipboard !== null) {
                    socket.send(JSON.stringify({ type: 'clipboard', text: fixture.clipboard }));
                }
                const answer = handlers.onStream?.(message);
                if (answer) socket.send(JSON.stringify(answer));
            });
            setTimeout(() => socket.send(JSON.stringify({ type: 'status', state: 'ready' })), 50);
            return;
        }
        socket.onMessage((data) => {
            const frame = Buffer.from(data);
            if (frame.length < 5) return;
            const id = frame.readUInt32LE(1);
            const reply = (message) => socket.send(channelJson(id, message));
            if (frame[0] === 4) {
                const code = frame.subarray(5).toString();
                if (code === 'HSTS') reply({ id: -1, type: 'hosts', data: { local: [{ type: platform }] } });
                if (code === 'GTRC' && platform === 'android') {
                    handlers.device = (next) => reply({ id: -1, type: 'devicelist', data: { id: 'android', name: 'Devices', list: [next] } });
                    handlers.device(androidPhone());
                }
                if (code === 'ATRC' && platform === 'ios') {
                    handlers.device = (next) => reply({ id: -1, type: 'devicelist', data: { id: 'ios', name: 'Devices', list: [next] } });
                    handlers.device(iphone());
                }
            } else if (frame[0] === 32) {
                const command = JSON.parse(frame.subarray(5).toString());
                commands.push(command);
                fixture.tracker = socket;
                const answer = handlers.onCommand?.(command);
                if (answer) reply({ id: command.id, type: command.type, data: { udid: command.data.udid, ...answer } });
            }
        });
    });
    const url = new URL(BASE);
    if (platform === 'android') {
        const socket = new URL('/', BASE);
        socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
        socket.search = new URLSearchParams({ action: 'proxy-adb', remote: 'tcp:8886', udid: ANDROID_UDID }).toString();
        url.hash = `!${new URLSearchParams({ action: 'stream', udid: ANDROID_UDID, player: 'webcodecs', ws: socket.toString(), captureKeyboard: '0', fitToScreen: '1' })}`;
    } else {
        url.hash = `!${new URLSearchParams({ action: 'stream-coredevice', udid: IOS_UDID })}`;
    }
    await page.goto(url.toString());
    await page.waitForFunction(() => document.querySelector('.kit-bar-status')?.textContent.includes('Connected'));
    return { context, page, errors, sent, commands, handlers, fixture, mobile, platform };
}

/** Presses a control by its title, opening the controls panel first on a phone. */
async function control(test, title) {
    const { page } = test;
    const button = page.locator(`.control-buttons-list [title="${title}"]`);
    if (test.mobile && !(await button.isVisible())) {
        await page.locator('.floating-toolbar-fab').click();
        await settleMotion(page);
    }
    await button.click();
    await settleMotion(page);
}

const actionsSheet = (page) => page.getByRole('dialog', { name: 'Actions', exact: true });

async function openActions(test) {
    await control(test, 'Actions');
    const sheet = actionsSheet(test.page);
    await sheet.waitFor();
    await settleMotion(test.page);
    return sheet;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The row whose title is `title`. */
const row = (sheet, title) =>
    sheet.locator('.kit-row').filter({ has: sheet.page().locator('.kit-row-title', { hasText: new RegExp(`^${escape(title)}$`) }) });
/** A button in the row titled `title`; `name` is its label when the row has more than one. */
const press = async (sheet, title, name) => {
    const target = row(sheet, title).getByRole('button', name ? { name, exact: true } : undefined).first();
    await target.scrollIntoViewIfNeeded();
    await target.click();
};
/** What the page sent on the stream socket during `act`, once it has gone quiet. */
async function sentDuring(test, act) {
    const before = test.sent.length;
    await act();
    await pause(150);
    return test.sent.slice(before);
}
const bytes = (packets) => packets.map((packet) => Array.from(packet));

/** The groups and rows as the sheet shows them. */
function readSheet(sheet) {
    return sheet.evaluate((root) =>
        Array.from(root.querySelectorAll('section.kit-group')).map((group) => ({
            title: group.querySelector(':scope > .kit-group-title')?.textContent.trim() ?? '',
            rows: Array.from(group.querySelectorAll('.kit-row')).filter((el) => el.querySelector('.kit-row-title')).map((el) => ({
                title: el.querySelector('.kit-row-title').textContent.trim(),
                description: el.querySelector('.kit-row-desc')?.textContent.trim() ?? '',
                buttons: Array.from(el.querySelectorAll('button')).map((button) => button.textContent.trim()),
            })),
        })),
    );
}

/** Every string literal of a source file. */
function literals(file) {
    // Comments go first: an apostrophe in one would start a string.
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // A template literal gives the text around its placeholders.
    return Array.from(source.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)).flatMap((m) =>
        m[3] !== undefined ? m[3].split(/\$\{[^}]*\}/) : [(m[1] ?? m[2]).replace(/\\'/g, "'")],
    );
}

/** The sheet's structure on one phone at one size and theme. */
async function structure(browser, platform, { mobile, dark }) {
    const label = `${platform} ${mobile ? 'phone' : 'desktop'} ${dark ? 'dark' : 'light'}`;
    const test = await open(browser, platform, { mobile, dark });
    const { page } = test;
    try {
        const sheet = await openActions(test);
        assert.equal(await sheet.locator('.kit-sheet-subtitle').textContent(), platform === 'android' ? ANDROID_NAME : IOS_NAME, `${label}: the phone's name under the title`);
        const groups = await readSheet(sheet);
        const titles = groups.map((group) => group.title);
        // Android has nothing for Power: no reboot or shut down from here.
        assert.deepEqual(titles, platform === 'android' ? ORDER.filter((title) => title !== 'Power') : ORDER, `${label}: the groups in the fixed order`);
        const rows = groups.flatMap((group) => group.rows.map((item) => [group.title, item.title, item.description, item.buttons]));
        assert.deepEqual(rows, ROWS[platform], `${label}: the rows, their words and their buttons`);
        assert.equal(await sheet.getByRole('button', { name: 'Open Settings', exact: true }).count(), 1, `${label}: Settings says what it opens`);

        // Nothing leaves the page and nothing that persists is here: those are in Settings.
        assert.equal(await sheet.getByRole('button', { name: /Back to devices|Phones|Disconnect|Return/ }).count(), 0, `${label}: no exit row`);
        assert.equal(await sheet.locator('.kit-sheet-footer').count(), 0, `${label}: no footer`);
        assert.equal(await sheet.locator('details, .kit-disclosure, [role="switch"], input[type="checkbox"], input[type="range"]').count(), 0, `${label}: no disclosure, switch or slider`);
        const copy = await sheet.textContent();
        for (const gone of ['Sound', 'Listen in this browser', 'Keyboard', 'Send keystrokes', 'Troubleshooting', 'Restart services', 'Scheduled unlock', 'Phone panels', 'Stream settings']) {
            assert.equal(copy.includes(gone), false, `${label}: no ${gone}`);
        }
        assert.doesNotMatch(copy, /\bdevices?\b/i, `${label}: the sheet says phone`);

        // The sheet fits its width; a picture of each group for review.
        const fits = await sheet.locator('.kit-sheet-body').evaluate((body) => body.scrollWidth <= body.clientWidth + 1);
        assert.equal(fits, true, `${label}: nothing is wider than the sheet`);
        fs.mkdirSync(OUT, { recursive: true });
        const name = `${platform}-actions-${mobile ? 'phone' : 'desktop'}-${dark ? 'dark' : 'light'}`;
        await page.screenshot({ path: path.join(OUT, `${name}.png`) });
        await sheet.locator('section.kit-group').last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(OUT, `${name}-end.png`) });
        assert.deepEqual(test.errors, []);
        return groups;
    } finally {
        await test.context.close();
    }
}

/** The words of the sheet come from one table: the strings shown are written there, and only there. */
function oneTable(shown) {
    const table = new Set(literals('src/app/views/actions/actionRows.ts'));
    const others = [
        'src/app/views/ActionsSheet.tsx', 'src/app/views/ApplActionsSheet.tsx',
        ...fs.readdirSync(path.join(ROOT, 'src/app/views/actions')).filter((file) => file !== 'actionRows.ts').map((file) => `src/app/views/actions/${file}`),
    ];
    const elsewhere = new Set(others.flatMap(literals));
    for (const text of shown) {
        assert.ok(table.has(text), `"${text}" is in the table`);
        assert.equal(elsewhere.has(text), false, `"${text}" is written only in the table`);
    }
}

/** Read, show, copy and send, with the same words and the same limit on both. */
async function clipboard(browser, platform, { mobile, dark }) {
    const label = `${platform} ${mobile ? 'phone' : 'desktop'} ${dark ? 'dark' : 'light'}`;
    const test = await open(browser, platform, { mobile, dark });
    const { page } = test;
    try {
        const sheet = await openActions(test);
        const read = row(sheet, "Read the phone's clipboard");
        const copyHere = read.getByRole('button', { name: 'Copy here', exact: true });
        assert.equal(await copyHere.isDisabled(), true, `${label}: nothing to copy before a read`);
        assert.equal(await sheet.getByLabel('Phone clipboard', { exact: true }).count(), 0, `${label}: no clipboard field before a read`);
        await read.getByRole('button', { name: 'Read', exact: true }).click();
        await sheet.getByText('Read from the phone.', { exact: true }).waitFor();
        assert.equal(await sheet.getByLabel('Phone clipboard', { exact: true }).inputValue(), PHONE_TEXT, `${label}: the text read is shown`);
        await copyHere.click();
        await sheet.getByText('Copied to this browser.', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.__copied), PHONE_TEXT, `${label}: and copied to this browser`);

        const paste = platform === 'android';
        const field = sheet.getByLabel(paste ? 'Text to paste on the phone' : 'Text for the phone clipboard');
        const send = sheet.getByRole('button', { name: paste ? 'Paste' : 'Send to phone', exact: true });
        assert.equal(await send.isDisabled(), true, `${label}: nothing to send yet`);
        await field.fill('a'.repeat(LIMIT + 1));
        const tooLong = sheet.getByRole('alert').filter({ hasText: new RegExp(`^${escape(TOO_LONG)}$`) });
        await tooLong.waitFor();
        assert.equal(await send.isDisabled(), true, `${label}: text over the limit cannot be sent`);
        await tooLong.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(OUT, `${platform}-clipboard-too-long-${mobile ? 'phone' : 'desktop'}-${dark ? 'dark' : 'light'}.png`) });
        // Three bytes a character: the limit counts UTF-8 bytes.
        await field.fill('€'.repeat(Math.floor(LIMIT / 3) + 1));
        await tooLong.waitFor();
        await field.fill('a'.repeat(LIMIT));
        await tooLong.waitFor({ state: 'detached' });

        const out = await sentDuring(test, () => send.click());
        if (paste) {
            // SET_CLIPBOARD with paste: type, a sequence of 0 (no ack), paste 1, length, text.
            assert.equal(out.length, 1, `${label}: one message`);
            const [packet] = out;
            assert.deepEqual([packet[0], ...packet.subarray(1, 10), packet.readUInt32BE(10), packet.length], [9, 0, 0, 0, 0, 0, 0, 0, 0, 1, LIMIT, 1 << 18], `${label}: SET_CLIPBOARD with paste, at the limit`);
            await sheet.getByText('Pasted into the focused field on the phone.', { exact: true }).waitFor();
        } else {
            assert.deepEqual(out.map(({ type, op, text, id }) => [type, op, text.length, Number.isInteger(id)]), [['clipboard', 'set', LIMIT, true]], `${label}: one clipboard set at the limit`);
            await sheet.getByText('Sending to the phone clipboard…', { exact: true }).waitFor();
            assert.equal(await send.isDisabled(), true, `${label}: busy until the phone answers`);
            test.fixture.stream.send(JSON.stringify({ type: 'result', id: out[0].id, ok: true }));
            await sheet.getByText('Sent. Long-press a field on the phone and choose Paste.', { exact: true }).waitFor();
            assert.equal(await send.isDisabled(), false, `${label}: usable again`);
        }
        assert.deepEqual(test.errors, []);
        console.log(`PASS ${label}: the clipboard group reads, shows, copies and sends, with one limit`);
    } finally {
        await test.context.close();
    }
}

/** A read that is never answered ends with the same words on both. */
async function noAnswer(browser) {
    const words = {};
    for (const platform of ['android', 'ios']) {
        const test = await open(browser, platform, { clipboard: null });
        try {
            const sheet = await openActions(test);
            await row(sheet, "Read the phone's clipboard").getByRole('button', { name: 'Read', exact: true }).click();
            await sheet.getByRole('button', { name: 'Reading…', exact: true }).waitFor();
            await sheet.getByText('Reading the phone clipboard…', { exact: true }).waitFor();
            if (platform === 'ios') {
                // The iPhone server restarts the phone's clipboard service on the way, and says so.
                await sheet.getByText('The phone stopped answering. Restarting its clipboard service and trying again…', { exact: true }).waitFor({ timeout: 12000 });
            }
            await sheet.getByText(NO_ANSWER, { exact: true }).waitFor({ timeout: 30000 });
            words[platform] = await sheet.locator('.kit-group').first().locator('.kit-status').textContent();
            assert.equal(await sheet.getByRole('button', { name: 'Read', exact: true }).isEnabled(), true, `${platform}: Read again`);
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    assert.equal(words.android, words.ios, 'the same words when the phone does not answer');
    console.log('PASS a clipboard read that is never answered says the same on both');
}

/**
 * What each one-shot action sends. These expectations were taken on a build of the base
 * (5cab921) with SCENARIO=messages, where the sheets were two.
 */
async function messages(browser) {
    const android = await open(browser, 'android');
    try {
        const sheet = await openActions(android);
        assert.deepEqual(bytes(await sentDuring(android, () => press(sheet, "Read the phone's clipboard", 'Read'))), [[8, 0]], 'Read: GET_CLIPBOARD');
        await sheet.getByText('Read from the phone.', { exact: true }).waitFor();
        await sheet.getByLabel('Text to paste on the phone').fill('hello');
        assert.deepEqual(bytes(await sentDuring(android, () => press(sheet, 'Paste text on the phone', 'Paste'))), [[9, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 5, ...Buffer.from('hello')]], 'Paste: SET_CLIPBOARD with paste');
        for (const [title, type] of [['Notifications', 5], ['Quick settings', 6], ['Collapse panels', 7]]) {
            const panel = actionsSheet(android.page);
            if (!(await panel.isVisible())) await openActions(android);
            assert.deepEqual(bytes(await sentDuring(android, () => press(panel, title))), [[type]], `${title}: one panel message`);
            await panel.waitFor({ state: 'hidden' });
        }
        assert.deepEqual(android.errors, []);
    } finally {
        await android.context.close();
    }

    const phone = await open(browser, 'ios');
    try {
        const sheet = await openActions(phone);
        phone.handlers.onStream = (message) => (message.id !== undefined && message.type !== 'clipboard' ? { type: 'result', id: message.id, ok: true } : undefined);
        const strip = (list) => list.map((message) => ({ ...message, ...(message.id === undefined ? {} : { id: typeof message.id }) }));
        assert.deepEqual(await sentDuring(phone, () => press(sheet, "Read the phone's clipboard", 'Read')), [{ type: 'clipboard', op: 'get' }], 'Read: clipboard get');
        await sheet.getByLabel('Text for the phone clipboard').fill('hello');
        assert.deepEqual(strip(await sentDuring(phone, () => press(sheet, 'Send text to the phone', 'Send to phone'))), [{ type: 'clipboard', op: 'set', text: 'hello', id: 'number' }], 'Send to phone: clipboard set');
        assert.deepEqual(strip(await sentDuring(phone, () => press(sheet, 'Rotate', 'Left'))), [{ type: 'rotate', direction: 'left', id: 'number' }], 'Rotate left');
        await sheet.getByText('Done.', { exact: true }).waitFor();
        assert.deepEqual(strip(await sentDuring(phone, () => press(sheet, 'Rotate', 'Right'))), [{ type: 'rotate', direction: 'right', id: 'number' }], 'Rotate right');
        assert.deepEqual(await sentDuring(phone, () => press(sheet, 'Refresh picture')), [{ type: 'pli' }], 'Refresh picture: a key frame');
        await sheet.getByText('Asked for a new keyframe.', { exact: true }).waitFor();
        assert.deepEqual(strip(await sentDuring(phone, () => press(sheet, 'Restart video'))), [{ type: 'restart', id: 'number' }], 'Restart video');
        await sheet.getByText('The video was restarted.', { exact: true }).waitFor();
        assert.deepEqual(await sentDuring(phone, () => press(sheet, 'Reconnect')), [{ type: 'restart-session' }], 'Reconnect: a new session');

        // Reboot and Shut down go over the tracker, each after its prompt.
        phone.handlers.onCommand = () => ({ result: 'ok' });
        for (const [title, type, sentLine] of [['Reboot', 'reboot_device', 'Rebooting…'], ['Shut down', 'shutdown_device', 'Shutting down…']]) {
            const before = phone.commands.length;
            await press(sheet, title);
            const prompt = sheet.getByRole('alertdialog');
            await prompt.waitFor();
            assert.equal(phone.commands.length, before, `${title}: nothing before the prompt is answered`);
            await prompt.locator('.kit-confirm-go:not([aria-disabled])').waitFor();
            await prompt.getByRole('button', { name: title, exact: true }).click();
            await sheet.getByText(sentLine, { exact: true }).waitFor();
            assert.deepEqual(phone.commands.slice(before).map((command) => [command.type, command.data]), [[type, { udid: IOS_UDID }]], `${title}: one tracker command`);
        }
        assert.deepEqual(phone.errors, []);
    } finally {
        await phone.context.close();
    }
    console.log('PASS each one-shot action sends what it sent before');
}

/**
 * Unlock and Lock are rows on both, whatever the lock state. Lock sends what the side button
 * control sends for one press, and closes the sheet; with the screen asleep it would wake the
 * phone instead, so it waits.
 */
async function lockRows(browser) {
    for (const platform of ['android', 'ios']) {
        const test = await open(browser, platform);
        const { page } = test;
        try {
            const expected = platform === 'android'
                ? [[0, 0, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0, 0]]
                : [{ type: 'button', name: 'lock', state: 'press' }];
            const pack = (list) => (platform === 'android' ? bytes(list) : list);
            // The control, pressed from the keyboard: one press, no hold. The side button is Lock
            // on both phones, in the controls as in this sheet.
            const key = page.locator('.control-buttons-list [title="Lock"]');
            assert.deepEqual(pack(await sentDuring(test, () => key.evaluate((el) => el.click()))), expected, `${platform}: the control's press`);
            let sheet = await openActions(test);
            assert.deepEqual(pack(await sentDuring(test, () => press(sheet, 'Lock the phone', 'Lock'))), expected, `${platform}: Lock sends the same press`);
            await sheet.waitFor({ state: 'hidden' });

            // Unlock is there although the phone is not locked; its sheet says so.
            sheet = await openActions(test);
            await press(sheet, 'Unlock the phone', 'Unlock');
            await page.getByRole('dialog', { name: /^Unlock/ }).getByText('This phone reports that it is unlocked.').waitFor();
            await page.keyboard.press('Escape');
            await page.getByRole('dialog', { name: /^Unlock/ }).waitFor({ state: 'hidden' });

            test.handlers.device(platform === 'android' ? androidPhone({ 'screen.power': 'off', 'device.awake': false }) : iphone({ 'screen.power': 'off' }));
            sheet = await openActions(test);
            const lock = row(sheet, 'Lock the phone').getByRole('button', { name: 'Lock', exact: true });
            await page.waitForFunction((el) => el.disabled, await lock.elementHandle());
            assert.equal(await row(sheet, 'Unlock the phone').getByRole('button', { name: 'Unlock', exact: true }).isEnabled(), true, `${platform}: Unlock stays with the screen asleep`);
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    console.log('PASS Unlock and Lock are rows on both; Lock sends the side button press and waits while the screen is asleep');
}

/**
 * Reboot and Shut down go over the tracker, so they can be pressed while the stream is down, and
 * a command whose answer is lost with the tracker socket ends with a line that says so.
 */
async function powerOverTracker(browser) {
    const test = await open(browser, 'ios');
    try {
        const sheet = await openActions(test);
        test.fixture.refuse = true;
        test.fixture.stream.close();
        await sheet.locator('.actions-sheet > .kit-banner').waitFor();
        await press(sheet, 'Reboot');
        const prompt = sheet.getByRole('alertdialog', { name: `Reboot ${IOS_NAME}?`, exact: true });
        await prompt.locator('.kit-confirm-go:not([aria-disabled])').waitFor();
        await prompt.getByRole('button', { name: 'Reboot', exact: true }).click();
        await sheet.getByText('Asking the phone to reboot…', { exact: true }).waitFor();
        assert.deepEqual(test.commands.filter((command) => command.type === 'reboot_device').map((command) => command.data), [{ udid: IOS_UDID }]);
        test.fixture.tracker.close();
        await sheet.getByText('The connection to the server dropped before it answered. Check the result once it is back.', { exact: true }).waitFor();
        assert.equal(await row(sheet, 'Reboot').getByRole('button', { name: 'Reboot', exact: true }).isEnabled(), true, 'Reboot can be pressed again');
        assert.deepEqual(test.errors, []);
    } finally {
        await test.context.close();
    }
    console.log('PASS Reboot goes over the tracker while the stream is down, and a lost answer is said');
}

/** Ids on the page that more than one element has. */
const sharedIds = (page) =>
    page.evaluate(() => {
        const seen = {};
        document.querySelectorAll('[id]').forEach((el) => {
            seen[el.id] = (seen[el.id] || 0) + 1;
        });
        return Object.keys(seen).filter((id) => seen[id] > 1);
    });

/**
 * A prompt or a field that appears after the sheet has opened, closed and opened again keeps its
 * own id, so it keeps its name. Each group's state lives above the sheet for this (see
 * `views/actions/PhoneActionsSheet.tsx`): drawn from a group of its own, the Reboot prompt took
 * the id of the sheet's title and was named Actions.
 */
async function reopened(browser) {
    for (const platform of ['android', 'ios']) {
        const test = await open(browser, platform, { mobile: true });
        const { page } = test;
        try {
            for (let round = 1; round <= 2; round++) {
                const sheet = await openActions(test);
                await press(sheet, "Read the phone's clipboard", 'Read');
                await sheet.getByText('Read from the phone.', { exact: true }).waitFor();
                assert.equal(await sheet.getByLabel('Phone clipboard', { exact: true }).inputValue(), PHONE_TEXT, `${platform} round ${round}: the field read has its name`);
                if (platform === 'ios') {
                    const reboot = row(sheet, 'Reboot').getByRole('button', { name: 'Reboot', exact: true });
                    const prompt = sheet.getByRole('alertdialog', { name: `Reboot ${IOS_NAME}?`, exact: true });
                    for (const leave of ['Cancel', 'a press elsewhere']) {
                        await reboot.click();
                        await prompt.waitFor();
                        if (leave === 'Cancel') await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
                        else await sheet.getByRole('heading', { name: 'Power', exact: true }).click();
                        await prompt.waitFor({ state: 'detached' });
                    }
                    await reboot.click();
                    await prompt.waitFor();
                }
                assert.deepEqual(await sharedIds(page), [], `${platform} round ${round}: every id is used once`);
                await page.getByRole('button', { name: 'Close Actions', exact: true }).click();
                await sheet.waitFor({ state: 'hidden' });
            }
            assert.equal(test.commands.filter((command) => command.type === 'reboot_device').length, 0, 'nothing was sent');
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    console.log('PASS after the sheet opens again, a new prompt and a new field keep their own ids and names');
}

/** While the stream is down the sheet says so above the groups, and the rows that need it wait. */
async function paused(browser) {
    const words = {};
    for (const platform of ['android', 'ios']) {
        const test = await open(browser, platform);
        try {
            const sheet = await openActions(test);
            await sheet.getByLabel(platform === 'android' ? 'Text to paste on the phone' : 'Text for the phone clipboard').fill('hello');
            test.fixture.refuse = true;
            test.fixture.stream.close();
            const banner = sheet.locator('.actions-sheet > .kit-banner');
            await banner.waitFor();
            words[platform] = (await banner.textContent()).trim();
            for (const [title, name] of [["Read the phone's clipboard", 'Read'], [platform === 'android' ? 'Paste text on the phone' : 'Send text to the phone', platform === 'android' ? 'Paste' : 'Send to phone'], ['Unlock the phone', 'Unlock'], ['Lock the phone', 'Lock']]) {
                assert.equal(await row(sheet, title).getByRole('button', { name, exact: true }).isDisabled(), true, `${platform}: ${name} waits for the stream`);
            }
            assert.equal(await sheet.getByRole('button', { name: 'Open Settings', exact: true }).isEnabled(), true, `${platform}: Settings does not need the stream`);
            assert.deepEqual(test.errors, []);
        } finally {
            await test.context.close();
        }
    }
    assert.equal(words.android, 'Reconnecting to the phone. Actions that need the stream are paused until it is back.');
    assert.equal(words.ios, words.android, 'the same words on both');
    console.log('PASS while the stream is down both sheets say so in the same words, and its rows wait');
}

/** The structure at both sizes in both themes, then the words against the table. */
async function structures(browser) {
    const shown = new Set();
    for (const [mobile, dark] of [[true, false], [true, true], [false, false], [false, true]]) {
        for (const platform of ['android', 'ios']) {
            for (const group of await structure(browser, platform, { mobile, dark })) {
                if (group.title) shown.add(group.title);
                for (const item of group.rows) [item.title, item.description, ...item.buttons].filter(Boolean).forEach((text) => shown.add(text));
            }
        }
        console.log(`PASS ${mobile ? 'phone' : 'desktop'} ${dark ? 'dark' : 'light'}: the same groups in the same order on both, no exit row, nothing that persists`);
    }
    oneTable(shown);
    console.log('PASS the titles, descriptions and labels come from one table');
}

async function clipboards(browser) {
    for (const [mobile, dark] of [[true, false], [false, true]]) {
        for (const platform of ['android', 'ios']) await clipboard(browser, platform, { mobile, dark });
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const scenarios = [structures, clipboards, noAnswer, messages, lockRows, paused, powerOverTracker, reopened];
        const selected = process.env.SCENARIO ? scenarios.filter((run) => run.name === process.env.SCENARIO) : scenarios;
        assert.ok(selected.length, 'SCENARIO names a scenario of this suite');
        for (const run of selected) await run(browser);
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
