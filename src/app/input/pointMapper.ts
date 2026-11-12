import type { SizeInterface } from '../Size';

/**
 * The one point mapper of both kinds of phone: where a pointer on the page lands on the phone's
 * picture. Pure, so `scripts/test-point-mapper.js` checks it directly.
 *
 * - The element box is the touch layer's place on the page, in CSS pixels.
 * - The picture is the video inside that box, centred, with its own shape. The player sizes the
 *   layer to the picture, but a stale layout can leave bands inside it.
 * - Rotation needs no step here: both phones send their video turned the way the phone is, so a
 *   rotation arrives as a new video size and the point is read against that size.
 * - A point beside the picture is clamped onto its nearest edge, so a drag that leaves the
 *   picture keeps going along the edge.
 *
 * What each platform sends for a point is its own: Android a pixel of the video
 * (`lastPixel`), the iPhone a fraction of the screen (`StreamClientCoreDevice.sendTouch`).
 */

/** A box on the page, in CSS pixels. */
export interface ClientBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** A point on the phone's picture, in video pixels: 0 to the width and 0 to the height. */
export interface VideoPoint {
    x: number;
    y: number;
}

/**
 * The touch layer's box on the page. The place comes from the layout and the size from
 * `clientWidth` and `clientHeight`. Both are CSS pixels, whatever the device pixel ratio and
 * whatever the size of the canvas's own bitmap (the video size).
 */
export function elementBox(element: HTMLElement): ClientBox {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: element.clientWidth, height: element.clientHeight };
}

/** Whether a page point is on the box, its edges included. */
export function isInside(box: ClientBox, clientX: number, clientY: number): boolean {
    return (
        clientX >= box.left && clientX <= box.left + box.width && clientY >= box.top && clientY <= box.top + box.height
    );
}

/**
 * Maps a page point to video pixels, clamped onto the picture. `undefined` when the point is not
 * a number or there is no picture yet.
 */
export function clientPointToVideo(
    clientX: number,
    clientY: number,
    box: ClientBox,
    videoSize: SizeInterface,
): VideoPoint | undefined {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
        return undefined;
    }
    if (!box.width || !box.height || !videoSize.width || !videoSize.height) {
        return undefined;
    }
    const ratio = videoSize.width / videoSize.height;
    let pictureWidth = box.width;
    let pictureHeight = box.height;
    if (box.width / box.height > ratio) {
        pictureWidth = box.height * ratio;
    } else {
        pictureHeight = box.width / ratio;
    }
    const offsetX = (box.width - pictureWidth) / 2;
    const offsetY = (box.height - pictureHeight) / 2;
    const px = Math.min(Math.max(clientX - box.left - offsetX, 0), pictureWidth);
    const py = Math.min(Math.max(clientY - box.top - offsetY, 0), pictureHeight);
    return {
        x: Math.round((px / pictureWidth) * videoSize.width),
        y: Math.round((py / pictureHeight) * videoSize.height),
    };
}

/** Android's form of a point: the last pixel is width - 1, and scrcpy ignores a point past it. */
export function lastPixel(point: VideoPoint, videoSize: SizeInterface): VideoPoint {
    return { x: Math.min(point.x, videoSize.width - 1), y: Math.min(point.y, videoSize.height - 1) };
}

/** The middle of the picture. */
export function pictureCentre(videoSize: SizeInterface): VideoPoint {
    return { x: videoSize.width / 2, y: videoSize.height / 2 };
}

/**
 * The second finger of a pinch: `point` mirrored through `centre`. `undefined` when that falls
 * off the picture, which only happens when the centre is not the middle.
 */
export function mirrorPoint(point: VideoPoint, centre: VideoPoint, videoSize: SizeInterface): VideoPoint | undefined {
    const x = Math.round(2 * centre.x - point.x);
    const y = Math.round(2 * centre.y - point.y);
    if (x < 0 || y < 0 || x > videoSize.width || y > videoSize.height) {
        return undefined;
    }
    return { x, y };
}
