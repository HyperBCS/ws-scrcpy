// Run with: node --test scripts/test-hevc-colour.js
// The colour of an iPhone's picture: the SPS colour fields, what each player hands the browser
// (WebCodecs `colorSpace`, the fMP4 `colr` box) and the Auto, Full and Limited choice of Settings.
// Mocked browser APIs only; no server, browser, phone or pymobiledevice3 is used. No test here
// can see the picture: they check the values handed to the browser.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

for (const ext of ['.svg', '.png', '.css']) {
    require.extensions[ext] = (module) => {
        module.exports = '';
    };
}

// ---------------------------------------------------------------- headers

// The parameter sets of the iPhone 13 Pro Max stream sample of 2026-10-25 (HEVC Main, 8 bit,
// 1296x2816), taken from its Annex-B file. They are stream headers and hold nothing of the
// screen. The server's /codec record of 2026-09-16 holds the same three. ffmpeg's trace_headers
// reads the SPS VUI as: video_signal_type_present_flag 1, video_full_range_flag 1,
// colour_description_present_flag 1, colour_primaries 2, transfer_characteristics 2,
// matrix_coefficients 2 (2 is "unspecified"). ffprobe: color_range=pc, the rest unknown.
const IPHONE_VPS = '40011c01ffff016000000300b000000300000300960cc090';
const IPHONE_SPS =
    '420111016000000300b000000300000300964800a22002c05880cee45218b9fc4fc2fe86fd43fea823f5504feaa82bf55505feaaa833f555529b8101010040';
const IPHONE_PPS = '440148072f05b240';

// Other SPS, each read with ffmpeg 6.1.1 trace_headers to the stop bit with the values named.
const SPS = {
    // libx265, BT.2020 primaries and matrix, PQ transfer, limited range (9, 16, 9, range 0).
    x265Pq: '42010101600000030090000003000003001ea020810596566924caf016a122012080000003008000000504',
    // libx265 with scaling lists on, BT.709 throughout, full range (1, 1, 1, range 1).
    x265Bt709Full: '42010101600000030090000003000003001ea020810596566924e5780b701010104000000300400000030282',
    // The iPhone SPS with vui_parameters_present_flag 0.
    noVui: '420111016000000300b000000300000300964800a22002c05880cee45218b9fc4fc2fe86fd43fea823f5504feaa82bf55505feaaa833f5555220',
    // The iPhone SPS with colour_description_present_flag 0: full range, nothing else.
    noDescription:
        '420111016000000300b000000300000300964800a22002c05880cee45218b9fc4fc2fe86fd43fea823f5504feaa82bf55505feaaa833f555529b0040',
    // Built to take every branch before the VUI: a sub-layer with profile and level, a
    // conformance window, scaling list data, PCM, two predicted reference picture sets (the
    // second has four flags because the first has three pictures), long-term pictures and an
    // extended sample aspect ratio. Then limited range, BT.601 (6, 6, 6).
    everyBranch:
        '42010301600000030090000003000003005dc00001600000030090000003000003005aa0208107de595caf24897086b5ad695555584021ad6b5ad6b5ad6b5ad6b5ad6b5a5557bbe235a2fa652d82c257fe000800076a0c0c0c01',
};

/** An HEVCDecoderConfigurationRecord around parameter sets, with the header the server sends. */
function hvcc(...nalus) {
    const header = Buffer.from('010160000000b0000000000096f000fcfdf8f800000b', 'hex');
    const parts = [header, Buffer.from([nalus.length])];
    for (const hex of nalus) {
        const nalu = Buffer.from(hex, 'hex');
        parts.push(Buffer.from([(nalu[0] >> 1) & 0x3f, 0, 1, nalu.length >> 8, nalu.length & 0xff]), nalu);
    }
    return new Uint8Array(Buffer.concat(parts));
}
const IPHONE_HVCC = hvcc(IPHONE_VPS, IPHONE_SPS, IPHONE_PPS);
const CODEC = 'hev1.1.6.L150.B0';

const colour = () => require('../src/app/player/hevcColour');
const state = () => require('../src/app/state/pictureColour');

