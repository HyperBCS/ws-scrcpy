import { ComponentChildren } from 'preact';
import '../../style/views/ToolView.css';

// Each view of a page draws the strip itself, so a press on a tab removes the strip with its
// view, and the view shown next draws another. That strip stands in for the one before: it does
// not play the row's entrance again, and it takes the focus if the pressed tab had it.
const HANDOVER_MS = 1000;
const pressed = { at: -HANDOVER_MS, focused: false };

function handedOver(): boolean {
    return performance.now() - pressed.at < HANDOVER_MS;
}

function standIn(strip: HTMLElement | null): void {
    if (strip && handedOver()) {
        strip.style.animation = 'none';
    }
}

function takeFocus(tab: HTMLElement | null): void {
    if (tab && pressed.focused && handedOver()) {
        pressed.focused = false;
        tab.focus({ preventScroll: true });
    }
}

export interface Tab<T extends string> {
    id: T;
    title: string;
    /** Shown on hover. */
    hint?: string;
}

interface TabStripProps<T extends string> {
    /** Names the row for assistive technology, for example "Phone views". */
    label: string;
    tabs: ReadonlyArray<Tab<T>>;
    current: T;
    onSelect: (id: T) => void;
    /** Shown at the end of the row: the connection state of the tab that is open. */
    children?: ComponentChildren;
}

/**
 * The tabs under the header. This is the tool page's navigation row as a component. It keeps
 * that row's class names; its rules stay in `ToolView.css`, where they share selectors with the
 * rest of the tool page.
 */
export function TabStrip<T extends string>({ label, tabs, current, onSelect, children }: TabStripProps<T>) {
    return (
        <nav ref={standIn} class="tool-navigation" aria-label={label}>
            <div class="tool-tabs">
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        type="button"
                        title={tab.hint}
                        aria-current={tab.id === current ? 'page' : undefined}
                        ref={tab.id === current ? takeFocus : undefined}
                        onClick={(event?: MouseEvent) => {
                            if (tab.id !== current) {
                                pressed.at = performance.now();
                                // A tap in Safari gives a button no focus, and then none is handed on.
                                pressed.focused = !!event && document.activeElement === event.currentTarget;
                            }
                            onSelect(tab.id);
                        }}
                    >
                        {tab.title}
                    </button>
                ))}
            </div>
            {children}
        </nav>
    );
}
