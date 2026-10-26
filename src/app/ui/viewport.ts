// Safari may ignore the viewport's scale limits. Cancel its native zoom without stopping
// propagation: the interaction handler must still receive multi-touch on the remote screen.
const preventZoom = (event: Event): void => event.preventDefault();
document.addEventListener('gesturestart', preventZoom, { passive: false });
document.addEventListener('gesturechange', preventZoom, { passive: false });
document.addEventListener(
    'touchmove',
    (event: TouchEvent) => {
        if (event.touches.length > 1) {
            event.preventDefault();
        }
    },
    { passive: false },
);

// Floating feedback stays above Safari's keyboard and browser chrome.
let viewportFrame = 0;
const updateInset = () => {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
        const viewport = window.visualViewport;
        const inset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
        document.documentElement.style.setProperty('--viewport-bottom-inset', `${inset}px`);
    });
};
window.visualViewport?.addEventListener('resize', updateInset);
window.visualViewport?.addEventListener('scroll', updateInset);
window.addEventListener('resize', updateInset);
updateInset();
