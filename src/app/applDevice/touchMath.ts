import Size from '../Size';

export interface ClientBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * Maps a browser client-space point on the touch canvas to video pixels. The canvas is sized to
 * the video's aspect ratio by the player, but a stale layout can leave letterbox bands; points in
 * those bands are clamped onto the picture rather than dropped, so a finger sliding off the
 * edge still ends its gesture where the picture ends.
 */
export function clientPointToVideo(
    clientX: number,
    clientY: number,
    box: ClientBox,
    videoSize: Size,
): { x: number; y: number } | undefined {
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
