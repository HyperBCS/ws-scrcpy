// Run with: node scripts/test-stream-lifecycle.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
require('ts-node').register({ transpileOnly: true });
const { StreamReceiver } = require('../src/app/client/StreamReceiver');
const { UhidKeyboard } = require('../src/app/googDevice/UhidKeyboard');

function receiverWithSocket(t) {
    class BrowserSocket extends EventEmitter {
        static instances = [];
        CONNECTING = 0;
        OPEN = 1;
        CLOSING = 2;
        CLOSED = 3;
        readyState = 0;
        sent = [];
        closes = 0;
        constructor() {
            super();
            BrowserSocket.instances.push(this);
        }
        addEventListener(type, listener) {
            this.on(type, listener);
        }
        open() {
            this.readyState = this.OPEN;
            this.emit('open', {});
        }
        initial() {
            // Empty display/encoder lists are sufficient to complete this protocol handshake.
            const packet = Buffer.concat([Buffer.from('scrcpy_initial'), Buffer.alloc(64 + 4 + 4 + 4)]);
            this.emit('message', { data: packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.length) });
        }
        send(data) {
            this.sent.push(Buffer.from(data));
        }
        close() {
            this.closes++;
            this.readyState = this.CLOSED;
            this.emit('close', { reason: 'closed' });
        }
    }
    const previous = global.WebSocket;
    global.WebSocket = BrowserSocket;
    t.after(() => {
        global.WebSocket = previous;
    });
    const receiver = new StreamReceiver({
        udid: 'test',
        action: 'proxy_adb',
        hostname: '127.0.0.1',
        port: 8000,
        pathname: '/',
    });
    t.after(() => receiver.stop());
    return { receiver, socket: BrowserSocket.instances[0], sockets: BrowserSocket.instances };
}

const event = (value) => ({ toBuffer: () => Buffer.from([value]) });

test('stop closes a CONNECTING stream and ignores late open/message/input', (t) => {
    const { receiver, socket } = receiverWithSocket(t);
    let frames = 0;
    let connections = 0;
    receiver.on('video', () => frames++);
    receiver.on('connected', () => connections++);
    receiver.sendEvent(event(1));
    receiver.stop();
    assert.equal(socket.closes, 1);
    socket.open();
    socket.initial();
    socket.emit('message', { data: new ArrayBuffer(20) });
    receiver.sendEvent(event(2));
    assert.equal(socket.readyState, socket.CLOSED);
    assert.equal(frames, 0);
    assert.equal(connections, 0);
    assert.deepEqual(socket.sent, []);
});

test('initial setup is sent once and input during an outage is never replayed', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { receiver, socket, sockets } = receiverWithSocket(t);
    receiver.sendEvent(event(12));
    socket.open();
    assert.deepEqual(socket.sent, []);
    socket.initial();
    assert.deepEqual(socket.sent, [Buffer.from([12])]);
    socket.close();
    receiver.sendEvent(event(2));
    t.mock.timers.tick(1000);
    assert.equal(sockets.length, 2);
    const replacement = sockets[1];
    receiver.sendEvent(event(3));
    replacement.open();
    assert.deepEqual(replacement.sent, []);
    replacement.initial();
    assert.deepEqual(replacement.sent, []);
    receiver.sendEvent(event(4));
    assert.deepEqual(replacement.sent, [Buffer.from([4])]);
});

test('stopping during reconnect backoff cancels the replacement connection', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { receiver, socket, sockets } = receiverWithSocket(t);
    socket.open();
    socket.close();
    receiver.stop();
    t.mock.timers.tick(10000);
    assert.equal(sockets.length, 1);
});

test('single-use control batches never queue before handshake or replay after reconnect', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { receiver, socket, sockets } = receiverWithSocket(t);
    assert.equal(receiver.sendImmediateEvents([event(1), event(2)]), false);
    socket.open();
    assert.equal(receiver.sendImmediateEvents([event(1), event(2)]), false);
    socket.initial();
    assert.deepEqual(socket.sent, []);
    assert.equal(receiver.sendImmediateEvents([event(1), event(2)]), true);
    assert.deepEqual(socket.sent, [Buffer.from([1, 2])], 'one ordered batch is sent immediately');
    socket.close();
    assert.equal(receiver.sendImmediateEvents([event(3)]), false);
    t.mock.timers.tick(1000);
    sockets[1].open();
    sockets[1].initial();
    assert.deepEqual(sockets[1].sent, []);
    sockets[1].send = () => {
        throw new Error('transport failure');
    };
    assert.equal(receiver.sendImmediateEvents([event(4)]), false);
    receiver.stop();
    assert.equal(receiver.sendImmediateEvents([event(5)]), false);
});

