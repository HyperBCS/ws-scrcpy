// Run with: node --test scripts/test-style-rules.js
// The rules every stylesheet under src/style keeps, read from the files without a browser.
//   Layers: a file opens with the one layer order, and each of its rules is in a layer block:
//   tokens.css in `tokens`, app.css in `base`, ui/ and kit/ in `components`, the rest in `views`.
//   Units: no font size in rem or em. The root is 16px and every length is px.
//   Tokens: outside tokens.css a colour, a font size, a radius and a z-index come from a token,
//   and nothing is `!important`. The stylesheets written before the tokens still hold such
//   values; ALLOWED records how many each file had when this test was added. A count may fall,
//   and the test fails when one rises. A file that is not listed is allowed none.
// scripts/e2e-atlas.js is the check that a change to the stylesheets cannot be seen.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const STYLE = path.join(__dirname, '../src/style');
const LAYERS = ['tokens', 'base', 'components', 'views'];
const ORDER = `@layer ${LAYERS.join(', ')};`;

// What each file may still hold. `otherLayers` counts the blocks a file has for a layer that is
// not its own: a rule kept next to the rules it belongs with, in the layer it has to act in.
const ALLOWED = {
    'app.css': { colours: 3, fontSizes: 3, radii: 1, important: 5 },
    'morebox.css': { zIndex: 1, important: 1 },
    'ui/SheetControls.css': { colours: 7, fontSizes: 10, radii: 5 },
    // The order of what lies over the picture: the controls (8) and their shield (4).
    'views/FloatingToolbar.css': { zIndex: 2 },
    // The sleep overlay, one step under the header (4).
    'views/SleepOverlay.css': { zIndex: 1 },
    // The black behind the picture, twice, and the order of the picture, its touch layer and
    // the two failure cards. The picture's own rules were not changed.
    'views/StreamView.css': { colours: 2, zIndex: 4 },
    // The black of the terminal.
    'views/ToolView.css': { colours: 1 },
};

const KINDS = {
    colours: 'colours written as values',
    fontSizes: 'font sizes written as numbers',
    radii: 'radii written as numbers',
    zIndex: 'z-index numbers',
    important: '!important declarations',
    otherLayers: "blocks for a layer that is not the file's own",
};

function styleFiles(dir = STYLE) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return styleFiles(full);
        return entry.name.endsWith('.css') ? [path.relative(STYLE, full).split(path.sep).join('/')] : [];
    }).sort();
}

function ownLayer(file) {
    if (file === 'tokens.css') return 'tokens';
    if (file === 'app.css') return 'base';
    return file.startsWith('ui/') || file.startsWith('kit/') ? 'components' : 'views';
}

/**
 * The blocks, statements and declarations of a stylesheet. Each carries the line it starts on
 * and the at-rules and rules it is inside, outermost first.
 */
function read(source) {
    // Comments become spaces, so the lines keep their numbers.
    const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
    const blocks = [], statements = [], declarations = [];
    const open = [];
    let buffer = '', bufferLine = 1, line = 1, quote = '';
    const flush = () => {
        const content = buffer.trim();
        buffer = '';
        return content;
    };
    const inside = () => open.map((block) => block.prelude);
    const holdsDeclarations = () => open.length > 0 && !/^@(layer|media|supports|container|keyframes)\b/.test(open[open.length - 1].prelude);
    const statement = () => {
        const content = flush();
        if (!content) return;
        const colon = content.indexOf(':');
        if (holdsDeclarations() && colon > 0) {
            declarations.push({ prop: content.slice(0, colon).trim().toLowerCase(), value: content.slice(colon + 1).trim(), line: bufferLine, inside: inside() });
        } else {
            statements.push({ text: content.replace(/\s+/g, ' '), line: bufferLine, inside: inside() });
        }
    };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\n') line++;
        if (!buffer.trim()) bufferLine = line;
        if (quote) {
            buffer += c;
            if (c === '\\') buffer += text[++i];
            else if (c === quote) quote = '';
        } else if (c === '"' || c === "'") {
            quote = c;
            buffer += c;
        } else if (c === '{') {
            const block = { prelude: flush().replace(/\s+/g, ' '), line: bufferLine, inside: inside() };
            blocks.push(block);
            open.push(block);
        } else if (c === ';') {
            statement();
        } else if (c === '}') {
            statement();
            open.pop();
        } else {
            buffer += c;
        }
    }
    return { blocks, statements, declarations };
}

