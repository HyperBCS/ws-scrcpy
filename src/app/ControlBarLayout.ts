import Size from './Size';

// Legacy hosts can reserve a docked control bar on either axis. Current stream clients measure
// their video wrapper directly, since surrounding layout has already reserved that space.
export function computeMaxSize(containerWidth: number, containerHeight: number, controlBar?: HTMLElement): Size {
    if (!controlBar) {
        // Floating toolbar: it overlays the video rather than reserving space, so the encode
        // bounds are simply the container.
        return new Size(containerWidth & ~15, containerHeight & ~15);
    }
    const isBottomBar = controlBar.clientWidth >= controlBar.clientHeight;
    const width = isBottomBar ? containerWidth : containerWidth - controlBar.clientWidth;
    const height = isBottomBar ? containerHeight - controlBar.clientHeight : containerHeight;
    return new Size(width & ~15, height & ~15);
}

/** The laid-out video area already excludes headers, safe areas and any adjacent controls. */
export function getVideoBounds(video: HTMLElement): Size | undefined {
    const style = getComputedStyle(video);
    const padding = (value: string) => parseFloat(value) || 0;
    const width = video.clientWidth - padding(style.paddingLeft) - padding(style.paddingRight);
    const height = video.clientHeight - padding(style.paddingTop) - padding(style.paddingBottom);
    const bounds = computeMaxSize(Math.max(0, width), Math.max(0, height));
    // Hidden or not-yet-laid-out players should keep their previous bounds until visible.
    return bounds.width > 0 && bounds.height > 0 ? bounds : undefined;
}
