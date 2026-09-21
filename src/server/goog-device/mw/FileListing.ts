import * as path from 'path';
import { Mw } from '../../mw/Mw';
import { AdbUtils } from '../AdbUtils';
import Util from '../../../app/Util';
import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ChannelCode } from '../../../common/ChannelCode';
import { FileCommand } from '../../../common/FileCommand';
import { FilePushReader } from '../filePush/FilePushReader';

export class FileListing extends Mw {
    public static readonly TAG = 'FileListing';
    protected name = 'FileListing';

    public static processChannel(ws: Multiplexer, code: string, data: ArrayBuffer): Mw | undefined {
        if (code !== ChannelCode.FSLS) {
            return;
        }
        if (!data || data.byteLength < 4) {
            return;
        }
        const buffer = Buffer.from(data);
        const length = buffer.readInt32LE(0);
        const serial = Util.utf8ByteArrayToString(buffer.slice(4, 4 + length));
        return new FileListing(ws, serial);
    }

    constructor(
        ws: Multiplexer,
        private readonly serial: string,
    ) {
        super(ws);
        ws.on('channel', (params) => {
            FileListing.handleNewChannel(this.serial, params.channel, params.data);
        });
    }

    protected sendMessage = (): void => {
        throw Error('Do not use this method. You must send data over channels');
    };

    protected onSocketMessage(): void {
        // Nothing here. All communication are performed over the channels. See `handleNewChannel` below.
    }

    /**
     * Reads one `length(u32 LE) + utf8` field. Returns the value and the offset after it, so a
     * command carrying several paths (MOVE, DELE) can keep walking the same buffer.
     */
    private static readString(data: Buffer, offset: number): { value: string; offset: number } {
        if (data.length < offset + 4) {
            throw Error('Invalid message. Missing length');
        }
        const length = data.readUInt32LE(offset);
        offset += 4;
        if (data.length < offset + length) {
            throw Error('Invalid message. Truncated value');
        }
        const value = Util.utf8ByteArrayToString(data.slice(offset, offset + length));
        return { value, offset: offset + length };
    }

    /**
     * Mutating commands reach `adb shell`, so a path must be a plain absolute device path.
     * Control characters are rejected because a newline would also break the exit-status marker
     * `AdbUtils.shellExec` appends, and a rejected command is far better than a misread one.
     */
    private static checkPath(pathString: string): string {
        if (!pathString.startsWith('/')) {
            throw Error('Only absolute device paths are allowed.');
        }
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(pathString)) {
            throw Error('This name contains characters that cannot be used on the device.');
        }
        const normalized = path.posix.normalize(pathString).replace(/\/+$/, '') || '/';
        if (normalized === '/') {
            throw Error('The device root cannot be changed.');
        }
        return normalized;
    }

    private static handleNewChannel(serial: string, channel: Multiplexer, arrayBuffer: ArrayBuffer): void {
        const data = Buffer.from(arrayBuffer);
        if (data.length < 4) {
            console.error(`[${FileListing.TAG}]`, `Invalid message. Too short (${data.length})`);
            return;
        }
        const cmd = Util.utf8ByteArrayToString(data.slice(0, 4));
        try {
            switch (cmd) {
                case Protocol.LIST:
                case Protocol.STAT:
                case Protocol.RECV: {
                    const { value } = FileListing.readString(data, 4);
                    FileListing.handle(cmd, serial, value, channel).catch((error: Error) => {
                        FileListing.sendError(error.message, channel);
                    });
                    break;
                }
                case Protocol.SEND:
                    FilePushReader.handle(serial, channel);
                    break;
                case FileCommand.MKDIR: {
                    const { value } = FileListing.readString(data, 4);
                    FileListing.complete(AdbUtils.makeDirectory(serial, FileListing.checkPath(value)), channel);
                    break;
                }
                case FileCommand.MOVE:
                case FileCommand.COPY: {
                    const from = FileListing.readString(data, 4);
                    const to = FileListing.readString(data, from.offset);
                    const source = FileListing.checkPath(from.value);
                    const target = FileListing.checkPath(to.value);
                    FileListing.complete(
                        cmd === FileCommand.MOVE
                            ? AdbUtils.move(serial, source, target)
                            : AdbUtils.copy(serial, source, target),
                        channel,
                    );
                    break;
                }
                case FileCommand.DELETE: {
                    if (data.length < 8) {
                        throw Error('Invalid message. Missing count');
                    }
                    const count = data.readUInt32LE(4);
                    let offset = 8;
                    const paths: string[] = [];
                    for (let i = 0; i < count; i++) {
                        const item = FileListing.readString(data, offset);
                        offset = item.offset;
                        paths.push(FileListing.checkPath(item.value));
                    }
                    if (!paths.length) {
                        throw Error('Nothing was selected to delete.');
                    }
                    FileListing.complete(AdbUtils.remove(serial, paths), channel);
                    break;
                }
                default:
                    console.error(`[${FileListing.TAG}]`, `Invalid message. Wrong command (${cmd})`);
                    channel.close(4001, `Invalid message. Wrong command (${cmd})`);
                    break;
            }
        } catch (error: any) {
            FileListing.sendError(error?.message || 'The device rejected this request.', channel);
        }
    }

    private static async handle(cmd: string, serial: string, pathString: string, channel: Multiplexer): Promise<void> {
        if (cmd === Protocol.STAT) {
            return AdbUtils.pipeStatToStream(serial, pathString, channel);
        }
        if (cmd === Protocol.LIST) {
            return AdbUtils.pipeReadDirToStream(serial, pathString, channel);
        }
        if (cmd === Protocol.RECV) {
            return AdbUtils.pipePullFileToStream(serial, pathString, channel);
        }
    }

    /** Mutating commands answer with a single DONE or FAIL, so the client can report either. */
    private static complete(operation: Promise<void>, channel: Multiplexer): void {
        operation
            .then(() => {
                if (channel.readyState === channel.OPEN) {
                    channel.send(Buffer.from(Protocol.DONE, 'ascii'));
                    channel.close();
                }
            })
            .catch((error: Error) => {
                FileListing.sendError(error.message, channel);
            });
    }

    private static sendError(message: string, channel: Multiplexer): void {
        if (channel.readyState === channel.OPEN) {
            const length = Buffer.byteLength(message, 'utf-8');
            const buf = Buffer.alloc(4 + 4 + length);
            let offset = buf.write(Protocol.FAIL, 'ascii');
            offset = buf.writeUInt32LE(length, offset);
            buf.write(message, offset, 'utf-8');
            channel.send(buf);
            channel.close();
        }
    }
}