test('the iPhone header reads as full range, with primaries, transfer and matrix unspecified', () => {
    const { parseHevcColour } = colour();
    assert.equal(IPHONE_HVCC.length, 133, 'the size of the /codec record');
    assert.deepEqual(parseHevcColour(IPHONE_HVCC), {
        vui: true,
        signalType: true,
        fullRange: true,
        description: true,
        primaries: 2,
        transfer: 2,
        matrix: 2,
    });
    assert.equal(state().streamColourFact(parseHevcColour(IPHONE_HVCC)), 'Full range, colour space not declared');
});

test('headers with a colour description, without one and without a VUI read as ffmpeg reads them', () => {
    const { parseHevcColour } = colour();
    const { streamColourFact } = state();
    const read = (sps) => parseHevcColour(hvcc(IPHONE_VPS, sps, IPHONE_PPS));
    const cases = [
        [SPS.x265Pq, { vui: true, signalType: true, fullRange: false, description: true, primaries: 9, transfer: 16, matrix: 9 },
            'Limited range, primaries BT.2020, transfer PQ, matrix BT.2020'],
        [SPS.x265Bt709Full, { vui: true, signalType: true, fullRange: true, description: true, primaries: 1, transfer: 1, matrix: 1 },
            'Full range, BT.709'],
        [SPS.everyBranch, { vui: true, signalType: true, fullRange: false, description: true, primaries: 6, transfer: 6, matrix: 6 },
            'Limited range, BT.601'],
        [SPS.noDescription, { vui: true, signalType: true, fullRange: true, description: false, primaries: 2, transfer: 2, matrix: 2 },
            'Full range, colour space not declared'],
        [SPS.noVui, { vui: false, signalType: false, fullRange: false, description: false, primaries: 2, transfer: 2, matrix: 2 },
            'Range not declared, colour space not declared'],
    ];
    for (const [sps, expected, words] of cases) {
        assert.deepEqual(read(sps), expected, words);
        assert.equal(streamColourFact(read(sps)), words);
    }
    assert.equal(streamColourFact(undefined), 'Not readable');
});

test('a cut-off or broken header is not known, and the parser never throws', () => {
    const { parseHevcColour } = colour();
    const sps = Buffer.from(IPHONE_SPS, 'hex');
    const full = parseHevcColour(IPHONE_HVCC);
    // The matrix code ends at bit 465 of the RBSP: 59 bytes, 62 with the three emulation bytes.
    for (let length = 0; length < sps.length; length++) {
        const cut = parseHevcColour(hvcc(IPHONE_VPS, sps.subarray(0, length).toString('hex'), IPHONE_PPS));
        if (length < 62) assert.equal(cut, undefined, `an SPS cut to ${length} bytes is not known`);
        else assert.deepEqual(cut, full, `an SPS cut to ${length} bytes still holds the colour fields`);
    }
    // A record cut anywhere, including inside its array headers.
    for (let length = 0; length < IPHONE_HVCC.length; length++) {
        const cut = parseHevcColour(IPHONE_HVCC.subarray(0, length));
        assert.ok(cut === undefined || cut.fullRange === true, `a record cut to ${length} bytes`);
    }
    assert.equal(parseHevcColour(new Uint8Array([1])), undefined, 'the one-byte description of the fixtures');
    assert.equal(parseHevcColour(hvcc(IPHONE_VPS, IPHONE_PPS)), undefined, 'no SPS');
    // An Exp-Golomb code longer than 32 bits where sps_seq_parameter_set_id is.
    const longCode = Buffer.from(IPHONE_SPS, 'hex');
    longCode.fill(0, 15, 22);
    assert.equal(parseHevcColour(hvcc(IPHONE_VPS, longCode.toString('hex'), IPHONE_PPS)), undefined);
    // Noise in place of the SPS body, with a fixed seed.
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 256;
    for (let i = 0; i < 300; i++) {
        const noise = Buffer.from([0x42, 0x01, ...Array.from({ length: 1 + (i % 80) }, random)]);
        assert.doesNotThrow(() => parseHevcColour(hvcc(IPHONE_VPS, noise.toString('hex'))));
    }
});

// ---------------------------------------------------------------- browser mocks

