// node scripts/test-browser.js settings
// The Settings sheet of an Android phone. All WebSockets are fixtures: long phone and encoder
// labels, audio errors and apply failures exercise the real sheet without reaching a phone or
// changing real settings. Also: the sections and their order, a change that applies when it is
// made, the question when other screens are open, the sheet opened from the list for a phone in
// any state, and the passcode saved in this browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { settleMotion } = require('./ui-motion');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-settings';
const UDID = 'settings-layout-fixture-0123456789abcdefghijklmnopqrstuvwxyz';
const ENCODER = 'c2.vendor.hardware.encoder.avc.' + 'very_long_encoder_identifier_'.repeat(7);
const FAILURE = 'The device reported an encoder startup failure at /data/local/tmp/' + 'diagnostic_segment_'.repeat(12);

function channelJson(id, data) {
    const body = Buffer.from(JSON.stringify(data));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 32;
    frame.writeUInt32LE(id, 1);
    body.copy(frame, 5);
    return frame;
}
function audioError() {
    const body = Buffer.from(JSON.stringify({ status: 'error', sampleRate: 48000, channels: 2, message: FAILURE }));
    const frame = Buffer.alloc(23 + body.length);
    frame.write('scrcpy_audio_2');
    frame[14] = 2;
    body.copy(frame, 23);
    return frame;
}
async function fixture(page, { onApply, onStreamMessage, initialPacket, onStreamReady, sdk = '36', deviceList, onCommand, onTrackerReady } = {}) {
    const commands = [];
    await page.routeWebSocket('**', (socket) => {
        const target = new URL(socket.url());
        if (target.pathname === '/__settings_fixture__' || target.searchParams.get('action') === 'proxy-adb') {
            if (onStreamMessage) socket.onMessage(onStreamMessage);
            setTimeout(() => {
                const packet = Buffer.alloc(90);
                packet.write('scrcpy_initial');
                packet.write('Settings layout fixture', 14);
                packet.writeInt32BE(1, 86);
                socket.send(initialPacket || packet);
                const sendAudioError = () => socket.send(audioError());
                if (onStreamReady) onStreamReady({ sendAudioError, send: (data) => socket.send(data), close: () => socket.close() });
                else sendAudioError();
            }, 100);
            return;
        }
        socket.onMessage((data) => {
            const frame = Buffer.from(data);
            if (frame.length < 5) return;
            const id = frame.readUInt32LE(1);
            const reply = (message) => socket.send(channelJson(id, message));
            if (frame[0] === 4) {
                const code = frame.subarray(5).toString();
                if (code === 'HSTS') reply({ id: -1, type: 'hosts', data: { local: [{ type: 'android' }] } });
                if (code === 'GTRC') {
                    const sendDeviceList = (next = deviceList) => reply({
                        id: -1,
                        type: 'devicelist',
                        data: {
                            id: 'settings-fixture-tracker',
                            name: 'Settings test host',
                            list: next || [
                                {
                                    udid: UDID,
                                    state: 'device',
                                    pid: 123,
                                    interfaces: [],
                                    'ro.product.model': 'Foldable device with a descriptive model name',
                                    'ro.product.manufacturer': 'Fixture',
                                    'ro.build.version.release': '16',
                                    'ro.build.version.sdk': sdk,
                                    'ro.product.cpu.abi': 'arm64-v8a',
                                    'screen.power': 'on',
                                    'device.awake': true,
                                    'battery.level': 80,
                                    'battery.charging': false,
                                },
                            ],
                        },
                    });
                    sendDeviceList();
                    if (onTrackerReady) onTrackerReady({ sendDeviceList });
                }
            } else if (frame[0] === 32) {
                const command = JSON.parse(frame.subarray(5).toString());
                commands.push(command);
                if (onCommand) onCommand(command, reply);
                if (command.type === 'list_encoders')
                    reply({
                        id: command.id,
                        type: command.type,
                        data: {
                            udid: UDID,
                            encoders: [{ videoCodec: 'h264', encoderName: ENCODER, hardware: 'hw' }],
                            config: {
                                bitrate: 3500000,
                                maxFps: 60,
                                maxSize: 1280,
                                iFrameInterval: 10,
                                videoCodec: 'h264',
                                videoEncoder: ENCODER,
                                audio: true,
                                audioCodec: 'raw',
                                audioSource: 'output',
                            },
                        },
                    });
                if (command.type === 'update_stream_config') {
                    if (onApply) onApply(command, reply);
                    else reply({ id: command.id, type: command.type, data: { udid: UDID, error: FAILURE } });
                }
            }
        });
    });
    return commands;
}
async function geometry(page, label) {
    const result = await page.locator('dialog.kit-sheet[open] .kit-sheet-body').evaluate((body) => {
        const bounds = body.getBoundingClientRect();
        const style = getComputedStyle(body);
        const panel = body.closest('.kit-sheet-panel');
        const offenders = Array.from(
            panel.querySelectorAll('select, input, button, .kit-row, .kit-banner, .kit-status'),
        )
            .filter((el) => el.getClientRects().length)
            .map((el) => {
                const rect = el.getBoundingClientRect();
                return {
                    tag: el.tagName,
                    name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 42),
                    left: rect.left,
                    right: rect.right,
                    width: rect.width,
                };
            })
            .filter((el) => el.left < bounds.left - 1 || el.right > bounds.right + 1);
        const overflowingContent = Array.from(
            panel.querySelectorAll('.settings, .settings-section, details, .details-content, .kit-row, .kit-banner, .kit-confirm'),
        )
            .filter((el) => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1)
            .map((el) => ({ className: el.className, width: el.clientWidth, scrollWidth: el.scrollWidth }));
        body.scrollLeft = 100;
        return {
            width: body.clientWidth,
            scrollWidth: body.scrollWidth,
            scrollLeft: body.scrollLeft,
            overflowX: style.overflowX,
            touchAction: style.touchAction,
            offenders,
            overflowingContent,
        };
    });
    console.log(label, JSON.stringify(result));
    assert(result.scrollWidth <= result.width + 1, label + ': no horizontal content overflow');
    assert.equal(result.scrollLeft, 0, label + ': no horizontal scroll position');
    assert.equal(result.overflowX, 'hidden', label + ': horizontal scroll gestures are disabled');
    assert.equal(result.touchAction, 'pan-y', label + ': sheet permits vertical touch scrolling');
    assert.deepEqual(result.offenders, [], label + ': controls remain inside the sheet');
    assert.deepEqual(result.overflowingContent, [], label + ': content fits before clipping is applied');
}

