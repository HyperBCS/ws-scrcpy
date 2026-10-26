import { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { animate, finished } from './motion';

/** Observe natural content size without resizing it inside a ResizeObserver delivery. */
export function AutoHeight({ children, className = '' }: { children: ComponentChildren; className?: string }) {
    const outer = useRef<HTMLDivElement>(null);
    const inner = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const container = outer.current;
        const content = inner.current;
        if (!container || !content) return;
        const naturalHeight = () => {
            const style = getComputedStyle(container);
            return (
                content.getBoundingClientRect().height +
                parseFloat(style.paddingTop) +
                parseFloat(style.paddingBottom) +
                parseFloat(style.borderTopWidth) +
                parseFloat(style.borderBottomWidth)
            );
        };
        let height = naturalHeight();
        let width = content.clientWidth;
        let active: Animation | undefined;
        let frame = 0;
        if (width) container.style.height = `${height}px`;
        const update = () => {
            const next = naturalHeight();
            const nextWidth = content.clientWidth;
            if (!nextWidth) {
                active?.cancel();
                active = undefined;
                container.style.removeProperty('height');
                container.style.removeProperty('overflow');
                width = height = 0;
                return;
            }
            if (Math.abs(next - height) < 0.5 && nextWidth === width) return;
            const from = active ? container.getBoundingClientRect().height : height;
            active?.cancel();
            container.style.height = `${next}px`;
            container.style.removeProperty('overflow');
            if (nextWidth === width) {
                container.style.overflow = 'clip';
                const transition = animate(container, [{ height: `${from}px` }, { height: `${next}px` }]);
                active = transition;
                void finished(transition).then(() => {
                    if (active !== transition) return;
                    transition?.cancel();
                    active = undefined;
                    container.style.removeProperty('overflow');
                });
            } else active = undefined;
            height = next;
            width = nextWidth;
        };
        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(update);
        });
        observer.observe(content);
        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
            active?.cancel();
        };
    }, []);
    return (
        <div ref={outer} class={`auto-height ${className}`}>
            <div ref={inner}>{children}</div>
        </div>
    );
}
