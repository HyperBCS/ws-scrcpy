import { Mw, RequestParameters } from './Mw';
import WS from 'ws';
import { ACTION } from '../../common/Action';
import { Multiplexer } from '../../packages/multiplexer/Multiplexer';
import { broadcastManager } from '../../common/BroadcastManager';
import { Broadcast } from '../../common/Broadcast';

export class WebsocketProxy extends Mw {
    public static readonly TAG = 'WebsocketProxy';
    private broadcast?: Broadcast;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public static processRequest(ws: WS, params: RequestParameters): WebsocketProxy | undefined {
        const { action, url } = params;
        if (action !== ACTION.PROXY_WS) {
            return;
        }
        const wsString = url.searchParams.get('ws');
        if (!wsString) {
            console.log("clooooose")
            ws.close(4003, `[${this.TAG}] Invalid value "${ws}" for "ws" parameter`);
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

    public async init(udid : string): Promise<void> {
        this.name = `[${WebsocketProxy.TAG}{$${udid}}]`;

        const broadcast = broadcastManager.getBroadcast(udid);
        this.broadcast = broadcast
        
        if (broadcast) {
            const initialInfoPacket = broadcast.craftInitialInfoPacket(
                udid,                    // array of DisplayInfo
                [],
                1 // clientId
            );

            // send magic data, keyframe and config
            const keyFrame = broadcast.getLastKeyframe();
            const configFrame = broadcast.getLastConfigFrame();
            if(keyFrame && configFrame){
                this.ws.send(initialInfoPacket)
                this.ws.send(configFrame)
                this.ws.send(keyFrame)
            }
            const handler = (data: Buffer) => {
                if (this.ws && this.ws.readyState === this.ws.OPEN) {
                    this.ws.send(data);
                } else if(this.ws && this.ws.readyState != this.ws.OPEN) {
                    broadcast.removeListener(handler)
                }
            };
        
            broadcast.addListener(handler);
        }
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        const controlSocket = this.broadcast?.getControlSocket()
        if (controlSocket && controlSocket.readyState === "open") {
            controlSocket.write(Buffer.from(event.data));
        }

    }
}
