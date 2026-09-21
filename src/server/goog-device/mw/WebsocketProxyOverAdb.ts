import { StreamMeta, WebsocketProxy } from '../../mw/WebsocketProxy';
import { ControlCenter } from '../services/ControlCenter';
import { broadcastManager } from '../../../common/BroadcastManager';
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

    public static createProxyOverAdb(ws: WS, udid: string, _: string, __?: string | null): WebsocketProxy {
        const service = new WebsocketProxy(ws);
        this.connect(service, udid).catch((e: Error) => {
            console.error(`[${this.TAG}] Failed to start service: ${e.message}`);
        });
        return service;
    }

    /**
     * Makes sure a scrcpy server is actually running for this device before attaching the proxy.
     *
     * The server exits once its last viewer disconnects, and the only other caller of
     * `startServer()` is `fetchDeviceInfo`'s update cycle -- which deliberately backs off and
     * stops. So without this, closing the last tab left the device permanently unstreamable:
     * every later connection found no broadcast and was closed, with nothing ever restarting the
     * server short of restarting ws-scrcpy itself. `startServer()` is idempotent (it returns the
     * existing pid when one is running), so this is cheap on the common path.
     */
    private static async connect(service: WebsocketProxy, udid: string): Promise<void> {
        // Looked up here rather than inside WebsocketProxy: this class is already Android-only
        // and behind INCLUDE_GOOG, so reaching into the Android ControlCenter is free, whereas
        // doing it from the platform-agnostic mw/ layer would statically bundle adbkit into an
        // iOS-only build.
        const device = ControlCenter.hasInstance() ? ControlCenter.getInstance().getDevice(udid) : undefined;
        if (device && !broadcastManager.hasBroadcast(udid)) {
            try {
                await device.startServer();
            } catch (e) {
                console.error(`[${this.TAG}] Could not start scrcpy server: ${(e as Error).message}`);
            }
        }
        const meta: StreamMeta | undefined = device
            ? {
                  deviceName: device.getDeviceName() || udid,
                  encoders: device.getCachedEncoders().map((encoder) => encoder.encoderName),
              }
            : undefined;
        await service.init(udid, meta);
    }
}
