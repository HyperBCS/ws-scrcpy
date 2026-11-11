import Client from '@dead50f7/adbkit/lib/adb/client';
import { ExtendedSync } from './ExtendedSync';
import { SyncCommand } from './command/host-transport/sync';
import { ForwardNoRebindCommand } from './command/host-serial/forwardNoRebind';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';

export class ExtendedClient extends Client {
    public async pipeSyncService(serial: string): Promise<ExtendedSync> {
        const transport = await this.transport(serial);
        return new SyncCommand(transport).execute();
    }

    /** Like `forward()`, but adb refuses a local port that is already forwarded. */
    public async forwardNoRebind(serial: string, local: string, remote: string): Promise<void> {
        const connection = await this.connection();
        await new ForwardNoRebindCommand(connection).execute(serial, local, remote);
    }

    public async pipeReadDir(serial: string, pathString: string, stream: Multiplexer): Promise<void> {
        const sync = await this.pipeSyncService(serial);
        // Also on a closed channel or a protocol error, or the adb connection stays open.
        return sync.pipeReadDir(pathString, stream).finally(() => {
            sync.end();
        });
    }
}
