import * as portfinder from 'portfinder';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { AdbExtended } from './adb';
import { Forward } from '@dead50f7/adbkit/lib/Forward';
import Entry from '@dead50f7/adbkit/lib/adb/sync/entry';
import Stats from '@dead50f7/adbkit/lib/adb/sync/stats';
import PullTransfer from '@dead50f7/adbkit/lib/adb/sync/pulltransfer';
import { FileStats } from '../../types/FileStats';
import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import { Multiplexer } from '../../packages/multiplexer/Multiplexer';
import { ReadStream } from 'fs';
import { spawn } from 'child_process';
import { Duplex } from 'stream';
import PushTransfer from '@dead50f7/adbkit/lib/adb/sync/pushtransfer';
import { sendFileDownload } from './filePush/FileDownload';

export type ShellResult = {
    code: number;
    output: string;
};

// Copying or deleting a large folder takes far longer than a diagnostic shell read.
const FILE_OPERATION_TIMEOUT = 120000;
// adb frames a request with four hex digits of length, so anything past 65,535 bytes is cut
// short without an error. The limit leaves room for the service prefix and the status marker.
const MAX_SHELL_COMMAND_BYTES = 65000;
// One `rm` command stays well under that limit; a larger selection is deleted in batches.
const MAX_REMOVE_COMMAND_BYTES = 32 * 1024;

export class AdbUtils {
    private static async formatStatsMin(entry: Entry): Promise<FileStats> {
        return {
            name: entry.name,
            isDir: entry.isDirectory() ? 1 : 0,
            size: entry.size,
            dateModified: entry.mtimeMs ? entry.mtimeMs : entry.mtime.getTime(),
        };
    }

    public static async push(serial: string, stream: ReadStream, pathString: string): Promise<PushTransfer> {
        const client = AdbExtended.createClient();
        const transfer = await client.push(serial, stream, pathString);
        client.on('error', (error: Error) => {
            transfer.emit('error', error);
        });
        return transfer;
    }

    public static async stats(serial: string, pathString: string, stats?: Stats, deep = 0): Promise<Stats> {
        if (!stats || (stats.isSymbolicLink() && pathString.endsWith('/'))) {
            const client = AdbExtended.createClient();
            stats = await client.stat(serial, pathString);
        }
        if (stats.isSymbolicLink()) {
            if (deep === 5) {
                throw Error('Too deep');
            }
            if (!pathString.endsWith('/')) {
                pathString += '/';
            }
            try {
                stats = await this.stats(serial, pathString, stats, deep + 1);
            } catch (error: any) {
                if (error.message === 'Too deep') {
                    if (deep === 0) {
                        console.error(`Symlink is too deep: ${pathString}`);
                        return stats;
                    }
                    throw error;
                }
                if (error.code !== 'ENOENT') {
                    console.error(error.message);
                }
            }
            return stats;
        }
        return stats;
    }

    public static async readdir(serial: string, pathString: string): Promise<FileStats[]> {
        const client = AdbExtended.createClient();
        const list = await client.readdir(serial, pathString);
        const all = list.map(async (entry) => {
            if (entry.isSymbolicLink()) {
                const stat = await this.stats(serial, path.join(pathString, entry.name));
                const mtime = stat.mtimeMs ? stat.mtimeMs : stat.mtime.getTime();
                entry = new Entry(entry.name, stat.mode, stat.size, (mtime / 1000) | 0);
            }
            return AdbUtils.formatStatsMin(entry);
        });
        return Promise.all(all);
    }

    public static async pipePullFile(serial: string, pathString: string): Promise<PullTransfer> {
        // Return ownership immediately. A retained `readable` listener prevents pipeline's
        // flowing mode, and waiting for a first chunk also strands empty-file downloads.
        return AdbExtended.createClient().pull(serial, pathString);
    }

    /**
     * `/sdcard`, `/storage/emulated/0` and most other well-known Android locations are symlinks,
     * and stock adb `STAT` describes the link rather than its target. A browser that is told
     * "this is a symlink" cannot decide whether to open a folder or download a file, so resolve
     * the target here -- the same trailing-slash trick `stats()` uses -- before framing the reply.
     */
    public static async pipeStatToStream(serial: string, pathString: string, stream: Multiplexer): Promise<void> {
        const stats = await AdbUtils.stats(serial, pathString);
        const mtime = stats.mtimeMs ? stats.mtimeMs : stats.mtime.getTime();
        const reply = Buffer.alloc(16);
        reply.write(Protocol.STAT, 0, 'ascii');
        reply.writeUInt32LE(stats.mode, 4);
        reply.writeUInt32LE(stats.size, 8);
        reply.writeUInt32LE(Math.floor(mtime / 1000), 12);
        stream.send(reply);
        stream.close(1000);
    }

