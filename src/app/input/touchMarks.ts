import type { SizeInterface } from '../Size';
import type { Platform } from '../state/routes';
import { ClientBox, VideoPoint } from './pointMapper';

/**
 * Where the Show touches layer (`views/screen/TouchMarks.tsx`) draws the circle of a pointer, and
 * which pointers it draws. Pure, so `scripts/test-show-touches.js` checks it directly.
 *
 * The circle is where the phone receives the touch: the layer maps the page point with the
 * input's own mapping (`clientPointToVideo`), clamped onto the picture like the input, keeps that
 * point of the picture, and turns it back into a place on the page with `videoPointToLayer`. The
 * layer's box can be anywhere; the place is given from its top left corner.
 */

/** A place on the layer, in CSS pixels from its top left corner. */
export interface LayerPoint {
    x: number;
    y: number;
}

/**
 * Where the input of the two kinds of phone differs in what it takes as a touch. The layer
 * follows these, so it draws a circle exactly while the phone has the touch.
 */
export interface TouchRules {
    /** The most fingers the phone has at once. A finger past them gets nothing. */
    fingers: number;
    /** Fingers and a held mouse button at the same time. Without it, whichever came first wins. */
    fingersWithMouse: boolean;
    /**
     * A finger that moves on the picture while the phone has no touch of it puts one down: a press
     * that began before there was a picture, or one held while the input let everything go.
     */
    moveStartsTouch: boolean;
}

/** `scripts/test-show-touches.js` drives each handler against this table. */
export const TOUCH_RULES: Readonly<Record<Platform, Readonly<TouchRules>>> = {
    // interactionHandler/InteractionHandler.ts `formatTouchEvent`: every finger, also with the
    // mouse, and a move without a down is sent with one.
    android: { fingers: Infinity, fingersWithMouse: true, moveStartsTouch: true },
    // applDevice/CoreDeviceInteractionHandler.ts `onTouch` and `onMouse`: a contact frame carries
    // five fingers, a finger is not sent while the button is held nor a press while a finger is
    // down, and a finger only goes down where it starts or where it reaches the picture.
    ios: { fingers: 5, fingersWithMouse: false, moveStartsTouch: false },
};

/** The picture inside the touch layer's box: centred, with the video's own shape. */
function pictureIn(box: ClientBox, videoSize: SizeInterface): ClientBox {
    const ratio = videoSize.width / videoSize.height;
    let width = box.width;
    let height = box.height;
    if (box.width / box.height > ratio) {
        width = box.height * ratio;
    } else {
        height = box.width / ratio;
    }
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/**
 * Where a point of the phone's picture, in video pixels, lies on the layer whose top left corner
 * is at `layer` on the page. `undefined` while there is no picture.
 */
export function videoPointToLayer(
    point: VideoPoint,
    box: ClientBox,
    videoSize: SizeInterface,
    layer: { left: number; top: number },
): LayerPoint | undefined {
    if (!box.width || !box.height || !videoSize.width || !videoSize.height) {
        return undefined;
    }
    const picture = pictureIn(box, videoSize);
    return {
        x: picture.left + (point.x / videoSize.width) * picture.width - layer.left,
        y: picture.top + (point.y / videoSize.height) * picture.height - layer.top,
    };
}