class MockDecoder {
    static instances = [];
    static isConfigSupported = async () => ({ supported: true });
    /** Set to make configure() throw a TypeError for a config with a colour space. */
    static throwOnColour = false;
    state = 'unconfigured';
    configs = [];
    chunks = [];
    constructor(init) {
        this.init = init;
        MockDecoder.instances.push(this);
    }
    configure(config) {
        if (MockDecoder.throwOnColour && config.colorSpace) throw new TypeError("'bt709' is not a valid enum value");
        this.state = 'configured';
        this.configs.push(config);
    }
    decode(chunk) {
        this.chunks.push(chunk);
    }
    close() {
        this.state = 'closed';
    }
}

function element(overrides = {}) {
    const listeners = new Map();
    return {
        style: {},
        dataset: {},
        classList: { add() {}, remove() {} },
        width: 0,
        height: 0,
        clientWidth: 0,
        clientHeight: 0,
        children: [],
        listeners,
        getContext: () => ({ drawImage() {}, clearRect() {}, save() {}, restore() {} }),
        setAttribute() {},
        removeAttribute() {},
        addEventListener(name, fn) {
            listeners.set(name, fn);
        },
        removeEventListener(name) {
            listeners.delete(name);
        },
        appendChild(child) {
            this.children.push(child);
            child.parentElement = this;
        },
        removeChild() {},
        remove() {},
        getBoundingClientRect() {
            return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
        },
        play: async () => {},
        toDataURL: () => 'data:,',
        ...overrides,
    };
}
const listenerApi = () => {
    const map = new Map();
    return {
        addEventListener(name, fn) {
            if (!map.has(name)) map.set(name, new Set());
            map.get(name).add(fn);
        },
        removeEventListener(name, fn) {
            map.get(name)?.delete(fn);
        },
    };
};
const storage = new Map();
global.Element = class Element {};
global.VideoDecoder = MockDecoder;
global.EncodedVideoChunk = class {
    constructor(init) {
        Object.assign(this, init);
    }
};
global.requestAnimationFrame = () => 1;
global.cancelAnimationFrame = () => {};
global.document = {
    ...listenerApi(),
    visibilityState: 'visible',
    createElement: () => element(),
    querySelector: () => null,
    body: { ...listenerApi(), classList: { add() {}, remove() {} }, clientWidth: 1000, clientHeight: 800 },
};
global.window = global;
Object.assign(global, listenerApi());
global.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
};
Object.defineProperty(global, 'navigator', { configurable: true, value: { userAgent: 'node', platform: 'Linux' } });
global.location = new URL('http://localhost:8000/');
global.Image = class {
    set src(_) {
        /* never loads */
    }
};
global.URL.createObjectURL = () => 'blob:mock';
global.URL.revokeObjectURL = () => {};

const settle = () => new Promise((resolve) => setImmediate(resolve));
const key = new Uint8Array([0, 0, 0, 0, 1, 0x26]);
const delta = new Uint8Array([1, 0, 0, 0, 1, 0x02]);

function hevcPlayer(t) {
    MockDecoder.instances.length = 0;
    MockDecoder.isConfigSupported = async () => ({ supported: true });
    MockDecoder.throwOnColour = false;
    const { WebCodecsHevcPlayer } = require('../src/app/player/WebCodecsHevcPlayer');
    const player = new WebCodecsHevcPlayer('iphone-colour');
    const requests = [];
    player.on('keyframe-request', () => requests.push(MockDecoder.instances.length));
    t.after(() => player.stop());
    return { player, requests, decoders: MockDecoder.instances };
}

// ---------------------------------------------------------------- WebCodecs

test('the WebCodecs config carries the colour space: full range as declared, BT.709 for what is left out', (t) => {
    const { player, decoders } = hevcPlayer(t);
    player.configure(CODEC, IPHONE_HVCC);
    assert.equal(decoders.length, 1);
    const [config] = decoders[0].configs;
    assert.equal(config.codec, CODEC);
    assert.equal(config.description, IPHONE_HVCC);
    assert.equal(config.optimizeForLatency, true);
    assert.deepEqual(config.colorSpace, { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true });

    player.configure(CODEC, hvcc(IPHONE_VPS, SPS.x265Pq, IPHONE_PPS));
    assert.deepEqual(decoders.at(-1).configs[0].colorSpace, {
        primaries: 'bt2020',
        transfer: 'pq',
        matrix: 'bt2020-ncl',
        fullRange: false,
    });
    // A description this cannot read is configured as before the colour space existed.
    player.configure('hev1', new Uint8Array([1]));
    assert.deepEqual(decoders.at(-1).configs[0], { codec: 'hev1', description: new Uint8Array([1]), optimizeForLatency: true });
});

