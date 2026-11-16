// Run with: node --test scripts/test-theme.js
// The theme without a browser. The choice (src/app/state/theme.ts) is System until this browser
// chooses, is kept and read back, follows another tab, and with storage blocked stays System
// without a fault. The dark tokens of src/style/tokens.css are the same for a dark system and for
// Dark chosen. src/public/theme.js, which applies the choice before the first paint, does what
// the app does, with the same key and colours, and index.html loads it before the styles. No
// browser or phone is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const KEY = 'ws-scrcpy.theme';
const STATE = require.resolve('../src/app/state/theme');

/** This browser's storage, or one that refuses every access, as Safari's private browsing does. */
function storage({ blocked = false, values = {} } = {}) {
    const kept = new Map(Object.entries(values));
    const refuse = () => {
        throw new Error('The operation is insecure.');
    };
    return blocked
        ? { kept, store: { getItem: refuse, setItem: refuse, removeItem: refuse } }
        : {
              kept,
              store: {
                  getItem: (key) => (kept.has(key) ? kept.get(key) : null),
                  setItem: (key, value) => kept.set(key, String(value)),
                  removeItem: (key) => kept.delete(key),
              },
          };
}

/**
 * The head of src/public/index.html as a page has it: the root element and the colour metas, with
 * just enough of the DOM for the two scripts. `snapshot()` is everything they may change.
 */
