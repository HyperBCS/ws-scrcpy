import { ComponentChildren, JSX, toChildArray } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { animate, finished } from './motion';

export function AnimatedDetails({
    children,
    open,
    ...props
}: Omit<JSX.HTMLAttributes<HTMLDetailsElement>, 'ref'> & {
    children: ComponentChildren;
    open?: boolean;
}) {
    const ref = useRef<HTMLDetailsElement>(null);
    const animation = useRef<Animation>();
    const desired = useRef(!!open);
    const initialOpen = useRef(open);
    const parts = toChildArray(children);
    const toggle = (next: boolean) => {
        const node = ref.current;
        const summary = node?.querySelector('summary');
        const content = node?.querySelector<HTMLElement>(':scope > .details-content');
        if (!node || !summary || !content) return;
        desired.current = next;
        const from = node.getBoundingClientRect().height;
        animation.current?.cancel();
        node.open = true;
        node.dataset.expanded = String(next);
        content.inert = !next;
        if (!next && content.contains(document.activeElement)) summary.focus({ preventScroll: true });
        const border = node.offsetHeight - node.clientHeight;
        const to = next ? node.getBoundingClientRect().height : summary.getBoundingClientRect().height + border;
        node.style.overflow = 'clip';
        const active = animate(node, [{ height: `${from}px` }, { height: `${to}px` }]);
        animation.current = active;
        void finished(active).then(() => {
            if (animation.current !== active || desired.current !== next) return;
            node.open = next;
            active?.cancel();
            animation.current = undefined;
            node.style.removeProperty('overflow');
        });
    };
    useLayoutEffect(() => {
        if (open !== undefined && ref.current?.open !== open) toggle(open);
    }, [open]);
    useLayoutEffect(() => () => animation.current?.cancel(), []);
    return (
        <details
            {...props}
            ref={ref}
            open={initialOpen.current}
            onClick={(event) => {
                const node = ref.current;
                const summary = node?.querySelector('summary');
                if (
                    !summary?.contains(event.target as Node) ||
                    (event.target instanceof Element && event.target.closest('a, button, input, select'))
                )
                    return;
                event.preventDefault();
                toggle(animation.current ? !desired.current : !node?.open);
            }}
        >
            {parts[0]}
            <div class="details-content">{parts.slice(1)}</div>
        </details>
    );
}