/** What is wrong with the layers of a file, as sentences, and how many blocks it has for another layer. */
function layerFaults(file, source, parsed) {
    const faults = [];
    if (!source.startsWith(ORDER)) faults.push(`${file} does not open with "${ORDER}"`);
    for (const item of parsed.statements) {
        if (item.inside.length) continue;
        if (item.text !== ORDER.slice(0, -1) && !item.text.startsWith('@import ')) faults.push(`${file}:${item.line} has "${item.text}" outside a layer`);
    }
    let otherLayers = 0;
    for (const block of parsed.blocks) {
        const layer = /^@layer\s+(\S+)$/.exec(block.prelude);
        if (!block.inside.length && !layer) faults.push(`${file}:${block.line} has the rule "${block.prelude}" outside a layer`);
        if (!layer) continue;
        if (block.inside.length) faults.push(`${file}:${block.line} has a layer inside ${block.inside[block.inside.length - 1]}; a layer block is at the top of a file`);
        else if (!LAYERS.includes(layer[1])) faults.push(`${file}:${block.line} names the layer "${layer[1]}"; the layers are ${LAYERS.join(', ')}`);
        else if (layer[1] !== ownLayer(file)) otherLayers++;
    }
    if (!parsed.blocks.some((block) => block.prelude === `@layer ${ownLayer(file)}`)) faults.push(`${file} has no "@layer ${ownLayer(file)}" block`);
    return { faults, otherLayers };
}

