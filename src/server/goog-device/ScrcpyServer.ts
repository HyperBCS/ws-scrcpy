import '../../../vendor/Genymobile/scrcpy/scrcpy-server.jar';
import '../../../vendor/Genymobile/scrcpy/LICENSE';

import { StreamConfigData } from './StreamConfig';
import {
    buildScrcpyArgs,
    ScrcpyServerConfig,
    SERVER_PACKAGE,
    SERVER_PROCESS_NAME,
    SERVER_VERSION,
} from '../../common/Constants';
import path from 'path';
import PushTransfer from '@dead50f7/adbkit/lib/adb/sync/pushtransfer';
import { ScrcpyInstance } from './ScrcpyInstance';
import { once } from 'events';

export interface ScrcpyTarget {
    udid: string;
    TAG: string;
    isConnected(): boolean;
    getPidOf(name: string, strict?: boolean, signal?: AbortSignal): Promise<number[] | undefined>;
    runShellCommandAdbKit(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<string>;
    push(contents: string, path: string, signal?: AbortSignal): Promise<PushTransfer>;
    getLaunchStreamConfig(): StreamConfigData;
    launchServer(command: string, audio: boolean): Promise<void>;
}

const TEMP_PATH = '/data/local/tmp/';
const FILE_DIR = path.join(__dirname, 'vendor/Genymobile/scrcpy');
const FILE_NAME = 'scrcpy-server.jar';
const CLASSPATH_PREFIX = `CLASSPATH=${TEMP_PATH}${FILE_NAME} app_process`;

export interface EncoderInfo {
    videoCodec: string;
    encoderName: string;
    /** `(hw)` / `(sw)` as reported by scrcpy; 'unknown' if the line carried neither. */
    hardware: 'hw' | 'sw' | 'unknown';
    /** Set when scrcpy marked this as "(alias for X)" - the same encoder under a legacy name. */
    aliasFor?: string;
}

export class ScrcpyServer {
    // Matches the lines scrcpy-server prints for `list_encoders=true`, e.g.
    //     --video-codec=h264 --video-encoder='OMX.qcom.video.encoder.avc'
    // Quoting is inconsistent across scrcpy versions/shells, so single, double and no quotes
    // around the encoder name are all accepted. NOT verified against a real device in this
    // change - see the report for what that means for testing.
    private static readonly ENCODER_LINE_RE = /--video-codec=(\S+)\s+--video-encoder=(?:'([^']*)'|"([^"]*)"|(\S+))/;

    private static async copyServer(device: ScrcpyTarget, signal?: AbortSignal): Promise<PushTransfer> {
        const src = path.join(FILE_DIR, FILE_NAME);
        const dst = TEMP_PATH + FILE_NAME; // don't use path.join(): will not work on win host
        signal?.throwIfAborted();
        const transfer = await device.push(src, dst, signal);
        if (signal?.aborted) {
            transfer.on('error', () => undefined);
            transfer.cancel?.();
            signal.throwIfAborted();
        }
        // adbkit resolves push() when the transfer starts. Launching before `end` races the
        // jar upload, producing ClassNotFoundException on slower USB/Wi-Fi connections.
        const abort = () => {
            transfer.on('error', () => undefined);
            transfer.cancel?.();
        };
        signal?.addEventListener('abort', abort, { once: true });
        try {
            await once(transfer, 'end', { signal });
        } finally {
            signal?.removeEventListener('abort', abort);
        }
        return transfer;
    }

    /**
     * The scrcpy processes on the phone that this server started: `app_process` running the
     * scrcpy package with this server's scid. Every other scrcpy is someone else's (desktop
     * scrcpy, or another ws-scrcpy) and is never counted, reported or stopped.
     *
     * @param strict bound each adb read and report a failed one, where the default treats it as
     *     "nothing found". Status polling uses it so a failed read is not shown as "stopped".
     */
    public static async getServerPid(
        device: ScrcpyTarget,
        strict = false,
        signal?: AbortSignal,
    ): Promise<number[] | undefined> {
        if (!device.isConnected()) {
            return;
        }
        const list = await device.getPidOf(SERVER_PROCESS_NAME, strict, signal);
        if (!Array.isArray(list) || !list.length) {
            return;
        }
        const serverPid: number[] = [];
        const promises = list.map((pid) => {
            return device
                .runShellCommandAdbKit(`cat /proc/${pid}/cmdline`, strict ? 6500 : undefined, signal)
                .then((output) => {
                    if (ScrcpyServer.isOwnServer(output.split('\0'))) {
                        serverPid.push(pid);
                    }
                });
        });
        await Promise.all(promises);
        return serverPid;
    }

