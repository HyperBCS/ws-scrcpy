// node scripts/test-browser.js about-ui
// About facts and service outcomes against isolated synthetic sockets. No application server,
// helper, phone input, unlock or stored-setting command is used by this suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { settleMotion } = require('./ui-motion');

const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-about-ui';
const VERSION = '16 (vendor preview 2026.11.13-r20261113.0810)';
const TOKEN = '27.2.1+syntheticbuild0123456789abcdefghijklmnopqrstuvwxyz0123456789';
const REASON = 'Synthetic session failure: fixture/' + 'long_reason_segment_'.repeat(10);
const ALLOWED = new Set(['list_encoders', 'start_server', 'kill_server', 'refresh_device', 'restart_session', 'remount_ddi']);
const records = { cases: [], geometry: [], pictures: [], commands: [], streams: [], failures: [] };
let base;

function safeBase() {
    assert(process.env.BASE, 'use the isolated browser runner');
    const url = new URL(process.env.BASE);
    assert.equal(url.protocol, 'http:');
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'loopback fixture origin required');
    assert(url.port && !['8000', '8010'].includes(url.port), 'phone-server ports refused');
    assert(!url.username && !url.password);
    return url;
}

function channel(id, message) {
    const body = Buffer.from(JSON.stringify(message));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}

function androidPacket() {
    const frame = Buffer.alloc(186);
    frame.write('scrcpy_initial'); frame.write('About fixture', 14);
    frame.writeInt32BE(1, 78); frame.writeInt32BE(720, 86); frame.writeInt32BE(1280, 90);
    frame.writeInt32BE(25, 110); frame.writeInt32BE(720, 122); frame.writeInt32BE(1280, 126);
    frame.writeInt32BE(720, 130); frame.writeInt32BE(1280, 134);
    frame.writeInt32BE(35, 139); frame.writeInt32BE(4000000, 143); frame.writeInt32BE(60, 147);
    frame.writeInt8(1, 151); frame.writeInt8(-1, 165); frame.writeInt32BE(1, 182);
    return frame;
}

function descriptor(platform, extra = {}) {
    const udid = `about-ui-${platform}-fixture-0123456789abcdefghijklmnopqrstuvwxyz`;
    return platform === 'ios' ? {
        udid, name: 'About iPhone fixture', model: 'iPhone fixture', version: '27.2.1', state: 'Connected',
        session: 'ready', developerMode: true, paired: true, 'screen.power': 'on', 'device.locked': false,
        unlockSchedule: { enabled: false, time: '03:00', hasPasscode: false, serverTimeZone: 'UTC' }, ...extra,
    } : {
        udid, state: 'device', pid: 123, interfaces: [], 'ro.product.manufacturer': 'Fixture',
        'ro.product.model': 'About Android', 'ro.build.version.release': '16', 'ro.build.version.sdk': '36',
        'ro.product.cpu.abi': 'arm64-v8a', 'screen.power': 'on', 'device.awake': true, 'device.locked': false,
        'battery.level': 80, 'battery.charging': false, ...extra,
    };
}

