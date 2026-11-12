import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { usePresence } from '../ui/Presence';
import { ControlButton } from './ControlButton';
import { CONTROLS_LABEL, ControlDefinition, PhoneControls, shownControls, SLOT_COLUMNS } from './definition';

/** The height of one slot of the rail, as `FloatingToolbar.css` lays it out. */
const SLOT_HEIGHT = 56;

/** Where a control stands when the slots of the grid of three follow one another from the top. */
function slotIndex({ slot }: ControlDefinition) {
    return (slot.row - 1) * SLOT_COLUMNS + slot.column;
}

/**
 * The controls beside the picture, for a window with a mouse. The slots of the grid follow one
 * another from the top in one column, or in two when the picture is too short for one column;
 * an empty slot keeps its place, so a control has the same place on both kinds of phone here
 * too. The stage puts the rail against the picture and as tall as it (`StreamView.css`); what
 * two columns do not fit either scrolls inside the rail.
 */
export function ControlRail({ controls }: { controls: PhoneControls }) {
    const { ref } = usePresence<HTMLDivElement>(true, 'fade');
    const [columns, setColumns] = useState(1);
    const shown = shownControls(controls);
    const slots = Math.max(0, ...shown.map(({ definition }) => slotIndex(definition)));
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
            return room >= slots * SLOT_HEIGHT ? 1 : 2;
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
                    {shown.map(({ definition, action }) => {
                        const index = slotIndex(definition) - 1;
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