test('the WebCodecs player configures without the colour space when the browser refuses it', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const { player, requests, decoders } = hevcPlayer(t);
    const asked = [];
    MockDecoder.isConfigSupported = async (config) => {
        asked.push(config);
        return { supported: !config.colorSpace };
    };
    player.configure(CODEC, IPHONE_HVCC);
    assert.ok(decoders[0].configs[0].colorSpace, 'tried with the colour space first, so no key frame waits on the check');
    await settle();
    assert.equal(asked.length, 1);
    assert.equal(decoders.length, 2, 'refused: a new decoder');
    assert.equal(decoders[0].state, 'closed');
    assert.deepEqual(decoders[1].configs, [{ codec: CODEC, description: IPHONE_HVCC, optimizeForLatency: true }]);
    assert.deepEqual(requests, [2], 'and one key frame request for it');
    // The same stream again (a reconnect): straight to the config the browser takes.
    player.configure(CODEC, IPHONE_HVCC);
    await settle();
    assert.equal(decoders.length, 3);
    assert.equal(decoders[2].configs[0].colorSpace, undefined);
    assert.equal(asked.length, 1, 'not asked again');
    assert.deepEqual(requests, [2]);

    // A browser that does not know a colour space value throws in configure(): no error leaves
    // the player, and the same decoder is configured without it.
    const other = hevcPlayer(t);
    MockDecoder.throwOnColour = true;
    assert.doesNotThrow(() => other.player.configure(CODEC, IPHONE_HVCC));
    assert.equal(other.decoders.length, 1);
    assert.deepEqual(other.decoders[0].configs, [{ codec: CODEC, description: IPHONE_HVCC, optimizeForLatency: true }]);
    assert.equal(other.decoders[0].state, 'configured');
    other.player.play();
    other.player.pushFrame(key);
    assert.equal(other.decoders[0].chunks.length, 1, 'and it decodes');
});

test('Full and Limited override the WebCodecs colour range, Auto follows the stream', (t) => {
    const { player, requests, decoders } = hevcPlayer(t);
    player.setColourRange('limited');
    assert.equal(decoders.length, 0, 'before the codec arrives a choice is only kept');
    player.configure(CODEC, IPHONE_HVCC);
    assert.equal(decoders[0].configs[0].colorSpace.fullRange, false, 'Limited applies to the first config');
    player.play();
    player.pushFrame(key);
    player.pushFrame(delta);
    player.setColourRange('full');
    assert.equal(decoders.length, 2, 'a new decoder for the new colour space');
    assert.equal(decoders[0].state, 'closed');
    assert.deepEqual(decoders[1].configs[0].colorSpace, { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true });
    assert.deepEqual(requests, [2], 'with a key frame request');
    player.pushFrame(delta);
    assert.equal(decoders[1].chunks.length, 0, 'deltas wait for that key frame');
    player.pushFrame(key);
    assert.deepEqual(decoders[1].chunks.map((chunk) => chunk.type), ['key']);
    player.setColourRange('auto');
    assert.equal(decoders.length, 2, 'Auto is Full for this stream: the decoder stays');
    assert.deepEqual(requests, [2], 'and nothing is asked of the phone');
    player.setColourRange('limited');
    assert.equal(decoders[2].configs[0].colorSpace.fullRange, false);
    player.setColourRange('auto');
    assert.equal(decoders[3].configs[0].colorSpace.fullRange, true, 'Auto: what the stream declares');
    assert.deepEqual(requests, [2, 3, 4]);
    player.stop();
    player.setColourRange('limited');
    assert.equal(decoders.length, 4, 'a stopped player builds nothing');
    assert.deepEqual(requests, [2, 3, 4]);
});

// ---------------------------------------------------------------- MSE

