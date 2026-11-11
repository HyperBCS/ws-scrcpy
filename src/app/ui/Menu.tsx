import { ComponentChildren, RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import '../../style/kit/Menu.css';
import { stopRemoteInteraction } from './dialogFocus';
import { openOverlay } from './overlayHistory';
import { usePresence } from './Presence';

/** A menu opens at its button, or at a point for a context menu. */
export type MenuAnchor = HTMLElement | { x: number; y: number };

// Checkbox and radio items count: the role starts with "menuitem".
const ITEMS = '[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])';
/** Between the button and the menu, and between the menu and the edge of the window. */
const GAP = 4;
const EDGE = 8;

// Menus on screen, so the sheet that holds one can close it before it closes itself.
const openMenus = new Map<HTMLElement, () => void>();

/**
 * Closes the menus shown inside `container`, if there are any. A sheet calls this when the
 * browser asks it to close: the menu goes first and the sheet stays.
 */
export function closeMenusIn(container: HTMLElement): boolean {
    let closed = false;
    openMenus.forEach((close, menu) => {
        if (container.contains(menu)) {
            close();
            closed = true;
        }
    });
    return closed;
}

/** Under the button and in line with its left edge; moved only as far as the window needs. */
function placeMenu(menu: HTMLElement, anchor: MenuAnchor): void {
    const at = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : new DOMRect(anchor.x, anchor.y, 0, 0);
    const gap = anchor instanceof HTMLElement ? GAP : 0;
    const page = document.documentElement;
    // Layout size, not the painted one: the menu scales while it opens.
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = at.left + width > page.clientWidth - EDGE ? at.right - width : at.left;
    const below = at.bottom + gap;
    const above = at.top - gap - height;
    const top = below + height > page.clientHeight - EDGE && above >= EDGE ? above : below;
    menu.style.left = `${Math.max(EDGE, Math.min(left, page.clientWidth - width - EDGE))}px`;
    menu.style.top = `${Math.max(EDGE, Math.min(top, page.clientHeight - height - EDGE))}px`;
}

/**
 * What an open menu does, for markup built by any code: an element with the class `kit-menu`
 * and the role `menu`, holding `kit-menu-item` buttons with a `menuitem` role.
 *
 * The menu is placed at `anchor` in the top layer, so no sheet or scrolling parent covers or
 * cuts it. The first item takes focus and the arrow keys, Home and End move it. Escape, Tab, a
 * press outside, a scroll outside and the browser's Back ask for it to close through
 * `onClose`. Presses in it do not reach the listeners that drive the phone.
 *
 * Call the result when the menu closes, however it closes: it ends all of this and returns
 * focus to the button. The caller hides or removes the element.
 */
export function bindMenu(menu: HTMLElement, anchor: MenuAnchor, onClose: () => void): () => void {
    const opener = anchor instanceof HTMLElement ? anchor : null;
    if (typeof menu.showPopover === 'function') {
        menu.popover = 'manual';
        // Shown again, it is on top of whatever opened since.
        if (menu.matches(':popover-open')) {
            menu.hidePopover();
        }
        menu.showPopover();
    }
    const place = () => placeMenu(menu, anchor);
    place();
    const items = () => Array.from(menu.querySelectorAll<HTMLElement>(ITEMS));
    (items()[0] ?? menu).focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
        const options = items();
        const current = options.indexOf(document.activeElement as HTMLElement);
        const last = options.length - 1;
        if (event.key === 'ArrowDown') {
            options[current >= last ? 0 : current + 1]?.focus();
        } else if (event.key === 'ArrowUp') {
            options[current <= 0 ? last : current - 1]?.focus();
        } else if (event.key === 'Home') {
            options[0]?.focus();
        } else if (event.key === 'End') {
            options[last]?.focus();
        } else if ((event.key === 'Escape' && !event.isComposing) || event.key === 'Tab') {
            onClose();
        } else {
            return;
        }
        // The key is used up here: a sheet under the menu does not close on this Escape.
        event.preventDefault();
        event.stopPropagation();
    };
    const outside = (event: Event) => {
        const target = event.target;
        // A press on the button is the button's to answer: it closes the menu it opened.
        if (!(target instanceof Node) || (!menu.contains(target) && !opener?.contains(target))) {
            onClose();
        }
    };
    menu.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', outside, true);
    // The button moves with what scrolls; the menu would stay behind.
    document.addEventListener('scroll', outside, true);
    window.addEventListener('resize', place);
    const allowRemote = stopRemoteInteraction(menu);
    openMenus.set(menu, onClose);
    const entry = openOverlay(onClose);

    return () => {
        menu.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('scroll', outside, true);
        window.removeEventListener('resize', place);
        allowRemote();
        openMenus.delete(menu);
        entry.release();
        // After a press on another control, focus is that control's.
        const active = document.activeElement;
        if (opener?.isConnected && (!active || active === document.body || menu.contains(active))) {
            opener.focus({ preventScroll: true });
        }
    };
}

interface MenuProps {
    open: boolean;
    onClose: () => void;
    /** The button the menu belongs to, or a point for a context menu. */
    anchor: RefObject<HTMLElement> | { x: number; y: number };
    /** The accessible name. A menu has no title of its own. */
    label: string;
    children: ComponentChildren;
}

/**
 * The one menu. Render it next to its button and keep `open` in the caller; the button toggles
 * it. Choosing a `MenuItem` closes the menu; a checked item leaves it open.
 */
export function Menu({ open, onClose, anchor, label, children }: MenuProps) {
    const { ref, present } = usePresence<HTMLDivElement>(open, 'popover');
    const close = useRef(onClose);
    close.current = onClose;

    useLayoutEffect(() => {
        const menu = ref.current;
        const at = 'current' in anchor ? anchor.current : anchor;
        if (!open || !menu || !at) {
            return;
        }
        return bindMenu(menu, at, () => close.current());
    }, [open]);

    if (!present) {
        return null;
    }
    return (
        <div
            ref={ref}
            class="kit-menu"
            role="menu"
            aria-label={label}
            tabIndex={-1}
            data-exiting={!open || undefined}
            onClick={(event) => {
                const item = event.target instanceof Element ? event.target.closest('[role="menuitem"]') : null;
                if (item && !item.matches(':disabled')) {
                    onClose();
                }
            }}
        >
            {children}
        </div>
    );
}

interface MenuItemProps {
    onSelect: () => void;
    /** A setting that is on or off. The item shows a check and the menu stays open. */
    checked?: boolean;
    /** An action that removes something. */
    danger?: boolean;
    disabled?: boolean;
    children: ComponentChildren;
}

export function MenuItem({ onSelect, checked, danger = false, disabled = false, children }: MenuItemProps) {
    return (
        <button
            type="button"
            class={`kit-menu-item${danger ? ' kit-menu-danger' : ''}`}
            role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={checked}
            tabIndex={-1}
            disabled={disabled}
            onClick={onSelect}
        >
            {children}
        </button>
    );
}

export function MenuSeparator() {
    return <div class="kit-menu-separator" role="separator" />;
}
