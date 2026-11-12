import { getSettings } from '../../Settings';
import Adb from '@dead50f7/adbkit/lib/adb';
import Connection from '@dead50f7/adbkit/lib/adb/connection';
import type Bluebird from 'bluebird';
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
