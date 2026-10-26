/** Timings shared with tokens.css. Movement is interruptible; reduced motion settles immediately. */
export const MOTION = {
    quick: 160,
    settle: 320,
    exit: 220,
    ease: 'cubic-bezier(0.22, 1, 0.36, 1)',
    accelerate: 'cubic-bezier(0.32, 0, 0.67, 0)',
};

const running = new Set<Animation>();
let preference: MediaQueryList | undefined;

export function reducedMotion(): boolean {
    if (!preference) {
        preference = window.matchMedia('(prefers-reduced-motion: reduce)');
        preference.addEventListener('change', () => {
            if (preference?.matches) running.forEach((animation) => animation.finish());
        });
    }
    return preference.matches;
}

export function animate(
    element: Element,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions = {},
): Animation | undefined {
    if (reducedMotion()) return;
    const animation = element.animate(keyframes, {
        duration: MOTION.settle,
        easing: MOTION.ease,
        fill: 'both',
        ...options,
    });
    running.add(animation);
    void animation.finished.catch(() => undefined).finally(() => running.delete(animation));
    return animation;
}

export function finished(animation?: Animation): Promise<void> {
    return animation
        ? animation.finished.then(
              () => undefined,
              () => undefined,
          )
        : Promise.resolve();
}

const transitions = new WeakMap<HTMLElement, { animation?: Animation }>();

/** Imperative counterpart of Presence, used by the file browser's existing DOM. */
export function transitionVisibility(element: HTMLElement, visible: boolean, onHidden?: () => void): void {
    const previous = transitions.get(element);
    const style = getComputedStyle(element);
    const current = { opacity: style.opacity, transform: style.transform };
    previous?.animation?.cancel();
    element.hidden = false;
    element.inert = !visible;
    element.toggleAttribute('data-exiting', !visible);
    const hidden = { opacity: 0, transform: 'translateY(6px) scale(0.97)' };
    const shown = { opacity: 1, transform: 'none' };
    const record = {
        animation: animate(element, [previous || !visible ? current : hidden, visible ? shown : hidden], {
            duration: visible ? MOTION.settle : MOTION.exit,
        }),
    };
    transitions.set(element, record);
    void finished(record.animation).then(() => {
        if (transitions.get(element) !== record) return;
        transitions.delete(element);
        record.animation?.cancel();
        if (!visible) {
            element.hidden = true;
            onHidden?.();
        }
    });
}

export function cancelVisibility(element: HTMLElement): void {
    transitions.get(element)?.animation?.cancel();
    transitions.delete(element);
}
