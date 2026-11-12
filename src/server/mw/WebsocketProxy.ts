import { Mw, SocketMessageEvent } from './Mw';
import WS from 'ws';
import { Multiplexer } from '../../packages/multiplexer/Multiplexer';
import { broadcastManager } from '../../common/BroadcastManager';
import { Broadcast, VideoFrameKind } from '../../common/Broadcast';
import { ControlMessage } from '../../app/controlMessage/ControlMessage';

type BroadcastListener = (data: Buffer, videoKind?: VideoFrameKind) => void;
// Allow the bounded 16 MiB bootstrap, then reconnect viewers that cannot keep up.
const MAX_BUFFERED_BYTES = 20 * 1024 * 1024;
// scrcpy INJECT_KEYCODE: type(1) action(1) keycode(4) repeat(4) metaState(4).
const KEYCODE_MESSAGE_LENGTH = 14;
const KEY_ACTION_DOWN = 0;
const KEY_ACTION_UP = 1;
// scrcpy INJECT_TOUCH_EVENT: type(1) action(1) pointerId(8) x(4) y(4) width(2) height(2)
// pressure(2) actionButton(4) buttons(4).
const TOUCH_MESSAGE_LENGTH = 32;
const TOUCH_ACTION_UP = 1;
const TOUCH_PRESSURE_OFFSET = 22;

/**
 * Device details used to fill the synthetic `scrcpy_initial` packet. Supplied by the caller
 * rather than looked up here: this class lives in the platform-agnostic `mw/` layer, while the
 * only source of these values is the Android ControlCenter, which is behind `INCLUDE_GOOG` and
 * deliberately loaded via dynamic import so an iOS-only build never bundles adbkit. A static
 * import of it here would silently defeat that flag.
 */
export type StreamMeta = {
    deviceName: string;
    encoders: string[];
};

export class WebsocketProxy extends Mw {
    public static readonly TAG = 'WebsocketProxy';
    // Every viewer shares the same scrcpy control socket, including its UHID namespace.
    // Keep active IDs unique and within the protocol's unsigned 16-bit device-id range.
    private static readonly activeClientIds = new Set<number>();
    private static nextClientId = 0;
    private clientId?: number;
    private keyboardCreated = false;
    /** Android keycodes this viewer has sent down and not yet up. */
    private readonly heldKeys = new Set<number>();
    /** The last message of each finger this viewer has put down and not lifted, by pointer id. */
    private readonly heldTouches = new Map<string, Buffer>();
    private broadcast?: Broadcast;
    private broadcastListener?: BroadcastListener;
    private controlSocketCloseListener?: () => void;
    private released = false;

    private static allocateClientId(): number | undefined {
        for (let attempt = 0; attempt < 0xffff; attempt++) {
            const id = (this.nextClientId = (this.nextClientId % 0xffff) + 1);
            if (!this.activeClientIds.has(id)) {
                this.activeClientIds.add(id);
                return id;
            }
        }
        return;
    }

    constructor(ws: WS | Multiplexer) {
        super(ws);
    }