async function settled(page) {
    await settleMotion(page);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function fixture(browser, platform, view, theme, label, extra = {}) {
    const id = `${platform}-${view.name}-${theme}-${label}`;
    const context = await browser.newContext({ viewport: { width: view.width, height: view.height },
        hasTouch: view.touch, isMobile: view.touch, colorScheme: theme, serviceWorkers: 'block' });
    const page = await context.newPage();
    if (platform === 'android' && label === 'actions') await page.clock.install();
    const errors = [];
    const commands = [];
    let item = descriptor(platform, extra);
    let streamCount = 0;
    const streamMessages = [];
    let trackerReply;
    let trackerSocket;
    let onCommand;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== base.origin) {
            errors.push('Blocked non-fixture HTTP request');
            await route.abort();
        } else if (url.pathname.startsWith('/api/notifications/')) {
            await route.fulfill({ status: 200, json: { sources: [], unread: 0, unreadBySource: {} } });
        } else {
            await route.continue();
        }
    });
    await page.routeWebSocket('**', socket => {
        const url = new URL(socket.url());
        assert.equal(url.hostname, base.hostname);
        assert.equal(url.port, base.port);
        const action = url.searchParams.get('action');
        if (['proxy-adb', 'proxy-coredevice'].includes(action)) {
            streamCount++;
            socket.onMessage(data => {
                if (typeof data === 'string') {
                    const message = JSON.parse(data);
                    streamMessages.push({ type: message.type });
                } else {
                    const frame = Buffer.from(data);
                    const detach = frame.length > 0 && frame.length % 3 === 0 &&
                        Array.from({ length: frame.length / 3 }, (_, i) => frame[i * 3]).every(type => type === 14);
                    streamMessages.push({ detach, bytes: frame.length });
                }
            });
            setTimeout(() => {
                if (platform === 'ios') socket.send(JSON.stringify({ type: 'status', state: 'ready' }));
                else socket.send(androidPacket());
            }, 50);
            return;
        }
        trackerSocket = socket;
        socket.onMessage(data => {
            const frame = Buffer.from(data);
            if (frame.length < 5) return;
            const id = frame.readUInt32LE(1);
            const reply = message => socket.send(channel(id, message));
            if (frame[0] === 4) {
                const code = frame.subarray(5).toString();
                if (code === 'HSTS') reply({ id: -1, type: 'hosts', data: { local: [{ type: platform === 'ios' ? 'ios' : 'android' }] } });
                if (code === (platform === 'ios' ? 'ATRC' : 'GTRC')) {
                    trackerReply = reply;
                    reply({ id: -1, type: 'devicelist', data: { id: 'about-fixture', name: 'About fixture', list: [item] } });
                }
            } else if (frame[0] === 32) {
                const command = JSON.parse(frame.subarray(5).toString());
                assert(ALLOWED.has(command.type), `unexpected service command ${command.type}`);
                assert.equal(command.data.udid, item.udid, 'command target is the synthetic phone');
                commands.push(command);
                records.commands.push({ case: id, ...command });
                if (command.type === 'list_encoders') reply({ id: command.id, type: command.type, data: {
                    udid: item.udid, encoders: [{ videoCodec: 'h264', encoderName: 'fixture.encoder', hardware: 'hw' }],
                    config: { bitrate: 3500000, maxFps: 60, maxSize: 1280, iFrameInterval: 10,
                        videoCodec: 'h264', videoEncoder: 'fixture.encoder', audio: true, audioCodec: 'raw', audioSource: 'output' },
                } });
                else onCommand?.(command);
            }
        });
    });
    const url = new URL(base);
    if (view.dock) url.hash = `!${new URLSearchParams({ action: 'device', udid: item.udid, view: 'screen' })}`;
    await page.goto(url.toString());
    if (view.dock) {
        await page.locator('.kit-bar-status', { hasText: 'Connected' }).waitFor();
        await page.locator('.stream-mount').evaluate(node => { window.__aboutMount = node; });
    } else {
        await page.locator(`[data-device-key$=":${item.udid}"]`).waitFor();
    }
    const test = { id, context, page, commands, platform, view, theme, errors,
        item: () => item,
        onCommand: callback => { onCommand = callback; },
        send: extra => {
            item = { ...item, ...extra };
            trackerReply({ id: -1, type: 'device', data: { id: 'about-fixture', name: 'About fixture', device: item } });
        },
        reply: (command, answer, overrides = {}) => trackerReply({ id: overrides.id ?? command.id,
            type: overrides.type ?? command.type, data: { udid: overrides.udid ?? item.udid, ...answer } }),
        drop: () => trackerSocket.close(),
        open: async () => {
            if (view.dock) await page.getByRole('button', { name: 'Settings', exact: true }).click();
            else await page.locator(`[data-device-key$=":${item.udid}"]`).getByRole('button', { name: /^Settings for / }).click();
            test.dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
            await test.dialog.waitFor();
            await settled(page);
            test.about = test.dialog.locator('[data-section="about"]');
            test.services = test.about.locator('.settings-services');
        },
        closeSheet: async () => {
            await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
            await test.dialog.waitFor({ state: 'hidden' });
        },
        button: id => test.services.locator(`[data-service="${id}"] button`),
        count: type => commands.filter(command => command.type === type).length,
        waitCommand: async (type, count) => {
            const until = Date.now() + 4000;
            while (test.count(type) < count && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(test.count(type), count, type + ': expected fixture request received');
            return commands.filter(command => command.type === type).at(-1);
        },
        inventory: expected => {
            const actual = {};
            for (const command of commands) actual[command.type] = (actual[command.type] || 0) + 1;
            assert.deepEqual(actual, expected, id + ': exact command inventory');
        },
        finish: async () => {
            assert.equal(streamCount, view.dock ? 1 : 0, id + ': one socket per open');
            if (view.dock) {
                assert.equal(await page.locator('.stream-mount').evaluate(node => node === window.__aboutMount), true,
                    id + ': metadata and Settings retain the stream mount');
            }
            assert(streamMessages.every(message => message.detach || ['pli', 'keyboard-detach'].includes(message.type)),
                id + ': only benign stream protocol messages, no keys, touches, paste or restart');
            records.streams.push({ case: id, count: streamCount, messages: streamMessages });
            assert.deepEqual(errors, []);
        },
    };
    await test.open();
    records.cases.push({ id, viewport: view, theme });
    return test;
}

