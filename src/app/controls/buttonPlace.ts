/**
 * Where the controls button sits on a touch screen (`ControlPanel.tsx`). It keeps to the left or
 * the right edge of the stage, so its place is a side and a height: the fraction of the height
 * the button can move in. The same place fits every window size and both orientations.
 */
export type Side = 'left' | 'right';

export interface Place {
    side: Side;
    /** 0 at the top of the area the button can move in, 1 at the bottom. */
    fraction: number;
}

export interface Point {
    x: number;
    y: number;
}

export interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface Size {
    width: number;
    height: number;
}

/** The height of a button the owner has not moved, as in the approved mockup. */
export const DEFAULT_FRACTION = 0.44;

const unit = (value: number) => Math.min(1, Math.max(0, value));
const range = (area: Box, size: Size) => Math.max(0, area.bottom - area.top - size.height);

/**
 * The top left corner of the button at `place`, inside `area`, on whole pixels so its edges and
 * its icon are drawn sharp.
 */
export function pointOf(place: Place, area: Box, size: Size): Point {
    const x = place.side === 'left' ? Math.ceil(area.left) : Math.floor(Math.max(area.left, area.right - size.width));
    return { x, y: Math.round(area.top + unit(place.fraction) * range(area, size)) };
}

/** A corner kept inside `area`, for a button that is being dragged. */
export function clampPoint(point: Point, area: Box, size: Size): Point {
    return {
        x: Math.min(Math.max(point.x, area.left), Math.max(area.left, area.right - size.width)),
        y: Math.min(Math.max(point.y, area.top), area.top + range(area, size)),
    };
}

/** The place for a button let go at `point`: the nearer side, at the same height. */
export function placeOf(point: Point, area: Box, size: Size): Place {
    const height = range(area, size);
    return {
        side: point.x + size.width / 2 < (area.left + area.right) / 2 ? 'left' : 'right',
        fraction: height > 0 ? unit((point.y - area.top) / height) : 0,
    };
}

/**
 * The place of a button the owner has not moved. Where the picture leaves a band at its sides
 * that is wide enough for the button, the button on the right edge is in that band. Where the
 * bands are above and below the picture, it goes in the middle of the taller one, if it fits.
 * Otherwise it is over the picture, on the right edge.
 */
export function defaultPlace(area: Box, picture: Box | undefined, size: Size): Place {
    const place: Place = { side: 'right', fraction: DEFAULT_FRACTION };
    if (!picture || area.right - picture.right >= size.width) {
        return place;
    }
    const above = { top: area.top, bottom: Math.min(area.bottom, picture.top) };
    const below = { top: Math.max(area.top, picture.bottom), bottom: area.bottom };
    const band = below.bottom - below.top >= above.bottom - above.top ? below : above;
    const height = range(area, size);
    if (band.bottom - band.top < size.height || height <= 0) {
        return place;
    }
    const top = band.top + (band.bottom - band.top - size.height) / 2;
    return { side: 'right', fraction: unit((top - area.top) / height) };
}

/** A place read back from storage, or undefined when the text is not one. */
export function parsePlace(text: string | null): Place | undefined {
    try {
        const value = text ? JSON.parse(text) : undefined;
        if ((value?.side === 'left' || value?.side === 'right') && Number.isFinite(value.fraction)) {
            return { side: value.side, fraction: unit(value.fraction) };
        }
    } catch {
        // Not a place.
    }
    return undefined;
}

/**
 * The place for the corner a button was dragged to before it kept to an edge, stored as `{x, y}`
 * of a button of `oldSize`. It goes to the nearer side, at the same height.
 */
export function placeFromPosition(text: string | null, area: Box, size: Size, oldSize: Size): Place | undefined {
    try {
        const value = text ? JSON.parse(text) : undefined;
        if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) {
            const centre = { x: value.x + oldSize.width / 2 - size.width / 2, y: value.y };
            return placeOf(clampPoint(centre, area, size), area, size);
        }
    } catch {
        // Not a position.
    }
    return undefined;
}
