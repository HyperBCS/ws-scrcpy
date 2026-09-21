import { ChildProcess, spawn } from 'child_process';
import * as http from 'http';
import {
    AUDIO_CHANNELS,
    AUDIO_MAGIC,
    AUDIO_PACKET_HEADER_SIZE,
    AUDIO_SAMPLE_RATE,
    AudioMetadata,
    AudioPacketKind,
} from '../../../common/AudioProtocol';
import { splitStreamFrames } from '../../../common/CoreDeviceProtocol';

const TAG = '[CoreDeviceAudio]';
const MAGIC = Buffer.from(AUDIO_MAGIC, 'utf-8');
// 20 ms of interleaved s16le stereo per browser packet, like stock scrcpy's raw audio.
const PACKET_SAMPLES = 960;
const PACKET_BYTES = PACKET_SAMPLES * AUDIO_CHANNELS * 2;
// AudioSpecificConfig of the device's stream: AAC-ELD (AOT 39), 48 kHz, stereo, epConfig 0.
// Apple's own magic cookie is f8e64000, whose frameLengthFlag says 512-sample frames, yet the
// phone sends 100 frames a second, i.e. 480 samples each (pymobiledevice3 pins AudioToolbox to
// 480 for the same reason). ffmpeg trusts the flag, so bit 19 is set here: with the cookie as-is
// it reports "invalid band type" on most frames; with 480 it decodes every frame, silence
// included (verified against a 12 s capture from an iPhone 13 Pro Max on iOS 27).
const ELD_ASC_48K_STEREO_480 = Buffer.from([0xf8, 0xe6, 0x50, 0x00]);
const TRACK_ID = 1;
const TIMESCALE = AUDIO_SAMPLE_RATE;
const FRAME_SAMPLES = 480;

export type AudioPacketListener = (packet: Buffer) => void;

function box(type: string, ...payload: Buffer[]): Buffer {
    const body = Buffer.concat(payload);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + body.length, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, body]);
}

function fullBox(type: string, version: number, flags: number, ...payload: Buffer[]): Buffer {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
    return box(type, head, ...payload);
}

function u32(...values: number[]): Buffer {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeUInt32BE(value >>> 0, index * 4));
    return out;
}

function esds(): Buffer {
    const decoderSpecific = Buffer.concat([Buffer.from([0x05, ELD_ASC_48K_STEREO_480.length]), ELD_ASC_48K_STEREO_480]);
    const decoderConfig = Buffer.concat([
        Buffer.from([0x04, 13 + decoderSpecific.length, 0x40, 0x15, 0, 0, 0]),
        u32(400000, 320000), // max / average bitrate, informational
        decoderSpecific,
    ]);
    const esDescriptor = Buffer.concat([
        Buffer.from([0x03, 3 + decoderConfig.length + 3, 0, 1, 0]),
        decoderConfig,
        Buffer.from([0x06, 0x01, 0x02]),
    ]);
    return fullBox('esds', 0, 0, esDescriptor);
}

const UNITY_MATRIX = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

/**
 * The fragmented-MP4 initialisation segment for the phone's audio: an empty `mp4a` track whose
 * `esds` carries the ELD configuration above. ffmpeg's ELD decoder only behaves when it gets
 * that configuration as codec extradata -- fed the same frames through LOAS/LATM it mis-parsed
 * them -- so the raw access units are remuxed into fMP4 on the way to its stdin.
 */
