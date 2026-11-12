import { InteractionEvents, InteractionHandler } from '../interactionHandler/InteractionHandler';
import { clientPointToVideo, elementBox, mirrorPoint, pictureCentre, VideoPoint } from '../input/pointMapper';
import { MOUSE_CONTRACT } from '../input/mouseContract';
import { WHEEL_SWIPE, wheelSwipePath } from '../input/wheelSwipe';
import { BasePlayer } from '../player/BasePlayer';
import Point from '../Point';
import Size from '../Size';
import { CoreDeviceContact } from '../../common/CoreDeviceProtocol';

export interface CoreDeviceTouchTarget {
    sendContacts(contacts: CoreDeviceContact[], videoSize: Size): void;
    sendTouch(op: 'contact' | 'release' | 'tap', x: number, y: number, videoSize: Size): void;
}

const TAG = '[CoreDeviceTouch]';

/** A Ctrl+drag: the pointer's finger and its mirror through `centre`, as one contact frame. */
interface Pinch {
    centre: VideoPoint;
    size: Size;
    contacts: [CoreDeviceContact, CoreDeviceContact];
}

/** The swipe a wheel gesture is running: the timer of its next step and where the finger is. */
interface Swipe {
    timer: ReturnType<typeof setTimeout>;
    at: VideoPoint;
    size: Size;
}

/**
 * Maps pointer input on the video canvas to CoreDevice touchscreen reports, following
 * `MOUSE_CONTRACT.ios`: a wheel gesture is one short swipe, a drag that leaves the picture keeps
 * going along its edge, right-click does nothing (an iPhone has no Back) and Ctrl+drag pinches
 * with two contacts.
 *
 * Touches go as complete contact frames with stable identities; moves are coalesced per frame.
 * A mouse drag uses the single-contact `touch` messages it always has.
 */
export class CoreDeviceInteractionHandler extends InteractionHandler {
    // Only `mousedown` is taken from the canvas. Once a button is held the move/up pair is read
    // from `window` (see `onWindowMouse`): the base dispatcher only forwards events whose target
    // is the canvas, so a release outside it was never seen and the contact stayed down until
    // the next click -- the pointer "stuck" after leaving the picture.
    private static readonly eventNames: InteractionEvents[] = [
        'touchstart',
        'touchend',
        'touchmove',
        'touchcancel',
        'mousedown',
        'wheel',
    ];
    private touches = new Map<number, CoreDeviceContact>();
    /** Where touches that began beside the picture would go down, by touch identifier. */
    private edgeTouches = new Map<number, { x: number; y: number }>();
    private mouseActive = false;
    /** Where the mouse's contact is, sent or about to be. A release lifts it there. */
    private mouseAt?: { x: number; y: number; size: Size };
    private pending?: { x: number; y: number; size: Size };
    private frame?: number;
    private pinch?: Pinch;
    private swipe?: Swipe;
    /** When the last wheel swipe started, for `WHEEL_SWIPE.intervalMs`. */
    private lastSwipeAt = -Infinity;

    constructor(
        player: BasePlayer,
        private readonly target: CoreDeviceTouchTarget,
    ) {
        // The touch layer itself keeps the browser's menu away on a right-click (`BasePlayer`).
        super(player, CoreDeviceInteractionHandler.eventNames, []);
    }

    /**
     * `clientX`/`clientY` are read explicitly: `Touch` and `MouseEvent` keep their coordinates
     * on the prototype, so spreading one into a plain object yields nothing (and NaN positions).
     */
    private position(clientX: number, clientY: number) {
        const screenInfo = this.player.getScreenInfo();
        if (!screenInfo) {
            return undefined;
        }
        const point = clientPointToVideo(clientX, clientY, elementBox(this.tag), screenInfo.videoSize);
        return point ? { ...point, size: screenInfo.videoSize } : undefined;
    }

    private contact(x: number, y: number, size: Size): void {
        this.pending = { x, y, size };
        this.mouseAt = this.pending;
        if (this.frame === undefined) {
            this.frame = requestAnimationFrame(() => {
                this.frame = undefined;
                if (this.pending) {
                    const { x, y, size } = this.pending;
                    this.pending = undefined;
                    this.target.sendTouch('contact', x, y, size);
                }
            });
        }
    }

    private lift(x: number, y: number, size: Size): void {
        if (this.frame !== undefined) {
            cancelAnimationFrame(this.frame);
            this.frame = undefined;
        }
        this.pending = undefined;
        this.target.sendTouch('release', x, y, size);
    }

    public releaseActiveTouch(): void {
        this.endEverything(true);
    }

    public forgetActiveTouch(): void {
        this.endEverything(false);
    }