function parseBoxes(bytes, offset = 0, end = bytes.length) {
    const boxes = [];
    while (offset + 8 <= end) {
        const size = bytes.readUInt32BE(offset);
        const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
        const found = { type, size, start: offset };
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) found.children = parseBoxes(bytes, offset + 8, offset + size);
        else if (type === 'stsd') found.children = parseBoxes(bytes, offset + 16, offset + size);
        else if (type === 'hev1' || type === 'hvc1') found.children = parseBoxes(bytes, offset + 8 + 78, offset + size);
        boxes.push(found);
        if (size < 8) break;
        offset += size;
    }
    return boxes;
}
const find = (boxes, route) =>
    route.split('/').reduce((list, type) => (list.find((entry) => entry.type === type) || {}).children || [], boxes);

/** The sample entry's boxes, and the `colr` payload when there is one. */
function sampleEntry(init) {
    const bytes = Buffer.from(init);
    const [entry] = find(parseBoxes(bytes), 'moov/trak/mdia/minf/stbl/stsd');
    const colr = entry.children.find((child) => child.type === 'colr');
    return {
        type: entry.type,
        boxes: entry.children.map((child) => child.type),
        // Sizes add up: the children end where the sample entry ends.
        closed: entry.children.reduce((sum, child) => sum + child.size, 8 + 78) === entry.size,
        colr: colr && {
            size: colr.size,
            kind: bytes.subarray(colr.start + 8, colr.start + 12).toString('latin1'),
            primaries: bytes.readUInt16BE(colr.start + 12),
            transfer: bytes.readUInt16BE(colr.start + 14),
            matrix: bytes.readUInt16BE(colr.start + 16),
            rangeByte: bytes[colr.start + 18],
        },
    };
}

function msePlayer(t) {
    const buffers = [];
    const sources = [];
    class MockSourceBuffer {
        updating = false;
        appended = [];
        listeners = {};
        mode = 'segments';
        addEventListener(name, fn) {
            this.listeners[name] = fn;
        }
        removeEventListener() {}
        appendBuffer(data) {
            this.appended.push(Buffer.from(data));
            this.updating = true;
        }
        finish() {
            this.updating = false;
            this.listeners.updateend?.();
        }
        remove() {}
    }
    global.MediaSource = class {
        static isTypeSupported = (mime) => mime.includes('hev1');
        readyState = 'closed';
        listeners = {};
        constructor() {
            sources.push(this);
        }
        addEventListener(name, fn) {
            this.listeners[name] = fn;
        }
        removeEventListener() {}
        addSourceBuffer() {
            const buffer = new MockSourceBuffer();
            buffers.push(buffer);
            return buffer;
        }
        endOfStream() {
            this.readyState = 'ended';
        }
        open() {
            this.readyState = 'open';
            this.listeners.sourceopen?.();
        }
    };
    const video = element({ buffered: { length: 0 }, currentTime: 0, paused: true, videoWidth: 0, videoHeight: 0 });
    const realCreate = global.document.createElement;
    global.document.createElement = (tag) => (tag === 'video' ? video : realCreate(tag));
    t.mock.method(global, 'setInterval', () => 1);
    t.mock.method(global, 'clearInterval', () => {});
    const { MseHevcPlayer } = require('../src/app/player/MseHevcPlayer');
    const player = new MseHevcPlayer('iphone-colour-mse');
    global.document.createElement = realCreate;
    const requests = [];
    player.on('keyframe-request', () => requests.push(true));
    t.after(() => player.stop());
    /** Every append so far, flushed one at a time, as box types per append. */
    const appends = () => buffers[0].appended;
    return { player, buffers, sources, requests, appends };
}

test('the init segment holds a colr nclx box after the hvcC, with the full-range bit set', (t) => {
    const { player, buffers, sources } = msePlayer(t);
    player.configure(CODEC, IPHONE_HVCC);
    player.play();
    sources[0].open();
    const init = buffers[0].appended[0];
    const entry = sampleEntry(init);
    assert.equal(entry.type, 'hev1');
    assert.deepEqual(entry.boxes, ['hvcC', 'colr'], 'inside the sample entry, after the decoder record');
    assert.equal(entry.closed, true, 'the sample entry size covers the new box');
    assert.deepEqual(entry.colr, { size: 19, kind: 'nclx', primaries: 1, transfer: 1, matrix: 1, rangeByte: 0x80 });
    // The hvcC itself is untouched.
    const [hvcC] = find(parseBoxes(init), 'moov/trak/mdia/minf/stbl/stsd')[0].children;
    assert.deepEqual(init.subarray(hvcC.start + 8, hvcC.start + hvcC.size), Buffer.from(IPHONE_HVCC));
});

