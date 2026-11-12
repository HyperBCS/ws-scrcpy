import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import * as path from 'path';
import { ChannelCode } from '../../../common/ChannelCode';
import { FileCommand } from '../../../common/FileCommand';
import { CommandControlMessage, FilePushState } from '../../controlMessage/CommandControlMessage';
import { Entry } from '../Entry';
import { FilePushResponseStatus } from '../filePush/FilePushResponseStatus';

/**
 * Why a request to the phone did not succeed. `refused` carries the phone's own words; the
 * service words the others.
 */
export type FileErrorKind =
    'refused' | 'missing' | 'unsupported' | 'interrupted' | 'unreadable' | 'offline' | 'cancelled';

/** The one error every request rejects with. Its message is fit to show to the owner. */
export class FileError extends Error {
    constructor(
        public readonly kind: FileErrorKind,
        message: string,
    ) {
        super(message);
        this.name = 'FileError';
    }
}

/** A request in flight. `cancel()` closes its channel; the promise then rejects as cancelled. */
export type Cancellable<T> = Promise<T> & { cancel: () => void };

/** The part of a multiplexed channel the service uses (`packages/multiplexer/Multiplexer.ts`). */
export interface FileChannel {
    send(data: Buffer): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    addEventListener(type: 'close', listener: (event: CloseEvent) => void): void;
    removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    removeEventListener(type: 'close', listener: (event: CloseEvent) => void): void;
}

/** The Files channel to one phone. Every request opens a channel of its own inside it. */
export interface FileSocket {
    readonly readyState: number;
    readonly OPEN: number;
    createChannel(payload: Buffer): FileChannel;
}

/** How far an upload is. `saving` is true once every byte is sent: it can no longer be stopped. */
export type UploadProgress = { sent: number; size: number; saving: boolean };

export type UploadOptions = {
    /** The absolute path the file gets on the phone. */
    path: string;
    /** Without it the phone refuses a name that is taken. */
    overwrite: boolean;
    onProgress?: (progress: UploadProgress) => void;
};

const INTERRUPTED = 'The connection to the phone was interrupted.';
const CANCELLED = 'The request was cancelled.';

/**
 * Chunks sent ahead of their acknowledgement. Waiting for each one before sending the next
 * limited an upload to one chunk per round trip, which is slow over a remote connection.
 */
const CHUNKS_IN_FLIGHT = 16;
/** The size of one APPEND, the same as one adb sync DATA packet. */
const CHUNK_BYTES = 64 * 1024;

/** What the phone's upload codes mean (`FilePushResponseStatus`). */
const PUSH_CODES = new Map([
    [FilePushResponseStatus.NEW_PUSH_ID, 'New push id'],
    [FilePushResponseStatus.NO_ERROR, 'No error'],
    [FilePushResponseStatus.ERROR_INVALID_NAME, 'Invalid name'],
    [FilePushResponseStatus.ERROR_NO_SPACE, 'No space'],
    [FilePushResponseStatus.ERROR_FAILED_TO_DELETE, 'Failed to delete existing'],
    [FilePushResponseStatus.ERROR_FAILED_TO_CREATE, 'Failed to create new file'],
    [FilePushResponseStatus.ERROR_FILE_NOT_FOUND, 'File not found'],
    [FilePushResponseStatus.ERROR_FAILED_TO_WRITE, 'Failed to write to file'],
    [FilePushResponseStatus.ERROR_FILE_IS_BUSY, 'File is busy'],
    [FilePushResponseStatus.ERROR_INVALID_STATE, 'Invalid state'],
    [FilePushResponseStatus.ERROR_UNKNOWN_ID, 'Unknown id'],
    [FilePushResponseStatus.ERROR_NO_FREE_ID, 'No free id'],
    [FilePushResponseStatus.ERROR_INCORRECT_SIZE, 'Incorrect size'],
    [FilePushResponseStatus.ERROR_OTHER, 'The upload did not finish'],
    [FilePushResponseStatus.ERROR_FILE_EXISTS, 'An item with this name already exists'],
]);

function pushCodeMessage(code: number): string {
    return `${PUSH_CODES.get(code) || `Unknown error (${code})`}.`;
}

/** `code`, then one `length(u32 LE) + utf8` field. */
function stringCommand(code: string, value: string): Buffer {
    const length = Buffer.byteLength(value, 'utf-8');
    const payload = Buffer.alloc(8 + length);
    payload.write(code, 0, 'ascii');
    payload.writeUInt32LE(length, 4);
    payload.write(value, 8, 'utf-8');
    return payload;
}

