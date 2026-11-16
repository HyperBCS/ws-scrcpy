import MotionEvent from '../MotionEvent';
import ScreenInfo from '../ScreenInfo';
import { TouchControlMessage } from '../controlMessage/TouchControlMessage';
import Size from '../Size';
import Point from '../Point';
import Position from '../Position';
import TouchPointPNG from '../../public/images/multitouch/touch_point.png';
import CenterPointPNG from '../../public/images/multitouch/center_point.png';
import Util from '../Util';
import { BasePlayer } from '../player/BasePlayer';
import { clientPointToVideo, elementBox, isInside, lastPixel, mirrorPoint, pictureCentre } from '../input/pointMapper';

interface Touch {
    action: number;
    position: Position;
    buttons: number;
    invalid: boolean;
}

interface CommonTouchAndMouse {
    clientX: number;
    clientY: number;
    type: string;
    target: EventTarget | null;
    buttons: number;
}

interface MiniMouseEvent extends CommonTouchAndMouse {
    ctrlKey: boolean;
    shiftKey: boolean;
    buttons: number;
}

const TAG = '[TouchHandler]';

export type TouchEventNames =
    'touchstart' | 'touchend' | 'touchmove' | 'touchcancel' | 'mousedown' | 'mouseup' | 'mousemove';
export type WheelEventNames = 'wheel';
export type InteractionEvents = TouchEventNames | WheelEventNames;
export type KeyEventNames = 'keydown' | 'keyup';

/**
 * Hears the fingers of a mouse pinch each time the pinch code draws them on a picture: the
 * pointer's finger first, then its mirror, in video pixels. The Show touches layer
 * (`views/screen/TouchMarks.tsx`) draws the second finger from it. Nothing that is sent to the
 * phone depends on it.
 */
export type PinchWatcher = (picture: HTMLCanvasElement, fingers: readonly Point[]) => void;

export abstract class InteractionHandler {
    protected static readonly SIMULATE_MULTI_TOUCH = 'SIMULATE_MULTI_TOUCH';
    protected static readonly STROKE_STYLE: string = '#00BEA4';
    protected static EVENT_ACTION_MAP: Record<string, number> = {
        touchstart: MotionEvent.ACTION_DOWN,
        touchend: MotionEvent.ACTION_UP,
        touchmove: MotionEvent.ACTION_MOVE,
        touchcancel: MotionEvent.ACTION_UP,
        mousedown: MotionEvent.ACTION_DOWN,
        mousemove: MotionEvent.ACTION_MOVE,
        mouseup: MotionEvent.ACTION_UP,
        [InteractionHandler.SIMULATE_MULTI_TOUCH]: -1,
    };
    private static options = Util.supportsPassive() ? { passive: false } : false;
    private static idToPointerMap: Map<number, number> = new Map();
    private static pointerToIdMap: Map<number, number> = new Map();
    private static touchPointRadius = 10;
    private static centerPointRadius = 5;
    private static touchPointImage?: HTMLImageElement;
    private static centerPointImage?: HTMLImageElement;
    private static pointImagesLoaded = false;
    private static eventListeners: Map<string, Set<InteractionHandler>> = new Map();
    private static readonly pinchWatchers = new Set<PinchWatcher>();
    private multiTouchActive = false;
    private multiTouchCenter?: Point;
    private multiTouchShift = false;
    private dirtyPlace: Point[] = [];
    /** Touches that began beside the picture and have not reached it yet, by pointer id. */
    private readonly edgeStarts = new Map<number, Position>();
    protected readonly ctx: CanvasRenderingContext2D | null;
    protected readonly tag: HTMLCanvasElement;
    protected over = false;
    protected lastPosition?: MouseEvent;

