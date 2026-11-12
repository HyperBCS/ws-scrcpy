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
import PushTransfer from '@dead50f7/adbkit/lib/adb/sync/pushtransfer';
import { AdbShell, ShellResult } from './AdbShell';

export type { ShellResult } from './AdbShell';

import { sendFileDownload } from './filePush/FileDownload';

export interface ForwardLease {
    port: number;
    /** Removes only a forward created by this acquisition. Reused forwards belong to their owner. */
    release(): Promise<void>;
}

// Copying or deleting a large folder takes far longer than a diagnostic shell read.
const FILE_OPERATION_TIMEOUT = 120000;
// One `rm` command stays well under that limit; a larger selection is deleted in batches.
const MAX_REMOVE_COMMAND_BYTES = 32 * 1024;
// How many ports to try when adb reports that one is already forwarded or bound.
const FORWARD_ATTEMPTS = 10;

interface OwnedForward {
    users: number;
    remove(): Promise<void>;
}

export class AdbUtils {
    private static ownedForwards = new Map<string, OwnedForward>();
    private static forwardQueue: Promise<void> = Promise.resolve();

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

    /**
     * The local TCP port that reaches `remote` on this device, forwarding one if needed.
     *
     * Calls run one at a time. Two phones that start together would otherwise both be handed
     * the same free port, and adb would point it at whichever asked last.
     */
    public static forward(serial: string, remote: string): Promise<number> {
        return AdbUtils.acquireForward(serial, remote).then((lease) => lease.port);
    }

    public static acquireForward(serial: string, remote: string, signal?: AbortSignal): Promise<ForwardLease> {
        const pending = AdbUtils.forwardQueue.then(() => AdbUtils.forwardNow(serial, remote, signal));
        AdbUtils.forwardQueue = pending.then(
            () => undefined,
            () => undefined,
        );
        return pending;
    }

    private static async forwardNow(serial: string, remote: string, signal?: AbortSignal): Promise<ForwardLease> {
        signal?.throwIfAborted();
        const client = AdbExtended.createClient();
        const forwards = await client.listForwards(serial);
        signal?.throwIfAborted();
        const forward = forwards.find((item: Forward) => {
            return item.remote === remote && item.local.startsWith('tcp:') && item.serial === serial;
        });
        if (forward) {
            const { local } = forward;
            const port = parseInt(local.split('tcp:')[1], 10);
            const key = JSON.stringify([serial, local, remote]);
            const owned = AdbUtils.ownedForwards.get(key);
            if (owned) {
                owned.users++;
                return AdbUtils.forwardLease(key, owned, port);
            }
            return { port, release: async () => undefined };
        }
        // adb lists the forwards of every device here. A port another phone holds is not free,
        // even where this process cannot see adb's listener (adb on another host).
        const taken = new Set(
            forwards
                .filter((item: Forward) => item.local.startsWith('tcp:'))
                .map((item: Forward) => parseInt(item.local.split('tcp:')[1], 10)),
        );
        let next = portfinder.basePort;
        let failure: Error | undefined;
        for (let attempt = 0; attempt < FORWARD_ATTEMPTS; attempt++) {
            let port = await portfinder.getPortPromise({ port: next });
            while (taken.has(port)) {
                port = await portfinder.getPortPromise({ port: port + 1 });
            }
            next = port + 1;
            try {
                // Another server on the same adb may take the port between the check and here.
                // adb then refuses, where the plain form would move that forward to this device.
                signal?.throwIfAborted();
                await client.forwardNoRebind(serial, `tcp:${port}`, remote);
                if (signal?.aborted) {
                    await client.killForward(serial, `tcp:${port}`);
                    signal.throwIfAborted();
                }
                const key = JSON.stringify([serial, `tcp:${port}`, remote]);
                const owned: OwnedForward = { users: 1, remove: () => client.killForward(serial, `tcp:${port}`) };
                AdbUtils.ownedForwards.set(key, owned);
                return AdbUtils.forwardLease(key, owned, port);
            } catch (error) {
                failure = error as Error;
                if (!/rebind|bind|in use/i.test(failure.message)) {
                    throw failure;
                }
            }
        }
        throw failure ?? Error('No free port for the device connection.');
    }

    private static forwardLease(key: string, owned: OwnedForward, port: number): ForwardLease {
        let released = false;
        return {
            port,
            release: () => {
                if (released) return Promise.resolve();
                released = true;
                // Serialize removal with acquisition, and retain a forward a successor already reused.
                const removal = AdbUtils.forwardQueue.then(async () => {
                    if (AdbUtils.ownedForwards.get(key) !== owned) return;
                    if (--owned.users > 0) return;
                    AdbUtils.ownedForwards.delete(key);
                    await owned.remove();
                });
                AdbUtils.forwardQueue = removal.then(
                    () => undefined,
                    () => undefined,
                );
                return removal;
            },
        };
    }

    /** Remove legacy filesystem forwards left by an earlier server version. */
    public static async removeFileSocketForwards(serial: string): Promise<void> {
        const client = AdbExtended.createClient();
        const forwards = await client.listForwards(serial);

        // Over the adb protocol, not the adb CLI: a spawned client starts an adb server of its own
        // when none answers, and replaces a server of another version.
        const removals = forwards
            .filter((forward) => forward.serial === serial && forward.local.includes('localfilesystem:'))
            .map((forward) => client.killForward(serial, forward.local));

        await Promise.all(removals);
    }
    /**
     * Runs one shell command and returns its combined output plus the shell exit status.
     * Diagnostics use the same reader; file operations also need the exit
     * code, because `mkdir`/`mv`/`rm` report failures on stderr and adb still exits 0.
     */
    public static async shellExec(serial: string, command: string, timeoutMs = 15000): Promise<ShellResult> {
        return new AdbShell(serial).exec(command, timeoutMs);
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
     * The size of one file in bytes, or undefined when the device does not say. adb sync `STAT`
     * carries 32 bits, so it reports a file of 4 GiB or more as its size modulo 4 GiB.
     */
    public static async fileSize(serial: string, pathString: string): Promise<number | undefined> {
        try {
            const { code, output } = await AdbUtils.shellExec(serial, `stat -L -c %s -- ${AdbUtils.quote(pathString)}`);
            return code === 0 && /^\d+$/.test(output) ? Number(output) : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * The files directly inside `folder` that are 4 GiB or larger, with their true sizes. adb
     * sync `LIST` states sizes in 32 bits, so these are the entries it gets wrong. Nothing here
     * is fatal: a folder that cannot be searched simply yields no corrections.
     */
    public static async largeFileSizes(serial: string, folder: string): Promise<Map<string, number>> {
        const sizes = new Map<string, number>();
        // The trailing slash makes find enter a folder that is a symlink, such as /sdcard.
        const root = AdbUtils.quote(folder.replace(/\/+$/, '') + '/');
        const { output } = await AdbUtils.shellExec(
            serial,
            `find ${root} -maxdepth 1 -type f -size +4294967295c -exec stat -c '%s %n' {} +`,
        ).catch(() => ({ output: '' }));
        for (const line of output.split('\n')) {
            const match = /^(\d+) (.*\/)?([^/]+)$/.exec(line);
            if (match && Number(match[1]) > 0xffffffff) {
                sizes.set(match[3], Number(match[1]));
            }
        }
        return sizes;
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
