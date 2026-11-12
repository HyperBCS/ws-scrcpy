import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * The target of a sheet, kept while the sheet plays its exit. A sheet is closed by clearing its
 * target, and without the last one its content would go blank as it slides away. `inside` is an
 * element in the sheet's body: once its dialog has closed, the last target is let go, so a closed
 * sheet holds no stale content (a hidden "Connected" would still be found by text). Any sheet
 * opened by a signal can use it.
 */
export function useRetainedTarget<T>(target: T | undefined, inside: { current: Element | null }): T | undefined {
    const last = useRef(target);
    const [, setReleased] = useState(0);
    if (target !== undefined) {
        last.current = target;
    }

    useEffect(() => {
        if (target !== undefined || last.current === undefined) {
            return;
        }
        const release = () => {
            last.current = undefined;
            setReleased((count) => count + 1);
        };
        const dialog = inside.current?.closest('dialog');
        if (!dialog?.open) {
            release();
            return;
        }
        // The sheet closes its dialog when the exit has played.
        dialog.addEventListener('close', release, { once: true });
        return () => dialog.removeEventListener('close', release);
    }, [target]);

    return target ?? last.current;
}
