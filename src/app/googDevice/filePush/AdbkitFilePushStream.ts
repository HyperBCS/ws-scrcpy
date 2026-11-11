import { FilePushStream } from './FilePushStream';
import { CommandControlMessage, FilePushState } from '../../controlMessage/CommandControlMessage';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { FilePushResponseStatus } from './FilePushResponseStatus';
import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import { FileListingClient } from '../client/FileListingClient';
import * as path from 'path';
import FilePushHandler from './FilePushHandler';

export class AdbkitFilePushStream extends FilePushStream {
    private channels: Map<number, Multiplexer> = new Map();
    private pendingChannels = new Set<Multiplexer>();
    private released = false;
    private finishing = new Set<number>();
    private completed = new Set<number>();
    constructor(
        private readonly socket: Multiplexer,
        private readonly fileListingClient: FileListingClient,
    ) {
        super();
    }
    public hasConnection(): boolean {
        return !this.released && this.socket.readyState == this.socket.OPEN;
    }

    public isAllowedFile(): boolean {
        return true;
    }

    public getChannel(id: number): Multiplexer | undefined {
        const channel = this.channels.get(id);
        let code: FilePushResponseStatus = FilePushResponseStatus.NO_ERROR;
        if (!channel) {
            code = FilePushResponseStatus.ERROR_UNKNOWN_ID;
        }
        if (code) {
            this.emit('response', { id, code });
            return;
        }
        return channel;
    }

    public sendEventAppend({ id, chunk }: { id: number; chunk: Uint8Array }): void {
        const appendParams = { id, chunk, state: FilePushState.APPEND };
        const channel = this.getChannel(id);
        if (!channel) {
            return;
        }
        channel.send(CommandControlMessage.createPushFileCommand(appendParams).toBuffer());
    }

    public sendEventFinish({ id }: { id: number }): void {
        const finishParams = { id, state: FilePushState.FINISH };
        const channel = this.getChannel(id);
        if (!channel) {
            return;
        }
        this.finishing.add(id);
        channel.send(CommandControlMessage.createPushFileCommand(finishParams).toBuffer());
    }

    /**
     * Sends CANCEL and closes the upload's channel. The server cancels the adb transfer and
     * removes the partial file on either, so the order they arrive in does not matter.
     */
    public sendEventCancel({ id }: { id: number }): void {
        const channel = this.channels.get(id);
        if (!channel) {
            return;
        }
        // The close that follows is the expected end of this upload, not an error to report.
        this.completed.add(id);
        channel.send(CommandControlMessage.createPushFileCommand({ id, state: FilePushState.CANCEL }).toBuffer());
        channel.close();
    }

    public sendEventNew({ id }: { id: number }): void {
        if (!this.hasConnection()) return;
        let pushId = id;
        const newParams = { id, state: FilePushState.NEW };
        const channel = this.socket.createChannel(Buffer.from(Protocol.SEND));
        this.pendingChannels.add(channel);
        const onMessage = (event: MessageEvent): void => {
            let offset = 0;
            const buffer = Buffer.from(event.data);
            const id = buffer.readInt16BE(offset);
            offset += 2;
            const code = buffer.readInt8(offset);
            if (code === FilePushResponseStatus.NEW_PUSH_ID) {
                this.channels.set(id, channel);
                pushId = id;
            }
            if (code === FilePushResponseStatus.NO_ERROR && this.finishing.has(id)) this.completed.add(id);
            this.emit('response', { id, code });
        };
        const onClose = (event: CloseEvent): void => {
            this.pendingChannels.delete(channel);
            this.channels.delete(pushId);
            if (!this.released && !this.completed.has(pushId)) {
                const code = 4000 - event.code;
                // this.emit('response', { id: pushId, code });
                this.emit('error', {
                    id: pushId,
                    error: new Error(
                        FilePushHandler.getErrorMessage(
                            code,
                            event.reason || 'Upload connection closed before completion.',
                        ),
                    ),
                });
            }
            this.finishing.delete(pushId);
            this.completed.delete(pushId);
            channel.removeEventListener('message', onMessage);
            channel.removeEventListener('close', onClose);
        };
        channel.addEventListener('message', onMessage);
        channel.addEventListener('close', onClose);
        channel.send(CommandControlMessage.createPushFileCommand(newParams).toBuffer());
    }

    public sendEventStart({
        id,
        fileName,
        fileSize,
        overwrite = false,
        folder,
    }: {
        id: number;
        fileName: string;
        fileSize: number;
        overwrite?: boolean;
        folder?: string;
    }): void {
        // The owner's answer about this name was given for `folder`. The explorer may have moved
        // to another folder while the push id was allocated.
        const filePath = path.join(folder ?? this.fileListingClient.getPath(), fileName);
        // Always state the choice: without the flag the server refuses a name that is taken.
        const startParams = { id, fileName: filePath, fileSize, overwrite, state: FilePushState.START };
        const channel = this.getChannel(id);
        if (!channel) {
            return;
        }
        channel.send(CommandControlMessage.createPushFileCommand(startParams).toBuffer());
    }

    public release(): void {
        if (this.released) return;
        this.released = true;
        this.pendingChannels.forEach((channel) => {
            channel.close();
        });
        this.pendingChannels.clear();
        this.channels.clear();
        this.finishing.clear();
        this.completed.clear();
    }
}
