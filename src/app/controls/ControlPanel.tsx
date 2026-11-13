import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { deviceSwitcherOpen, liveTextOpen, toolsSheetOpen, unlockSheetOpen } from '../state/stream';
import { settingsSheetTarget } from '../state/settingsSheet';
import { Icon } from '../ui/Icon';
import { iconButtonClass } from '../ui/IconButton';
import { animate } from '../ui/motion';
import { useOverlayHistory } from '../ui/overlayHistory';
import { usePresence } from '../ui/Presence';
import { readStorage, removeStorage, writeStorage } from '../ui/storage';
import {
    Box,
    clampPoint,
    defaultPlace,
    parsePlace,
    Place,
    placeFromPosition,
    placeOf,
    Point,
    pointOf,
    Side,
    Size,
} from './buttonPlace';
import { ControlButton } from './ControlButton';
import { CONTROLS_LABEL, PhoneControls, shownControls } from './definition';

// The place the owner dragged the button to, as a side and a height (`buttonPlace.ts`).
const PLACE_KEY = 'controls_button_place';
// Where the button was kept before it stayed on an edge: the corner of a 56px button.
const OLD_POSITION_KEY = 'floating_toolbar_position';
const OLD_SIZE: Size = { width: 56, height: 56 };
// The size in `FloatingToolbar.css`, for the first layout before the button is measured.
const BUTTON_SIZE: Size = { width: 44, height: 56 };
const DRAG_THRESHOLD_PX = 6;
const EDGE_MARGIN = 12;
const PANEL_GAP = 10;
// Without a touch for this long the button turns translucent (`--idle-opacity`).
const IDLE_AFTER_MS = 3000;
// After a touch ends the browser may still send mouse events and a click for it.
const SHIELD_RELEASE_MS = 400;
// The remote input handlers listen on document.body.
const SHIELD_EVENTS = [
    'touchstart',
    'touchmove',
    'touchend',
    'touchcancel',
    'mousedown',
    'mousemove',
    'mouseup',
    'click',
];

/** The safe-area insets of the screen, read from the probe in the toolbar. */
function safeInsets(): Box {
    const probe = document.querySelector('.floating-toolbar-safearea');
    const style = probe ? getComputedStyle(probe) : undefined;
    const inset = (side: 'Top' | 'Right' | 'Bottom' | 'Left') => parseFloat(style?.[`padding${side}`] || '0') || 0;
    return { left: inset('Left'), top: inset('Top'), right: inset('Right'), bottom: inset('Bottom') };
}

/** The part of the window in view, which the on-screen keyboard can shrink and pan. */
function visibleBox(): Box {
    const visual = window.visualViewport;
    const left = visual?.offsetLeft || 0;
    const top = visual?.offsetTop || 0;
    return {
        left,
        top,
        right: left + (visual?.width || window.innerWidth),
        bottom: top + (visual?.height || window.innerHeight),
    };
}

/**
 * The width a sheet docked at the right edge of the stage takes from it (`ui/Sheet.tsx`, from
 * 1024px, also on a touch screen). The stage has `data-sheet-docked` while the panel is shown.
 */
function dockedWidth(stage: Element | null): number {
    if (!stage?.hasAttribute('data-sheet-docked')) {
        return 0;
    }
    return parseFloat(getComputedStyle(stage).getPropertyValue('--stream-dock-width')) || 0;
}

/**
 * Where the panel may open: the part in view, inside the safe area and 12px from its edges. It
 * may lie over the header, but not below the stage, where Type text docks its sheet, and not
 * over a sheet docked beside the stage.
 */
function panelArea(stage: Element | null): Box {
    const view = visibleBox();
    const inset = safeInsets();
    const box = stage?.getBoundingClientRect();
    const bottom = box?.bottom ?? view.bottom;
    const docked = dockedWidth(stage);
    const right = view.right - Math.max(EDGE_MARGIN, inset.right);
    return {
        left: view.left + Math.max(EDGE_MARGIN, inset.left),
        top: view.top + Math.max(EDGE_MARGIN, inset.top),
        right: box && docked ? Math.min(right, box.right - docked - EDGE_MARGIN) : right,
        bottom: Math.min(view.bottom - Math.max(EDGE_MARGIN, inset.bottom), bottom - EDGE_MARGIN),
    };
}

