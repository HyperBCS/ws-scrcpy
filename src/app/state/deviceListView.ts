// Where the Phones list was scrolled when it was last left. The page unmounts on every route
// change, so the position is kept here and put back on return. Module state on purpose: a reload
// starts at the top.

let scrollTop = 0;

export function rememberListScroll(value: number): void {
    scrollTop = value;
}

export function savedListScroll(): number {
    return scrollTop;
}
