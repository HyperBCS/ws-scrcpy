import { ControlMessage } from './ControlMessage';
import Util from '../Util';

/**
 * UHID control messages: they make the device register a real virtual HID device, so input
 * arrives as a *physical* keyboard rather than as synthesised key events. That means the host
 * keyboard layout applies, modifiers/auto-repeat behave natively, and the device stops raising
 * its on-screen keyboard.
 *
 * Wire formats verified against the stock scrcpy 3.1 server on a real device (a `UHID_CREATE`
 * with this layout makes `dumpsys input` list a new "scrcpy" device, and `UHID_INPUT` reports
 * then type into a focused field):
 *
 *   UHID_CREATE:  type(1) id(u16) vendorId(u16) productId(u16) nameLen(u8) name descLen(u16) desc
 *   UHID_INPUT:   type(1) id(u16) size(u16) data
 *   UHID_DESTROY: type(1) id(u16)
 *
 * Requires Android 11+ on the device; on older versions the server rejects the create and input
 * silently goes nowhere, which is why the caller keeps a non-UHID fallback.
 */
export class UhidCreateControlMessage extends ControlMessage {
    constructor(
        readonly id: number,
        readonly vendorId: number,
        readonly productId: number,
        readonly name: string,
        readonly reportDescriptor: Uint8Array,
    ) {
        super(ControlMessage.TYPE_UHID_CREATE);
    }

    public toBuffer(): Buffer {
        const nameBytes = Util.stringToUtf8ByteArray(this.name);
        const buffer = Buffer.alloc(1 + 2 + 2 + 2 + 1 + nameBytes.length + 2 + this.reportDescriptor.length);
        let offset = 0;
        offset = buffer.writeUInt8(this.type, offset);
        offset = buffer.writeUInt16BE(this.id, offset);
        offset = buffer.writeUInt16BE(this.vendorId, offset);
        offset = buffer.writeUInt16BE(this.productId, offset);
        offset = buffer.writeUInt8(nameBytes.length, offset);
        buffer.set(nameBytes, offset);
        offset += nameBytes.length;
        offset = buffer.writeUInt16BE(this.reportDescriptor.length, offset);
        buffer.set(this.reportDescriptor, offset);
        return buffer;
    }

    public toString(): string {
        return `UhidCreateControlMessage{id=${this.id}, name=${this.name}}`;
    }
}

export class UhidInputControlMessage extends ControlMessage {
    constructor(
        readonly id: number,
        readonly data: Uint8Array,
    ) {
        super(ControlMessage.TYPE_UHID_INPUT);
    }

    public toBuffer(): Buffer {
        const buffer = Buffer.alloc(1 + 2 + 2 + this.data.length);
        let offset = 0;
        offset = buffer.writeUInt8(this.type, offset);
        offset = buffer.writeUInt16BE(this.id, offset);
        offset = buffer.writeUInt16BE(this.data.length, offset);
        buffer.set(this.data, offset);
        return buffer;
    }

    public toString(): string {
        return `UhidInputControlMessage{id=${this.id}, size=${this.data.length}}`;
    }
}

export class UhidDestroyControlMessage extends ControlMessage {
    constructor(readonly id: number) {
        super(ControlMessage.TYPE_UHID_DESTROY);
    }

    public toBuffer(): Buffer {
        const buffer = Buffer.alloc(3);
        buffer.writeUInt8(this.type, 0);
        buffer.writeUInt16BE(this.id, 1);
        return buffer;
    }

    public toString(): string {
        return `UhidDestroyControlMessage{id=${this.id}}`;
    }
}
