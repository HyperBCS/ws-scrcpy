import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import Command from '@dead50f7/adbkit/lib/adb/command';
import type Bluebird from 'bluebird';

/** `adb -s <serial> forward --remove <local>`, sent to the adb server instead of spawning the CLI. */
export class KillForwardCommand extends Command<boolean> {
    execute(serial: string, local: string): Bluebird<boolean> {
        this._send(`host-serial:${serial}:killforward:${local}`);
        // The server answers OKAY for the request and OKAY again for its result, as for `forward`.
        const readOkay = (): Bluebird<boolean> =>
            this.parser.readAscii(4).then((reply) => {
                switch (reply) {
                    case Protocol.OKAY:
                        return true;
                    case Protocol.FAIL:
                        return this.parser.readError();
                    default:
                        return this.parser.unexpected(reply, 'OKAY or FAIL');
                }
            });
        return readOkay().then(readOkay);
    }
}
