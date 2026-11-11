import { Server as WSServer } from 'ws';
import WS from 'ws';
import { Service } from './Service';
import { HttpServer, ServerAndPort } from './HttpServer';
import { MwFactory } from '../mw/Mw';
import { allowsHost, allowsOrigin, reportRefusedHost } from '../requestOrigin';

export class WebSocketServer implements Service {
    private static instance?: WebSocketServer;
    /** How often every client is pinged. A test shortens it. */
    public static heartbeatMs = 20000;
    /** A client that has not answered this many pings in a row is gone. */
    private static readonly MAX_MISSED_PONGS = 2;
    private servers: WSServer[] = [];
    private heartbeats: Map<WSServer, NodeJS.Timeout> = new Map();
    private mwFactories: Set<MwFactory> = new Set();

    protected constructor() {
        // nothing here
    }

    public static getInstance(): WebSocketServer {
        if (!this.instance) {
            this.instance = new WebSocketServer();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!this.instance;
    }

    public registerMw(mwFactory: MwFactory): void {
        this.mwFactories.add(mwFactory);
    }

    public attachToServer(item: ServerAndPort): WSServer {
        const { server, port } = item;
        const TAG = `WebSocket Server {tcp:${port}}`;
        const wss = new WSServer({
            server,
            maxPayload: 4 * 1024 * 1024,
            verifyClient: ({ req }, done) => {
                if (!allowsHost(req)) {
                    reportRefusedHost(req);
                    done(false, 403, 'Host not allowed');
                } else if (!allowsOrigin(req)) done(false, 403, 'Origin not allowed');
                else done(true);
            },
        });
        wss.on('connection', (ws: WS, request) => {
            // ws reports an oversized or malformed frame as 'error' and then closes the socket.
            // With no listener that event is an uncaught exception, which stops the server.
            ws.on('error', (error: Error) => {
                console.error(`[${TAG}] Socket error: ${error.message}`);
            });
            if (!request.url) {
                ws.close(4001, `[${TAG}] Invalid url`);
                return;
            }
            let url: URL;
            try {
                url = new URL(request.url, 'https://example.org/');
            } catch {
                ws.close(4001, 'Invalid URL');
                return;
            }
            const action = url.searchParams.get('action') || '';
            let processed = false;
            for (const mwFactory of this.mwFactories.values()) {
                try {
                    if (mwFactory.processRequest(ws, { action, request, url })) processed = true;
                } catch {
                    ws.close(1011, 'Connection could not be started');
                    return;
                }
            }
            if (!processed) {
                ws.close(4002, `[${TAG}] Unsupported request`);
            }
            return;
        });
        wss.on('error', (error: Error) => {
            console.error(`[${TAG}] Server error: ${error.message}`);
        });
        wss.on('close', () => {
            this.stopHeartbeat(wss);
            console.log(`${TAG} stopped`);
        });
        this.startHeartbeat(wss, TAG);
        this.servers.push(wss);
        return wss;
    }

    /**
     * A phone that sleeps or drops off Wi-Fi does not close its socket, and an idle stream sends
     * nothing that would fail. Without this its proxy keeps the Android hardware keyboard attached
     * and the iPhone input ownership until the server restarts. Browsers answer pings themselves.
     */
    private startHeartbeat(wss: WSServer, TAG: string): void {
        const missed = new WeakMap<WS, number>();
        wss.on('connection', (ws: WS) => {
            ws.on('pong', () => missed.set(ws, 0));
        });
        const timer = setInterval(() => {
            for (const client of wss.clients) {
                const count = missed.get(client) ?? 0;
                if (count >= WebSocketServer.MAX_MISSED_PONGS) {
                    console.log(`[${TAG}] Closing a client that stopped answering`);
                    // No close handshake: nobody is there to answer it. 'close' follows and
                    // releases the middleware.
                    client.terminate();
                    continue;
                }
                missed.set(client, count + 1);
                if (client.readyState === client.OPEN) {
                    client.ping();
                }
            }
        }, WebSocketServer.heartbeatMs);
        timer.unref();
        this.heartbeats.set(wss, timer);
    }

    private stopHeartbeat(wss: WSServer): void {
        clearInterval(this.heartbeats.get(wss));
        this.heartbeats.delete(wss);
    }

    public getServers(): WSServer[] {
        return this.servers;
    }

    public getName(): string {
        return `WebSocket Server Service`;
    }

    public async start(): Promise<void> {
        const service = HttpServer.getInstance();
        const servers = await service.getServers();
        servers.forEach((item) => {
            this.attachToServer(item);
        });
    }

    public release(): void {
        this.servers.forEach((server) => {
            this.stopHeartbeat(server);
            for (const client of server.clients) {
                client.close(1001, 'Server restarting');
                const timer = setTimeout(() => client.terminate(), 1000);
                timer.unref();
                client.once('close', () => clearTimeout(timer));
            }
            server.close();
        });
    }
}
