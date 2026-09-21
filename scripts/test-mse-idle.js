// Run with: node --test scripts/test-mse-idle.js
// Uses the installed h264-converter parser/remuxer, with only browser media APIs replaced.
const assert = require('node:assert/strict');
const { test } = require('node:test');
require('ts-node').register({ transpileOnly: true });
const { MsePlayer } = require('../src/app/player/MsePlayer');
const ScreenInfo = require('../src/app/ScreenInfo').default;
const Rect = require('../src/app/Rect').default;
const Size = require('../src/app/Size').default;

// Two real 32×32 red frames encoded by libx264 (baseline, zerolatency, keyint=60).
// Store whole Annex-B packets just as scrcpy emits them; no ffmpeg dependency at test time.
const CONFIG = Buffer.from('000000016742c00ada25b011000003000100000300788f1226a00000000168ce0fc8', 'hex');
const IDR = Buffer.from('000000016588843a118a000218f1c00040f63800087949d75e', 'hex');
const DELTA = Buffer.from('00000001419a206a2c', 'hex');
const emptyRanges = {
    length: 0,
    start() {
        throw new Error('Empty range');
    },
    end() {
        throw new Error('Empty range');
    },
};

function fixture(t) {
    class FakeSourceBuffer extends EventTarget {
        updating = false;
        buffered = emptyRanges;
        appended = [];
        onupdateend = null;
        appendBuffer(data) {
            assert.equal(this.updating, false);
            this.appended.push(Buffer.from(data));
            this.updating = true;
        }
        finishAppend() {
            this.updating = false;
            this.dispatchEvent(new Event('updateend'));
            this.onupdateend?.(new Event('updateend'));
        }
    }
    class FakeMediaSource extends EventTarget {
        static instances = [];
        static isTypeSupported() {
            return true;
        }
        readyState = 'closed';
        duration = 0;
        constructor() {
            super();
            FakeMediaSource.instances.push(this);
        }
        addSourceBuffer() {
            this.buffer = new FakeSourceBuffer();
            return this.buffer;
        }
        open() {
            this.readyState = 'open';
            this.dispatchEvent(new Event('sourceopen'));
        }
    }
    class FakeVideo extends EventTarget {
        paused = true;
        readyState = 0;
        currentTime = 0;
        videoWidth = 32;
        videoHeight = 32;
        buffered = emptyRanges;
        seekable = emptyRanges;
        error = null;
        style = {};
        setAttribute() {}
        play() {
            this.paused = false;
            return Promise.resolve();
        }
        pause() {
            this.paused = true;
        }
    }
    const globals = {
        window: {
            innerWidth: 390,
            innerHeight: 844,
            localStorage: {
                getItem() {
                    return null;
                },
            },
        },
        navigator: { userAgent: 'Chrome', platform: 'Linux' },
        document: {
            createElement(type) {
                return type === 'video' ? new FakeVideo() : { style: {} };
            },
        },
        MediaSource: FakeMediaSource,
        requestAnimationFrame: () => 1,
    };
    for (const [name, value] of Object.entries(globals)) {
        const old = Object.getOwnPropertyDescriptor(global, name);
        Object.defineProperty(global, name, { configurable: true, writable: true, value });
        t.after(() => (old ? Object.defineProperty(global, name, old) : delete global[name]));
    }
    t.mock.method(URL, 'createObjectURL', () => 'blob:mse-fixture');
    const player = new MsePlayer('idle-screen');
    player.setScreenInfo(new ScreenInfo(new Rect(0, 0, 32, 32), new Size(32, 32), 0));
    player.play();
    t.after(() => player.stop());
    return { player, sources: FakeMediaSource.instances };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
function drain(buffer) {
    while (buffer.updating) buffer.finishAppend();
}
function assertPicture(buffer, picture, label) {
    assert(
        buffer.appended.some((data) => data.includes(picture.subarray(4))),
        label,
    );
}

test('a single idle IDR remuxes without waiting for a subsequent picture', async (t) => {
    const { player, sources } = fixture(t);
    sources[0].open();
    player.pushFrame(CONFIG);
    player.pushFrame(IDR);
    await nextTurn();
    const buffer = sources[0].buffer;
    drain(buffer);
    assert.equal(buffer.appended.length, 2, 'initialization plus one media segment');
    assert.equal(buffer.appended[0].subarray(4, 8).toString(), 'ftyp');
    assertPicture(buffer, IDR, 'the final IDR NAL reaches the media segment immediately');
    player.pushFrame(DELTA);
    drain(buffer);
    assert.equal(buffer.appended.length, 3, 'a complete delta also flushes without the following frame');
    assertPicture(buffer, DELTA, 'delta payload is retained intact');
});

test('config and the only idle picture arriving before sourceopen drain after readiness', async (t) => {
    const { player, sources } = fixture(t);
    player.pushFrame(CONFIG);
    player.pushFrame(IDR);
    assert.equal(sources[0].buffer, undefined, 'MediaSource is still closed');
    sources[0].open();
    await nextTurn();
    const buffer = sources[0].buffer;
    drain(buffer);
    assert.equal(buffer.appended.length, 2, 'the converter preserves both queued segments');
    assertPicture(buffer, IDR, 'no subsequent input is needed after sourceopen');
});

test('restarting the converter clears a pending old buffer-removal wait and queued frames', async (t) => {
    const { player, sources } = fixture(t);
    sources[0].open();
    player.pushFrame(CONFIG);
    player.pushFrame(IDR);
    drain(sources[0].buffer);
    player.waitUntilSegmentRemoved = true;
    player.pushFrame(DELTA);
    assert.equal(player.frames.length, 1);
    player.pause();
    player.play();
    player.pushFrame(CONFIG);
    player.pushFrame(IDR);
    sources[1].open();
    await nextTurn();
    drain(sources[1].buffer);
    assert.equal(player.frames.length, 0, 'old-session pictures are not replayed');
    assert.equal(sources[1].buffer.appended.length, 2);
    assertPicture(sources[1].buffer, IDR, 'the replacement converter displays its idle key frame');
});
