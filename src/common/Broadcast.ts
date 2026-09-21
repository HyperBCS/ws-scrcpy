import { Socket } from 'net';
import { DisplayInfo } from '../app/DisplayInfo';
import VideoSettings from '../app/VideoSettings';
import ScreenInfo from '../app/ScreenInfo';
import Size from '../app/Size';
import Rect from '../app/Rect';
import DeviceMessage from '../app/googDevice/DeviceMessage';
import {
    AUDIO_CHANNELS,
    AUDIO_MAGIC,
    AUDIO_PACKET_HEADER_SIZE,
    AUDIO_SAMPLE_RATE,
    AudioCodec,
    AudioMetadata,
    AudioPacketKind,
} from './AudioProtocol';

export type VideoFrameKind = 'config' | 'key' | 'delta';
type DataCallback = (data: Buffer, videoKind?: VideoFrameKind) => void;

interface FrameHeader {
    keyFrame: boolean;
    config: boolean;
    size: number;
}

interface AudioFrameHeader extends FrameHeader {
    timestamp: bigint;
}

export interface BroadcastAudioOptions {
    failure?: AudioMetadata;
    onFailure?: (metadata: AudioMetadata) => void;
}

interface UhidOutputHeader {
    id: number;
    size: number;
}

/**
 * Header sent once at the head of the video stream.
 *
 * scrcpy 4.0 added a 4-byte "session metadata" field (Genymobile/scrcpy#6159) between the codec id
 * and the dimensions, taking this from 12 to 16 bytes:
 *
 *   3.1:  codecId(4) width(4)  height(4)
 *   4.x:  codecId(4) meta(4)   width(4)  height(4)
 *
 * Verified by capture against a real device on both versions: parsing a 4.1 stream with the old
 * 12-byte header desynchronises on the very first frame, while 16 stays in sync.
 */
const CODEC_HEADER_SIZE = 16;
/** Offsets of the dimensions within the codec header (after the codec id and metadata fields). */
const CODEC_HEADER_WIDTH_OFFSET = 8;
const CODEC_HEADER_HEIGHT_OFFSET = 12;
/**
 * codec id only, sent once at the head of the audio stream. Audio has no width/height (no
 * session packets either - scrcpy only re-announces those for video, on rotation), so this is
 * shorter than CODEC_HEADER_SIZE despite otherwise mirroring it.
 */
const AUDIO_CODEC_HEADER_SIZE = 4;
/** pts + flags (8 bytes) followed by the packet size (4 bytes), sent before every frame */
const FRAME_HEADER_SIZE = 12;
/**
 * Upper bound for a single video packet. The stream is 3.5 Mbit/s at max_size=1280,
 * i.e. under 512 KiB for a whole second of video, so a packet past 4 MiB means we lost
 * framing (or read a corrupt length). Without the bound a garbage 32-bit size makes the
 * loop buffer up to 4 GiB while waiting for a frame that never completes.
 */
const MAX_PACKET_SIZE = 4 * 1024 * 1024;
// A joining decoder needs every reference frame since the IDR. Bound that replay cache even
// when a device ignores its configured keyframe interval. On overflow keep a decodable prefix
// for an idle-screen preview, but do not join it to live deltas with missing references.
const MAX_VIDEO_BOOTSTRAP_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BOOTSTRAP_FRAMES = 1024;
/**
 * Upper bound for a device message payload (currently only reachable via the clipboard text
 * length, a u32). This mirrors MESSAGE_MAX_SIZE (1 << 18) in scrcpy's own DeviceMessageWriter,
 * which never emits anything larger, so a bigger length here means the control stream lost
 * framing. Without the bound a garbage length makes the loop buffer forever waiting for bytes
 * that will never come.
 */
const MAX_DEVICE_MESSAGE_SIZE = 1 << 18;
/**
 * Packet flag bits in the 8-byte pts/flags field of a frame header.
 *
 * scrcpy 4.0 shifted these down by one (demuxer.c): 3.1 used CONFIG=63 / KEY_FRAME=62, 4.x uses
 * CONFIG=62 / KEY_FRAME=61. Reading the old positions against a 4.x stream means the config
 * packet (SPS/PPS) is never recognised, so `lastConfigframe` stays null, newly attached clients
 * are never primed with it, and every decoder sits on a black screen -- which is exactly what
 * happened before this was fixed. Verified by capture on a real device.
 */
