import { Mw, RequestParameters } from './Mw';
import WS from 'ws';
import { ACTION } from '../../common/Action';
import { Multiplexer } from '../../packages/multiplexer/Multiplexer';
import * as net from 'net';

export class WebsocketProxy extends Mw {
    public static readonly TAG = 'WebsocketProxy';
    private remoteSocket?: WS;
    private released = false;
    private storage: WS.MessageEvent[] = [];

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

    public async init_ws(remoteUrl: string): Promise<void> {
        this.name = `[${WebsocketProxy.TAG}{$${remoteUrl}}]`;
        const remoteSocket = new WS(remoteUrl);
        remoteSocket.onopen = () => {
            this.remoteSocket = remoteSocket;
            this.flush();
        };
        remoteSocket.onmessage = (event) => {
            if (this.ws && this.ws.readyState === this.ws.OPEN) {
                if (Array.isArray(event.data)) {
                    event.data.forEach((data) => this.ws.send(data));
                } else {
                    this.ws.send(event.data);
                }
            }
        };
        remoteSocket.onclose = (e) => {
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.close(e.wasClean ? 1000 : 4010);
            }
        };
        remoteSocket.onerror = (e) => {
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.close(4011, e.message);
            }
        };
    }

    public async init(remoteUrl: string): Promise<void> {
        this.name = `[${WebsocketProxy.TAG}{$${remoteUrl}}]`;
    
        // Parse the remote URL to extract the host and port
        const [host, port] = remoteUrl.split(':');
        console.log(remoteUrl,host,port)
        
        // Create a TCP socket connection to the remote server
        const remoteSocket = new net.Socket();
    
        // Connect to the remote server
        remoteSocket.connect(Number(port), host, () => {
            this.flush();
        });
    
        // Handle incoming data from the remote server
        remoteSocket.on('data', (data: Uint8Array) => {
            console.log("data",this.ws.readyState)
            if (this.ws && this.ws.readyState === this.ws.OPEN) {
                // Send the received data to the WebSocket
                console.log("inside")
                if (Array.isArray(data)) {
                    // Convert each element of Uint8Array to a Buffer or send it directly as a string
                    data.forEach((item) => {
                        console.log("sending1")
                        // Convert each number to a Buffer and send it to the WebSocket
                        this.ws.send(Buffer.from([item]));
                    });
                } else {
                    console.log("sending2")
                    // Send the entire Uint8Array directly to the WebSocket
                    this.ws.send(data);
                }
            }
        });

        remoteSocket.on('connect', () => {
            if (this.ws.readyState === this.ws.OPEN) {
                // do something, e.g., send a message or log
                console.log('Remote connection established');
            }
        });
    
        // Handle the end of the connection
        remoteSocket.on('end', () => {
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.close(1000, 'Remote connection closed');
            }
        });
    
        // Handle errors in the TCP connection
        remoteSocket.on('error', (e: Error) => {
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.close(4011, e.message);
            }
        });
    
        // Handle TCP connection closure
        remoteSocket.on('close', (hadError: boolean) => {
            console.log("closed")
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.close(hadError ? 4010 : 1000);
            }
        });
    }

    private flush(): void {
        if (this.remoteSocket) {
            while (this.storage.length) {
                const event = this.storage.shift();
                if (event && event.data) {
                    this.remoteSocket.send(event.data);
                }
            }
            if (this.released) {
                this.remoteSocket.close();
            }
        }
        this.storage.length = 0;
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        if (this.remoteSocket) {
            this.remoteSocket.send(event.data);
        } else {
            this.storage.push(event);
        }
    }

    public release(): void {
        if (this.released) {
            return;
        }
        super.release();
        this.released = true;
        this.flush();
    }
}
