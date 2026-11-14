// Run with: node --test scripts/test-kit.js
// The shared controls of src/app/ui without a browser: the icon set as data and as strings, the
// class names code that builds HTML relies on, the refusal of an icon button without a label,
// the attributes a button carries for its states, and the sheet parts, which have one look.
// scripts/e2e-kit.js measures the same controls in a browser.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
require.extensions['.css'] = () => {};

const { ICONS, iconSvg } = require('../src/app/ui/icons');
const { Button, buttonClass } = require('../src/app/ui/Button');
const { IconButton, iconButtonClass } = require('../src/app/ui/IconButton');
const { Switch } = require('../src/app/ui/Switch');
const { InlineStatus } = require('../src/app/ui/InlineStatus');
const { Banner } = require('../src/app/ui/Banner');
const SheetControls = require('../src/app/ui/SheetControls');
const { SheetRow, SheetStatus, SheetMessageRow } = SheetControls;

/** Every element in a Preact tree, as { type, props }. Components without hooks are drawn. */
function elements(node, found = []) {
    if (Array.isArray(node)) node.forEach((child) => elements(child, found));
    else if (node && typeof node === 'object') {
        if (typeof node.type === 'function') elements(node.type(node.props), found);
        else {
            if (typeof node.type === 'string') found.push(node);
            elements(node.props?.children, found);
        }
    }
    return found;
}
const classes = (node) => elements(node).map((element) => element.props.class).filter(Boolean);