export function audioInitSegment(): Buffer {
    const ftyp = box('ftyp', Buffer.from('iso5', 'latin1'), u32(1), Buffer.from('iso5iso6mp41', 'latin1'));
    const mp4a = box(
        'mp4a',
        Buffer.concat([Buffer.alloc(6), Buffer.from([0, 1])]), // reserved, data reference index
        Buffer.alloc(8),
        Buffer.from([0, AUDIO_CHANNELS, 0, 16]), // channel count, sample size
        Buffer.alloc(4),
        u32(TIMESCALE << 16),
        esds(),
    );
    const stbl = box(
        'stbl',
        fullBox('stsd', 0, 0, u32(1), mp4a),
        fullBox('stts', 0, 0, u32(0)),
        fullBox('stsc', 0, 0, u32(0)),
        fullBox('stsz', 0, 0, u32(0, 0)),
        fullBox('stco', 0, 0, u32(0)),
    );
    const minf = box(
        'minf',
        fullBox('smhd', 0, 0, u32(0)),
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        stbl,
    );
    const mdia = box(
        'mdia',
        fullBox('mdhd', 0, 0, u32(0, 0, TIMESCALE, 0), Buffer.from([0x55, 0xc4, 0, 0])),
        fullBox(
            'hdlr',
            0,
            0,
            u32(0),
            Buffer.from('soun', 'latin1'),
            Buffer.alloc(12),
            Buffer.from('SoundHandler\0', 'latin1'),
        ),
        minf,
    );
    const tkhd = fullBox(
        'tkhd',
        0,
        7,
        u32(0, 0, TRACK_ID, 0, 0),
        Buffer.alloc(8),
        Buffer.from([0, 0, 0, 0, 1, 0, 0, 0]), // layer, alternate group, volume 1.0, reserved
        UNITY_MATRIX,
        u32(0, 0),
    );
    const mvhd = fullBox(
        'mvhd',
        0,
        0,
        u32(0, 0, 1000, 0),
        u32(0x10000),
        Buffer.from([1, 0]),
        Buffer.alloc(10),
        UNITY_MATRIX,
        Buffer.alloc(24),
        u32(2),
    );
    const mvex = box('mvex', fullBox('trex', 0, 0, u32(TRACK_ID, 1, FRAME_SAMPLES, 0, 0)));
    return Buffer.concat([ftyp, box('moov', mvhd, box('trak', tkhd, mdia), mvex)]);
}

/** One access unit as its own `moof` + `mdat` fragment; `decodeTime` is in samples. */
export function audioSegment(au: Uint8Array, sequence: number, decodeTime: number): Buffer {
    const decode = Buffer.alloc(8);
    decode.writeBigUInt64BE(BigInt(decodeTime), 0);
    const trafHead = Buffer.concat([
        fullBox('tfhd', 0, 0x020000, u32(TRACK_ID)), // default-base-is-moof
        fullBox('tfdt', 1, 0, decode),
    ]);
    const trun = (dataOffset: number) => {
        const offset = Buffer.alloc(4);
        offset.writeInt32BE(dataOffset, 0);
        // data-offset-present | sample-duration-present | sample-size-present
        return fullBox('trun', 0, 0x301, u32(1), offset, u32(FRAME_SAMPLES, au.length));
    };
    const mfhd = fullBox('mfhd', 0, 0, u32(sequence));
    const provisional = box('moof', mfhd, box('traf', trafHead, trun(0)));
    const moof = box('moof', mfhd, box('traf', trafHead, trun(provisional.length + 8)));
    return Buffer.concat([moof, box('mdat', Buffer.from(au))]);
}

/**
 * One device's audio, decoded once and fanned out to every viewer in the browser envelope.
 *
 * serve-web (patched, see python/patches) exposes the phone's system audio on `/audio.bin` as
 * length-prefixed frames: decoded PCM where the host has AudioToolbox (macOS), otherwise the raw
 * AAC-ELD access units the phone sends (48 kHz stereo, 10 ms each). On Linux those are decoded
 * here with ffmpeg and re-cut into 20 ms `scrcpy_audio_2` raw packets, so `AudioPlayer` on the
 * browser side plays them exactly like Android's PCM. Decoder trouble only ever changes the
 * audio metadata; video and input never depend on this class.
 */
export class CoreDeviceAudioRelay {
    private readonly listeners = new Set<AudioPacketListener>();
    private metadata: AudioMetadata = {
        status: 'pending',
        sampleRate: AUDIO_SAMPLE_RATE,
        channels: AUDIO_CHANNELS,
        message: 'Waiting for the phone audio stream',
    };
    private metadataPacket = CoreDeviceAudioRelay.packet(AudioPacketKind.METADATA, 0n, this.encodedMetadata());
    private request?: http.ClientRequest;
    private response?: http.IncomingMessage;
    private decoder?: ChildProcess;
    private decoderLog = '';
    private pending: Buffer[] = [];
    private pendingBytes = 0;
    private samples = 0n;
    private started = false;
    private stopped = false;

    constructor(
        private readonly udid: string,
        private readonly port: number,
    ) {}

    public getMetadata(): AudioMetadata {
        return this.metadata;
    }