// ffmpeg's mov reader logs each colr box it reads at trace level. (Its stream values then come
// from the SPS, which says full range and nothing else, so they cannot show the box.)
test('ffmpeg reads the colr box of the init segment inside the sample entry', { skip: !hasFfprobe() && 'ffprobe is not installed' }, () => {
    const { buildHevcInitSegment } = require('../src/app/player/hevcFmp4');
    const { parseHevcColour, pictureColour } = colour();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-colr-'));
    try {
        for (const [range, expected] of [['auto', 'nclx: pri 1 trc 1 matrix 1 full 1'], ['limited', 'nclx: pri 1 trc 1 matrix 1 full 0']]) {
            const file = path.join(dir, `init-${range}.mp4`);
            fs.writeFileSync(file, buildHevcInitSegment({
                sampleEntry: 'hev1', hvcC: IPHONE_HVCC, width: 1296, height: 2816,
                colour: pictureColour(parseHevcColour(IPHONE_HVCC), range),
            }));
            const probe = spawnSync('ffprobe', ['-v', 'trace', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file],
                { encoding: 'utf8' });
            const log = probe.stderr;
            assert.deepEqual(JSON.parse(probe.stdout).streams[0], { codec_name: 'hevc', width: 1296, height: 2816 });
            assert.match(log, /type:'hvcC' parent:'stsd'[^\n]*\n(?:[^\n]*\n)*?[^\n]*type:'colr' parent:'stsd' sz: 19/, `${range}: colr after hvcC`);
            assert.ok(log.includes(expected), `${range}: ${expected}`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function hasFfprobe() {
    try {
        execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

test('Full and Limited override the MSE colr box before the next key frame, Auto follows the stream', (t) => {
    const { player, buffers, sources, requests } = msePlayer(t);
    player.setColourRange('limited');
    player.configure(CODEC, IPHONE_HVCC);
    player.play();
    sources[0].open();
    const buffer = buffers[0];
    assert.equal(sampleEntry(buffer.appended[0]).colr.rangeByte, 0, 'Limited applies to the first init segment');
    // What one frame puts in the buffer, every append until the buffer is idle again.
    const push = (frame) => {
        const before = buffer.appended.length;
        player.pushFrame(frame);
        while (buffer.updating) buffer.finish();
        return buffer.appended.slice(before);
    };
    const types = (appends) => appends.map((append) => parseBoxes(append).map((b) => b.type).join('+'));
    while (buffer.updating) buffer.finish();
    assert.deepEqual(types(push(key)), ['moof+mdat']);
    player.setColourRange('full');
    assert.deepEqual(requests, [true], 'a key frame request');
    assert.deepEqual(types(push(delta)), ['moof+mdat'], 'a delta before the key frame stays with the picture it belongs to');
    const full = push(key);
    assert.deepEqual(types(full), ['ftyp+moov', 'moof+mdat'], 'a new init segment, then the key frame');
    assert.equal(sampleEntry(full[0]).colr.rangeByte, 0x80, 'with the full-range bit');
    player.setColourRange('auto');
    assert.deepEqual(requests, [true], 'Auto is Full for this stream: nothing changes');
    assert.deepEqual(types(push(key)), ['moof+mdat']);
    player.setColourRange('limited');
    assert.deepEqual(requests, [true, true]);
    const limited = push(key);
    assert.deepEqual(types(limited), ['ftyp+moov', 'moof+mdat']);
    assert.equal(sampleEntry(limited[0]).colr.rangeByte, 0);
    assert.equal(sources.length, 1, 'the same MediaSource throughout');
    assert.equal(buffers.length, 1, 'and the same SourceBuffer');

    // A description this cannot read: no colr, as before; Full or Limited still writes one.
    const other = msePlayer(t);
    other.player.configure(CODEC, new Uint8Array([1]));
    other.sources[0].open();
    assert.equal(sampleEntry(other.buffers[0].appended[0]).colr, undefined);
    other.buffers[0].finish();
    other.player.pushFrame(key);
    other.buffers[0].finish();
    other.player.setColourRange('full');
    other.player.pushFrame(key);
    assert.deepEqual(sampleEntry(other.buffers[0].appended.at(-1)).colr,
        { size: 19, kind: 'nclx', primaries: 1, transfer: 1, matrix: 1, rangeByte: 0x80 });
});

// ---------------------------------------------------------------- the client and Settings

test('a change of the colour range asks for one key frame and opens no socket, session or player', async (t) => {
    storage.clear();
    const { colourRange, declaredColour, setColourRange } = state();
    setColourRange('auto');
    const { StreamClientCoreDevice } = require('../src/app/applDevice/client/StreamClientCoreDevice');
    const { CoreDeviceReceiver } = require('../src/app/applDevice/client/CoreDeviceReceiver');
    const connections = t.mock.method(CoreDeviceReceiver.prototype, 'openNewConnection', () => undefined);
    const sent = [];
    t.mock.method(CoreDeviceReceiver.prototype, 'send', (message) => sent.push(message));
    MockDecoder.instances.length = 0;
    MockDecoder.isConfigSupported = async () => ({ supported: true });
    MockDecoder.throwOnColour = false;
    const container = element();
    const client = StreamClientCoreDevice.start({ action: 'stream-coredevice', udid: 'iphone-colour', captureKeyboard: false }, container);
    let stopped = false;
    t.after(() => !stopped && client.stop());
    await client.onCodec({ codec: CODEC, description: IPHONE_HVCC });
    const player = client.getPlayer();
    assert.equal(client.getDecoderKind(), 'hevc');
    assert.equal(MockDecoder.instances[0].configs[0].colorSpace.fullRange, true);
    assert.equal(declaredColour.value.client, client, 'the fact in Settings is this stream');
    assert.equal(state().streamColourFact(declaredColour.value.colour), 'Full range, colour space not declared');
    const before = { connections: connections.mock.callCount(), children: client.videoWrapper.children.length };
    assert.ok(before.children > 0, 'the player is mounted');

    setColourRange('limited');
    assert.equal(colourRange.value, 'limited');
    assert.equal(storage.get('ws-scrcpy.iphone.colour-range'), 'limited', 'kept in this browser');
    assert.deepEqual(sent, [{ type: 'pli' }], 'one key frame request, and nothing else');
    assert.equal(MockDecoder.instances.at(-1).configs[0].colorSpace.fullRange, false);
    assert.equal(client.getPlayer(), player, 'the same player');
    assert.equal(connections.mock.callCount(), before.connections, 'no new socket');
    assert.equal(client.videoWrapper.children.length, before.children, 'nothing mounted again');
    assert.equal(container.children.length, 1, 'one phone view');
    setColourRange('auto');
    assert.deepEqual(sent, [{ type: 'pli' }, { type: 'pli' }]);
    assert.equal(MockDecoder.instances.at(-1).configs[0].colorSpace.fullRange, true);

    client.stop();
    stopped = true;
    assert.equal(declaredColour.value, undefined, 'the fact goes with the stream');
    const decoders = MockDecoder.instances.length;
    setColourRange('limited');
    assert.equal(sent.length, 2, 'a stopped client sends nothing');
    assert.equal(MockDecoder.instances.length, decoders);
    setColourRange('auto');
});

test('the choice is kept in this browser, Auto when nothing or something unknown is stored', () => {
    const modulePath = require.resolve('../src/app/state/pictureColour');
    const load = (stored) => {
        storage.clear();
        if (stored !== undefined) storage.set('ws-scrcpy.iphone.colour-range', stored);
        delete require.cache[modulePath];
        return require(modulePath).colourRange.value;
    };
    try {
        assert.equal(load(undefined), 'auto');
        assert.equal(load('full'), 'full');
        assert.equal(load('limited'), 'limited');
        assert.equal(load('bright'), 'auto');
        const blocked = global.localStorage;
        global.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
        try {
            assert.equal(load(undefined), 'auto', 'blocked site storage is Auto');
            assert.doesNotThrow(() => require(modulePath).setColourRange('full'));
        } finally {
            global.localStorage = blocked;
        }
    } finally {
        storage.clear();
        delete require.cache[modulePath];
    }
});