async function geometry(test, state) {
    await settled(test.page);
    const result = await test.about.evaluate(about => {
        const rect = node => node?.getBoundingClientRect().toJSON();
        const part = node => {
            if (!node) return null;
            const range = document.createRange(); range.selectNodeContents(node);
            return { rect: rect(node), lines: [...range.getClientRects()].map(r => r.toJSON()),
                clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
        };
        return [...about.querySelectorAll('[data-fact],[data-service]')].map(row => ({
            fact: row.dataset.fact, service: row.dataset.service, rect: rect(row),
            text: part(row.querySelector('.kit-row-text')), title: part(row.querySelector('.kit-row-title')),
            value: part(row.querySelector('.kit-row-value')), description: part(row.querySelector('.kit-row-desc')),
            control: rect(row.querySelector('.kit-row-control')), button: rect(row.querySelector('button')),
            clientWidth: row.clientWidth, scrollWidth: row.scrollWidth,
        }));
    });
    records.geometry.push({ case: test.id, state, rows: result });
    const cards = await test.about.locator('.auto-height.kit-card').evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        const extra = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
            .reduce((sum, key) => sum + parseFloat(style[key]), 0);
        return { height: node.getBoundingClientRect().height,
            naturalHeight: node.firstElementChild.getBoundingClientRect().height + extra,
            inlineHeight: node.style.height };
    }));
    records.geometry.at(-1).cards = cards;
    for (const card of cards) {
        assert(Math.abs(card.height - card.naturalHeight) <= 1, 'card follows its natural content height');
        assert.equal(card.inlineHeight, '', 'no stale fixed card height');
    }
    for (const row of result) {
        assert(row.scrollWidth <= row.clientWidth + 1, `${test.id}/${state}: ${row.fact || row.service} content fits`);
        for (const child of [row.title, row.value, row.description].filter(Boolean)) {
            for (const line of child.lines) {
                assert(line.left >= row.rect.left - 1 && line.right <= row.rect.right + 1,
                    `${test.id}/${state}: text remains readable inside ${row.fact || row.service}`);
            }
        }
    }
    const finite = await test.page.evaluate(() => document.getAnimations().filter(animation => {
        const timing = animation.effect?.getComputedTiming();
        return timing && Number.isFinite(timing.endTime) && animation.playState === 'running';
    }).length);
    assert.equal(finite, 0, 'finite motion has settled');
    return result;
}

