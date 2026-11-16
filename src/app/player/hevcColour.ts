/**
 * The colour of an iPhone's HEVC picture: what the stream's SPS declares, and what the players
 * hand the browser for it.
 *
 * Why: the iPhone sends full-range pixels (`video_full_range_flag` = 1) and leaves primaries,
 * transfer and matrix unspecified (2). Chrome is thought to drop the range when the colour
 * description says nothing, and to show the picture as limited range: whites clip, blacks
 * crush. That is a reading, not a proof; only a Chrome with hardware HEVC can show it. So both
 * players say the colour to the browser themselves, and the owner can choose Full or Limited
 * in Settings to compare.
 *
 * Kept free of DOM types, like `hevcFmp4.ts`, so the tests can run it in Node.
 */
import { HEVC_SPS_NAL_TYPE, hvccNalus, NclxColour, stripEmulationPrevention } from './hevcFmp4';

/** What the picture's range follows: the stream (`auto`), or a range the owner chose. */
export type ColourRange = 'auto' | 'full' | 'limited';
export const COLOUR_RANGES: ReadonlyArray<ColourRange> = ['auto', 'full', 'limited'];

/**
 * The colour fields of the VUI of an HEVC SPS (H.265 E.2.1). A field the stream leaves out holds
 * the value H.265 infers for it: limited range, and 2 (unspecified) for each code point.
 */
export interface HevcColour {
    /** vui_parameters_present_flag. */
    vui: boolean;
    /** video_signal_type_present_flag: the stream says its range. */
    signalType: boolean;
    /** video_full_range_flag. */
    fullRange: boolean;
    /** colour_description_present_flag. */
    description: boolean;
    /** H.273 code points. */
    primaries: number;
    transfer: number;
    matrix: number;
}

/** The colour space a `VideoDecoderConfig` takes. The names are the WebCodecs enum values. */
export interface WebCodecsColour {
    primaries: string;
    transfer: string;
    matrix: string;
    fullRange: boolean;
}

const UNSPECIFIED = 2;
const BT709 = 1;

interface CodePoint {
    /** A short name for the fact in Settings. */
    name: string;
    /** The WebCodecs value, where WebCodecs has one. */
    webCodecs?: string;
}

// Every code point H.273 defines. A value outside these is reserved and treated as not declared.
const PRIMARIES: Record<number, CodePoint> = {
    1: { name: 'BT.709', webCodecs: 'bt709' },
    4: { name: 'BT.470M' },
    5: { name: 'BT.601', webCodecs: 'bt470bg' },
    6: { name: 'BT.601', webCodecs: 'smpte170m' },
    7: { name: 'SMPTE 240M' },
    8: { name: 'film' },
    9: { name: 'BT.2020', webCodecs: 'bt2020' },
    10: { name: 'XYZ' },
    11: { name: 'DCI-P3' },
    12: { name: 'Display P3', webCodecs: 'smpte432' },
    22: { name: 'EBU 3213' },
};
const TRANSFER: Record<number, CodePoint> = {
    1: { name: 'BT.709', webCodecs: 'bt709' },
    4: { name: 'gamma 2.2' },
    5: { name: 'gamma 2.8' },
    6: { name: 'BT.601', webCodecs: 'smpte170m' },
    7: { name: 'SMPTE 240M' },
    8: { name: 'linear', webCodecs: 'linear' },
    9: { name: 'log 100:1' },
    10: { name: 'log 316:1' },
    11: { name: 'IEC 61966-2-4' },
    12: { name: 'BT.1361' },
    13: { name: 'sRGB', webCodecs: 'iec61966-2-1' },
    // The BT.2020 curve is the BT.709 curve at a higher precision.
    14: { name: 'BT.2020', webCodecs: 'bt709' },
    15: { name: 'BT.2020', webCodecs: 'bt709' },
    16: { name: 'PQ', webCodecs: 'pq' },
    17: { name: 'SMPTE 428' },
    18: { name: 'HLG', webCodecs: 'hlg' },
};
const MATRIX: Record<number, CodePoint> = {
    0: { name: 'RGB', webCodecs: 'rgb' },
    1: { name: 'BT.709', webCodecs: 'bt709' },
    4: { name: 'FCC' },
    5: { name: 'BT.601', webCodecs: 'bt470bg' },
    6: { name: 'BT.601', webCodecs: 'smpte170m' },
    7: { name: 'SMPTE 240M' },
    8: { name: 'YCgCo' },
    9: { name: 'BT.2020', webCodecs: 'bt2020-ncl' },
    10: { name: 'BT.2020 CL' },
    11: { name: 'SMPTE 2085' },
    12: { name: 'chromaticity NCL' },
    13: { name: 'chromaticity CL' },
    14: { name: 'ICtCp' },
};

