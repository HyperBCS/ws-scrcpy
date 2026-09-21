#!/usr/bin/env node
/* eslint-disable */
// A stand-in for the `pymobiledevice3` CLI, for tests that run without an iPhone. It answers the
// handful of commands the server uses and, for `display serve-web`, runs a loopback HTTP server
// with the same routes and framing as the real one (see CoreDeviceProtocol.ts).
//
// Behaviour is steered by environment variables so one binary covers every scenario:
//   FAKE_DEVICES        comma-separated UDIDs `usbmux list --simple` reports (default: one)
//   FAKE_UNPAIRED       comma-separated UDIDs whose `lockdown info` fails with a pairing error
//   FAKE_DEVMODE        "false" makes `amfi developer-mode-status` report false
//   FAKE_MOUNT_FAIL     "devmode" | "other": make `mounter auto-mount` fail that way
//   FAKE_SERVE_EXIT     exit code for serve-web to die with immediately
//   FAKE_SERVE_DELAY_MS how long /codec answers 503 before the stream is "ready"
//   FAKE_CLIPBOARD_HANG /clipboard accepts the request and never responds
//   FAKE_CLIPBOARD_HANG_FIRST  /clipboard hangs for this many requests, then answers normally --
//                       a phone whose pasteboard daemon was wedged and has just been restarted
//   FAKE_CLIPBOARD_ERROR_FIRST  /clipboard answers 500 "clipboard error:" that many times first,
//                       the way the real helper does when the daemon is not answering its socket
//   FAKE_AUDIO          "unpatched": /audio.bin answers the unpatched helper's 503; otherwise it
//                       streams scripts/fixtures/iphone-aac-eld.bin (2 s of real AAC-ELD frames
//                       from an iPhone) as raw access units, 100 a second, then keeps the
//                       connection open like the real helper
//   FAKE_SCREEN         "off" makes the AppleARMBacklight IORegistry entry report brightness 0
//   FAKE_LOCK           what the lock probe (invoked as `<shim> lockstate.py`, standing in for
//                       python/probes/lockstate.py) sees: "locked" (default), "passcode",
//                       "unlocked", "foreign" (a lock screen in another language), "empty"
//   FAKE_LOCK_FAIL      the lock probe exits non-zero with this message on stderr
//   FAKE_PASTEBOARD_RESTART  what `pasteboard_restart.py` reports: "none" (nothing was running to
//                       kill) or a message to fail with; by default it kills one daemon
//   FAKE_LANGUAGE       `lockdown get --domain com.apple.international --key Language` (en-US)
//   FAKE_NOTIFY         `notification observe` relays this notification name once, 200 ms in
//   FAKE_LOG            file to append one line per invocation (args + POST bodies)
//   FAKE_TOUCH_DROP_AFTER  drop the connection on every `/touch` past this many, so a gesture can
//                       be cut off mid-swipe the way a wedged HID channel cuts one off
const http = require('node:http');
const fs = require('node:fs');

const args = process.argv.slice(2).filter((arg) => arg !== '--no-color');
const log = (line) => {
    if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, line + '\n');
};
log('args ' + JSON.stringify(args));

const flag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};
const udid = flag('--udid') ?? process.env.PYMOBILEDEVICE3_UDID;
const valued = ['--udid', '--bind', '--http-port', '--ioclass', '--domain', '--key', '--tunnel'];
const command = args.filter((arg, index) => !arg.startsWith('--') && !valued.includes(args[index - 1])).join(' ');