    /** Ends every touch, the drag, the pinch and the swipe once; with `send`, the phone is told. */
    private endEverything(send: boolean): void {
        this.edgeTouches.clear();
        this.endSwipe(send);
        if (this.touches.size) {
            const size = this.player.getScreenInfo()?.videoSize;
            this.cancelPending();
            if (size && send)
                this.target.sendContacts(
                    [...this.touches.values()].map((c) => ({ ...c, touching: false })),
                    size,
                );
            this.touches.clear();
        }
        if (!this.mouseActive) {
            return;
        }
        this.setMouseActive(false);
        if (this.pinch) {
            this.endPinch(send);
            return;
        }
        // Lifted where it is, not at a corner: the release carries a position too.
        const at = this.mouseAt;
        if (at && send) {
            this.lift(at.x, at.y, at.size);
        } else {
            this.cancelPending();
        }
    }

    protected onInteraction(event: MouseEvent | TouchEvent): void {
        if (window['TouchEvent'] && event instanceof TouchEvent) {
            // The bands beside the picture count too, so that a swipe in from an edge works.
            if (this.isTouchTarget(event.target)) {
                this.onTouch(event);
            }
        } else if (event instanceof MouseEvent && event.target === this.tag) {
            if (event.type === 'wheel') {
                this.onWheel(event as WheelEvent);
            } else {
                this.onMouse(event);
            }
        }
    }

    private addContact(identifier: number, at: { x: number; y: number }): CoreDeviceContact {
        const used = new Set([...this.touches.values()].map((c) => c.id));
        const id = [0, 1, 2, 3, 4].find((id) => !used.has(id))!;
        const contact = { id, touching: true, x: at.x, y: at.y };
        this.touches.set(identifier, contact);
        return contact;
    }

    private cancelPending(): void {
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        this.frame = undefined;
        this.pending = undefined;
    }

    private onTouch(event: TouchEvent): void {
        event.preventDefault();
        if (this.mouseActive) return;
        // A finger takes over from a wheel swipe that is still running.
        this.endSwipe(true);
        const size = this.player.getScreenInfo()?.videoSize;
        if (!size) {
            this.releaseActiveTouch();
            return;
        }
        const ending = event.type === 'touchend' || event.type === 'touchcancel';
        const send = () => {
            this.frame = undefined;
            this.target.sendContacts(
                [...this.touches.values()].map((c) => ({ ...c })),
                size,
            );
        };
        for (const touch of Array.from(event.changedTouches)) {
            let contact = this.touches.get(touch.identifier);
            const position = this.position(touch.clientX, touch.clientY);
            if (!contact && position && this.touches.size < 5) {
                const inside = this.isInsidePicture(touch.clientX, touch.clientY);
                const edgeStart = this.edgeTouches.get(touch.identifier);
                if (event.type === 'touchstart' && inside) {
                    contact = this.addContact(touch.identifier, position);
                } else if (event.type === 'touchstart') {
                    // Began beside the picture. A tap there is not a tap on the phone, so
                    // nothing is sent until the finger moves onto the picture.
                    this.edgeTouches.set(touch.identifier, position);
                } else if (event.type === 'touchmove' && edgeStart && inside) {
                    // An edge swipe: the finger goes down on the edge where it started, which is
                    // where iOS expects a Home or Back gesture to begin, in a frame of its own.
                    this.edgeTouches.delete(touch.identifier);
                    contact = this.addContact(touch.identifier, edgeStart);
                    this.cancelPending();
                    send();
                }
            }
            if (ending) {
                this.edgeTouches.delete(touch.identifier);
            }
            if (contact) {
                if (position) {
                    contact.x = position.x;
                    contact.y = position.y;
                }
                contact.touching = !ending;
            }
        }
        if (!this.touches.size) return;
        if (event.type === 'touchmove') {
            if (this.frame === undefined) this.frame = requestAnimationFrame(send);
        } else {
            this.cancelPending();
            send();
            if (ending) for (const touch of Array.from(event.changedTouches)) this.touches.delete(touch.identifier);
        }
    }

