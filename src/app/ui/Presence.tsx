import { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { animate, finished, MOTION } from './motion';

export type MotionKind = 'fade' | 'toast' | 'popover' | 'sheet' | 'collapse';

/** Keeps the real element mounted through its exit, including when an exit is interrupted. */
export function usePresence<T extends HTMLElement>(visible: boolean, kind: MotionKind = 'fade') {
    const ref = useRef<T>(null);
    const [retained, setRetained] = useState(visible);
    const animation = useRef<Animation>();
    const generation = useRef(0);
    const present = visible || retained;

    useLayoutEffect(() => {
        const node = ref.current;
        if (!node || !present) return;
        const id = ++generation.current;
        const previous = animation.current;
        const style = getComputedStyle(node);
        const current: Keyframe = { opacity: style.opacity, transform: style.transform };
        const dimensions = [
            'marginTop',
            'marginBottom',
            'paddingTop',
            'paddingBottom',
            'minHeight',
            'borderTopWidth',
            'borderBottomWidth',
        ] as const;
        if (kind === 'collapse') {
            current.height = `${node.getBoundingClientRect().height}px`;
            for (const property of dimensions) current[property] = style[property];
            node.style.boxSizing = 'border-box';
        }
        previous?.cancel();
        node.style.removeProperty('--sheet-drag-y');
        if (visible) node.style.removeProperty('--sheet-backdrop-opacity');
        node.inert = !visible;
        if (visible) setRetained(true);
        const desktop = window.matchMedia(
            '(min-width: 760px) and (min-height: 540px) and (hover: hover) and (pointer: fine)',
        ).matches;
        const hiddenTransform =
            kind === 'toast'
                ? 'translateY(20px) scale(0.96)'
                : kind === 'popover'
                  ? 'translateY(6px) scale(0.96)'
                  : kind === 'sheet'
                    ? desktop
                        ? 'translateY(12px) scale(0.98)'
                        : 'translateY(100%)'
                    : kind === 'collapse'
                      ? 'translateY(-4px)'
                      : 'none';
        const hidden: Keyframe = { opacity: 0, transform: hiddenTransform };
        const shown: Keyframe = { opacity: 1, transform: 'none' };
        if (kind === 'collapse') {
            hidden.height = '0px';
            // Cancelling the previous animation exposes the natural target size.
            // Snapshot every dimension so a reversal cannot jump to full padding.
            const natural = getComputedStyle(node);
            shown.height = `${node.getBoundingClientRect().height}px`;
            for (const property of dimensions) {
                hidden[property] = '0px';
                shown[property] = natural[property];
            }
            node.style.overflow = 'clip';
        }
        animation.current = animate(node, [previous || !visible ? current : hidden, visible ? shown : hidden], {
            duration: visible ? MOTION.settle : MOTION.exit,
        });
        const active = animation.current;
        void finished(active).then(() => {
            if (id !== generation.current) return;
            active?.cancel();
            animation.current = undefined;
            if (kind === 'collapse') node.style.removeProperty('overflow');
            if (!visible) setRetained(false);
        });
    }, [visible, kind]);

    useLayoutEffect(
        () => () => {
            generation.current++;
            animation.current?.cancel();
        },
        [],
    );
    return { ref, present, exiting: !visible };
}

interface PresenceProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, 'ref'> {
    show: boolean;
    kind?: MotionKind;
    keepMounted?: boolean;
    children: ComponentChildren;
}

export function Presence({ show, kind = 'fade', keepMounted = false, children, ...props }: PresenceProps) {
    const { ref, present, exiting } = usePresence<HTMLDivElement>(show, kind);
    const content = useRef(children);
    if (show) content.current = children;
    return present || keepMounted ? (
        <div
            {...props}
            ref={ref}
            hidden={!present}
            data-presence
            data-exiting={exiting || undefined}
            aria-hidden={exiting || props['aria-hidden']}
        >
            {content.current}
        </div>
    ) : null;
}
