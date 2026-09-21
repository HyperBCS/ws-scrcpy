import '../../../vendor/Genymobile/scrcpy/scrcpy-server.jar';
import '../../../vendor/Genymobile/scrcpy/LICENSE';

import { Device } from './Device';
import { buildScrcpyArgs, SERVER_PACKAGE, SERVER_PROCESS_NAME, SERVER_VERSION } from '../../common/Constants';
import path from 'path';
import PushTransfer from '@dead50f7/adbkit/lib/adb/sync/pushtransfer';
import { ServerVersion } from './ServerVersion';
import { once } from 'events';

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

type WaitForPidParams = { tryCounter: number; processExited: boolean; lookPidFile: boolean };

export class ScrcpyServer {
    private static PID_FILE_PATH = '/data/local/tmp/ws_scrcpy.pid';
    // Matches the lines scrcpy-server prints for `list_encoders=true`, e.g.
    //     --video-codec=h264 --video-encoder='OMX.qcom.video.encoder.avc'
    // Quoting is inconsistent across scrcpy versions/shells, so single, double and no quotes
    // around the encoder name are all accepted. NOT verified against a real device in this
    // change - see the report for what that means for testing.
    private static readonly ENCODER_LINE_RE = /--video-codec=(\S+)\s+--video-encoder=(?:'([^']*)'|"([^"]*)"|(\S+))/;

    private static async copyServer(device: Device): Promise<PushTransfer> {
        const src = path.join(FILE_DIR, FILE_NAME);
        const dst = TEMP_PATH + FILE_NAME; // don't use path.join(): will not work on win host
        const transfer = await device.push(src, dst);
        // adbkit resolves push() when the transfer starts. Launching before `end` races the
        // jar upload, producing ClassNotFoundException on slower USB/Wi-Fi connections.
        await once(transfer, 'end');
        return transfer;
    }

    // Important to notice that we first try to read PID from file.
    // Checking with `.getServerPid()` will return process id, but process may stop.
    // PID file only created after WebSocket server has been successfully started.
    private static async waitForServerPid(device: Device, params: WaitForPidParams): Promise<number[] | undefined> {
        const { tryCounter, processExited, lookPidFile } = params;
        if (processExited) {
            return;
        }
        const timeout = 500 + 100 * tryCounter;
        if (lookPidFile) {
            const fileName = ScrcpyServer.PID_FILE_PATH;
            const content = await device.runShellCommandAdbKit(`test -f ${fileName} && cat ${fileName}`);
            if (content.trim()) {
                const pid = parseInt(content, 10);
                if (pid && !isNaN(pid)) {
                    const realPid = await this.getServerPid(device);
                    if (realPid?.includes(pid)) {
                        return realPid;
                    } else {
                        params.lookPidFile = false;
                    }
                }
            }
        } else {
            const list = await this.getServerPid(device);
            if (Array.isArray(list) && list.length) {
                return list;
            }
        }
        if (++params.tryCounter > 5) {
            throw new Error('Failed to start server');
        }
        return new Promise<number[] | undefined>((resolve) => {
            setTimeout(() => {
                resolve(this.waitForServerPid(device, params));
            }, timeout);
        });
    }

    public static async getServerPid(device: Device, cleanUpOldVersions = true): Promise<number[] | undefined> {
        if (!device.isConnected()) {
            return;
        }
        const list = await device.getPidOf(SERVER_PROCESS_NAME, !cleanUpOldVersions);
        if (!Array.isArray(list) || !list.length) {
            return;
        }
        const serverPid: number[] = [];
        const promises = list.map((pid) => {
            return device
                .runShellCommandAdbKit(`cat /proc/${pid}/cmdline`, cleanUpOldVersions ? undefined : 6500)
                .then((output) => {
                    const args = output.split('\0');
                    if (!args.length || args[0] !== SERVER_PROCESS_NAME) {
                        return;
                    }
                    let first = args[0];
                    while (args.length && first !== SERVER_PACKAGE) {
                        args.shift();
                        first = args[0];
                    }
                    if (args.length < 3) {
                        return;
                    }
                    if (args.some((arg) => /^list_[^=]+=true$/.test(arg))) {
                        // Encoder/camera/display enumeration runs a short-lived helper JVM too.
                        // Its PID does not prove that the mirroring service is available.
                        return;
                    }
                    const versionString = args[1];
                    if (versionString === SERVER_VERSION || !cleanUpOldVersions) {
                        serverPid.push(pid);
                    } else {
                        const currentVersion = new ServerVersion(versionString);
                        if (currentVersion.isCompatible()) {
                            const desired = new ServerVersion(SERVER_VERSION);
                            if (desired.gt(currentVersion)) {
                                console.log(
                                    device.TAG,
                                    `Found old server version running (PID: ${pid}, Version: ${versionString})`,
                                );
                                console.log(device.TAG, 'Perform kill now');
                                device.killProcess(pid);
                            }
                        }
                    }
                    return;
                });
        });
        await Promise.all(promises);
        return serverPid;
    }

    public static async run(device: Device): Promise<number[] | undefined> {
        if (!device.isConnected()) {
            return;
        }
        let list: number[] | string | undefined = await this.getServerPid(device);
        if (Array.isArray(list) && list.length) {
            return list;
        }
        await this.copyServer(device);

        // Built per-udid, per-call: config may have just changed via Device.updateStreamConfig(),
        // and this is the only place that launches the mirroring server, so there is no separate
        // "reload config" step to keep in sync.
        const config = device.getLaunchStreamConfig();
        const args = buildScrcpyArgs(config);
        const runCommand = `${CLASSPATH_PREFIX} / ${SERVER_PACKAGE} ${args}`;

        const params: WaitForPidParams = { tryCounter: 0, processExited: false, lookPidFile: true };
        const runPromise = device.runShellCommandAdbSpecial(runCommand, device.udid, config.audio);
        runPromise
            .then((out) => {
                if (device.isConnected()) {
                    console.log(device.TAG, 'Server exited:', out);
                }
            })
            .catch((e) => {
                console.log(device.TAG, 'Error:', e.message);
            })
            .finally(() => {
                params.processExited = true;
            });
        list = await Promise.race([runPromise, this.waitForServerPid(device, params)]);
        console.log('return done');
        if (Array.isArray(list) && list.length) {
            return list;
        }
        return;
    }

    /**
     * Runs the server jar in `list_encoders=true` mode, which prints the device's available
     * encoders and exits immediately rather than starting the mirroring loop, so it is safe to
     * run this alongside an already-running mirror server for the same device.
     */
    public static async listEncoders(device: Device): Promise<EncoderInfo[]> {
        if (!device.isConnected()) {
            return [];
        }
        await this.copyServer(device);
        const command = `${CLASSPATH_PREFIX} / ${SERVER_PACKAGE} ${SERVER_VERSION} list_encoders=true`;
        let output: string;
        try {
            output = await device.runShellCommandAdbKit(command);
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
