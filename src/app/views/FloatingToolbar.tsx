import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { deviceSwitcherOpen, liveTextOpen, streamConnected, toolsSheetOpen } from '../state/stream';
import { settingsSheetTarget } from '../state/settingsSheet';
import '../../style/views/FloatingToolbar.css';

const STORAGE_KEY = 'floating_toolbar_position';
const DRAG_THRESHOLD_PX = 6;
const FAB_SIZE = 56;
const EDGE_MARGIN = 12;
// Width alone misclassifies both wide iPads and narrow desktop browser windows.
const MOBILE_CONTROLS_QUERY = '(hover: none) and (pointer: coarse)';

interface Position {
    x: number;
    y: number;
}

function viewport() {
    const visual = window.visualViewport;
    const probe = document.querySelector('.floating-toolbar-safearea');
    const style = probe ? getComputedStyle(probe) : undefined;
    const inset = (side: 'Top' | 'Right' | 'Bottom' | 'Left') =>
        Math.max(EDGE_MARGIN, parseFloat(style?.[`padding${side}`] || '0') || 0);
    return {
        left: (visual?.offsetLeft || 0) + inset('Left'),
        top: (visual?.offsetTop || 0) + inset('Top'),
        right: (visual?.offsetLeft || 0) + (visual?.width || window.innerWidth) - inset('Right'),
        bottom: (visual?.offsetTop || 0) + (visual?.height || window.innerHeight) - inset('Bottom'),
    };
}

function clamp(pos: Position): Position {
    const bounds = viewport();
    return {
        x: Math.min(Math.max(pos.x, bounds.left), Math.max(bounds.left, bounds.right - FAB_SIZE)),
        y: Math.min(Math.max(pos.y, bounds.top), Math.max(bounds.top, bounds.bottom - FAB_SIZE)),
    };
}

function loadPosition(): Position {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : undefined;
        if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) {
            return clamp(parsed);
        }
    } catch {
        // Blocked storage should never prevent access to device controls.
    }
    return clamp({ x: window.innerWidth - FAB_SIZE - 16, y: window.innerHeight - FAB_SIZE - 32 });
}

export interface ToolbarClient {
    getControlButtonsElement(): HTMLElement | undefined;
}

interface FloatingToolbarProps {
    client: ToolbarClient;
}

