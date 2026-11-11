// Sheet and shared UI rules that need no browser: where focus returns when sheets replace each
// other, the Listen label per playback state, Copy here without the async clipboard API, and the
// contrast of the colour tokens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

// A minimal document: enough for focus bookkeeping and the selection copy.
class FakeElement {
    constructor(name, parent) {
        this.name = name;
        this.parent = parent;
        this.shown = true;
        this.isConnected = true;
        this.style = {};
    }
    contains(other) {
        for (let node = other; node; node = node.parent) if (node === this) return true;
        return false;
    }
    getClientRects() {
        for (let node = this; node; node = node.parent) if (!node.shown) return [];
        return [{}];
    }
    focus() {
        if (this.getClientRects().length) document.activeElement = this;
    }
    setAttribute() {}
    setSelectionRange() {}
    remove() {
        this.isConnected = false;
    }
}
global.HTMLElement = FakeElement;
global.document = {
    body: new FakeElement('body'),
    activeElement: null,
    copied: [],
    createElement: (name) => new FakeElement(name, document.body),
    getSelection: () => null,
    execCommand(command) {
        this.copied.push([command, this.activeElement?.value]);
        return command === 'copy';
    },
};
document.body.appendChild = () => {};

const { rememberDialogFocus, returnDialogFocus } = require('../src/app/ui/dialogFocus');
const { listenStateLabel } = require('../src/app/state/audio');
const { copyPhoneClipboardHere } = require('../src/app/ui/copyText');

test('a sheet opened from another sheet keeps focus, and the last one returns it to the page', () => {
    const toolbarButton = new FakeElement('toolbar Actions', document.body);
    const fab = new FakeElement('fab', document.body);
    const actions = new FakeElement('actions sheet', document.body);
    const openSettings = new FakeElement('Open button', actions);
    const settings = new FakeElement('settings sheet', document.body);

    document.activeElement = toolbarButton;
    rememberDialogFocus(actions);
    actions.focus();
    openSettings.focus();
    // "Open" closes Actions and opens Stream settings in the same step.
    rememberDialogFocus(settings);
    settings.focus();
    // Actions finishes its exit animation about 220 ms later.
    actions.shown = false;
    returnDialogFocus(actions, fab);
    assert.equal(document.activeElement, settings, 'the sheet that finished closing leaves focus in the open one');
    settings.shown = false;
    returnDialogFocus(settings, fab);
    assert.equal(document.activeElement, toolbarButton, 'the last sheet returns focus to where the first was opened');
});

test('focus that fell to the body still inherits the outgoing sheet, and the fallback is used last', () => {
    const fab = new FakeElement('fab', document.body);
    const opener = new FakeElement('panel button', document.body);
    const first = new FakeElement('first sheet', document.body);
    const second = new FakeElement('second sheet', document.body);
    document.activeElement = opener;
    rememberDialogFocus(first);
    // The first sheet turned inert as it closed and the browser dropped focus.
    document.activeElement = document.body;
    rememberDialogFocus(second);
    second.focus();
    first.shown = false;
    returnDialogFocus(first, fab);
    assert.equal(document.activeElement, second);
    // The controls panel has closed meanwhile, so its button is gone too.
    opener.shown = false;
    second.shown = false;
    returnDialogFocus(second, fab);
    assert.equal(document.activeElement, fab);
});

test('a single sheet returns focus to its opener', () => {
    const opener = new FakeElement('card button', document.body);
    const sheet = new FakeElement('sheet', document.body);
    document.activeElement = opener;
    rememberDialogFocus(sheet);
    sheet.focus();
    sheet.shown = false;
    returnDialogFocus(sheet);
    assert.equal(document.activeElement, opener);
});

test('the Listen control names its state', () => {
    assert.equal(listenStateLabel('muted', true), 'Listen');
    assert.equal(listenStateLabel('playing', false), 'Listening');
    assert.equal(listenStateLabel('waiting', false), 'Waiting for audio');
    assert.equal(listenStateLabel('disconnected', false), 'Waiting for audio');
    assert.equal(listenStateLabel('blocked', false), 'Blocked');
    assert.equal(listenStateLabel('blocked', true), 'Blocked');
    for (const state of ['disabled', 'error', 'unsupported']) assert.equal(listenStateLabel(state, false), 'Listen');
    assert.notEqual(listenStateLabel('waiting', false), listenStateLabel('playing', false), 'waiting does not read as playing');
});

