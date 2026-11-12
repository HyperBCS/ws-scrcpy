// Run with: node --test scripts/test-stream-receivers.js
// The two stream receivers without a phone or a server: the audio framing they share
// (src/app/client/audioPacket.ts). Every socket is the fake below; no address is contacted.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

global.location = new URL('http://viewer.invalid/');
const { StreamReceiver } = require('../src/app/client/StreamReceiver');
const { CoreDeviceReceiver } = require('../src/app/applDevice/client/CoreDeviceReceiver');

class FakeSocket extends EventEmitter {
    static instances = [];
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 0;
    sent = [];
    constructor(url) {
        super();
        this.url = url;
        FakeSocket.instances.push(this);
    }
    addEventListener(type, listener) {
        this.on(type, listener);
    }
    send(data) {
        this.sent.push(data);
    }
    open() {
        this.readyState = this.OPEN;
        this.emit('open', {});
    }
    message(data) {
        this.emit('message', { data });
    }
    close(code = 1006) {
        if (this.readyState === this.CLOSED) {
            return;
        }
        this.readyState = this.CLOSED;
        this.emit('close', { code, reason: '' });
    }
}

function useFakeSockets(t) {
    FakeSocket.instances = [];
    const previous = global.WebSocket;
    global.WebSocket = FakeSocket;
    t.after(() => {
        global.WebSocket = previous;
    });
    return FakeSocket.instances;
}

const server = { hostname: 'viewer.invalid', port: 1, pathname: '/' };

function androidReceiver(t) {
    const sockets = useFakeSockets(t);
    const receiver = new StreamReceiver({ ...server, udid: 'android-phone', action: 'proxy_adb' });
    t.after(() => receiver.stop());
    return { receiver, sockets };
}

function iphoneReceiver(t) {
    const sockets = useFakeSockets(t);
    const receiver = new CoreDeviceReceiver({ ...server, udid: 'iphone', action: 'proxy-coredevice' });
    t.after(() => receiver.stop());
    return { receiver, sockets };
}

const arrayBuffer = (bytes) => {
    const buffer = Buffer.from(bytes);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
};

// ------------------------------------------------------------------ audio framing

/** `scrcpy_audio_2(14) kind(1) timestampUs(8 BE) payload`, as Broadcast and CoreDeviceAudio send it. */
function envelope(kind, timestamp, payload) {
    const bytes = Buffer.alloc(23 + payload.length);
    bytes.write('scrcpy_audio_2');
    bytes[14] = kind;
    bytes.writeBigUInt64BE(BigInt(timestamp), 15);
    Buffer.from(payload).copy(bytes, 23);
    return bytes;
}
const metadataEnvelope = (value) => envelope(2, 0, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));

const opusHead = Buffer.from('4f707573486561640102380180bb0000000000', 'hex');
const pending = { status: 'pending', sampleRate: 48000, channels: 2 };
const readyOpus = { status: 'ready', codec: 'opus', sampleRate: 48000, channels: 2 };
const readyRaw = { status: 'ready', codec: 'raw', sampleRate: 48000, channels: 2 };
const error = (message) => ({ status: 'error', sampleRate: 48000, channels: 2, message });
const jsonError = (() => {
    try {
        JSON.parse('{invalid');
    } catch (e) {
        return e.message;
    }
})();
const split = envelope(0, 0x4e20, [1, 2, 3, 4]);
const config = envelope(1, 0, opusHead);

/**
 * One stream of audio messages, each a whole envelope unless it says otherwise, and what the
 * player must see after each: the events, then the metadata and config a late player is given.
 * `config` in the state is the timestamp of the kept config frame.
 */
