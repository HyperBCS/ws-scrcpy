/**
 * Ends a button hold. `send` says whether the device can still be told: false after the stream
 * disconnected, when the release would be dropped or replayed into a different session.
 * Must do nothing when its button is not held.
 */
export type EndHold = (send: boolean) => void;

/**
 * Toolbar buttons that send "down" when pressed and "up" when let go. The "up" depends on a
 * pointer event that does not always come: the window can lose focus or the page can be hidden
 * with the pointer still down. This releases every held button in those cases, and both stream
 * clients call `forgetAll()` when their connection drops.
 */
export class HeldButtons {
    private readonly holds = new Set<EndHold>();

    constructor() {
        window.addEventListener('blur', this.releaseAll);
        window.addEventListener('pagehide', this.releaseAll);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    public add(end: EndHold): void {
        this.holds.add(end);
    }

    /** Lets go of every held button and tells the device. */
    public releaseAll = (): void => {
        this.holds.forEach((end) => end(true));
    };

    /** Drops every hold without sending anything; the server releases what the device still holds. */
    public forgetAll(): void {
        this.holds.forEach((end) => end(false));
    }

    private onVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') {
            this.releaseAll();
        }
    };

    public destroy(): void {
        window.removeEventListener('blur', this.releaseAll);
        window.removeEventListener('pagehide', this.releaseAll);
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.releaseAll();
        this.holds.clear();
    }
}