test('every icon is one path on the 24 by 24 grid, and the string form carries the same attributes', () => {
    const names = Object.keys(ICONS);
    assert.ok(names.length >= 55, `${names.length} icons`);
    for (const name of ['headphones', 'volMute', 'volUp', 'volDown', 'close', 'back', 'bell', 'sliders', 'bolt', 'warning', 'moon']) {
        assert.ok(names.includes(name), `${name} is in the set`);
    }
    assert.notEqual(ICONS.headphones, ICONS.volUp, 'Sound in this browser and the volume key of the phone have different icons');
    assert.notEqual(ICONS.headphones, ICONS.volMute);
    for (const name of names) {
        assert.match(ICONS[name], /^M[\d\sMmLlHhVvAaCcZz.-]+$/, `${name} is path data`);
        const numbers = ICONS[name].match(/^M\s*(-?[\d.]+)[\s,]*(-?[\d.]+)/);
        assert.ok(+numbers[1] >= 0 && +numbers[1] <= 24 && +numbers[2] >= 0 && +numbers[2] <= 24, `${name} starts inside the grid`);
    }
    assert.equal(
        iconSvg('close', 16),
        '<svg class="kit-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" width="16" height="16"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    );
    assert.match(iconSvg('bell'), /width="24" height="24"/);
});

test('the class names of a button for code that builds HTML', () => {
    assert.equal(buttonClass(), 'kit-button');
    assert.equal(buttonClass({ variant: 'primary' }), 'kit-button kit-button-primary');
    assert.equal(buttonClass({ variant: 'quiet', size: 'compact' }), 'kit-button kit-button-quiet kit-button-compact');
    assert.equal(buttonClass({ variant: 'danger', full: true }), 'kit-button kit-button-danger kit-button-full');
    // The answer that confirms a removal has a variant of its own, not a class of the confirm prompt.
    assert.equal(buttonClass({ variant: 'danger-solid' }), 'kit-button kit-button-danger-solid');
    assert.equal(iconButtonClass(), 'kit-icon-button');
    assert.equal(iconButtonClass({ variant: 'bare', danger: true, size: 'compact' }), 'kit-icon-button kit-icon-button-bare kit-icon-button-danger kit-icon-button-compact');
});

test('a button carries its state: busy, disabled, pressed, and a link when it has an address', () => {
    let presses = 0;
    const press = () => presses++;
    const [plain] = elements(Button({ variant: 'primary', onClick: press, children: 'Open screen' }));
    assert.deepEqual([plain.type, plain.props.class, plain.props.type, plain.props.disabled], ['button', 'kit-button kit-button-primary', 'button', false]);
    plain.props.onClick({});
    assert.equal(presses, 1);

    const busy = elements(Button({ busy: true, type: 'submit', icon: 'refresh', onClick: press, children: 'Saving' }));
    assert.deepEqual([busy[0].props['aria-busy'], busy[0].props['aria-disabled'], busy[0].props.disabled], ['true', true, false], 'a busy button keeps the focus');
    // Not disabled, so a press reaches it. The press is cancelled, or a submit button would send its form again.
    let cancelled = 0;
    busy[0].props.onClick({ preventDefault: () => cancelled++ });
    assert.deepEqual([presses, cancelled], [1, 1], 'a press on a busy button does nothing');
    assert.equal(busy.length, 1, 'the ring takes the place of the icon while busy');
    assert.equal(elements(Button({ icon: 'refresh', children: 'Refresh' })).filter((element) => element.type === 'svg').length, 1);

    assert.equal(elements(Button({ pressed: false, children: 'Ctrl' }))[0].props['aria-pressed'], false);
    assert.equal(elements(Button({ children: 'Ctrl' }))[0].props['aria-pressed'], undefined);

    const [link] = elements(Button({ href: '#!action=notifications', children: 'Notifications' }));
    assert.deepEqual([link.type, link.props.href, link.props['aria-disabled']], ['a', '#!action=notifications', undefined]);
    const [off] = elements(Button({ href: '#!action=notifications', disabled: true, onClick: press, children: 'Notifications' }));
    assert.deepEqual([off.type, off.props.href, off.props.role, off.props['aria-disabled'], off.props.onClick], ['a', undefined, 'link', true, undefined]);
});

test('an icon button without a label is refused', () => {
    for (const label of ['', '   ', undefined, null]) {
        assert.throws(() => IconButton({ icon: 'close', label }), /The icon button "close" has no label/);
    }
    const [button, icon] = elements(IconButton({ icon: 'headphones', label: 'Sound', variant: 'bare', pressed: true }));
    assert.deepEqual(
        [button.type, button.props.class, button.props['aria-label'], button.props.title, button.props['aria-pressed']],
        ['button', 'kit-icon-button kit-icon-button-bare', 'Sound', 'Sound', true],
    );
    assert.deepEqual([icon.type, icon.props['aria-hidden'], icon.props.width], ['svg', 'true', 24]);
    assert.equal(elements(IconButton({ icon: 'close', label: 'Close', size: 'compact' }))[1].props.width, 20);
});

test('a switch is a checkbox with the switch role and a name', () => {
    const changes = [];
    const [input] = elements(Switch({ checked: true, label: 'Listen in this browser', onChange: (next) => changes.push(next) }));
    assert.deepEqual(
        [input.type, input.props.type, input.props.role, input.props.class, input.props.checked, input.props['aria-label']],
        ['input', 'checkbox', 'switch', 'kit-switch', true, 'Listen in this browser'],
    );
    input.props.onChange({ currentTarget: { checked: false } });
    assert.deepEqual(changes, [false]);
    assert.equal(elements(Switch({ checked: false, labelledBy: 'title', onChange: () => {} }))[0].props['aria-labelledby'], 'title');
});

test('messages: a status line by tone, and a banner with one action', () => {
    const roles = (tone) => elements(InlineStatus({ tone, children: 'Copied.' }))[0].props;
    assert.deepEqual([roles('error').role, roles('error').class], ['alert', 'kit-status kit-status-error']);
    assert.deepEqual([roles('success').role, roles(undefined).class], ['status', 'kit-status kit-status-neutral']);
    assert.equal(elements(InlineStatus({ children: 'Reading.' })).filter((element) => element.type === 'svg').length, 0, 'a neutral line has no icon');
    assert.equal(elements(InlineStatus({ tone: 'warning', children: 'Waiting.' })).filter((element) => element.type === 'svg').length, 1);

    let runs = 0;
    const banner = elements(Banner({ tone: 'error', action: { label: 'Retry', run: () => runs++ }, children: 'The stream stopped.' }));
    assert.deepEqual([banner[0].props.class, banner[0].props.role], ['kit-banner kit-banner-error', 'alert']);
    const action = banner.find((element) => element.type === 'button');
    assert.equal(action.props.class, 'kit-button kit-button-compact');
    action.props.onClick({});
    assert.equal(runs, 1);
    assert.equal(elements(Banner({ children: 'Asleep.' })).filter((element) => element.type === 'button').length, 0);
    assert.deepEqual(classes(Banner({ children: 'Asleep.' })).slice(0, 1), ['kit-banner']);
});

test('the sheet parts have the kit class names and no other look', () => {
    const row = { title: 'Restart video', description: 'Use this when the picture is frozen.', children: 'control' };
    assert.deepEqual(classes(SheetRow(row)), ['kit-row', 'kit-row-text', 'kit-row-title', 'kit-row-desc', 'kit-row-control']);
    assert.equal(classes(SheetRow({ ...row, layout: 'stack' }))[0], 'kit-row kit-row-stack');
    assert.equal(classes(SheetRow({ ...row, layout: 'pair' }))[0], 'kit-row kit-row-pair');
    assert.equal(elements(SheetRow({ ...row, attributes: { 'data-audio-state': 'muted' } }))[0].props['data-audio-state'], 'muted');
    // A kit prop left in a caller would change nothing; the parts do not read one.
    assert.deepEqual(classes(SheetRow({ ...row, kit: false })), classes(SheetRow(row)));

    assert.deepEqual(classes(SheetStatus({ tone: 'error', children: 'Failed.' })), ['kit-status kit-status-error', 'kit-icon']);
    assert.deepEqual(classes(SheetStatus({ children: 'Reading.' })), ['kit-status kit-status-neutral']);

    assert.deepEqual(classes(SheetMessageRow({ tone: 'info', children: 'An older list is still active.' })).slice(0, 2), ['kit-row kit-row-stack', 'kit-banner kit-banner-info']);
    // The actions that end a sheet are in the footer of Sheet; the sheet parts have no footer of their own.
    assert.equal(SheetControls.SheetFooter, undefined);
});

/** The declarations of the rules of a stylesheet whose selector is exactly `selector`, inside `media` if given. */
function rule(file, selector, media) {
    let css = fs.readFileSync(path.join(__dirname, '../src/style', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (media) {
        const at = css.indexOf(`@media ${media}`);
        assert.notEqual(at, -1, `${file} has @media ${media}`);
        css = css.slice(at);
    }
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(match, `${file} has a rule for ${selector}`);
    return match[1];
}

test('a long press on a kit button, a link among them, selects nothing on a touch screen', () => {
    for (const [file, selector] of [['kit/Button.css', '.kit-button'], ['kit/IconButton.css', '.kit-icon-button']]) {
        const declarations = rule(file, selector, '(hover: none) and (pointer: coarse)');
        assert.match(declarations, /(^|\s)user-select: none;/, `${selector} sets user-select`);
        assert.match(declarations, /-webkit-touch-callout: none;/, `${selector} brings up no callout`);
    }
});

test('a select at the end of a row does not shrink under the width of its options', () => {
    const control = rule('kit/Group.css', '.kit-row-control-select');
    // A flex item's automatic minimum is its content, clamped by its maximum: the options, up to 70% of the row.
    assert.match(control, /min-width: auto;/, 'the control does not shrink under its content');
    assert.match(control, /max-width: 70%;/, 'unless its content would crowd the text out');
    const select = rule('kit/Group.css', '.kit-row-control-select > .kit-select > .kit-field');
    assert.match(select, /(^|\s)width: auto;/, 'the content of the control is the select at the width of its options');
    assert.match(select, /min-width: 100%;/, 'which fills the control where there is room');
});

test('the unread count of Notifications is words in the status line of the bar, not a badge without an icon', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/app/views/NotificationHistory.tsx'), 'utf8');
    const count = /export function UnreadCount[\s\S]*?\n}\n/.exec(source)?.[0] || '';
    assert.match(count, /<span class="notification-unread-line">[\s\S]*<span class="notification-unread-count">\{text\}<\/span> unread/);
    assert.doesNotMatch(count, /kit-badge/, 'no red count on its own in the bar');
    assert.match(count, /badgeText\(count\)/, 'the words of the count are the kit badge\'s');
    const view = fs.readFileSync(path.join(__dirname, '../src/app/views/NotificationsView.tsx'), 'utf8');
    assert.equal((view.match(/<UnreadCount /g) || []).length, 2, 'one iPhone and All iPhones each say their count');
    assert.match(view, /\{shown\.name\} · \{FEED_LABELS\[feed\]\}\s*<\/AppBarStatus>\s*<UnreadCount /, 'after the status line, on its line');
    assert.match(rule('kit/Badge.css', '.kit-badge-inline'), /position: static;/);
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../src/style/app.css'), 'utf8'), /notification-unread-count/, 'app.css has no badge of its own');
});