    public async init(udid: string, meta?: StreamMeta): Promise<void> {
        if (this.released || this.ws.readyState !== this.ws.OPEN) {
            return;
        }

        this.name = `[${WebsocketProxy.TAG}{$${udid}}]`;

        const broadcast = broadcastManager.getBroadcast(udid);
        this.broadcast = broadcast;

        if (!broadcast) {
            // Most commonly hit mid config-change restart (see Device.updateStreamConfig): the
            // old broadcast is already gone and the new one is not registered yet. Closing here
            // - instead of leaving the socket open with nothing ever arriving - keeps the
            // client's reconnect-with-backoff loop (StreamReceiver) retrying until the fresh
            // broadcast shows up, rather than stranding it in a silent "connected" state forever.
            this.ws.close(4008, 'No active stream for this device yet');
            return;
        }

        // craftInitialInfoPacket reports videoWidth/videoHeight, which are 0 until the first
        // session packet has been read. The client latches that ScreenInfo permanently, so
        // wait for it rather than advertising a 0x0 screen.
        if (!(await broadcast.whenReady())) {
            this.ws.close(4006, 'Stream ended before it was ready');
            return;
        }
        // The browser can leave while server startup/header parsing is still in flight.
        // release() has already run in that case; registering now would leak both listeners.
        if (this.released || this.ws.readyState !== this.ws.OPEN) {
            return;
        }

        this.clientId ??= WebsocketProxy.allocateClientId();
        if (this.clientId === undefined) {
            this.ws.close(4010, 'All stream client IDs are in use');
            return;
        }

        // A config-change restart tears this broadcast down without ever telling this proxy
        // directly: without this, an already-attached client's socket would just go silent
        // forever (frozen last frame, no 'close' event, so StreamReceiver never reconnects).
        // Broadcast.stop() destroys the control socket, so it also ends this viewer's stream.
        this.controlSocketCloseListener = () => {
            const { OPEN, CONNECTING } = this.ws;
            if (this.ws.readyState === OPEN || this.ws.readyState === CONNECTING) {
                this.ws.close(4007, 'Stream restarted');
            }
        };
        broadcast.getControlSocket().once('close', this.controlSocketCloseListener);

        let waitingForKeyframe = true;
        if (this.ws.readyState === this.ws.OPEN) {
            // The magic packet is the only source of ScreenInfo for the player, so it must go out
            // even before the first config/key frame is cached, or the client never leaves PAUSED.
            if (
                !this.sendPacket(
                    broadcast.craftInitialInfoPacket(meta?.deviceName || udid, meta?.encoders ?? [], this.clientId),
                )
            )
                return;
            for (const packet of broadcast.getAudioBootstrapPackets()) {
                if (!this.sendPacket(packet)) return;
            }

            // A lone cached IDR is stale and cannot decode future deltas that reference the
            // omitted intervening pictures. Replay the complete current GOP to reach live.
            const videoPackets = broadcast.getVideoBootstrapPackets();
            for (const packet of videoPackets) {
                if (!this.sendPacket(packet)) return;
            }
            waitingForKeyframe = !broadcast.hasCompleteVideoBootstrap();
        }

        const clientId = this.clientId;
        const listener: BroadcastListener = (data, videoKind) => {
            if (this.ws.readyState === this.ws.OPEN) {
                if (videoKind === 'session') {
                    // The device rotated or its encoder restarted. The client takes the picture
                    // size from `scrcpy_initial` alone, so send it again with the new size. The
                    // new session's own config packet and keyframe follow.
                    waitingForKeyframe = true;
                    this.sendPacket(
                        broadcast.craftInitialInfoPacket(
                            meta?.deviceName || udid,
                            meta?.encoders ?? [],
                            clientId,
                            true,
                        ),
                    );
                    return;
                }
                if (videoKind === 'config') {
                    waitingForKeyframe = true;
                } else if (videoKind === 'key') {
                    waitingForKeyframe = false;
                } else if (videoKind === 'delta' && waitingForKeyframe) {
                    // Startup or a bounded-cache overflow may leave no complete GOP. Audio and
                    // device messages still flow while this viewer waits for a usable picture.
                    return;
                }
                this.sendPacket(data);
            } else {
                broadcast.removeListener(listener);
            }
        };

        this.broadcastListener = listener;
        broadcast.addListener(listener);
    }

