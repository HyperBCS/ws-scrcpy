// What the Devices page looked like when it was last left. The page unmounts on every route
// change, so its scroll position and open cards are kept here and put back on return. Module
// state on purpose: a reload starts at the top with every card closed.

let scrollTop = 0;
const openCards = new Set<string>();

export function rememberListScroll(value: number): void {
    scrollTop = value;
}

export function savedListScroll(): number {
    return scrollTop;
}

export function rememberCardOpen(key: string, open: boolean): void {
    if (open) {
        openCards.add(key);
    } else {
        openCards.delete(key);
    }
}

export function wasCardOpen(key: string): boolean {
    return openCards.has(key);
}