// The stream's first packet with one display. `others` is how many other screens show the same
// stream: the sheet reads it to know whether a restart reconnects them.
function streamPacket(others = 0) {
    const packet = Buffer.alloc(186);
    packet.write('scrcpy_initial');
    packet.write('Settings layout fixture', 14);
    packet.writeInt32BE(1, 78);
    packet.writeInt32BE(720, 86);
    packet.writeInt32BE(1280, 90);
    packet.writeInt32BE(others, 106);
    packet.writeInt32BE(25, 110);
    packet.writeInt32BE(720, 122);
    packet.writeInt32BE(1280, 126);
    packet.writeInt32BE(720, 130);
    packet.writeInt32BE(1280, 134);
    packet.writeInt32BE(35, 139);
    packet.writeInt32BE(4000000, 143);
    packet.writeInt32BE(60, 147);
    packet.writeInt8(1, 151);
    packet.writeInt8(-1, 165);
    packet.writeInt32BE(1, 182);
    return packet;
}

const NAME = 'Fixture Foldable device with a descriptive model name';
const settingsSheet = (page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const sectionsOf = (dialog) =>
    dialog
        .locator('.settings-section')
        .evaluateAll((nodes) => nodes.map((node) => [node.dataset.section, node.querySelector('.settings-section-title').textContent]));
const ANDROID_SECTIONS = [
    ['stream', 'Stream'],
    ['sound', 'Sound'],
    ['keyboard', 'Keyboard'],
    ['unlock', 'Unlock'],
    ['about', 'About and troubleshooting'],
];
const group = (dialog, className) => dialog.locator(`section.kit-group.${className}`);
const statusOf = (dialog, className) => group(dialog, className).locator(':scope > .kit-status');
const applies = (commands) => commands.filter((command) => command.type === 'update_stream_config');

async function openStream(browser, { width = 390, height = 844, mobile = true, colorScheme = 'light', ...options } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile, colorScheme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const commands = await fixture(page, options);
    const socket = new URL('/__settings_fixture__', BASE);
    socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(BASE);
    url.hash = `!${new URLSearchParams({ action: 'stream', udid: UDID, player: 'webcodecs', ws: socket.toString(), captureKeyboard: '0' })}`;
    await page.goto(url.toString());
    await page.getByText('Connected', { exact: true }).waitFor();
    const open = async () => {
        if (mobile) await page.getByRole('button', { name: 'Show controls', exact: true }).click();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const dialog = settingsSheet(page);
        await dialog.waitFor();
        await page.waitForFunction(
            (encoder) => document.querySelector('[data-setting="encoder"] select')?.value === encoder,
            ENCODER,
        );
        await settleMotion(page);
        return dialog;
    };
    return { context, page, errors, commands, open };
}

/** Sizes, scrolling and long labels at four sizes, and a change the phone refuses, said in place. */
async function layoutFlow(browser) {
    for (const [label, width, height, mobile] of [
        ['phone320', 320, 568, true],
        ['iphone17pm', 440, 956, true],
        ['iphone17pm-landscape', 956, 440, true],
        ['desktop', 1280, 900, false],
    ]) {
        const test = await openStream(browser, { width, height, mobile, colorScheme: 'dark' });
        const { page, commands, errors } = test;
        const dialog = await test.open();
        await page.locator('.settings-audio [data-audio-state="error"]').waitFor();
        await dialog.evaluate((el) => {
            el.querySelectorAll('details').forEach((details) => {
                details.open = true;
            });
            el.querySelectorAll('.settings-playback option').forEach((option) => {
                option.textContent += ' — a player with a deliberately long descriptive name';
            });
        });
        await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
        const playback = await dialog.locator('.settings-playback').textContent();
        assert(/Show quality stats/.test(playback), label + ': playback settings are listed');
        assert(!/Fit screen/i.test(playback), label + ': no Fit screen toggle, the picture always fits');
        await geometry(page, label + ' all sections');
        await page.screenshot({ path: path.join(OUT, label + '-quality.png') });
        await page.locator('.settings-audio').evaluate((el) => {
            const body = el.closest('.kit-sheet-body');
            body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 16;
        });
        const scroller = page.locator('dialog.kit-sheet[open] .kit-sheet-body');
        assert((await scroller.evaluate((body) => body.scrollTop)) > 0, 'settings content can scroll vertically');
        await scroller.hover();
        await page.mouse.wheel(500, 0);
        await geometry(page, label + ' horizontal gesture');
        await page.screenshot({ path: path.join(OUT, label + '-sound.png') });
        // The fixture refuses every change: the long reason shows in place, under the presets.
        await dialog.getByRole('radio', { name: 'Data saver', exact: true }).click();
        await statusOf(dialog, 'settings-quality').and(page.getByRole('alert')).waitFor();
        await geometry(page, label + ' error');
        await page.screenshot({ path: path.join(OUT, label + '-error.png') });
        assert.equal(applies(commands).length, 1, 'the change reached only the mocked tracker, once');
        assert.deepEqual(errors, [], 'no browser runtime errors');
        await test.context.close();
    }
    console.log('PASS Settings sizing, scrolling, spacing, long labels and a refused change at four sizes');
}

/** Sections in their order; a preset applies when pressed, says so in place, and no Apply bar is left. */
async function applyFlow(browser) {
    for (const [width, height, mobile] of [[390, 844, true], [1280, 800, false]]) {
        for (const colorScheme of ['light', 'dark']) {
            const label = `${width} ${colorScheme}`;
            let answer;
            const test = await openStream(browser, {
                width,
                height,
                mobile,
                colorScheme,
                initialPacket: streamPacket(0),
                onApply: (command, reply) => {
                    answer = (data) => reply({ id: command.id, type: command.type, data: { udid: UDID, ...data } });
                },
            });
            const { page, commands, errors } = test;
            try {
                const dialog = await test.open();
                assert.deepEqual(await sectionsOf(dialog), ANDROID_SECTIONS, `${label}: the five sections in their order`);
                assert.equal(await dialog.locator('.kit-sheet-subtitle').textContent(), NAME);
                assert.equal(await dialog.locator('.kit-sheet-footer').count(), 0, `${label}: no footer and no Apply bar`);
                assert.equal(await dialog.getByRole('button', { name: /Apply|Discard|Keep editing/ }).count(), 0, `${label}: no Apply step`);
                // Sound is here once, with the rows the Actions sheet has today.
                await group(dialog, 'settings-audio').getByText('Listen in this browser', { exact: true }).waitFor();
                await group(dialog, 'settings-audio').getByText('Volume', { exact: true }).waitFor();
                // One keyboard label on both kinds of phone.
                await dialog.getByRole('switch', { name: 'Send this keyboard to the phone' }).waitFor();
                assert.equal(await dialog.getByText('Physical keyboard').count(), 0);
                await page.screenshot({ path: path.join(OUT, `apply-${width}-${colorScheme}-open.png`) });

                // A preset applies when pressed: one command, the values in place, the sheet held.
                const saver = dialog.getByRole('radio', { name: 'Data saver', exact: true });
                await saver.click();
                const quality = statusOf(dialog, 'settings-quality');
                await quality.filter({ hasText: 'Restarting stream…' }).waitFor();
                assert.deepEqual(
                    applies(commands).map((command) => command.data.config),
                    [{ bitrate: 1000000, maxFps: 30, maxSize: 720, videoEncoder: '' }],
                    `${label}: one change, sent at once`,
                );
                assert.equal(await saver.isChecked(), true, `${label}: the pressed preset shows while it is applied`);
                assert.equal(await statusOf(dialog, 'settings-audio').count(), 0, `${label}: the outcome is where the change was made`);
                const close = page.getByRole('button', { name: 'Close Settings', exact: true });
                assert.equal(await close.isDisabled(), true, `${label}: the sheet stays while the stream restarts`);
                await page.keyboard.press('Escape');
                await page.waitForTimeout(150);
                assert.equal(await dialog.isVisible(), true, `${label}: Escape waits for the restart`);
                await page.screenshot({ path: path.join(OUT, `apply-${width}-${colorScheme}-restarting.png`) });
                answer({
                    config: {
                        bitrate: 1000000,
                        maxFps: 30,
                        maxSize: 720,
                        iFrameInterval: 10,
                        videoCodec: 'h264',
                        videoEncoder: '',
                        audio: true,
                        audioCodec: 'raw',
                        audioSource: 'output',
                    },
                });
                await quality.filter({ hasText: 'Settings saved.' }).waitFor();
                assert.equal(await quality.getAttribute('class'), 'kit-status kit-status-success');
                assert.equal(await saver.isChecked(), true);
                assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true, `${label}: focus stays in the sheet`);

                // A change the phone refuses, made from the keyboard: the reason in place, the
                // control shows what the phone runs, and focus is back on the presets.
                await saver.focus();
                await page.keyboard.press('ArrowRight');
                await quality.filter({ hasText: 'Restarting stream…' }).waitFor();
                assert.deepEqual(applies(commands).at(-1).data.config, { bitrate: 3500000, maxFps: 60, maxSize: 1280 });
                answer({ error: 'encoder failed' });
                await quality.filter({ hasText: 'Could not apply changes: encoder failed' }).waitFor();
                assert.equal(await quality.getAttribute('role'), 'alert');
                assert.equal(await saver.isChecked(), true, `${label}: a refused preset leaves the one the phone runs`);
                assert.equal(await close.isDisabled(), false);
                assert.equal(
                    await page.evaluate(() => !!document.activeElement?.closest('[data-setting="quality"]')),
                    true,
                    `${label}: focus is back on the presets`,
                );

                // Sound capture is a stream value too, and its outcome is under Sound.
                await dialog.getByRole('switch', { name: 'Capture audio' }).click();
                await statusOf(dialog, 'settings-audio').filter({ hasText: 'Restarting stream…' }).waitFor();
                assert.deepEqual(applies(commands).at(-1).data.config, { audio: false });
                assert.equal(await quality.count(), 0, `${label}: the earlier outcome under Stream is gone`);
                answer({});
                await statusOf(dialog, 'settings-audio').filter({ hasText: 'Settings saved.' }).waitFor();
                assert.equal(await dialog.getByRole('switch', { name: 'Capture audio' }).isChecked(), false, `${label}: capture shows what the phone now runs`);
                await geometry(page, `${label} saved`);
                await statusOf(dialog, 'settings-audio').scrollIntoViewIfNeeded();
                await settleMotion(page);
                await page.screenshot({ path: path.join(OUT, `apply-${width}-${colorScheme}-saved.png`) });
                assert.equal(applies(commands).length, 3);
                assert.deepEqual(errors, []);
            } finally {
                await test.context.close();
            }
        }
    }
    console.log('PASS Settings: five sections in order, a change applies when made, Restarting stream… and the result in place, no Apply bar');
}

