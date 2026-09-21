/**
 * Browser <-> server protocol for an iOS screen session (`ACTION.PROXY_COREDEVICE`).
 *
 * The server side is a thin bridge over `pymobiledevice3 developer core-device display serve-web`,
 * which owns the RSD tunnel, Apple's CoreDevice display stream (RTP/HEVC) and the HID surfaces.
 * Its HTTP framing is reproduced here almost verbatim so the two stay easy to compare:
 *
 * - `/codec` answers `{codec, description}`: the WebCodecs codec string parsed from the SPS and a
 *   base64 `HEVCDecoderConfigurationRecord` (hvcC). hvcC mode -- parameter sets out of band,
 *   4-byte-length-prefixed NALUs per chunk -- is deliberate: Chrome's Annex-B path tears under
 *   motion, VideoToolbox's hvcC path does not.
 * - `/stream.bin` is a chunked sequence of `[4-byte BE length][1-byte type][AU]`; the type byte is
 *   0 = keyframe, 1 = delta, 2 = keyframe after which the decoder must be rebuilt (the server saw
 *   an upstream drop and the decoder's reference state may be stale).
 *
 * Over the WebSocket every video access unit is one binary message `[type][AU]` (the length is
 * the message itself), device audio is a binary message `[3][scrcpy_audio_2 packet]`, and
 * everything else is a JSON text message.
 */

export const COREDEVICE_FRAME_KEY = 0;
export const COREDEVICE_FRAME_DELTA = 1;
export const COREDEVICE_FRAME_RESET_KEY = 2;
// Not a video frame: the rest of the message is one browser audio packet in the shared
// `scrcpy_audio_2` envelope (see AudioProtocol.ts), so the Android audio player plays it as is.
export const COREDEVICE_FRAME_AUDIO = 3;

export type CoreDeviceSessionState = 'starting' | 'ready' | 'error' | 'stopped';

/**
 * Hardware buttons, forwarded to serve-web's `/button`. `home` and `lock` are sent as an explicit
 * down/up pair by the proxy rather than serve-web's own `press`, whose hold is too short for iOS
 * to accept either of them (see `HOME_PRESS_MS` / `LOCK_TAP_MS`).
 *
 * There is deliberately no app-switcher entry: it was tried and removed, because iOS gives no way
 * to open the switcher on a Face ID phone from here. See docs/HANDOFF.md.
 */
export type CoreDeviceButton = 'home' | 'lock' | 'volume-up' | 'volume-down' | 'mute' | 'siri';

export const COREDEVICE_BUTTONS: readonly CoreDeviceButton[] = [
    'home',
    'lock',
    'volume-up',
    'volume-down',
    'mute',
    'siri',
];

/** Touch/HID coordinates are normalised to the device screen: 0..65535 on both axes. */
export const COREDEVICE_HID_MAX = 0xffff;

// server -> browser
export type CoreDeviceServerMessage =
    | { type: 'status'; state: CoreDeviceSessionState; message?: string }
    | { type: 'codec'; codec: string; description: string }
    | { type: 'clipboard'; text: string | null; error?: string }
    | { type: 'result'; id: number; ok: boolean; error?: string; data?: unknown };

// browser -> server
export type CoreDeviceClientMessage =
    | { type: 'touch'; op: 'contact' | 'release' | 'tap'; x: number; y: number }
    | { type: 'key'; usages: number[] }
    | { type: 'button'; name: CoreDeviceButton; state?: 'press' | 'down' | 'up' }
    | { type: 'clipboard'; op: 'get'; id?: number }
    | { type: 'clipboard'; op: 'set'; text: string; id?: number }
    | { type: 'rotate'; direction: 'left' | 'right'; id?: number }
    | { type: 'pli' }
    // Restarts the device's video inside the running serve-web process (picture recovery).
    | { type: 'restart' }
    // Kills the serve-web process so the next connection gets a fresh one. This is the only
    // recovery for its per-process HID and pasteboard channels, which wedge independently of
    // video: the socket closes and the viewer reconnects into a new process.
    | { type: 'restart-session' };

export function isCoreDeviceButton(value: unknown): value is CoreDeviceButton {
    return typeof value === 'string' && (COREDEVICE_BUTTONS as readonly string[]).includes(value);
}

export function clampHid(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(COREDEVICE_HID_MAX, Math.round(value)));
}

/**
 * Splits `/stream.bin` bytes into framed access units. Returns the complete frames and the
 * unconsumed tail; the tail must be prepended to the next chunk.
 */
export function splitStreamFrames(buffer: Uint8Array): { frames: Uint8Array[]; rest: Uint8Array } {
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (buffer.length - offset >= 4) {
        const length =
            ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>>
            0;
        if (buffer.length - offset < 4 + length) {
            break;
        }
        // The framed payload is `[type][AU]`, exactly what the WebSocket carries.
        frames.push(buffer.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
    }
    return { frames, rest: buffer.subarray(offset) };
}
