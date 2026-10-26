import WS from 'ws';
import { Mw, RequestParameters, SocketMessageEvent } from './Mw';
import { Config } from '../Config';
import { ACTION } from '../../common/Action';

/** A configured upstream connection, independent of local scrcpy broadcasts. */
export class RemoteWebsocketProxy extends Mw {
    private readonly upstream: WS;
    private released = false;
    private pending: Array<WS.RawData | string> = [];
    private pendingBytes = 0;

    static processRequest(socket: WS, params: RequestParameters): RemoteWebsocketProxy | undefined {
        if (params.action !== ACTION.PROXY_WS) return;
        let target: URL;
        try {
            target = new URL(params.url.searchParams.get('ws') || '');
        } catch {
            socket.close(4003, 'Invalid remote URL');
            return;
        }
        const host = Config.getInstance().getProxyHost(target);
        if (!host || target.searchParams.get('action') === ACTION.PROXY_WS) {
            socket.close(4003, 'Remote host is not configured');
            return;
        }
        return new RemoteWebsocketProxy(socket, target, host.accessKey);
    }

    constructor(
        private readonly client: WS,
        target: URL,
        key?: string,
    ) {
        super(client);
        this.upstream = new WS(target, {
            handshakeTimeout: 10000,
            maxPayload: 20 * 1024 * 1024,
            ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
        });
        client.pause();
        this.upstream.on('open', () => {
            if (this.released) return;
            for (const data of this.pending) this.upstream.send(data, { binary: typeof data !== 'string' });
            this.pending = [];
            this.pendingBytes = 0;
            client.resume();
        });
        this.upstream.on('message', (data, binary) => {
            if (client.readyState !== client.OPEN) return;
            if (client.bufferedAmount > 20 * 1024 * 1024) {
                client.close(4009, 'Connection too slow. Reconnecting.');
                this.release();
            } else client.send(data, { binary });
        });
        this.upstream.on('error', () => {
            if (client.readyState === client.OPEN) client.close(4005, 'Remote connection failed');
            this.release();
        });
        this.upstream.on('close', () => {
            if (client.readyState === client.OPEN) client.close(4007, 'Remote connection closed');
            this.release();
        });
    }

    protected onSocketMessage({ data }: SocketMessageEvent): void {
        if (this.released) return;
        if (this.upstream.readyState === this.upstream.CONNECTING) {
            this.pendingBytes +=
                typeof data === 'string'
                    ? Buffer.byteLength(data)
                    : Array.isArray(data)
                      ? data.reduce((size, chunk) => size + chunk.byteLength, 0)
                      : data.byteLength;
            if (this.pendingBytes <= 65536) this.pending.push(data);
            else this.release();
        } else if (this.upstream.readyState === this.upstream.OPEN) {
            if (this.upstream.bufferedAmount > 4 * 1024 * 1024) this.release();
            else this.upstream.send(data, { binary: typeof data !== 'string' });
        }
    }

    public release(): void {
        if (this.released) return;
        this.released = true;
        this.pending = [];
        this.upstream?.terminate();
        super.release();
    }
}
