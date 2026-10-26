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

/**
 * Publishes the control bar's footprint as CSS custom properties so the bottom sheets can inset
 * themselves and leave the bar reachable.
 *
 * Without this a sheet anchored to `bottom: 0` sits on top of the bar, and because the overlap is
 * the sheet's own content (not its backdrop) a tap there hits a list item instead of the button
 * the user aimed at -- and does not even dismiss the sheet. Returns a teardown function.
 */
export function trackControlBarInset(controlBar: HTMLElement): () => void {
    const root = document.documentElement;
    const apply = () => {
        const isBottomBar = controlBar.clientWidth >= controlBar.clientHeight;
        root.style.setProperty('--control-bar-bottom', isBottomBar ? `${controlBar.clientHeight}px` : '0px');
        root.style.setProperty('--control-bar-side', isBottomBar ? '0px' : `${controlBar.clientWidth}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(controlBar);
    window.addEventListener('resize', apply);
    return () => {
        observer.disconnect();
        window.removeEventListener('resize', apply);
        root.style.removeProperty('--control-bar-bottom');
        root.style.removeProperty('--control-bar-side');
    };
}
