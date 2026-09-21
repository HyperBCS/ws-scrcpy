/* eslint-disable */
// BASE=http://127.0.0.1:8000 E2E_OUT=/tmp/ws-scrcpy-settings node scripts/e2e-settings.js
// All WebSockets are fixtures: long device/encoder labels, audio errors, and Apply failures
// exercise the real Settings component without reaching a device or changing real settings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
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
                if (onStreamReady) onStreamReady({ sendAudioError, close: () => socket.close() });
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
    const result = await page.locator('.bottom-sheet-root.open .bottom-sheet-body').evaluate((body) => {
        const bounds = body.getBoundingClientRect();
        const style = getComputedStyle(body);
        const offenders = Array.from(
            body.querySelectorAll('select, input, button, .settings-sheet-row, .settings-sheet-banner'),
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
            body.querySelectorAll(
                '.settings-sheet-content, .settings-device-context, details, .settings-advanced-body, .settings-sheet-row, .settings-sheet-banner, .settings-sheet-button-row',
            ),
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
async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        for (const [label, width, height, mobile] of [
            ['phone320', 320, 568, true],
            ['iphone17pm', 440, 956, true],
            ['iphone17pm-landscape', 956, 440, true],
            ['desktop', 1280, 900, false],
        ]) {
            const context = await browser.newContext({
                viewport: { width, height },
                hasTouch: mobile,
                isMobile: mobile,
                colorScheme: 'dark',
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            const commands = await fixture(page);
            const socket = new URL('/__settings_fixture__', BASE);
            socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = new URL(BASE);
            url.hash = `!${new URLSearchParams({ action: 'stream', udid: UDID, player: 'webcodecs', ws: socket.toString(), captureKeyboard: '0' })}`;
            await page.goto(url.toString());
            await page.getByText('Connected', { exact: true }).waitFor();
            if (mobile) await page.getByRole('button', { name: 'Show controls', exact: true }).click();
            await page.getByRole('button', { name: 'Settings', exact: true }).click();
            const dialog = page.locator('.bottom-sheet-root.open [role="dialog"]');
            await dialog.waitFor();
            await page.waitForFunction(
                (encoder) => document.querySelector('.settings-encoder-row select')?.value === encoder,
                ENCODER,
            );
            await page.locator('.settings-audio [data-audio-state="error"]').waitFor();
            await dialog.evaluate((el) => {
                el.querySelectorAll('details').forEach((details) => {
                    details.open = true;
                });
                el.querySelectorAll('.settings-playback option').forEach((option) => {
                    option.textContent += ' — a player with a deliberately long descriptive name';
                });
            });
            await dialog.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
            await geometry(page, label + ' all sections');
            await page.screenshot({ path: path.join(OUT, label + '-quality.png') });
            await page.locator('.settings-audio').evaluate((el) => {
                const body = el.closest('.bottom-sheet-body');
                body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 16;
            });
            const scroller = page.locator('.bottom-sheet-root.open .bottom-sheet-body');
            assert((await scroller.evaluate((body) => body.scrollTop)) > 0, 'settings content can scroll vertically');
            await scroller.hover();
            await page.mouse.wheel(500, 0);
            await geometry(page, label + ' horizontal gesture');
            await page.screenshot({ path: path.join(OUT, label + '-sound.png') });
            await page.getByRole('button', { name: /Data saver/ }).click();
            await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
            await geometry(page, label + ' confirmation');
            await page.getByRole('button', { name: 'Apply & restart', exact: true }).click();
            await page.locator('.settings-sheet-apply-bar [role="alert"]').waitFor();
            await geometry(page, label + ' error');
            await page.screenshot({ path: path.join(OUT, label + '-error.png') });
            assert(
                commands.some((command) => command.type === 'update_stream_config'),
                'Apply reached only mocked tracker',
            );
            assert.deepEqual(errors, [], 'no browser runtime errors');
            await context.close();
        }
        console.log('PASS: Settings sizing, scrolling, spacing, long labels, confirmation and error states');
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
