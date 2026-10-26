// Real UI, fixture APIs. Inspect intermediate frames rather than disabling animations.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { fixture, article, historyItems, touchSequence, cardAction, openCardMenu } = require('./e2e-notifications');
const { settleMotion } = require('./ui-motion');
const browserName = process.env.BROWSER || 'chromium';
const OUT = process.env.E2E_OUT || '/tmp/ws-motion-review';

async function instrument(page) {
    await page.evaluate(() => {
        const original = Element.prototype.animate;
        window.motionFrames = [];
        window.pauseMotionFor = '';
        Element.prototype.animate = function (...args) {
            const animation = original.apply(this, args);
            const entry = { node: this, animation, frames: args[0] };
            window.motionFrames.push(entry);
            if (window.pauseMotionFor && this.matches(window.pauseMotionFor)) {
                animation.pause();
                animation.currentTime = 0;
            }
            return animation;
        };
    });
}
async function freeze(page, selector) {
    await page.evaluate(selector => { window.pauseMotionFor = selector; }, selector);
}
async function seek(page, selector, progress) {
    await page.evaluate(({ selector, progress }) => {
        for (const { node, animation } of window.motionFrames) {
            if (!node.matches(selector) || animation.playState !== 'paused') continue;
            const timing = animation.effect.getTiming();
            animation.currentTime = timing.delay + timing.duration * progress;
        }
    }, { selector, progress });
}
async function finish(page, selector = '*') {
    await page.evaluate(selector => {
        window.pauseMotionFor = '';
        for (const { node, animation } of window.motionFrames) {
            if (node.matches(selector) && animation.playState === 'paused') animation.finish();
        }
    }, selector);
}
async function capture(page, name) {
    await fs.mkdir(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, `${browserName}-${name}.png`) });
}
async function drag(page, card, dx) {
    await card.evaluate((node, dx) => {
        const target = node.querySelector('h3');
        const box = target.getBoundingClientRect();
        const x = box.right - 25, y = box.top + box.height / 2;
        const list = items => typeof document.createTouchList === 'function' ? document.createTouchList(...items) : items;
        window.finishMotionTouch = (type, delta = dx) => {
            const data = { identifier: 45, target, clientX: x + delta, clientY: y, pageX: x + delta, pageY: y, screenX: x + delta, screenY: y };
            const touch = typeof document.createTouch === 'function'
                ? document.createTouch(window, target, 45, data.pageX, data.pageY, data.screenX, data.screenY)
                : new Touch(data);
            const active = type === 'touchend' || type === 'touchcancel' ? [] : [touch];
            target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: list(active), targetTouches: list(active), changedTouches: list([touch]) }));
        };
        window.finishMotionTouch('touchstart', 0);
        window.finishMotionTouch('touchmove', dx);
    }, dx);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
}
async function waitFor(check, label) {
    for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert(check(), label);
}

async function swipeFrames(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), ios: true, standalone: true });
    try {
        await settleMotion(f.page);
        await instrument(f.page);
        const card = article(f.page, 'Coffee at four?');
        const next = article(f.page, 'Design review');
        const origin = await card.boundingBox();
        const nextOrigin = await next.boundingBox();
        await drag(f.page, card, -180);
        assert(Math.abs((await card.boundingBox()).x - origin.x + 180) < 1, 'the card follows a full 180px swipe without hitting a cap');
        assert.equal((await next.boundingBox()).y, nextOrigin.y, 'dragging does not disturb the list');
        await capture(f.page, 'swipe-following-finger');
        await f.page.evaluate(() => window.finishMotionTouch('touchcancel'));
        await settleMotion(f.page);
        assert(Math.abs((await card.boundingBox()).x - origin.x) < 1, 'cancelled gesture settles exactly at its origin');
        assert.deepEqual(f.dismissed, []);

        f.holdNextMutation = true;
        await freeze(f.page, '.notification-history-item, .notification-swipe-row');
        await drag(f.page, card, -160);
        await f.page.evaluate(() => window.finishMotionTouch('touchend'));
        await seek(f.page, '.notification-history-item, .notification-swipe-row', 0.45);
        const mid = await card.locator('..').boundingBox();
        assert(mid.height > 0 && mid.height < origin.height, 'the row closes its space during the exit');
        assert((await next.boundingBox()).y < nextOrigin.y - 10, 'the next card moves up with the departing card');
        assert.deepEqual(f.dismissed, [], 'the gesture has not sent an action before completing');
        await capture(f.page, 'swipe-exit-midpoint');
        await finish(f.page);
        await waitFor(() => !!f.releaseMutation, 'fixture holds the dismissal response');
        assert((await card.locator('..').boundingBox()).height < 1, 'no empty gap while the response is delayed');
        // A slow response must not lock every other card.
        await touchSequence(f.page, next, { dx: 130 });
        await waitFor(() => f.readRequests.some(request => request.keys.includes('a-calendar')), 'another card remains swipeable while the first request waits');
        f.releaseMutation();
        await card.waitFor({ state: 'detached' });
        await settleMotion(f.page);
        assert.deepEqual(f.dismissed, ['a-chat']);
        assert.deepEqual(f.errors, []);
        console.log('PASS full-distance tracking, cancellation, simultaneous list collapse and slow-response interaction');
    } finally { await f.context.close(); }
}

