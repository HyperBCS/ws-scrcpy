import type { JSX } from 'preact';
import { streamConnected } from '../state/stream';
import { Icon } from '../ui/Icon';
import { iconButtonClass } from '../ui/IconButton';
import type { ControlAction, ControlDefinition, KeyAction, ListenAction } from './definition';
import type { HeldButtons } from './heldButtons';
import { listenView, pressListen } from './listen';
import '../../style/kit/IconButtonCaption.css';

interface ControlButtonProps {
    definition: ControlDefinition;
    action: ControlAction;
    held: HeldButtons;
    /** Where the rail or the panel puts it in its grid. */
    style: JSX.CSSProperties;
}

/** The handlers of a key: every press goes through `HeldButtons`. */
function keyHandlers(id: string, action: KeyAction, held: HeldButtons): JSX.HTMLAttributes<HTMLButtonElement> {
    const end = () => held.end(id);
    return {
        onPointerDown: (event) => {
            if (event.button !== 0 || !held.start(id, action)) {
                return;
            }
            event.preventDefault();
            // Capture keeps the end of the press on this button, also when it leaves the button.
            event.currentTarget.setPointerCapture(event.pointerId);
        },
        onPointerUp: end,
        onPointerCancel: end,
        onLostPointerCapture: end,
        onClick: (event) => {
            // A pointer press has sent its own down and up. A press from the keyboard has none.
            if (event.detail === 0) {
                held.tap(action);
            }
        },
    };
}

/** The handlers of a control, by its definition and its action. */
function handlersOf(
    definition: ControlDefinition,
    action: ControlAction,
    held: HeldButtons,
): JSX.HTMLAttributes<HTMLButtonElement> {
    if (action.kind === 'key') {
        // A key the definition does not hold is one tap per click, never a hold.
        return definition.hold ? keyHandlers(definition.id, action, held) : { onClick: () => held.tap(action) };
    }
    return action.kind === 'listen' ? { onClick: () => pressListen(action) } : { onClick: () => action.run() };
}

/**
 * One control of a phone's screen: the kit's icon button with a caption. `control-button` has no
 * rule; the browser checks find the controls by it.
 */
export function ControlButton({ definition, action, held, style }: ControlButtonProps) {
    const { label, icon } = definition;
    const listen = action.kind === 'listen' ? listenView(action as ListenAction) : undefined;
    const handlers = handlersOf(definition, action, held);
    return (
        <button
            type="button"
            class={`${iconButtonClass({ variant: 'bare' })} control-button kit-icon-button-captioned`}
            title={label}
            aria-label={label}
            aria-description={listen ? listen.description : definition.description}
            aria-pressed={listen ? listen.pressed : undefined}
            data-control={listen ? 'audio' : undefined}
            data-audio-state={listen?.state}
            disabled={definition.needsConnection && !streamConnected.value}
            style={style}
            {...handlers}
        >
            <Icon name={icon} />
            <span class="kit-icon-button-caption" aria-hidden="true">
                {listen?.caption || definition.caption || label}
            </span>
        </button>
    );
}
