/**
 * How the rows of a list lie in its body: items per line, the distance from the top of one
 * line to the next, the gap between two lines, and the space above the first line. `pitch` is
 * the mean over the lines measured; it stands for each line that was not measured yet.
 */
export type RowGeometry = { columns: number; pitch: number; gap: number; padding: number };

/** The items to build rows for, `[from, to)`, and the heights that stand in for the lines before and after them. */
export type RowRange = { from: number; to: number; before: number; after: number };

/**
 * Which rows of a long list are in the document. A list of more than `FROM` items has the lines
 * in view and `MARGIN` lines on each side; the lines before and after them are one spacer each,
 * as tall as the lines it stands for, so the list scrolls as if every row were there. A shorter
 * list has every row.
 *
 * The lines of a list need not be of one height: a tile with a name of one line is shorter than
 * one with two, and a folder tile has no size. Each line that was in the document is kept at
 * the pitch it measured, and the others are taken at the mean. A line that leaves the view at
 * the top while the owner scrolls down is then in the spacer at its true height, so what is in
 * view does not move when the rows change.
 */
export class RowWindow {
    /** Lists up to this length have every row. */
    public static readonly FROM = 200;
    /** Lines kept in the document beyond each edge of the view. */
    public static readonly MARGIN = 10;

    /** The lines in the document, from the last range. */
    private shown?: { first: number; last: number; columns: number };
    /** The pitch each line measured, for one list in one number of columns. */
    private lines: { list?: readonly unknown[]; columns: number; pitches: number[] } = { columns: 0, pitches: [] };

    public static windowed(length: number): boolean {
        return length > RowWindow.FROM;
    }

    /**
     * Whether rows that measure as `measured` still lie as `assumed` says, so the range stands.
     * A first measure must match closely. After that the mean pitch differs a little at each
     * place in a list whose lines differ in height. Taking each new mean would resize the lines
     * not yet measured while the owner scrolls, so it stands until the rows lie in other
     * columns or their lines are a tenth taller or shorter.
     */
    public static fits(assumed: RowGeometry, measured: RowGeometry, settled: boolean): boolean {
        if (measured.columns !== assumed.columns || Math.abs(measured.padding - assumed.padding) >= 0.5) {
            return false;
        }
        if (settled) {
            return Math.abs(measured.pitch - assumed.pitch) <= assumed.pitch / 10;
        }
        return Math.abs(measured.pitch - assumed.pitch) < 0.5 && Math.abs(measured.gap - assumed.gap) < 0.5;
    }

    /** Forgets the last range. */
    public reset(): void {
        this.shown = undefined;
    }

    /** Forgets the last range and every line measured: the rows lie in another way now. */
    public forget(): void {
        this.shown = undefined;
        this.lines = { columns: 0, pitches: [] };
    }

    /** Keeps the pitch of lines of `list` measured in the document, `pitches[0]` for line `from`. */
    public measured(list: readonly unknown[], columns: number, from: number, pitches: number[]): void {
        if (this.lines.list !== list || this.lines.columns !== columns) {
            this.lines = { list, columns, pitches: [] };
        }
        pitches.forEach((pitch, index) => {
            if (pitch > 0) {
                this.lines.pitches[from + index] = pitch;
            }
        });
    }

    /** Where line `line` of `list` starts, from the top of the body. */
    public offset(list: readonly unknown[], line: number, geometry: RowGeometry): number {
        const pitchOf = this.pitchOf(list, geometry);
        let offset = geometry.padding;
        for (let index = 0; index < line; index++) {
            offset += pitchOf(index);
        }
        return offset;
    }

    /**
     * The range for `list` laid out by `geometry`. `view` is the part of the body in view,
     * measured from the top of the body.
     */
    public range(list: readonly unknown[], view: { top: number; bottom: number }, geometry: RowGeometry): RowRange {
        const { columns, gap, padding } = geometry;
        const length = list.length;
        const lines = Math.max(1, Math.ceil(length / columns));
        const pitchOf = this.pitchOf(list, geometry);
        // The lines at the top and at the bottom of the view.
        let top = lines - 1;
        let bottom = lines - 1;
        let found = false;
        for (let line = 0, start = padding; line < lines; line++) {
            const end = start + pitchOf(line);
            if (!found && end > view.top) {
                top = line;
                found = true;
            }
            if (end > view.bottom) {
                bottom = line;
                break;
            }
            start = end;
        }
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
        const span = (from: number, to: number) => {
            let total = 0;
            for (let line = from; line < to; line++) {
                total += pitchOf(line);
            }
            return total;
        };
        return {
            from: first * columns,
            to: Math.min(length, (last + 1) * columns),
            before: first > 0 ? Math.max(0, span(0, first) - gap) : 0,
            after: last < lines - 1 ? Math.max(0, span(last + 1, lines) - gap) : 0,
        };
    }

    /** The pitch of each line of `list`: as measured, or the mean of `geometry`. */
    private pitchOf(list: readonly unknown[], geometry: RowGeometry): (line: number) => number {
        const known = this.lines.list === list && this.lines.columns === geometry.columns ? this.lines.pitches : [];
        return (line) => known[line] ?? geometry.pitch;
    }
}
