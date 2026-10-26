import { animate, finished } from './motion';

export const DESKTOP_DIALOG = '(min-width: 760px) and (min-height: 540px) and (hover: hover) and (pointer: fine)';

/** One gesture for all mobile sheets; body scrolling and embedded controls remain native. */
export function bindSheetDrag(
    header: HTMLElement,
    panel: HTMLElement,
    root: HTMLElement,
    enabled: () => boolean,
    close: () => void,
): () => void {
    const desktop = window.matchMedia(DESKTOP_DIALOG);
    let drag:
        | {
              id: number;
              x: number;
              y: number;
              distance: number;
              lastY: number;
              time: number;
              velocity: number;
              horizontal: boolean;
          }
        | undefined;
    let settling: Animation | undefined;
    const reset = (settle = true) => {
        const current = drag;
        drag = undefined;
        const from = getComputedStyle(panel).transform;
        root.classList.remove('dragging');
        root.style.removeProperty('--sheet-backdrop-opacity');
        panel.style.removeProperty('--sheet-drag-y');
        if (current && header.hasPointerCapture(current.id)) header.releasePointerCapture(current.id);
        settling?.cancel();
        if (settle && current?.distance) {
            const animation = animate(panel, [{ transform: from }, { transform: 'translateY(0)' }]);
            settling = animation;
            void finished(animation).then(() => {
                if (settling === animation) {
                    animation?.cancel();
                    settling = undefined;
                }
            });
        }
    };
    const down = (event: PointerEvent) => {
        if (!event.isPrimary) {
            reset();
            return;
        }
        if (
            !enabled() ||
            desktop.matches ||
            drag ||
            event.button !== 0 ||
            (event.target instanceof Element && event.target.closest('button, a, input, select, textarea'))
        )
            return;
        event.preventDefault();
        event.stopPropagation();
        const offset = new DOMMatrix(getComputedStyle(panel).transform).m42;
        panel.getAnimations().forEach((animation) => animation.cancel());
        settling?.cancel();
        settling = undefined;
        drag = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY - offset,
            distance: offset,
            lastY: event.clientY,
            time: performance.now(),
            velocity: 0,
            horizontal: false,
        };
        header.setPointerCapture(event.pointerId);
        panel.style.setProperty('--sheet-drag-y', `${offset}px`);
        root.classList.add('dragging');
    };
    const move = (event: PointerEvent) => {
        if (!drag || drag.id !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const dx = Math.abs(event.clientX - drag.x);
        const dy = event.clientY - drag.y;
        const now = performance.now();
        drag.velocity = (event.clientY - drag.lastY) / Math.max(1, now - drag.time);
        drag.lastY = event.clientY;
        drag.time = now;
        if (dx > 12 && dx > Math.abs(dy) * 1.2) drag.horizontal = true;
        drag.distance = drag.horizontal ? 0 : dy >= 0 ? dy : -Math.min(24, Math.sqrt(-dy) * 2);
        panel.style.setProperty('--sheet-drag-y', `${drag.distance}px`);
        root.style.setProperty(
            '--sheet-backdrop-opacity',
            `${1 - Math.min(0.85, Math.max(0, drag.distance) / panel.clientHeight)}`,
        );
    };
    const up = (event: PointerEvent) => {
        if (!drag || drag.id !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const dismiss =
            enabled() &&
            !drag.horizontal &&
            (drag.distance >= Math.min(96, panel.clientHeight * 0.25) ||
                (drag.distance > 32 && drag.velocity > 0.65 && performance.now() - drag.time < 80));
        if (!dismiss) {
            reset();
            return;
        }
        const id = drag.id;
        drag = undefined;
        root.classList.remove('dragging');
        if (header.hasPointerCapture(id)) header.releasePointerCapture(id);
        // Presence reads the final drag position before clearing these variables.
        close();
    };
    const cancel = (event: PointerEvent) => {
        if (drag?.id === event.pointerId && event.target === header) reset();
    };
    const resetAll = () => reset();
    header.addEventListener('pointerdown', down);
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up);
    header.addEventListener('pointercancel', cancel);
    header.addEventListener('lostpointercapture', cancel);
    window.addEventListener('blur', resetAll);
    window.addEventListener('resize', resetAll);
    desktop.addEventListener('change', resetAll);
    return () => {
        if (drag) reset(false);
        settling?.cancel();
        header.removeEventListener('pointerdown', down);
        header.removeEventListener('pointermove', move);
        header.removeEventListener('pointerup', up);
        header.removeEventListener('pointercancel', cancel);
        header.removeEventListener('lostpointercapture', cancel);
        window.removeEventListener('blur', resetAll);
        window.removeEventListener('resize', resetAll);
        desktop.removeEventListener('change', resetAll);
    };
}
