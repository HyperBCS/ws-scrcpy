/**
 * A key of the phone, as a control presses it. `down` and `up` are what each platform sends;
 * this file only decides when.
 */
export interface KeyAction {
    kind: 'key';
    down(): void;
    up(): void;
    /**
     * A short press sent as one message. With it, a press becomes a hold only after
     * `HOLD_AFTER_MS` (the iPhone: its server applies the hold time of a press). Without it, the
     * key goes down at once and up when the press ends (Android).
     */
    tap?(): void;
}

/** How long a press on a key with `tap` lasts before it is sent as a hold. */
export const HOLD_AFTER_MS = 700;

interface Hold {
    action: KeyAction;
    down: boolean;
    timer?: ReturnType<typeof setTimeout>;
}

/**
 * The one place that turns a press on a control into down and up, for every key of the phone on
 * both platforms. A hold is a hold and a tap is a tap. A press ends once: on pointer up, pointer
 * cancel or lost capture (`end`), when the window loses focus or the page is hidden, and when
 * the panel that holds the control closes (`releaseAll`), or when the stream drops
 * (`forgetAll`). The pointer's own end does not always come, so the last three cannot wait for it.
 */
export class HeldButtons {
    private readonly holds = new Map<string, Hold>();

    constructor() {
        window.addEventListener('blur', this.releaseAll);
        window.addEventListener('pagehide', this.releaseAll);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    /** A pointer went down on control `id`. False when that control is already pressed. */
    public start(id: string, action: KeyAction): boolean {
        if (this.holds.has(id)) {
            return false;
        }
        const hold: Hold = { action, down: false };
        this.holds.set(id, hold);
        if (action.tap) {
            hold.timer = setTimeout(() => {
                hold.timer = undefined;
                hold.down = true;
                action.down();
            }, HOLD_AFTER_MS);
        } else {
            hold.down = true;
            action.down();
        }
        return true;
    }

    /** The pointer on control `id` came up or was cancelled: a hold ends, a short press is a tap. */
    public end(id: string): void {
        this.finish(id, true, true);
    }

    /** Keyboard or assistive activation: there is no pointer, so it is one tap. */
    public tap(action: KeyAction): void {
        if (action.tap) {
            action.tap();
        } else {
            action.down();
            action.up();
        }
    }

    /** Lets go of every held key and tells the phone. A press that was not yet a hold sends nothing. */
    public releaseAll = (): void => {
        Array.from(this.holds.keys()).forEach((id) => this.finish(id, true, false));
    };

    /** Drops every hold without sending anything: after a disconnect the server lets go of the key. */
    public forgetAll(): void {
        Array.from(this.holds.keys()).forEach((id) => this.finish(id, false, false));
    }

    public destroy(): void {
        window.removeEventListener('blur', this.releaseAll);
        window.removeEventListener('pagehide', this.releaseAll);
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.releaseAll();
    }

    private finish(id: string, send: boolean, byPointer: boolean): void {
        const hold = this.holds.get(id);
        if (!hold) {
            return;
        }
        this.holds.delete(id);
        if (hold.timer !== undefined) {
            clearTimeout(hold.timer);
        }
        if (hold.down) {
            if (send) {
                hold.action.up();
            }
        } else if (byPointer && hold.action.tap) {
            hold.action.tap();
        }
    }

    private onVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') {
            this.releaseAll();
        }
    };
}
