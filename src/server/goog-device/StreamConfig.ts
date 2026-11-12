import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_SCRCPY_SERVER_CONFIG, ScrcpyServerConfig } from '../../common/Constants';
import { getSettings } from '../Settings';

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
                if (
                    entry !== undefined &&
                    entry !== 'output' &&
                    entry !== 'playback' &&
                    entry !== 'voice-call-downlink'
                ) {
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
 * scrcpy has no live "change settings" control message, so "apply" means persisting the new
 * config here and relaunching the server with a freshly-built argument string - see
 * Device.updateStreamConfig().
 *
 * An explicit path is kept. New saves otherwise go in the data directory; the former file in
 * the working directory is read when no file exists there yet, so older settings are retained.
 */
export class StreamConfig {
    private static instance?: StreamConfig;
    private readonly filePath: string;
    private readonly legacyFilePath?: string;
    private store: StoreShape = Object.create(null);

    private constructor() {
        const settings = getSettings();
        this.filePath = settings.streamConfigPath;
        this.legacyFilePath = settings.legacyStreamConfigPath;
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
            const file = fs.existsSync(this.filePath) ? this.filePath : this.legacyFilePath;
            if (file && fs.existsSync(file)) {
                const raw = fs.readFileSync(file, 'utf-8');
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
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
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
