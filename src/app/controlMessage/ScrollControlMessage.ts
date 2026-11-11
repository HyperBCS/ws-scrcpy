import { ControlMessage, ControlMessageInterface } from './ControlMessage';
import Position, { PositionInterface } from '../Position';

export interface ScrollControlMessageInterface extends ControlMessageInterface {
    position: PositionInterface;
    hScroll: number;
    vScroll: number;
}

/**
 * scrcpy carries a scroll amount as signed 16-bit fixed point for the range [-1, 1] and the
 * server multiplies what it decodes by 16 (app/src/control_msg.c, Controller.injectScroll).
 * So the wire value is notches / 16. Encoding the notch count itself made one wheel step
 * sixteen steps on the device.
 */
function notchesToI16(notches: number): number {
    const normalised = Math.max(-1, Math.min(1, notches / ScrollControlMessage.MAX_NOTCHES));
    // Same rounding as scrcpy's sc_float_to_i16fp: scale by 2^15 and cap the one value over range.
    return Math.min(Math.trunc(normalised * 0x8000), 0x7fff);
}

export class ScrollControlMessage extends ControlMessage {
    public static PAYLOAD_LENGTH = 20;
    /** The largest scroll one message can carry, in wheel notches. */
    public static readonly MAX_NOTCHES = 16;

    /** `hScroll` and `vScroll` are wheel notches: 1 is one step of a mouse wheel. */
    constructor(
        readonly position: Position,
        readonly hScroll: number,
        readonly vScroll: number,
    ) {
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
        offset = buffer.writeInt16BE(notchesToI16(this.hScroll), offset);
        offset = buffer.writeInt16BE(notchesToI16(this.vScroll), offset);
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