/** Bits of an RBSP, most significant first. Reading past the end throws. */
class Bits {
    private pos = 0;
    private readonly length: number;
    constructor(private readonly bytes: Uint8Array) {
        this.length = bytes.length * 8;
    }

    public bit(): number {
        if (this.pos >= this.length) {
            throw new RangeError('SPS cut off');
        }
        const value = (this.bytes[this.pos >>> 3] >>> (7 - (this.pos & 7))) & 1;
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
        if (this.pos + count > this.length) {
            throw new RangeError('SPS cut off');
        }
        this.pos += count;
    }

    /** Unsigned Exp-Golomb. */
    public ue(): number {
        let zeros = 0;
        while (this.bit() === 0) {
            if (++zeros > 31) {
                throw new RangeError('bad Exp-Golomb code');
            }
        }
        return 2 ** zeros - 1 + this.bits(zeros);
    }

    /** Signed Exp-Golomb. */
    public se(): number {
        const value = this.ue();
        return value % 2 ? (value + 1) / 2 : -(value / 2);
    }
}

/** A value outside what H.265 allows: the header is not one this parser can read. */
function limit(value: number, max: number, what: string): number {
    if (value > max) {
        throw new RangeError(`${what} out of range`);
    }
    return value;
}

function skipProfileTierLevel(bits: Bits, maxSubLayersMinus1: number): void {
    bits.skip(88); // general profile space, tier, idc, compatibility and constraint flags
    bits.skip(8); // general_level_idc
    const profilePresent: number[] = [];
    const levelPresent: number[] = [];
    for (let i = 0; i < maxSubLayersMinus1; i++) {
        profilePresent.push(bits.bit());
        levelPresent.push(bits.bit());
    }
    if (maxSubLayersMinus1 > 0) {
        bits.skip(2 * (8 - maxSubLayersMinus1)); // reserved_zero_2bits
    }
    for (let i = 0; i < maxSubLayersMinus1; i++) {
        if (profilePresent[i]) bits.skip(88);
        if (levelPresent[i]) bits.skip(8);
    }
}

/** H.265 7.3.4. */
function skipScalingListData(bits: Bits): void {
    for (let sizeId = 0; sizeId < 4; sizeId++) {
        for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
            if (!bits.bit()) {
                bits.ue(); // scaling_list_pred_matrix_id_delta
                continue;
            }
            const coefficients = Math.min(64, 1 << (4 + (sizeId << 1)));
            if (sizeId > 1) bits.se(); // scaling_list_dc_coef_minus8
            for (let i = 0; i < coefficients; i++) bits.se(); // scaling_list_delta_coef
        }
    }
}

/** The picture order count deltas of one short-term reference picture set. */
interface RefPicSet {
    negative: number[];
    positive: number[];
}

/**
 * H.265 7.3.7 with the derivation of 7.4.8. A set predicted from the one before it has as many
 * flags as that set has pictures, plus one, so each set's pictures must be counted exactly.
 */