function page() {
    const element = (attributes) => ({
        attributes: { ...attributes },
        getAttribute(name) {
            return name in this.attributes ? this.attributes[name] : null;
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        removeAttribute(name) {
            delete this.attributes[name];
        },
    });
    const metas = Array.from(read('src/public/index.html').matchAll(/<meta\s+([^>]*)>/g), (match) =>
        element(Object.fromEntries(Array.from(match[1].matchAll(/([\w-]+)="([^"]*)"/g), (pair) => [pair[1], pair[2]]))),
    );
    const listeners = new Map();
    return {
        documentElement: element({ lang: 'en' }),
        metas,
        listeners,
        querySelectorAll(selector) {
            const name = /^meta\[name="([\w-]+)"\]$/.exec(selector);
            assert.ok(name, `a selector the page fixture knows: ${selector}`);
            return metas.filter((meta) => meta.getAttribute('name') === name[1]);
        },
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        snapshot() {
            return { root: this.documentElement.attributes, metas: metas.map((meta) => meta.attributes) };
        },
    };
}

/** The state module as a new page loads it, with what the browser has kept. */
function load(store) {
    const doc = page();
    global.localStorage = store;
    global.document = doc;
    global.window = { addEventListener: (type, listener) => doc.addEventListener(type, listener), localStorage: store };
    delete require.cache[STATE];
    return { state: require(STATE), doc };
}

/** src/public/theme.js run in the head of a new page. */
function boot(store) {
    const doc = page();
    const window = { localStorage: store };
    if (!store) {
        Object.defineProperty(window, 'localStorage', {
            get() {
                throw new Error('The operation is insecure.');
            },
        });
    }
    vm.runInNewContext(read('src/public/theme.js'), { window, document: doc });
    return doc;
}

/** The declarations of one block of tokens.css that `opening` starts, by name. */
function block(css, opening) {
    const start = css.indexOf(opening);
    assert.notEqual(start, -1, `tokens.css has ${opening}`);
    const body = css.slice(start + opening.length, css.indexOf('}', start));
    return Object.fromEntries(Array.from(body.matchAll(/([\w-]+):\s*([^;]+);/g), (match) => [match[1], match[2].trim()]));
}
const TOKENS = read('src/style/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
const LIGHT = block(TOKENS, ':root {');
const SYSTEM_DARK = block(TOKENS, "@media (prefers-color-scheme: dark) {\n    :root:not([data-theme='light']) {");
const CHOSEN_DARK = block(TOKENS, ":root[data-theme='dark'] {");

test('the theme is System until this browser chooses, is kept, and is read back on the next load', () => {
    const { store, kept } = storage();
    let { state, doc } = load(store);
    assert.equal(state.THEME_KEY, KEY);
    assert.deepEqual(state.THEME_CHOICES, ['system', 'light', 'dark']);
    assert.equal(state.theme.value, 'system', 'System by default');
    assert.equal(doc.documentElement.getAttribute('data-theme'), null, 'no attribute for System');
    for (const choice of ['dark', 'light']) {
        state.setTheme(choice);
        assert.equal(state.theme.value, choice, `${choice} at once`);
        assert.equal(doc.documentElement.getAttribute('data-theme'), choice, `${choice} on the root at once`);
        assert.equal(kept.get(KEY), choice, `${choice} kept in this browser`);
        ({ state, doc } = load(store));
        assert.equal(state.theme.value, choice, `${choice} read back`);
        assert.equal(doc.documentElement.getAttribute('data-theme'), choice, `${choice} applied on load without the boot script`);
    }
    state.setTheme('system');
    assert.equal(state.theme.value, 'system');
    assert.equal(doc.documentElement.getAttribute('data-theme'), null);
    assert.equal(kept.has(KEY), false, 'System leaves nothing behind');
    assert.equal(load(store).state.theme.value, 'system');
    for (const value of ['system', 'Dark', 'LIGHT', '', ' dark', 'blue']) {
        assert.equal(load(storage({ values: { [KEY]: value } }).store).state.theme.value, 'system', `"${value}" is System`);
    }
});

test('with storage blocked the page follows the system, a choice still applies to it, and nothing throws', () => {
    const { store } = storage({ blocked: true });
    const { state, doc } = load(store);
    assert.equal(state.theme.value, 'system');
    assert.equal(doc.documentElement.getAttribute('data-theme'), null);
    state.setTheme('dark');
    assert.equal(state.theme.value, 'dark');
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark', 'this page takes the choice');
    state.setTheme('system');
    assert.equal(doc.documentElement.getAttribute('data-theme'), null);
    assert.deepEqual(boot(undefined).snapshot(), page().snapshot(), 'the boot script changes nothing when storage throws');
    assert.deepEqual(boot(store).snapshot(), page().snapshot(), 'nor when every read throws');
});

test('a choice made in another tab applies at once', () => {
    const { store, kept } = storage();
    const { state, doc } = load(store);
    const changed = doc.listeners.get('storage');
    assert.equal(typeof changed, 'function', 'the page listens for changes to storage');
    kept.set(KEY, 'dark');
    changed({ key: KEY });
    assert.equal(state.theme.value, 'dark');
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
    changed({ key: 'ws-scrcpy.screen.show-touches' });
    assert.equal(state.theme.value, 'dark', 'another key changes nothing');
    kept.clear();
    changed({ key: null });
    assert.equal(state.theme.value, 'system', 'storage cleared elsewhere is System');
    assert.equal(doc.documentElement.getAttribute('data-theme'), null);
});

test('the boot script does what the app does, for every stored value', () => {
    const { applyTheme, storedTheme } = load(storage().store).state;
    for (const value of [undefined, 'system', 'light', 'dark', 'Dark', '', 'blue']) {
        const values = value === undefined ? {} : { [KEY]: value };
        const booted = boot(storage({ values }).store).snapshot();
        const app = page();
        applyTheme(storedTheme(value ?? null), app);
        assert.deepEqual(booted, app.snapshot(), `stored ${JSON.stringify(value)}`);
    }
    // What each choice puts on the page, as the browser reads it.
    const applied = (choice) => {
        const doc = page();
        applyTheme(choice, doc);
        const bars = doc.metas.filter((meta) => meta.getAttribute('name') === 'theme-color');
        return {
            theme: doc.documentElement.getAttribute('data-theme'),
            scheme: doc.metas.find((meta) => meta.getAttribute('name') === 'color-scheme').getAttribute('content'),
            bars: bars.map((meta) => [meta.getAttribute('media'), meta.getAttribute('content')]),
        };
    };
    const media = (scheme) => `(prefers-color-scheme: ${scheme})`;
    assert.deepEqual(applied('system'), { theme: null, scheme: 'light dark', bars: [[media('light'), '#f5f6f8'], [media('dark'), '#17191d']] });
    assert.deepEqual(applied('light'), { theme: 'light', scheme: 'light', bars: [[media('light'), '#f5f6f8'], [media('dark'), '#f5f6f8']] });
    assert.deepEqual(applied('dark'), { theme: 'dark', scheme: 'dark', bars: [[media('light'), '#17191d'], [media('dark'), '#17191d']] });
    // And back: System after a choice is the page as index.html has it.
    const doc = page();
    applyTheme('dark', doc);
    applyTheme('system', doc);
    assert.deepEqual(doc.snapshot(), page().snapshot());
});

test('the dark tokens are the same for a dark system and for Dark chosen, and Light wins over a dark system', () => {
    assert.ok(Object.keys(CHOSEN_DARK).length >= 20, 'the dark tokens are found');
    assert.deepEqual(CHOSEN_DARK, SYSTEM_DARK, 'one set of dark values, written twice');
    assert.equal(SYSTEM_DARK['color-scheme'], 'dark', 'the browser draws its own parts dark');
    assert.equal(LIGHT['color-scheme'], 'light');
    for (const name of Object.keys(SYSTEM_DARK)) {
        assert.ok(name in LIGHT, `${name} has a light value`);
    }
    // The two blocks are the only dark ones, their conditions are these, and they come after
    // every light value.
    assert.deepEqual(TOKENS.match(/prefers-color-scheme[^)]*\)/g), ['prefers-color-scheme: dark)']);
    assert.deepEqual(TOKENS.match(/data-theme[^\]]*\]/g), ["data-theme='light']", "data-theme='dark']"]);
    assert.ok(TOKENS.indexOf(":root[data-theme='dark']") > TOKENS.indexOf('@media (prefers-color-scheme: dark)'));
    assert.ok(TOKENS.indexOf('@media (prefers-color-scheme: dark)') > TOKENS.lastIndexOf('--press-transform'));
});