// Capture each selected group's full scroll span, including its lower row and border.
async function pictures(test, state, selector) {
    const body = test.dialog.locator('.kit-sheet-body');
    const group = test.about.locator(selector);
    const region = await group.evaluate(node => {
        const body = node.closest('.kit-sheet-body');
        const b = body.getBoundingClientRect(); const r = node.getBoundingClientRect();
        return { top: body.scrollTop + r.top - b.top, bottom: body.scrollTop + r.bottom - b.top,
            height: body.clientHeight, max: body.scrollHeight - body.clientHeight };
    });
    const positions = [Math.max(0, region.top)];
    while (positions.at(-1) + region.height < region.bottom - 1) positions.push(positions.at(-1) + region.height - 24);
    for (const [index, position] of positions.entries()) {
        await body.evaluate((node, value) => { node.scrollTop = value; }, Math.min(position, region.max));
        await settled(test.page);
        const filename = `${test.id}--${state}-${index}.png`;
        await test.page.screenshot({ path: path.join(OUT, filename) });
        records.pictures.push({ case: test.id, state, filename, scrollTop: await body.evaluate(node => node.scrollTop) });
    }
    assert(await group.evaluate(node => {
        const body = node.closest('.kit-sheet-body');
        return node.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 1;
    }), 'selected lower group edge is reachable');
}

const VIEWS = [
    { name: '320-touch-list', width: 320, height: 568, touch: true },
    { name: '390-touch-list', width: 390, height: 844, touch: true },
    { name: '390-mouse-list', width: 390, height: 640, touch: false },
    { name: '956-landscape-list', width: 956, height: 440, touch: true },
    { name: '1280-centred-list', width: 1280, height: 800, touch: false },
    { name: '1024-short-dock', width: 1024, height: 450, touch: false, dock: true },
];

async function layout(browser) {
    for (const platform of ['android', 'ios']) for (const view of VIEWS) for (const theme of ['light', 'dark']) {
        const test = await fixture(browser, platform, view, theme, 'layout');
        try {
            const rows = await geometry(test, 'ordinary');
            const system = rows.find(row => row.fact === 'system');
            assert.equal(system.title.lines.length, 1, 'ordinary System label stays on one line');
            assert.equal(system.value.lines.length, 1, 'ordinary System value stays on one line');
            assert(system.value.rect.left > system.title.rect.right, 'ordinary System keeps inline alignment');
            await pictures(test, 'ordinary-facts', '.settings-facts');
            await pictures(test, 'ordinary-services', '.settings-services');
            if (platform === 'ios') {
                const restart = rows.find(row => row.service === 'restart-services');
                if (view.width < 600 || view.dock) {
                    assert(restart.text.rect.width >= restart.rect.width - 34, 'Restart uses the full narrow text width');
                    assert(restart.control.top >= restart.text.rect.bottom + 7, 'Restart control has kit spacing below its text');
                } else {
                    assert(restart.control.left > restart.text.rect.right, 'centred desktop keeps the inline service layout');
                }
            }
            for (const [state, version] of [['vendor-version', VERSION], ['unbroken-version', TOKEN]]) {
                test.send(platform === 'ios' ? { model: 'Long synthetic marketing model '.repeat(3), version } :
                    { 'ro.product.model': 'Long synthetic marketing model '.repeat(3), 'ro.build.version.release': version });
                await test.about.getByText(version, { exact: true }).waitFor();
                const long = (await geometry(test, state)).find(row => row.fact === 'system');
                assert.equal(long.title.lines.length, 1, 'long metadata never breaks its System label into letters');
                assert(long.value.rect.width > 100, 'long System value has a readable width');
                await pictures(test, state, '.settings-facts');
            }
            if (platform === 'android' && !view.dock) assert(await test.about.locator('.settings-players a').count() > 0);
            test.inventory(platform === 'android' ? { list_encoders: 1 } : {});
            await test.finish();
        } finally {
            await test.context.close();
        }
    }
}