const audioScript = [
    ['pending metadata', metadataEnvelope(pending), [['audioMetadata', pending]], { metadata: 'pending' }],
    ['ready metadata', metadataEnvelope(readyOpus), [['audioMetadata', readyOpus]], { metadata: 'ready' }],
    ['config', config, [['audio', frame(true, 0, opusHead)]], { metadata: 'ready', config: 0 }],
    ['sample', envelope(0, 20000, [0xf8, 0xff, 0xfe]), [['audio', frame(false, 20000, [0xf8, 0xff, 0xfe])]], { metadata: 'ready', config: 0 }],
    ['sample of only a header', envelope(0, 40000, []), [['audio', frame(false, 40000, [])]], { metadata: 'ready', config: 0 }],
    ['same codec again', metadataEnvelope(readyOpus), [['audioMetadata', readyOpus]], { metadata: 'ready', config: 0 }],
    ['another codec', metadataEnvelope(readyRaw), [['audioMetadata', readyRaw]], { metadata: 'ready' }],
    ['config', config, [['audio', frame(true, 0, opusHead)]], { metadata: 'ready', config: 0 }],
    ['capture not ready', metadataEnvelope(pending), [['audioMetadata', pending]], { metadata: 'pending' }],
    ['config', config, [['audio', frame(true, 0, opusHead)]], { metadata: 'pending', config: 0 }],
    ['truncated', envelope(0, 1, []).subarray(0, 22), [['audioMetadata', error('Truncated audio packet.')]], { metadata: 'error' }],
    ['ready metadata', metadataEnvelope(readyOpus), [['audioMetadata', readyOpus]], { metadata: 'ready' }],
    ['config', config, [['audio', frame(true, 0, opusHead)]], { metadata: 'ready', config: 0 }],
    ['unknown kind', envelope(7, 0, [1]), [['audioMetadata', error('Unknown audio packet type.')]], { metadata: 'error' }],
    ['metadata with an unknown status', metadataEnvelope({ ...readyOpus, status: 'loud' }), [['audioMetadata', error('Invalid audio stream metadata.')]], { metadata: 'error' }],
    ['ready metadata without a codec', metadataEnvelope({ status: 'ready', sampleRate: 48000, channels: 2 }), [['audioMetadata', error('Invalid audio stream metadata.')]], { metadata: 'error' }],
    ['metadata that is not JSON', metadataEnvelope('{invalid'), [['audioMetadata', error(jsonError)]], { metadata: 'error' }],
    ['timestamp past 2^53', envelope(0, 2n ** 53n, [1]), [['audioMetadata', error('Invalid audio timestamp.')]], { metadata: 'error' }],
    // The server sends one envelope per message. A split one is not joined: its first part is
    // truncated, and its second part does not start like audio, so it goes on as video.
    ['first half of a split packet', split.subarray(0, 20), [['audioMetadata', error('Truncated audio packet.')]], { metadata: 'error' }, 'split'],
    ['second half of a split packet', split.subarray(20), [['video', [...split.subarray(20)]]], { metadata: 'error' }, 'rest'],
    ['ready metadata', metadataEnvelope(readyOpus), [['audioMetadata', readyOpus]], { metadata: 'ready' }],
    ['sample', envelope(0, 60000, [9]), [['audio', frame(false, 60000, [9])]], { metadata: 'ready' }],
];

function frame(isConfig, timestamp, data) {
    return { keys: 'config,data,timestamp', config: isConfig, timestamp, data: [...data], view: 'Uint8Array' };
}

/** What the player is handed, in a form that compares byte for byte. */
function recordEvents(source) {
    const events = [];
    source.on('audio', (value) =>
        events.push([
            'audio',
            {
                keys: Object.keys(value).sort().join(','),
                config: value.config,
                timestamp: value.timestamp,
                data: [...value.data],
                view: value.data.constructor.name,
            },
        ]),
    );
    source.on('audioMetadata', (value) => events.push(['audioMetadata', { ...value }]));
    source.on('video', (value) => events.push(['video', [...value]]));
    return events;
}

function stateOf(receiver) {
    const state = { metadata: receiver.getAudioMetadata()?.status };
    const kept = receiver.getAudioConfig();
    if (kept) {
        assert.equal(kept.config, true);
        state.config = kept.timestamp;
    }
    return state;
}

/** Plays `audioScript` into a receiver; `wrap` turns an envelope into that platform's message. */
function playScript(receiver, socket, wrap) {
    const events = recordEvents(receiver);
    for (const [name, bytes, expected, state, part] of audioScript) {
        events.length = 0;
        socket.message(arrayBuffer(wrap(bytes, part)));
        assert.deepEqual(events, expected, name);
        assert.deepEqual(stateOf(receiver), state, `${name}: what a late player is given`);
    }
}

