import Connection from '@dead50f7/adbkit/lib/adb/connection';
import Parser from '@dead50f7/adbkit/lib/adb/parser';
import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';

export class ExtendedSync {
    private parser: Parser;

    constructor(private connection: Connection) {
        this.connection = connection;
        this.parser = this.connection.parser;
    }

    public async pipeReadDir(path: string, stream: Multiplexer): Promise<void> {
        const readNext = async (): Promise<void> => {
            const reply = await this.parser.readAscii(4);
            switch (reply) {
                case Protocol.DENT: {
                    const stat = await this.parser.readBytes(16);
                    const namelen = stat.readUInt32LE(12);
                    const name = await this.parser.readBytes(namelen);
                    if (stream.readyState !== stream.OPEN) {
                        // The browser left this folder. The caller ends the adb connection.
                        return;
                    }
                    stream.send(Buffer.concat([Buffer.from(reply), stat, name]));
                    return readNext();
                }
                case Protocol.DONE:
                    await this.parser.readBytes(16);
                    stream.close(0);
                    return;
                case Protocol.FAIL:
                    return this._readError(stream);
                default:
                    return this.parser.unexpected(reply, 'DENT, DONE or FAIL');
            }
        };
        this._sendCommandWithArg(Protocol.LIST, path);
        return readNext();
    }

    private _sendCommandWithArg(cmd: string, arg: string): Connection {
        const arglen = Buffer.byteLength(arg, 'utf-8');
        const payload = Buffer.alloc(cmd.length + 4 + arglen);
        let pos = 0;
        payload.write(cmd, pos, cmd.length);
        pos += cmd.length;
        payload.writeUInt32LE(arglen, pos);
        pos += 4;
        payload.write(arg, pos);
        return this.connection.write(payload);
    }

    private async _readError(stream: Multiplexer): Promise<void> {
        const length = await this.parser.readBytes(4);
        const message = await this.parser.readAscii(length.readUInt32LE(0));
        stream.close(4000, message);
        await this.parser.end();
        return;
    }

    public end(): ExtendedSync {
        this.connection.end();
        return this;
    }
}
