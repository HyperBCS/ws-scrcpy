import { InteractionEvents, KeyEventNames, InteractionHandler } from './InteractionHandler';
import { BasePlayer } from '../player/BasePlayer';
import { ControlMessage } from '../controlMessage/ControlMessage';
import { TouchControlMessage } from '../controlMessage/TouchControlMessage';
import { KeyCodeControlMessage } from '../controlMessage/KeyCodeControlMessage';
import KeyEvent from '../googDevice/android/KeyEvent';
import MotionEvent from '../MotionEvent';
import ScreenInfo from '../ScreenInfo';
import { ScrollControlMessage } from '../controlMessage/ScrollControlMessage';
import { MOUSE_CONTRACT } from '../input/mouseContract';

const TAG = '[FeaturedTouchHandler]';

export interface InteractionHandlerListener {
    sendMessage: (message: ControlMessage) => void;
}

/**
 * Pointer input on an Android phone's picture, as scrcpy touch and scroll messages. The mouse
 * follows `MOUSE_CONTRACT.android`: the wheel scrolls, a drag that leaves the picture keeps going
 * along its edge until the button is let go, right-click is Back, and Ctrl+drag pinches.
 */
export class FeaturedInteractionHandler extends InteractionHandler {
    // `mouseup` and the moves of a drag are read from `window` while the button is held (see
    // `onWindowMouse`); a press is only taken on the picture.
    private static readonly touchEventsNames: InteractionEvents[] = [
        'touchstart',
        'touchend',
        'touchmove',
        'touchcancel',
        'mousedown',
        'mousemove',
        'wheel',
    ];
    private static readonly keyEventsNames: KeyEventNames[] = ['keydown', 'keyup'];
    /** At most one scroll message per this many ms; a trackpad reports far more often. */
    public static SCROLL_EVENT_THROTTLING_TIME = 30;
    /** A pause this long ends a scroll. What was not yet sent from it is dropped. */
    private static readonly SCROLL_IDLE_RESET_TIME = 200;
    // What one notch of a mouse wheel reports. Chrome and Safari use pixels (about 100 per
    // notch), Firefox uses lines (3 per notch), and a page is treated as ten notches.
    private static readonly WHEEL_PIXELS_PER_NOTCH = 100;
    private static readonly WHEEL_LINES_PER_NOTCH = 3;
    private static readonly WHEEL_NOTCHES_PER_PAGE = 10;
    private readonly storedFromMouseEvent = new Map<number, TouchControlMessage>();
    private readonly storedFromTouchEvent = new Map<number, TouchControlMessage>();
    private pendingScroll = { hScroll: 0, vScroll: 0, time: 0 };
    private lastScrollSentAt = 0;
    /** The primary button went down on the picture and has not come up. */
    private mouseActive = false;

    constructor(
        player: BasePlayer,
        public readonly listener: InteractionHandlerListener,
    ) {
        super(player, FeaturedInteractionHandler.touchEventsNames, FeaturedInteractionHandler.keyEventsNames);
        this.tag.addEventListener('mouseleave', this.onMouseLeave);
        this.tag.addEventListener('mouseenter', this.onMouseEnter);
    }

    /** A wheel delta in mouse wheel notches. `deltaMode` is 0 for pixels, 1 for lines, 2 for pages. */
    public static wheelNotches(delta: number, deltaMode: number): number {
        if (deltaMode === 1) {
            return delta / FeaturedInteractionHandler.WHEEL_LINES_PER_NOTCH;
        }
        if (deltaMode === 2) {
            return delta * FeaturedInteractionHandler.WHEEL_NOTCHES_PER_PAGE;
        }
        return delta / FeaturedInteractionHandler.WHEEL_PIXELS_PER_NOTCH;
    }

    /**
     * One wheel notch is one scrcpy notch. Deltas between two messages are added up, so a
     * trackpad's many small steps scroll by their total and not by one full notch each.
     */
    public buildScrollEvent(event: WheelEvent, screenInfo: ScreenInfo): ScrollControlMessage[] {
        const touch = this.buildTouchOnClient(event, screenInfo);
        if (!touch) {
            return [];
        }
        const time = Date.now();
        const pending = this.pendingScroll;
        if (time - pending.time > FeaturedInteractionHandler.SCROLL_IDLE_RESET_TIME) {
            pending.hScroll = 0;
            pending.vScroll = 0;
        }
        // The browser's deltaY is positive for scrolling down, Android's AXIS_VSCROLL for scrolling
        // up. Both use positive for scrolling right (AXIS_HSCROLL, as scrcpy passes SDL's x).
        pending.hScroll += FeaturedInteractionHandler.wheelNotches(event.deltaX, event.deltaMode);
        pending.vScroll -= FeaturedInteractionHandler.wheelNotches(event.deltaY, event.deltaMode);
        pending.time = time;
        if (time - this.lastScrollSentAt <= FeaturedInteractionHandler.SCROLL_EVENT_THROTTLING_TIME) {
            return [];
        }
        const max = ScrollControlMessage.MAX_NOTCHES;
        const hScroll = Math.max(-max, Math.min(max, pending.hScroll));
        const vScroll = Math.max(-max, Math.min(max, pending.vScroll));
        if (!hScroll && !vScroll) {
            return [];
        }
        pending.hScroll = 0;
        pending.vScroll = 0;
        this.lastScrollSentAt = time;
        return [new ScrollControlMessage(touch.position, hScroll, vScroll)];
    }