/**
 * Where the button may sit: the stage, which starts under the header, the tabs and the banners,
 * within the part in view and the safe area, and left of a docked sheet. The button touches the
 * side edges of that area and keeps 12px from its top and bottom.
 */
function buttonArea(stage: Element | null): Box {
    const view = visibleBox();
    const inset = safeInsets();
    const box = stage?.getBoundingClientRect() ?? view;
    return {
        left: Math.max(box.left, view.left + inset.left),
        top: Math.max(box.top, view.top + inset.top) + EDGE_MARGIN,
        right: Math.min(box.right - dockedWidth(stage), view.right - inset.right),
        bottom: Math.min(box.bottom, view.bottom - inset.bottom) - EDGE_MARGIN,
    };
}

/** The picture on the stage, once it has a size. The touch layer lies exactly over it. */
function pictureBox(stage: Element | null): Box | undefined {
    const box = stage?.querySelector('.touch-layer')?.getBoundingClientRect();
    return box && box.width > 0 && box.height > 0 ? box : undefined;
}

/**
 * The controls on a touch screen: a button on the left or the right edge of the stage, and the
 * panel it opens, with the controls in their slots of three columns. The owner can drag the
 * button; it goes back to the nearer edge and keeps that side and height in this browser.
 * Without a touch for 3 s it is translucent.
 */
