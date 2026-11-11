import { StreamReceiver } from '../../client/StreamReceiver';
import { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { ACTION } from '../../../common/Action';
import Util from '../../Util';

export class StreamReceiverScrcpy extends StreamReceiver<ParamsStreamScrcpy> {
    public static parseParameters(params: URLSearchParams): ParamsStreamScrcpy {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.STREAM_SCRCPY) {
            throw Error('Incorrect action');
        }
        return {
            ...typedParams,
            action,
            udid: Util.parseString(params, 'udid', true),
            ws: Util.parseString(params, 'ws', true),
            player: Util.parseString(params, 'player', true),
        };
    }
    protected buildDirectWebSocketUrl(): URL {
        const { ws, useProxy } = this.params as ParamsStreamScrcpy;
        const url = new URL(ws);
        if (useProxy) {
            // Wrapped in this server's proxy, which connects to configured hosts only.
            return url;
        }
        // `ws` comes from the link. Control input, and the lock-screen code with it, goes down
        // this socket, so the link may not point it at another host.
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (url.protocol !== protocol || url.host !== location.host || url.username || url.password) {
            throw Error('This link connects to another server. Open the device from the Devices page.');
        }
        return url;
    }
}