test('UHID reset recreates the keyboard without replaying held keys or destroy messages', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = [];
    const keyboard = new UhidKeyboard({ sendMessage: (message) => sent.push(message.toBuffer()) }, 17);
    keyboard.create();
    keyboard.create();
    assert.deepEqual(
        sent.map((data) => data[0]),
        [12],
    );
    t.mock.timers.tick(500);
    keyboard.handleKey('ShiftLeft', true);
    keyboard.handleKey('KeyA', true);
    assert.equal(sent.at(-1)[5], 2);
    assert.equal(sent.at(-1)[7], 4);
    sent.length = 0;
    keyboard.reset();
    assert.equal(keyboard.handleKey('ControlLeft', true), true);
    assert.equal(keyboard.handleKey('KeyC', true), true);
    assert.equal(keyboard.handleKey('Unidentified', true), false);
    assert.deepEqual(sent, []);
    keyboard.create();
    assert.deepEqual(sent, [], 'reconnect must wait for the newly assigned client id');
    keyboard.setId(18);
    keyboard.create();
    t.mock.timers.tick(500);
    keyboard.handleKey('KeyB', true);
    assert.deepEqual(
        sent.map((data) => data[0]),
        [12, 13],
    );
    assert.equal(sent[1][5], 0);
    assert.equal(sent[1][7], 5);
    assert.equal(sent[1].readUInt16BE(1), 18);
    keyboard.destroy();
    assert.equal(sent.at(-1)[0], 14);
});

test('two viewers use independent keyboard ids for create, input, and teardown', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const firstMessages = [];
    const secondMessages = [];
    const first = new UhidKeyboard({ sendMessage: (message) => firstMessages.push(message.toBuffer()) }, 101);
    const second = new UhidKeyboard({ sendMessage: (message) => secondMessages.push(message.toBuffer()) }, 202);
    first.create();
    second.create();
    t.mock.timers.tick(500);
    first.handleKey('KeyA', true);
    second.handleKey('KeyB', true);
    first.destroy();
    second.handleKey('KeyB', false);
    assert.deepEqual(
        firstMessages.map((data) => [data[0], data.readUInt16BE(1)]),
        [
            [12, 101],
            [13, 101],
            [14, 101],
        ],
    );
    assert.deepEqual(
        secondMessages.map((data) => [data[0], data.readUInt16BE(1)]),
        [
            [12, 202],
            [13, 202],
            [13, 202],
        ],
    );
    assert.equal(secondMessages.at(-1)[7], 0);
});

test('unassigned and invalid keyboard ids cannot reach the control socket', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = [];
    const keyboard = new UhidKeyboard({ sendMessage: (message) => sent.push(message.toBuffer()) });
    keyboard.create();
    keyboard.handleKey('KeyA', true);
    assert.deepEqual(sent, []);
    for (const id of [0, -1, 65536, 1.5, NaN]) {
        assert.throws(() => keyboard.setId(id), /Invalid UHID keyboard id/);
    }
    keyboard.setId(65535);
    keyboard.create();
    assert.equal(sent[0].readUInt16BE(1), 65535);
});

test('lazy UHID buffers first keys and modifiers through registration, preserving FIFO while draining', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = [];
    const keyboard = new UhidKeyboard({ sendMessage: message => sent.push(message.toBuffer()) }, 41);
    keyboard.handleKey('KeyX', false);
    keyboard.handleKey('Unidentified', true);
    keyboard.releaseAll();
    assert.deepEqual(sent, [], 'key releases and unsupported keys do not create an external keyboard');
    keyboard.handleKey('ShiftLeft', true);
    keyboard.handleKey('KeyX', true);
    keyboard.handleKey('KeyX', false);
    keyboard.handleKey('KeyY', true);
    keyboard.handleKey('KeyY', false);
    keyboard.handleKey('ShiftLeft', false);
    const inputs = () => sent.filter(message => message[0] === 13);
    assert.deepEqual(sent.map(message => message[0]), [12]);
    t.mock.timers.tick(499);
    assert.deepEqual(inputs(), [], 'first presses/releases stay buffered throughout registration');
    t.mock.timers.tick(1);
    assert.equal(inputs().length, 1, 'the queued reports do not burst together');
    assert.deepEqual([...inputs()[0].subarray(5)], [2, 0, 0, 0, 0, 0, 0, 0]);
    t.mock.timers.tick(7);
    assert.equal(inputs().length, 1);
    t.mock.timers.tick(1);
    keyboard.handleKey('KeyZ', true);
    keyboard.handleKey('KeyZ', false);
    for (let report = 0; report < 6; report++) t.mock.timers.tick(8);
    assert.deepEqual(inputs().map(message => [message[5], message[7]]), [
        [2, 0], [2, 0x1b], [2, 0], [2, 0x1c], [2, 0], [0, 0], [0, 0x1d], [0, 0],
    ], 'immutable snapshots retain early keyups, modifiers and newly appended reports');
    keyboard.handleKey('KeyA', true);
    keyboard.handleKey('KeyA', true);
    assert.equal(inputs().length, 9, 'normal input is immediate after draining, and repeat does not duplicate it');
    keyboard.handleKey('KeyA', false);
    assert.equal(inputs().length, 10);
    keyboard.destroy();
});

