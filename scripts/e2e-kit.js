// E2E_OUT=/tmp/ws-scrcpy-kit node scripts/test-browser.js kit
// The shared controls on the kit page (#!action=kit, src/app/views/KitPage.tsx), in both themes
// at 390x844 (touch) and 1440x900 (mouse). What is measured comes from the browser:
//   sizes     every button and field is 44px high, and 32px for the compact size under a mouse
//   type      every font size is 12, 13, 15, 17, 20 or 24, and 16 in a field
//   radii     every radius is one of the four tokens
//   colours   every colour is a role token, and one accent marks primary actions and what is on
//   contrast  text is 4.5:1 on what is behind it; the edge of a field and of a switch is 3:1
//   keyboard  each control shows the token's focus ring; Switch and SegmentedControl answer to
//             the keyboard and expose their state
//   names     an icon button without a label is refused
//   layout    the page does not scroll sideways
// Screenshots go to E2E_OUT. The page needs no phone: every socket is left unanswered.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { settleMotion } = require('./ui-motion');

// Only through test-browser.js, which serves the build on a port of its own.
if (!process.env.BASE) {
    console.error('Run this suite as: node scripts/test-browser.js kit');
    process.exit(1);
}
const BASE = process.env.BASE;
const OUT = process.env.E2E_OUT || '/tmp/ws-scrcpy-kit';
const VIEWPORTS = [
    { name: 'phone', width: 390, height: 844, mobile: true },
    { name: 'desktop', width: 1440, height: 900, mobile: false },
];
const THEMES = ['light', 'dark'];
// The role tokens that are colours. Nothing on the kit page may show any other colour.
const COLOUR_TOKENS = [
    'surface', 'surface-raised', 'surface-sunken', 'surface-inverse', 'border', 'border-strong', 'text', 'text-muted',
    'accent', 'accent-text', 'accent-soft', 'accent-pressed', 'on-accent', 'on-inverse', 'danger-text', 'danger-fill',
    'success-text', 'success-fill', 'warning-text', 'warning-fill', 'info-text', 'info-fill', 'neutral-text', 'neutral-fill',
];
// The kinds of control the focus walk must meet.
const FOCUS_KINDS = [
    'kit-button', 'kit-icon-button', 'input.kit-field', 'select.kit-field', 'textarea.kit-field', 'kit-range', 'kit-switch',
    'kit-segment', 'kit-tab', 'kit-bar-back', 'kit-bar-title', 'kit-disclosure',
];