test("nothing else follows the system's theme by itself", () => {
    // A rule or a script that reads the system's theme would ignore the choice. Everything that
    // depends on the theme reads the tokens.
    const found = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (/\.(css|tsx?|js|html)$/.test(entry.name) && /prefers-color-scheme|light-dark\(/.test(read(file))) found.push(file);
        }
    };
    walk('src');
    assert.deepEqual(found.sort(), ['src/public/index.html', 'src/style/tokens.css']);
});

test('the bar colours are the page background of each theme, in all four places', () => {
    const { THEME_COLOURS } = load(storage().store).state;
    assert.deepEqual(THEME_COLOURS, { light: LIGHT['--surface'], dark: CHOSEN_DARK['--surface'] });
    const bars = page().metas.filter((meta) => meta.getAttribute('name') === 'theme-color');
    assert.deepEqual(
        bars.map((meta) => [meta.getAttribute('media'), meta.getAttribute('content')]),
        [['(prefers-color-scheme: light)', THEME_COLOURS.light], ['(prefers-color-scheme: dark)', THEME_COLOURS.dark]],
    );
    for (const choice of ['light', 'dark']) {
        const doc = boot(storage({ values: { [KEY]: choice } }).store);
        assert.ok(doc.metas.filter((meta) => meta.getAttribute('name') === 'theme-color').every((meta) => meta.getAttribute('content') === THEME_COLOURS[choice]), choice);
    }
});

test('index.html runs the boot script in its head before any style, and the build copies it', () => {
    const html = read('src/public/index.html');
    const head = html.slice(0, html.indexOf('</head>'));
    const script = /<script src="theme\.js\?<%= compilation\.hash %>"><\/script>/.exec(head);
    assert.ok(script, 'a script of the same origin, with the build hash, in the head');
    assert.ok(script.index > head.lastIndexOf('<meta name="theme-color"'), 'after the metas it changes');
    assert.equal(/<link[^>]+stylesheet|<style/.test(head.slice(0, script.index)), false, 'before any style');
    assert.equal(/\basync\b|\bdefer\b|type="module"/.test(script[0]), false, 'it runs before the page goes on');
    // The client build and the browser checks' build both copy it next to index.html.
    const config = read('webpack/ws-scrcpy.common.ts');
    assert.equal(config.match(/'src\/public\/theme\.js'\), to: /g)?.length, 2);
});
