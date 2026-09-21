import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_SCRCPY_SERVER_CONFIG, ScrcpyServerConfig } from '../../common/Constants';
import { EnvName } from '../EnvName';

export type StreamConfigData = ScrcpyServerConfig;

const TAG = '[StreamConfig]';

type StoreShape = Record<string, Partial<StreamConfigData>>;

/** Validate before persisting or stopping a working stream. These values become shell args. */
export function validateStreamConfigPatch(value: unknown): Partial<StreamConfigData> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Stream config must be an object');
    }
    const patch: Partial<StreamConfigData> = {};
    for (const [key, entry] of Object.entries(value)) {
        switch (key) {
            case 'videoCodec':
                if (entry !== undefined && entry !== '' && !['h264', 'h265', 'av1'].includes(entry as string)) {
                    throw new Error('Invalid video codec');
                }
                patch.videoCodec = entry || undefined;
                break;
            case 'videoEncoder':
                if (entry !== undefined && (typeof entry !== 'string' || !/^[\w.:-]*$/.test(entry))) {
                    throw new Error('Invalid video encoder name');
                }
                patch.videoEncoder = entry || undefined;
                break;
            case 'audio':
                if (typeof entry !== 'boolean') {
                    throw new Error('Audio must be a boolean');
                }
                patch.audio = entry;
                break;
            case 'audioCodec':
                if (entry !== undefined && entry !== 'raw' && entry !== 'opus') {
                    throw new Error('Invalid audio codec');
                }
                patch.audioCodec = entry;
                break;
            case 'audioSource':
                if (entry !== undefined && entry !== 'output' && entry !== 'voice-call-downlink') {
                    throw new Error('Invalid audio source');
                }
                patch.audioSource = entry;
                break;
            case 'bitrate':
            case 'maxFps':
            case 'maxSize':
            case 'iFrameInterval':
            case 'displayId': {
                const maximum = key === 'maxSize' ? 65535 : 2147483647;
                const minimum = key === 'bitrate' ? 1 : 0;
                if (
                    typeof entry !== 'number' ||
                    !Number.isFinite(entry) ||
                    entry < minimum ||
                    entry > maximum ||
                    (key !== 'maxFps' && !Number.isInteger(entry))
                ) {
                    throw new Error(`Invalid ${key} value`);
                }
                patch[key] = entry;
                break;
            }
            default:
                throw new Error(`Unknown stream config field: ${key}`);
        }
    }
    return patch;
}

/**
 * Per-device video-settings overrides, layered on top of DEFAULT_SCRCPY_SERVER_CONFIG. Stock
 * scrcpy has no live "change settings" control message (see the commented-out
 * sendNewVideoSetting() call sites in StreamClientScrcpy), so "apply" means persisting the new
 * config here and relaunching the server with a freshly-built argument string - see
 * Device.updateStreamConfig().
 *
 * File location mirrors Config.ts: a path from the environment is used as-is if absolute,
 * otherwise resolved against process.cwd(); with nothing set, it defaults to a file in cwd next
 * to where the process is started (Config.ts has no such default because it requires an explicit
 * path or falls back to in-memory defaults - this store always needs *some* file to persist to).
 */
export class StreamConfig {
    private static instance?: StreamConfig;
    private readonly filePath: string;
    private store: StoreShape = Object.create(null);

    private constructor() {
        const configured = process.env[EnvName.STREAM_CONFIG_PATH];
        if (configured) {
            this.filePath = path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
        } else {
            this.filePath = path.resolve(process.cwd(), 'stream-config.json');
        }
        this.load();
    }

    public static getInstance(): StreamConfig {
        if (!this.instance) {
            this.instance = new StreamConfig();
        }
        return this.instance;
    }

    private load(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    for (const [udid, config] of Object.entries(parsed)) {
                        try {
                            this.store[udid] = validateStreamConfigPatch(config);
                        } catch (error) {
                            console.error(TAG, `Ignoring invalid config for "${udid}": ${(error as Error).message}`);
                        }
                    }
                }
            }
        } catch (e: any) {
            console.error(TAG, `Failed to read "${this.filePath}": ${e.message}`);
        }
    }

    private persist(): void {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 4));
        } catch (e: any) {
            // Best-effort: an unwritable path should not block applying the config in memory,
            // it just will not survive a process restart.
            console.error(TAG, `Failed to write "${this.filePath}": ${e.message}`);
        }
    }

    public get(udid: string): StreamConfigData {
        return { ...DEFAULT_SCRCPY_SERVER_CONFIG, ...this.store[udid] };
    }

    public set(udid: string, patch: Partial<StreamConfigData>): StreamConfigData {
        const merged = { ...this.get(udid), ...validateStreamConfigPatch(patch) };
        this.store[udid] = merged;
        this.persist();
        return merged;
    }
}

export const streamConfig = StreamConfig.getInstance();
