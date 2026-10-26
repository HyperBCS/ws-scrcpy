import PullTransfer from '@dead50f7/adbkit/lib/adb/sync/pulltransfer';
import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';

const HIGH_WATER_BYTES = 1024 * 1024;
const DRAIN_TIMEOUT_MS = 15000;

/** The browser channel owns the pull, including while ADB is still opening it. */
export async function sendFileDownload(open: () => Promise<PullTransfer>, channel: Multiplexer): Promise<void> {
    let transfer: PullTransfer | undefined;
    let closed = channel.readyState !== channel.OPEN;
    let complete = false;
    let cancelled = false;
    const cancel = () => {
        closed = true;
        if (!complete && !cancelled && transfer) {
            cancelled = true;
            transfer.cancel();
            transfer.destroy();
        }
    };
    channel.addEventListener('close', cancel);
    try {
        transfer = await open();
        // ADB can report an error after cancellation. The iterator handles active errors.
        transfer.on('error', () => undefined);
        if (closed) return;
        for await (const chunk of transfer) {
            if (closed || channel.readyState !== channel.OPEN) return;
            channel.send(Buffer.concat([Buffer.from(Protocol.DATA, 'ascii'), Buffer.from(chunk)]));
            const deadline = Date.now() + DRAIN_TIMEOUT_MS;
            while (!closed && channel.bufferedAmount > HIGH_WATER_BYTES) {
                if (Date.now() >= deadline) throw new Error('Download paused too long. Try again.');
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        }
        if (!closed && channel.readyState === channel.OPEN) {
            channel.send(Buffer.from(Protocol.DONE, 'ascii'));
            complete = true;
            channel.close();
        }
    } catch (error) {
        if (!closed) throw error;
    } finally {
        channel.removeEventListener('close', cancel);
        if (!complete) cancel();
    }
}