const PACKET_FLAG_CONFIG = 1n << 62n;
const PACKET_FLAG_KEY_FRAME = 1n << 61n;

const MAGIC_BYTES_MESSAGE = Buffer.from(DeviceMessage.MAGIC_BYTES_MESSAGE);
/**
 * Tags audio frames on the fan-out socket, mirroring MAGIC_BYTES_MESSAGE above. Must stay the
 * same byte length as MAGIC_BYTES_INITIAL/MAGIC_BYTES_MESSAGE (14) - StreamReceiver.onSocketMessage
 * on the client relies on all three magics being equal length to pick one fixed-size slice and
 * compare it against each candidate in turn.
 */
const MAGIC_BYTES_AUDIO = Buffer.from(AUDIO_MAGIC, 'utf-8');
const AUDIO_CODEC_IDS: Record<number, AudioCodec> = {
    0x00726177: 'raw',
    0x6f707573: 'opus',
};
const PACKET_PTS_MASK = PACKET_FLAG_KEY_FRAME - 1n;

const EMPTY = Buffer.alloc(0);

/**
 * Detaches bytes from the head of a chunk queue, or returns null - consuming nothing - when
 * fewer bytes than requested have arrived. Chunks are only copied where a message straddles
 * them, so unlike a concat-per-chunk accumulator this stays linear in the stream length.
 */
class ChunkAccumulator {
    private chunks: Buffer[] = [];
    private buffered = 0;

    push(chunk: Buffer): void {
        this.chunks.push(chunk);
        this.buffered += chunk.length;
    }

    consume(size: number): Buffer | null {
        if (this.buffered < size) {
            return null;
        }
        if (size === 0) {
            return EMPTY;
        }
        let head = this.chunks[0];
        if (head.length < size) {
            let count = 0;
            let total = 0;
            while (total < size) {
                total += this.chunks[count].length;
                count++;
            }
            head = Buffer.concat(this.chunks.splice(0, count), total);
            this.chunks.unshift(head);
        }
        this.buffered -= size;
        if (head.length === size) {
            this.chunks.shift();
            return head;
        }
        this.chunks[0] = head.subarray(size);
        return head.subarray(0, size);
    }

    reset(): void {
        this.chunks = [];
        this.buffered = 0;
    }
}

export class Broadcast {
    private socket: Socket;
    private control: Socket;
    /** Present only if this launch requested audio; capture can subsequently fail independently. */
    private audio?: Socket;
    private onTeardown?: () => void;
    private listeners: Set<DataCallback> = new Set();
    private lastKeyframe: Buffer | null = null;
    private lastConfigframe: Buffer | null = null;
    private videoBootstrapFrames: Buffer[] = [];
    private videoBootstrapBytes = 0;
    private videoBootstrapComplete = false;
    private videoBuffer = new ChunkAccumulator();
    private headerParsed = false;
    private readyResolvers: Array<(ok: boolean) => void> = [];
    private frameHeader: FrameHeader | null = null;
    private stopped = false;

    private codecId = 0;
    private videoWidth = 0;
    private videoHeight = 0;

    private controlBuffer = new ChunkAccumulator();
    private deviceMessageType: number | null = null;
    private clipboardLength: number | null = null;
    private uhidOutputHeader: UhidOutputHeader | null = null;

    // Audio has the same frame header as video, but no session-size packets. Keep its buffer,
    // timestamp, codec metadata, and failure state independent from the picture/control path.
    private audioBuffer = new ChunkAccumulator();
    private audioHeaderParsed = false;
    private audioCodecId = 0;
    private audioFrameHeader: AudioFrameHeader | null = null;
    private audioStopped = false;
    private audioMetadata: AudioMetadata;
    private lastAudioConfigPacket: Buffer | null = null;
    private readonly onAudioFailure?: (metadata: AudioMetadata) => void;

