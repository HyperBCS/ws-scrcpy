/**
 * How the rows of a list lie in its body: items per line, the distance from the top of one
 * line to the next, the gap between two lines, and the space above the first line.
 */
export type RowGeometry = { columns: number; pitch: number; gap: number; padding: number };

/** The items to build rows for, `[from, to)`, and the heights that stand in for the lines before and after them. */
export type RowRange = { from: number; to: number; before: number; after: number };

/**
 * Which rows of a long list are in the document. A list of more than `FROM` items has the lines
 * in view and `MARGIN` lines on each side; the lines before and after them are one spacer each,
 * as tall as the lines it stands for, so the list scrolls as if every row were there. A shorter
 * list has every row.
 */
export class RowWindow {
    /** Lists up to this length have every row. */
    public static readonly FROM = 200;
    /** Lines kept in the document beyond each edge of the view. */
    public static readonly MARGIN = 10;

    /** The lines in the document, from the last range. */
    private shown?: { first: number; last: number; columns: number };

    public static windowed(length: number): boolean {
        return length > RowWindow.FROM;
    }

    /** Forgets the last range. */
    public reset(): void {
        this.shown = undefined;
    }

    /**
     * The range for a list of `length` items laid out by `geometry`. `view` is the part of the
     * body in view, measured from the top of the body.
     */
    public range(length: number, view: { top: number; bottom: number }, geometry: RowGeometry): RowRange {
        const { columns, pitch, gap, padding } = geometry;
        const lines = Math.max(1, Math.ceil(length / columns));
        const lineAt = (offset: number) => Math.min(lines - 1, Math.max(0, Math.floor((offset - padding) / pitch)));
        const top = lineAt(view.top);
        const bottom = Math.max(top, lineAt(view.bottom));
        const kept = this.shown;
        const near = RowWindow.MARGIN / 2;
        let first = Math.max(0, top - RowWindow.MARGIN);
        let last = Math.min(lines - 1, bottom + RowWindow.MARGIN);
        // A small scroll keeps the range until the view comes near one of its edges, so rows
        // are added and taken away several lines at a time, not on every scroll event.
        if (
            kept &&
            kept.columns === columns &&
            kept.last <= lines - 1 &&
            top >= kept.first &&
            bottom <= kept.last &&
            (top - kept.first >= near || kept.first === 0) &&
            (kept.last - bottom >= near || kept.last === lines - 1)
        ) {
            first = kept.first;
            last = kept.last;
        }
        this.shown = { first, last, columns };
        return {
            from: first * columns,
            to: Math.min(length, (last + 1) * columns),
            before: first > 0 ? Math.max(0, first * pitch - gap) : 0,
            after: last < lines - 1 ? Math.max(0, (lines - 1 - last) * pitch - gap) : 0,
        };
    }
}
