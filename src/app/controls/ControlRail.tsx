import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { usePresence } from '../ui/Presence';
import { ControlButton } from './ControlButton';
import { CONTROLS_LABEL, PhoneControls, shownControls } from './definition';

/**
 * The controls beside the picture, for a window with a mouse. Offered controls follow one
 * another without the touch grid's empty cells. One column is centred when it fits; a short
 * picture uses two columns and scrolls when needed. The stage keeps the rail attached.
 */
export function ControlRail({ controls }: { controls: PhoneControls }) {
    const { ref } = usePresence<HTMLDivElement>(true, 'fade');
    const [columns, setColumns] = useState(1);
    const shown = shownControls(controls);
    const slots = shown.length;
    // A key held when the rail goes (the window turned into a touch screen, another stream).
    useEffect(() => () => controls.held.releaseAll(), [controls]);

    useLayoutEffect(() => {
        const panel = ref.current;
        if (!panel) {
            return;
        }
        const wanted = () => {
            const style = getComputedStyle(panel);
            const room = panel.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
            const list = panel.querySelector<HTMLElement>('.control-buttons-list');
            if (!list) {
                return 1;
            }
            // Measure a hidden one-column copy at its real target width. Grid rows stretch
            // their neighbors, so summing the current two-column buttons overcounts captions.
            const columns = Number(panel.parentElement?.dataset.columns) || 1;
            const width =
                (panel.getBoundingClientRect().width -
                    parseFloat(style.borderLeftWidth) -
                    parseFloat(style.borderRightWidth)) /
                    columns -
                parseFloat(style.paddingLeft) -
                parseFloat(style.paddingRight);
            const probe = list.cloneNode(true) as HTMLElement;
            probe.setAttribute('aria-hidden', 'true');
            probe.inert = true;
            Object.assign(probe.style, {
                position: 'fixed',
                visibility: 'hidden',
                pointerEvents: 'none',
                width: `${width}px`,
                gridTemplateColumns: 'minmax(0, 1fr)',
                margin: '0',
            });
            for (const button of Array.from(probe.children) as HTMLElement[]) {
                button.style.gridRow = 'auto';
                button.style.gridColumn = 'auto';
            }
            panel.appendChild(probe);
            const height = probe.getBoundingClientRect().height;
            probe.remove();
            return room >= height ? 1 : 2;
        };
        setColumns(wanted());
        let frame = 0;
        // The rail follows the picture's height. A change of columns changes the rail's width and
        // so the picture's place: it waits for the next frame, which lays that out again.
        const resize = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => setColumns(wanted()));
        });
        resize.observe(panel);
        const list = panel.querySelector('.control-buttons-list');
        if (list) {
            resize.observe(list);
            // Captions can change without changing a row stretched by another button.
            list.querySelectorAll('.kit-icon-button-caption').forEach((caption) => resize.observe(caption));
        }
        return () => {
            cancelAnimationFrame(frame);
            resize.disconnect();
        };
    }, [slots]);

    return (
        <div class="floating-toolbar desktop" data-columns={columns}>
            <div class="floating-toolbar-safearea" aria-hidden="true" />
            <div
                id="stream-controls"
                class="floating-toolbar-panel"
                ref={ref}
                aria-hidden={false}
                role="group"
                aria-label={CONTROLS_LABEL}
            >
                <div class="control-buttons-list floating">
                    {shown.map(({ definition, action }, index) => {
                        return (
                            <ControlButton
                                key={definition.id}
                                definition={definition}
                                action={action}
                                held={controls.held}
                                style={{
                                    gridRow: String(Math.floor(index / columns) + 1),
                                    gridColumn: String((index % columns) + 1),
                                }}
                            />
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