    /** Sends the current metadata immediately, then every packet until the returned function runs. */
    public subscribe(listener: AudioPacketListener): () => void {
        this.listeners.add(listener);
        listener(this.metadataPacket);
        if (!this.started && !this.stopped) {
            this.started = true;
            this.open();
        }
        return () => {
            this.listeners.delete(listener);
        };
    }

    public stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.request?.destroy();
        this.response?.destroy();
        this.request = undefined;
        this.response = undefined;
        this.stopDecoder();
        this.listeners.clear();
    }

    private open(): void {
        const request = http.request(
            { host: '127.0.0.1', port: this.port, path: '/audio.bin', method: 'GET', agent: false },
            (response) => this.onResponse(response),
        );
        this.request = request;
        request.on('error', (error: Error) => {
            if (!this.stopped) {
                this.setMetadata('error', `The phone audio stream failed: ${error.message}`);
            }
        });
        request.end();
    }

    private onResponse(response: http.IncomingMessage): void {
        if (this.stopped) {
            response.destroy();
            return;
        }
        this.response = response;
        if (response.statusCode !== 200) {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => (body += chunk));
            response.on('end', () => {
                const detail = body.trim().split('\n')[0];
                this.setMetadata(
                    'disabled',
                    /AudioToolbox|missing python package/.test(detail)
                        ? 'The iOS helper on the server is unpatched for audio. Run "npm run setup:ios" and restart the session.'
                        : `The phone declined the audio stream (HTTP ${response.statusCode}${detail ? `: ${detail}` : ''}).`,
                );
            });
            return;
        }
        const codec = String(response.headers['x-audio-codec'] || 'aac-eld');
        let feed: (frame: Uint8Array) => void;
        if (codec === 'pcm') {
            feed = (frame) => this.emitPcm(Buffer.from(frame));
        } else if (codec === 'aac-eld') {
            const decoder = this.startDecoder();
            if (!decoder) {
                response.destroy();
                return;
            }
            let sequence = 0;
            decoder.stdin?.write(audioInitSegment());
            feed = (frame) => {
                if (decoder.stdin?.writable) {
                    sequence++;
                    decoder.stdin.write(audioSegment(frame, sequence, (sequence - 1) * FRAME_SAMPLES));
                }
            };
        } else {
            this.setMetadata('error', `The phone audio stream uses an unknown format (${codec}).`);
            response.destroy();
            return;
        }
        this.setMetadata('ready', undefined, 'raw');
        let rest: Uint8Array = new Uint8Array(0);
        response.on('data', (chunk: Buffer) => {
            const merged = new Uint8Array(rest.length + chunk.length);
            merged.set(rest);
            merged.set(chunk, rest.length);
            const split = splitStreamFrames(merged);
            rest = split.rest.slice();
            split.frames.forEach(feed);
        });
        const ended = () => {
            if (!this.stopped) {
                this.setMetadata('error', 'The phone audio stream ended. Restart the session to bring it back.');
            }
        };
        response.on('end', ended);
        response.on('error', ended);
    }

    /**
     * ffmpeg reads fragmented MP4 on stdin and writes interleaved s16le 48 kHz stereo on stdout.
     * `IOS_AUDIO_DECODER` swaps in another command (tests use a stand-in); it gets the same
     * stdin and must write the same PCM.
     */
    private startDecoder(): ChildProcess | undefined {
        const override = process.env.IOS_AUDIO_DECODER;
        const command = override || 'ffmpeg';
        const args = override
            ? []
            : [
                  '-hide_banner',
                  '-loglevel',
                  'error',
                  '-nostdin',
                  // Decode as frames arrive rather than after the demuxer's usual read-ahead.
                  '-fflags',
                  '+nobuffer',
                  '-flags',
                  'low_delay',
                  '-probesize',
                  '32',
                  '-analyzeduration',
                  '0',
                  // One undecodable frame must not make ffmpeg give up on the whole stream.
                  '-max_error_rate',
                  '1',
                  '-f',
                  'mp4',
                  '-i',
                  'pipe:0',
                  '-f',
                  's16le',
                  '-ar',
                  String(AUDIO_SAMPLE_RATE),
                  '-ac',
                  String(AUDIO_CHANNELS),
                  'pipe:1',
              ];
        let decoder: ChildProcess;
        try {
            decoder = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (error) {
            this.setMetadata('error', `The audio decoder could not start: ${(error as Error).message}`);
            return undefined;
        }
        this.decoder = decoder;
        // The decoder must never keep this process alive on its own (a test that fails before
        // releasing the session, or a shutdown racing a late frame).
        decoder.unref();
        // The stdio pipes are net.Sockets at runtime, typed as plain streams.
        for (const pipe of [decoder.stdin, decoder.stdout, decoder.stderr]) {
            (pipe as unknown as { unref?: () => void } | null)?.unref?.();
        }
        decoder.stdout?.on('data', (chunk: Buffer) => this.emitPcm(chunk));
        decoder.stderr?.on('data', (chunk: Buffer) => {
            this.decoderLog = (this.decoderLog + chunk.toString()).slice(-2048);
        });
        decoder.stdin?.on('error', () => undefined);
        decoder.on('error', (error: Error) => {
            if (this.decoder !== decoder || this.stopped) {
                return;
            }
            this.decoder = undefined;
            this.setMetadata(
                'error',
                (error as NodeJS.ErrnoException).code === 'ENOENT'
                    ? `The audio decoder "${command}" is not installed on the server.`
                    : `The audio decoder failed: ${error.message}`,
            );
        });
        decoder.on('exit', (code, signal) => {
            if (this.decoder !== decoder || this.stopped) {
                return;
            }
            this.decoder = undefined;
            const reason = this.decoderLog.trim().split('\n').pop();
            console.error(`${TAG} [${this.udid}] decoder exited (${signal || code})${reason ? `: ${reason}` : ''}`);
            this.setMetadata('error', `The audio decoder stopped${reason ? `: ${reason}` : ''}.`);
        });
        return decoder;
    }

    private stopDecoder(): void {
        const decoder = this.decoder;
        this.decoder = undefined;
        if (decoder) {
            decoder.stdin?.end();
            decoder.kill('SIGTERM');
        }
    }

    private emitPcm(chunk: Buffer): void {
        if (this.stopped || !chunk.length) {
            return;
        }
        this.pending.push(chunk);
        this.pendingBytes += chunk.length;
        if (this.pendingBytes < PACKET_BYTES) {
            return;
        }
        const merged = Buffer.concat(this.pending, this.pendingBytes);
        let offset = 0;
        while (merged.length - offset >= PACKET_BYTES) {
            const timestamp = (this.samples * 1000000n) / BigInt(AUDIO_SAMPLE_RATE);
            this.samples += BigInt(PACKET_SAMPLES);
            this.notify(
                CoreDeviceAudioRelay.packet(
                    AudioPacketKind.SAMPLE,
                    timestamp,
                    merged.subarray(offset, offset + PACKET_BYTES),
                ),
            );
            offset += PACKET_BYTES;
        }
        const rest = merged.subarray(offset);
        this.pending = rest.length ? [Buffer.from(rest)] : [];
        this.pendingBytes = rest.length;
    }

    private setMetadata(status: AudioMetadata['status'], message?: string, codec?: 'raw'): void {
        if (this.stopped) {
            return;
        }
        this.metadata = { status, sampleRate: AUDIO_SAMPLE_RATE, channels: AUDIO_CHANNELS, message, codec };
        this.metadataPacket = CoreDeviceAudioRelay.packet(AudioPacketKind.METADATA, 0n, this.encodedMetadata());
        if (status !== 'ready') {
            console.log(`${TAG} [${this.udid}] audio ${status}${message ? `: ${message}` : ''}`);
        }
        this.notify(this.metadataPacket);
    }

    private encodedMetadata(): Buffer {
        return Buffer.from(JSON.stringify(this.metadata));
    }

    private notify(packet: Buffer): void {
        for (const listener of Array.from(this.listeners)) {
            listener(packet);
        }
    }

    public static packet(kind: AudioPacketKind, timestamp: bigint, payload: Buffer): Buffer {
        const header = Buffer.alloc(AUDIO_PACKET_HEADER_SIZE);
        MAGIC.copy(header);
        header.writeUInt8(kind, MAGIC.length);
        header.writeBigUInt64BE(timestamp, MAGIC.length + 1);
        return Buffer.concat([header, payload]);
    }
}
