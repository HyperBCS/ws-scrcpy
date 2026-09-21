import * as portfinder from 'portfinder';
import * as path from 'path';
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

export type ShellResult = {
    code: number;
    output: string;
};

// Copying or deleting a large folder takes far longer than a diagnostic shell read.
const FILE_OPERATION_TIMEOUT = 120000;

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
        const client = AdbExtended.createClient();
        const transfer = await client.pull(serial, pathString);

        transfer.on('progress', function (stats) {
            console.log('[%s] [%s] Pulled %d bytes so far', serial, pathString, stats.bytesTransferred);
        });
        transfer.on('end', function () {
            console.log('[%s] [%s] Pull complete', serial, pathString);
        });
        return new Promise((resolve, reject) => {
            transfer.on('readable', () => {
                resolve(transfer);
            });
            transfer.on('error', (e) => {
                reject(e);
            });
        });
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
        const transfer = await client.pull(serial, pathString);
        transfer.on('data', (data) => {
            stream.send(Buffer.concat([Buffer.from(Protocol.DATA, 'ascii'), data]));
        });
        return new Promise((resolve, reject) => {
            transfer.on('end', function () {
                stream.send(Buffer.from(Protocol.DONE, 'ascii'));
                stream.close();
                resolve();
            });
            transfer.on('error', (e) => {
                reject(e);
            });
        });
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

    public static async forwardFileSocket(serial: string, remote: string, pid: number): Promise<string> {
        const client = AdbExtended.createClient();
        const socketPath = `/tmp/scrcpy-${pid}`;
        await client.forward(serial, `localfilesystem:${socketPath}`, remote);
        return socketPath;
    }

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

    public static async move(serial: string, from: string, to: string): Promise<void> {
        // No `-f`: silently replacing a different file is not what a rename or a paste means.
        return AdbUtils.runFileOperation(
            serial,
            `mv -- ${AdbUtils.quote(from)} ${AdbUtils.quote(to)}`,
            'The device refused to move this item.',
            FILE_OPERATION_TIMEOUT,
        );
    }

    public static async copy(serial: string, from: string, to: string): Promise<void> {
        return AdbUtils.runFileOperation(
            serial,
            `cp -r -- ${AdbUtils.quote(from)} ${AdbUtils.quote(to)}`,
            'The device refused to copy this item.',
            FILE_OPERATION_TIMEOUT,
        );
    }

    public static async remove(serial: string, paths: string[]): Promise<void> {
        const targets = paths.map((item) => AdbUtils.quote(item)).join(' ');
        return AdbUtils.runFileOperation(
            serial,
            `rm -rf -- ${targets}`,
            'The device refused to delete this item.',
            FILE_OPERATION_TIMEOUT,
        );
    }
}
