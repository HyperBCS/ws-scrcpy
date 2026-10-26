import { InteractionEvents, InteractionHandler } from '../interactionHandler/InteractionHandler';
import { clientPointToVideo } from './touchMath';
import { BasePlayer } from '../player/BasePlayer';
import Size from '../Size';
import { CoreDeviceContact } from '../../common/CoreDeviceProtocol';

export interface CoreDeviceTouchTarget {
    sendContacts(contacts: CoreDeviceContact[], videoSize: Size): void;
    sendTouch(op: 'contact' | 'release' | 'tap', x: number, y: number, videoSize: Size): void;
}

const TAG = '[CoreDeviceTouch]';

/**
 * Maps pointer input on the video canvas to CoreDevice touchscreen reports.
 *
 * Sends complete contact frames with stable identities; moves are coalesced per frame.
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
    private touches = new Map<number, CoreDeviceContact>();
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
        document.addEventListener('visibilitychange', this.onVisibility);
    }

    private onVisibility = (): void => {
        if (document.hidden) this.releaseActiveTouch();
    };

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
        if (this.touches.size) {
            const size = this.player.getScreenInfo()?.videoSize;
            this.cancelPending();
            if (size)
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

    private cancelPending(): void {
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        this.frame = undefined;
        this.pending = undefined;
    }

    private onTouch(event: TouchEvent): void {
        event.preventDefault();
        if (this.mouseActive) return;
        const size = this.player.getScreenInfo()?.videoSize;
        if (!size) {
            this.releaseActiveTouch();
            return;
        }
        const ending = event.type === 'touchend' || event.type === 'touchcancel';
        for (const touch of Array.from(event.changedTouches)) {
            let contact = this.touches.get(touch.identifier);
            const position = this.position(touch.clientX, touch.clientY);
            if (!contact && event.type === 'touchstart' && this.touches.size < 5 && position) {
                const used = new Set([...this.touches.values()].map((c) => c.id));
                const id = [0, 1, 2, 3, 4].find((id) => !used.has(id))!;
                contact = { id, touching: true, x: position.x, y: position.y };
                this.touches.set(touch.identifier, contact);
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
        const send = () => {
            this.frame = undefined;
            this.target.sendContacts(
                [...this.touches.values()].map((c) => ({ ...c })),
                size,
            );
        };
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
        if (event.button !== 0 || this.touches.size > 0 || this.mouseActive) {
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
        document.removeEventListener('visibilitychange', this.onVisibility);
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
