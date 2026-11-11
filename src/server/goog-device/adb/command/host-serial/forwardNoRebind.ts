import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import Command from '@dead50f7/adbkit/lib/adb/command';
import type Bluebird from 'bluebird';

/**
 * `adb forward --no-rebind`: fails when the local port already has a forward, where the plain
 * form quietly points that port at the new device.
 */
export class ForwardNoRebindCommand extends Command<boolean> {
    execute(serial: string, local: string, remote: string): Bluebird<boolean> {
        this._send(`host-serial:${serial}:forward:norebind:${local};${remote}`);
        // adb answers twice: once for the request, once for the forward itself.
        return this.readStatus().then(() => this.readStatus());
    }

    private readStatus(): Bluebird<boolean> {
        return this.parser.readAscii(4).then((reply) => {
            switch (reply) {
                case Protocol.OKAY:
                    return true;
                case Protocol.FAIL:
                    return this.parser.readError();
                default:
                    return this.parser.unexpected(reply, 'OKAY or FAIL');
            }
        });
    }
}