// The iPhone carries each envelope behind its frame-type byte (COREDEVICE_FRAME_AUDIO = 3). The
// rest of a split packet arrives without it, as the server would never send it.
const iphoneMessage = (bytes, part) => (part === 'rest' ? bytes : Buffer.concat([Buffer.from([3]), bytes]));

for (const [platform, create, wrap] of [
    ['Android', androidReceiver, (bytes) => bytes],
    ['iPhone', iphoneReceiver, iphoneMessage],
]) {
    test(`audio framing: the ${platform} receiver hands the player every packet kind and bad packet the same way`, (t) => {
        const { receiver, sockets } = create(t);
        sockets[0].open();
        playScript(receiver, sockets[0], wrap);

        // A closed socket starts the audio state over, and a stopped receiver passes nothing on.
        sockets[0].close();
        assert.deepEqual(stateOf(receiver), { metadata: undefined });
        const events = recordEvents(receiver);
        receiver.stop();
        sockets[0].message(arrayBuffer(wrap(config)));
        assert.deepEqual(events, []);
    });
}

test('audio framing: one reader parses the envelope for both receivers, at offset 0 and behind a type byte', () => {
    const { AudioEnvelopeReader } = require('../src/app/client/audioPacket');
    for (const offset of [0, 1]) {
        const events = [];
        const sink = new EventEmitter();
        const reader = new AudioEnvelopeReader({
            audio: (value) => sink.emit('audio', value),
            metadata: (value) => sink.emit('audioMetadata', value),
        });
        const recorded = recordEvents(sink);
        for (const [name, bytes, expected, state, part] of audioScript) {
            if (part === 'rest') {
                continue; // Not audio: a receiver never hands it to the reader.
            }
            recorded.length = 0;
            reader.read(arrayBuffer(offset ? Buffer.concat([Buffer.from([3]), bytes]) : bytes), offset);
            events.push(name);
            assert.deepEqual(recorded, expected, `${name} at offset ${offset}`);
            assert.deepEqual(
                stateOf({ getAudioMetadata: () => reader.getMetadata(), getAudioConfig: () => reader.getConfig() }),
                state,
                `${name} at offset ${offset}: what a late player is given`,
            );
        }
        reader.reset();
        assert.equal(reader.getMetadata(), undefined);
        assert.equal(reader.getConfig(), undefined);
        assert.equal(events.length, audioScript.length - 1);
    }
});

test('audio framing: the frame a late player is given is the frame the player was sent', () => {
    const { AudioEnvelopeReader } = require('../src/app/client/audioPacket');
    const sent = [];
    const reader = new AudioEnvelopeReader({ audio: (value) => sent.push(value), metadata: () => undefined });
    reader.read(arrayBuffer(metadataEnvelope(readyOpus)));
    reader.read(arrayBuffer(config));
    assert.equal(reader.getConfig(), sent[0]);
});

test('audio framing: legacy scrcpy_audio_1 packets reach the Android player without a timestamp', (t) => {
    const { receiver, sockets } = androidReceiver(t);
    const events = recordEvents(receiver);
    const legacy = (flag, payload) => Buffer.concat([Buffer.from('scrcpy_audio_1'), Buffer.from([flag]), Buffer.from(payload)]);
    const untimed = (isConfig, data) => ({ keys: 'config,data', config: isConfig, timestamp: undefined, data, view: 'Uint8Array' });
    sockets[0].open();
    sockets[0].message(arrayBuffer(legacy(1, opusHead)));
    sockets[0].message(arrayBuffer(legacy(0, [5, 6])));
    sockets[0].message(arrayBuffer(legacy(2, [7])));
    sockets[0].message(arrayBuffer(legacy(0, [])));
    assert.deepEqual(events, [
        ['audio', untimed(true, [...opusHead])],
        ['audio', untimed(false, [5, 6])],
        ['audio', untimed(false, [7])],
        ['audio', untimed(false, [])],
    ]);
    assert.deepEqual([...receiver.getAudioConfig().data], [...opusHead]);
    // A bare magic has no flag byte.
    events.length = 0;
    sockets[0].message(arrayBuffer(Buffer.from('scrcpy_audio_1')));
    assert.deepEqual(events, [['audioMetadata', error('Truncated audio packet.')]]);
    assert.equal(receiver.getAudioConfig(), undefined);
});
