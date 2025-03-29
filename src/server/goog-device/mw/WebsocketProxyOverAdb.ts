import { WebsocketProxy } from '../../mw/WebsocketProxy';
import { AdbUtils } from '../AdbUtils';
import WS from 'ws';
import { RequestParameters } from '../../mw/Mw';
import { ACTION } from '../../../common/Action';

export class WebsocketProxyOverAdb extends WebsocketProxy {
    public static processRequest(ws: WS, params: RequestParameters): WebsocketProxy | undefined {
        const { action, url } = params;
        let udid: string | null = '';
        let remote: string | null = '';
        let path: string | null = '';
        let isSuitable = false;
        if (action === ACTION.PROXY_ADB) {
            isSuitable = true;
            remote = url.searchParams.get('remote');
            udid = url.searchParams.get('udid');
            path = url.searchParams.get('path');
        }
        if (url && url.pathname) {
            const temp = url.pathname.split('/');
            // Shortcut for action=proxy, without query string
            if (temp.length >= 4 && temp[0] === '' && temp[1] === ACTION.PROXY_ADB) {
                isSuitable = true;
                temp.splice(0, 2);
                udid = decodeURIComponent(temp.shift() || '');
                remote = decodeURIComponent(temp.shift() || '');
                path = temp.join('/') || '/';
            }
        }
        if (!isSuitable) {
            return;
        }
        if (typeof remote !== 'string' || !remote) {
            ws.close(4003, `[${this.TAG}] Invalid value "${remote}" for "remote" parameter`);
            return;
        }
        if (typeof udid !== 'string' || !udid) {
            ws.close(4003, `[${this.TAG}] Invalid value "${udid}" for "udid" parameter`);
            return;
        }
        if (path && typeof path !== 'string') {
            ws.close(4003, `[${this.TAG}] Invalid value "${path}" for "path" parameter`);
            return;
        }
        return this.createProxyOverAdb(ws, udid, remote, path);
    }

    public static createProxyOverAdb(ws: WS, udid: string, remote: string, _?: string | null): WebsocketProxy {
        const service = new WebsocketProxy(ws);
        console.log("Hello",remote)
        // AdbUtils.forward(udid, "localabstract:scrcpy")
        // .then((port) => {
        //     console.log("new port", port);
            
        //     // Create a socket to connect to the local port
        //     const socket = net.createConnection({ host: '127.0.0.1', port: port }, () => {
        //         console.log(`Connected to port ${port}`);
        //     });
    
        //     // Read data from the socket
        //     socket.on('data', (_) => {
        //         // console.log('Received data:', data.toString());
        //     });
    
        //     // Handle error events
        //     socket.on('error', (err) => {
        //         console.error('Socket error:', err);
        //     });
    
        //     // Handle the end of the connection
        //     socket.on('end', () => {
        //         console.log('Connection closed');
        //     });
        // })
        // .catch((e) => {
        //     console.log("ERROR", e);
        // });
        AdbUtils.forward(udid, "localabstract:scrcpy")
            .then((port) => {
                return service.init(`127.0.0.1:${port}`);
            })
            .catch((e) => {
                const msg = `[${this.TAG}] Failed to start service: ${e.message}`;
                console.error(msg);
                console.log(e)
                ws.close(4005, msg);
            });
        // AdbUtils.forward(udid, remote)
        //     .then((port) => {
        //         return service.init(`ws://127.0.0.1:${port}${path ? path : ''}`);
        //     })
        //     .catch((e) => {
        //         const msg = `[${this.TAG}] Failed to start service: ${e.message}`;
        //         console.error(msg);
        //         ws.close(4005, msg);
        //     });
        return service;
    }
}