    constructor(
        socket: Socket,
        control: Socket,
        audio: Socket | undefined,
        onTeardown?: () => void,
        audioOptions?: BroadcastAudioOptions,
    ) {
        this.socket = socket;
        this.control = control;
        this.audio = audio;
        this.onTeardown = onTeardown;
        this.onAudioFailure = audioOptions?.onFailure;
        this.audioMetadata = audioOptions?.failure ?? {
            status: audio ? 'pending' : 'disabled',
            sampleRate: AUDIO_SAMPLE_RATE,
            channels: AUDIO_CHANNELS,
            ...(audio ? {} : { message: 'Device audio is off in stream settings.' }),
        };

        this.socket.on('data', (chunk: Buffer) => {
            this.videoBuffer.push(chunk);
            if (!this.parseCodecHeader()) {
                return;
            }
            this.processFrames();
        });

        this.socket.on('end', () => {
            console.log('Broadcast ended');
        });

        this.control.on('data', (chunk: Buffer) => {
            this.controlBuffer.push(chunk);
            this.processDeviceMessages();
        });

        // Every socket needs an 'error' listener: an unhandled 'error' on a net.Socket is
        // re-thrown as an uncaught exception and takes the whole process down. The control
        // socket is written to on every input event, so it sees EPIPE/ECONNRESET first.
        this.watch(this.socket, 'video');
        this.watch(this.control, 'control');

        const audioSocket = this.audio;
        if (audioSocket) {
            audioSocket.on('data', (chunk: Buffer) => {
                if (this.stopped || this.audioStopped) {
                    return;
                }
                this.audioBuffer.push(chunk);
                if (!this.parseAudioCodecHeader()) {
                    return;
                }
                this.processAudioFrames();
            });
            // Audio is optional: a rejected capture source or closed audio channel must not
            // destroy the video/control channels. scrcpy itself also treats codec-id 0 as
            // nonfatal (v4.1 app/src/demuxer.c and device/Streamer.java).
            audioSocket.on('error', (error: Error) => {
                this.stopAudio('error', `Device audio connection failed: ${error.message}`);
            });
            audioSocket.on('end', () => this.stopAudio('error', 'The device audio stream ended.'));
            audioSocket.on('close', () => this.stopAudio('error', 'The device audio connection closed.'));
        }
    }

    private watch(socket: Socket, name: string): void {
        socket.on('error', (err: Error) => {
            console.error(`Broadcast ${name} socket error:`, err);
            this.teardown();
        });
        socket.on('close', () => {
            this.teardown();
        });
    }

    /** Stop on our own initiative (socket died, stream desynchronised) and tell the owner. */
    private teardown(): void {
        if (this.stopped) {
            return;
        }
        this.stop();
        this.onTeardown?.();
    }

    private parseCodecHeader(): boolean {
        if (this.headerParsed) {
            return true;
        }
        const header = this.videoBuffer.consume(CODEC_HEADER_SIZE);
        if (!header) {
            return false;
        }
        this.codecId = header.readUInt32BE(0);
        this.videoWidth = header.readUInt32BE(CODEC_HEADER_WIDTH_OFFSET);
        this.videoHeight = header.readUInt32BE(CODEC_HEADER_HEIGHT_OFFSET);
        this.headerParsed = true;

        console.log(`Codec ID: ${this.codecId}`);
        console.log(`Width: ${this.videoWidth}`);
        console.log(`Height: ${this.videoHeight}`);
        this.settleReady(true);
        return true;
    }

