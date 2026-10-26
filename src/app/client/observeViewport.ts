/** Keep both platform players fitted to their container, with one teardown owner. */
export function observeViewport(element: Element, resize: () => void): () => void {
    window.addEventListener('resize', resize);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(element);
    return () => {
        window.removeEventListener('resize', resize);
        observer?.disconnect();
    };
}