async function confirm(test, id, type, { cancel = false } = {}) {
    const before = test.count(type);
    const outcome = test.services.locator(':scope > .kit-status');
    const previous = await outcome.count() ? await outcome.textContent() : undefined;
    await test.button(id).click();
    const prompt = test.about.getByRole('alertdialog');
    await prompt.waitFor();
    assert.equal(test.count(type), before, 'arming sends no command');
    await prompt.locator('.kit-confirm-go').evaluate(button => button.click());
    assert.equal(test.count(type), before, 'early confirmation is blocked by the existing guard');
    if (previous !== undefined) assert.equal(await outcome.textContent(), previous, 'arming keeps the prior command outcome');
    await pictures(test, `${id}-${cancel ? 'cancel' : 'confirm'}-${before}-armed`, '.kit-confirm');
    if (cancel) {
        await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
        await prompt.waitFor({ state: 'detached' });
        assert.equal(test.count(type), before, 'cancel sends no command');
        if (previous !== undefined) assert.equal(await outcome.textContent(), previous, 'cancel keeps the prior command outcome');
        assert.equal(await test.button(id).evaluate(button => button === document.activeElement), true);
        return;
    }
    await prompt.locator('.kit-confirm-go:not([aria-disabled])').waitFor();
    await prompt.locator('.kit-confirm-go').click();
    await prompt.waitFor({ state: 'detached' });
    await test.page.waitForFunction(() => !document.querySelector('.kit-confirm'));
    await test.waitCommand(type, before + 1);
}

async function androidActions(browser) {
    for (const view of [VIEWS[0], VIEWS[5]]) {
        const test = await fixture(browser, 'android', view, view.dock ? 'dark' : 'light', 'actions', { pid: -1 });
        try {
            let last;
            test.onCommand(command => { last = command; });
            await test.button('stream-service').click();
            await test.button('stream-service').filter({ hasText: /^Starting…$/ }).waitFor();
            await test.waitCommand('start_server', 1);
            assert.deepEqual(last.data, { udid: test.item().udid });
            test.reply(last, { error: 'Wrong request' }, { id: last.id + 10 });
            test.reply(last, { error: 'Wrong phone' }, { udid: 'another-synthetic-phone' });
            test.reply(last, { error: 'Wrong type' }, { type: 'kill_server' });
            await settled(test.page);
            assert.equal(await test.services.locator('.kit-status').count(), 0);
            test.reply(last, { error: 'Synthetic Start refused.' });
            await test.services.getByRole('alert').filter({ hasText: 'Synthetic Start refused.' }).waitFor();
            await test.button('stream-service').filter({ hasText: /^Start$/ }).waitFor();
            assert.equal(await test.button('stream-service').isDisabled(), false, 'matched refusal clears Starting promptly');
            await geometry(test, 'start-refused');
            await pictures(test, 'start-refused', '.settings-services');

            await test.button('stream-service').click();
            await test.waitCommand('start_server', 2);
            const successfulStart = last;
            test.send({ pid: 456 });
            await test.button('stream-service').filter({ hasText: /^Stop$/ }).waitFor();
            test.reply(successfulStart, { error: 'Late Start refusal after confirmed running' });
            await settled(test.page);
            assert.equal(await test.services.locator('.kit-status').count(), 0, 'descriptor success wins over late failure');
            await confirm(test, 'stream-service', 'kill_server', { cancel: true });
            await confirm(test, 'stream-service', 'kill_server');
            assert.deepEqual(last.data, { udid: test.item().udid, pid: 456 });
            test.reply(last, { error: 'Synthetic Stop refused.' });
            await test.services.getByRole('alert').filter({ hasText: 'Synthetic Stop refused.' }).waitFor();
            await pictures(test, 'stop-refused', '.settings-services');
            await confirm(test, 'stream-service', 'kill_server');
            const successfulStop = last;
            test.send({ pid: -1 });
            await test.button('stream-service').filter({ hasText: /^Start$/ }).waitFor();
            test.reply(successfulStop, { error: 'Late Stop refusal after confirmed stopped' });
            await settled(test.page);
            assert.equal(await test.services.locator('.kit-status').count(), 0);

            // No acknowledgment: keep the original eight-second Starting fallback and no invented error.
            await test.button('stream-service').click();
            await test.waitCommand('start_server', 3);
            const oldStart = last;
            await test.page.clock.runFor(8001);
            await test.page.clock.resume();
            await test.button('stream-service').filter({ hasText: /^Start$/ }).waitFor();
            assert.equal(await test.services.locator('.kit-status').count(), 0);
            await test.button('stream-service').click();
            await test.waitCommand('start_server', 4);
            const newStart = last;
            test.reply(oldStart, { error: 'Old action refused after new Start' });
            await settled(test.page);
            assert.equal(await test.button('stream-service').textContent(), 'Starting…', 'old action cannot clear the new Starting marker');
            test.reply(newStart, { error: 'Current Start refused.' });
            await settled(test.page);
            await test.services.getByRole('alert').filter({ hasText: 'Current Start refused.' }).waitFor();

            await test.button('stream-service').click();
            await test.waitCommand('start_server', 5);
            const oldOpening = last;
            await test.closeSheet();
            test.send({ pid: 789 });
            await test.open();
            test.reply(oldOpening, { error: 'Old opening refusal' });
            await settled(test.page);
            assert.equal(await test.services.locator('.kit-status').count(), 0);
            test.inventory({ list_encoders: 2, start_server: 5, kill_server: 2 });
            await test.finish();
        } finally {
            await test.context.close();
        }
    }
}