    private sendPacket(data: Buffer): boolean {
        if (this.ws.readyState !== this.ws.OPEN) return false;
        if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            this.ws.close(4009, 'Connection too slow. Reconnecting.');
            return false;
        }
        this.ws.send(data);
        return true;
    }

    protected onSocketMessage(event: SocketMessageEvent): void {
        const controlSocket = this.broadcast?.getControlSocket();
        if (!controlSocket || controlSocket.readyState !== 'open') {
            return;
        }
        const { data } = event;
        let buffer: Buffer;
        if (typeof data === 'string') {
            buffer = Buffer.from(data);
        } else if (Array.isArray(data)) {
            // A fragmented message arrives as a list of chunks; `Buffer.from()` would not join them
            buffer = Buffer.concat(data);
        } else if (Buffer.isBuffer(data)) {
            // Split from the branch below on purpose: `Buffer.from()` copies a Buffer but only
            // wraps an ArrayBuffer, and the two overloads reject a `Buffer | ArrayBuffer` union.
            buffer = Buffer.from(data);
        } else {
            buffer = Buffer.from(data);
        }
        if (buffer.length >= 3 && buffer.readUInt16BE(1) === this.clientId) {
            if (buffer[0] === ControlMessage.TYPE_UHID_CREATE) {
                this.keyboardCreated = true;
            } else if (buffer[0] === ControlMessage.TYPE_UHID_DESTROY) {
                this.keyboardCreated = false;
            }
        }
        this.trackHeldKey(buffer);
        this.trackHeldTouch(buffer);
        controlSocket.write(buffer);
    }

    /**
     * Remembers a finger this viewer has down. Each touch is a one-message frame. A move counts
     * as down too: scrcpy puts down a pointer it has not seen.
     */
    private trackHeldTouch(buffer: Buffer): void {
        if (buffer.length !== TOUCH_MESSAGE_LENGTH || buffer[0] !== ControlMessage.TYPE_TOUCH) {
            return;
        }
        const pointer = buffer.subarray(2, 10).toString('hex');
        if (buffer[1] === TOUCH_ACTION_UP) {
            this.heldTouches.delete(pointer);
        } else {
            this.heldTouches.set(pointer, Buffer.from(buffer));
        }
    }

    /**
     * Remembers a key this viewer has pressed and not released. A toolbar button sends its
     * down and up as separate one-message frames: type, action, keycode, repeat, meta state.
     * Frames that carry several messages hold complete down/up pairs and are not tracked.
     */
    private trackHeldKey(buffer: Buffer): void {
        if (buffer.length !== KEYCODE_MESSAGE_LENGTH || buffer[0] !== ControlMessage.TYPE_KEYCODE) {
            return;
        }
        const keycode = buffer.readInt32BE(2);
        if (buffer[1] === KEY_ACTION_DOWN) {
            this.heldKeys.add(keycode);
        } else if (buffer[1] === KEY_ACTION_UP) {
            this.heldKeys.delete(keycode);
        }
    }

    public release(): void {
        this.released = true;
        const heldKeys = Array.from(this.heldKeys);
        this.heldKeys.clear();
        if (heldKeys.length && this.broadcast?.getControlSocket().readyState === 'open') {
            // The browser went away with a key down, for example Power held when the network
            // dropped. Its release never arrives, and Android would read a long press.
            for (const keycode of heldKeys) {
                const up = Buffer.alloc(KEYCODE_MESSAGE_LENGTH);
                up[0] = ControlMessage.TYPE_KEYCODE;
                up[1] = KEY_ACTION_UP;
                up.writeInt32BE(keycode, 2);
                this.broadcast.getControlSocket().write(up);
            }
        }
        const heldTouches = Array.from(this.heldTouches.values());
        this.heldTouches.clear();
        if (heldTouches.length && this.broadcast?.getControlSocket().readyState === 'open') {
            // The browser went away with a finger down, for example mid-drag when the network
            // dropped. It cannot send the up, and the browser forgets the touch on a disconnect.
            for (const last of heldTouches) {
                const up = Buffer.from(last);
                up[1] = TOUCH_ACTION_UP;
                up.writeUInt16BE(0, TOUCH_PRESSURE_OFFSET);
                this.broadcast.getControlSocket().write(up);
            }
        }
        if (this.clientId !== undefined) {
            const control = this.broadcast?.getControlSocket();
            if (this.keyboardCreated && control?.readyState === 'open') {
                // A lost browser cannot send its own teardown. Remove only its keyboard,
                // before this ID can be reused, without disturbing another viewer's keys.
                const destroy = Buffer.alloc(3);
                destroy[0] = ControlMessage.TYPE_UHID_DESTROY;
                destroy.writeUInt16BE(this.clientId, 1);
                control.write(destroy);
            }
            this.keyboardCreated = false;
            WebsocketProxy.activeClientIds.delete(this.clientId);
            this.clientId = undefined;
        }
        if (this.broadcast) {
            if (this.broadcastListener) {
                this.broadcast.removeListener(this.broadcastListener);
                this.broadcastListener = undefined;
            }
            if (this.controlSocketCloseListener) {
                this.broadcast.getControlSocket().off('close', this.controlSocketCloseListener);
                this.controlSocketCloseListener = undefined;
            }
        }
        super.release();
    }
}
