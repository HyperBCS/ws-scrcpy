import type { Platform } from '../state/routes';

/**
 * What the mouse does on each kind of phone, as facts. The interaction handlers act on these and
 * the Actions sheet's Mouse and keyboard row lists them, so the list cannot claim what a phone
 * does not do. `scripts/test-stream-clients.js` drives each handler against this table.
 *
 * On both, a drag swipes and keeps going past the edge of the picture, clamped to the edge,
 * until the button is let go.
 */
export interface MouseContract {
    /** `scroll`: a scroll message at the pointer. `swipe`: one short swipe per wheel gesture. */
    wheel: 'scroll' | 'swipe';
    /** `back`: the Back key. `nothing`: the phone has no Back key. */
    rightClick: 'back' | 'nothing';
    /** Ctrl+drag puts down a second finger mirrored through the middle of the picture. */
    pinch: boolean;
}

export const MOUSE_CONTRACT: Readonly<Record<Platform, Readonly<MouseContract>>> = {
    android: { wheel: 'scroll', rightClick: 'back', pinch: true },
    // The iPhone's touch frames carry up to five fingers, so a pinch is two of them.
    ios: { wheel: 'swipe', rightClick: 'nothing', pinch: true },
};
