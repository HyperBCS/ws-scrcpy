import { ControlMessage, ControlMessageInterface } from './ControlMessage';
import Position, { PositionInterface } from '../Position';

export interface ScrollControlMessageInterface extends ControlMessageInterface {
    position: PositionInterface;
    hScroll: number;
    vScroll: number;
}

function floatToI16(value : number) {
    return Math.max(-1, Math.min(1, value)) * 0x7FFF | 0;
  }

export class ScrollControlMessage extends ControlMessage {
    public static PAYLOAD_LENGTH = 20;

    constructor(readonly position: Position, readonly hScroll: number, readonly vScroll: number) {
        super(ControlMessage.TYPE_SCROLL);
    }

    /**
     * @override
     */
    public toBuffer(): Buffer {
        const buffer = Buffer.alloc(ScrollControlMessage.PAYLOAD_LENGTH + 1);
        let offset = 0;
        offset = buffer.writeUInt8(this.type, offset);
        offset = buffer.writeUInt32BE(this.position.point.x, offset);
        offset = buffer.writeUInt32BE(this.position.point.y, offset);
        offset = buffer.writeUInt16BE(this.position.screenSize.width, offset);
        offset = buffer.writeUInt16BE(this.position.screenSize.height, offset);
        offset = buffer.writeInt16BE(floatToI16(this.hScroll), offset);
        offset = buffer.writeInt16BE(floatToI16(this.vScroll), offset);
        buffer.writeInt32BE(0, offset);
        return buffer;
    }

    public toString(): string {
        return `ScrollControlMessage{hScroll=${this.hScroll}, vScroll=${this.vScroll}, position=${this.position}}`;
    }

    public toJSON(): ScrollControlMessageInterface {
        return {
            type: this.type,
            position: this.position.toJSON(),
            hScroll: this.hScroll,
            vScroll: this.vScroll,
        };
    }
}
