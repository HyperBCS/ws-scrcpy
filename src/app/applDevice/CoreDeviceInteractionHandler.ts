import { InteractionEvents, InteractionHandler } from '../interactionHandler/InteractionHandler';
import { clientPointToVideo } from './touchMath';
import { BasePlayer } from '../player/BasePlayer';
import Size from '../Size';

export interface CoreDeviceTouchTarget {
    sendTouch(op: 'contact' | 'release' | 'tap', x: number, y: number, videoSize: Size): void;
}

const TAG = '[CoreDeviceTouch]';

/**
 * Maps pointer input on the video canvas to CoreDevice touchscreen reports.
 *
 * The device side (`com.apple.coredevice.hid.universalhidservice`, report 0x09) tracks one
 * contact: every CONTACT sample is "the finger is here now", RELEASE lifts it. So this handler
 * follows the first active pointer only and ignores the others until it lifts -- a second finger
 * would otherwise teleport the single contact between two places. Moves are coalesced per frame.
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
    ];
    private activeTouchId?: number;
    private mouseActive = false;
    private pending?: { x: number; y: number; size: Size };
    private frame?: number;

    constructor(
        player: BasePlayer,
        private readonly target: CoreDeviceTouchTarget,
    ) {
        super(player, CoreDeviceInteractionHandler.eventNames, []);
        this.tag.addEventListener('contextmenu', (event) => event.preventDefault());
        window.addEventListener('blur', this.releaseActiveTouch);
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
        const rect = this.tag.getBoundingClientRect();
        const point = clientPointToVideo(
            clientX,
            clientY,
            { left: rect.left, top: rect.top, width: this.tag.clientWidth, height: this.tag.clientHeight },
            screenInfo.videoSize,
        );
        return point ? { ...point, size: screenInfo.videoSize } : undefined;
    }

    private contact(x: number, y: number, size: Size): void {
        this.pending = { x, y, size };
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

    public releaseActiveTouch = (): void => {
        if (this.activeTouchId === undefined && !this.mouseActive) {
            return;
        }
        this.activeTouchId = undefined;
        this.setMouseActive(false);
        const size = this.player.getScreenInfo()?.videoSize;
        if (size) {
            this.lift(this.pending?.x ?? 0, this.pending?.y ?? 0, size);
        }
    };

    protected onInteraction(event: MouseEvent | TouchEvent): void {
        if (event.target !== this.tag) {
            return;
        }
        if (window['TouchEvent'] && event instanceof TouchEvent) {
            this.onTouch(event);
        } else if (event instanceof MouseEvent) {
            this.onMouse(event);
        }
    }

    private onTouch(event: TouchEvent): void {
        if (event.type === 'touchstart') {
            if (this.activeTouchId !== undefined) {
                event.preventDefault();
                return;
            }
            const touch = event.changedTouches[0];
            const position = this.position(touch.clientX, touch.clientY);
            if (!position) {
                return;
            }
            this.activeTouchId = touch.identifier;
            this.contact(position.x, position.y, position.size);
            event.preventDefault();
            return;
        }
        if (this.activeTouchId === undefined) {
            return;
        }
        const touch = Array.from(event.changedTouches).find((item) => item.identifier === this.activeTouchId);
        if (!touch) {
            return;
        }
        event.preventDefault();
        const position = this.position(touch.clientX, touch.clientY);
        if (!position) {
            return;
        }
        if (event.type === 'touchmove') {
            this.contact(position.x, position.y, position.size);
        } else {
            this.activeTouchId = undefined;
            this.lift(position.x, position.y, position.size);
        }
    }

    private onMouse(event: MouseEvent): void {
        if (event.type !== 'mousedown') {
            return;
        }
        if (event.button !== 0 || this.activeTouchId !== undefined || this.mouseActive) {
            return;
        }
        const position = this.position(event.clientX, event.clientY);
        if (!position) {
            return;
        }
        this.setMouseActive(true);
        this.contact(position.x, position.y, position.size);
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
        if (!this.mouseActive) {
            return;
        }
        const position = this.position(event.clientX, event.clientY);
        if (!position) {
            return;
        }
        if (event.type === 'mousemove') {
            this.contact(position.x, position.y, position.size);
        } else if (event.type === 'mouseup') {
            this.setMouseActive(false);
            this.lift(position.x, position.y, position.size);
        }
        event.preventDefault();
    };

    protected onKey(): void {
        // Keyboard input is handled by StreamClientCoreDevice (HID usages), not here.
    }

    public release(): void {
        window.removeEventListener('blur', this.releaseActiveTouch);
        this.releaseActiveTouch();
        this.setMouseActive(false);
        if (this.frame !== undefined) {
            cancelAnimationFrame(this.frame);
            this.frame = undefined;
        }
        super.release();
        console.log(TAG, 'released');
    }
}
