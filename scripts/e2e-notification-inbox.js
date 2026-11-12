// Fixture-only inbox checks. Run through scripts/test-browser.js notification-inbox.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { fixture, article, historyItems, switchIphone, touchSequence } = require('./e2e-notifications');
const { settleMotion } = require('./ui-motion');

async function until(check, label) {
    const end = Date.now() + 8000;
    while (!(await check()) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(await check(), label);
}
async function allIphones(browser) {
    for (const width of [390, 1440]) {
        const f = await fixture(browser, { history: true, allSources: true, notifications: historyItems(), width, devices: true });
        try {
            const { page } = f;
            await article(page, 'A message from Alex').waitFor();
            assert.equal(await page.locator('.kit-bar-status').textContent(), 'All iPhones');
            assert.equal(await page.locator('.notification-unread-count').textContent(), '3');
            assert.equal(await page.getByRole('radio', { name: 'Inbox 3', exact: true }).isChecked(), true);
            assert.equal(await article(page, 'A message from Alex').locator('.notification-source-name-on-card').textContent(), 'Phone B');
            const top = await article(page, 'Coffee at four?').evaluate(el => el.getBoundingClientRect().top);
            if (width === 1440) assert.ok((await article(page, 'Coffee at four?').boundingBox()).width >= 900, 'desktop inbox uses the available width');
            if (width === 390) console.log(`First card at ${top}px on 390x844`);
            if (width === 390) assert.ok(top <= 130, `the first actual card starts within 130px (${top})`);
            const out = '/tmp/ws-scrcpy-redesign/inbox-screens';
            await fs.mkdir(out, { recursive: true });
            for (const colorScheme of ['light', 'dark']) {
                await page.emulateMedia({ colorScheme });
                await settleMotion(page);
                await page.screenshot({ path: path.join(out, `inbox-${width}-${colorScheme}.png`) });
            }
            await page.getByRole('button', { name: 'Mark all read', exact: true }).click();
            await until(() => f.notifications.every(n => n.read), 'toolbar reads both sources');
            await page.getByRole('button', { name: 'Undo', exact: true }).click();
            await until(() => f.notifications.every(n => !n.read), 'Undo restores every scoped read state');
            await switchIphone(page, 'Phone B');
            assert.equal(await article(page, 'Coffee at four?').count(), 0);
            assert.match(await page.locator('.kit-bar-status').textContent(), /^Phone B/);
            assert.equal(await page.locator('.notification-unread-count').textContent(), '1');
            await page.reload();
            await article(page, 'A message from Alex').waitFor();
            assert.equal(await article(page, 'Coffee at four?').count(), 0, 'explicit source survives reload');
            assert.deepEqual(f.streams, [], 'inbox, selection and actions start no stream');
            assert.deepEqual(f.errors, []);
        } finally { await f.context.close(); }
    }
    console.log('PASS All iPhones is the default; counts, toolbar reads, source names and explicit source reloads stay scoped');
}
async function desktopActions(browser) {
    const f = await fixture(browser, { history: true, allSources: true, notifications: historyItems(), width: 1440, devices: true });
    try {
        const { page } = f;
        const first = page.locator('[data-notification-key="a-chat"] article');
        await first.focus();
        await page.keyboard.press('j');
        assert.equal(await article(page, 'Design review').evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('k');
        await page.keyboard.press('u');
        await until(() => f.notifications[0].read, 'u marks the current card read');
        await until(() => article(page, 'Design review').evaluate(el => el === document.activeElement), 'read action focuses the next card');
        await page.keyboard.press('e');
        await article(page, 'Design review').waitFor({ state: 'detached' });
        assert.deepEqual(f.dismissed, ['a-calendar']);
        await until(() => article(page, 'A message from Alex').evaluate(el => el === document.activeElement), 'dismiss focuses the next card');
        await page.keyboard.press('z');
        await article(page, 'Design review').waitFor();
        await page.keyboard.press('/');
        const search = page.getByRole('searchbox', { name: 'Search notifications', exact: true });
        await until(() => search.evaluate(el => el === document.activeElement), '/ focuses search');
        await search.fill('jkeuz');
        assert.deepEqual(f.dismissed, ['a-calendar'], 'typing never invokes inbox shortcuts');
        await page.locator('.kit-bar').getByRole('button', { name: 'Search', exact: true }).click();
        await first.waitFor();
        const button = first.getByRole('button', { name: 'Actions for Coffee at four?', exact: true });
        await button.click();
        const menu = page.getByRole('menu', { name: 'Notification actions', exact: true });
        await menu.waitFor();
        await settleMotion(page);
        const [at, box] = await Promise.all([button.boundingBox(), menu.boundingBox()]);
        assert.ok(Math.abs(box.y - (at.y + at.height)) <= 12 || Math.abs(box.y + box.height - at.y) <= 12, 'menu stays beside its button');
        assert.equal(await page.locator('dialog[open]').count(), 0, 'desktop card actions use a menu');
        await page.keyboard.press('e');
        assert.deepEqual(f.dismissed, ['a-calendar'], 'keys in a menu do not invoke inbox actions');
        await menu.getByRole('menuitem', { name: 'Mute this app', exact: true }).click();
        await until(() => f.sourcePosts.length === 1, 'mute saves once');
        assert.deepEqual(f.sourcePosts[0].muted, [{ app: 'com.example.chat', name: 'Messages' }]);
        assert.equal(f.sourcePosts[0].id, 'phone-a');
        f.sources[0].preview = false;
        // Undo uses a new source record, so a later unrelated edit is retained.
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await until(async () => (await first.textContent()).includes('Previews off.'), 'new source settings arrive');
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await until(() => f.sourcePosts.length === 2, 'mute Undo saves once');
        assert.equal(f.sourcePosts[1].preview, false);
        assert.deepEqual(f.sourcePosts[1].muted, []);
        f.sourceError = 'Could not save the mute list.';
        await button.click();
        await menu.getByRole('menuitem', { name: 'Mute this app', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: f.sourceError }).waitFor();
        assert.deepEqual(f.sources[0].muted, [], 'a refused mute leaves settings unchanged');
        assert.deepEqual(f.streams, []);
        assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
    console.log('PASS desktop keys, next-card focus, anchored menu, mute and Undo stay local and preserve later settings');
}
async function groupedAndExpanded(browser) {
    const now = Date.now();
    const items = historyItems();
    items[0].body = 'Long notification text. '.repeat(100);
    items.splice(1, 0, { ...items[0], key: 'a-chat-older', body: 'An earlier message.', received: now - 60000 });
    items.push({ ...items[0], key: 'a-yesterday', title: 'Yesterday message', body: 'Earlier.', received: now - 86400000 });
    const f = await fixture(browser, { history: true, notifications: items, ios: true, standalone: true });
    try {
        const { page } = f;
        await page.getByRole('heading', { name: 'Today', exact: true }).waitFor();
        await page.getByRole('heading', { name: 'Yesterday', exact: true }).waitFor();
        assert.equal(await page.locator('[data-notification-key="a-chat-older"]').count(), 0);
        await page.getByRole('button', { name: 'Show 1 older notification', exact: true }).click();
        await page.locator('[data-notification-key="a-chat-older"] article').waitFor();
        assert.deepEqual(f.readRequests, [], 'opening a stack does not read unseen members');
        const first = article(page, 'Coffee at four?').first();
        await first.getByRole('button', { name: 'Show more', exact: true }).click();
        await until(() => f.notifications[0].read, 'expanding marks only that notification read');
        assert.deepEqual(f.readRequests, [{ keys: ['a-chat'], read: true }]);
        assert.equal(f.notifications[1].read, false);
        await until(async () => (await page.locator('.notification-unread-count').textContent()) === '3', 'read-on-expand updates the badge');
        const cancelled = article(page, 'Design review');
        await touchSequence(page, cancelled, { dx: -30 });
        await cancelled.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
        assert.deepEqual(f.readRequests, [{ keys: ['a-chat'], read: true }], 'a cancelled horizontal swipe cannot become a read-on-expand click');
        assert.deepEqual(f.dismissed, []);
        await page.locator('[data-notification-key="a-chat-older"]').scrollIntoViewIfNeeded();
        await touchSequence(page, page.locator('[data-notification-key="a-chat-older"] article'), { dx: -140 });
        await until(() => f.dismissed.length === 1, 'one swipe invokes one action');
        assert.deepEqual(f.dismissed, ['a-chat-older']);
        assert.deepEqual(f.actions, [], 'swipe does not clear anything on a phone');
        assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
    console.log('PASS day groups and conversation stacks keep every member accessible; expanding reads one and swiping acts once');
}
async function scopedBulkArchive(browser) {
    const f = await fixture(browser, { history: true, allSources: true, notifications: historyItems(), width: 1440 });
    try {
        f.bulkDismissErrorSource = 'phone-b';
        await f.page.getByRole('button', { name: 'Notification actions', exact: true }).click();
        await f.page.getByRole('dialog').getByRole('button', { name: 'Archive all', exact: true }).click();
        const failure = f.page.getByRole('alert').filter({ hasText: 'Could not archive this iPhone.' });
        await failure.waitFor();
        assert.deepEqual(f.bulkDismissed, [
            { source: 'phone-a', keys: ['a-chat', 'a-calendar'] }, { source: 'phone-b', keys: ['b-mail'] },
        ], 'each request names only its own source and the original keys');
        assert.equal(f.notifications[2].dismissed, false);
        await failure.getByRole('button', { name: 'Undo', exact: true }).click();
        await until(() => f.notifications.every(n => !n.dismissed && !n.read), 'Undo remains available after a partial bulk failure');
        assert.deepEqual(f.bulkRestored, [{ source: 'phone-a', items: [{ key: 'a-chat', read: false }, { key: 'a-calendar', read: false }] }]);
        assert.deepEqual(f.actions, []);
        assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
    console.log('PASS combined bulk archive keeps source snapshots and offers Undo after a partial failure');
}
async function expandedUnread(browser) {
    const items = historyItems(); items[0].body = 'A long message. '.repeat(100);
    const f = await fixture(browser, { history: true, notifications: items });
    try {
        const { page } = f;
        await page.getByRole('radio', { name: 'Unread 2', exact: true }).click();
        const card = article(page, 'Coffee at four?');
        await card.focus();
        await page.keyboard.press('Space');
        await until(() => f.notifications[0].read, 'expanded unread message is read');
        await page.getByRole('radio', { name: 'Unread 1', exact: true }).waitFor();
        assert.equal(await card.isVisible(), true, 'the expanded text stays available until it is collapsed');
        await card.getByRole('button', { name: 'Show less', exact: true }).click();
        await card.waitFor({ state: 'detached' });
        assert.deepEqual(f.readRequests, [{ keys: ['a-chat'], read: true }], 'expansion sends one read request');
        assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
    console.log('PASS reading an expanded message updates Unread without hiding its text before collapse');
}
async function leavingDuringRead(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), width: 1440, devices: true });
    try {
        f.holdNextMutation = true;
        const card = article(f.page, 'Coffee at four?');
        await card.hover();
        await card.getByRole('button', { name: 'Open screen', exact: true }).click();
        await until(() => !!f.releaseMutation, 'the read response waits before opening the screen');
        await f.page.locator('.notifications-view > .kit-bar').getByRole('button', { name: 'Phones', exact: true }).click();
        await f.page.getByRole('heading', { name: 'Phones', exact: true }).waitFor();
        f.releaseMutation();
        await f.page.waitForTimeout(500);
        assert.deepEqual(f.streams, [], 'a late read response cannot open a phone after leaving the inbox');
        assert.equal(await f.page.getByRole('heading', { name: 'Phones', exact: true }).count(), 1);
        assert.deepEqual(f.errors, []);
    } finally { f.releaseMutation?.(); await f.context.close(); }
    const pendingSearch = await fixture(browser, { history: true, notifications: historyItems(), width: 1440, devices: true });
    try {
        const { page } = pendingSearch;
        await page.locator('.kit-bar').getByRole('button', { name: 'Search', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Search notifications', exact: true }).fill('Coffee');
        pendingSearch.holdNextMutation = true;
        const card = article(page, 'Coffee at four?');
        await card.hover();
        await card.getByRole('button', { name: 'Open screen', exact: true }).click();
        await until(() => !!pendingSearch.releaseMutation, 'the read waits while a search debounce would have fired');
        await page.waitForTimeout(500);
        pendingSearch.releaseMutation();
        await until(() => pendingSearch.streams.length === 1, 'the original open survives its own pending search');
        assert.deepEqual(pendingSearch.streams, ['phone-a']);
        assert.match(page.url(), /action=device&udid=phone-a/);
        assert.deepEqual(pendingSearch.errors, []);
    } finally { pendingSearch.releaseMutation?.(); await pendingSearch.context.close(); }
    console.log('PASS a pending search is flushed before opening; leaving during its read response cannot open a phone later');
}
(async () => {
    const browser = await chromium.launch({ headless: true });
    try { for (const run of [allIphones, desktopActions, groupedAndExpanded, scopedBulkArchive, expandedUnread, leavingDuringRead]) if (!process.env.SCENARIO || process.env.SCENARIO === run.name) await run(browser); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
