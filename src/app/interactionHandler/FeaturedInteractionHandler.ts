import { InteractionEvents, KeyEventNames, InteractionHandler } from './InteractionHandler';
import { BasePlayer } from '../player/BasePlayer';
import { ControlMessage } from '../controlMessage/ControlMessage';
import { TouchControlMessage } from '../controlMessage/TouchControlMessage';
import MotionEvent from '../MotionEvent';
import ScreenInfo from '../ScreenInfo';
import { ScrollControlMessage } from '../controlMessage/ScrollControlMessage';

const TAG = '[FeaturedTouchHandler]';

export interface InteractionHandlerListener {
    sendMessage: (message: ControlMessage) => void;
}

export class FeaturedInteractionHandler extends InteractionHandler {
    private static readonly touchEventsNames: InteractionEvents[] = [
        'touchstart',
        'touchend',
        'touchmove',
        'touchcancel',
        'mousedown',
        'mouseup',
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
        const touchOnClient = this.buildTouchOnClient(event, screenInfo);
        if (!touchOnClient) {
            return [];
        }
        const time = Date.now();
        const pending = this.pendingScroll;
        if (time - pending.time > FeaturedInteractionHandler.SCROLL_IDLE_RESET_TIME) {
            pending.hScroll = 0;
            pending.vScroll = 0;
        }
        // A positive delta moves the content up or left, which Android reads as a negative axis.
        pending.hScroll -= FeaturedInteractionHandler.wheelNotches(event.deltaX, event.deltaMode);
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
        return [new ScrollControlMessage(touchOnClient.touch.position, hScroll, vScroll)];
    }

    protected onInteraction(event: MouseEvent | TouchEvent): void {
        const screenInfo = this.player.getScreenInfo();
        if (!screenInfo) {
            return;
        }
        let messages: ControlMessage[];
        let storage: Map<number, TouchControlMessage>;
        if (event instanceof MouseEvent) {
            if (event.target !== this.tag) {
                return;
            }
            if (window['WheelEvent'] && event instanceof WheelEvent) {
                messages = this.buildScrollEvent(event, screenInfo);
            } else {
                storage = this.storedFromMouseEvent;
                messages = this.buildTouchEvent(event, screenInfo, storage);
            }
            if (this.over) {
                this.lastPosition = event;
            }
        } else if (window['TouchEvent'] && event instanceof TouchEvent) {
            // The bands beside the picture count too, so that a swipe in from an edge works.
            if (!this.isTouchTarget(event.target)) {
                return;
            }
            storage = this.storedFromTouchEvent;
            messages = this.formatTouchEvent(event, screenInfo, storage);
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
        this.buildTouchEvent(props, screenInfo, new Map());
    }

    private onMouseEnter = (): void => {
        this.over = true;
    };
    private onMouseLeave = (): void => {
        this.lastPosition = undefined;
        this.over = false;
        this.storedFromMouseEvent.forEach((message) => {
            this.listener.sendMessage(InteractionHandler.createEmulatedMessage(MotionEvent.ACTION_UP, message));
        });
        this.storedFromMouseEvent.clear();
        this.clearCanvas();
    };

    public release(): void {
        super.release();
        this.tag.removeEventListener('mouseleave', this.onMouseLeave);
        this.tag.removeEventListener('mouseenter', this.onMouseEnter);
        this.storedFromMouseEvent.clear();
    }
}
