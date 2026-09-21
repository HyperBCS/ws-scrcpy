import Size from './Size';

// Both `StreamClientScrcpy.getMaxSize()` and `StreamClientCoreDevice.getMaxSize()` need
// the video area left over once the control bar is subtracted from the container -- this feeds
// the fit-to-screen encode bounds, so getting the wrong axis is a correctness bug, not a cosmetic
// one. Which axis to subtract from depends on whether the bar is currently docked as a side rail
// (desktop/landscape, tall and thin) or a bottom bar (mobile portrait, wide and short -- see
// `views/StreamView.css`). Comparing the bar's own footprint tells us which, without duplicating
// the CSS breakpoint here.
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