    /**
     * Resolves true once the codec header has been parsed and videoWidth/videoHeight are real,
     * or false if the broadcast is torn down first. Callers must not advertise a screen size
     * to a client before this resolves — a 0x0 ScreenInfo is latched by the player for good.
     */
    whenReady(): Promise<boolean> {
        if (this.stopped) {
            return Promise.resolve(false);
        }
        if (this.headerParsed) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => this.readyResolvers.push(resolve));
    }

    private settleReady(ok: boolean): void {
        const resolvers = this.readyResolvers;
        this.readyResolvers = [];
        for (const resolve of resolvers) {
            resolve(ok);
        }
    }

    private processFrames(): void {
        for (;;) {
            if (!this.frameHeader) {
                const header = this.videoBuffer.consume(FRAME_HEADER_SIZE);
                if (!header) {
                    return;
                }
                const flags = header.readBigUInt64BE(0); // read 8 bytes as BigInt
                const size = header.readUInt32BE(8);
                if (size > MAX_PACKET_SIZE) {
                    console.error(`Broadcast: packet size ${size} exceeds ${MAX_PACKET_SIZE}, stream desynchronised`);
                    this.teardown();
                    return;
                }
                this.frameHeader = {
                    keyFrame: (flags & PACKET_FLAG_KEY_FRAME) > 0n,
                    config: (flags & PACKET_FLAG_CONFIG) > 0n,
                    size,
                };
            }

            const framePayload = this.videoBuffer.consume(this.frameHeader.size);
            if (!framePayload) {
                return;
            }
            const { keyFrame, config } = this.frameHeader;
            this.frameHeader = null;

            if (config) {
                this.lastConfigframe = framePayload;
                // Parameter changes invalidate pictures encoded with the previous config.
                this.clearVideoBootstrap();
            } else if (keyFrame) {
                this.lastKeyframe = framePayload;
                this.videoBootstrapFrames = [framePayload];
                this.videoBootstrapBytes = framePayload.length;
                this.videoBootstrapComplete = true;
            } else if (this.videoBootstrapComplete) {
                if (
                    this.videoBootstrapBytes + framePayload.length > MAX_VIDEO_BOOTSTRAP_BYTES ||
                    this.videoBootstrapFrames.length >= MAX_VIDEO_BOOTSTRAP_FRAMES
                ) {
                    this.videoBootstrapComplete = false;
                } else {
                    this.videoBootstrapFrames.push(framePayload);
                    this.videoBootstrapBytes += framePayload.length;
                }
            }

            this.notifyListeners(framePayload, config ? 'config' : keyFrame ? 'key' : 'delta');
        }
    }

    private clearVideoBootstrap(): void {
        this.lastKeyframe = null;
        this.videoBootstrapFrames = [];
        this.videoBootstrapBytes = 0;
        this.videoBootstrapComplete = false;
    }

    /** A decodable path from codec setup; reaches the latest picture unless the cap was hit. */
    getVideoBootstrapPackets(): Buffer[] {
        if (!this.lastConfigframe) {
            return [];
        }
        return [this.lastConfigframe, ...this.videoBootstrapFrames];
    }

    hasCompleteVideoBootstrap(): boolean {
        return !!this.lastConfigframe && this.videoBootstrapComplete;
    }

    private parseAudioCodecHeader(): boolean {
        if (this.audioHeaderParsed) {
            return true;
        }
        const header = this.audioBuffer.consume(AUDIO_CODEC_HEADER_SIZE);
        if (!header) {
            return false;
        }
        this.audioCodecId = header.readUInt32BE(0);
        this.audioHeaderParsed = true;
        if (this.audioCodecId === 0) {
            this.stopAudio(
                'disabled',
                'The device could not capture this audio source. Android 11 requires an unlocked screen; call capture may be restricted.',
            );
            return false;
        }
        const codec = AUDIO_CODEC_IDS[this.audioCodecId];
        if (!codec) {
            this.stopAudio(
                'error',
                this.audioCodecId === 1
                    ? 'The device rejected the audio source or format. Try Device sound with Compatibility PCM.'
                    : `Unsupported device audio codec: 0x${this.audioCodecId.toString(16)}`,
            );
            return false;
        }
        // scrcpy's capture profile is fixed at 48kHz stereo (AudioConfig.java). Raw payloads
        // are interleaved signed 16-bit little-endian; Opus config is already bare OpusHead.
        this.audioMetadata = { status: 'ready', codec, sampleRate: AUDIO_SAMPLE_RATE, channels: AUDIO_CHANNELS };
        this.notifyListeners(this.createAudioMetadataPacket());
        return true;
    }

    /**
     * Same frame-header/payload loop as processFrames() above, over the audio socket's own
     * ChunkAccumulator. The scrcpy default audio codec is Opus; a config frame (the flag scrcpy
     * also uses for video's SPS/PPS) carries the decoder's `description` bytes rather than
     * audio samples, so it is tagged rather than dropped - see the flag byte written in
     * emitAudioFrame() and consumed by AudioPlayer on the client.
     */
    private processAudioFrames(): void {
        for (;;) {
            if (!this.audioFrameHeader) {
                const header = this.audioBuffer.consume(FRAME_HEADER_SIZE);
                if (!header) {
                    return;
                }
                const flags = header.readBigUInt64BE(0); // read 8 bytes as BigInt
                const size = header.readUInt32BE(8);
                if (!size || size > MAX_PACKET_SIZE || flags >> 63n) {
                    this.stopAudio('error', 'The device sent an invalid audio packet.');
                    return;
                }
                this.audioFrameHeader = {
                    keyFrame: (flags & PACKET_FLAG_KEY_FRAME) > 0n,
                    config: (flags & PACKET_FLAG_CONFIG) > 0n,
                    size,
                    timestamp: flags & PACKET_PTS_MASK,
                };
            }

            const framePayload = this.audioBuffer.consume(this.audioFrameHeader.size);
            if (!framePayload) {
                return;
            }
            const { config, timestamp } = this.audioFrameHeader;
            this.audioFrameHeader = null;
            if (!config && this.audioMetadata.codec === 'raw' && framePayload.length % (AUDIO_CHANNELS * 2)) {
                this.stopAudio('error', 'The device sent incomplete PCM audio samples.');
                return;
            }
            this.emitAudioFrame(config, timestamp, framePayload);
        }
    }

    private createAudioPacket(kind: AudioPacketKind, timestamp: bigint, payload: Buffer): Buffer {
        const header = Buffer.alloc(AUDIO_PACKET_HEADER_SIZE);
        MAGIC_BYTES_AUDIO.copy(header);
        header.writeUInt8(kind, MAGIC_BYTES_AUDIO.length);
        header.writeBigUInt64BE(timestamp, MAGIC_BYTES_AUDIO.length + 1);
        return Buffer.concat([header, payload]);
    }

    private createAudioMetadataPacket(): Buffer {
        return this.createAudioPacket(AudioPacketKind.METADATA, 0n, Buffer.from(JSON.stringify(this.audioMetadata)));
    }

    private emitAudioFrame(config: boolean, timestamp: bigint, payload: Buffer): void {
        const packet = this.createAudioPacket(
            config ? AudioPacketKind.CONFIG : AudioPacketKind.SAMPLE,
            timestamp,
            payload,
        );
        if (config) {
            this.lastAudioConfigPacket = packet;
        }
        this.notifyListeners(packet);
    }

    private stopAudio(status: 'disabled' | 'error', message: string): void {
        if (this.stopped || this.audioStopped) {
            return;
        }
        this.audioStopped = true;
        this.lastAudioConfigPacket = null;
        this.audioBuffer.reset();
        this.audioFrameHeader = null;
        this.audioMetadata = { ...this.audioMetadata, status, message };
        this.notifyListeners(this.createAudioMetadataPacket());
        this.onAudioFailure?.(this.audioMetadata);
        this.audio?.destroy();
    }

    /** Prime every joining viewer; scrcpy sends audio codec/config metadata only once. */
    getAudioBootstrapPackets(): Buffer[] {
        const packets = [this.createAudioMetadataPacket()];
        if (this.lastAudioConfigPacket) {
            packets.push(this.lastAudioConfigPacket);
        }
        return packets;
    }

    /**
     * Parses stock scrcpy 3.1 device messages off the control socket: a 1-byte type, then a
     * type-specific body (clipboard: u32 length + UTF-8 text; ack-clipboard: u64 sequence;
     * uhid-output: u16 id + u16 size + that many bytes). Each complete message is wrapped in
     * DeviceMessage.MAGIC_BYTES_MESSAGE and fanned out to the same listeners as video frames, so
     * WebsocketProxy forwards it with no change to its listener wiring. An unrecognised type
     * means we can no longer know how many bytes it occupies, so parsing stops for good rather
     * than guessing and desynchronising the rest of the stream.
     */
    private processDeviceMessages(): void {
        for (;;) {
            if (this.deviceMessageType === null) {
                const typeByte = this.controlBuffer.consume(1);
                if (!typeByte) {
                    return;
                }
                this.deviceMessageType = typeByte.readUInt8(0);
            }

            switch (this.deviceMessageType) {
                case DeviceMessage.TYPE_CLIPBOARD:
                    if (!this.consumeClipboardMessage()) {
                        return;
                    }
                    break;
                case DeviceMessage.TYPE_ACK_CLIPBOARD: {
                    const sequence = this.controlBuffer.consume(8);
                    if (!sequence) {
                        return;
                    }
                    this.emitDeviceMessage(DeviceMessage.TYPE_ACK_CLIPBOARD, sequence);
                    this.deviceMessageType = null;
                    break;
                }
                case DeviceMessage.TYPE_UHID_OUTPUT:
                    if (!this.consumeUhidOutputMessage()) {
                        return;
                    }
                    break;
                default:
                    console.error(
                        `Broadcast: unknown device message type ${this.deviceMessageType}, ` +
                            'control stream desynchronised',
                    );
                    this.teardown();
                    return;
            }
        }
    }

    private consumeClipboardMessage(): boolean {
        if (this.clipboardLength === null) {
            const lengthBuf = this.controlBuffer.consume(4);
            if (!lengthBuf) {
                return false;
            }
            const length = lengthBuf.readUInt32BE(0);
            if (length > MAX_DEVICE_MESSAGE_SIZE) {
                console.error(
                    `Broadcast: clipboard message length ${length} exceeds ${MAX_DEVICE_MESSAGE_SIZE}, ` +
                        'control stream desynchronised',
                );
                this.teardown();
                return false;
            }
            this.clipboardLength = length;
        }

        const text = this.controlBuffer.consume(this.clipboardLength);
        if (!text) {
            return false;
        }
        const lengthBuf = Buffer.alloc(4);
        lengthBuf.writeUInt32BE(this.clipboardLength, 0);
        this.emitDeviceMessage(DeviceMessage.TYPE_CLIPBOARD, Buffer.concat([lengthBuf, text]));
        this.clipboardLength = null;
        this.deviceMessageType = null;
        return true;
    }

    private consumeUhidOutputMessage(): boolean {
        if (!this.uhidOutputHeader) {
            const header = this.controlBuffer.consume(4);
            if (!header) {
                return false;
            }
            this.uhidOutputHeader = {
                id: header.readUInt16BE(0),
                size: header.readUInt16BE(2),
            };
        }

        const { id, size } = this.uhidOutputHeader;
        const data = this.controlBuffer.consume(size);
        if (!data) {
            return false;
        }
        const header = Buffer.alloc(4);
        header.writeUInt16BE(id, 0);
        header.writeUInt16BE(size, 2);
        this.emitDeviceMessage(DeviceMessage.TYPE_UHID_OUTPUT, Buffer.concat([header, data]));
        this.uhidOutputHeader = null;
        this.deviceMessageType = null;
        return true;
    }

    private emitDeviceMessage(type: number, rest: Buffer): void {
        const typeBuf = Buffer.alloc(1);
        typeBuf.writeUInt8(type, 0);
        this.notifyListeners(Buffer.concat([MAGIC_BYTES_MESSAGE, typeBuf, rest]));
    }

    private notifyListeners(data: Buffer, videoKind?: VideoFrameKind): void {
        for (const cb of this.listeners) {
            try {
                cb(data, videoKind);
            } catch (err) {
                console.error('Broadcast callback error:', err);
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
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.settleReady(false);
        this.socket.destroy();
        this.control.destroy();
        this.audio?.destroy();
        this.listeners.clear();
        this.videoBuffer.reset();
        this.frameHeader = null;
        this.lastConfigframe = null;
        this.clearVideoBootstrap();
        this.controlBuffer.reset();
        this.deviceMessageType = null;
        this.clipboardLength = null;
        this.uhidOutputHeader = null;
        this.audioBuffer.reset();
        this.audioFrameHeader = null;
        this.lastAudioConfigPacket = null;
    }

    getCodecId(): number {
        return this.codecId;
    }

    getAudioCodecId(): number | undefined {
        return this.audio ? this.audioCodecId : undefined;
    }

    hasAudio(): boolean {
        return !!this.audio && !this.audioStopped;
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

    getControlSocket(): Socket {
        return this.control;
    }

    craftInitialInfoPacket(deviceName: string, encoders: string[], clientId: number): Buffer {
        const MAGIC_BYTES_INITIAL = Buffer.from('scrcpy_initial', 'utf-8');
        const DEVICE_NAME_FIELD_LENGTH = 64;

        // === Static parts for single display ===
        const displayId = 0;
        const displayInfo = new DisplayInfo(displayId, new Size(this.videoWidth, this.videoHeight), 0, 0, 0);
        const screenInfo = new ScreenInfo(
            new Rect(0, 0, this.videoWidth, this.videoHeight),
            new Size(this.videoWidth, this.videoHeight),
            0,
        );
        const videoSettings = new VideoSettings({
            lockedVideoOrientation: -1,
            bitrate: 7340032,
            maxFps: 60,
            iFrameInterval: 1,
            bounds: new Size(this.videoWidth, this.videoHeight),
            sendFrameMeta: false,
        });
        // Number of viewers already attached to this broadcast. Callers craft this packet for a
        // joining client *before* adding its listener, so this is exactly the "other clients"
        // count the UI means. It was hardcoded to 1, which made the settings sheet's
        // "N other viewers will reconnect" warning meaningless.
        const connectionCount = this.listeners.size;

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
            clientIdBuf,
        ]);
    }
}