for (const cancellation of ['destroy', 'reset', 'setId']) {
    test(`UHID ${cancellation} cancels pending registration and drain before a fresh session`, (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const sent = [];
        const keyboard = new UhidKeyboard({ sendMessage: message => sent.push(message.toBuffer()) }, 51);
        const cancel = () => cancellation === 'setId' ? keyboard.setId(52) : keyboard[cancellation]();
        keyboard.handleKey('KeyA', true);
        keyboard.handleKey('KeyA', false);
        t.mock.timers.tick(100);
        cancel();
        t.mock.timers.tick(1000);
        assert.equal(sent.filter(message => message[0] === 13).length, 0, 'no initial report survives cancellation');
        assert.equal(sent.filter(message => message[0] === 14).length, cancellation === 'reset' ? 0 : 1);
        keyboard.setId(52);
        keyboard.handleKey('KeyB', true);
        keyboard.handleKey('KeyB', false);
        t.mock.timers.tick(500);
        const input = sent.filter(message => message[0] === 13);
        assert.equal(input.length, 1);
        assert.equal(input[0].readUInt16BE(1), 52);
        assert.equal(input[0][7], 5, 'only the new session key reaches the new namespace');
        const beforeCancel = sent.length;
        if (cancellation === 'setId') keyboard.setId(53);
        else keyboard[cancellation]();
        t.mock.timers.tick(1000);
        assert.equal(sent.slice(beforeCancel).filter(message => message[0] === 13).length, 0, 'cancellation also stops an active drain');
    });
}

test('UHID registration backlog is bounded and overflow unregisters without replaying held keys', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = [];
    const keyboard = new UhidKeyboard({ sendMessage: message => sent.push(message.toBuffer()) }, 61);
    for (let report = 0; report < 257; report++) keyboard.handleKey('KeyA', report % 2 === 0);
    assert.deepEqual(sent.map(message => message[0]), [12, 14]);
    t.mock.timers.tick(1000);
    keyboard.handleKey('KeyA', false);
    assert.deepEqual(sent.map(message => message[0]), [12, 14], 'overflow clears timers and late releases cannot reattach');
    keyboard.handleKey('KeyB', true);
    keyboard.handleKey('KeyB', false);
    t.mock.timers.tick(500);
    t.mock.timers.tick(8);
    const inputs = sent.filter(message => message[0] === 13);
    assert.deepEqual(inputs.map(message => [message[5], message[7]]), [[0, 5], [0, 0]]);
    keyboard.destroy();
});

test('destroying a draining keyboard cannot leak its reports into a new keyboard with the same id', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = [];
    const keyboard = new UhidKeyboard({ sendMessage: message => sent.push(message.toBuffer()) }, 71);
    keyboard.handleKey('ShiftLeft', true);
    keyboard.handleKey('KeyA', true);
    keyboard.handleKey('KeyA', false);
    keyboard.handleKey('ShiftLeft', false);
    t.mock.timers.tick(500);
    assert.deepEqual(sent.map(message => message[0]), [12, 13]);
    keyboard.destroy();
    keyboard.handleKey('KeyB', true);
    keyboard.handleKey('KeyB', false);
    const newSession = sent.length;
    t.mock.timers.tick(8);
    assert.equal(sent.length, newSession, 'the previous drain timer must not consume the new session queue');
    t.mock.timers.tick(492);
    t.mock.timers.tick(8);
    assert.deepEqual(sent.slice(newSession).map(message => [message[0], message.readUInt16BE(1), message[5], message[7]]), [
        [13, 71, 0, 5], [13, 71, 0, 0],
    ], 'only unmodified B from the fresh session is delivered');
    keyboard.destroy();
});