async function metadata(browser) {
    for (const view of [VIEWS[0], VIEWS[5]]) {
        const test = await fixture(browser, 'ios', view, view.dock ? 'dark' : 'light', 'metadata');
        try {
            test.send({ state: 'unauthorized', model: '<NoModel>', version: '<NoVersion>', session: 'stopped' });
            await test.about.locator('[data-fact="status"] .kit-row-value', { hasText: 'Unauthorized' }).waitFor();
            assert.equal(await test.about.locator('[data-fact="model"] .kit-row-desc').textContent(), 'Unknown');
            assert.equal(await test.about.locator('[data-fact="system"] .kit-row-value').textContent(), 'Unknown');
            await geometry(test, 'unread-metadata');
            await pictures(test, 'unread-metadata', '.settings-facts');
            for (const state of ['offline', 'unauthorized', 'Connected']) {
                test.send({ state, model: 'Known <NoModel> suffix', version: 'Known <NoVersion> suffix', session: 'stopped' });
                await test.about.getByText('Known <NoVersion> suffix', { exact: true }).waitFor();
                assert.equal(await test.about.locator('[data-fact="model"] .kit-row-desc').textContent(), 'Known <NoModel> suffix');
            }
            test.send({ session: 'error', sessionMessage: REASON, developerMode: false });
            await test.services.locator('[data-service="stream-service"] .kit-row-desc', { hasText: REASON }).waitFor();
            assert.equal(await test.services.getByText(REASON, { exact: true }).count(), 1);
            assert.equal(await test.button('stream-service').isDisabled(), true);
            await geometry(test, 'session-reason');
            await pictures(test, 'session-reason', '.settings-services');
            test.send({ session: 'stopped', sessionMessage: undefined, developerMode: true });
            await test.services.getByText('Stopped. It starts when the screen is opened.', { exact: true }).waitFor();
            assert.equal(await test.services.getByText(REASON, { exact: true }).count(), 0);
            test.drop();
            await test.about.locator('[data-fact="connection"] .kit-row-value', { hasText: 'Reconnecting…' }).waitFor();
            assert.equal(await test.about.locator('[data-fact="model"] .kit-row-desc').textContent(), 'Known <NoModel> suffix');
            assert.equal(await test.about.locator('[data-fact="system"] .kit-row-value').textContent(), 'Known <NoVersion> suffix');
            test.inventory({});
            await test.finish();
        } finally {
            await test.context.close();
        }
    }
}

