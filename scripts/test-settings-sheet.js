// Run with: node --test scripts/test-settings-sheet.js
// The one Settings sheet without a browser: every opener opens the same sheet, a target can name
// a section, the sections come in one order with only what a platform has nothing for left out,
// and opening at a section scrolls to its heading and focuses it. No browser and no phone.
const assert = require('node:assert/strict');
const { test } = require('node:test');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

const sheet = require('../src/app/state/settingsSheet');
const { SETTINGS_SECTIONS, SECTION_TITLES, sectionsFor, focusSection } = require('../src/app/views/settings/sections');
const { capabilities } = require('../src/app/state/capabilities');

test('every opener opens the one sheet for a serial, and openSettings can name a section', () => {
    sheet.openSettingsSheet('PIXEL', 'android:PIXEL');
    assert.deepEqual(sheet.settingsSheetTarget.value, { udid: 'PIXEL', deviceKey: 'android:PIXEL', section: undefined });
    sheet.openApplSettingsSheet('IPHONE');
    assert.deepEqual(sheet.settingsSheetTarget.value, { udid: 'IPHONE', deviceKey: undefined, section: undefined }, 'the iPhone opener opens the same sheet');
    const before = sheet.settingsSheetTarget.value;
    sheet.openApplSettingsSheet('IPHONE');
    assert.notEqual(sheet.settingsSheetTarget.value, before, 'each opening is a new target, so it loads again');
    sheet.openSettings('IPHONE', { deviceKey: 'ios:IPHONE', section: 'unlock' });
    assert.deepEqual(sheet.settingsSheetTarget.value, { udid: 'IPHONE', deviceKey: 'ios:IPHONE', section: 'unlock' });
    // The names the iPhone code used are the one sheet's.
    assert.equal(sheet.applSettingsSheetTarget, sheet.settingsSheetTarget);
    sheet.closeApplSettingsSheet();
    assert.equal(sheet.settingsSheetTarget.value, undefined);
    sheet.openSettings('PIXEL');
    sheet.closeSettingsSheet();
    assert.equal(sheet.settingsSheetTarget.value, undefined);
});

test('the sections keep one order, and a platform leaves out only what it has nothing for', () => {
    assert.deepEqual(SETTINGS_SECTIONS, ['stream', 'sound', 'keyboard', 'unlock', 'about']);
    assert.deepEqual(
        SETTINGS_SECTIONS.map((section) => SECTION_TITLES[section]),
        ['Stream', 'Sound', 'Keyboard', 'Unlock', 'About and troubleshooting'],
    );
    const android = sectionsFor(capabilities('android'));
    const ios = sectionsFor(capabilities('ios'));
    assert.deepEqual(android, SETTINGS_SECTIONS);
    assert.deepEqual(ios, ['sound', 'keyboard', 'unlock', 'about'], 'an iPhone stream has no settings of its own');
    assert.deepEqual(ios, android.filter((section) => ios.includes(section)), 'never reordered');
    assert.deepEqual(sectionsFor(undefined), ['about'], 'a phone of a kind not known yet shows what is known of it');
    assert.deepEqual(sectionsFor({ ...capabilities('ios'), streamQuality: true }), SETTINGS_SECTIONS, 'the table decides, not the platform name');
});

test('opening at a section scrolls its heading to the top and focuses it', () => {
    const calls = [];
    const heading = {
        scrollIntoView: (options) => calls.push(['scroll', options]),
        focus: (options) => calls.push(['focus', options]),
    };
    const root = {
        querySelector: (selector) => (selector === '[data-section="unlock"] .settings-section-title' ? heading : null),
    };
    assert.equal(focusSection(root, 'unlock'), true);
    assert.deepEqual(calls, [['scroll', { block: 'start' }], ['focus', { preventScroll: true }]]);
    assert.equal(focusSection(root, 'stream'), false, 'a section the sheet does not show is left alone');
    assert.equal(calls.length, 2);
});