    /** Whether a process command line is a mirroring server launched by this ws-scrcpy server. */
    public static isOwnServer(cmdline: string[]): boolean {
        if (cmdline[0] !== SERVER_PROCESS_NAME) {
            return false;
        }
        const args = cmdline.slice(cmdline.indexOf(SERVER_PACKAGE));
        if (args[0] !== SERVER_PACKAGE || args.length < 3) {
            return false;
        }
        if (args.some((arg) => /^list_[^=]+=true$/.test(arg))) {
            // Encoder/camera/display enumeration runs a short-lived helper JVM too.
            // Its PID does not prove that the mirroring service is available.
            return false;
        }
        return ScrcpyInstance.owns(args);
    }

    /**
     * The server's launch arguments: the stream settings, then what every launch from this
     * server carries. `scid` names the device socket and marks the process as ours.
     * `power_on=false` keeps a start from waking the phone's screen: scrcpy starts when someone
     * opens the screen in a browser, and the viewer has its own Wake button.
     */
    public static buildLaunchArgs(config: ScrcpyServerConfig): string {
        return `${buildScrcpyArgs(config)} scid=${ScrcpyInstance.getScid()} power_on=false`;
    }

    /**
     * Pushes the jar and launches the mirroring server. Resolves once its stream is connected
     * and rejects if the launch fails, the process exits first, or it takes too long
     * (`Device.launchServer`).
     */
    public static async run(device: ScrcpyTarget, signal?: AbortSignal): Promise<void> {
        if (!device.isConnected()) {
            return;
        }
        await this.copyServer(device, signal);
        signal?.throwIfAborted();
        if (!device.isConnected()) return;

        // Built per-udid, per-call: config may have just changed via Device.updateStreamConfig(),
        // and this is the only place that launches the mirroring server, so there is no separate
        // "reload config" step to keep in sync.
        const config = device.getLaunchStreamConfig();
        const runCommand = `${CLASSPATH_PREFIX} / ${SERVER_PACKAGE} ${this.buildLaunchArgs(config)}`;
        await device.launchServer(runCommand, config.audio);
    }

    /**
     * Runs the server jar in `list_encoders=true` mode, which prints the device's available
     * encoders and exits immediately rather than starting the mirroring loop, so it is safe to
     * run this alongside an already-running mirror server for the same device.
     */
    public static async listEncoders(device: ScrcpyTarget, signal?: AbortSignal): Promise<EncoderInfo[]> {
        if (!device.isConnected()) {
            return [];
        }
        await this.copyServer(device, signal);
        signal?.throwIfAborted();
        if (!device.isConnected()) return [];
        const command = `${CLASSPATH_PREFIX} / ${SERVER_PACKAGE} ${SERVER_VERSION} list_encoders=true`;
        let output: string;
        try {
            output = await device.runShellCommandAdbKit(command, undefined, signal);
        } catch (e: any) {
            console.error(device.TAG, `Failed to list encoders: ${e.message}`);
            return [];
        }
        return this.parseEncoderList(output);
    }

    public static parseEncoderList(output: string): EncoderInfo[] {
        const list: EncoderInfo[] = [];
        const seen = new Set<string>();
        output.split('\n').forEach((line) => {
            const match = ScrcpyServer.ENCODER_LINE_RE.exec(line);
            if (!match) {
                return;
            }
            const videoCodec = match[1];
            const encoderName = match[2] ?? match[3] ?? match[4] ?? '';
            if (!videoCodec || !encoderName) {
                return;
            }
            const key = `${videoCodec}:${encoderName}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            // Real output (verified on Android 16) looks like:
            //   --video-codec=h264 --video-encoder=c2.mtk.avc.encoder   (hw) [vendor]
            //   --video-codec=h264 --video-encoder=OMX.google.h264.encoder (sw) (alias for c2...)
            // The hw/sw marker is the whole reason to expose this dropdown, so keep it.
            let hardware: EncoderInfo['hardware'] = 'unknown';
            if (/\((hw)\)/.test(line)) {
                hardware = 'hw';
            } else if (/\((sw)\)/.test(line)) {
                hardware = 'sw';
            }
            const aliasMatch = line.match(/\(alias for ([^)]+)\)/);
            list.push({
                videoCodec,
                encoderName,
                hardware,
                ...(aliasMatch ? { aliasFor: aliasMatch[1].trim() } : {}),
            });
        });
        return list;
    }
}
