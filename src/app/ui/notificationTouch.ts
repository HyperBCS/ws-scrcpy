import { NotificationSwipe, NotificationSwipeAction } from './notificationSwipe';

/** Native touch events keep their original target, including in Home Screen web
 * views. They don't require pointer capture or a complete compatibility stream. */
export function bindNotificationTouch(
    element: HTMLElement,
    callbacks: {
        enabled: () => boolean;
        offset: (value: number) => void;
        action: (value: NotificationSwipeAction, velocity: number) => void;
    },
): { cancel: () => void; release: () => void } {
    const swipe = new NotificationSwipe();
    let touchId: number | null = null;
    // Touch identifiers and PointerEvent IDs are unrelated. This recognizer owns
    // its own fixed internal ID and matches native contacts separately.
    const gestureId = 1;
    const cancel = () => {
        touchId = null;
        swipe.cancel();
        callbacks.offset(0);
    };
    const find = (list: TouchList) => {
        for (let index = 0; index < list.length; index++) {
            if (list[index].identifier === touchId) return list[index];
        }
        return undefined;
    };
    const start = (event: TouchEvent) => {
        cancel();
        if (
            !callbacks.enabled() ||
            event.touches.length !== 1 ||
            event.targetTouches.length !== 1 ||
            (event.target instanceof Element &&
                event.target.closest('button, a, input, select, textarea, video, audio, .notification-media'))
        )
            return;
        const touch = event.targetTouches[0];
        touchId = touch.identifier;
        swipe.start(touch.clientX, touch.clientY, gestureId, element.clientWidth);
    };
    const move = (event: TouchEvent) => {
        if (touchId === null) return;
        if (!callbacks.enabled() || event.touches.length !== 1) {
            cancel();
            return;
        }
        const touch = find(event.touches);
        if (!touch) {
            cancel();
            return;
        }
        const state = swipe.move(touch.clientX, touch.clientY, gestureId);
        if (state.locked === 'vertical') {
            cancel();
            return;
        }
        if (state.locked === 'horizontal') {
            // If WebKit already owns an uncancellable scroll, don't turn its
            // movement into a notification action on finger release.
            if (!event.cancelable) {
                cancel();
                return;
            }
            event.preventDefault();
        }
        callbacks.offset(state.offset);
    };
    const end = (event: TouchEvent) => {
        if (touchId === null) return;
        const touch = find(event.changedTouches);
        if (!touch) return;
        if (!callbacks.enabled() || event.touches.length) {
            cancel();
            return;
        }
        const action = swipe.end(touch.clientX, touch.clientY, gestureId);
        touchId = null;
        if (action) {
            if (event.cancelable) event.preventDefault();
            callbacks.action(action, swipe.releaseVelocity);
        } else callbacks.offset(0);
    };
    const additionalTouch = (event: TouchEvent) => {
        if (touchId !== null && event.touches.length !== 1) cancel();
    };
    const externalEnd = (event: TouchEvent) => {
        // Local end runs first. This only clears a sequence whose original
        // target vanished or whose touchend did not reach the card.
        if (touchId !== null && find(event.changedTouches)) cancel();
    };
    const hidden = () => {
        if (document.hidden) cancel();
    };
    element.addEventListener('touchstart', start, { passive: true });
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', end, { passive: false });
    element.addEventListener('touchcancel', cancel, { passive: true });
    window.addEventListener('touchstart', additionalTouch, { capture: true, passive: true });
    window.addEventListener('touchend', externalEnd, { passive: true });
    window.addEventListener('touchcancel', cancel, { passive: true });
    window.addEventListener('pagehide', cancel);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hidden);
    return {
        cancel,
        release: () => {
            element.removeEventListener('touchstart', start);
            element.removeEventListener('touchmove', move);
            element.removeEventListener('touchend', end);
            element.removeEventListener('touchcancel', cancel);
            window.removeEventListener('touchstart', additionalTouch, true);
            window.removeEventListener('touchend', externalEnd);
            window.removeEventListener('touchcancel', cancel);
            window.removeEventListener('pagehide', cancel);
            window.removeEventListener('blur', cancel);
            document.removeEventListener('visibilitychange', hidden);
            swipe.cancel();
            touchId = null;
        },
    };
}
