import { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { animate, finished } from './motion';

interface AutoHeightProps {
    children: ComponentChildren;
    className?: string;
    /** Class for the element that holds the children. Put flex or grid layout and gaps here. */
    innerClassName?: string;
}

/** Observe natural content size without resizing it inside a ResizeObserver delivery. */
export function AutoHeight({ children, className = '', innerClassName }: AutoHeightProps) {
    const outer = useRef<HTMLDivElement>(null);
    const inner = useRef<HTMLDivElement>(null);
    const schedule = useRef<() => void>();
    const measure = useRef<() => void>();
    useLayoutEffect(() => {
        const container = outer.current;
        const content = inner.current;
        if (!container || !content) return;
        // Layout sizes, rather than transformed screen rects: a centred sheet can be scaling
        // during its entrance. Keep fractional pixels and include the wrapper's padding/borders.
        const size = () => {
            const style = getComputedStyle(container);
            const inside = getComputedStyle(content);
            const extra = (value: CSSStyleDeclaration) =>
                parseFloat(value.paddingTop) +
                parseFloat(value.paddingBottom) +
                parseFloat(value.borderTopWidth) +
                parseFloat(value.borderBottomWidth);
            return {
                height:
                    parseFloat(inside.height) + (inside.boxSizing === 'border-box' ? 0 : extra(inside)) + extra(style),
                width: content.clientWidth,
            };
        };
        let previous = size();
        let active: Animation | undefined;
        let frame = 0;
        const update = () => {
            const next = size();
            if (!next.width || !Number.isFinite(next.height)) {
                active?.cancel();
                active = undefined;
                container.style.removeProperty('overflow');
                previous = next;
                return;
            }
            if (Math.abs(next.height - previous.height) < 0.5 && next.width === previous.width) return;
            const from = active ? parseFloat(getComputedStyle(container).height) : previous.height;
            active?.cancel();
            active = undefined;
            container.style.removeProperty('overflow');
            if (next.width === previous.width && previous.width && Number.isFinite(from)) {
                container.style.overflow = 'clip';
                const transition = animate(container, [{ height: `${from}px` }, { height: `${next.height}px` }]);
                active = transition;
                void finished(transition).then(() => {
                    if (active !== transition) return;
                    transition?.cancel();
                    active = undefined;
                    container.style.removeProperty('overflow');
                });
            }
            // Height is animated only. At rest the wrapper always uses natural layout, so an
            // initial or coalesced observer delivery can never leave yesterday's fixed height.
            previous = next;
        };
        measure.current = update;
        schedule.current = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(update);
        };
        const observer = new ResizeObserver(() => schedule.current?.());
        observer.observe(content);
        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
            active?.cancel();
            schedule.current = undefined;
            measure.current = undefined;
            container.style.removeProperty('overflow');
        };
    }, []);
    // Commit-driven changes must start before paint: delaying them to the observer's next
    // frame would expose natural height first, then jump back to the old animation start.
    // External size changes still come through the observer outside its delivery.
    useLayoutEffect(() => measure.current?.());
    return (
        <div ref={outer} class={`auto-height ${className}`}>
            <div ref={inner} class={innerClassName}>
                {children}
            </div>
        </div>
    );
}
