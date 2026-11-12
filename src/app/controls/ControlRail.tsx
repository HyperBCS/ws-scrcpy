import { useEffect } from 'preact/hooks';
import { usePresence } from '../ui/Presence';
import { ControlButton } from './ControlButton';
import { CONTROLS_LABEL, PhoneControls, shownControls, SLOT_COLUMNS } from './definition';

/**
 * The controls in one column beside the picture, for a window with a mouse. The slots of the
 * grid follow one another from the top, and an empty slot keeps its height, so a control has the
 * same place on both kinds of phone here too.
 */
export function ControlRail({ controls }: { controls: PhoneControls }) {
    const { ref } = usePresence<HTMLDivElement>(true, 'fade');
    // A key held when the rail goes (the window turned into a touch screen, another stream).
    useEffect(() => () => controls.held.releaseAll(), [controls]);
    return (
        <div class="floating-toolbar desktop">
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
                    {shownControls(controls).map(({ definition, action }) => (
                        <ControlButton
                            key={definition.id}
                            definition={definition}
                            action={action}
                            held={controls.held}
                            style={{
                                gridRow: String((definition.slot.row - 1) * SLOT_COLUMNS + definition.slot.column),
                                gridColumn: '1',
                            }}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