/** Everything that can be read off the page at rest, as a list of faults. */
function audit({ mobile, tokens }) {
    const faults = [];
    const page = document.querySelector('.kit-page');
    const name = (element) => {
        const demo = element.closest('[data-kit-demo]')?.getAttribute('data-kit-demo');
        const section = element.closest('[data-kit-section]')?.getAttribute('data-kit-section');
        const text = (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 30);
        return `${section || '?'} / ${demo || '?'} / ${element.tagName.toLowerCase()}.${String(element.getAttribute('class') || '').split(' ')[0]} "${text}"`;
    };
    const probe = document.createElement('span');
    // With motion reduced every property still has a transition, of 0.01ms. Not this one.
    probe.style.transition = 'none';
    page.append(probe);
    const resolved = {};
    for (const token of tokens) {
        probe.style.color = `var(--${token})`;
        resolved[token] = getComputedStyle(probe).color;
    }
    probe.remove();
    const allowed = new Set(Object.values(resolved));
    const parse = (colour) => {
        const match = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(colour);
        return match ? { r: +match[1], g: +match[2], b: +match[3], a: match[4] === undefined ? 1 : +match[4] } : undefined;
    };
    const luminance = ({ r, g, b }) => {
        const channel = (value) => (value / 255 <= 0.03928 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const contrast = (first, second) => {
        const [high, low] = [luminance(parse(first)), luminance(parse(second))].sort((a, b) => b - a);
        return (high + 0.05) / (low + 0.05);
    };
    /** The colour behind an element: the nearest fill that is not transparent. */
    const behind = (element) => {
        for (let node = element; node; node = node.parentElement) {
            // The text of a segment lies over the radio button that draws the chosen fill.
            const under = node.matches('.kit-segment > span') ? [node.previousElementSibling, node] : [node];
            for (const layer of under) {
                const fill = parse(getComputedStyle(layer).backgroundColor);
                if (fill && fill.a === 1) return getComputedStyle(layer).backgroundColor;
                if (fill && fill.a > 0) faults.push(`a fill that is neither solid nor clear: ${name(layer)}`);
            }
        }
        return getComputedStyle(document.body).backgroundColor;
    };
    const dimmed = (element) => {
        for (let node = element; node && node !== page.parentElement; node = node.parentElement) {
            if (node.matches(':disabled, [aria-disabled="true"]') || Number(getComputedStyle(node).opacity) < 1) return true;
        }
        return false;
    };
    // A sheet that is closed is not drawn; e2e-kit-sheet.js measures the open ones.
    const all = (selector) => [...page.querySelectorAll(selector)].filter((element) => !element.closest('dialog:not([open])'));
    const elements = all('*').filter((element) => !element.closest('svg') || element.tagName === 'svg');

    // Sizes.
    const coarse = matchMedia('(pointer: coarse)').matches;
    if (coarse !== mobile) faults.push(`(pointer: coarse) is ${coarse} in a ${mobile ? 'touch' : 'mouse'} context`);
    const height = (element) => Math.round(element.getBoundingClientRect().height * 100) / 100;
    for (const element of all('.kit-button, .kit-icon-button')) {
        const compact = element.matches('.kit-button-compact, .kit-icon-button-compact');
        const expected = compact && !mobile ? 32 : 44;
        if (height(element) !== expected) faults.push(`${height(element)}px high, not ${expected}px: ${name(element)}`);
        if (element.matches('.kit-icon-button') && element.getBoundingClientRect().width !== expected) faults.push(`not square: ${name(element)}`);
    }
    for (const element of all('input.kit-field, select.kit-field, .kit-tab, .kit-bar-back, .kit-segment, .kit-range, .kit-toast-close, .kit-toast-action')) {
        if (height(element) !== 44) faults.push(`${height(element)}px high, not 44px: ${name(element)}`);
    }
    for (const element of all('textarea.kit-field, .kit-row, .kit-disclosure > summary, .kit-bar-title')) {
        if (height(element) < 44) faults.push(`${height(element)}px high, under 44px: ${name(element)}`);
    }
    for (const element of all('.kit-switch')) {
        const target = parseFloat(getComputedStyle(element, '::after').height);
        if (target !== 44) faults.push(`a ${target}px target, not 44px: ${name(element)}`);
    }

    // Type, radii and colours, element by element.
    const SIZES = ['12px', '13px', '15px', '17px', '20px', '24px'];
    const RADII = ['0px', resolvedLength('--radius-sm'), resolvedLength('--radius-md'), resolvedLength('--radius-lg'), resolvedLength('--radius-full')];
    function resolvedLength(property) {
        return getComputedStyle(document.documentElement).getPropertyValue(property).trim();
    }
    const colourOf = (style, property, where) => {
        const value = style[property];
        const colour = parse(value);
        if (!colour) faults.push(`${property} ${value} cannot be read: ${where}`);
        else if (colour.a !== 0 && !allowed.has(value)) faults.push(`${property} ${value} is not a role token: ${where}`);
    };
    for (const element of elements) {
        // The browser draws the options of a select; they take the field's type and colours.
        if (element.tagName === 'OPTION') continue;
        const field = element.matches('input.kit-field, select.kit-field, textarea.kit-field');
        const hasText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
        for (const pseudo of [undefined, '::before', '::after']) {
            const style = getComputedStyle(element, pseudo);
            if (pseudo && (style.content === 'none' || style.content === 'normal')) continue;
            const where = `${name(element)}${pseudo || ''}`;
            for (const corner of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']) {
                if (!RADII.includes(style[corner])) faults.push(`${corner} ${style[corner]} is not a radius token: ${where}`);
            }
            // `color` shows only as text and as the stroke of an icon.
            if (!pseudo && (field || hasText || element.tagName === 'svg')) colourOf(style, 'color', where);
            colourOf(style, 'backgroundColor', where);
            for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
                if (parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none') colourOf(style, `border${side}Color`, where);
            }
        }
        if (!field && !hasText) continue;
        const style = getComputedStyle(element);
        if (field ? style.fontSize !== '16px' : !SIZES.includes(style.fontSize)) faults.push(`font size ${style.fontSize}: ${name(element)}`);
        if (dimmed(element)) continue;
        const ratio = contrast(style.color, behind(element));
        if (ratio < 4.5) faults.push(`text contrast ${ratio.toFixed(2)}:1 (${style.color} on ${behind(element)}): ${name(element)}`);
        if (field) {
            const placeholder = contrast(getComputedStyle(element, '::placeholder').color, behind(element));
            if (placeholder < 4.5) faults.push(`placeholder contrast ${placeholder.toFixed(2)}:1: ${name(element)}`);
        }
    }

    // The edge that makes a field or a switch findable.
    for (const element of all('.kit-field, .kit-switch')) {
        if (dimmed(element)) continue;
        const style = getComputedStyle(element);
        const ratio = contrast(style.borderTopColor, behind(element.parentElement));
        if (ratio < 3) faults.push(`border contrast ${ratio.toFixed(2)}:1 (${style.borderTopColor} on ${behind(element.parentElement)}): ${name(element)}`);
    }

    // One accent: primary actions and everything that is on carry the same fill.
    const accentFills = new Set();
    const marked = all('.kit-button-primary, .kit-switch:checked, .kit-button[aria-pressed="true"], .kit-icon-button[aria-pressed="true"]');
    for (const element of marked) {
        const style = getComputedStyle(element);
        accentFills.add(style.backgroundColor);
        if (style.backgroundColor !== resolved.accent) faults.push(`fill ${style.backgroundColor} is not the accent: ${name(element)}`);
        if (style.borderTopColor !== resolved.accent) faults.push(`border ${style.borderTopColor} is not the accent: ${name(element)}`);
    }
    if (marked.length < 8 || accentFills.size !== 1) faults.push(`${marked.length} accent controls with ${accentFills.size} fills`);
    for (const tab of all('.kit-tab')) {
        const style = getComputedStyle(tab);
        const current = tab.getAttribute('aria-current') === 'page';
        if (style.borderBottomColor !== (current ? resolved.accent : 'rgba(0, 0, 0, 0)')) faults.push(`tab underline ${style.borderBottomColor}: ${name(tab)}`);
        if (style.color !== (current ? resolved['accent-text'] : resolved['text-muted'])) faults.push(`tab colour ${style.color}: ${name(tab)}`);
    }

    // Icons: each is one path that draws inside the 24 by 24 grid.
    const icons = all('[data-kit-icon] svg');
    if (icons.length < 50) faults.push(`${icons.length} icons shown`);
    for (const svg of icons) {
        const box = svg.querySelector('path').getBBox();
        const inside = box.x >= 0 && box.y >= 0 && box.x + box.width <= 24 && box.y + box.height <= 24 && (box.width > 4 || box.height > 4);
        if (!inside || svg.children.length !== 1) faults.push(`icon ${svg.parentElement.getAttribute('data-kit-icon')} is ${JSON.stringify([box.x, box.y, box.width, box.height])}`);
        if (svg.getAttribute('aria-hidden') !== 'true') faults.push(`icon ${svg.parentElement.getAttribute('data-kit-icon')} is not hidden from assistive technology`);
    }
    for (const svg of all('svg.kit-icon')) {
        const size = svg.getBoundingClientRect().width;
        if (![16, 20, 24].includes(size) || svg.getBoundingClientRect().height !== size) faults.push(`an icon of ${size}px: ${name(svg)}`);
    }

    // Names.
    for (const button of all('.kit-icon-button, .kit-toast-close')) {
        if (!(button.getAttribute('aria-label') || '').trim()) faults.push(`an icon button without a name: ${name(button)}`);
    }

    // Layout.
    if (page.scrollWidth > page.clientWidth) faults.push(`the page scrolls sideways: ${page.scrollWidth}px in ${page.clientWidth}px`);
    if (document.documentElement.scrollWidth > innerWidth) faults.push('the document scrolls sideways');
    for (const element of elements) {
        const box = element.getBoundingClientRect();
        if (box.width && box.right > innerWidth + 0.5 && !element.closest('.kit-toast')) faults.push(`reaches ${Math.round(box.right)}px, past the ${innerWidth}px window: ${name(element)}`);
    }
    return { faults, resolved, counts: { elements: elements.length, icons: icons.length } };
}

/** What has the focus, and the ring it shows once the frame after the key press is drawn. */
async function focused() {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const element = document.activeElement;
    if (!element || element === document.body || !element.closest('.kit-page')) return null;
    const style = getComputedStyle(element);
    const kinds = ['kit-button', 'kit-icon-button', 'kit-range', 'kit-switch', 'kit-tab', 'kit-bar-back', 'kit-bar-title', 'kit-toast-action', 'kit-toast-close'];
    let kind = kinds.find((name) => element.classList.contains(name));
    if (element.classList.contains('kit-field')) kind = `${element.tagName.toLowerCase()}.kit-field`;
    if (element.matches('.kit-segment > input')) kind = 'kit-segment';
    if (element.matches('.kit-disclosure > summary')) kind = 'kit-disclosure';
    const again = element.hasAttribute('data-kit-walked');
    element.setAttribute('data-kit-walked', '');
    return {
        kind: kind || `${element.tagName.toLowerCase()}.${element.getAttribute('class')}`,
        label: (element.getAttribute('aria-label') || element.textContent || element.getAttribute('value') || '').trim().slice(0, 30),
        again,
        byKeyboard: element.matches(':focus-visible'),
        ring: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
    };
}

/** A picture of the whole page, or of the window as it stands when `whole` is false. */
async function shoot(page, viewport, name, whole = true) {
    fs.mkdirSync(OUT, { recursive: true });
    await settleMotion(page);
    // The page scrolls inside itself, so the window grows to its length for the picture.
    const height = whole ? await page.evaluate(() => document.querySelector('.kit-page').scrollHeight) : viewport.height;
    await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, height) });
    await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled' });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
}

