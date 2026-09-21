import { Message } from '../../types/Message';
import * as http from 'http';
import { Multiplexer } from '../../packages/multiplexer/Multiplexer';
import WS from 'ws';

export type RequestParameters = {
    request: http.IncomingMessage;
    url: URL;
    action: string;
};

/**
 * Shape shared by `WS.MessageEvent` (when `ws` is a real socket) and the DOM `MessageEvent`
 * dispatched by `Multiplexer`. `Mw` can be built on either, so the handler must accept both.
 */
export interface SocketMessageEvent {
    data: WS.Data;
    type: string;
}

export interface MwFactory {
    processRequest(ws: WS, params: RequestParameters): Mw | undefined;
    processChannel(ws: Multiplexer, code: string, data?: ArrayBuffer): Mw | undefined;
}

export abstract class Mw {
    protected name = 'Mw';

    public static processChannel(_ws: Multiplexer, _code: string, _data?: ArrayBuffer): Mw | undefined {
        return;
    }

    public static processRequest(_ws: WS, _params: RequestParameters): Mw | undefined {
        return;
    }

    protected constructor(protected readonly ws: WS | Multiplexer) {
        const onMessage = this.onSocketMessage.bind(this);
        const onClose = this.onSocketClose.bind(this);
        // Both types accept these listeners, but their generic `addEventListener`
        // declarations do not form a callable union, so narrow before registering.
        if (this.ws instanceof Multiplexer) {
            this.ws.addEventListener('message', onMessage);
            this.ws.addEventListener('close', onClose);
        } else {
            this.ws.addEventListener('message', onMessage);
            this.ws.addEventListener('close', onClose);
        }
    }

    protected abstract onSocketMessage(event: SocketMessageEvent): void;

    protected sendMessage = (data: Message): void => {
        if (this.ws.readyState !== this.ws.OPEN) {
            return;
        }
        this.ws.send(JSON.stringify(data));
    };

    protected onSocketClose(): void {
        this.release();
    }

    public release(): void {
        const { readyState, CLOSED, CLOSING } = this.ws;
        if (readyState !== CLOSED && readyState !== CLOSING) {
            this.ws.close();
        }
    }
}
