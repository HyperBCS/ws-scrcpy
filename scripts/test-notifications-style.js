// Run with: node --test scripts/test-notifications-style.js
// The Notifications page takes its controls from the kit, so its stylesheets place parts and
// set text, and select by class only. A rule such as `.notifications-page button` restyles every
// button on the page at once, the toast's and the confirm prompt's included; this test keeps
// such rules out. scripts/test-style-rules.js holds the same files to the tokens, and the
// kitControls case of scripts/e2e-notifications.js measures the page in a browser.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const STYLES = ['NotificationsPage.css', 'NotificationsInbox.css', 'NotificationsSetup.css'].map((name) => `src/style/views/${name}`);
const VIEWS = ['NotificationsView.tsx', 'NotificationHistory.tsx', 'NotificationCard.tsx', 'NotificationMedia.tsx', 'NotificationActionSheet.tsx'].map((name) => `src/app/views/${name}`);

/** The selectors of a stylesheet, each with the line it starts on. At-rules are left out. */
function selectors(source) {
    const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
    const found = [];
    let buffer = '', line = 1, start = 1;
    for (const character of text) {
        if (character === '\n') line++;
        if (character === '{') {
            const prelude = buffer.trim().replace(/\s+/g, ' ');
            if (prelude && !prelude.startsWith('@')) found.push({ selector: prelude, line: start });
            buffer = '';
        } else if (character === '}' || character === ';') {
            buffer = '';
        } else {
            if (!buffer.trim()) start = line;
            buffer += character;
        }
    }
    return found;
}

/** The elements a selector names by tag: `p` in `.card p`, and not `button` in `.kit-button`. */
function tags(selector) {
    const bare = selector.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"|'[^']*'/g, '');
    return [...bare.matchAll(/(?<![\w.#:-])[a-z][a-z0-9]*(?![\w(-])/gi)].map((match) => match[0].toLowerCase());
}

test('the reader finds the elements a selector names by tag', () => {
    assert.deepEqual(tags('.notifications-page button:where(:not(.toast-close))'), ['button']);
    assert.deepEqual(tags('.notification-details > summary::before'), ['summary']);
    assert.deepEqual(tags('.notifications-page input:not([type="checkbox"]), .notifications-page select'), ['input', 'select']);
    assert.deepEqual(tags('.notification-actions > .kit-button:focus-visible'), []);
    assert.deepEqual(tags('.swipe-read .notification-swipe-reveal'), []);
    assert.deepEqual(selectors('@layer views {\n/* p { } */\n.a,\n.b p { color: red; }\n@media (max-width: 599px) { .c { margin: 0 } }\n}').map((rule) => [rule.selector, rule.line]), [['.a, .b p', 3], ['.c', 5]]);
});

test('the page has a page, an inbox and a setup stylesheet, and the two older ones are gone', () => {
    for (const file of STYLES) assert.ok(fs.existsSync(path.join(root, file)), `${file} exists`);
    for (const file of ['src/style/views/Notifications.css', 'src/style/views/NotificationActionSheet.css']) {
        assert.equal(fs.existsSync(path.join(root, file)), false, `${file} is deleted`);
    }
    const imports = VIEWS.map(read).join('\n');
    for (const file of STYLES) assert.ok(imports.includes(path.basename(file)), `${file} is imported by a view of the page`);
});

test('no rule of the page selects an element by its tag', () => {
    const found = STYLES.flatMap((file) => selectors(read(file)).flatMap((rule) => (tags(rule.selector).length ? [`${file}:${rule.line} ${rule.selector}`] : [])));
    assert.deepEqual(found, [], 'Give the element a class, or use the kit part that already has one.');
    const rules = STYLES.reduce((total, file) => total + selectors(read(file)).length, 0);
    assert.ok(rules > 80, `the stylesheets are read (${rules} rules)`);
});

test('the older button classes and the dead disclosure marker are gone', () => {
    const sources = [...STYLES, ...VIEWS].map((file) => [file, read(file)]);
    for (const [file, source] of sources) {
        assert.doesNotMatch(source, /notification-(primary|danger|link-button|notice|check)\b/, `${file} uses no class of the older controls`);
        assert.doesNotMatch(source, /\bui-button\b|confirm-prompt|app-toast|stream-header/, `${file} names no older shared class`);
    }
    assert.doesNotMatch(read('src/style/app.css'), /\.notification-details\s*>\s*summary::before/, 'the rule that hid the old marker went with the marker');
});

test('the views draw their controls with the kit parts', () => {
    for (const file of VIEWS) {
        const source = read(file);
        // A control written out by hand has no kit class. The parts are in src/app/ui.
        assert.doesNotMatch(source, /<(button|select|textarea|input|details|dialog)\b/, `${file} writes no control by hand`);
    }
    const page = read('src/app/views/NotificationsView.tsx');
    const inbox = read('src/app/views/NotificationHistory.tsx');
    assert.match(page, /<AppBar title="Notifications">/);
    assert.match(page, /<Toast\b/);
    assert.equal((inbox.match(/<Toast\b/g) || []).length, 3, 'the three notices of the inbox are toasts');
    assert.doesNotMatch(`${page}${inbox}`, /<(AppBar|AppBarStatus|Toast)\s[^>]*\bkit\b/, 'the kit look is the only one: no part takes a kit prop');
    assert.equal((`${page}${inbox}`.match(/<ConfirmPrompt\b/g) || []).length, (`${page}${inbox}`.match(/<ConfirmPrompt\s+kit\b/g) || []).length, 'every confirm prompt is the kit one');
    assert.equal((`${page}${inbox}`.match(/<SegmentedControl\b/g) || []).length, 2, 'the page tabs and the inbox filter are one control');
    assert.match(read('src/app/views/NotificationActionSheet.tsx'), /<Sheet\b/, 'the action sheet is the shared sheet');
});
