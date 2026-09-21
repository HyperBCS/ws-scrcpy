import { Mw, RequestParameters, SocketMessageEvent } from './Mw';
import WS from 'ws';
import { ACTION } from '../../common/Action';
import { Multiplexer } from '../../packages/multiplexer/Multiplexer';
import { broadcastManager } from '../../common/BroadcastManager';
import { Broadcast, VideoFrameKind } from '../../common/Broadcast';
import { ControlMessage } from '../../app/controlMessage/ControlMessage';

type BroadcastListener = (data: Buffer, videoKind?: VideoFrameKind) => void;

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

    public static processRequest(ws: WS, params: RequestParameters): WebsocketProxy | undefined {
        const { action, url } = params;
        if (action !== ACTION.PROXY_WS) {
            return;
        }
        const wsString = url.searchParams.get('ws');
        if (!wsString) {
            ws.close(4003, `[${this.TAG}] Invalid value "${wsString}" for "ws" parameter`);
            return;
        }
        return this.createProxy(ws, wsString);
    }

    public static createProxy(ws: WS | Multiplexer, remoteUrl: string): WebsocketProxy {
        const service = new WebsocketProxy(ws);
        service.init(remoteUrl).catch((e) => {
            const msg = `[${this.TAG}] Failed to start service: ${e.message}`;
            console.error(msg);
            ws.close(4005, msg);
        });
        return service;
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

        // craftInitialInfoPacket reports videoWidth/videoHeight, which are 0 until the 16-byte
        // codec header has been consumed. The client latches that ScreenInfo permanently, so
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
        // Broadcast.stop() destroy()s the control socket, which is the one teardown signal
        // available here without adding an event to Broadcast/BroadcastManager themselves -
        // those are owned by another change in flight.
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
            this.ws.send(
                broadcast.craftInitialInfoPacket(meta?.deviceName || udid, meta?.encoders ?? [], this.clientId),
            );
            for (const packet of broadcast.getAudioBootstrapPackets()) {
                this.ws.send(packet);
            }

            // A lone cached IDR is stale and cannot decode future deltas that reference the
            // omitted intervening pictures. Replay the complete current GOP to reach live.
            const videoPackets = broadcast.getVideoBootstrapPackets();
            for (const packet of videoPackets) {
                this.ws.send(packet);
            }
            waitingForKeyframe = !broadcast.hasCompleteVideoBootstrap();
        }

        const listener: BroadcastListener = (data, videoKind) => {
            if (this.ws.readyState === this.ws.OPEN) {
                if (videoKind === 'config') {
                    waitingForKeyframe = true;
                } else if (videoKind === 'key') {
                    waitingForKeyframe = false;
                } else if (videoKind === 'delta' && waitingForKeyframe) {
                    // Startup or a bounded-cache overflow may leave no complete GOP. Audio and
                    // device messages still flow while this viewer waits for a usable picture.
                    return;
                }
                this.ws.send(data);
            } else {
                broadcast.removeListener(listener);
            }
        };

        this.broadcastListener = listener;
        broadcast.addListener(listener);
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
        controlSocket.write(buffer);
    }

    public release(): void {
        this.released = true;
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
