const assert = require('node:assert/strict');
const { test } = require('node:test');
require('ts-node').register({ transpileOnly: true });
const { NotificationSwipe } = require('../src/app/ui/notificationSwipe');

test('signed iOS Home Screen pointer identifiers, zero, and positive IDs support both swipe actions', () => {
    for (const id of [-1790170905, -1, -2147483648, 0, 1, 2147483647]) {
        const swipe = new NotificationSwipe();
        for (const [direction, action] of [[1, 'read'], [-1, 'dismiss']]) {
            assert.equal(swipe.start(100, 100, id, 256), true, `start pointer ${id}`);
            assert.equal(swipe.pointerId, id);
            assert.deepEqual(swipe.move(100 + direction * 80, 101, id), {
                offset: direction * 80,
                locked: 'horizontal',
            });
            assert.equal(swipe.end(100 + direction * 80, 101, id), action, `finish pointer ${id}`);
            assert.equal(swipe.pointerId, null);
        }
    }
});

test('non-integer and non-finite pointer identifiers remain invalid', () => {
    for (const id of [NaN, Infinity, -Infinity, 1.5, -1.5]) {
        const swipe = new NotificationSwipe();
        assert.equal(swipe.start(0, 0, id, 256), false);
        assert.equal(swipe.pointerId, null);
        assert.equal(swipe.end(80, 0, id), null);
    }
});

test('taps and small movement leave scrolling alone and never commit', () => {
    const swipe = new NotificationSwipe();
    assert.equal(swipe.start(50, 100, 1, 256), true);
    assert.deepEqual(swipe.move(60, 106, 1), { offset: 0, locked: 'pending' });
    assert.equal(swipe.end(60, 106, 1), null);
    assert.equal(swipe.pointerId, null);
    swipe.start(0, 0, 1, 256);
    assert.equal(swipe.end(100, 0, 1), null, 'pointerup alone cannot establish swipe intent');
});

test('vertical intent locks before horizontal intent and stays available for normal scrolling', () => {
    const swipe = new NotificationSwipe();
    swipe.start(100, 100, 1, 256);
    assert.deepEqual(swipe.move(108, 109, 1), { offset: 0, locked: 'vertical' });
    assert.deepEqual(swipe.move(250, 120, 1), { offset: 0, locked: 'vertical' });
    assert.equal(swipe.end(250, 120, 1), null);
    swipe.start(100, 100, 1, 256);
    assert.equal(swipe.move(91, 91, 1).locked, 'vertical', 'equal diagonal movement prefers scrolling');
    assert.equal(swipe.end(0, 0, 1), null);
});

test('ambiguous diagonal motion stays pending until a clear direction develops', () => {
    const swipe = new NotificationSwipe();
    swipe.start(0, 0, 1, 256);
    assert.deepEqual(swipe.move(20, 18, 1), { offset: 0, locked: 'pending' });
    assert.equal(swipe.move(80, 70, 1).locked, 'pending');
    assert.equal(swipe.end(80, 70, 1), null);
    swipe.start(0, 0, 1, 256);
    swipe.move(20, 18, 1);
    assert.deepEqual(swipe.move(30, 18, 1), { offset: 30, locked: 'horizontal' });
    assert.equal(swipe.end(64, 18, 1), 'read');
});

test('right marks read and left dismisses only after the full distance threshold', () => {
    const swipe = new NotificationSwipe();
    for (const [direction, action] of [[1, 'read'], [-1, 'dismiss']]) {
        swipe.start(100, 100, 1, 256);
        assert.equal(swipe.move(100 + direction * 20, 101, 1).locked, 'horizontal');
        assert.equal(swipe.end(100 + direction * 63, 101, 1), null);
        swipe.start(100, 100, 1, 256);
        swipe.move(100 + direction * 20, 101, 1);
        assert.equal(swipe.end(100 + direction * 64, 101, 1), action);
        assert.equal(swipe.end(100 + direction * 100, 101, 1), null, 'a second pointerup cannot repeat it');
    }
});

