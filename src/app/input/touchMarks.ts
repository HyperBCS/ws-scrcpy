import type { SizeInterface } from '../Size';
import { clientPointToVideo, ClientBox, VideoPoint } from './pointMapper';

/**
 * Where the Show touches layer (`views/screen/TouchMarks.tsx`) draws the circle of a pointer.
 * Pure, so `scripts/test-show-touches.js` checks it directly.
 *
 * The circle is where the phone receives the touch: the page point goes through the input's own
 * mapping (`clientPointToVideo`), clamped onto the picture like the input, and the point on the
 * picture is turned back into a place on the page. The layer's box can be anywhere; the place is
 * given from its top left corner.
 */

/** A place on the layer, in CSS pixels from its top left corner. */
export interface LayerPoint {
    x: number;
    y: number;
}

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

/**
 * Where the circle of a pointer at a page point goes on the layer: the point the input sends to
 * the phone, so a pointer beside the picture puts it on the nearest edge. `undefined` when the
 * input has no point either.
 */
export function markPoint(
    clientX: number,
    clientY: number,
    box: ClientBox,
    videoSize: SizeInterface,
    layer: { left: number; top: number },
): LayerPoint | undefined {
    const point = clientPointToVideo(clientX, clientY, box, videoSize);
    return point && videoPointToLayer(point, box, videoSize, layer);
}
