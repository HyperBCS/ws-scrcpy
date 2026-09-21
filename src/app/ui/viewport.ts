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