/** `replace` adds a trailing 1: without it the phone refuses a destination that exists. */
function pairCommand(code: FileCommand, from: string, to: string, replace: boolean): Buffer {
    const fromLength = Buffer.byteLength(from, 'utf-8');
    const toLength = Buffer.byteLength(to, 'utf-8');
    const payload = Buffer.alloc(12 + fromLength + toLength + (replace ? 1 : 0));
    payload.write(code, 0, 'ascii');
    payload.writeUInt32LE(fromLength, 4);
    payload.write(from, 8, 'utf-8');
    payload.writeUInt32LE(toLength, 8 + fromLength);
    payload.write(to, 12 + fromLength, 'utf-8');
    if (replace) {
        payload.writeUInt8(1, 12 + fromLength + toLength);
    }
    return payload;
}

/** `code`, a count, then one `length + utf8` field per path. */
function listCommand(code: FileCommand, paths: string[]): Buffer {
    const payload = Buffer.alloc(8 + paths.reduce((total, item) => total + 4 + Buffer.byteLength(item, 'utf-8'), 0));
    payload.write(code, 0, 'ascii');
    payload.writeUInt32LE(paths.length, 4);
    let offset = 8;
    paths.forEach((item) => {
        const length = Buffer.byteLength(item, 'utf-8');
        payload.writeUInt32LE(length, offset);
        offset += 4;
        payload.write(item, offset, 'utf-8');
        offset += length;
    });
    return payload;
}

/** The four letters a reply starts with. A reply too short to hold them cannot be read. */
function codeOf(data: Buffer): string {
    if (data.length < 4) throw Error('Truncated reply');
    return data.subarray(0, 4).toString('ascii');
}

/** The text of a FAIL reply: `FAIL length(u32 LE) utf8`. */
function failText(data: Buffer): string {
    return data.length >= 8 ? data.subarray(8, 8 + data.readUInt32LE(4)).toString('utf8') : '';
}

/** A channel the phone ended on purpose: after its answer, or with nothing more to say. */
function normalClose(event: CloseEvent): boolean {
    return event.code === 0 || event.code === 1000;
}

/** The phone's reason for ending a channel early, when it gave one. */
function closeReason(event: CloseEvent): string {
    return (!normalClose(event) && event.reason) || INTERRUPTED;
}

/** One request's channel and the promise that ends with it. */
type Exchange<T> = {
    readonly channel: FileChannel;
    settled: boolean;
    succeed: (value: T) => void;
    /** Rejects the request. `close` also closes its channel, for an answer that ends it. */
    fail: (kind: FileErrorKind, message: string, close?: boolean) => void;
};

type Handlers<T> = {
    /** One reply. A throw counts as a reply that could not be read. */
    message: (data: Buffer, exchange: Exchange<T>) => void;
    /** The channel closed before the request settled. */
    close: (event: CloseEvent, exchange: Exchange<T>) => void;
    /** The request settled, whichever way. */
    end?: (error?: FileError) => void;
};

/** What `request()` opens: the caller's promise, its channel, and the way to end it as cancelled. */
type Request<T> = { promise: Cancellable<T>; exchange: Exchange<T>; abort: () => void };

/** The phone's answers on one upload channel, taken in the order they came. */
class Answers {
    private readonly ready: number[] = [];
    private readonly waiting: { resolve: (code: number) => void; reject: (error: FileError) => void }[] = [];
    private error?: FileError;

    public put(code: number): void {
        const next = this.waiting.shift();
        if (next) next.resolve(code);
        else this.ready.push(code);
    }

    /** The next answer. Handled already, so one that is never awaited rejects quietly. */
    public next(): Promise<number> {
        const answer = this.ready.length
            ? Promise.resolve(this.ready.shift() as number)
            : this.error
              ? Promise.reject(this.error)
              : new Promise<number>((resolve, reject) => this.waiting.push({ resolve, reject }));
        answer.catch(() => undefined);
        return answer;
    }

    public end(error: FileError): void {
        this.error = error;
        this.waiting.splice(0).forEach(({ reject }) => reject(error));
    }
}

/**
 * The Files channel to one phone, as typed requests. Each request opens a channel of its own,
 * so a listing, a folder operation and an upload never wait for one another. Every request is
 * a promise with `cancel()`, and rejects with a `FileError`. Nothing reaches a caller after its
 * request was cancelled or the service was released.
 *
 * The bytes are the ones the explorer sent before this service existed: `scripts/test-files.js`
 * compares them for a fixed script of actions.
 */
export class FileService {
    private readonly channels = new Set<FileChannel>();
    private released = false;

