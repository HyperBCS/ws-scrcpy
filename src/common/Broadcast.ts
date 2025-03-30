import { Socket } from 'net';
import { DisplayInfo } from '../app/DisplayInfo';
import VideoSettings from '../app/VideoSettings';
import ScreenInfo from '../app/ScreenInfo';
import Size from '../app/Size';
import Rect from '../app/Rect';



type DataCallback = (data: Buffer) => void;

export class Broadcast {
    private socket: Socket;
    private listeners: Set<DataCallback> = new Set();
    private lastKeyframe: Buffer | null = null;
    private lastConfigframe: Buffer | null = null;
    private buffer: Buffer = Buffer.alloc(0);

    private codecId: number = 0;
    private videoWidth: number = 0;
    private videoHeight: number = 0;

    constructor(socket: Socket) {
        this.socket = socket;
    
        this.socket.once('data', (chunk: Buffer) => {
            if (chunk.length < 12) {
                console.error('Insufficient data for header');
                return;
            }
    
            this.codecId = chunk.readUInt32BE(0);
            this.videoWidth = chunk.readUInt32BE(4);
            this.videoHeight = chunk.readUInt32BE(8);
    
            console.log(`Codec ID: ${this.codecId}`);
            console.log(`Width: ${this.videoWidth}`);
            console.log(`Height: ${this.videoHeight}`);
    
            this.buffer = chunk.subarray(12); // Remaining bytes after header
    
            this.socket.on('data', (chunk: Buffer) => {
                this.buffer = Buffer.concat([this.buffer, chunk]);
                this.processFrames();
            });
        });
    
        this.socket.on('error', (err) => {
            console.error('Broadcast socket error:', err);
        });
    
        this.socket.on('end', () => {
            console.log("Broadcast ended");
            this.listeners.clear();
        });
    }

    private processFrames(): void {
        while (this.buffer.length >= 12) {
            const flags = this.buffer.readBigUInt64BE(0); // read 8 bytes as BigInt
            const keyFrameFlag = (flags & (1n << 62n)) > 0n;
            const configFlag = (flags & (1n << 63n)) > 0n;
            const pts = this.buffer.readBigUInt64BE(2) & ((1n << 62n) - 1n);
            const packetSize = this.buffer.readUInt32BE(8);

            if (this.buffer.length < 12 + packetSize) break;

            const framePayload = this.buffer.subarray(12, 12 + packetSize);
            this.buffer = this.buffer.subarray(12 + packetSize);

            if (keyFrameFlag) {
                this.lastKeyframe = framePayload;
            }

            if (configFlag) {
                this.lastConfigframe = framePayload;
            }

            for (const cb of this.listeners) {
                try {
                    cb(framePayload);
                } catch (err) {
                    console.error('Broadcast callback error:', err);
                }
            }
        }
    }

    addListener(fn: DataCallback): void {
        this.listeners.add(fn);
    }

    removeListener(fn: DataCallback): void {
        this.listeners.delete(fn);
    }

    stop(): void {
        this.socket.destroy();
        this.listeners.clear();
    }

    getCodecId(): number {
        return this.codecId;
    }
    
    getVideoWidth(): number {
        return this.videoWidth;
    }
    
    getVideoHeight(): number {
        return this.videoHeight;
    }

    getLastKeyframe(): Buffer | null {
        return this.lastKeyframe;
    }

    getLastConfigFrame(): Buffer | null {
        return this.lastConfigframe;
    }

    craftInitialInfoPacket(
        deviceName: string,
        encoders: string[],
        clientId: number
    ): Buffer {
        const MAGIC_BYTES_INITIAL = Buffer.from('scrcpy_initial', 'utf-8');
        const DEVICE_NAME_FIELD_LENGTH = 64;
    
        // === Static parts for single display ===
        const displayId = 0;
        const displayInfo = new DisplayInfo(displayId, new Size(this.videoWidth, this.videoHeight), 0, 0, 0);
        const screenInfo = new ScreenInfo(
            new Rect(0, 0, this.videoWidth, this.videoHeight),
            new Size(this.videoWidth, this.videoHeight),
            0
        );
        const videoSettings = new VideoSettings({
            lockedVideoOrientation: -1,
            bitrate: 7340032,
            maxFps: 60,
            iFrameInterval: 1,
            bounds: new Size(this.videoWidth, this.videoHeight),
            sendFrameMeta: false,
        });
        const connectionCount = 1;
    
        // === Device Name ===
        const nameBytes = Buffer.alloc(DEVICE_NAME_FIELD_LENGTH);
        const encodedName = Buffer.from(deviceName, 'utf-8');
        encodedName.copy(nameBytes);
    
        // === Display Count ===
        const displayCountBuf = Buffer.alloc(4);
        displayCountBuf.writeInt32BE(1, 0);
    
        // === Display Section ===
        const displayInfoBuf = displayInfo.toBuffer();
        const connectionCountBuf = Buffer.alloc(4);
        connectionCountBuf.writeInt32BE(connectionCount, 0);
    
        const screenInfoBuf = screenInfo.toBuffer();
        const screenInfoLengthBuf = Buffer.alloc(4);
        screenInfoLengthBuf.writeInt32BE(screenInfoBuf.length, 0);
    
        const videoSettingsBuf = videoSettings.toBuffer();
        const videoSettingsLengthBuf = Buffer.alloc(4);
        videoSettingsLengthBuf.writeInt32BE(videoSettingsBuf.length, 0);
    
        // === Encoders ===
        const encoderCountBuf = Buffer.alloc(4);
        encoderCountBuf.writeInt32BE(encoders.length, 0);
    
        const encoderSections: Buffer[] = [];
        for (const name of encoders) {
            const nameBuf = Buffer.from(name, 'utf-8');
            const nameLenBuf = Buffer.alloc(4);
            nameLenBuf.writeInt32BE(nameBuf.length, 0);
            encoderSections.push(nameLenBuf, nameBuf);
        }
    
        const clientIdBuf = Buffer.alloc(4);
        clientIdBuf.writeInt32BE(clientId, 0);
    
        // === Final packet ===
        return Buffer.concat([
            MAGIC_BYTES_INITIAL,
            nameBytes,
            displayCountBuf,
            displayInfoBuf,
            connectionCountBuf,
            screenInfoLengthBuf,
            screenInfoBuf,
            videoSettingsLengthBuf,
            videoSettingsBuf,
            encoderCountBuf,
            ...encoderSections,
            clientIdBuf
        ]);
    }
    
}