    private onMouse(event: MouseEvent): void {
        if (event.type !== 'mousedown') {
            return;
        }
        // Right-click: MOUSE_CONTRACT.ios.rightClick is `nothing`, as an iPhone has no Back key.
        if (event.button !== 0 || this.touches.size > 0 || this.mouseActive) {
            return;
        }
        const position = this.position(event.clientX, event.clientY);
        if (!position) {
            return;
        }
        this.endSwipe(true);
        this.setMouseActive(true);
        if (event.ctrlKey && MOUSE_CONTRACT.ios.pinch) {
            this.startPinch(position, position.size, event.shiftKey);
        } else {
            this.contact(position.x, position.y, position.size);
        }
        event.preventDefault();
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

    /** Follows a held mouse button anywhere in the window; positions clamp onto the picture. */
    private onWindowMouse = (event: MouseEvent): void => {
        if (!this.mouseActive || (event.type === 'mouseup' && event.button !== 0)) {
            return;
        }
        const position = this.position(event.clientX, event.clientY);
        if (!position) {
            return;
        }
        if (event.type === 'mousemove') {
            if (this.pinch) {
                this.movePinch(position);
            } else {
                this.contact(position.x, position.y, position.size);
            }
        } else if (event.type === 'mouseup') {
            this.setMouseActive(false);
            if (this.pinch) {
                this.movePinch(position);
                this.endPinch(true);
            } else {
                this.lift(position.x, position.y, position.size);
            }
        }
        event.preventDefault();
    };

    // ------------------------------------------------------------------ Ctrl+drag

    /**
     * Two contacts: the pointer's and its mirror through the middle of the picture, or through
     * the point pressed when Shift is held too, as on Android. The frame goes at once.
     */
    private startPinch(at: VideoPoint, size: Size, aroundPress: boolean): void {
        const centre = aroundPress ? { x: at.x, y: at.y } : pictureCentre(size);
        const partner = mirrorPoint(at, centre, size) ?? at;
        this.pinch = {
            centre,
            size,
            contacts: [
                { id: 0, touching: true, x: at.x, y: at.y },
                { id: 1, touching: true, x: partner.x, y: partner.y },
            ],
        };
        this.cancelPending();
        this.sendPinch();
    }

    /** The pointer's finger follows; its mirror stays where it is when it would leave the picture. */
    private movePinch(at: VideoPoint): void {
        const pinch = this.pinch;
        if (!pinch) return;
        const [finger, partner] = pinch.contacts;
        finger.x = at.x;
        finger.y = at.y;
        const mirror = mirrorPoint(at, pinch.centre, pinch.size);
        if (mirror) {
            partner.x = mirror.x;
            partner.y = mirror.y;
        }
        if (this.frame === undefined) {
            this.frame = requestAnimationFrame(() => {
                this.frame = undefined;
                this.sendPinch();
            });
        }
    }

    /** Both fingers lift together, once. */
    private endPinch(send: boolean): void {
        const pinch = this.pinch;
        if (!pinch) return;
        this.cancelPending();
        this.pinch = undefined;
        pinch.contacts.forEach((contact) => (contact.touching = false));
        if (send) {
            this.target.sendContacts(
                pinch.contacts.map((c) => ({ ...c })),
                pinch.size,
            );
        }
        this.clearCanvas();
    }

    private sendPinch(): void {
        const pinch = this.pinch;
        if (!pinch) return;
        this.target.sendContacts(
            pinch.contacts.map((c) => ({ ...c })),
            pinch.size,
        );
        const toPoint = ({ x, y }: VideoPoint) => new Point(x, y);
        this.drawPinch(toPoint(pinch.centre), pinch.contacts.map(toPoint));
    }

    // ------------------------------------------------------------------ wheel

    /**
     * One wheel gesture is one short swipe at the pointer (`wheelSwipePath`). A wheel while a
     * finger, the mouse or a swipe is down, or sooner than `WHEEL_SWIPE.intervalMs` after the
     * last swipe began, is dropped, so a fast wheel cannot flood the phone.
     */
    private onWheel(event: WheelEvent): void {
        event.preventDefault();
        const now = Date.now();
        if (this.swipe || this.mouseActive || this.touches.size || now - this.lastSwipeAt < WHEEL_SWIPE.intervalMs) {
            return;
        }
        const at = this.position(event.clientX, event.clientY);
        const path = at && wheelSwipePath(at, at.size, event.deltaX, event.deltaY);
        if (!at || !path) {
            return;
        }
        this.lastSwipeAt = now;
        const size = at.size;
        const [start, ...moves] = path;
        this.target.sendTouch('contact', start.x, start.y, size);
        const step = (index: number): void => {
            const swipe = this.swipe;
            if (!swipe) return;
            if (index < moves.length) {
                swipe.at = moves[index];
                this.target.sendTouch('contact', swipe.at.x, swipe.at.y, size);
                swipe.timer = setTimeout(
                    () => step(index + 1),
                    index + 1 < moves.length ? WHEEL_SWIPE.moveMs : WHEEL_SWIPE.holdMs,
                );
            } else {
                this.endSwipe(true);
            }
        };
        this.swipe = { at: start, size, timer: setTimeout(() => step(0), WHEEL_SWIPE.moveMs) };
    }

    /** Lifts the swipe's finger where it is, once. */
    private endSwipe(send: boolean): void {
        const swipe = this.swipe;
        if (!swipe) return;
        clearTimeout(swipe.timer);
        this.swipe = undefined;
        if (send) {
            this.target.sendTouch('release', swipe.at.x, swipe.at.y, swipe.size);
        }
    }

    protected onKey(): void {
        // Keyboard input is handled by StreamClientCoreDevice (HID usages), not here.
    }

    public release(): void {
        super.release();
        if (this.frame !== undefined) {
            cancelAnimationFrame(this.frame);
            this.frame = undefined;
        }
        console.log(TAG, 'released');
    }
}
