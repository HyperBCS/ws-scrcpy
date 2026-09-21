import { AudioCodec, AudioSource } from './AudioProtocol';

export const SERVER_PACKAGE = 'com.genymobile.scrcpy.Server';
export const SERVER_PORT = 8886;
export const SERVER_VERSION = '4.1';
export const SERVER_PROCESS_NAME = 'app_process';

/**
 * Per-device scrcpy server configuration. Fields left `undefined` are omitted from the built
 * argument string entirely, so scrcpy falls back to its own default instead of us guessing one -
 * this matters most for `videoEncoder`: leaving it unset lets scrcpy pick a hardware encoder,
 * where the old hardcoded `video_encoder=OMX.google.h264.encoder` pinned every device to a
 * software encoder.
 */
export interface ScrcpyServerConfig {
    videoCodec?: string; // e.g. 'h264' (scrcpy default), 'h265', 'av1'
    videoEncoder?: string; // e.g. 'OMX.qcom.video.encoder.avc'; unset = scrcpy picks one itself
    bitrate: number; // video_bit_rate, bits/sec
    maxFps: number; // 0 = unlimited
    maxSize: number; // 0 = device's native size
    iFrameInterval: number; // seconds, folded into video_codec_options
    displayId: number; // 0 = default display
    // Enabled by default. When `true`, scrcpy opens an
    // extra socket - video, then audio, then control, in that fixed order - so BroadcastManager
    // must be told this value for the same udid the server was launched with; getting it wrong
    // silently misroutes the control channel. See BroadcastManager.startBroadcast().
    audio: boolean;
    audioCodec?: AudioCodec;
    audioSource?: AudioSource;
}

// Matches the behaviour of the old fixed ARGS_STRING, with one deliberate change: videoEncoder
// is left unset (see ScrcpyServerConfig above) instead of forcing the software encoder.
export const DEFAULT_SCRCPY_SERVER_CONFIG: ScrcpyServerConfig = {
    bitrate: 3_500_000,
    maxFps: 60,
    maxSize: 1280,
    iFrameInterval: 1,
    displayId: 0,
    audio: true,
    // PCM works through Web Audio on phone browsers and plain HTTP; Opus remains an option
    // for secure browsers with WebCodecs when lower bandwidth matters more.
    audioCodec: 'raw',
    audioSource: 'output',
};

/**
 * Builds the positional-then-`key=value` argument list scrcpy-server.jar expects on its command
 * line (e.g. `3.1 tunnel_forward=true control=true video_bit_rate=3500000 ...`). These are the
 * server's own options, distinct from the desktop client's `--flag` names, confirmed against the
 * scrcpy 3.1 docs for the option names that changed (video_codec/video_encoder/list_encoders);
 * the rest are unchanged from this fork's previous, working ARGS_STRING.
 */
export function buildScrcpyArgs(cfg: ScrcpyServerConfig): string {
    const args: string[] = [SERVER_VERSION];

    // Fixed transport requirements for this fork (single forwarded local socket, no debug byte,
    // no device-meta banner ahead of the video stream) - not user-configurable.
    args.push('send_dummy_byte=false');
    args.push('send_device_meta=false');
    args.push('tunnel_forward=true');
    args.push('control=true');

    if (cfg.videoCodec) {
        args.push(`video_codec=${cfg.videoCodec}`);
    }
    if (cfg.videoEncoder) {
        args.push(`video_encoder=${cfg.videoEncoder}`);
    }
    args.push(`video_bit_rate=${cfg.bitrate}`);
    args.push(`max_fps=${cfg.maxFps}`);
    args.push(`max_size=${cfg.maxSize}`);
    args.push(`video_codec_options=i-frame-interval=${cfg.iFrameInterval}`);
    if (cfg.displayId) {
        args.push(`display_id=${cfg.displayId}`);
    }
    args.push(`audio=${cfg.audio ? 'true' : 'false'}`);
    if (cfg.audio) {
        args.push(`audio_codec=${cfg.audioCodec ?? 'raw'}`);
        args.push(`audio_source=${cfg.audioSource ?? 'output'}`);
    }

    return args.join(' ');
}