    constructor(
        private readonly socket: FileSocket,
        private readonly options: {
            serial: string;
            /** The phone's server, for a download through a proxy. */
            remote?: string;
        },
    ) {}

    /** The payload that opens the Files channel for a phone. */
    public static channelInit(serial: string): Buffer {
        const name = Buffer.from(serial, 'utf8');
        const buffer = Buffer.alloc(8 + name.length);
        buffer.write(ChannelCode.FSLS, 0);
        buffer.writeUInt32LE(name.length, 4);
        name.copy(buffer, 8);
        return buffer;
    }

    public connected(): boolean {
        return !this.released && this.socket.readyState === this.socket.OPEN;
    }

    /** Describes one item. A folder or a regular file resolves; anything else rejects. */
    public stat(target: string): Cancellable<Entry> {
        return this.request<Entry>(stringCommand(Protocol.STAT, target), {
            message: (data, exchange) => {
                const code = codeOf(data);
                if (code === Protocol.FAIL) {
                    exchange.fail('refused', failText(data) || 'The phone gave no reason.', true);
                } else if (code === Protocol.STAT) {
                    if (data.length < 16) throw Error('Truncated STAT');
                    const entry = new Entry(
                        path.basename(target),
                        data.readUInt32LE(4),
                        data.readUInt32LE(8),
                        data.readUInt32LE(12),
                    );
                    if (!entry.mode) {
                        exchange.fail('missing', 'There is no such folder on the phone, or it cannot be read.', true);
                    } else if (entry.isDirectory() || entry.isFile()) {
                        exchange.succeed(entry);
                    } else {
                        exchange.fail('unsupported', 'This item is not a regular file or folder.', true);
                    }
                }
            },
            close: (event, exchange) => exchange.fail('interrupted', closeReason(event)),
        }).promise;
    }

    /**
     * Lists a folder. `onEntry` hears of each item as it arrives; the promise resolves with all
     * of them once the phone has listed the last one.
     */
    public list(folder: string, onEntry?: (entry: Entry) => void): Cancellable<Entry[]> {
        const entries: Entry[] = [];
        return this.request<Entry[]>(stringCommand(Protocol.LIST, folder), {
            message: (data, exchange) => {
                const code = codeOf(data);
                if (code === Protocol.FAIL) {
                    exchange.fail('refused', failText(data) || 'The phone gave no reason.', true);
                } else if (code === Protocol.DENT) {
                    if (data.length < 20) throw Error('Truncated DENT');
                    const entry = new Entry(
                        data.subarray(20, 20 + data.readUInt32LE(16)).toString('utf8'),
                        data.readUInt32LE(4),
                        data.readUInt32LE(8),
                        data.readUInt32LE(12),
                    );
                    if (entry.name !== '.' && entry.name !== '..') {
                        entries.push(entry);
                        onEntry?.(entry);
                    }
                } else if (code === Protocol.DONE) {
                    exchange.succeed(entries);
                }
            },
            // The server ends a listing by closing the channel.
            close: (event, exchange) =>
                normalClose(event) ? exchange.succeed(entries) : exchange.fail('interrupted', closeReason(event)),
        }).promise;
    }

    /**
     * The true sizes of the files in a folder that are too large for LIST to state in 32 bits,
     * by name. A correction that does not arrive is no failure: what came is kept.
     */
    public largeSizes(folder: string): Cancellable<Map<string, number>> {
        const sizes = new Map<string, number>();
        return this.request<Map<string, number>>(stringCommand(FileCommand.SIZES, folder), {
            message: (data) => {
                if (codeOf(data) === FileCommand.SIZES && data.length >= 16) {
                    const name = data.subarray(16, 16 + data.readUInt32LE(12)).toString('utf8');
                    sizes.set(name, data.readUInt32LE(4) + data.readUInt32LE(8) * 0x100000000);
                }
            },
            close: (_event, exchange) => exchange.succeed(sizes),
        }).promise;
    }

    public mkdir(target: string): Cancellable<void> {
        return this.operation(stringCommand(FileCommand.MKDIR, target));
    }

    public rename(from: string, to: string): Cancellable<void> {
        return this.move(from, to);
    }

    /** Without `replace` the phone refuses a destination that exists. */
    public move(from: string, to: string, replace = false): Cancellable<void> {
        return this.operation(pairCommand(FileCommand.MOVE, from, to, replace));
    }

    public copy(from: string, to: string, replace = false): Cancellable<void> {
        return this.operation(pairCommand(FileCommand.COPY, from, to, replace));
    }

    /** Deletes every path in one request; a folder goes with everything inside it. */
    public remove(paths: string[]): Cancellable<void> {
        return this.operation(listCommand(FileCommand.DELETE, paths));
    }

