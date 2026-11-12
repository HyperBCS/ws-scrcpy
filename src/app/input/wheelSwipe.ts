import type { SizeInterface } from '../Size';
import type { VideoPoint } from './pointMapper';

/**
 * How a wheel scrolls an iPhone, which takes touches and no scroll message: one wheel gesture
 * is one short swipe at the pointer, and a fast wheel cannot start swipes faster than
 * `intervalMs`. How far and how fast feels right has to be judged on the phone.
 */
export const WHEEL_SWIPE = {
    /** Length of a swipe, as a share of the picture's height, or of its width sideways. */
    length: 0.2,
    /** A swipe stays this share away from every edge, so it is never Home, Back or a panel. */
    inset: 0.1,
    /** Moves between the touch down and the touch up. */
    moves: 5,
    /** Time between two moves. */
    moveMs: 20,
    /** The finger rests at the end this long before it lifts, so the page does not fling on. */
    holdMs: 100,
    /** A new swipe starts at most this often. Wheel events in between are dropped. */
    intervalMs: 400,
} as const;

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/**
 * The points of the swipe for a wheel event at `at`, in video pixels: the touch down, then each
 * move. The touch up is at the last point. The finger moves against the scroll, as on a touch
 * screen: scrolling down moves it up. The larger delta picks the axis. `undefined` when the
 * wheel did not move.
 */
export function wheelSwipePath(
    at: VideoPoint,
    size: SizeInterface,
    deltaX: number,
    deltaY: number,
): VideoPoint[] | undefined {
    const dx = Number.isFinite(deltaX) ? deltaX : 0;
    const dy = Number.isFinite(deltaY) ? deltaY : 0;
    if (!dx && !dy) {
        return undefined;
    }
    const vertical = Math.abs(dy) >= Math.abs(dx);
    const extent = vertical ? size.height : size.width;
    const across = vertical ? size.width : size.height;
    const move = -Math.sign(vertical ? dy : dx) * Math.round(extent * WHEEL_SWIPE.length);
    // The whole swipe lies inside the inset band, so it keeps its length near an edge.
    const low = extent * WHEEL_SWIPE.inset;
    const high = extent * (1 - WHEEL_SWIPE.inset);
    const start = clamp(vertical ? at.y : at.x, low - Math.min(0, move), high - Math.max(0, move));
    const side = Math.round(
        clamp(vertical ? at.x : at.y, across * WHEEL_SWIPE.inset, across * (1 - WHEEL_SWIPE.inset)),
    );
    const points: VideoPoint[] = [];
    for (let step = 0; step <= WHEEL_SWIPE.moves; step++) {
        const along = Math.round(start + (move * step) / WHEEL_SWIPE.moves);
        points.push(vertical ? { x: side, y: along } : { x: along, y: side });
    }
    return points;
}
