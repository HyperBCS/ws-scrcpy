import { MessageType } from './MessageType';
import Util from '../../app/Util';
import { CloseEventClass } from './CloseEventClass';

export type MessageData = ArrayBuffer | Uint8Array;

/**
 * `Buffer.from()` wraps an `ArrayBuffer` but copies a typed array, so narrow explicitly
 * and wrap in both cases to keep reads free of hidden copies.
 */
function asBuffer(data: MessageData): Buffer {
    if (data instanceof Uint8Array) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    return Buffer.from(data);
}

export class Message<T extends MessageData = MessageData> {
    public static readonly HEADER_LENGTH = 5;

    public static parse(buffer: ArrayBuffer): Message<ArrayBuffer> {
        const view = Buffer.from(buffer);
        if (view.byteLength < Message.HEADER_LENGTH) {
            throw new RangeError(
                `Invalid message: expected at least ${Message.HEADER_LENGTH} bytes, got ${view.byteLength}`,
            );
        }

        const type: MessageType = view.readUInt8(0);
        const channelId = view.readUInt32LE(1);
        const data: ArrayBuffer = buffer.slice(Message.HEADER_LENGTH);

        return new Message(type, channelId, data);
    }

    public static fromCloseEvent(id: number, code: number, reason?: string): Message<Buffer> {
        const reasonBuffer = reason ? Util.stringToUtf8ByteArray(reason) : Buffer.alloc(0);
        const buffer = Buffer.alloc(2 + 4 + reasonBuffer.byteLength);
        buffer.writeUInt16LE(code, 0);
        if (reasonBuffer.byteLength) {
            buffer.writeUInt32LE(reasonBuffer.byteLength, 2);
            buffer.set(reasonBuffer, 6);
        }
        return new Message(MessageType.CloseChannel, id, buffer);
    }

    public static createBuffer(type: MessageType, channelId: number, data?: MessageData): Buffer {
        const result = Buffer.alloc(Message.HEADER_LENGTH + (data ? data.byteLength : 0));
        result.writeUInt8(type, 0);
        result.writeUInt32LE(channelId, 1);
        if (data?.byteLength) {
            result.set(asBuffer(data), Message.HEADER_LENGTH);
        }
        return result;
    }

    public constructor(
        public readonly type: MessageType,
        public readonly channelId: number,
        public readonly data: T,
    ) {}

    public toCloseEvent(): CloseEvent {
        let code: number | undefined;
        let reason: string | undefined;
        // Every read is length-checked: this runs inside a WebSocket message handler, so a
        // truncated CloseChannel payload must not throw RangeError out of the event loop.
        if (this.data && this.data.byteLength >= 2) {
            const buffer = asBuffer(this.data);
            code = buffer.readUInt16LE(0);
            if (buffer.byteLength >= 6) {
                const length = buffer.readUInt32LE(2);
                const end = Math.min(6 + length, buffer.byteLength);
                reason = Util.utf8ByteArrayToString(buffer.subarray(6, end));
            }
        }
        return new CloseEventClass('close', {
            code,
            reason,
            wasClean: code === 1000,
        });
    }

    public toBuffer(): Buffer {
        return Message.createBuffer(this.type, this.channelId, this.data);
    }
}