    public static async pipeReadDirToStream(serial: string, pathString: string, stream: Multiplexer): Promise<void> {
        const client = AdbExtended.createClient();
        return client.pipeReadDir(serial, pathString, stream);
    }

    public static async pipePullFileToStream(serial: string, pathString: string, stream: Multiplexer): Promise<void> {
        const client = AdbExtended.createClient();
        return sendFileDownload(() => client.pull(serial, pathString), stream);
    }

    public static async forward(serial: string, remote: string): Promise<number> {
        const client = AdbExtended.createClient();
        const forwards = await client.listForwards(serial);
        const forward = forwards.find((item: Forward) => {
            return item.remote === remote && item.local.startsWith('tcp:') && item.serial === serial;
        });
        if (forward) {
            const { local } = forward;
            return parseInt(local.split('tcp:')[1], 10);
        }
        const port = await portfinder.getPortPromise();
        const local = `tcp:${port}`;
        await client.forward(serial, local, remote);
        return port;
    }

    /** Remove legacy filesystem forwards left by an earlier server version. */
    public static async removeFileSocketForwards(serial: string): Promise<void> {
        const client = AdbExtended.createClient();
        const forwards = await client.listForwards(serial);

        const removals = forwards
            .filter((forward) => forward.serial === serial && forward.local.includes('localfilesystem:'))
            .map((forward) => {
                return new Promise<void>((resolve, reject) => {
                    const adb = spawn('adb', ['-s', serial, 'forward', '--remove', forward.local]);
                    adb.on('close', (code) => {
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`Failed to remove forward: ${forward.local}`));
                        }
                    });

                    adb.on('error', reject);
                });
            });

        await Promise.all(removals);
    }
    /**
     * Runs one shell command and returns its combined output plus the shell exit status.
     * `Device.runShellCommandAdbKit` exists for diagnostics; file operations need the exit
     * code, because `mkdir`/`mv`/`rm` report failures on stderr and adb still exits 0.
     */
    public static async shellExec(serial: string, command: string, timeoutMs = 15000): Promise<ShellResult> {
        if (Buffer.byteLength(command) > MAX_SHELL_COMMAND_BYTES) {
            throw Error('This command is too long to send to the device.');
        }
        const client = AdbExtended.createClient();
        let stream: Duplex | undefined;
        let expired = false;
        let timer: NodeJS.Timeout | undefined;
        const reading = client
            .shell(serial, `${command} 2>&1; echo "__rc=$?"`)
            .then((socket) => {
                stream = socket;
                if (expired) {
                    socket.destroy();
                    throw Error('The device did not answer in time.');
                }
                return AdbExtended.util.readAll(socket);
            })
            .then((buffer: Buffer) => {
                const output = buffer.toString();
                const match = output.match(/__rc=(\d+)\s*$/);
                // No marker means the shell died before finishing: treat that as a failure
                // rather than reporting success with truncated output.
                const code = match ? parseInt(match[1], 10) : -1;
                return { code, output: (match ? output.slice(0, match.index) : output).trim() };
            });
        if (!timeoutMs) {
            return reading;
        }
        try {
            return await Promise.race([
                reading,
                new Promise<ShellResult>((_resolve, reject) => {
                    timer = setTimeout(() => {
                        expired = true;
                        stream?.destroy();
                        reject(Error('The device did not answer in time.'));
                    }, timeoutMs);
                }),
            ]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    /** Single-quote one shell argument. File names legitimately contain spaces, quotes and `$`. */
    private static quote(value: string): string {
        return `'${value.split("'").join(`'\\''`)}'`;
    }

    private static async runFileOperation(
        serial: string,
        command: string,
        fallback: string,
        timeoutMs?: number,
    ): Promise<void> {
        const { code, output } = await AdbUtils.shellExec(serial, command, timeoutMs);
        if (code !== 0) {
            throw Error(output || fallback);
        }
    }

    public static async makeDirectory(serial: string, pathString: string): Promise<void> {
        return AdbUtils.runFileOperation(
            serial,
            `mkdir -- ${AdbUtils.quote(pathString)}`,
            'The device refused to create this folder.',
        );
    }

    /**
     * A plain absolute device path with no control characters, normalised. Anything that reaches
     * `adb shell` goes through here first: a newline would also break the exit-status marker
     * `shellExec` appends, and a rejected command is far better than a misread one.
     */
    public static checkDevicePath(pathString: string): string {
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

    /** What an upload or a replacing paste would land on. */
    public static async targetKind(serial: string, target: string): Promise<'missing' | 'item' | 'folder'> {
        const item = AdbUtils.quote(target);
        const { code, output } = await AdbUtils.shellExec(
            serial,
            `if [ -d ${item} ] && [ ! -L ${item} ]; then echo folder; ` +
                `elif [ -e ${item} ] || [ -L ${item} ]; then echo item; else echo missing; fi`,
        );
        if (code !== 0 || (output !== 'missing' && output !== 'item' && output !== 'folder')) {
            throw Error(output || 'The device did not say whether this name is in use.');
        }
        return output;
    }

    /**
     * The guards every replacing operation shares: only a file may be replaced, and only by a
     * file. `mv -f` and `cp` would otherwise merge into, or move inside, an existing folder.
     */
    private static replaceGuards(source: string, destination: string): string {
        return (
            `if [ -d ${destination} ] && [ ! -L ${destination} ]; then ` +
            `printf '%s\\n' 'A folder with this name already exists. Folders are not replaced.'; false; ` +
            `elif [ -d ${source} ] && [ ! -L ${source} ]; then ` +
            `printf '%s\\n' 'A folder cannot replace a file.'; false; `
        );
    }

    /** `replace` swaps an existing file for the source in one rename; the default never does. */
    public static async move(serial: string, from: string, to: string, replace = false): Promise<void> {
        const source = AdbUtils.quote(from);
        const destination = AdbUtils.quote(to);
        if (replace) {
            return AdbUtils.runFileOperation(
                serial,
                `${AdbUtils.replaceGuards(source, destination)}else mv -fT -- ${source} ${destination}; fi`,
                'The device refused to replace this item.',
                FILE_OPERATION_TIMEOUT,
            );
        }
        const conflict = "printf '%s\\n' 'An item with this name already exists.'; false";
        return AdbUtils.runFileOperation(
            serial,
            `if [ -e ${destination} ] || [ -L ${destination} ]; then ${conflict}; ` +
                `else mv -nT -- ${source} ${destination} && { ` +
                `if [ -e ${source} ] || [ -L ${source} ]; then ${conflict}; else true; fi; }; fi`,
            'The device refused to move this item.',
            FILE_OPERATION_TIMEOUT,
        );
    }

    public static async copy(serial: string, from: string, to: string, replace = false): Promise<void> {
        const source = AdbUtils.quote(from);
        const destination = AdbUtils.quote(to);
        if (replace) {
            // Copy beside the target first, so the old file stays until the new one is complete.
            const partial = AdbUtils.quote(AdbUtils.partialPath(to));
            return AdbUtils.runFileOperation(
                serial,
                `${AdbUtils.replaceGuards(source, destination)}` +
                    `elif cp -T -- ${source} ${partial} && mv -fT -- ${partial} ${destination}; then true; ` +
                    `else rm -f -- ${partial}; false; fi`,
                'The device refused to replace this item.',
                FILE_OPERATION_TIMEOUT,
            );
        }
        const conflict = "printf '%s\\n' 'An item with this name already exists.'; false";
        return AdbUtils.runFileOperation(
            serial,
            // -n protects destinations created after the check; -T prevents nesting into an
            // existing folder. Verbose output distinguishes a silent skip from a successful copy.
            `if [ -e ${destination} ] || [ -L ${destination} ]; then ${conflict}; ` +
                `else report=$(cp -rnTv -- ${source} ${destination} 2>&1); result=$?; ` +
                `if [ "$result" -ne 0 ]; then printf '%s\\n' "$report"; (exit "$result"); ` +
                `elif [ -z "$report" ]; then ${conflict}; else true; fi; fi`,
            'The device refused to copy this item.',
            FILE_OPERATION_TIMEOUT,
        );
    }

    /**
     * A hidden name in the target's own folder, so finishing is a rename on one filesystem. The
     * name is not derived from the target, which may already be as long as a name can be.
     */
    public static partialPath(target: string): string {
        return path.posix.join(path.posix.dirname(target), `.partial-${randomBytes(6).toString('hex')}`);
    }

    /** Deletes in batches, in order, and stops at the first batch the device refuses. */
    public static async remove(serial: string, paths: string[]): Promise<void> {
        const prefix = 'rm -rf --';
        let batch: string[] = [];
        let size = prefix.length;
        const run = async (): Promise<void> => {
            if (!batch.length) {
                return;
            }
            const command = `${prefix} ${batch.join(' ')}`;
            batch = [];
            size = prefix.length;
            await AdbUtils.runFileOperation(
                serial,
                command,
                'The device refused to delete this item.',
                FILE_OPERATION_TIMEOUT,
            );
        };
        for (const item of paths) {
            const target = AdbUtils.quote(item);
            const length = Buffer.byteLength(target) + 1;
            if (batch.length && size + length > MAX_REMOVE_COMMAND_BYTES) {
                await run();
            }
            batch.push(target);
            size += length;
        }
        await run();
    }
}