export function ControlPanel({ controls }: { controls: PhoneControls }) {
    const [pos, setPos] = useState<Point>(() => ({
        x: window.innerWidth - BUTTON_SIZE.width,
        y: window.innerHeight / 2,
    }));
    const [side, setSide] = useState<Side>('right');
    const [open, setOpen] = useState(false);
    const [dragging, setDragging] = useState(false);
    // Opaque from a touch on the button until 3 s after it; translucent before the first touch.
    const [awake, setAwake] = useState(false);
    const [pressing, setPressing] = useState(false);
    // The press that closes the panel must not reach the phone. The shield covers the stage
    // while the panel is open and stays until that press, and the events that follow it, end.
    const [shieldHeld, setShieldHeld] = useState(false);
    const shieldRef = useRef<HTMLDivElement>(null);
    const shieldTimer = useRef<ReturnType<typeof setTimeout>>();
    const [panelStyle, setPanelStyle] = useState({
        left: '12px',
        top: '12px',
        maxHeight: '70dvh',
        transformOrigin: 'center bottom',
    });
    const rootRef = useRef<HTMLDivElement>(null);
    const { ref: panelRef, present: panelPresent } = usePresence<HTMLDivElement>(open, 'popover');
    const fabRef = useRef<HTMLButtonElement>(null);
    const suppressClick = useRef(false);
    const openedOverSheet = useRef(false);
    const dragState = useRef<{ dx: number; dy: number; start: Point; moved: boolean; id: number }>();
    // The place the owner chose; until then the button takes the default place.
    const chosen = useRef<Place>();
    // Where a button that was let go is drawn from as it goes to its edge.
    const snapFrom = useRef<Point>();
    const modalOpen =
        toolsSheetOpen.value || deviceSwitcherOpen.value || unlockSheetOpen.value || !!settingsSheetTarget.value;
    const sheetOpen = modalOpen || liveTextOpen.value;

    const buttonSize = (): Size => {
        const fab = fabRef.current;
        return fab?.offsetWidth ? { width: fab.offsetWidth, height: fab.offsetHeight } : BUTTON_SIZE;
    };
    const stage = () => rootRef.current?.closest('.stream-stage') ?? null;
    const layout = () => {
        if (dragState.current?.moved) {
            return;
        }
        const area = buttonArea(stage());
        const size = buttonSize();
        const place = chosen.current ?? defaultPlace(area, pictureBox(stage()), size);
        const next = pointOf(place, area, size);
        setPos((current) => (current.x === next.x && current.y === next.y ? current : next));
        setSide(place.side);
    };

    // Another stream's controls start closed.
    useEffect(() => setOpen(false), [controls]);
    // A key held when the panel closes is let go then, not when its pointer ends.
    useEffect(() => {
        if (!open) {
            controls.held.releaseAll();
        }
    }, [open, controls]);
    useEffect(() => () => controls.held.releaseAll(), [controls]);

    useEffect(() => {
        if (sheetOpen) {
            setOpen(false);
        }
    }, [sheetOpen]);
    // The panel over the picture: the browser's Back closes it and leaves the stream open. A sheet
    // opened from it takes its place. `sheetOpen` is read here, and not only in the effect above,
    // so the panel gives its history entry up in the same pass in which the sheet asks for one:
    // the sheet takes that entry over and no step through history is made.
    // The panel can also open while Type text is open, which leaves the button in reach. It is
    // then on top and keeps an entry of its own, so Back closes it first.
    if (!sheetOpen) {
        openedOverSheet.current = false;
    }
    useOverlayHistory(open && (!sheetOpen || openedOverSheet.current), () => setOpen(false));

    // The clock runs while the button is in sight and free: not while it is pressed, while its
    // panel is open, or under a sheet that covers it.
    useEffect(() => {
        if (!awake || pressing || open || modalOpen) {
            return;
        }
        const timer = setTimeout(() => setAwake(false), IDLE_AFTER_MS);
        return () => clearTimeout(timer);
    }, [awake, pressing, open, modalOpen]);

    // The button follows the stage: a banner, Type text, the on-screen keyboard, a rotation and
    // the picture's own size move it to its place again.
    useLayoutEffect(() => {
        const area = buttonArea(stage());
        const saved = parsePlace(readStorage(PLACE_KEY));
        const old = readStorage(OLD_POSITION_KEY);
        chosen.current = saved ?? placeFromPosition(old, area, buttonSize(), OLD_SIZE);
        // Earlier versions kept both keys after conversion. Keep the current place, and only
        // discard the old corner after this browser confirms it can save that place again.
        if (old !== null && chosen.current && writeStorage(PLACE_KEY, JSON.stringify(chosen.current))) {
            removeStorage(OLD_POSITION_KEY);
        }
        layout();
        const sizes = new ResizeObserver(() => layout());
        const mount = stage()?.querySelector('.stream-mount');
        let picture: Element | null = null;
        const watchPicture = () => {
            const next = mount?.querySelector('.touch-layer') ?? null;
            if (next !== picture) {
                if (picture) sizes.unobserve(picture);
                picture = next;
                if (picture) sizes.observe(picture);
                layout();
            }
        };
        const added = new MutationObserver(watchPicture);
        const current = stage();
        if (current) sizes.observe(current);
        if (mount) added.observe(mount, { childList: true, subtree: true });
        watchPicture();
        // Type text keeps the view on the part in view (`LiveTextOverlay.tsx`). When the browser
        // pans that part, the view moves a frame later through its style, without a change of
        // size that the observer above would see.
        const moved = new MutationObserver(() => layout());
        const view = rootRef.current?.closest('.stream-view');
        if (view) moved.observe(view, { attributes: true, attributeFilter: ['style', 'class'] });
        // A sheet docked beside the stage on a wide touch screen takes its right edge.
        if (current) moved.observe(current, { attributes: true, attributeFilter: ['data-sheet-docked'] });
        window.addEventListener('resize', layout);
        window.visualViewport?.addEventListener('resize', layout);
        window.visualViewport?.addEventListener('scroll', layout);
        return () => {
            sizes.disconnect();
            added.disconnect();
            moved.disconnect();
            window.removeEventListener('resize', layout);
            window.visualViewport?.removeEventListener('resize', layout);
            window.visualViewport?.removeEventListener('scroll', layout);
        };
    }, []);

    // A button that was let go slides from there to its edge; with motion reduced it is there.
    useLayoutEffect(() => {
        const from = snapFrom.current;
        snapFrom.current = undefined;
        if (from && fabRef.current) {
            animate(
                fabRef.current,
                [{ transform: `translate(${from.x - pos.x}px, ${from.y - pos.y}px)` }, { transform: 'none' }],
                { fill: 'none' },
            );
        }
    }, [pos]);

    useLayoutEffect(() => {
        if (!open || !panelRef.current) {
            return;
        }
        const bounds = panelArea(stage());
        const size = buttonSize();
        const panel = panelRef.current;
        let maxHeight = bounds.bottom - bounds.top;
        const height = Math.min(panel.scrollHeight, maxHeight);
        // The layout width: the panel is still scaled down as it opens.
        const width = panel.offsetWidth;
        // Beside the button, on the side away from its edge and centred on it.
        const beside = side === 'left' ? pos.x + size.width + PANEL_GAP : pos.x - PANEL_GAP - width;
        let left = beside;
        let top = Math.max(bounds.top, Math.min(pos.y + size.height / 2 - height / 2, bounds.bottom - height));
        let origin = `${side === 'left' ? 0 : width}px ${pos.y + size.height / 2 - top}px`;
        if (beside < bounds.left || beside + width > bounds.right) {
            // A narrow screen has no room beside it: above or below, lined up with its outer edge.
            const above = pos.y - height - PANEL_GAP;
            const below = pos.y + size.height + PANEL_GAP;
            left = side === 'left' ? pos.x : pos.x + size.width - width;
            if (above >= bounds.top) {
                top = above;
            } else if (below + height <= bounds.bottom) {
                top = below;
            } else {
                // A narrow, short screen cannot fit the full grid there either. Scroll the
                // panel in the larger remaining space so no control sits under the button.
                const availableAbove = pos.y - bounds.top - PANEL_GAP;
                const availableBelow = bounds.bottom - below;
                if (availableBelow >= availableAbove) {
                    maxHeight = Math.max(0, availableBelow);
                    top = below;
                } else {
                    maxHeight = Math.max(0, availableAbove);
                    top = bounds.top;
                }
            }
            const shown = Math.max(bounds.left, Math.min(left, bounds.right - width));
            origin = `${pos.x + size.width / 2 - shown}px ${pos.y < top ? 0 : height}px`;
        }
        setPanelStyle({
            left: `${Math.max(bounds.left, Math.min(left, bounds.right - width))}px`,
            top: `${top}px`,
            maxHeight: `${maxHeight}px`,
            transformOrigin: origin,
        });
    }, [open, pos, side]);

    const shieldShown = open || shieldHeld;
    useEffect(() => {
        const shield = shieldRef.current;
        if (!shieldShown || !shield) {
            return;
        }
        const consume = (event: Event) => {
            event.stopPropagation();
            if (event.cancelable) {
                event.preventDefault();
            }
        };
        SHIELD_EVENTS.forEach((name) => shield.addEventListener(name, consume, { passive: false }));
        return () => SHIELD_EVENTS.forEach((name) => shield.removeEventListener(name, consume));
    }, [shieldShown]);
    useEffect(() => () => clearTimeout(shieldTimer.current), []);

    const onShieldDown = () => {
        clearTimeout(shieldTimer.current);
        setShieldHeld(true);
        setOpen(false);
    };
    const onShieldUp = () => {
        clearTimeout(shieldTimer.current);
        shieldTimer.current = setTimeout(() => setShieldHeld(false), SHIELD_RELEASE_MS);
    };

    useEffect(() => {
        if (!open) {
            return;
        }
        const dismiss = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                fabRef.current?.focus();
            }
        };
        document.addEventListener('pointerdown', dismiss);
        document.addEventListener('keydown', escape);
        return () => {
            document.removeEventListener('pointerdown', dismiss);
            document.removeEventListener('keydown', escape);
        };
    }, [open]);

    const onPointerDown = (event: PointerEvent) => {
        if (!event.isPrimary || event.button !== 0) {
            return;
        }
        suppressClick.current = false;
        setAwake(true);
        setPressing(true);
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        dragState.current = {
            dx: event.clientX - pos.x,
            dy: event.clientY - pos.y,
            start: pos,
            moved: false,
            id: event.pointerId,
        };
    };

    const onPointerMove = (event: PointerEvent) => {
        const state = dragState.current;
        if (!state || state.id !== event.pointerId) {
            return;
        }
        const next = { x: event.clientX - state.dx, y: event.clientY - state.dy };
        if (!state.moved && Math.hypot(next.x - state.start.x, next.y - state.start.y) < DRAG_THRESHOLD_PX) {
            return;
        }
        state.moved = true;
        suppressClick.current = true;
        setDragging(true);
        setOpen(false);
        event.preventDefault();
        setPos(clampPoint(next, buttonArea(stage()), buttonSize()));
    };

    const endDrag = (event: PointerEvent) => {
        const state = dragState.current;
        if (!state || state.id !== event.pointerId) {
            return;
        }
        dragState.current = undefined;
        setDragging(false);
        setPressing(false);
        if (event.type === 'pointercancel') {
            suppressClick.current = true;
            layout();
            return;
        }
        if (state.moved) {
            const area = buttonArea(stage());
            const size = buttonSize();
            const dropped = clampPoint({ x: event.clientX - state.dx, y: event.clientY - state.dy }, area, size);
            const place = placeOf(dropped, area, size);
            const next = pointOf(place, area, size);
            chosen.current = place;
            // The place still works for this session when site storage is blocked.
            writeStorage(PLACE_KEY, JSON.stringify(place));
            if (dropped.x !== next.x || dropped.y !== next.y) {
                snapFrom.current = dropped;
            }
            setPos(next);
            setSide(place.side);
        }
    };

    return (
        <>
            <div
                key="toolbar"
                ref={rootRef}
                class={`floating-toolbar mobile ${open ? 'open' : ''} ${dragging ? 'dragging' : ''}`}
                data-side={side}
                style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
            >
                <div class="floating-toolbar-safearea" aria-hidden="true" />
                <div
                    id="stream-controls"
                    class="floating-toolbar-panel"
                    ref={panelRef}
                    hidden={!panelPresent}
                    aria-hidden={!open}
                    data-exiting={!open || undefined}
                    style={panelStyle}
                    role="group"
                    aria-label={CONTROLS_LABEL}
                >
                    <div class="floating-toolbar-heading">{CONTROLS_LABEL}</div>
                    <div class="control-buttons-list floating">
                        {shownControls(controls).map(({ definition, action }) => (
                            <ControlButton
                                key={definition.id}
                                definition={definition}
                                action={action}
                                held={controls.held}
                                style={{
                                    gridRow: String(definition.slot.row),
                                    gridColumn: String(definition.slot.column),
                                }}
                            />
                        ))}
                    </div>
                </div>
                <button
                    ref={fabRef}
                    type="button"
                    class={`${iconButtonClass()} floating-toolbar-fab`}
                    data-idle={(!awake && !open) || undefined}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onLostPointerCapture={() => {
                        if (dragState.current) {
                            suppressClick.current = true;
                            dragState.current = undefined;
                            setDragging(false);
                            setPressing(false);
                            layout();
                        }
                    }}
                    onClick={(event) => {
                        if (suppressClick.current && event.detail !== 0) {
                            suppressClick.current = false;
                            return;
                        }
                        if (!open) {
                            openedOverSheet.current = sheetOpen;
                        }
                        setOpen((v) => !v);
                        if (event.detail === 0 && !open) {
                            requestAnimationFrame(() =>
                                panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus(),
                            );
                        }
                    }}
                    aria-expanded={open}
                    aria-controls="stream-controls"
                    aria-label={CONTROLS_LABEL}
                    title="Drag to move, tap for controls"
                >
                    <Icon name={open ? 'close' : 'grid'} />
                </button>
            </div>
            {/* A sibling of the toolbar, not a child: it is sized by the stage (`.stream-stage`), so the
                header and the notices above the stage still take a press directly. */}
            {shieldShown && (
                <div
                    key="shield"
                    ref={shieldRef}
                    class="floating-toolbar-shield"
                    aria-hidden="true"
                    onPointerDown={onShieldDown}
                    onPointerUp={onShieldUp}
                    onPointerCancel={onShieldUp}
                    onLostPointerCapture={onShieldUp}
                />
            )}
        </>
    );
}
