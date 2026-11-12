/**
 * The rows of a list, one element per item, kept by key. `show()` puts the rows of the items it
 * is given into the body in their order: a row that is already there stays as it is, a row that
 * is not wanted is taken out and kept for later, and only the items without a row, or whose item
 * changed, are built. Filtering and sorting therefore move rows instead of building them again,
 * and a row keeps its focus, its hover and the two clicks of a double click.
 */
export class KeyedRows<T> {
    private readonly rows = new Map<string, { item: T; element: HTMLElement }>();
    /** The rows `show()` put in the body, in their order. */
    private attached: HTMLElement[] = [];
    /** How many rows were built, for the tests. */
    public built = 0;

    constructor(
        private readonly body: HTMLElement,
        private readonly keyOf: (item: T) => string,
        /** Builds the rows of several items at once, in their order. */
        private readonly build: (items: T[]) => HTMLElement[],
        /** Whether a row built for `before` still shows `after`. */
        private readonly same: (before: T, after: T) => boolean,
    ) {}

    /**
     * Makes the body hold the rows of `items` in this order, between `edges.before` and
     * `edges.after` when they are given. Anything else in the body is taken out.
     */
    public show(items: T[], edges: { before?: HTMLElement; after?: HTMLElement } = {}): void {
        const missing: T[] = [];
        for (const item of items) {
            const row = this.rows.get(this.keyOf(item));
            if (!row || (row.item !== item && !this.same(row.item, item))) {
                missing.push(item);
            } else {
                row.item = item;
            }
        }
        if (missing.length) {
            const elements = this.build(missing);
            missing.forEach((item, index) => {
                const key = this.keyOf(item);
                this.rows.get(key)?.element.remove();
                this.rows.set(key, { item, element: elements[index] });
            });
            this.built += missing.length;
        }
        this.attached = items.map((item) => (this.rows.get(this.keyOf(item)) as { element: HTMLElement }).element);
        const wanted = [
            ...(edges.before ? [edges.before] : []),
            ...this.attached,
            ...(edges.after ? [edges.after] : []),
        ];
        // What is not wanted goes first, so the rows that stay do not move.
        const keep = new Set(wanted);
        for (const child of Array.from(this.body.children)) {
            if (!keep.has(child as HTMLElement)) {
                child.remove();
            }
        }
        let cursor = this.body.firstElementChild;
        for (const element of wanted) {
            if (element === cursor) {
                cursor = cursor.nextElementSibling;
            } else {
                this.body.insertBefore(element, cursor);
            }
        }
    }

    /** The row of an item, whether it is in the body or not. */
    public element(key: string): HTMLElement | undefined {
        return this.rows.get(key)?.element;
    }

    /** The rows that are in the body. */
    public shown(): readonly HTMLElement[] {
        return this.attached;
    }

    /** Forgets every row. Those in the body stay there until the next `show()`. */
    public clear(): void {
        this.rows.clear();
        this.attached = [];
    }
}