if (command === 'usbmux list' || command === 'usbmux list simple usb') {
    const list = (process.env.FAKE_DEVICES ?? 'fake-iphone').split(',').filter(Boolean);
    process.stdout.write(JSON.stringify(list) + '\n');
    process.exit(0);
}
if (command === 'lockdown info') {
    if ((process.env.FAKE_UNPAIRED || '').split(',').includes(udid)) {
        process.stderr.write(
            '2026-09-15 10:00:00 pymobiledevice3 ERROR PairingDialogResponsePendingError: user needs to trust\n',
        );
        process.exit(1);
    }
    process.stdout.write(
        JSON.stringify({
            Identifier: udid,
            DeviceName: `Fixture ${udid}`,
            ProductType: 'iPhone14,5',
            ProductVersion: '27.0',
            UniqueDeviceID: udid,
        }) + '\n',
    );
    process.exit(0);
}
if (command === 'diagnostics ioregistry') {
    // Trimmed to what DeviceStateMonitor reads; the real entry has ~80 more keys.
    process.stdout.write(
        JSON.stringify({
            IOClass: flag('--ioclass'),
            IODisplayParameters: {
                brightness: { max: 65536, min: 0, value: process.env.FAKE_SCREEN === 'off' ? 0 : 1 },
                rawBrightness: { max: 2047, min: 0, value: 232 },
            },
        }) + '\n',
    );
    process.exit(0);
}
const LOCK_SCENES = {
    locked: ['1:38\u202fAM', 'Locked', 'Flashlight, Off, Button', 'Camera, Button', 'Show Notifications, Button'],
    passcode: ['Enter Passcode', '1', '2 ABC', '3 DEF', 'Emergency', 'Cancel'],
    unlocked: ['Safari', 'Messages', 'Settings', 'Page 1 of 2'],
    foreign: ['1:38', 'Gesperrt', 'Taschenlampe, Aus, Taste', 'Kamera, Taste'],
    empty: [],
};
if (command === 'pasteboard_restart.py') {
    // Stands in for python/probes/pasteboard_restart.py: kills the phone's wedged dtpasteboardd.
    const mode = process.env.FAKE_PASTEBOARD_RESTART;
    if (mode && mode !== 'none') {
        process.stderr.write(`RuntimeError: ${mode}\n`);
        process.exit(1);
    }
    const answer = mode === 'none' ? { restarted: false, pids: [] } : { restarted: true, pids: [651] };
    process.stdout.write(JSON.stringify(answer) + '\n');
    process.exit(0);
}
if (command === 'lockstate.py') {
    // Stands in for python/probes/lockstate.py, which the server runs through IOS_PROBE_CMD.
    if (process.env.FAKE_LOCK_FAIL) {
        process.stderr.write(`RuntimeError: ${process.env.FAKE_LOCK_FAIL}\n`);
        process.exit(1);
    }
    const captions = LOCK_SCENES[process.env.FAKE_LOCK || 'locked'] || LOCK_SCENES.locked;
    const decide = (caption) => {
        const lowered = caption.toLowerCase();
        if (lowered.includes('locked') && !lowered.includes('unlocked')) return true;
        if (lowered.includes('enter passcode')) return true;
        if (lowered === 'unlocked') return false;
        return null;
    };
    const locked = captions.map(decide).find((value) => value !== null) ?? null;
    process.stdout.write(JSON.stringify({ locked, captions, monitored: false }) + '\n');
    process.exit(0);
}
if (command === 'developer accessibility list-items') {
    const item = (caption) => ({ caption, spoken_description: caption, estimated_uid: '0', platform_identifier: '0' });
    const scene = LOCK_SCENES[process.env.FAKE_LOCK || 'locked'] || LOCK_SCENES.locked;
    process.stdout.write(JSON.stringify(scene.map(item)) + '\n');
    process.exit(0);
}
if (command === 'lockdown get') {
    if (flag('--key') === 'Language') {
        process.stdout.write(JSON.stringify(process.env.FAKE_LANGUAGE || 'en-US') + '\n');
    } else {
        process.stdout.write(JSON.stringify({ Language: process.env.FAKE_LANGUAGE || 'en-US', Locale: 'en_US' }) + '\n');
    }
    process.exit(0);
}
let longLived = false;
if (command.startsWith('notification observe')) {
    // Long-lived like the real relay: prints one JSON line per notification, exits on SIGTERM.
    longLived = true;
    if (process.env.FAKE_NOTIFY) {
        setTimeout(() => {
            process.stdout.write(JSON.stringify({ Command: 'RelayNotification', Name: process.env.FAKE_NOTIFY }) + '\n');
        }, 200);
    }
    setInterval(() => {}, 60000);
    process.on('SIGTERM', () => process.exit(0));
}
if (command === 'amfi developer-mode-status') {
    process.stdout.write((process.env.FAKE_DEVMODE === 'false' ? 'false' : 'true') + '\n');
    process.exit(0);
}
if (command === 'amfi enable-developer-mode') {
    process.stdout.write('\n');
    process.exit(0);
}
if (command === 'mounter auto-mount') {
    if (process.env.FAKE_MOUNT_FAIL === 'devmode') {
        process.stderr.write('pymobiledevice3.exceptions.DeveloperModeIsNotEnabledError\n');
        process.exit(1);
    }
    if (process.env.FAKE_MOUNT_FAIL === 'other') {
        process.stderr.write('ERROR Unable to find the correct DeveloperDiskImage\n');
        process.exit(1);
    }
    process.stderr.write('INFO DeveloperDiskImage already mounted\n');
    process.exit(0);
}
if (command === 'developer core-device display serve-web') {
    if (args.includes('--udid')) {
        // The real CLI (11.12.5) rejects this: the tunnel target comes from PYMOBILEDEVICE3_UDID.
        process.stderr.write('Usage: pymobiledevice3 developer core-device display serve-web [OPTIONS]\n╭─ Error ─╮\n│ No such option: --udid │\n╰─╯\n');
        process.exit(2);
    }
    if (process.env.FAKE_SERVE_EXIT) {
        process.stderr.write('ERROR CoreDeviceError: displayservice unavailable (9021)\n');
        process.exit(Number(process.env.FAKE_SERVE_EXIT));
    }
    const port = Number(flag('--http-port'));
    const readyAt = Date.now() + Number(process.env.FAKE_SERVE_DELAY_MS || 0);
    // Counts the /clipboard requests swallowed under FAKE_CLIPBOARD_HANG_FIRST. It lives in this
    // process on purpose: the wedge being modelled is on the phone, so it outlives nothing here
    // and a restart of the *daemon* (the probe) is what makes the next request answer.
    let clipboardHangs = 0;
    let clipboardErrors = 0;
    const frame = (type, payload) => {
        const body = Buffer.concat([Buffer.from([type]), payload]);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(body.length, 0);
        return Buffer.concat([length, body]);
    };
    const nalu = (bytes) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length, 0);
        return Buffer.concat([length, Buffer.from(bytes)]);
    };
    let touches = 0;
    const server = http.createServer((request, response) => {
        const path = request.url.split('?')[0];
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
            if (request.method === 'POST') log(`post ${path} ${body}`);
            if (path === '/codec') {
                if (Date.now() < readyAt) {
                    response.writeHead(503).end();
                    return;
                }
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(
                    JSON.stringify({
                        codec: 'hev1.1.6.L120.90',
                        description: Buffer.from([1, 2, 3, 4]).toString('base64'),
                    }),
                );
                return;
            }
            if (path === '/stream.bin') {
                response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' });
                // One key, one delta, then a reset-key, split unevenly across chunks so the proxy's
                // reassembly is exercised.
                const packets = Buffer.concat([
                    frame(0, Buffer.concat([nalu([0x40, 0x01, 0xaa]), nalu([0x26, 0x01, 0xbb, 0xcc])])),
                    frame(1, nalu([0x02, 0x01, 0xdd])),
                    frame(2, nalu([0x26, 0x01, 0xee])),
                ]);
                response.write(packets.subarray(0, 7));
                setTimeout(() => response.write(packets.subarray(7, 21)), 20);
                setTimeout(() => response.write(packets.subarray(21)), 40);
                // Stay open like the real stream; the proxy destroys it on release.
                return;
            }
            if (path === '/audio.bin') {
                if (process.env.FAKE_AUDIO === 'unpatched') {
                    const body = 'audio disabled: missing python package(s): macOS (AudioToolbox).\n';
                    response.writeHead(503, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
                    response.end(body);
                    return;
                }
                response.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'X-Audio-Codec': 'aac-eld',
                    'Transfer-Encoding': 'chunked',
                });
                const fixture = fs.readFileSync(require('node:path').join(__dirname, 'iphone-aac-eld.bin'));
                const frames = [];
                for (let offset = 0; offset + 4 <= fixture.length; ) {
                    const length = fixture.readUInt32BE(offset);
                    frames.push(fixture.subarray(offset, offset + 4 + length));
                    offset += 4 + length;
                }
                let index = 0;
                const timer = setInterval(() => {
                    if (index >= frames.length) {
                        clearInterval(timer);
                        return;
                    }
                    response.write(frames[index++]);
                }, 10);
                response.on('close', () => clearInterval(timer));
                return;
            }
            if (path === '/clipboard' && process.env.FAKE_CLIPBOARD_HANG) {
                // The phone's dtpasteboardd takes the request and never answers it (see
                // python/probes/pasteboard_restart.py).
                return;
            }
            if (path === '/clipboard' && Number(process.env.FAKE_CLIPBOARD_HANG_FIRST) > clipboardHangs) {
                // ... until it is restarted, after which the same requests answer normally.
                clipboardHangs++;
                return;
            }
            if (path === '/clipboard' && Number(process.env.FAKE_CLIPBOARD_ERROR_FIRST) > clipboardErrors) {
                // The other face of the same daemon: serve-web's own request fails, and the
                // exception it reports carries no message.
                clipboardErrors++;
                response.writeHead(500, { 'Content-Type': 'text/plain' });
                response.end('clipboard error: ');
                return;
            }
            if (path === '/clipboard') {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(request.method === 'GET' ? JSON.stringify({ text: 'from the phone' }) : '{"ok":true}');
                return;
            }
            if (path === '/rotate') {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ orientation: 'landscapeLeft' }));
                return;
            }
            if (path === '/key' && process.env.FAKE_SLOW_KEY_MS) {
                // A phone that answers HID slowly: lets a test see whether the proxy waits for
                // one report before sending the next (the log records arrival order).
                setTimeout(() => response.writeHead(200).end('ok'), Number(process.env.FAKE_SLOW_KEY_MS));
                return;
            }
            if (path === '/touch' && process.env.FAKE_TOUCH_DROP_AFTER) {
                // A phone that stops answering partway through a gesture: from this touch on the
                // socket is dropped, so the proxy sees the same ECONNRESET a wedged HID channel
                // gives it. The POST is already logged, so a test can still see what was attempted.
                touches += 1;
                if (touches > Number(process.env.FAKE_TOUCH_DROP_AFTER)) {
                    request.destroy();
                    return;
                }
            }
            if (['/touch', '/key', '/button', '/pli', '/restart'].includes(path)) {
                response.writeHead(200).end('ok');
                return;
            }
            response.writeHead(404).end();
        });
    });
    server.listen(port, '127.0.0.1', () => process.stderr.write(`INFO Open http://127.0.0.1:${port}/\n`));
    process.on('SIGTERM', () => {
        server.close();
        process.exit(0);
    });
} else if (!longLived) {
    process.stderr.write(`fake pymobiledevice3: unknown command ${JSON.stringify(args)}\n`);
    process.exit(2);
}