/** Adopts the protocol toolbox so labels and layout can evolve without duplicating its commands. */
export function FloatingToolbar({ client }: FloatingToolbarProps) {
    const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_CONTROLS_QUERY).matches);
    const [pos, setPos] = useState<Position>(loadPosition);
    const [open, setOpen] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [panelStyle, setPanelStyle] = useState({ left: '12px', top: '12px', maxHeight: '70dvh' });
    const rootRef = useRef<HTMLDivElement>(null);
    const hostRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const fabRef = useRef<HTMLButtonElement>(null);
    const suppressClick = useRef(false);
    const dragState = useRef<{ dx: number; dy: number; start: Position; moved: boolean; id: number }>();
    const sheetOpen =
        toolsSheetOpen.value || deviceSwitcherOpen.value || liveTextOpen.value || !!settingsSheetTarget.value;
    const connected = streamConnected.value;

    useLayoutEffect(() => {
        // Connecting a mouse can change the control layout without changing window dimensions.
        // Notify the client's existing debounced resize path after the sidebar space changes.
        window.dispatchEvent(new Event('resize'));
    }, [mobile]);

    useEffect(() => {
        const media = window.matchMedia(MOBILE_CONTROLS_QUERY);
        const update = () => {
            setMobile(media.matches);
            setOpen(false);
            setDragging(false);
            dragState.current = undefined;
        };
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);

    useEffect(() => {
        const host = hostRef.current;
        const controls = client.getControlButtonsElement();
        if (host && controls && controls.parentElement !== host) {
            controls.classList.add('floating');
            controls.querySelectorAll<HTMLElement>('.control-button').forEach((button) => {
                const label = button.title || button.getAttribute('aria-label');
                if (label) {
                    button.setAttribute('aria-label', label);
                    if (!button.querySelector('.floating-control-label')) {
                        const caption = document.createElement('span');
                        caption.className = 'floating-control-label';
                        caption.textContent = label === 'Take screenshot' ? 'Screenshot' : label;
                        caption.setAttribute('aria-hidden', 'true');
                        button.appendChild(caption);
                    }
                }
            });
            host.replaceChildren(controls);
            setOpen(false);
            return () => {
                if (controls.parentElement === host) {
                    controls.remove();
                }
            };
        }
        return undefined;
    }, [client]);

    useEffect(() => {
        hostRef.current?.querySelectorAll<HTMLButtonElement>('button.control-button').forEach((button) => {
            if (
                [
                    'Power',
                    'Volume up',
                    'Volume down',
                    'Mute device',
                    'Back',
                    'Home',
                    'Overview',
                    'Lock',
                    'Siri',
                ].includes(button.title)
            ) {
                button.disabled = !connected;
            }
        });
    }, [client, connected]);

    useEffect(() => {
        if (sheetOpen) {
            setOpen(false);
        }
    }, [sheetOpen]);

    useEffect(() => {
        const resize = () => setPos((p) => clamp(p));
        resize();
        window.addEventListener('resize', resize);
        window.visualViewport?.addEventListener('resize', resize);
        window.visualViewport?.addEventListener('scroll', resize);
        return () => {
            window.removeEventListener('resize', resize);
            window.visualViewport?.removeEventListener('resize', resize);
            window.visualViewport?.removeEventListener('scroll', resize);
        };
    }, []);

    useLayoutEffect(() => {
        if (!mobile || !open || !panelRef.current) {
            return;
        }
        const bounds = viewport();
        const panel = panelRef.current;
        let maxHeight = bounds.bottom - bounds.top;
        const height = Math.min(panel.scrollHeight, maxHeight);
        const width = panel.getBoundingClientRect().width;
        const above = pos.y - height - 10;
        const below = pos.y + FAB_SIZE + 10;
        let top = above >= bounds.top ? above : below + height <= bounds.bottom ? below : bounds.top;
        let left = pos.x + FAB_SIZE - width;
        // A short landscape viewport may have no room above or below the FAB. Open beside
        // it where possible so the draggable button cannot cover a control in the grid.
        if (above < bounds.top && below + height > bounds.bottom) {
            if (pos.x - width - 10 >= bounds.left) {
                left = pos.x - width - 10;
            } else if (pos.x + FAB_SIZE + 10 + width <= bounds.right) {
                left = pos.x + FAB_SIZE + 10;
            } else {
                // A narrow, short screen cannot fit the full grid beside the button either.
                // Scroll the panel in the larger remaining space so no control sits under it.
                const availableAbove = pos.y - bounds.top - 10;
                const availableBelow = bounds.bottom - below;
                if (availableBelow >= availableAbove) {
                    maxHeight = Math.max(0, availableBelow);
                    top = below;
                } else {
                    maxHeight = Math.max(0, availableAbove);
                    top = bounds.top;
                }
            }
        }
        setPanelStyle({
            left: `${Math.max(bounds.left, Math.min(left, bounds.right - width))}px`,
            top: `${top}px`,
            maxHeight: `${maxHeight}px`,
        });
    }, [mobile, open, pos]);

    useEffect(() => {
        if (!mobile || !open) {
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
    }, [mobile, open]);

    const onPointerDown = (event: PointerEvent) => {
        if (!event.isPrimary || event.button !== 0) {
            return;
        }
        suppressClick.current = false;
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
        setPos(clamp(next));
    };

    const endDrag = (event: PointerEvent) => {
        const state = dragState.current;
        if (!state || state.id !== event.pointerId) {
            return;
        }
        dragState.current = undefined;
        setDragging(false);
        if (event.type === 'pointercancel') {
            suppressClick.current = true;
            return;
        }
        if (state.moved) {
            const next = clamp({ x: event.clientX - state.dx, y: event.clientY - state.dy });
            setPos(next);
            try {
                window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            } catch {
                // The position still works for this session when site storage is blocked.
            }
        }
    };

    return (
        <div
            ref={rootRef}
            class={`floating-toolbar ${mobile ? 'mobile' : 'desktop'} ${open ? 'open' : ''} ${dragging ? 'dragging' : ''}`}
            style={mobile ? { left: `${pos.x}px`, top: `${pos.y}px` } : undefined}
        >
            <div class="floating-toolbar-safearea" aria-hidden="true" />
            <div
                id="stream-controls"
                class="floating-toolbar-panel"
                ref={panelRef}
                hidden={mobile && !open}
                style={mobile ? panelStyle : undefined}
                role="group"
                aria-label="Device controls"
            >
                {mobile && (
                    <div class="floating-toolbar-heading">
                        <div>
                            <strong>Device controls</strong>
                            <span>Drag the blue button to move it</span>
                        </div>
                    </div>
                )}
                <div ref={hostRef} />
            </div>
            {mobile && (
                <button
                    ref={fabRef}
                    type="button"
                    class="floating-toolbar-fab"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onLostPointerCapture={() => {
                        if (dragState.current) {
                            suppressClick.current = true;
                            dragState.current = undefined;
                            setDragging(false);
                        }
                    }}
                    onClick={(event) => {
                        if (suppressClick.current && event.detail !== 0) {
                            suppressClick.current = false;
                            return;
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
                    aria-label={open ? 'Hide controls' : 'Show controls'}
                    title="Drag to move, tap for controls"
                >
                    <svg
                        class="floating-toolbar-glyph"
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        aria-hidden="true"
                    >
                        {open ? (
                            <path d="m6 6 12 12M6 18 18 6" />
                        ) : (
                            <>
                                <path d="M4 6h16M4 12h16M4 18h16" />
                                <circle cx="9" cy="6" r="2" />
                                <circle cx="15" cy="12" r="2" />
                                <circle cx="9" cy="18" r="2" />
                            </>
                        )}
                    </svg>
                </button>
            )}
        </div>
    );
}