async function iosActions(browser) {
    for (const view of [VIEWS[0], VIEWS[5]]) {
        const test = await fixture(browser, 'ios', view, view.dock ? 'dark' : 'light', 'actions');
        try {
            let last;
            test.onCommand(command => { last = command; });
            if (view.dock) {
                assert.equal(await test.button('stream-service').isDisabled(), true, 'own-screen Stop remains unavailable');
                await test.button('stream-service').evaluate(button => button.click());
                assert.equal(test.count('kill_server'), 0);
            } else {
                await confirm(test, 'stream-service', 'kill_server', { cancel: true });
                await confirm(test, 'stream-service', 'kill_server');
                assert.deepEqual(last.data, { udid: test.item().udid, pid: 1 });
                test.reply(last, { error: 'Wrong id' }, { id: last.id + 1 });
                test.reply(last, { error: 'Wrong phone' }, { udid: 'other-synthetic-phone' });
                test.reply(last, { error: 'Synthetic iPhone Stop refused.' });
                await test.services.getByRole('alert').filter({ hasText: 'Synthetic iPhone Stop refused.' }).waitFor();
                await pictures(test, 'stop-refused', '.settings-services');
                await confirm(test, 'stream-service', 'kill_server');
                test.reply(last, { result: null });
                await settled(test.page);
                assert.equal(await test.services.locator('.kit-status').count(), 0, 'acknowledgment makes no shutdown claim');
                assert.equal(await test.button('stream-service').isDisabled(), false, 'acknowledgment alone does not change the descriptor');
                test.send({ session: 'stopped' });
                await test.page.waitForFunction(() => document.querySelector('[data-service="stream-service"] button')?.disabled);
            }

            const refresh = test.button('refresh');
            const before = (await geometry(test, 'refresh-before')).find(row => row.service === 'refresh');
            await refresh.focus();
            await refresh.evaluate(button => { window.__aboutFocusedButton = button; });
            await refresh.click();
            await test.services.getByText('Refreshing…', { exact: true }).waitFor();
            await test.waitCommand('refresh_device', 1);
            assert.equal(await refresh.getAttribute('aria-busy'), 'true');
            assert.equal(await refresh.getAttribute('aria-disabled'), 'true');
            assert.equal(await refresh.isDisabled(), false);
            assert.equal(await refresh.evaluate(button => button === document.activeElement && button === window.__aboutFocusedButton), true);
            for (const id of ['stream-service', 'restart-services', 'remount']) assert.equal(await test.button(id).isDisabled(), true);
            await refresh.evaluate(button => { button.click(); button.click(); });
            await test.page.keyboard.press('Enter');
            await test.page.keyboard.press('Space');
            await refresh.click({ force: true });
            assert.equal(test.count('refresh_device'), 1, 'busy rejects pointer, keyboard and programmatic repeats');
            const pending = (await geometry(test, 'refresh-pending')).find(row => row.service === 'refresh');
            assert.equal(pending.button.height, before.button.height, 'busy keeps the target height');
            await pictures(test, 'refresh-pending', '.settings-services');
            test.reply(last, { result: null });
            await test.services.getByText('Phone info refreshed.', { exact: true }).waitFor();
            assert.equal(await refresh.evaluate(button => button === document.activeElement && button === window.__aboutFocusedButton), true);
            await geometry(test, 'refresh-success');
            await refresh.click();
            await test.waitCommand('refresh_device', 2);
            test.reply(last, { error: REASON });
            await test.services.getByRole('alert').filter({ hasText: REASON }).waitFor();
            assert.equal(await refresh.evaluate(button => button === document.activeElement), true);
            await pictures(test, 'refresh-refused', '.settings-services');

            await confirm(test, 'restart-services', 'restart_session', { cancel: true });
            await confirm(test, 'restart-services', 'restart_session');
            await test.services.getByText('Restarting services…', { exact: true }).waitFor();
            await geometry(test, 'restart-pending');
            await pictures(test, 'restart-pending', '.settings-services');
            test.reply(last, { result: 'Synthetic restart request accepted.' });
            await test.services.getByText('Synthetic restart request accepted.', { exact: true }).waitFor();
            await confirm(test, 'remount', 'remount_ddi', { cancel: true });
            await confirm(test, 'remount', 'remount_ddi');
            test.reply(last, { error: 'Synthetic Remount refused.' });
            await test.services.getByRole('alert').filter({ hasText: 'Synthetic Remount refused.' }).waitFor();
            await pictures(test, 'remount-refused', '.settings-services');

            await refresh.click();
            await test.waitCommand('refresh_device', 3);
            const oldOpening = last;
            await test.closeSheet();
            await test.open();
            await refresh.click();
            await test.waitCommand('refresh_device', 4);
            const current = last;
            test.reply(oldOpening, { error: 'Old opening error' });
            await settled(test.page);
            await test.services.getByText('Refreshing…', { exact: true }).waitFor();
            test.reply(current, { result: 'Current opening refreshed.' });
            await test.services.getByText('Current opening refreshed.', { exact: true }).waitFor();
            test.reply(oldOpening, { result: 'Old opening late success' });
            await settled(test.page);
            assert.equal(await test.services.getByText('Old opening late success', { exact: true }).count(), 0);

            await refresh.click();
            await test.services.getByText('Refreshing…', { exact: true }).waitFor();
            await test.waitCommand('refresh_device', 5);
            test.drop();
            await test.services.getByRole('alert').filter({ hasText: 'The connection to the server dropped before it answered.' }).waitFor();
            await test.services.locator('.kit-group-hint').waitFor();
            assert.equal(await refresh.isDisabled(), true, 'availability loss may natively disable the focused action');
            await pictures(test, 'tracker-drop', '.settings-services');
            await test.page.waitForFunction(() => !document.querySelector('.settings-services .kit-group-hint'));
            await test.services.getByRole('alert').filter({ hasText: 'The connection to the server dropped before it answered.' }).waitFor();
            assert.equal(await refresh.isDisabled(), false, 'recovery enables actions while retaining the last outcome');
            await pictures(test, 'tracker-recovered-last-outcome', '.settings-services');
            test.inventory(view.dock ? { refresh_device: 5, restart_session: 1, remount_ddi: 1 } :
                { kill_server: 2, refresh_device: 5, restart_session: 1, remount_ddi: 1 });
            await test.finish();
        } finally {
            await test.context.close();
        }
    }
}

async function main() {
    base = safeBase();
    fs.mkdirSync(OUT, { recursive: true });
    const flows = { layout, metadata, androidActions, iosActions };
    assert(!process.env.ABOUT_CASE || Object.hasOwn(flows, process.env.ABOUT_CASE), 'known About case required');
    const browser = await chromium.launch({ headless: true });
    try {
        for (const [name, run] of Object.entries(flows)) {
            if (process.env.ABOUT_CASE && process.env.ABOUT_CASE !== name) continue;
            try {
                await run(browser);
                console.log('PASS About UI', name);
            } catch (error) {
                for (const context of browser.contexts()) await context.close();
                records.failures.push({ name, message: error.message, stack: error.stack });
                console.error('FAIL About UI', name, error);
            }
        }
    } finally {
        await browser.close();
        fs.writeFileSync(path.join(OUT, 'about-result.json'), JSON.stringify(records, null, 2) + '\n');
    }
    assert.deepEqual(records.failures, [], 'About UI regressions');
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