    /**
     * The address the browser downloads one file from. A download is a plain HTTP request that
     * the browser saves to disk itself: it shows the progress, and the file never passes through
     * the page.
     */
    public downloadLink(target: string): string {
        const endpoint = new URL('api/files/download', new URL('.', location.href));
        endpoint.searchParams.set('udid', this.options.serial);
        endpoint.searchParams.set('path', target);
        if (this.options.remote) {
            endpoint.searchParams.set('remote', this.options.remote);
        }
        return endpoint.href;
    }

    /**
     * Sends one file to `options.path`. The phone writes it under a temporary name and renames
     * it into place at the end, so a cancelled or failed upload leaves nothing behind. Cancel
     * does nothing once every byte is sent and the phone is saving the file.
     */
    public upload(file: Blob, options: UploadOptions): Cancellable<void> {
        const size = file.size;
        const answers = new Answers();
        let pushId = 0;
        let saving = false;
        let finishing = false;
        let cancelAsked = false;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const request = this.request<void>(Buffer.from(Protocol.SEND), {
            message: (data, exchange) => {
                const code = data.readInt8(2);
                if (code === FilePushResponseStatus.NEW_PUSH_ID) {
                    pushId = data.readInt16BE(0);
                }
                answers.put(code);
                // The file is saved. The close that follows at once is the end of the upload.
                if (finishing && code === FilePushResponseStatus.NO_ERROR) {
                    exchange.succeed(undefined);
                }
            },
            // The phone explains a refusal in the close reason.
            close: (event, exchange) =>
                exchange.fail('refused', event.reason || 'Upload connection closed before completion.'),
            end: (error) => {
                answers.end(error || new FileError('cancelled', CANCELLED));
                void reader?.cancel().catch(() => undefined);
            },
        });
        const { exchange, abort } = request;
        const send = (params: Omit<Parameters<typeof CommandControlMessage.createPushFileCommand>[0], 'id'>) =>
            exchange.channel.send(CommandControlMessage.createPushFileCommand({ id: pushId, ...params }).toBuffer());
        const cancelNow = () => {
            send({ state: FilePushState.CANCEL });
            abort();
        };
        const progress = (sent: number) => {
            if (!exchange.settled) options.onProgress?.({ sent, size, saving });
        };
        const refuse = (code: number) => exchange.fail('refused', pushCodeMessage(code));

        const run = async (): Promise<void> => {
            progress(0);
            send({ state: FilePushState.NEW });
            const allocated = await answers.next();
            if (allocated !== FilePushResponseStatus.NEW_PUSH_ID) {
                return refuse(allocated);
            }
            if (pushId <= 0) {
                return refuse(pushId);
            }
            if (cancelAsked) {
                // Cancelled while the id was on its way: the phone hears of it now.
                return cancelNow();
            }
            send({ state: FilePushState.START, fileName: options.path, fileSize: size, overwrite: options.overwrite });
            reader = file.stream().getReader() as ReadableStreamDefaultReader<Uint8Array>;
            const [started, first] = await Promise.all([answers.next(), reader.read()]);
            if (started !== FilePushResponseStatus.NO_ERROR) {
                return refuse(started);
            }
            const inFlight: { response: Promise<number>; bytes: number }[] = [];
            let acknowledged = 0;
            let shown = -1;
            /** Waits for the oldest chunk's acknowledgement and returns its code. */
            const settleOldest = async (): Promise<number> => {
                const { response, bytes } = inFlight.shift() as (typeof inFlight)[number];
                const code = await response;
                if (code === FilePushResponseStatus.NO_ERROR) {
                    acknowledged += bytes;
                    // One report per percent, not one per chunk.
                    const percent = Math.floor((acknowledged * 100) / size);
                    if (percent !== shown) {
                        shown = percent;
                        progress(acknowledged);
                    }
                }
                return code;
            };
            let next = first;
            while (!next.done && next.value) {
                const value = next.value;
                const reading = reader.read();
                // A cancelled upload stops waiting for this read; its failure is not news then.
                reading.catch(() => undefined);
                // A browser may hand over the whole file as one chunk. Pieces of a fixed size
                // keep the phone's buffer, the progress and the window meaningful.
                for (let offset = 0; offset < value.length; offset += CHUNK_BYTES) {
                    const chunk = value.subarray(offset, offset + CHUNK_BYTES);
                    inFlight.push({ response: answers.next(), bytes: chunk.length });
                    send({ state: FilePushState.APPEND, chunk });
                    while (inFlight.length >= CHUNKS_IN_FLIGHT) {
                        const code = await settleOldest();
                        if (code !== FilePushResponseStatus.NO_ERROR) return refuse(code);
                    }
                }
                next = await reading;
                if (exchange.settled) return;
            }
            while (inFlight.length) {
                const code = await settleOldest();
                if (code !== FilePushResponseStatus.NO_ERROR) return refuse(code);
            }
            saving = true;
            progress(size);
            finishing = true;
            const finish = answers.next();
            send({ state: FilePushState.FINISH });
            const finished = await finish;
            if (finished !== FilePushResponseStatus.NO_ERROR) {
                return refuse(finished);
            }
            exchange.succeed(undefined);
        };
        void run().catch((error) => {
            // A settled upload's waits end with its error; anything else is a failure of its own.
            exchange.fail('refused', error instanceof Error ? error.message : 'Upload failed.');
        });

        return Object.assign(request.promise, {
            cancel: () => {
                if (exchange.settled || saving || cancelAsked) {
                    return;
                }
                cancelAsked = true;
                // CANCEL, then the close: the phone stops the transfer and removes the partial
                // file on either. Without an id yet, CANCEL waits for the id.
                if (pushId > 0) {
                    cancelNow();
                }
            },
        });
    }