test('threshold adapts to card width within 56–88 pixels and handles missing measurements', () => {
    for (const [width, threshold] of [[180, 56], [256, 64], [320, 80], [600, 88], [0, 64], [NaN, 64]]) {
        const swipe = new NotificationSwipe();
        swipe.start(0, 0, 1, width);
        swipe.move(threshold - 1, 0, 1);
        assert.equal(swipe.end(threshold - 1, 0, 1), null, `width ${width}: reject below threshold`);
        swipe.start(0, 0, 1, width);
        swipe.move(threshold, 0, 1);
        assert.equal(swipe.end(threshold, 0, 1), 'read', `width ${width}: accept at threshold`);
    }
});

test('a rapid short flick and a swipe returned to its origin cannot commit', () => {
    const swipe = new NotificationSwipe();
    swipe.start(0, 0, 1, 256);
    swipe.move(50, 0, 1);
    assert.equal(swipe.end(50, 0, 1), null, 'speed never substitutes for distance');
    for (const end of [0, 5, -5]) {
        swipe.start(0, 0, 1, 256);
        swipe.move(100, 0, 1);
        swipe.move(end, 0, 1);
        assert.equal(swipe.end(end, 0, 1), null);
    }
});

test('the card follows the finger, with resistance only beyond its full width', () => {
    const swipe = new NotificationSwipe();
    swipe.start(0, 0, 1, 600);
    assert.deepEqual(swipe.move(300, 1, 1), { offset: 300, locked: 'horizontal' });
    assert.deepEqual(swipe.move(-520, 1, 1), { offset: -520, locked: 'horizontal' });
    const resisted = swipe.move(-1000, 1, 1);
    assert.equal(resisted.locked, 'horizontal');
    assert(resisted.offset < -600 && resisted.offset > -1000, 'overscroll is elastic beyond the card edge');
    assert.equal(swipe.end(-1000, 1, 1), 'dismiss');
});

test('unrelated or out-of-order events cannot capture or commit an active gesture', () => {
    const swipe = new NotificationSwipe();
    assert.deepEqual(swipe.move(100, 0, 1), { offset: 0, locked: 'pending' });
    assert.equal(swipe.end(100, 0, 1), null);
    swipe.start(0, 0, 1, 256);
    swipe.move(80, 0, 1);
    assert.deepEqual(swipe.move(100, 0, 2), { offset: 0, locked: 'pending' });
    assert.equal(swipe.end(100, 0, 2), null);
    assert.equal(swipe.pointerId, 1);
    assert.equal(swipe.end(80, 0, 1), 'read');
});

test('additional pointers cancel the swipe and block a new one until all tracked pointers end', () => {
    const swipe = new NotificationSwipe();
    swipe.start(0, 0, 1, 256);
    swipe.move(80, 0, 1);
    assert.equal(swipe.start(0, 0, 2, 256), false);
    assert.equal(swipe.pointerId, null);
    assert.equal(swipe.end(80, 0, 1), null);
    assert.equal(swipe.start(0, 0, 3, 256), false);
    assert.equal(swipe.end(100, 0, 2), null);
    assert.equal(swipe.end(100, 0, 3), null);
    assert.equal(swipe.start(0, 0, 4, 256), true);
    swipe.move(80, 0, 4);
    assert.equal(swipe.end(80, 0, 4), 'read');
});

test('cancellation prevents late moves and pointerups from taking any action', () => {
    const swipe = new NotificationSwipe();
    swipe.start(0, 0, 1, 256);
    swipe.move(-80, 0, 1);
    swipe.cancel();
    assert.equal(swipe.pointerId, null);
    assert.deepEqual(swipe.move(-100, 0, 1), { offset: 0, locked: 'pending' });
    assert.equal(swipe.end(-100, 0, 1), null);
    assert.equal(swipe.start(0, 0, 2, 256), true);
});

test('duplicate starts do not move the origin, and invalid coordinates fail without an action', () => {
    const swipe = new NotificationSwipe();
    swipe.start(0, 0, 1, 256);
    assert.equal(swipe.start(100, 0, 1, 256), false);
    swipe.move(64, 0, 1);
    assert.equal(swipe.end(64, 0, 1), 'read');
    swipe.start(0, 0, 1, 256);
    swipe.move(80, 0, 1);
    assert.equal(swipe.end(NaN, 0, 1), null);
    swipe.start(0, 0, 1, 256);
    swipe.move(NaN, 0, 1);
    assert.equal(swipe.end(100, 0, 1), null);
    assert.equal(swipe.start(Infinity, 0, 1, 256), false);
});