async function toastFrames(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), ios: true, standalone: true });
    try {
        await settleMotion(f.page);
        await instrument(f.page);
        await freeze(f.page, '.app-toast');
        await cardAction(f.page, 'Coffee at four?', 'Mark read');
        const toast = f.page.locator('.app-toast');
        await toast.waitFor({ state: 'attached' });
        await seek(f.page, '.app-toast', 0.2);
        const entering = await toast.evaluate(el => ({ opacity: +getComputedStyle(el).opacity, y: new DOMMatrix(getComputedStyle(el).transform).m42 }));
        assert(entering.opacity > 0 && entering.opacity < 1 && entering.y > 0, 'toast fades and moves into place');
        await capture(f.page, 'toast-entering');
        await finish(f.page, '.app-toast');
        await settleMotion(f.page);
        await freeze(f.page, '.app-toast');
        await toast.getByRole('button', { name: 'Dismiss undo notice' }).click();
        await seek(f.page, '.app-toast', 0.35);
        const leaving = await toast.evaluate(el => ({ opacity: +getComputedStyle(el).opacity, inert: el.inert, y: new DOMMatrix(getComputedStyle(el).transform).m42 }));
        assert(leaving.opacity > 0 && leaving.opacity < 1 && leaving.y > 0 && leaving.inert, 'toast is visible but noninteractive during its exit');
        await capture(f.page, 'toast-exiting');
        const previousOpacity = leaving.opacity;
        await cardAction(f.page, 'Design review', 'Mark read');
        const restarted = await toast.evaluate(el => +getComputedStyle(el).opacity);
        assert(Math.abs(restarted - previousOpacity) < 0.03, 'a replacement toast resumes from the interrupted frame');
        await finish(f.page);
        await settleMotion(f.page);
        assert.equal(await toast.count(), 1, 'one toast survives a replacement during exit');
        await toast.getByRole('button', { name: 'Undo', exact: true }).click();
        await toast.waitFor({ state: 'detached' });
        assert.equal(f.notifications.find(n => n.key === 'a-calendar').read, false, 'the replacement action belongs to the latest notification');
        assert.deepEqual(f.errors, []);
        console.log('PASS toast entry, exit, interrupted exit, replacement and Undo');
    } finally { await f.context.close(); }
}

