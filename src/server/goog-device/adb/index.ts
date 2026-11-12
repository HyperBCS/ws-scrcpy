import { getSettings } from '../../Settings';
import Adb from '@dead50f7/adbkit/lib/adb';
import Connection from '@dead50f7/adbkit/lib/adb/connection';
import Bluebird from 'bluebird';
import type { ChildProcess } from 'child_process';
import type { Duplex } from 'stream';
import type AdbKitClient from '@dead50f7/adbkit/lib/adb/client';
import { createReadStream, ReadStream } from 'fs';
import type PushTransfer from '@dead50f7/adbkit/lib/adb/sync/pushtransfer';
import { ExtendedClient } from './ExtendedClient';
import { ClientOptions } from '@dead50f7/adbkit/lib/ClientOptions';
import { KillForwardCommand } from './command/host-serial/killforward';

interface Options {
    host?: string;
    port?: number;
    bin?: string;
}

/**
 * When the adb server refuses a connection, adbkit runs `<bin> start-server` and tries again.
 * This server must never do that. In the container the started server has no USB access, yet it
 * holds port 5037 on the host network, so no Android device appears and the host's own adb server
 * cannot start. Nothing exists at this path, so the attempt fails and the tracker retries later.
 */
export const NO_ADB_BINARY = '/nonexistent/ws-scrcpy-never-starts-adb';

/** Operation connections must never invoke adbkit's automatic daemon startup. */
class OperationConnection extends Connection {
    public startServer(): Bluebird<ChildProcess> {
        return Bluebird.reject(
            Error(
                `The adb server at ${this.options.host}:${this.options.port} is not running. ` +
                    'Start it on the host with "adb start-server".',
            ),
        );
    }
}

/** Talks to the adb server that is already running. It never starts one. */
export class HostAdbClient extends ExtendedClient {
    public connection(): Bluebird<Connection> {
        return super.connection().catch((error: NodeJS.ErrnoException) => {
            if (error.path === NO_ADB_BINARY) {
                throw new Error(
                    `The adb server at ${this.options.host}:${this.options.port} is not running. ` +
                        'Start it on the host with "adb start-server".',
                );
            }
            throw error;
        });
    }

    /** Removes one forward, as `adb forward --remove` does, without spawning the adb client. */
    public async killForward(serial: string, local: string): Promise<void> {
        const connection = await this.connection();
        try {
            await new KillForwardCommand(connection).execute(serial, local);
        } finally {
            connection.end();
        }
    }
}

export class AdbExtended extends Adb {
    /**
     * Keep adbkit's commands/parsers, but own their sockets before connection/OKAY.
     * Each operation has its own client view and connection set; the original client
     * and concurrent operations are never changed. Streaming callers close on end.
     */
    static operation<T extends AdbKitClient>(
        client: T,
        signal?: AbortSignal,
    ): { client: T; close(error?: Error): void } {
        const scoped = Object.create(client) as T;
        const sockets = new Set<Duplex>();
        const sources = new Set<ReadStream>();
        const transfers = new Set<PushTransfer>();
        let closed = false;
        let failure = Error('The phone connection ended.');
        const close = (error?: Error) => {
            if (closed) return;
            closed = true;
            if (error) failure = error;
            signal?.removeEventListener('abort', abort);
            const uploading = transfers.size > 0;
            transfers.forEach((transfer) => transfer.cancel());
            sources.forEach((source) => source.destroy());
            sockets.forEach((socket) => socket.destroy(uploading ? undefined : error));
        };
        const abort = () => close(signal?.reason instanceof Error ? signal.reason : failure);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        scoped.connection = () => {
            if (closed) return Bluebird.reject(failure);
            const connection = new OperationConnection(client.options);
            // The command parser/returned stream owns errors, including queued late errors.
            connection.on('error', () => undefined);
            const pending = connection.connect();
            // connect() creates the socket/parser synchronously, before its promise resolves.
            const socket = connection.parser.raw();
            sockets.add(socket);
            socket.on('error', () => undefined);
            socket.once('close', () => sockets.delete(socket));
            if (closed) socket.destroy(failure);
            return pending.catch((error: Error) => {
                socket.destroy();
                throw error;
            });
        };
        scoped.syncService = (serial, callback) =>
            client.syncService
                .call(scoped, serial)
                .then((sync) => {
                    const ownedSync = Object.create(sync) as typeof sync;
                    ownedSync.push = (contents, path, mode) => {
                        // Open at the same point as adbkit pushFile, after sync OKAY. Keep
                        // the file reader too: cancelling adbkit's writer does not close it.
                        const source = typeof contents === 'string' ? createReadStream(contents) : contents;
                        sources.add(source);
                        source.on('error', () => undefined);
                        source.once('close', () => sources.delete(source));
                        const transfer = sync.push(source, path, mode);
                        transfers.add(transfer);
                        transfer.on('error', () => undefined);
                        // adbkit's cancel listener returns its reader promise. EventEmitter
                        // discards that result, so observe its expected cancellation locally.
                        let cancelled = false;
                        transfer.cancel = () => {
                            // The scope and upload caller can receive the same abort.
                            if (cancelled) return transfer.listenerCount('cancel') > 0;
                            if (!closed) {
                                close(Error('The phone transfer was cancelled.'));
                                return true;
                            }
                            cancelled = true;
                            const handlers = transfer.rawListeners('cancel');
                            for (const handler of handlers) {
                                const pending = handler.call(transfer);
                                if (pending instanceof Bluebird)
                                    pending.catch((error: Error) => {
                                        if (!(error instanceof Bluebird.CancellationError))
                                            transfer.emit('error', error);
                                    });
                            }
                            return handlers.length > 0;
                        };
                        const done = () => {
                            transfers.delete(transfer);
                            sources.delete(source);
                            source.destroy();
                        };
                        transfer.once('end', done);
                        transfer.once('error', done);
                        if (closed) {
                            transfer.cancel();
                            source.destroy();
                        }
                        return transfer;
                    };
                    return ownedSync;
                })
                .nodeify(callback);
        return { client: scoped, close };
    }

    static createClient(options: Options = {}): HostAdbClient {
        const opts: ClientOptions = {
            bin: options.bin || NO_ADB_BINARY,
            host: options.host || getSettings().adbHost,
            port: options.port || 0,
        };
        if (!opts.port) {
            opts.port = getSettings().adbPort;
        }
        return new HostAdbClient(opts);
    }
}
