// Mirrors the server's `EncoderInfo` (see `src/server/goog-device/ScrcpyServer.ts`), declared
// independently here rather than imported: nothing under `src/app/` or `src/types/` may reach
// into `src/server/`, which pulls in adbkit and other server-only dependencies that must not end
// up in the client bundle.
export interface EncoderInfo {
    videoCodec: string;
    encoderName: string;
    hardware: 'hw' | 'sw' | 'unknown';
    aliasFor?: string;
}