function readRefPicSet(bits: Bits, index: number, sets: RefPicSet[]): RefPicSet {
    if (index > 0 && bits.bit()) {
        // inter_ref_pic_set_prediction_flag. In an SPS the reference is the set before.
        const ref = sets[index - 1];
        const sign = bits.bit();
        const deltaRps = (sign ? -1 : 1) * (limit(bits.ue(), 2 ** 15 - 1, 'abs_delta_rps_minus1') + 1);
        const count = ref.negative.length + ref.positive.length;
        const useDelta: boolean[] = [];
        for (let j = 0; j <= count; j++) {
            const used = bits.bit() === 1;
            useDelta.push(used || bits.bit() === 1);
        }
        const offset = ref.negative.length;
        const negative: number[] = [];
        const positive: number[] = [];
        for (let j = ref.positive.length - 1; j >= 0; j--) {
            const poc = ref.positive[j] + deltaRps;
            if (poc < 0 && useDelta[offset + j]) negative.push(poc);
        }
        if (deltaRps < 0 && useDelta[count]) negative.push(deltaRps);
        for (let j = 0; j < ref.negative.length; j++) {
            const poc = ref.negative[j] + deltaRps;
            if (poc < 0 && useDelta[j]) negative.push(poc);
        }
        for (let j = ref.negative.length - 1; j >= 0; j--) {
            const poc = ref.negative[j] + deltaRps;
            if (poc > 0 && useDelta[j]) positive.push(poc);
        }
        if (deltaRps > 0 && useDelta[count]) positive.push(deltaRps);
        for (let j = 0; j < ref.positive.length; j++) {
            const poc = ref.positive[j] + deltaRps;
            if (poc > 0 && useDelta[offset + j]) positive.push(poc);
        }
        limit(negative.length + positive.length, 16, 'reference pictures');
        return { negative, positive };
    }
    const negativeCount = limit(bits.ue(), 16, 'num_negative_pics');
    const positiveCount = limit(bits.ue(), 16, 'num_positive_pics');
    const negative: number[] = [];
    const positive: number[] = [];
    let poc = 0;
    for (let i = 0; i < negativeCount; i++) {
        poc -= bits.ue() + 1; // delta_poc_s0_minus1
        bits.skip(1); // used_by_curr_pic_s0_flag
        negative.push(poc);
    }
    poc = 0;
    for (let i = 0; i < positiveCount; i++) {
        poc += bits.ue() + 1; // delta_poc_s1_minus1
        bits.skip(1); // used_by_curr_pic_s1_flag
        positive.push(poc);
    }
    return { negative, positive };
}

function notDeclared(vui: boolean, signalType = false, fullRange = false): HevcColour {
    return {
        vui,
        signalType,
        fullRange,
        description: false,
        primaries: UNSPECIFIED,
        transfer: UNSPECIFIED,
        matrix: UNSPECIFIED,
    };
}

/** H.265 7.3.2.2.1 up to the colour fields of the VUI (E.2.1). */
function readSpsColour(bits: Bits): HevcColour {
    bits.skip(4); // sps_video_parameter_set_id
    const maxSubLayersMinus1 = limit(bits.bits(3), 6, 'sps_max_sub_layers_minus1');
    bits.skip(1); // sps_temporal_id_nesting_flag
    skipProfileTierLevel(bits, maxSubLayersMinus1);
    bits.ue(); // sps_seq_parameter_set_id
    const chromaFormatIdc = limit(bits.ue(), 3, 'chroma_format_idc');
    if (chromaFormatIdc === 3) bits.skip(1); // separate_colour_plane_flag
    bits.ue(); // pic_width_in_luma_samples
    bits.ue(); // pic_height_in_luma_samples
    if (bits.bit()) {
        // conformance_window_flag: left, right, top and bottom offsets
        for (let i = 0; i < 4; i++) bits.ue();
    }
    bits.ue(); // bit_depth_luma_minus8
    bits.ue(); // bit_depth_chroma_minus8
    const pocLsbBits = limit(bits.ue(), 12, 'log2_max_pic_order_cnt_lsb_minus4') + 4;
    const orderingInfo = bits.bit(); // sps_sub_layer_ordering_info_present_flag
    for (let i = orderingInfo ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
        bits.ue(); // sps_max_dec_pic_buffering_minus1
        bits.ue(); // sps_max_num_reorder_pics
        bits.ue(); // sps_max_latency_increase_plus1
    }
    // Coding and transform block sizes, and the transform hierarchy depths.
    for (let i = 0; i < 6; i++) bits.ue();
    if (bits.bit() && bits.bit()) {
        // scaling_list_enabled_flag, then sps_scaling_list_data_present_flag
        skipScalingListData(bits);
    }
    bits.skip(2); // amp_enabled_flag, sample_adaptive_offset_enabled_flag
    if (bits.bit()) {
        // pcm_enabled_flag
        bits.skip(8); // PCM sample bit depths
        bits.ue(); // log2_min_pcm_luma_coding_block_size_minus3
        bits.ue(); // log2_diff_max_min_pcm_luma_coding_block_size
        bits.skip(1); // pcm_loop_filter_disabled_flag
    }
    const setCount = limit(bits.ue(), 64, 'num_short_term_ref_pic_sets');
    const sets: RefPicSet[] = [];
    for (let i = 0; i < setCount; i++) {
        sets.push(readRefPicSet(bits, i, sets));
    }
    if (bits.bit()) {
        // long_term_ref_pics_present_flag
        const longTerm = limit(bits.ue(), 32, 'num_long_term_ref_pics_sps');
        for (let i = 0; i < longTerm; i++) bits.skip(pocLsbBits + 1);
    }
    bits.skip(2); // sps_temporal_mvp_enabled_flag, strong_intra_smoothing_enabled_flag
    if (!bits.bit()) {
        return notDeclared(false);
    }
    if (bits.bit() && bits.bits(8) === 255) {
        // aspect_ratio_info_present_flag, aspect_ratio_idc = EXTENDED_SAR: sar_width, sar_height
        bits.skip(32);
    }
    if (bits.bit()) bits.skip(1); // overscan_info_present_flag, overscan_appropriate_flag
    if (!bits.bit()) {
        return notDeclared(true);
    }
    bits.skip(3); // video_format
    const fullRange = bits.bit() === 1;
    if (!bits.bit()) {
        return notDeclared(true, true, fullRange);
    }
    return {
        vui: true,
        signalType: true,
        fullRange,
        description: true,
        primaries: bits.bits(8),
        transfer: bits.bits(8),
        matrix: bits.bits(8),
    };
}

