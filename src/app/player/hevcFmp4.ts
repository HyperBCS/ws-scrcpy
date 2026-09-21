/**
 * Fragmented-MP4 remuxer for the iOS CoreDevice HEVC stream.
 *
 * Media Source Extensions want ISO BMFF, not raw access units, so this wraps each `[AU]` (already
 * 4-byte-length-prefixed NALUs, exactly what an `hvc1`/`hev1` sample is) in a one-sample
 * `moof`+`mdat` pair, and builds the `moov` init segment around the hvcC record `/codec` hands
 * out. Nothing about the bitstream is touched: the only new bytes are box headers.
 *
 * Kept free of DOM types so the tests can run it in Node and ffprobe can check the output.
 */

const TIMESCALE = 1_000_000; // microseconds

export const HEVC_SPS_NAL_TYPE = 33;

function u8(...values: number[]): Uint8Array {
    return new Uint8Array(values);
}

function u16(value: number): Uint8Array {
    return u8((value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number): Uint8Array {
    return u8((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u64(value: number): Uint8Array {
    const high = Math.floor(value / 0x1_0000_0000);
    const low = value >>> 0;
    return concat([u32(high), u32(low)]);
}

function fourcc(code: string): Uint8Array {
    return u8(code.charCodeAt(0), code.charCodeAt(1), code.charCodeAt(2), code.charCodeAt(3));
}

export function concat(parts: Uint8Array[]): Uint8Array {
    let length = 0;
    for (const part of parts) {
        length += part.length;
    }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
    const body = concat(payload);
    return concat([u32(8 + body.length), fourcc(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
    return box(type, u8(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff), ...payload);
}

const UNITY_MATRIX = concat([
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x40000000),
]);

export interface HevcInitOptions {
    /** `hev1` (parameter sets may also appear in-band, which this stream does) or `hvc1`. */
    sampleEntry: 'hev1' | 'hvc1';
    /** HEVCDecoderConfigurationRecord, verbatim from `/codec`. */
    hvcC: Uint8Array;
    width: number;
    height: number;
}

/** `ftyp` + `moov` for a single video track whose samples are appended one AU at a time. */
export function buildHevcInitSegment({ sampleEntry, hvcC, width, height }: HevcInitOptions): Uint8Array {
    const ftyp = box(
        'ftyp',
        fourcc('isom'),
        u32(0x200),
        fourcc('isom'),
        fourcc('iso2'),
        fourcc('iso5'),
        fourcc('iso6'),
        fourcc('mp41'),
    );
    const mvhd = fullBox(
        'mvhd',
        0,
        0,
        u32(0), // creation_time
        u32(0), // modification_time
        u32(TIMESCALE),
        u32(0), // duration: unknown, live
        u32(0x00010000), // rate 1.0
        u16(0x0100), // volume 1.0
        u16(0),
        u32(0),
        u32(0),
        UNITY_MATRIX,
        new Uint8Array(24), // pre_defined
        u32(2), // next_track_ID
    );
    const tkhd = fullBox(
        'tkhd',
        0,
        0x000007, // enabled | in_movie | in_preview
        u32(0),
        u32(0),
        u32(1), // track_ID
        u32(0),
        u32(0), // duration
        u32(0),
        u32(0),
        u16(0), // layer
        u16(0), // alternate_group
        u16(0), // volume (video)
        u16(0),
        UNITY_MATRIX,
        u32(width << 16),
        u32(height << 16),
    );
    const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0)); // language 'und'
    const hdlr = fullBox(
        'hdlr',
        0,
        0,
        u32(0),
        fourcc('vide'),
        u32(0),
        u32(0),
        u32(0),
        u8(...'VideoHandler'.split('').map((c) => c.charCodeAt(0))),
        u8(0),
    );
    const vmhd = fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const visualSampleEntry = box(
        sampleEntry,
        new Uint8Array(6), // reserved
        u16(1), // data_reference_index
        u16(0), // pre_defined
        u16(0), // reserved
        new Uint8Array(12), // pre_defined
        u16(width),
        u16(height),
        u32(0x00480000), // horizresolution 72 dpi
        u32(0x00480000), // vertresolution
        u32(0), // reserved
        u16(1), // frame_count
        new Uint8Array(32), // compressorname (empty)
        u16(0x0018), // depth
        u16(0xffff), // pre_defined = -1
        box('hvcC', hvcC),
    );
    const stsd = fullBox('stsd', 0, 0, u32(1), visualSampleEntry);
    const stbl = box(
        'stbl',
        stsd,
        fullBox('stts', 0, 0, u32(0)),
        fullBox('stsc', 0, 0, u32(0)),
        fullBox('stsz', 0, 0, u32(0), u32(0)),
        fullBox('stco', 0, 0, u32(0)),
    );
    const minf = box('minf', vmhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const trak = box('trak', tkhd, mdia);
    const trex = fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0));
    const mvex = box('mvex', trex);
    const moov = box('moov', mvhd, trak, mvex);
    return concat([ftyp, moov]);
}

export interface HevcSampleOptions {
    /** The access unit: 4-byte-length-prefixed NALUs, as delivered (no type byte). */
    accessUnit: Uint8Array;
    sequenceNumber: number;
    /** Decode time in microseconds (ignored by browsers in 'sequence' mode, kept for players that care). */
    decodeTime: number;
    /** Sample duration in microseconds. */
    duration: number;
    isKeyFrame: boolean;
}

const TRUN_FLAGS = 0x000001 | 0x000100 | 0x000200 | 0x000400; // data-offset, duration, size, flags
const SAMPLE_FLAGS_SYNC = 0x02000000; // depends_on = 2 (I picture)
const SAMPLE_FLAGS_NON_SYNC = 0x01010000; // depends_on = 1, is_non_sync_sample

/** One `moof` + `mdat` carrying exactly one access unit. */
export function buildHevcMediaSegment({
    accessUnit,
    sequenceNumber,
    decodeTime,
    duration,
    isKeyFrame,
}: HevcSampleOptions): Uint8Array {
    const mfhd = fullBox('mfhd', 0, 0, u32(sequenceNumber));
    const tfhd = fullBox('tfhd', 0, 0x020000, u32(1)); // default-base-is-moof
    const tfdt = fullBox('tfdt', 1, 0, u64(decodeTime));
    const trunWithoutOffset = (dataOffset: number) =>
        fullBox(
            'trun',
            0,
            TRUN_FLAGS,
            u32(1), // sample_count
            u32(dataOffset),
            u32(duration),
            u32(accessUnit.length),
            u32(isKeyFrame ? SAMPLE_FLAGS_SYNC : SAMPLE_FLAGS_NON_SYNC),
        );
    // The data offset points at the first byte after the mdat header, relative to the moof start;
    // the trun's own size does not depend on the offset value, so size it once with a placeholder.
    const moofSize = box('moof', mfhd, box('traf', tfhd, tfdt, trunWithoutOffset(0))).length;
    const moof = box('moof', mfhd, box('traf', tfhd, tfdt, trunWithoutOffset(moofSize + 8)));
    const mdat = box('mdat', accessUnit);
    return concat([moof, mdat]);
}

/** Splits an hvcC record into its parameter-set NALUs (VPS, SPS, PPS, SEI...). */
export function hvccNalus(hvcC: Uint8Array): { type: number; nalu: Uint8Array }[] {
    const out: { type: number; nalu: Uint8Array }[] = [];
    if (hvcC.length < 23) {
        return out;
    }
    let offset = 22;
    const arrays = hvcC[offset++];
    for (let a = 0; a < arrays && offset + 3 <= hvcC.length; a++) {
        const type = hvcC[offset++] & 0x3f;
        const count = (hvcC[offset] << 8) | hvcC[offset + 1];
        offset += 2;
        for (let i = 0; i < count && offset + 2 <= hvcC.length; i++) {
            const length = (hvcC[offset] << 8) | hvcC[offset + 1];
            offset += 2;
            out.push({ type, nalu: hvcC.subarray(offset, offset + length) });
            offset += length;
        }
    }
    return out;
}

class BitReader {
    private pos = 0;
    constructor(private readonly bytes: Uint8Array) {}

    public bit(): number {
        const byte = this.bytes[this.pos >>> 3];
        if (byte === undefined) {
            throw new RangeError('SPS truncated');
        }
        const value = (byte >>> (7 - (this.pos & 7))) & 1;
        this.pos++;
        return value;
    }

    public bits(count: number): number {
        let value = 0;
        for (let i = 0; i < count; i++) {
            value = value * 2 + this.bit();
        }
        return value;
    }

    public skip(count: number): void {
        this.pos += count;
    }

    /** Unsigned Exp-Golomb. */
    public ue(): number {
        let zeros = 0;
        while (this.bit() === 0) {
            if (++zeros > 32) {
                throw new RangeError('bad Exp-Golomb code');
            }
        }
        return (1 << zeros) - 1 + this.bits(zeros);
    }
}

function stripEmulationPrevention(nalu: Uint8Array): Uint8Array {
    const out: number[] = [];
    let zeros = 0;
    for (let i = 0; i < nalu.length; i++) {
        const byte = nalu[i];
        if (zeros >= 2 && byte === 3) {
            zeros = 0;
            continue; // emulation_prevention_three_byte
        }
        out.push(byte);
        zeros = byte === 0 ? zeros + 1 : 0;
    }
    return new Uint8Array(out);
}

/**
 * Picture size from the SPS inside an hvcC record, or `undefined` when it cannot be read. Used
 * for the `tkhd`/sample-entry dimensions before the first frame has been decoded.
 */
export function parseHevcSpsSize(hvcC: Uint8Array): { width: number; height: number } | undefined {
    const sps = hvccNalus(hvcC).find((entry) => entry.type === HEVC_SPS_NAL_TYPE);
    if (!sps) {
        return undefined;
    }
    try {
        const rbsp = stripEmulationPrevention(sps.nalu.subarray(2)); // skip the 2-byte NAL header
        const reader = new BitReader(rbsp);
        reader.skip(4); // sps_video_parameter_set_id
        const maxSubLayersMinus1 = reader.bits(3);
        reader.skip(1); // sps_temporal_id_nesting_flag
        // profile_tier_level(1, maxSubLayersMinus1)
        reader.skip(88); // general profile space/tier/idc, compatibility flags, constraint flags
        reader.skip(8); // general_level_idc
        const subLayerProfilePresent: number[] = [];
        const subLayerLevelPresent: number[] = [];
        for (let i = 0; i < maxSubLayersMinus1; i++) {
            subLayerProfilePresent.push(reader.bit());
            subLayerLevelPresent.push(reader.bit());
        }
        if (maxSubLayersMinus1 > 0) {
            for (let i = maxSubLayersMinus1; i < 8; i++) {
                reader.skip(2); // reserved_zero_2bits
            }
        }
        for (let i = 0; i < maxSubLayersMinus1; i++) {
            if (subLayerProfilePresent[i]) {
                reader.skip(88);
            }
            if (subLayerLevelPresent[i]) {
                reader.skip(8);
            }
        }
        reader.ue(); // sps_seq_parameter_set_id
        const chromaFormatIdc = reader.ue();
        if (chromaFormatIdc === 3) {
            reader.skip(1); // separate_colour_plane_flag
        }
        let width = reader.ue(); // pic_width_in_luma_samples
        let height = reader.ue(); // pic_height_in_luma_samples
        if (reader.bit()) {
            // conformance_window_flag: offsets are in chroma sample units
            const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
            const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
            const left = reader.ue();
            const right = reader.ue();
            const top = reader.ue();
            const bottom = reader.ue();
            width -= (left + right) * subWidthC;
            height -= (top + bottom) * subHeightC;
        }
        if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
            return undefined;
        }
        return { width, height };
    } catch {
        return undefined;
    }
}

/**
 * The `codecs=` parameter for `MediaSource.isTypeSupported`, in both sample-entry spellings. The
 * stream announces `hev1.…`; some browsers only admit `hvc1.…` for the same bytes.
 */
export function hevcMimeCandidates(codec: string): { mime: string; sampleEntry: 'hev1' | 'hvc1' }[] {
    const suffix = codec.replace(/^(hev1|hvc1)/, '');
    const preferred: 'hev1' | 'hvc1' = codec.startsWith('hvc1') ? 'hvc1' : 'hev1';
    const other: 'hev1' | 'hvc1' = preferred === 'hev1' ? 'hvc1' : 'hev1';
    return [preferred, other].map((sampleEntry) => ({
        sampleEntry,
        mime: `video/mp4; codecs="${sampleEntry}${suffix}"`,
    }));
}
