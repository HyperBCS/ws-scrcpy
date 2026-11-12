import { Duplex } from 'stream';
import AdbKitClient from '@dead50f7/adbkit/lib/adb/client';
import { AdbExtended } from './adb';

export type ShellResult = { code: number; output: string };

// Leave room for adb's service prefix and the status marker in its four-hex-digit frame.
const MAX_SHELL_COMMAND_BYTES = 65000;

/** Shell transports belong to this phone, including connections that arrive after cancellation. */
export class AdbShell {
    private lifetime = new AbortController();
    private released = false;

    constructor(
        private readonly serial: string,
        private readonly client: AdbKitClient = AdbExtended.createClient(),
    ) {}

    public cancel(): void {
        this.lifetime.abort(new Error('The phone connection ended.'));
        this.lifetime = new AbortController();
    }

    public release(): void {
        this.released = true;
        this.cancel();
    }

    /** adbkit's legacy shell resolves to a raw Duplex after OKAY; stdout and stderr are combined. */
    public open(command: string, signal?: AbortSignal): Promise<Duplex> {
        const lifetime = this.lifetime.signal;
        const operation = AdbExtended.operation(this.client);
        return new Promise((resolve, reject) => {
            let socket: Duplex | undefined;
            let cancelled = false;
            const cleanup = (error?: Error) => {
                lifetime.removeEventListener('abort', abort);
                signal?.removeEventListener('abort', abort);
                operation.close(error);
            };
            const abort = () => {
                cancelled = true;
                const reason = signal?.reason ?? lifetime.reason ?? new Error('The phone connection ended.');
                cleanup(reason instanceof Error ? reason : undefined);
                socket?.destroy();
                reject(reason);
            };
            lifetime.addEventListener('abort', abort, { once: true });
            signal?.addEventListener('abort', abort, { once: true });
            if (this.released || lifetime.aborted || signal?.aborted) {
                abort();
                return;
            }
            Promise.resolve()
                .then(() => {
                    if (cancelled) throw signal?.reason ?? lifetime.reason;
                    return operation.client.shell(this.serial, command);
                })
                .then(
                    (stream) => {
                        socket = stream;
                        // Keep errors handled even when a cancelled connection is delivered late.
                        stream.on('error', () => undefined);
                        if (cancelled) {
                            stream.destroy();
                            return;
                        }
                        stream.once('close', () => cleanup());
                        stream.once('end', () => cleanup());
                        resolve(stream);
                    },
                    (error: Error) => {
                        cleanup(error);
                        reject(error);
                    },
                );
        });
    }

    /** No default diagnostic timeout or output cap: existing callers choose their own bounds. */
    public async read(
        command: string,
        timeoutMs?: number,
        signal?: AbortSignal,
        timeoutMessage = 'Phone diagnostic timed out',
    ): Promise<string> {
        const controller = new AbortController();
        const lifetime = this.lifetime.signal;
        const abort = () => controller.abort(signal?.reason ?? lifetime.reason);
        signal?.addEventListener('abort', abort, { once: true });
        lifetime.addEventListener('abort', abort, { once: true });
        if (signal?.aborted || lifetime.aborted) abort();
        const timer = timeoutMs ? setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs) : undefined;
        let socket: Duplex | undefined;
        let cancelRead: (() => void) | undefined;
        try {
            socket = await this.open(command, controller.signal);
            const reading = AdbExtended.util.readAll(socket).then((buffer: Buffer) => buffer.toString().trim());
            const cancelled = new Promise<never>((_resolve, reject) => {
                cancelRead = () => reject(controller.signal.reason);
                controller.signal.addEventListener('abort', cancelRead, { once: true });
                if (controller.signal.aborted) cancelRead();
            });
            // readAll may be waiting for end when a transport is destroyed. Abort settles it too.
            return await Promise.race([reading, cancelled]);
        } catch (error) {
            socket?.destroy();
            throw error;
        } finally {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            lifetime.removeEventListener('abort', abort);
            if (cancelRead) controller.signal.removeEventListener('abort', cancelRead);
        }
    }

    public async exec(command: string, timeoutMs = 15000, signal?: AbortSignal): Promise<ShellResult> {
        if (Buffer.byteLength(command) > MAX_SHELL_COMMAND_BYTES) {
            throw Error('This command is too long to send to the phone.');
        }
        const output = await this.read(
            `${command} 2>&1; echo "__rc=$?"`,
            timeoutMs,
            signal,
            'The phone did not answer in time.',
        );
        const match = output.match(/__rc=(\d+)\s*$/);
        return {
            code: match ? parseInt(match[1], 10) : -1,
            output: (match ? output.slice(0, match.index) : output).trim(),
        };
    }

    public async push(contents: string, path: string, signal?: AbortSignal) {
        const lifetime = this.lifetime.signal;
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason ?? lifetime.reason ?? Error('The phone connection ended.'));
        lifetime.addEventListener('abort', abort, { once: true });
        signal?.addEventListener('abort', abort, { once: true });
        if (this.released || lifetime.aborted || signal?.aborted) abort();
        const operation = AdbExtended.operation(this.client, controller.signal);
        const cleanup = () => {
            lifetime.removeEventListener('abort', abort);
            signal?.removeEventListener('abort', abort);
            operation.close();
        };
        try {
            controller.signal.throwIfAborted();
            const transfer = await operation.client.push(this.serial, contents, path);
            transfer.on('error', () => undefined);
            if (controller.signal.aborted) {
                transfer.cancel();
                controller.signal.throwIfAborted();
            }
            transfer.once('end', cleanup);
            transfer.once('error', cleanup);
            return transfer;
        } catch (error) {
            operation.close(error as Error);
            cleanup();
            throw error;
        }
    }
}