/** With other screens open the restart is asked first, and nothing is sent before the answer. */
async function viewersFlow(browser) {
    let answer;
    const test = await openStream(browser, {
        width: 1280,
        height: 800,
        mobile: false,
        initialPacket: streamPacket(2),
        onApply: (command, reply) => {
            answer = () => reply({ id: command.id, type: command.type, data: { udid: UDID } });
        },
    });
    const { page, commands, errors } = test;
    try {
        const dialog = await test.open();
        const saver = dialog.getByRole('radio', { name: 'Data saver', exact: true });
        await saver.click();
        const prompt = dialog.getByRole('alertdialog');
        await prompt.waitFor();
        assert.equal(await prompt.locator('.kit-confirm-question').textContent(), `Restart the stream of ${NAME}?`);
        assert.equal(await prompt.locator('.kit-confirm-consequence').textContent(), '2 other open screens will also reconnect.');
        assert.equal(await group(dialog, 'settings-quality').locator('.kit-confirm').count(), 1, 'the question is under the presets');
        assert.equal(applies(commands).length, 0, 'nothing is sent before the answer');
        await page.screenshot({ path: path.join(OUT, 'viewers-question.png') });
        await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
        await prompt.waitFor({ state: 'detached' });
        assert.equal(await saver.isChecked(), false, 'a cancelled change leaves the preset the phone runs');
        assert.equal(applies(commands).length, 0);

        await saver.click();
        await prompt.locator('.kit-confirm-actions .kit-button:not([aria-disabled])').first().waitFor();
        await prompt.getByRole('button', { name: 'Restart stream', exact: true }).click();
        await statusOf(dialog, 'settings-quality').filter({ hasText: 'Restarting stream…' }).waitFor();
        assert.equal(applies(commands).length, 1, 'sent once, after the answer');
        answer();
        await statusOf(dialog, 'settings-quality').filter({ hasText: 'Settings saved.' }).waitFor();
        assert.deepEqual(errors, []);
    } finally {
        await test.context.close();
    }
    console.log('PASS Settings asks before a restart that reconnects other screens');
}