    protected onInteraction(event: MouseEvent | TouchEvent): void {
        const screenInfo = this.player.getScreenInfo();
        if (!screenInfo) {
            return;
        }
        let messages: ControlMessage[];
        if (event instanceof MouseEvent) {
            if (event.target !== this.tag) {
                return;
            }
            messages = this.onMouse(event, screenInfo);
            if (this.over) {
                this.lastPosition = event;
            }
        } else if (window['TouchEvent'] && event instanceof TouchEvent) {
            // The bands beside the picture count too, so that a swipe in from an edge works.
            if (!this.isTouchTarget(event.target)) {
                return;
            }
            messages = this.formatTouchEvent(event, screenInfo, this.storedFromTouchEvent);
        } else {
            console.error(TAG, 'Unsupported event', event);
            return;
        }
        if (event.cancelable) {
            event.preventDefault();
        }
        event.stopPropagation();
        messages.forEach((message) => {
            this.listener.sendMessage(message);
        });
    }

    /** A wheel, a press or a move on the picture. */
    private onMouse(event: MouseEvent, screenInfo: ScreenInfo): ControlMessage[] {
        if (window['WheelEvent'] && event instanceof WheelEvent) {
            return this.buildScrollEvent(event, screenInfo);
        }
        if (event.type === 'mousedown') {
            if (event.button === 2) {
                return MOUSE_CONTRACT.android.rightClick === 'back' ? this.back() : [];
            }
            if (event.button !== 0 || this.mouseActive) {
                return [];
            }
            this.setMouseActive(true);
            // The press sets the pinch's centre, as on an iPhone: the middle, or with Shift the
            // point pressed. A centre left from hovering or from the last pinch does not count.
            this.resetPinch();
            return this.buildMouseTouch(event, screenInfo, this.storedFromMouseEvent);
        }
        if (!this.mouseActive) {
            // Hovering: nothing is sent, but with Ctrl held the pinch's fingers are shown where
            // a press here would put them.
            this.resetPinch();
            this.buildMouseTouch(event, screenInfo, new Map());
        }
        // During a drag the window listener sends the move.
        return [];
    }

    /** The Back key, pressed and let go, as the Back control sends it. No touch goes with it. */
    private back(): ControlMessage[] {
        return [KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP].map(
            (action) => new KeyCodeControlMessage(action, KeyEvent.KEYCODE_BACK, 0, 0),
        );
    }

    /** Ctrl pinches where the contract says Android can. */
    private buildMouseTouch(
        event: MouseEvent,
        screenInfo: ScreenInfo,
        storage: Map<number, TouchControlMessage>,
    ): TouchControlMessage[] {
        return this.buildTouchEvent(event, screenInfo, storage, event.ctrlKey && MOUSE_CONTRACT.android.pinch);
    }

    private setMouseActive(active: boolean): void {
        if (active === this.mouseActive) {
            return;
        }
        this.mouseActive = active;
        if (active) {
            window.addEventListener('mousemove', this.onWindowMouse, true);
            window.addEventListener('mouseup', this.onWindowMouse, true);
        } else {
            window.removeEventListener('mousemove', this.onWindowMouse, true);
            window.removeEventListener('mouseup', this.onWindowMouse, true);
        }
    }

    /**
     * Follows a held button anywhere in the window. A point beside the picture rides its edge,
     * and the touch ends where the button comes up.
     */
    private onWindowMouse = (event: MouseEvent): void => {
        if (!this.mouseActive || (event.type === 'mouseup' && event.button !== 0)) {
            return;
        }
        const screenInfo = this.player.getScreenInfo();
        if (!screenInfo) {
            return;
        }
        const messages = this.buildMouseTouch(event, screenInfo, this.storedFromMouseEvent);
        if (event.type === 'mouseup') {
            this.setMouseActive(false);
        }
        event.preventDefault();
        messages.forEach((message) => this.listener.sendMessage(message));
    };

    protected onKey(event: KeyboardEvent): void {
        if (!this.lastPosition) {
            return;
        }
        const screenInfo = this.player.getScreenInfo();
        if (!screenInfo) {
            return;
        }
        const { ctrlKey, shiftKey } = event;
        const { target, button, buttons, clientY, clientX } = this.lastPosition;
        const type = InteractionHandler.SIMULATE_MULTI_TOUCH;
        const props = { ctrlKey, shiftKey, type, target, button, buttons, clientX, clientY };
        if (!this.mouseActive) {
            // The preview follows the keys: Shift held or let go moves its centre.
            this.resetPinch();
        }
        this.buildTouchEvent(props, screenInfo, new Map(), ctrlKey && MOUSE_CONTRACT.android.pinch);
    }

    private onMouseEnter = (): void => {
        this.over = true;
    };
    private onMouseLeave = (): void => {
        this.lastPosition = undefined;
        this.over = false;
        // A drag goes on outside the picture, and so does the drawing of its pinch.
        if (!this.mouseActive) {
            this.clearCanvas();
        }
    };

    public releaseActiveTouch(): void {
        this.endEverything(true);
    }

    public forgetActiveTouch(): void {
        this.endEverything(false);
    }

    /** Ends every touch and the drag once; with `send`, the phone is told with one up each. */
    private endEverything(send: boolean): void {
        this.setMouseActive(false);
        for (const storage of [this.storedFromMouseEvent, this.storedFromTouchEvent]) {
            const held = Array.from(storage.values());
            storage.clear();
            if (send) {
                held.forEach((message) =>
                    this.listener.sendMessage(InteractionHandler.createEmulatedMessage(MotionEvent.ACTION_UP, message)),
                );
            }
        }
        this.clearEdgeStarts();
        this.resetPinch();
    }

    public release(): void {
        super.release();
        this.tag.removeEventListener('mouseleave', this.onMouseLeave);
        this.tag.removeEventListener('mouseenter', this.onMouseEnter);
    }
}
