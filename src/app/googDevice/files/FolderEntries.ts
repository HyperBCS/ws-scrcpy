import { Entry } from '../Entry';
import { typeLabel } from '../client/fileTypes';

export type SortKey = 'name' | 'size' | 'type' | 'modified';

/** How the folder is shown: its order, the filter text (lower case) and whether dot names show. */
export type Arrangement = { sort: SortKey; ascending: boolean; showHidden: boolean; filter: string };

// The same comparisons `localeCompare` makes, made once instead of once per pair.
const NAMES = new Intl.Collator(undefined, { numeric: true });
const LABELS = new Intl.Collator();

/**
 * The items of the folder that is shown, by name, in the order the phone listed them. The list
 * that is shown is sorted once for each change of the items or of the order, and filtered once
 * for each change of the filter; asking for it again costs nothing.
 */
export class FolderEntries {
    private readonly byName = new Map<string, { entry: Entry; index: number }>();
    private next = 0;
    private arrangement: Arrangement = { sort: 'name', ascending: true, showHidden: false, filter: '' };
    private sorted?: Entry[];
    private shown?: Entry[];
    private shownNames?: Set<string>;
    private hidden?: number;
    /** How many times the items were sorted. */
    public sorts = 0;

    public get size(): number {
        return this.byName.size;
    }

    /** Adds items, or replaces the item that has the same name. A replaced item keeps its place. */
    public add(...entries: Entry[]): void {
        entries.forEach((entry) => {
            const known = this.byName.get(entry.name);
            this.byName.set(entry.name, { entry, index: known ? known.index : this.next++ });
        });
        if (entries.length) {
            this.changed();
        }
    }

    public clear(): void {
        this.byName.clear();
        this.next = 0;
        this.changed();
    }

    public get(name: string): Entry | undefined {
        return this.byName.get(name)?.entry;
    }

    /** Where the phone listed the item, counting from 0. */
    public indexOf(name: string): number {
        return this.byName.get(name)?.index ?? -1;
    }

    /** Every item, in the order the phone listed them. */
    public all(): Entry[] {
        return [...this.byName.values()].map(({ entry }) => entry);
    }

    /** Changes how the folder is shown. What did not change keeps its list. */
    public arrange(next: Arrangement): void {
        const now = this.arrangement;
        const order = next.sort !== now.sort || next.ascending !== now.ascending;
        if (order) {
            this.sorted = undefined;
        }
        // What is shown is filtered from the sorted list, so a new order shows anew too.
        if (order || next.showHidden !== now.showHidden || next.filter !== now.filter) {
            this.shown = undefined;
            this.shownNames = undefined;
        }
        this.arrangement = { ...next };
    }

    /** What the list shows, in its order: folders first, then by the chosen column. */
    public visible(): Entry[] {
        if (!this.shown) {
            const { showHidden, filter } = this.arrangement;
            this.shown = this.sortedEntries().filter(
                (entry) =>
                    (showHidden || !entry.name.startsWith('.')) &&
                    (!filter || entry.name.toLowerCase().includes(filter)),
            );
            this.shownNames = undefined;
        }
        return this.shown;
    }

    /** Whether the list shows the item. */
    public isShown(name: string): boolean {
        if (!this.shownNames) {
            this.shownNames = new Set(this.visible().map((entry) => entry.name));
        }
        return this.shownNames.has(name);
    }

    /** Items whose name starts with a dot, while those are not shown. */
    public hiddenCount(): number {
        if (this.arrangement.showHidden) {
            return 0;
        }
        if (this.hidden === undefined) {
            this.hidden = 0;
            this.byName.forEach(({ entry }) => {
                if (entry.name.startsWith('.')) this.hidden = (this.hidden as number) + 1;
            });
        }
        return this.hidden;
    }

    private changed(): void {
        this.sorted = undefined;
        this.shown = undefined;
        this.shownNames = undefined;
        this.hidden = undefined;
    }

    private sortedEntries(): Entry[] {
        if (this.sorted) {
            return this.sorted;
        }
        const { sort, ascending } = this.arrangement;
        const direction = ascending ? 1 : -1;
        // Each item's key is worked out once, not once for every comparison it takes part in.
        const items = [...this.byName.values()].map(({ entry }) => ({
            entry,
            folder: entry.isDirectory(),
            label: sort === 'type' ? typeLabel(entry) : '',
        }));
        items.sort((a, b) => {
            // Folders first in every order, the way Explorer groups them.
            const folders = Number(b.folder) - Number(a.folder);
            if (folders) {
                return folders;
            }
            let result = 0;
            if (sort === 'size') {
                result = (a.folder ? -1 : a.entry.size) - (b.folder ? -1 : b.entry.size);
            } else if (sort === 'modified') {
                result = a.entry.mtime.getTime() - b.entry.mtime.getTime();
            } else if (sort === 'type') {
                result = LABELS.compare(a.label, b.label);
            }
            return (result || NAMES.compare(a.entry.name, b.entry.name)) * direction;
        });
        this.sorts++;
        this.sorted = items.map(({ entry }) => entry);
        return this.sorted;
    }
}
