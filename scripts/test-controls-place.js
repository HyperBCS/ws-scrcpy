// Run with: node --test scripts/test-controls-place.js
// The place of the controls button on a touch screen (src/app/controls/buttonPlace.ts): a side
// and a height, the nearer edge for a button let go, the default place in a band beside or under
// the picture, and the place read back from storage, also from the corner kept before. No
// browser or phone is used.
const assert = require('node:assert/strict');
const { test } = require('node:test');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const {
    DEFAULT_FRACTION, clampPoint, defaultPlace, parsePlace, placeFromPosition, placeOf, pointOf,
} = require('../src/app/controls/buttonPlace');

const SIZE = { width: 44, height: 56 };
// The stage of a 390x844 phone under a 106px header and tabs, 12px from its top and bottom.
const PORTRAIT = { left: 0, top: 118, right: 390, bottom: 832 };
// The same phone turned: 844x390.
const LANDSCAPE = { left: 0, top: 118, right: 844, bottom: 378 };

test('a place is a side and a height, the same fraction of the height at every size', () => {
    assert.deepEqual(pointOf({ side: 'right', fraction: 0 }, PORTRAIT, SIZE), { x: 346, y: 118 });
    assert.deepEqual(pointOf({ side: 'left', fraction: 1 }, PORTRAIT, SIZE), { x: 0, y: 776 });
    assert.deepEqual(pointOf({ side: 'right', fraction: 0.5 }, LANDSCAPE, SIZE), { x: 800, y: 220 });
    // A fraction out of range is taken as the nearer end.
    assert.deepEqual(pointOf({ side: 'left', fraction: 3 }, PORTRAIT, SIZE), { x: 0, y: 776 });
    // On whole pixels, inside the area.
    assert.deepEqual(pointOf({ side: 'right', fraction: 0.3 }, { left: 0.5, top: 100.25, right: 389.5, bottom: 500 }, SIZE), { x: 345, y: Math.round(100.25 + 0.3 * (500 - 100.25 - 56)) });
    assert.deepEqual(pointOf({ side: 'left', fraction: 0 }, { left: 0.5, top: 100, right: 389.5, bottom: 500 }, SIZE), { x: 1, y: 100 });
    // An area lower than the button keeps it at the top of the area.
    assert.deepEqual(pointOf({ side: 'right', fraction: 0.5 }, { left: 0, top: 100, right: 390, bottom: 130 }, SIZE), { x: 346, y: 100 });
});

test('a button let go goes to the nearer edge at the same height', () => {
    assert.deepEqual(placeOf({ x: 100, y: 447 }, PORTRAIT, SIZE), { side: 'left', fraction: 0.5 });
    assert.deepEqual(placeOf({ x: 200, y: 118 }, PORTRAIT, SIZE), { side: 'right', fraction: 0 });
    // The middle of the button decides: its centre at 195 is not left of the middle.
    assert.deepEqual(placeOf({ x: 173, y: 776 }, PORTRAIT, SIZE).side, 'right');
    assert.deepEqual(placeOf({ x: 172, y: 776 }, PORTRAIT, SIZE).side, 'left');
    // A place kept and laid out again is the same point.
    const place = placeOf({ x: 346, y: 300 }, PORTRAIT, SIZE);
    assert.deepEqual(pointOf(place, PORTRAIT, SIZE), { x: 346, y: 300 });
});

test('a dragged button stays inside the area: never over the header, the tabs or the banners', () => {
    assert.deepEqual(clampPoint({ x: -50, y: 0 }, PORTRAIT, SIZE), { x: 0, y: 118 });
    assert.deepEqual(clampPoint({ x: 900, y: 900 }, PORTRAIT, SIZE), { x: 346, y: 776 });
    assert.deepEqual(clampPoint({ x: 120, y: 400 }, PORTRAIT, SIZE), { x: 120, y: 400 });
});

test('the default place is on the right edge, in a band beside or under the picture when there is one', () => {
    // No picture yet, and a picture with no band: on the right edge, over the picture.
    assert.deepEqual(defaultPlace(PORTRAIT, undefined, SIZE), { side: 'right', fraction: DEFAULT_FRACTION });
    assert.deepEqual(defaultPlace(PORTRAIT, { left: 0, top: 128, right: 390, bottom: 822 }, SIZE), { side: 'right', fraction: DEFAULT_FRACTION });
    // A band of 342px beside a turned phone's picture: the button on the right edge is in it.
    const beside = defaultPlace(LANDSCAPE, { left: 342, top: 106, right: 502, bottom: 390 }, SIZE);
    assert.deepEqual(beside, { side: 'right', fraction: DEFAULT_FRACTION });
    assert.ok(pointOf(beside, LANDSCAPE, SIZE).x >= 502);
    // A band too narrow for the button (the iPhone picture leaves 11px).
    assert.deepEqual(defaultPlace(PORTRAIT, { left: 11, top: 118, right: 379, bottom: 832 }, SIZE), { side: 'right', fraction: DEFAULT_FRACTION });
    // A wide picture in a tall window: bands above and below, the button in the middle of the
    // lower one when they are the same.
    const picture = { left: 0, top: 365, right: 390, bottom: 585 };
    const under = pointOf(defaultPlace(PORTRAIT, picture, SIZE), PORTRAIT, SIZE);
    assert.equal(under.x, 346);
    // On whole pixels: 680.5 is drawn at 681.
    assert.equal(under.y, Math.round(585 + (832 - 585 - 56) / 2));
    // A taller band above wins.
    const higher = pointOf(defaultPlace(PORTRAIT, { left: 0, top: 500, right: 390, bottom: 720 }, SIZE), PORTRAIT, SIZE);
    assert.equal(higher.y, 118 + (500 - 118 - 56) / 2);
    // Bands lower than the button: over the picture.
    assert.deepEqual(defaultPlace(PORTRAIT, { left: 0, top: 150, right: 390, bottom: 800 }, SIZE), { side: 'right', fraction: DEFAULT_FRACTION });
});

test('a stored place is read back, and anything else is not a place', () => {
    assert.deepEqual(parsePlace('{"side":"left","fraction":0.25}'), { side: 'left', fraction: 0.25 });
    assert.deepEqual(parsePlace('{"side":"right","fraction":7}'), { side: 'right', fraction: 1 });
    for (const text of [null, '', 'not json', '{"side":"top","fraction":0.5}', '{"side":"left"}', '{"x":10,"y":20}', '{"side":"left","fraction":"0.5"}']) {
        assert.equal(parsePlace(text), undefined, String(text));
    }
});

test('the corner kept before the button stayed on an edge becomes a place at the same height', () => {
    const old = { width: 56, height: 56 };
    // The suites and an owner's browser may hold {x, y} of a 56px button.
    assert.deepEqual(placeFromPosition('{"x":318,"y":300}', PORTRAIT, SIZE, old), placeOf({ x: 324, y: 300 }, PORTRAIT, SIZE));
    assert.equal(placeFromPosition('{"x":318,"y":300}', PORTRAIT, SIZE, old).side, 'right');
    assert.deepEqual(placeFromPosition('{"x":12,"y":20}', PORTRAIT, SIZE, old), { side: 'left', fraction: 0 });
    assert.equal(placeFromPosition('{"x":"a","y":1}', PORTRAIT, SIZE, old), undefined);
    assert.equal(placeFromPosition(null, PORTRAIT, SIZE, old), undefined);
    assert.equal(placeFromPosition('{', PORTRAIT, SIZE, old), undefined);
});
