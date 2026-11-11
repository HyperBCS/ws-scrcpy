import { ComponentChildren } from 'preact';
import '../../style/views/ToolView.css';

export interface Tab<T extends string> {
    id: T;
    title: string;
    /** Shown on hover. */
    hint?: string;
}

interface TabStripProps<T extends string> {
    /** Names the row for assistive technology, for example "Device views". */
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
 * rest of the tool page, until the page itself moves onto this component.
 */
export function TabStrip<T extends string>({ label, tabs, current, onSelect, children }: TabStripProps<T>) {
    return (
        <nav class="tool-navigation" aria-label={label}>
            <div class="tool-tabs">
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        type="button"
                        title={tab.hint}
                        aria-current={tab.id === current ? 'page' : undefined}
                        onClick={() => onSelect(tab.id)}
                    >
                        {tab.title}
                    </button>
                ))}
            </div>
            {children}
        </nav>
    );
}
