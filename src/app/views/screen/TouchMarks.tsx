import { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { SizeInterface } from '../../Size';
import { ClientBox, elementBox, isInside, VideoPoint } from '../../input/pointMapper';
import { LayerPoint, markPoint, videoPointToLayer } from '../../input/touchMarks';
import { InteractionHandler } from '../../interactionHandler/InteractionHandler';
import { showTouches } from '../../state/showTouches';
import { animate, finished, MOTION } from '../../ui/motion';
import '../../../style/views/TouchMarks.css';

/** The mouse's circle, and the second finger of its Ctrl+drag pinch. A touch goes by its identifier. */
const MOUSE = 'mouse';
const PINCH = 'pinch';
const TOUCH_EVENTS = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const;
// The layer only listens: it never cancels an event or stops it on its way to the input.
const LISTEN: AddEventListenerOptions = { passive: true };
const LISTEN_EARLY: AddEventListenerOptions = { passive: true, capture: true };

/** The touch layer of the player, its box on the page and the video size its points are in. */
interface Picture {
    canvas: HTMLCanvasElement;
    box: ClientBox;
    videoSize: SizeInterface;
}

/**
 * The circles of one layer. It hears the same events as the input of both kinds of phone
 * (`InteractionHandler` and its subclasses) on the same elements, and takes the same rules from
 * them: a touch counts from where it starts on the picture, or from where it first reaches the
 * picture when it starts on the bands beside it; the mouse counts from a left press on the picture
 * until that button comes up, wherever the pointer goes meanwhile; a lost window or a hidden page
 * lets everything go. Each point goes through the input's own mapping (`markPoint` in
 * `input/touchMarks.ts`). The second finger of a Ctrl+drag pinch comes from the pinch code
 * (`InteractionHandler.watchPinch`).
 */
class TouchMarkLayer {
    private readonly marks = new Map<string, HTMLElement>();
    /** Touches that began beside the picture. The phone gets them once they reach it. */
    private readonly besides = new Set<number>();
    private mouseDown = false;
    private readonly unwatchPinch: () => void;

    constructor(
        private readonly layer: HTMLElement,
        private readonly mount: HTMLElement,
    ) {
        TOUCH_EVENTS.forEach((type) => mount.addEventListener(type, this.onTouch, LISTEN));
        mount.addEventListener('mousedown', this.onMouseDown, LISTEN);
        window.addEventListener('blur', this.liftAll);
        window.addEventListener('pagehide', this.liftAll);
        document.addEventListener('visibilitychange', this.onVisibility);
        this.unwatchPinch = InteractionHandler.watchPinch(this.onPinch);
    }

    /** The picture the input maps onto. None until the player has a video size. */
    private picture(): Picture | undefined {
        const canvas = this.mount.querySelector<HTMLCanvasElement>('canvas.touch-layer');
        if (!canvas || !canvas.hasAttribute('width')) {
            return undefined;
        }
        return { canvas, box: elementBox(canvas), videoSize: { width: canvas.width, height: canvas.height } };
    }

    private onTouch = (event: TouchEvent): void => {
        const ending = event.type === 'touchend' || event.type === 'touchcancel';
        const picture = this.picture();
        for (const touch of Array.from(event.changedTouches)) {
            const key = `touch-${touch.identifier}`;
            if (ending) {
                this.besides.delete(touch.identifier);
                if (picture && this.marks.has(key)) {
                    this.place(key, picture, touch.clientX, touch.clientY);
                }
                this.lift(key);
                continue;
            }
            // A touch on the picture, or on the bands beside it, which is where an edge swipe starts.
            if (!picture || (touch.target !== picture.canvas && touch.target !== picture.canvas.parentElement)) {
                continue;
            }
            const inside = isInside(picture.box, touch.clientX, touch.clientY);
            if (event.type === 'touchstart') {
                if (inside) {
                    this.place(key, picture, touch.clientX, touch.clientY);
                } else {
                    this.besides.add(touch.identifier);
                }
            } else if (this.marks.has(key)) {
                this.place(key, picture, touch.clientX, touch.clientY);
            } else if (inside && this.besides.delete(touch.identifier)) {
                this.place(key, picture, touch.clientX, touch.clientY);
            }
        }
    };

    private onMouseDown = (event: MouseEvent): void => {
        if (event.button !== 0 || this.mouseDown) {
            return;
        }
        const picture = this.picture();
        if (!picture || event.target !== picture.canvas) {
            return;
        }
        this.mouseDown = true;
        this.place(MOUSE, picture, event.clientX, event.clientY);
        window.addEventListener('mousemove', this.onWindowMouse, LISTEN_EARLY);
        window.addEventListener('mouseup', this.onWindowMouse, LISTEN_EARLY);
    };

    /** A held button, anywhere in the window. The circle rides the edge of the picture. */
    private onWindowMouse = (event: MouseEvent): void => {
        if (event.type === 'mouseup' && event.button !== 0) {
            return;
        }
        const picture = this.picture();
        if (picture) {
            this.place(MOUSE, picture, event.clientX, event.clientY);
        }
        if (event.type === 'mouseup') {
            this.endMouse();
        }
    };

    /** Android draws its pinch while Ctrl is held over the picture too, with nothing down: not drawn here. */
    private onPinch = (canvas: HTMLCanvasElement, fingers: readonly VideoPoint[]): void => {
        const picture = this.mouseDown ? this.picture() : undefined;
        if (!picture || picture.canvas !== canvas) {
            return;
        }
        const [finger, partner] = fingers;
        if (finger) {
            this.show(MOUSE, picture, finger);
        }
        if (partner) {
            this.show(PINCH, picture, partner);
        }
    };

    private endMouse(): void {
        this.forgetMouse();
        this.lift(MOUSE);
        this.lift(PINCH);
    }

    private forgetMouse(): void {
        this.mouseDown = false;
        window.removeEventListener('mousemove', this.onWindowMouse, LISTEN_EARLY);
        window.removeEventListener('mouseup', this.onWindowMouse, LISTEN_EARLY);
    }

    /** The circle of a pointer at a page point, where the input sends that point. */
    private place(key: string, picture: Picture, clientX: number, clientY: number): void {
        this.draw(key, markPoint(clientX, clientY, picture.box, picture.videoSize, this.layer.getBoundingClientRect()));
    }

    /** The circle of a point the pinch code gives, in video pixels. */
    private show(key: string, picture: Picture, point: VideoPoint): void {
        this.draw(key, videoPointToLayer(point, picture.box, picture.videoSize, this.layer.getBoundingClientRect()));
    }

    private draw(key: string, at: LayerPoint | undefined): void {
        if (!at) {
            return;
        }
        let mark = this.marks.get(key);
        if (!mark) {
            mark = document.createElement('span');
            mark.className = 'touch-mark';
            this.layer.appendChild(mark);
            this.marks.set(key, mark);
        }
        mark.style.transform = `translate(${at.x}px, ${at.y}px)`;
    }

    /** The pointer is let go: its circle fades where it is, or goes at once with reduced motion. */
    private lift(key: string): void {
        const mark = this.marks.get(key);
        if (!mark) {
            return;
        }
        this.marks.delete(key);
        const fade = animate(mark, [{ opacity: 1 }, { opacity: 0 }], { duration: MOTION.exit, fill: 'forwards' });
        void finished(fade).then(() => mark.remove());
    }

    /** The input lets everything go when the window loses focus or the page is hidden. */
    private liftAll = (): void => {
        this.besides.clear();
        if (this.mouseDown) {
            this.endMouse();
        }
        Array.from(this.marks.keys()).forEach((key) => this.lift(key));
    };

    private onVisibility = (): void => {
        if (document.visibilityState === 'hidden') {
            this.liftAll();
        }
    };

    /** The switch is turned off or the screen goes: the circles go with the layer, at once. */
    public stop(): void {
        this.forgetMouse();
        this.besides.clear();
        this.marks.forEach((mark) => mark.remove());
        this.marks.clear();
        TOUCH_EVENTS.forEach((type) => this.mount.removeEventListener(type, this.onTouch, LISTEN));
        this.mount.removeEventListener('mousedown', this.onMouseDown, LISTEN);
        window.removeEventListener('blur', this.liftAll);
        window.removeEventListener('pagehide', this.liftAll);
        document.removeEventListener('visibilitychange', this.onVisibility);
        this.unwatchPinch();
    }
}

/**
 * Show touches: a layer over the picture of a phone's screen with one circle under each pointer
 * that is down on it, the same on both kinds of phone. It is drawn in this browser only, so it is
 * not in a screenshot of the phone, and it takes no press. With the switch off
 * (`state/showTouches.ts`) there is no layer and nothing listens. `ScreenView` puts it beside the
 * mount node, which it listens on with passive listeners and never changes.
 */
export function TouchMarks({ mount }: { mount: RefObject<HTMLDivElement> }) {
    const on = showTouches.value;
    const layerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const layer = layerRef.current;
        const node = mount.current;
        if (!on || !layer || !node) {
            return;
        }
        const marks = new TouchMarkLayer(layer, node);
        return () => marks.stop();
    }, [on]);

    return on ? <div class="touch-marks" ref={layerRef} aria-hidden="true" /> : null;
}