async function disclosuresAndSheets(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), ios: true, standalone: true });
    try {
        await settleMotion(f.page);
        await instrument(f.page);
        const details = f.page.locator('.notification-history-help');
        const summary = details.locator('summary');
        await summary.focus();
        const closed = (await details.boundingBox()).height;
        await freeze(f.page, '.notification-history-help');
        await summary.evaluate(el => el.click());
        await seek(f.page, '.notification-history-help', 0.3);
        const middle = (await details.boundingBox()).height;
        assert(middle > closed + 5, 'disclosure expands through intermediate heights');
        await summary.evaluate(el => el.click());
        assert(Math.abs((await details.boundingBox()).height - middle) < 1, 'reversing an expansion keeps the current height');
        await finish(f.page);
        await settleMotion(f.page);
        assert.equal(await details.evaluate(el => el.open), false);
        assert.equal(await summary.evaluate(el => document.activeElement === el), true, 'disclosure retains keyboard focus');
        const sheet = await openCardMenu(f.page, 'Coffee at four?');
        await settleMotion(f.page);
        const handle = await sheet.locator('.notification-action-sheet-handle').boundingBox();
        await f.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await f.page.mouse.down();
        await f.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 120, { steps: 8 });
        assert(await sheet.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m42 > 100), 'action sheet follows its drag handle');
        await capture(f.page, 'sheet-drag');
        await f.page.mouse.up();
        await sheet.waitFor({ state: 'detached' });
        assert.equal(await article(f.page, 'Coffee at four?').getByRole('button').evaluate(el => document.activeElement === el), true, 'drag dismissal restores focus');
        const reopened = await openCardMenu(f.page, 'Coffee at four?');
        await settleMotion(f.page);
        assert.equal(await reopened.evaluate(el => +getComputedStyle(el, '::backdrop').opacity), 1, 'reopening restores the full backdrop after a drag');
        await reopened.getByRole('button', { name: 'Close actions' }).click();
        await reopened.waitFor({ state: 'detached' });
        await f.page.emulateMedia({ reducedMotion: 'reduce' });
        await cardAction(f.page, 'Coffee at four?', 'Mark read');
        const toast = f.page.locator('.app-toast');
        await toast.waitFor();
        assert.equal(await toast.evaluate(el => el.getAnimations().length), 0, 'reduced motion shows feedback without movement');
        await toast.getByRole('button', { name: 'Dismiss undo notice' }).click();
        await toast.waitFor({ state: 'detached' });
        await summary.click();
        assert.equal(await details.evaluate(el => el.open && !el.getAnimations().length), true, 'reduced motion changes disclosure state immediately');
        assert.deepEqual(f.errors, []);
        console.log('PASS reversible disclosures, draggable action sheets, focus restoration and reduced motion');
    } finally { await f.context.close(); }
}

async function toastTimer(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems(), clock: true });
    try {
        await settleMotion(f.page);
        await cardAction(f.page, 'Coffee at four?', 'Mark read');
        await settleMotion(f.page);
        const toast = f.page.locator('.app-toast');
        await toast.hover();
        await f.page.clock.fastForward(20000);
        assert.equal(await toast.count(), 1, 'hovering pauses the timer');
        await toast.getByRole('button', { name: 'Undo', exact: true }).focus();
        await f.page.mouse.move(1, 1);
        await f.page.clock.fastForward(20000);
        assert.equal(await toast.count(), 1, 'keyboard focus pauses the timer after the pointer leaves');
        await f.page.locator('input[type="search"]').focus();
        await f.page.clock.fastForward(13000);
        await f.page.clock.runFor(400);
        await toast.waitFor({ state: 'detached' });
        await cardAction(f.page, 'Design review', 'Mark read');
        await settleMotion(f.page);
        await f.page.clock.fastForward(13000);
        await f.page.clock.runFor(400);
        await toast.waitFor({ state: 'detached' });
        assert.deepEqual(f.errors, []);
        console.log('PASS toast timing pauses for hover/focus, resumes and resets for the next toast');
    } finally { await f.context.close(); }
}

async function noticeFrames(browser) {
    const f = await fixture(browser, { history: true, notifications: historyItems() });
    try {
        await settleMotion(f.page);
        await instrument(f.page);
        f.dismissError = 'Could not dismiss. Try again.';
        await freeze(f.page, '.notification-feedback');
        await cardAction(f.page, 'Coffee at four?', 'Dismiss here');
        const notice = f.page.locator('.notification-feedback');
        await notice.waitFor({ state: 'attached' });
        await seek(f.page, '.notification-feedback', 0.3);
        const middle = await notice.evaluate(el => ({ height: el.getBoundingClientRect().height, padding: +parseFloat(getComputedStyle(el).paddingTop) }));
        assert(middle.height > 0 && middle.padding > 0 && middle.padding < 14, 'the notice grows with its padding');
        await cardAction(f.page, 'Design review', 'Mark read');
        const reversed = await notice.evaluate(el => ({ height: el.getBoundingClientRect().height, padding: +parseFloat(getComputedStyle(el).paddingTop) }));
        assert(Math.abs(reversed.height - middle.height) < 1 && Math.abs(reversed.padding - middle.padding) < 0.1, 'reversing a notice retains height and padding');
        await finish(f.page);
        await notice.waitFor({ state: 'detached' });
        assert.deepEqual(f.errors, []);
        console.log('PASS notice growth and reversal preserve size, border and padding');
    } finally { await f.context.close(); }
}

(async () => {
    const browser = await ({ chromium, webkit }[browserName]).launch({ headless: true });
    try {
        const scenarios = [swipeFrames, toastFrames, disclosuresAndSheets, toastTimer, noticeFrames];
        for (const scenario of scenarios.filter(run => !process.env.SCENARIO || run.name === process.env.SCENARIO)) await scenario(browser);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