    protected constructor(
        public readonly player: BasePlayer,
        public readonly touchEventsNames: InteractionEvents[],
        public readonly keyEventsNames: KeyEventNames[],
    ) {
        this.tag = player.getTouchableElement();
        this.ctx = this.tag.getContext('2d');
        InteractionHandler.loadImages();
        InteractionHandler.bindGlobalListeners(this);
        // The end of a press does not come when the window loses focus or the page is hidden.
        window.addEventListener('blur', this.onFocusLost);
        window.addEventListener('pagehide', this.onFocusLost);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    protected abstract onInteraction(event: MouseEvent | TouchEvent): void;
    protected abstract onKey(event: KeyboardEvent): void;

    /**
     * Lets go of every touch and mouse button that is down on the phone, and tells the phone.
     * The one release of both platforms: it runs on blur, on a hidden page and on unmount
     * (`release`). Pointer up and pointer cancel end a touch in the handlers themselves.
     */
    public abstract releaseActiveTouch(): void;

    /**
     * Forgets every touch that is down without sending anything: after a disconnect a message
     * cannot reach the phone, and the server lifts what this viewer held.
     */
    public abstract forgetActiveTouch(): void;

    private onFocusLost = (): void => {
        this.releaseActiveTouch();
    };

    private onVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') {
            this.releaseActiveTouch();
        }
    };

    protected static bindGlobalListeners(interactionHandler: InteractionHandler): void {
        interactionHandler.touchEventsNames.forEach((eventName) => {
            let set: Set<InteractionHandler> | undefined = InteractionHandler.eventListeners.get(eventName);
            if (!set) {
                set = new Set();
                document.body.addEventListener(eventName, this.onInteractionEvent, InteractionHandler.options);
                this.eventListeners.set(eventName, set);
            }
            set.add(interactionHandler);
        });
        interactionHandler.keyEventsNames.forEach((eventName) => {
            let set = InteractionHandler.eventListeners.get(eventName);
            if (!set) {
                set = new Set();
                document.body.addEventListener(eventName, this.onKeyEvent);
                this.eventListeners.set(eventName, set);
            }
            set.add(interactionHandler);
        });
    }

    protected static unbindListeners(touchHandler: InteractionHandler): void {
        touchHandler.touchEventsNames.forEach((eventName) => {
            const set = InteractionHandler.eventListeners.get(eventName);
            if (!set) {
                return;
            }
            set.delete(touchHandler);
            if (set.size <= 0) {
                this.eventListeners.delete(eventName);
                document.body.removeEventListener(eventName, this.onInteractionEvent);
            }
        });
        touchHandler.keyEventsNames.forEach((eventName) => {
            const set = InteractionHandler.eventListeners.get(eventName);
            if (!set) {
                return;
            }
            set.delete(touchHandler);
            if (set.size <= 0) {
                this.eventListeners.delete(eventName);
                document.body.removeEventListener(eventName, this.onKeyEvent);
            }
        });
    }

    protected static onInteractionEvent = (event: MouseEvent | TouchEvent): void => {
        const set = InteractionHandler.eventListeners.get(event.type as TouchEventNames);
        if (!set) {
            return;
        }
        set.forEach((instance) => {
            instance.onInteraction(event);
        });
    };

    protected static onKeyEvent = (event: KeyboardEvent): void => {
        const set = InteractionHandler.eventListeners.get(event.type as KeyEventNames);
        if (!set) {
            return;
        }
        set.forEach((instance) => {
            instance.onKey(event);
        });
    };

    protected static loadImages(): void {
        if (this.pointImagesLoaded) {
            return;
        }
        const total = 2;
        let current = 0;

        const onload = (event: Event) => {
            if (++current === total) {
                this.pointImagesLoaded = true;
            }
            if (event.target === this.touchPointImage) {
                this.touchPointRadius = this.touchPointImage.width / 2;
            } else if (event.target === this.centerPointImage) {
                this.centerPointRadius = this.centerPointImage.width / 2;
            }
        };
        const touch = (this.touchPointImage = new Image());
        touch.src = TouchPointPNG;
        touch.onload = onload;
        const center = (this.centerPointImage = new Image());
        center.src = CenterPointPNG;
        center.onload = onload;
    }

    protected static getPointerId(type: string, identifier: number): number {
        if (this.idToPointerMap.has(identifier)) {
            const pointerId = this.idToPointerMap.get(identifier) as number;
            if (type === 'touchend' || type === 'touchcancel') {
                this.idToPointerMap.delete(identifier);
                this.pointerToIdMap.delete(pointerId);
            }
            return pointerId;
        }
        let pointerId = 0;
        while (this.pointerToIdMap.has(pointerId)) {
            pointerId++;
        }
        this.idToPointerMap.set(identifier, pointerId);
        this.pointerToIdMap.set(pointerId, identifier);
        return pointerId;
    }

    /**
     * A touch that starts on the bands beside the picture has the stream area as its target,
     * not the touch layer. It still belongs to the remote screen: an edge swipe begins there.
     */
    protected isTouchTarget(target: EventTarget | null): boolean {
        return !!target && (target === this.tag || target === this.tag.parentElement);
    }

    protected isInsidePicture(clientX: number, clientY: number): boolean {
        return isInside(elementBox(this.tag), clientX, clientY);
    }

    /**
     * Maps a page point to an Android touch through the shared point mapper. A point beside the
     * picture is clamped onto its nearest edge, so a finger that slides off the picture keeps its
     * gesture and ends it at the edge.
     */
    protected buildTouchOnClient(event: CommonTouchAndMouse, screenInfo: ScreenInfo): Touch | null {
        const action = InteractionHandler.mapTypeToAction(event.type);
        const { videoSize } = screenInfo;
        const point = clientPointToVideo(event.clientX, event.clientY, elementBox(this.tag), videoSize);
        if (!point) {
            return null;
        }
        const { x, y } = lastPixel(point, videoSize);
        return {
            invalid: false,
            action,
            position: new Position(new Point(x, y), new Size(videoSize.width, videoSize.height)),
            buttons: event.buttons,
        };
    }

    private static validateMessage(
        originalEvent: MiniMouseEvent | TouchEvent,
        message: TouchControlMessage,
        storage: Map<number, TouchControlMessage>,
        logPrefix: string,
    ): TouchControlMessage[] {
        const messages: TouchControlMessage[] = [];
        const { action, pointerId } = message;
        const previous = storage.get(pointerId);
        if (action === MotionEvent.ACTION_UP) {
            if (!previous) {
                console.warn(logPrefix, 'Received ACTION_UP while there are no DOWN stored');
            } else {
                storage.delete(pointerId);
                messages.push(message);
            }
        } else if (action === MotionEvent.ACTION_DOWN) {
            if (previous) {
                console.warn(logPrefix, 'Received ACTION_DOWN while already has one stored');
            } else {
                storage.set(pointerId, message);
                messages.push(message);
            }
        } else if (action === MotionEvent.ACTION_MOVE) {
            if (!previous) {
                if (
                    (originalEvent instanceof MouseEvent && originalEvent.buttons) ||
                    (window['TouchEvent'] && originalEvent instanceof TouchEvent)
                ) {
                    console.warn(logPrefix, 'Received ACTION_MOVE while there are no DOWN stored');
                    const emulated = InteractionHandler.createEmulatedMessage(MotionEvent.ACTION_DOWN, message);
                    messages.push(emulated);
                    storage.set(pointerId, emulated);
                }
            } else {
                messages.push(message);
                storage.set(pointerId, message);
            }
        }
        return messages;
    }

    protected static createEmulatedMessage(action: number, event: TouchControlMessage): TouchControlMessage {
        const { pointerId, position, buttons } = event;
        let pressure = event.pressure;
        if (action === MotionEvent.ACTION_UP) {
            pressure = 0;
        }
        return new TouchControlMessage(action, pointerId, position, pressure, buttons);
    }

    public static mapTypeToAction(type: string): number {
        return this.EVENT_ACTION_MAP[type];
    }

    protected getTouch(
        e: CommonTouchAndMouse,
        screenInfo: ScreenInfo,
        ctrlKey: boolean,
        shiftKey: boolean,
    ): Touch[] | null {
        const touch = this.buildTouchOnClient(e, screenInfo);
        if (!touch) {
            return null;
        }
        const result: Touch[] = [touch];
        if (!ctrlKey) {
            this.resetPinch();
            return result;
        }
        const { position, action, buttons } = touch;
        const { point, screenSize } = position;
        if (!this.multiTouchActive || !this.multiTouchCenter) {
            if (shiftKey) {
                this.multiTouchCenter = point;
                this.multiTouchShift = true;
            } else {
                // In video pixels, like the point. It was in page pixels, which put the second
                // finger off the screen whenever the picture was scaled to fit.
                const centre = pictureCentre(screenSize);
                this.multiTouchCenter = new Point(centre.x, centre.y);
            }
        }
        this.multiTouchActive = true;
        // Off the picture only when Shift put the centre elsewhere; that finger then stays put.
        const opposite = mirrorPoint(point, this.multiTouchCenter, screenSize);
        const partner = opposite ? lastPixel(opposite, screenSize) : point;
        result.push({
            invalid: !opposite,
            action,
            buttons,
            position: new Position(new Point(partner.x, partner.y), screenSize),
        });
        return result;
    }

    /** Ends the pinch preview and forgets its centre. */
    protected resetPinch(): void {
        this.multiTouchActive = false;
        this.multiTouchCenter = undefined;
        this.multiTouchShift = false;
        this.clearCanvas();
    }

    /** Adds a watcher of the fingers of a mouse pinch. The function returned removes it. */
    public static watchPinch(watcher: PinchWatcher): () => void {
        InteractionHandler.pinchWatchers.add(watcher);
        return () => {
            InteractionHandler.pinchWatchers.delete(watcher);
        };
    }

    /** Draws the centre of a pinch and its fingers on the touch layer, in video pixels. */
    protected drawPinch(centre: Point, points: Point[]): void {
        this.clearCanvas();
        this.drawCenter(centre);
        points.forEach((point) => {
            this.drawPoint(point, InteractionHandler.touchPointRadius, InteractionHandler.touchPointImage);
            this.drawLine(centre, point);
        });
        // A watcher that fails must not stop the messages of this pinch from being sent.
        InteractionHandler.pinchWatchers.forEach((watcher) => {
            try {
                watcher(this.tag, points);
            } catch (error) {
                console.error(TAG, 'Pinch watcher failed', error);
            }
        });
    }

    protected drawCircle(ctx: CanvasRenderingContext2D, point: Point, radius: number): void {
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2, true);
        ctx.stroke();
    }

    public drawLine(point1: Point, point2: Point): void {
        if (!this.ctx) {
            return;
        }
        this.ctx.save();
        this.ctx.strokeStyle = InteractionHandler.STROKE_STYLE;
        this.ctx.beginPath();
        this.ctx.moveTo(point1.x, point1.y);
        this.ctx.lineTo(point2.x, point2.y);
        this.ctx.stroke();
        this.ctx.restore();
    }

    protected drawPoint(point: Point, radius: number, image?: HTMLImageElement): void {
        if (!this.ctx) {
            return;
        }
        let { lineWidth } = this.ctx;
        if (InteractionHandler.pointImagesLoaded && image) {
            radius = image.width / 2;
            lineWidth = 0;
            this.ctx.drawImage(image, point.x - radius, point.y - radius);
        } else {
            this.drawCircle(this.ctx, point, radius);
        }

        const topLeft = new Point(point.x - radius - lineWidth, point.y - radius - lineWidth);
        const bottomRight = new Point(point.x + radius + lineWidth, point.y + radius + lineWidth);
        this.updateDirty(topLeft, bottomRight);
    }

    public drawCenter(point: Point): void {
        this.drawPoint(point, InteractionHandler.centerPointRadius, InteractionHandler.centerPointImage);
    }

    protected updateDirty(topLeft: Point, bottomRight: Point): void {
        if (!this.dirtyPlace.length) {
            this.dirtyPlace.push(topLeft, bottomRight);
            return;
        }
        const currentTopLeft = this.dirtyPlace[0];
        const currentBottomRight = this.dirtyPlace[1];
        const newTopLeft = new Point(Math.min(currentTopLeft.x, topLeft.x), Math.min(currentTopLeft.y, topLeft.y));
        const newBottomRight = new Point(
            Math.max(currentBottomRight.x, bottomRight.x),
            Math.max(currentBottomRight.y, bottomRight.y),
        );
        this.dirtyPlace.length = 0;
        this.dirtyPlace.push(newTopLeft, newBottomRight);
    }

    public clearCanvas(): void {
        // The layer's bitmap is the size of the video, which is what the points are in.
        const { width, height } = this.tag;
        const ctx = this.ctx;
        if (ctx && this.dirtyPlace.length) {
            const topLeft = this.dirtyPlace[0];
            const bottomRight = this.dirtyPlace[1];
            this.dirtyPlace.length = 0;
            const x = Math.max(topLeft.x, 0);
            const y = Math.max(topLeft.y, 0);
            const w = Math.min(width, bottomRight.x - x);
            const h = Math.min(height, bottomRight.y - y);
            ctx.clearRect(x, y, w, h);
            ctx.strokeStyle = InteractionHandler.STROKE_STYLE;
        }
    }

    public formatTouchEvent(
        e: TouchEvent,
        screenInfo: ScreenInfo,
        storage: Map<number, TouchControlMessage>,
    ): TouchControlMessage[] {
        const logPrefix = `${TAG}[formatTouchEvent]`;
        const messages: TouchControlMessage[] = [];
        const touches = e.changedTouches;
        if (touches && touches.length) {
            for (let i = 0, l = touches.length; i < l; i++) {
                const touch = touches[i];
                const pointerId = InteractionHandler.getPointerId(e.type, touch.identifier);
                if (!this.isTouchTarget(touch.target)) {
                    continue;
                }
                const item: CommonTouchAndMouse = {
                    clientX: touch.clientX,
                    clientY: touch.clientY,
                    type: e.type,
                    buttons: MotionEvent.BUTTON_PRIMARY,
                    target: e.target,
                };
                const event = this.buildTouchOnClient(item, screenInfo);
                if (!event) {
                    console.error(logPrefix, `Failed to format touch`, touch);
                    continue;
                }
                const { action, buttons, position } = event;
                let pressure = 1;
                if (action === MotionEvent.ACTION_UP) {
                    pressure = 0;
                } else if (typeof touch.force === 'number') {
                    pressure = touch.force;
                }
                if (!storage.has(pointerId)) {
                    const inside = this.isInsidePicture(touch.clientX, touch.clientY);
                    if (action === MotionEvent.ACTION_DOWN && !inside) {
                        // Began beside the picture. A tap there is not a tap on the device, so
                        // nothing is sent until the finger moves onto the picture.
                        this.edgeStarts.set(pointerId, position);
                        continue;
                    }
                    const edgeStart = this.edgeStarts.get(pointerId);
                    if (edgeStart) {
                        if (action === MotionEvent.ACTION_UP) {
                            this.edgeStarts.delete(pointerId);
                            continue;
                        }
                        if (!inside) {
                            continue;
                        }
                        // An edge swipe: the finger came onto the picture from beside it. Put
                        // it down on the edge where it started, which is where the device
                        // expects a Back or Home gesture to begin, then send this move.
                        this.edgeStarts.delete(pointerId);
                        const down = new TouchControlMessage(
                            MotionEvent.ACTION_DOWN,
                            pointerId,
                            edgeStart,
                            pressure,
                            buttons,
                        );
                        storage.set(pointerId, down);
                        messages.push(down);
                    }
                }
                const message = new TouchControlMessage(action, pointerId, position, pressure, buttons);
                messages.push(...InteractionHandler.validateMessage(e, message, storage, `${logPrefix}[validate]`));
            }
        } else {
            console.error(logPrefix, 'No "touches"', e);
        }
        return messages;
    }

    /** A mouse event as touches. With `pinch`, a second finger mirrors the pointer. */
    public buildTouchEvent(
        e: MiniMouseEvent,
        screenInfo: ScreenInfo,
        storage: Map<number, TouchControlMessage>,
        pinch = e.ctrlKey,
    ): TouchControlMessage[] {
        const logPrefix = `${TAG}[buildTouchEvent]`;
        const touches = this.getTouch(e, screenInfo, pinch, e.shiftKey);
        if (!touches) {
            return [];
        }
        const messages: TouchControlMessage[] = [];
        const points: Point[] = [];
        this.clearCanvas();
        touches.forEach((touch: Touch, pointerId: number) => {
            const { action, buttons, position } = touch;
            const previous = storage.get(pointerId);
            if (!touch.invalid) {
                let pressure = 1.0;
                if (action === MotionEvent.ACTION_UP) {
                    pressure = 0;
                }
                const message = new TouchControlMessage(action, pointerId, position, pressure, buttons);
                messages.push(...InteractionHandler.validateMessage(e, message, storage, `${logPrefix}[validate]`));
                points.push(touch.position.point);
            } else {
                if (previous) {
                    points.push(previous.position.point);
                }
            }
        });
        if (this.multiTouchActive && this.multiTouchCenter) {
            this.drawPinch(this.multiTouchCenter, points);
        }
        const hasActionUp = messages.find((message) => {
            return message.action === MotionEvent.ACTION_UP;
        });
        if (hasActionUp && storage.size) {
            console.warn(logPrefix, 'Looks like one of Multi-touch pointers was not raised up');
            storage.forEach((message) => {
                messages.push(InteractionHandler.createEmulatedMessage(MotionEvent.ACTION_UP, message));
            });
            storage.clear();
        }
        return messages;
    }

    /** Forgets the touches that began beside the picture and have not reached it. */
    protected clearEdgeStarts(): void {
        this.edgeStarts.clear();
    }

    /** The view unmounts: what is down is let go and told to the phone, then nothing is heard. */
    public release(): void {
        this.releaseActiveTouch();
        this.edgeStarts.clear();
        window.removeEventListener('blur', this.onFocusLost);
        window.removeEventListener('pagehide', this.onFocusLost);
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        InteractionHandler.unbindListeners(this);
    }
}