// The CSS colour keywords. `transparent` and `currentColor` are not raw colours.
const NAMED_COLOURS = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
    blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan
    darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen
    darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
    darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
    forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink
    indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral
    lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
    lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta
    maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
    mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite
    navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise
    palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown
    royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray
    slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke
    yellow yellowgreen`.split(/\s+/);
const COLOUR = new RegExp(`#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\(|(?<![\\w-])(?:${NAMED_COLOURS.join('|')})(?![\\w(-])`, 'i');
const LENGTH = /(?:^|[\s,(/])-?(?:\d+\.?\d*|\.\d+)(?:[a-z]+|%)/i;
const fontSizeOf = (declaration) => {
    if (declaration.prop === 'font-size') return declaration.value;
    // In the shorthand the size is the length before the line height or the family.
    if (declaration.prop === 'font') return (LENGTH.exec(declaration.value) || [''])[0];
    return '';
};

/** How many values of each kind a file writes out, and its font sizes in rem or em. */
function count(parsed) {
    const counts = { colours: 0, fontSizes: 0, radii: 0, zIndex: 0, important: 0 };
    const relativeSizes = [];
    for (const declaration of parsed.declarations) {
        // What a url() holds is a picture, not a value of the page.
        const value = declaration.value.replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, 'url()');
        if (/!\s*important/i.test(value)) counts.important++;
        // A name in quotes is text or an area name, not a colour.
        if (COLOUR.test(value.replace(/"[^"]*"|'[^']*'/g, "''"))) counts.colours++;
        if (declaration.prop === 'z-index' && /^-?\d+/.test(value)) counts.zIndex++;
        if (/^border(-[a-z]+)*-radius$/.test(declaration.prop) && LENGTH.test(value)) counts.radii++;
        const size = fontSizeOf({ ...declaration, value });
        if (LENGTH.test(size)) counts.fontSizes++;
        if (/\d(?:rem|em)\b/i.test(size)) relativeSizes.push(`line ${declaration.line}: ${declaration.prop}: ${declaration.value}`);
    }
    return { counts, relativeSizes };
}

const files = styleFiles();
const sheets = new Map(files.map((file) => {
    const source = fs.readFileSync(path.join(STYLE, file), 'utf8');
    return [file, { source, parsed: read(source) }];
}));

test('the reader finds the rules, the layers and the values of a stylesheet', () => {
    const parsed = read(`${ORDER}\n@import './x.css';\n/* a { color: red } */\n@layer views {\n.a,\n.b > c { color: #fff; font: 600 12.6px/1 var(--font-stack); border-radius: var(--radius-sm) }\n@media (min-width: 600px) { .a::before { content: '{;}'; z-index: 3; margin: 0 !important } }\n}\n.loose { font-size: 0.9rem; background: url("data:image/svg+xml,%3Csvg fill='%23000'/%3E") }\n`);
    assert.deepEqual(parsed.statements.map((item) => item.text), [ORDER.slice(0, -1), "@import './x.css'"]);
    assert.deepEqual(parsed.blocks.map((block) => block.prelude), ['@layer views', '.a, .b > c', '@media (min-width: 600px)', '.a::before', '.loose']);
    assert.deepEqual(parsed.declarations.map((item) => item.prop), ['color', 'font', 'border-radius', 'content', 'z-index', 'margin', 'font-size', 'background']);
    assert.deepEqual(parsed.blocks[3].inside, ['@layer views', '@media (min-width: 600px)']);
    assert.equal(parsed.blocks[4].line, 9);
    const { counts, relativeSizes } = count(parsed);
    assert.deepEqual(counts, { colours: 1, fontSizes: 2, radii: 0, zIndex: 1, important: 1 });
    assert.deepEqual(relativeSizes, ['line 9: font-size: 0.9rem']);
    const { faults, otherLayers } = layerFaults('views/Example.css', `${ORDER}\n`, parsed);
    assert.deepEqual(faults, ['views/Example.css:9 has the rule ".loose" outside a layer']);
    assert.equal(otherLayers, 0);
    assert.equal(layerFaults('ui/Example.css', `${ORDER}\n`, parsed).otherLayers, 1);
});

test('a colour written by its name counts, and a word that only holds one does not', () => {
    const colours = (css) => count(read(`${ORDER}\n@layer views {\n${css}\n}\n`)).counts.colours;
    assert.equal(colours('.a { color: red; }'), 1);
    assert.equal(colours('.a { border: 1px solid RebeccaPurple; }'), 1);
    assert.equal(colours('.a { box-shadow: 0 0 0 2px var(--ring, navy); }'), 1);
    assert.equal(colours('.a { background: white; }'), 1);
    assert.equal(colours('.a { color: var(--status-red-text); white-space: nowrap; animation: tan-in 1s; }'), 0);
    assert.equal(colours(".a { content: 'red'; grid-template-areas: 'gold teal'; color: currentColor; }"), 0);
    assert.equal(colours('.a { background: transparent; rotate: calc(tan(1) * 1deg); }'), 0);
});

test('every stylesheet opens with the layer order and keeps each rule in a layer', () => {
    assert.ok(files.length > 20, 'the stylesheets are found');
    const faults = files.flatMap((file) => layerFaults(file, sheets.get(file).source, sheets.get(file).parsed).faults);
    assert.deepEqual(faults, []);
});

test('no font size is in rem or em', () => {
    const found = files.flatMap((file) => count(sheets.get(file).parsed).relativeSizes.map((entry) => `${file} ${entry}`));
    assert.deepEqual(found, [], 'Write the size in px, or with a size token from tokens.css.');
});

test('no file holds more values written out, or more !important, than it did', () => {
    const over = [];
    for (const file of files) {
        const { parsed, source } = sheets.get(file);
        const actual = { ...count(parsed).counts, otherLayers: layerFaults(file, source, parsed).otherLayers };
        // The token file is where the values are written. Its layer is still checked.
        if (file === 'tokens.css') continue;
        const allowed = ALLOWED[file] || {};
        for (const kind of Object.keys(KINDS)) {
            if (actual[kind] > (allowed[kind] || 0)) over.push(`${file} has ${actual[kind]} ${KINDS[kind]}; the list allows ${allowed[kind] || 0}`);
        }
    }
    assert.deepEqual(over, [], 'Use a token from src/style/tokens.css. ALLOWED in this file only records what the older stylesheets held.');
});