const phone = (udid, model, extra = {}) => ({
    udid,
    state: 'device',
    pid: 123,
    interfaces: [],
    'ro.product.model': model,
    'ro.product.manufacturer': 'Fixture',
    'ro.build.version.release': '16',
    'ro.build.version.sdk': '36',
    'ro.product.cpu.abi': 'arm64-v8a',
    'screen.power': 'on',
    'device.awake': true,
    'battery.level': 80,
    'battery.charging': false,
    ...extra,
});
const PASSCODE = '908172';

/** From the list, for a phone that is offline, unauthorized or asleep, and the passcode saved here. */
async function listFlow(browser) {
    const list = [
        phone(UDID, 'Pixel ready'),
        phone('settings-offline-0001', 'Pixel offline', { state: 'offline', pid: -1 }),
        phone('settings-unauthorized-0001', 'Pixel unauthorized', { state: 'unauthorized', pid: -1 }),
        phone('settings-asleep-0001', 'Pixel asleep', { 'screen.power': 'off', 'device.awake': false }),
    ];
    // The fixture answers for its own phone; the others get an answer of their own.
    const onCommand = (command, reply) => {
        if (command.type === 'list_encoders' && command.data.udid !== UDID) {
            reply({ id: command.id, type: command.type, data: { udid: command.data.udid, encoders: [], config: { bitrate: 3500000, maxFps: 60, maxSize: 1280, iFrameInterval: 10, videoCodec: 'h264', videoEncoder: '', audio: true, audioCodec: 'raw', audioSource: 'output' } } });
        }
    };
    for (const [width, height, mobile] of [[390, 844, true], [1280, 800, false]]) {
        for (const colorScheme of ['light', 'dark']) {
            const label = `${width} ${colorScheme}`;
            const context = await browser.newContext({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile, colorScheme });
            // Saved by an Unlock sheet earlier, once the phone had confirmed it.
            await context.addInitScript(([udid, value]) => {
                if (!sessionStorage.getItem('seeded')) {
                    localStorage.setItem(`ws-scrcpy:remembered-passcode:${udid}`, JSON.stringify({ value, mode: 'pin' }));
                    sessionStorage.setItem('seeded', '1');
                }
            }, [UDID, PASSCODE]);
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            const commands = await fixture(page, { deviceList: list, onCommand });
            try {
                await page.goto(BASE);
                for (const [udid, model, status, connected] of [
                    ['settings-offline-0001', 'Pixel offline', 'Offline', false],
                    ['settings-unauthorized-0001', 'Pixel unauthorized', 'Unauthorized', false],
                    ['settings-asleep-0001', 'Pixel asleep', 'Asleep', true],
                ]) {
                    const before = commands.length;
                    const what = `${label} ${status}`;
                    await page
                        .locator(`[data-device-key$=":${udid}"]`)
                        .getByRole('button', { name: `Settings for Fixture ${model}`, exact: true })
                        .click();
                    const dialog = settingsSheet(page);
                    await dialog.waitFor();
                    await settleMotion(page);
                    assert.deepEqual(await sectionsOf(dialog), ANDROID_SECTIONS, `${what}: the same sections in any state`);
                    const about = dialog.locator('[data-section="about"]');
                    const fact = (name) => about.locator(`[data-fact="${name}"] .kit-row-value`).textContent();
                    assert.equal(await fact('status'), status);
                    assert.equal(await about.locator('[data-fact="serial"] .kit-row-desc').textContent(), udid);
                    assert.equal(await fact('system'), '16');
                    assert.equal(await fact('screen'), connected ? 'Asleep' : 'Unknown');
                    assert.equal(await fact('connection'), connected ? 'Connected' : 'Offline');
                    const service = about.locator('[data-service="stream-service"]');
                    assert.equal(await service.getByRole('button').isDisabled(), !connected, `${what}: the service row needs the phone`);
                    if (!connected) {
                        await dialog.getByText('The phone is not connected. Settings that need it are off until it is back.', { exact: true }).waitFor();
                        assert.equal(await dialog.locator('[data-setting="quality"] .kit-row-desc').textContent(), 'Not available while the phone is not connected.');
                        assert.equal(await dialog.getByRole('radio', { name: 'Balanced', exact: true }).isDisabled(), true, `${what}: rows that need the phone are off, not hidden`);
                        assert.equal(await about.locator('.settings-services .kit-group-hint').textContent(), 'Not available while the phone is not connected.');
                        assert.equal(commands.slice(before).filter((command) => command.type === 'list_encoders').length, 0, `${what}: nothing is asked of a phone that is not there`);
                    } else {
                        await dialog.locator('[data-setting="quality"] .kit-row-desc', { hasText: 'Balanced' }).waitFor();
                        assert.equal(await dialog.getByRole('radio', { name: 'Balanced', exact: true }).isDisabled(), false);
                        assert.equal(await service.locator('.kit-row-desc').textContent(), 'Running. Stopping it ends the stream for every viewer.');
                    }
                    // Rows that need the screen say so.
                    assert.equal(await dialog.locator('.settings-keyboard .kit-row-desc').first().textContent(), 'Open the screen to change this.');
                    assert.equal(
                        await dialog.locator('.settings-audio .kit-row', { hasText: 'Listen in this browser' }).locator('.kit-row-desc').textContent(),
                        'Open the screen to listen.',
                    );
                    assert.doesNotMatch(await dialog.textContent(), /\b(the|this) device\b|device's|Device media/i, `${what}: the sheet says phone`);
                    await about.locator('.settings-section-title').scrollIntoViewIfNeeded();
                    await page.screenshot({ path: path.join(OUT, `list-${status.toLowerCase()}-${width}-${colorScheme}.png`) });
                    assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, `${what}: no horizontal overflow`);
                    await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
                    await dialog.waitFor({ state: 'hidden' });
                    // Kept for its exit only: a closed sheet holds no content to be found by text.
                    await page.locator('dialog.kit-sheet .settings').waitFor({ state: 'detached' });
                }

                // The passcode this browser keeps for the ready phone: its state, never its value, and Forget.
                await page
                    .locator(`[data-device-key$=":${UDID}"]`)
                    .getByRole('button', { name: 'Settings for Fixture Pixel ready', exact: true })
                    .click();
                const dialog = settingsSheet(page);
                await dialog.waitFor();
                await settleMotion(page);
                const store = dialog.locator('[data-section="unlock"] [data-store]');
                assert.deepEqual(
                    await store.evaluateAll((rows) => rows.map((row) => [row.dataset.store, row.dataset.storeState])),
                    [['browser', 'saved']],
                    `${label}: one row, for the one store an Android phone has`,
                );
                assert.equal(await dialog.locator('[data-section="unlock"] .kit-group-title').textContent(), 'Saved passcode');
                assert.equal(await store.locator('.kit-row-title').textContent(), 'This browser');
                assert.ok(!(await dialog.textContent()).includes(PASSCODE), `${label}: the passcode is never shown`);
                // What the card's Details held: the screen with another player, for a picture that does not show.
                const players = dialog.locator('[data-section="about"] a.settings-player-link');
                assert.ok((await players.count()) >= 1, `${label}: the other players are offered`);
                assert.match(await players.first().getAttribute('href'), new RegExp(`action=device&udid=${UDID}&view=screen&player=`));
                await store.scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(OUT, `passcode-saved-${width}-${colorScheme}.png`) });
                await store.getByRole('button', { name: 'Forget', exact: true }).click();
                await dialog.getByText('Removed from this browser.', { exact: true }).waitFor();
                assert.equal(await store.getAttribute('data-store-state'), 'empty');
                assert.equal(await store.getByRole('button', { name: 'Forget', exact: true }).isDisabled(), true);
                assert.equal(
                    await page.evaluate((udid) => localStorage.getItem(`ws-scrcpy:remembered-passcode:${udid}`), UDID),
                    null,
                    `${label}: Forget removes it from this browser`,
                );
                await page.screenshot({ path: path.join(OUT, `passcode-forgotten-${width}-${colorScheme}.png`) });
                assert.deepEqual(errors, []);
            } finally {
                await context.close();
            }
        }
    }
    console.log('PASS Settings from the list for an offline, unauthorized and asleep phone, and Forget for the passcode saved here');
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        const flows = [layoutFlow, applyFlow, viewersFlow, listFlow];
        const selected = process.env.SCENARIO ? flows.filter((run) => run.name === process.env.SCENARIO) : flows;
        assert.ok(selected.length, 'SCENARIO names a known flow');
        for (const run of selected) await run(browser);
    } finally {
        await browser.close();
    }
}
module.exports = { fixture, UDID, ENCODER };
if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
