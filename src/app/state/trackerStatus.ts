import { signal } from '@preact/signals';

// The names of the servers that report they cannot reach adb, keyed by their tracker. A server
// in this state has no Android devices to list, and the list would otherwise only look empty.
export const adbUnavailable = signal<ReadonlyMap<object, string>>(new Map());

export function setAdbAvailable(tracker: object, name: string, available: boolean): void {
    const current = adbUnavailable.peek();
    if (available ? !current.has(tracker) : current.get(tracker) === name) {
        return;
    }
    const next = new Map(current);
    if (available) {
        next.delete(tracker);
    } else {
        next.set(tracker, name);
    }
    adbUnavailable.value = next;
}