test('Copy here works on plain HTTP, where navigator.clipboard does not exist', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    try {
        const button = new FakeElement('Copy here', document.body);
        document.activeElement = button;
        document.copied.length = 0;
        assert.equal(await copyPhoneClipboardHere('from the phone'), 'Copied to this browser.');
        assert.deepEqual(document.copied, [['copy', 'from the phone']]);
        assert.equal(document.activeElement, button, 'focus goes back to the pressed button');
        assert.equal(await copyPhoneClipboardHere(undefined), 'Read the phone clipboard first.');
        assert.equal(await copyPhoneClipboardHere(''), 'The phone clipboard is empty.');
    } finally {
        if (original) Object.defineProperty(globalThis, 'navigator', original);
        else delete globalThis.navigator;
    }
});

// --- colour tokens ---------------------------------------------------------------------------
function parseColor(value) {
    const hex = /^#([0-9a-f]{6})$/i.exec(value);
    if (hex) return [0, 2, 4].map((at) => parseInt(hex[1].slice(at, at + 2), 16));
    const hsl = /^hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)$/.exec(value);
    assert(hsl, `unsupported colour ${value}`);
    const [h, s, l] = [Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100];
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))));
}
function luminance(rgb) {
    const [r, g, b] = rgb.map((value) => {
        value /= 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
}
const mix = (top, under, share) => top.map((value, index) => Math.round(value * share + under[index] * (1 - share)));

function themes() {
    const css = fs.readFileSync(path.join(__dirname, '../src/style/tokens.css'), 'utf8');
    const split = css.indexOf('@media (prefers-color-scheme: dark)');
    const read = (block) => Object.fromEntries(Array.from(block.matchAll(/(--[\w-]+):\s*([^;]+);/g), (match) => [match[1], match[2].trim()]));
    const light = read(css.slice(0, split));
    return { light, dark: { ...light, ...read(css.slice(split)) } };
}
const STATUSES = ['streaming', 'ready', 'asleep', 'starting', 'offline', 'unauthorized'];
const SURFACES = ['--device-list-default-color', '--main-bg-color', '--header-bg-color', '--device-list-stripe-color'];

test('status text colours reach 4.5:1 on every surface and on their own tint, in both themes', () => {
    for (const [theme, tokens] of Object.entries(themes())) {
        for (const status of STATUSES) {
            const text = parseColor(tokens[`--status-${status}-text`]);
            const fill = parseColor(tokens[`--status-${status}-fill`]);
            assert.equal(tokens[`--status-${status}-color`], `var(--status-${status}-text)`, 'the older name carries the text colour');
            for (const name of SURFACES) {
                const surface = parseColor(tokens[name]);
                for (const [where, background] of [['surface', surface], ['12% tint', mix(fill, surface, 0.12)], ['own 12% tint', mix(text, surface, 0.12)]]) {
                    const ratio = contrast(text, background);
                    assert(ratio >= 4.5, `${theme} ${status} text on ${name} ${where}: ${ratio.toFixed(2)}`);
                }
            }
        }
    }
});

test('field edges reach 3:1, button labels 4.5:1, and white reads on the solid danger colour', () => {
    for (const [theme, tokens] of Object.entries(themes())) {
        const white = [255, 255, 255];
        const danger = contrast(white, parseColor(tokens['--status-danger-solid']));
        assert(danger >= 4.5, `${theme} white on the solid danger colour: ${danger.toFixed(2)}`);
        for (const name of SURFACES) {
            const surface = parseColor(tokens[name]);
            const edge = contrast(parseColor(tokens['--control-border-color']), surface);
            assert(edge >= 3, `${theme} field edge on ${name}: ${edge.toFixed(2)}`);
            const label = contrast(parseColor(tokens['--button-text-color']), surface);
            assert(label >= 4.5, `${theme} button label on ${name}: ${label.toFixed(2)}`);
        }
    }
});
