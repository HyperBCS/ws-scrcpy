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
        return AdbUtils.checkDevicePath(pathString);
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
                    // An optional trailing byte: 1 lets the operation replace an existing file.
                    const replace = data.length > to.offset && data.readUInt8(to.offset) === 1;
                    FileListing.complete(
                        cmd === FileCommand.MOVE
                            ? AdbUtils.move(serial, source, target, replace)
                            : AdbUtils.copy(serial, source, target, replace),
                        channel,
                    );
                    break;
                }
                case FileCommand.SIZES: {
                    const { value } = FileListing.readString(data, 4);
                    FileListing.sendLargeSizes(serial, value, channel);
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

    /**
     * Answers with one `SIZE low(u32 LE) high(u32 LE) nameLength(u32 LE) name` record per file
     * of 4 GiB or more, then DONE. A folder that cannot be searched answers with DONE alone.
     */
    private static sendLargeSizes(serial: string, folder: string, channel: Multiplexer): void {
        // eslint-disable-next-line no-control-regex
        if (!folder.startsWith('/') || /[\x00-\x1f\x7f]/.test(folder)) {
            throw Error('Only absolute device paths are allowed.');
        }
        AdbUtils.largeFileSizes(serial, folder)
            .catch(() => new Map<string, number>())
            .then((sizes) => {
                if (channel.readyState !== channel.OPEN) {
                    return;
                }
                sizes.forEach((size, name) => {
                    const length = Buffer.byteLength(name, 'utf-8');
                    const record = Buffer.alloc(16 + length);
                    record.write(FileCommand.SIZES, 0, 'ascii');
                    record.writeUInt32LE(size % 0x100000000, 4);
                    record.writeUInt32LE(Math.floor(size / 0x100000000), 8);
                    record.writeUInt32LE(length, 12);
                    record.write(name, 16, 'utf-8');
                    channel.send(record);
                });
                channel.send(Buffer.from(Protocol.DONE, 'ascii'));
                channel.close();
            });
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