async function run(browser, viewport, theme) {
    const label = `${viewport.name}--${theme}`;
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile,
        colorScheme: theme, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'UTC', serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/notifications/**', (route) => route.fulfill({ json: { sources: [], unread: 0, unreadBySource: {} } }));
    await page.routeWebSocket('**', () => {});
    await page.goto(`${BASE}#!action=kit`);
    const kit = page.locator('.kit-page');
    await kit.waitFor();
    // The pointer rests in a corner while styles are read, so nothing is under it.
    const rest = async () => {
        if (!viewport.mobile) await page.mouse.move(0, 0);
        await settleMotion(page);
    };
    const check = async (state) => {
        await rest();
        const result = await page.evaluate(audit, { mobile: viewport.mobile, tokens: COLOUR_TOKENS });
        assert.deepEqual(result.faults, [], `${label}, ${state}`);
        return result;
    };

    // At rest.
    const { resolved, counts } = await check('at rest');
    assert.ok(counts.elements > 400, `${label}: the kit page is drawn (${counts.elements} elements)`);
    assert.equal(new Set(Object.values(resolved)).size >= 20, true, `${label}: the role tokens resolve to colours`);
    await shoot(page, viewport, `kit--${label}`);

    // An icon button without a label is refused, and the reason is shown in its place.
    const refused = page.locator('[data-kit-demo="without a label"]');
    await assert.doesNotReject(refused.getByText(/^Refused\. The icon button "close" has no label\./).waitFor());
    assert.equal(await refused.locator('button, a').count(), 0, `${label}: nothing is drawn for an icon button without a label`);

    // Switch: a checkbox with the switch role. Space turns it, and a tap on its row turns it.
    const listen = page.getByRole('switch', { name: 'Listen in this browser', exact: true });
    assert.equal(await listen.count(), 1);
    assert.equal(await listen.isChecked(), false);
    await listen.focus();
    await page.keyboard.press('Space');
    assert.equal(await page.getByRole('switch', { name: 'Listen in this browser', exact: true, checked: true }).count(), 1, `${label}: Space turns the switch on and the state is exposed`);
    await page.keyboard.press('Space');
    assert.equal(await page.getByRole('switch', { name: 'Listen in this browser', exact: true, checked: false }).count(), 1, `${label}: Space turns it off again`);
    const rowSwitch = page.getByRole('switch', { name: 'Send this keyboard to the phone', exact: true });
    assert.equal(await rowSwitch.isChecked(), true);
    assert.equal(await rowSwitch.evaluate((element) => document.getElementById(element.getAttribute('aria-describedby')).textContent), 'Ctrl+Alt+K releases it.');
    await page.locator('.kit-row-toggle .kit-row-title').click();
    assert.equal(await rowSwitch.isChecked(), false, `${label}: the row turns its switch`);
    assert.equal(await page.getByRole('switch', { name: 'Unavailable, on', exact: true }).isDisabled(), true);

    // SegmentedControl: a radio group. The arrow keys move the choice and skip what is off.
    const quality = page.getByRole('radiogroup', { name: 'Quality', exact: true });
    const chosen = (group) => group.getByRole('radio', { checked: true }).evaluateAll((radios) => radios.map((radio) => radio.parentElement.textContent));
    assert.equal(await quality.getByRole('radio').count(), 3);
    assert.deepEqual(await chosen(quality), ['Auto']);
    await quality.getByRole('radio', { name: 'Auto', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await chosen(quality), ['High'], `${label}: the right arrow moves the choice`);
    assert.equal(await quality.getByRole('radio', { name: 'High', exact: true }).evaluate((radio) => radio === document.activeElement), true);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await chosen(quality), ['Low data'], `${label}: the choice wraps round`);
    const show = page.getByRole('radiogroup', { name: 'Show', exact: true });
    await show.getByRole('radio', { name: 'Archive', exact: true }).check();
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await chosen(show), ['All'], `${label}: an option that is off is skipped`);
    const kind = page.getByRole('radiogroup', { name: 'Kind of passcode', exact: true });
    await kind.locator('.kit-segment', { hasText: 'Password' }).click();
    assert.deepEqual(await chosen(kind), ['Password'], `${label}: a tap chooses an option`);

    // Pressed controls, tabs, the disclosure and a busy button.
    const soundButton = page.getByRole('button', { name: 'Sound', exact: true });
    assert.equal(await soundButton.getAttribute('aria-pressed'), 'false');
    assert.ok(await soundButton.locator('svg path').getAttribute('d'), `${label}: Sound has an icon`);
    await soundButton.click();
    await rest();
    assert.equal(await soundButton.getAttribute('aria-pressed'), 'true', `${label}: Sound shows that it is on`);
    assert.equal(await soundButton.evaluate((element) => getComputedStyle(element).backgroundColor), resolved.accent);
    const tabs = page.getByRole('navigation', { name: 'Phone views', exact: true });
    await tabs.getByRole('button', { name: 'Files', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await tabs.locator('[aria-current="page"]').allTextContents(), ['Files'], `${label}: Enter opens a tab`);
    const disclosure = page.locator('details.kit-disclosure');
    assert.equal(await disclosure.evaluate((details) => details.open), false);
    await disclosure.locator('summary').focus();
    await page.keyboard.press('Enter');
    await settleMotion(page);
    assert.equal(await disclosure.evaluate((details) => details.open), true, `${label}: Enter opens the disclosure`);
    await disclosure.getByText('Stream service', { exact: true }).waitFor();
    const busy = page.locator('[data-kit-demo="primary"] .kit-button[aria-busy="true"]');
    assert.equal(await busy.getAttribute('aria-disabled'), 'true');
    assert.equal(await page.locator('[data-kit-demo="link"] a.kit-button[href]').count(), 2, `${label}: a button with an address is a link`);
    const listenRow = page.locator('[data-audio-state]');
    await listenRow.getByRole('button', { name: 'Listen', exact: true }).click();
    await listenRow.getByRole('button', { name: 'Stop listening', exact: true }).waitFor();
    assert.equal(await listenRow.getAttribute('data-audio-state'), 'playing', `${label}: the Sound rows work in the kit look`);
    await check('with controls turned on');

    // The focus ring: Tab through the whole page.
    await page.evaluate(() => {
        document.activeElement?.blur();
        document.querySelector('.kit-page').scrollTop = 0;
    });
    const stops = [];
    for (let step = 0; step < 400; step++) {
        await page.keyboard.press('Tab');
        const stop = await page.evaluate(focused);
        if (!stop) continue;
        if (stop.again) break;
        stops.push(stop);
    }
    const ring = `solid 2px ${resolved.accent}`;
    assert.deepEqual(stops.filter((stop) => !stop.byKeyboard || stop.ring !== ring).map((stop) => `${stop.kind} "${stop.label}": ${stop.ring}`), [], `${label}: every control shows the focus ring`);
    assert.deepEqual(FOCUS_KINDS.filter((kindName) => !stops.some((stop) => stop.kind === kindName)), [], `${label}: every kind of control was reached by Tab`);
    assert.ok(stops.length > 60, `${label}: ${stops.length} controls take the focus`);

    // Toast: the kit look, with its action and its close button, and their ring on the dark bar.
    await page.getByRole('button', { name: 'Show with Undo', exact: true }).focus();
    await page.keyboard.press('Enter');
    const toast = page.locator('.kit-toast');
    await toast.waitFor();
    await settleMotion(page);
    assert.equal(await toast.getAttribute('role'), 'status');
    assert.equal(await toast.locator('.kit-toast-message').textContent(), 'Archived.');
    assert.equal(await page.locator('.app-toast').count(), 0, `${label}: the kit toast has the kit class names only`);
    await check('with a toast');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    for (const expected of ['Undo', 'Dismiss message']) {
        await page.keyboard.press('Tab');
        const stop = await page.evaluate(focused);
        assert.equal(stop.label, expected);
        assert.equal(stop.ring, `solid 2px ${resolved['on-inverse']}`, `${label}: ${expected} shows a ring on the toast`);
    }
    await shoot(page, viewport, `kit--${label}--toast`, false);
    await page.keyboard.press('Enter');
    await toast.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Show an error', exact: true }).click();
    await toast.waitFor();
    await settleMotion(page);
    assert.equal(await toast.getAttribute('role'), 'alert');
    await check('with an error toast');
    await toast.getByRole('button', { name: 'Dismiss message', exact: true }).click();
    await toast.waitFor({ state: 'detached' });

    assert.deepEqual(errors, [], `${label}: no page error`);
    await context.close();
    console.log(`PASS ${label}: sizes, type, radii, colours, contrast, focus ring (${stops.length} stops), switch, segments, toast; ${counts.icons} icons`);
}

(async () => {
    const browser = await chromium.launch();
    try {
        for (const viewport of VIEWPORTS) {
            for (const theme of THEMES) await run(browser, viewport, theme);
        }
        console.log(`Screenshots: ${OUT}`);
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