/**
 * The colour the SPS inside an hvcC record declares, or `undefined` when there is no SPS or it
 * cannot be read. Never throws: a header this cannot read leaves the players as they were.
 */
export function parseHevcColour(hvcC: Uint8Array): HevcColour | undefined {
    try {
        const sps = hvccNalus(hvcC).find((entry) => entry.type === HEVC_SPS_NAL_TYPE);
        if (!sps || sps.nalu.length < 3) {
            return undefined;
        }
        return readSpsColour(new Bits(stripEmulationPrevention(sps.nalu.subarray(2))));
    } catch {
        return undefined;
    }
}

function declaredCode(code: number | undefined, table: Record<number, CodePoint>): number | undefined {
    return code !== undefined && table[code] ? code : undefined;
}

/**
 * The colour the players hand the browser. `auto`: the range the stream declares (limited where it
 * says nothing, as H.265 infers), `full` and `limited` override it. Primaries, transfer and
 * matrix as declared, BT.709 for each one the stream leaves out, so the browser has a whole
 * colour space and does not drop the range. `undefined` (nothing is handed over, as before this
 * existed) when the choice is `auto` and the header could not be read.
 */
export function pictureColour(stream: HevcColour | undefined, range: ColourRange): NclxColour | undefined {
    if (!stream && range === 'auto') {
        return undefined;
    }
    return {
        primaries: declaredCode(stream?.primaries, PRIMARIES) ?? BT709,
        transfer: declaredCode(stream?.transfer, TRANSFER) ?? BT709,
        matrix: declaredCode(stream?.matrix, MATRIX) ?? BT709,
        fullRange: range === 'auto' ? !!stream?.fullRange : range === 'full',
    };
}

/** The same colour in WebCodecs terms. A code point WebCodecs has no name for becomes BT.709. */
export function webCodecsColour(colour: NclxColour): WebCodecsColour {
    return {
        primaries: PRIMARIES[colour.primaries]?.webCodecs ?? 'bt709',
        transfer: TRANSFER[colour.transfer]?.webCodecs ?? 'bt709',
        matrix: MATRIX[colour.matrix]?.webCodecs ?? 'bt709',
        fullRange: colour.fullRange,
    };
}

/** Short names of the code points the stream declares; a member it leaves out is undefined. */
export function colourNames(stream: HevcColour): { primaries?: string; transfer?: string; matrix?: string } {
    const name = (code: number, table: Record<number, CodePoint>) =>
        code === UNSPECIFIED ? undefined : (table[code]?.name ?? `code ${code}`);
    return {
        primaries: name(stream.primaries, PRIMARIES),
        transfer: name(stream.transfer, TRANSFER),
        matrix: name(stream.matrix, MATRIX),
    };
}