    /** Closes every channel that is open. Nothing that was asked for answers afterwards. */
    public release(): void {
        if (this.released) {
            return;
        }
        this.released = true;
        [...this.channels].forEach((channel) => channel.close());
        this.channels.clear();
    }

    /** A folder operation: DONE then a close, or FAIL with the phone's reason. */
    private operation(payload: Buffer): Cancellable<void> {
        let done = false;
        return this.request<void>(payload, {
            message: (data, exchange) => {
                const code = codeOf(data);
                if (code === Protocol.FAIL) {
                    exchange.fail('refused', failText(data) || 'The phone refused it.', true);
                } else if (code === Protocol.DONE) {
                    done = true;
                }
            },
            // Reported when the channel closes: the server closes it after its answer.
            close: (event, exchange) =>
                done && normalClose(event)
                    ? exchange.succeed(undefined)
                    : exchange.fail('interrupted', closeReason(event)),
        }).promise;
    }

    /**
     * Opens one request's channel. Replies before the request settles go to `handlers`; after
     * that, and after `release()`, nothing does. `abort()` ends it as cancelled and closes the
     * channel; the promise's `cancel()` is the same unless the caller gives its own.
     */
    private request<T>(payload: Buffer, handlers: Handlers<T>): Request<T> {
        let resolve!: (value: T) => void;
        let reject!: (error: FileError) => void;
        const promise = new Promise<T>((onResolve, onReject) => {
            resolve = onResolve;
            reject = onReject;
        });
        // A request nobody waits for must not end as an unhandled rejection.
        promise.catch(() => undefined);
        const connected = this.connected();
        const channel: FileChannel = connected
            ? this.socket.createChannel(payload)
            : {
                  send: () => undefined,
                  close: () => undefined,
                  addEventListener: () => undefined,
                  removeEventListener: () => undefined,
              };
        const exchange: Exchange<T> = {
            channel,
            settled: false,
            succeed: (value) => {
                if (exchange.settled) return;
                exchange.settled = true;
                resolve(value);
                handlers.end?.();
            },
            fail: (kind, message, close = false) => {
                if (exchange.settled) return;
                exchange.settled = true;
                const error = new FileError(kind, message);
                reject(error);
                handlers.end?.(error);
                if (close) channel.close();
            },
        };
        const abort = () => exchange.fail('cancelled', CANCELLED, true);
        const result: Request<T> = { promise: Object.assign(promise, { cancel: abort }), exchange, abort };
        if (!connected) {
            exchange.fail('offline', 'The connection to the phone is closed.');
            return result;
        }
        this.channels.add(channel);
        const onMessage = (event: MessageEvent) => {
            if (exchange.settled || this.released) return;
            try {
                const data = Buffer.from(event.data);
                if (data.length < 3) throw Error('Truncated reply');
                handlers.message(data, exchange);
            } catch {
                exchange.fail('unreadable', 'The answer from the phone could not be read.', true);
            }
        };
        const onClose = (event: CloseEvent) => {
            channel.removeEventListener('message', onMessage);
            channel.removeEventListener('close', onClose);
            this.channels.delete(channel);
            if (!this.released) handlers.close(event, exchange);
            exchange.fail('cancelled', CANCELLED);
        };
        channel.addEventListener('message', onMessage);
        channel.addEventListener('close', onClose);
        return result;
    }
}
