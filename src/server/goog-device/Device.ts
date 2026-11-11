import { AdbExtended } from './adb';
import AdbKitClient from '@dead50f7/adbkit/lib/adb/client';
import { AdbUtils } from './AdbUtils';
import PushTransfer from '@dead50f7/adbkit/lib/adb/sync/pushtransfer';
import { ChildProcess, spawn } from 'child_process';
import { NetInterface } from '../../types/NetInterface';
import { TypedEmitter } from '../../common/TypedEmitter';
import { broadcastManager } from '../../common/BroadcastManager';
import { Broadcast } from '../../common/Broadcast';
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, AudioMetadata } from '../../common/AudioProtocol';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { EncoderInfo, ScrcpyServer } from './ScrcpyServer';
import { ScrcpyInstance } from './ScrcpyInstance';
import { STREAM_SERVICE_STOPPED } from '../../common/StreamCloseCode';
import { StreamConfigData, streamConfig } from './StreamConfig';
import { Properties } from './Properties';
import { LOCK_STATE_COMMAND, parseLockState, unknownLockState } from './LockState';
import { AndroidLockState } from '../../types/AndroidLockState';
import { Duplex } from 'stream';
import Timeout = NodeJS.Timeout;

enum PID_DETECTION {
    UNKNOWN,
    PIDOF,
    GREP_PS,
    GREP_PS_A,
    LS_PROC,
}

export interface DeviceEvents {
    update: Device;
}

/** A browser that has this device's screen open. */
export interface StreamViewer {
    close(code: number, reason: string): void;
}

/** One run of the scrcpy server, from the adb child that started it. */
interface ServerLaunch {
    child: ChildProcess;
    /** Set once the launch has either connected its stream or failed. */
    done: boolean;
    broadcast?: Broadcast;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Device extends TypedEmitter<DeviceEvents> {
    private static readonly INITIAL_UPDATE_TIMEOUT = 1500;
    private static readonly MAX_UPDATES_COUNT = 7;
    // Long-lived poll for sleep/battery state, independent of the fetchDeviceInfo
    // backoff above (that one stops after MAX_UPDATES_COUNT attempts).
    private static readonly RUNTIME_STATE_ACTIVE_INTERVAL = 10000;
    private static readonly RUNTIME_STATE_IDLE_INTERVAL = 60000;
    private static readonly LOCK_STATE_ACTIVE_INTERVAL = 2000;
    private static readonly LOCK_STATE_IDLE_INTERVAL = 60000;
    // scrcpy runs while a browser has the screen open. It keeps running this long after the
    // last one left, so a reload or a trip to the device list and back does not restart it.
    private static readonly STREAM_IDLE_GRACE_MS = 30000;
    // The one limit on a launch, from spawning adb to the first bytes of the stream.
    private static readonly SERVER_START_TIMEOUT_MS = 15000;
    // scrcpy prints its first line shortly before it starts to listen for the stream sockets.
    private static readonly STREAM_CONNECT_DELAY_MS = 1000;
    private static readonly STREAM_RETRY_DELAY_MS = 500;
    // How long the screen is given to come on before its state is read again after a wake.
    private static readonly WAKE_SETTLE_MS = 500;
    // Verified against a real device (Xiaomi, Android 16). Notes on each part:
    //  - `Display Power: state=` is NOT emitted by `dumpsys power` on Android 16, so
    //    `dumpsys display`'s `mScreenState=` is the primary screen-state source; the older
    //    field is still parsed as a fallback for devices that do emit it.
    //  - the battery `level:` grep is anchored to the start of the line, because
    //    `dumpsys battery` also prints `Capacity level: 5`, which an unanchored pattern matches.
    //  - no `grep -m1`/`head`: closing the pipe early makes dumpsys log
    //    "Failed to write while dumping service" to stderr, which ends up in the output.
    private static readonly RUNTIME_STATE_COMMAND =
        "dumpsys power | grep -E 'mWakefulness=|Display Power: state=' ; " +
        "dumpsys display | grep 'mScreenState=' ; " +
        "dumpsys battery | grep -E '^ +level:|powered'";
    private connected = true;
    private released = false;
    private pidDetectionVariant: PID_DETECTION = PID_DETECTION.UNKNOWN;
    private client: AdbKitClient;
    private properties?: Record<string, string>;
    private viewers: Set<StreamViewer> = new Set();
    private idleStopTimeoutId?: Timeout;
    private launch?: ServerLaunch;
    private updateTimeoutId?: Timeout;
    private updateTimeout = Device.INITIAL_UPDATE_TIMEOUT;
    private updateCount = 0;
    private throttleTimeoutId?: Timeout;
    private lastEmit = 0;
    private runtimeStateTimeoutId?: Timeout;
    private runtimeStatePollActive = false;
    private lockStateTimeoutId?: Timeout;
    private lockStatePollInFlight = false;
    private connectionGeneration = 0;
    private lockReadSequence = 0;
    private lastAppliedLockRead = 0;
    private encoders: EncoderInfo[] = [];
    private encodersPromise?: Promise<EncoderInfo[]>;
    // Starts, stops, and config restarts share one queue: a reconnect must not launch a second
    // server while another viewer's Apply is still stopping the old one.
    private restartChain: Promise<void> = Promise.resolve();
    private audioFailure?: AudioMetadata;
    private audioLaunchGeneration = 0;
    private servicePidRevision = 0;
    public readonly TAG: string;
    public readonly descriptor: GoogDeviceDescriptor;

    constructor(
        public readonly udid: string,
        state: string,
    ) {
        super();
        this.TAG = `[${udid}]`;
        this.descriptor = {
            udid,
            state,
            interfaces: [],
            pid: 0,
            'wifi.interface': '',
            'ro.build.version.release': '',
            'ro.build.version.sdk': '',
            'ro.product.manufacturer': '',
            'ro.product.model': '',
            'ro.product.cpu.abi': '',
            'last.update.timestamp': 0,
            ...unknownLockState(),
            'device.awake': true,
            'battery.level': -1,
            'battery.charging': false,
        };
        this.client = AdbExtended.createClient();
        this.setState(state);
    }

    public setState(state: string): void {
        if (this.released) {
            return;
        }
        this.connectionGeneration++;
        this.lockStatePollInFlight = false;
        this.stopLockStateUpdates();
        Object.assign(this.descriptor, unknownLockState());
        this.setServerPid(0);
        if (state === 'device') {
            this.connected = true;
            this.properties = undefined;
        } else {
            this.connected = false;
        }
        this.descriptor.state = state;
        this.emitUpdate();
        this.fetchDeviceInfo();
        if (this.connected) {
            this.scheduleRuntimeStateUpdate(true);
            this.scheduleLockStateUpdate(true);
        } else {
            this.stopRuntimeStateUpdates();
        }
    }

    /**
     * Switches the runtime-state poll between its active and idle cadence. Driven by
     * ControlCenter from the number of browsers with a device list open: nobody is looking
     * at the badge when no tracker client is connected, so the slow interval is enough.
     */
    public setRuntimeStatePollActive(active: boolean): void {
        if (this.runtimeStatePollActive === active) {
            return;
        }
        this.runtimeStatePollActive = active;
        // Re-arm now: the pending timer was scheduled against the previous interval, so
        // going active would otherwise not take effect for up to a full idle period.
        this.stopRuntimeStateUpdates();
        this.scheduleRuntimeStateUpdate(active);
        this.stopLockStateUpdates();
        this.scheduleLockStateUpdate(active);
    }

    public isConnected(): boolean {
        return this.connected;
    }

    /**
     * The tracker service is shutting down: stop polling and let go of the stream. No device
     * input is sent. The adb child and the stream sockets would otherwise keep Node running
     * until Docker kills it; scrcpy on the phone exits when they close.
     */
    public release(): void {
        this.released = true;
        this.connected = false;
        this.connectionGeneration++;
        this.lockStatePollInFlight = false;
        this.stopRuntimeStateUpdates();
        this.stopLockStateUpdates();
        this.clearIdleStop();
        this.viewers.clear();
        broadcastManager.stopBroadcast(this.udid);
        this.launch?.child.kill('SIGTERM');
        if (this.updateTimeoutId) {
            clearTimeout(this.updateTimeoutId);
            this.updateTimeoutId = undefined;
        }
        if (this.throttleTimeoutId) {
            clearTimeout(this.throttleTimeoutId);
            this.throttleTimeoutId = undefined;
        }
        Object.assign(this.descriptor, unknownLockState());
    }

    public async getPidOf(processName: string, strict = false): Promise<number[] | undefined> {
        if (!this.connected) {
            return;
        }
        if (this.pidDetectionVariant === PID_DETECTION.UNKNOWN) {
            this.pidDetectionVariant = await this.findDetectionVariant(strict);
        }
        switch (this.pidDetectionVariant) {
            case PID_DETECTION.PIDOF:
                return this.pidOf(processName, strict);
            case PID_DETECTION.GREP_PS:
                return this.grepPs(processName, strict);
            case PID_DETECTION.GREP_PS_A:
                return this.grepPs_A(processName, strict);
            default:
                return this.listProc(processName, strict);
        }
    }

    /**
     * Wakes the screen with the wake key, sent through adb. It needs no scrcpy server, so the
     * device card can offer it while nobody has the screen open.
     */
    public async wake(): Promise<void> {
        if (!this.connected) {
            throw new Error('The device is not connected.');
        }
        // 224 is KEYCODE_WAKEUP: it turns the screen on and does nothing when it is on already.
        const { code, output } = await AdbUtils.shellExec(this.udid, 'input keyevent 224', 6500);
        if (code !== 0) {
            throw new Error(output || 'The device did not accept the wake key.');
        }
        // Show the result on the card without waiting for the next poll.
        void sleep(Device.WAKE_SETTLE_MS).then(() => {
            if (this.connected) {
                this.stopRuntimeStateUpdates();
                this.fetchRuntimeState();
            }
        });
    }

    public killProcess(pid: number): Promise<string> {
        const command = `kill ${pid}`;
        return this.runShellCommandAdbKit(command);
    }

    public async runShellCommandAdb(command: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const cmd = 'adb';
            const args = ['-s', `${this.udid}`, 'shell', command];
            const adb = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '';

            adb.stdout.on('data', (data) => {
                output += data.toString();
                console.log(this.TAG, `stdout: ${data.toString().replace(/\n$/, '')}`);
            });

            adb.stderr.on('data', (data) => {
                console.error(this.TAG, `stderr: ${data}`);
            });

            adb.on('error', (error: Error) => {
                console.error(this.TAG, `failed to spawn adb process.\n${error.stack}`);
                reject(error);
            });

            adb.on('close', (code) => {
                console.log(this.TAG, `adb process (${args.join(' ')}) exited with code ${code}`);
                resolve(output);
            });
        });
    }

    /**
     * Starts the scrcpy server through `adb shell` and connects its stream. The adb child stays
     * for as long as the server runs.
     *
     * Resolves once the stream has delivered its header. Rejects when adb cannot be spawned, the
     * server exits first, or the whole start takes longer than `SERVER_START_TIMEOUT_MS`; a
     * failed launch leaves no process or stream behind. Callers run on the server operation
     * queue, so nothing else starts or stops a server while one is still coming up.
     */
    public launchServer(command: string, audioEnabled: boolean): Promise<void> {
        const udid = this.udid;
        const launchGeneration = ++this.audioLaunchGeneration;
        const connectionGeneration = this.connectionGeneration;
        this.servicePidRevision++;
        this.setServerPid(0);
        const reportAudioFailure = (metadata: AudioMetadata) => {
            if (launchGeneration === this.audioLaunchGeneration) {
                this.audioFailure = metadata;
            }
        };
        return new Promise<void>((resolve, reject) => {
            const cmd = 'adb';
            const args = ['-s', udid, 'shell', command];
            const adb = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const launch: ServerLaunch = { child: adb, done: false };
            let exited = false;
            let lastOutput = '';
            let audioLogTail = '';
            const timer = setTimeout(() => {
                console.error(this.TAG, 'The stream service did not start in time');
                finish(new Error('The stream service did not start in time.'));
            }, Device.SERVER_START_TIMEOUT_MS);
            const checkAudioError = (data: Buffer) => {
                if (!audioEnabled) {
                    return;
                }
                audioLogTail = (audioLogTail + data.toString()).slice(-4096);
                // A device-side fatal audio error can close video before Broadcast sees the
                // disable header. These are scrcpy's own audio-specific startup errors.
                if (
                    /Audio (?:recording|encoding|capture) error|Audio disabled|Failed to (?:initialize audio|start audio capture)|Could not create (?:default )?audio encoder/i.test(
                        audioLogTail,
                    )
                ) {
                    reportAudioFailure({
                        status: 'error',
                        sampleRate: AUDIO_SAMPLE_RATE,
                        channels: AUDIO_CHANNELS,
                        message:
                            'The device rejected audio capture. Video remains available. Choose another audio source or format and apply to retry.',
                    });
                }
            };

            const stopOwnBroadcast = () => {
                const broadcast = launch.broadcast;
                launch.broadcast = undefined;
                if (broadcast) {
                    broadcastManager.stopBroadcast(udid, broadcast);
                }
            };

            // Settles the launch once: ready without an error, failed with one.
            const finish = (error?: Error) => {
                if (launch.done) {
                    return;
                }
                launch.done = true;
                clearTimeout(timer);
                if (!error) {
                    resolve();
                    return;
                }
                stopOwnBroadcast();
                if (!exited) {
                    // The adb client. scrcpy on the phone ends when its shell goes away.
                    adb.kill('SIGTERM');
                }
                reject(error);
            };

            adb.on('error', (error: Error) => {
                console.error(this.TAG, `failed to spawn adb process.\n${error.stack}`);
                exited = true;
                finish(error);
            });

            if (typeof adb.pid !== 'number') {
                const msg = `[${udid}] Failed to spawn adb process: ${cmd} ${args.join(' ')}`;
                console.error(msg);
                exited = true;
                finish(new Error(msg));
                return;
            }

            this.launch = launch;

            adb.stdout.once('data', () => {
                this.connectStream(launch, audioEnabled, reportAudioFailure).then(
                    () => finish(),
                    (error: Error) => {
                        console.error(`[${udid}] Failed to start service: ${error.message}`);
                        finish(error);
                    },
                );
            });

            adb.stdout.on('data', (data) => {
                checkAudioError(data);
                lastOutput = data.toString().trim() || lastOutput;
                console.log(this.TAG, `stdout: ${data.toString().replace(/\n$/, '')}`);
            });

            adb.stderr.on('data', (data) => {
                checkAudioError(data);
                lastOutput = data.toString().trim() || lastOutput;
                console.error(this.TAG, `stderr: ${data}`);
            });

            adb.on('close', (code) => {
                exited = true;
                console.log(this.TAG, `adb process (${args.join(' ')}) exited with code ${code}`);
                if (this.launch === launch) {
                    this.launch = undefined;
                }
                // A slow close from the old adb process must not stop its replacement.
                stopOwnBroadcast();
                const detail = lastOutput.split('\n').pop();
                finish(new Error(`The stream service exited before it was ready${detail ? `: ${detail}` : '.'}`));
                if (
                    this.connected &&
                    connectionGeneration === this.connectionGeneration &&
                    launchGeneration === this.audioLaunchGeneration
                ) {
                    this.setServerPid(0);
                    void this.refreshServicePid();
                }
            });
        });
    }

    /**
     * Connects the stream sockets of a launch and waits for the stream header.
     *
     * scrcpy prints before it listens. A connection made too early is accepted by adb and closed
     * again, so the attempt is repeated until the header arrives or the launch is over.
     */
    private async connectStream(
        launch: ServerLaunch,
        audioEnabled: boolean,
        onAudioFailure: (metadata: AudioMetadata) => void,
    ): Promise<void> {
        const udid = this.udid;
        // The adb daemon may run outside this container. TCP reaches its forward
        // through the shared network; a filesystem socket lives in the daemon's /tmp.
        const port = await AdbUtils.forward(udid, ScrcpyInstance.socketName());
        console.log(`[${udid}] Starting broadcast on 127.0.0.1:${port}`);
        let delay = Device.STREAM_CONNECT_DELAY_MS;
        while (!launch.done) {
            await sleep(delay);
            if (launch.done) {
                return;
            }
            // Use the launch-time audio setting: an Apply may already have changed the stored
            // config while this process is still connecting.
            await broadcastManager.startBroadcast(udid, port, audioEnabled, {
                onFailure: onAudioFailure,
                failure: audioEnabled ? undefined : this.audioFailure,
            });
            const broadcast = broadcastManager.getBroadcast(udid);
            if (launch.done) {
                if (broadcast) {
                    broadcastManager.stopBroadcast(udid, broadcast);
                }
                return;
            }
            launch.broadcast = broadcast;
            if (broadcast && (await broadcast.whenReady())) {
                return;
            }
            launch.broadcast = undefined;
            if (broadcast) {
                broadcastManager.stopBroadcast(udid, broadcast);
            }
            delay = Device.STREAM_RETRY_DELAY_MS;
        }
    }

    public async runShellCommandAdbKit(command: string, timeoutMs?: number): Promise<string> {
        let socket: Duplex | undefined;
        let expired = false;
        let timer: Timeout | undefined;
        const reading = this.client
            .shell(this.udid, command)
            .then((stream) => {
                socket = stream;
                if (expired) {
                    stream.destroy();
                    throw new Error('Device diagnostic timed out');
                }
                return AdbExtended.util.readAll(stream);
            })
            .then((output: Buffer) => output.toString().trim());
        if (!timeoutMs) {
            return reading;
        }
        try {
            return await Promise.race([
                reading,
                new Promise<string>((_resolve, reject) => {
                    timer = setTimeout(() => {
                        expired = true;
                        socket?.destroy();
                        reject(new Error('Device diagnostic timed out'));
                    }, timeoutMs);
                }),
            ]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    public async push(contents: string, path: string): Promise<PushTransfer> {
        return this.client.push(this.udid, contents, path);
    }

    public async getProperties(): Promise<Record<string, string> | undefined> {
        if (this.properties) {
            return this.properties;
        }
        if (!this.connected) {
            return;
        }
        this.properties = await this.client.getProperties(this.udid);
        return this.properties;
    }

    private interfacesSort = (a: NetInterface, b: NetInterface): number => {
        if (a.name > b.name) {
            return 1;
        }
        if (a.name < b.name) {
            return -1;
        }
        return 0;
    };

    public async getNetInterfaces(): Promise<NetInterface[]> {
        if (!this.connected) {
            return [];
        }
        const list: NetInterface[] = [];
        const output = await this.runShellCommandAdbKit(`ip -4 -f inet -o a | grep 'scope global'`);
        const lines = output.split('\n').filter((i: string) => !!i);
        lines.forEach((value: string) => {
            const temp = value.split(' ').filter((i: string) => !!i);
            const name = temp[1];
            const ipAndMask = temp[3];
            const ipv4 = ipAndMask.split('/')[0];
            list.push({ name, ipv4 });
        });
        return list.sort(this.interfacesSort);
    }

    private async pidOf(processName: string, strict = false): Promise<number[]> {
        return this.runShellCommandAdbKit(`pidof ${processName}`, strict ? 6500 : undefined)
            .then((output) => {
                return output
                    .split(' ')
                    .map((pid) => parseInt(pid, 10))
                    .filter((num) => !isNaN(num));
            })
            .catch((error) => {
                if (strict) {
                    throw error;
                }
                return [];
            });
    }

    private filterPsOutput(processName: string, output: string): number[] {
        const list: number[] = [];
        const processes = output.split('\n');
        processes.map((line) => {
            const cols = line
                .trim()
                .split(' ')
                .filter((item) => item.length);
            if (cols[cols.length - 1] === processName) {
                const pid = parseInt(cols[1], 10);
                if (!isNaN(pid)) {
                    list.push(pid);
                }
            }
        });
        return list;
    }

    private async grepPs_A(processName: string, strict = false): Promise<number[]> {
        return this.runShellCommandAdbKit(`ps -A | grep ${processName}`, strict ? 6500 : undefined)
            .then((output) => {
                return this.filterPsOutput(processName, output);
            })
            .catch((error) => {
                if (strict) {
                    throw error;
                }
                return [];
            });
    }

    private async grepPs(processName: string, strict = false): Promise<number[]> {
        return this.runShellCommandAdbKit(`ps | grep ${processName}`, strict ? 6500 : undefined)
            .then((output) => {
                return this.filterPsOutput(processName, output);
            })
            .catch((error) => {
                if (strict) {
                    throw error;
                }
                return [];
            });
    }

    private async listProc(processName: string, strict = false): Promise<number[]> {
        const find = `find /proc -maxdepth 2 -name cmdline  2>/dev/null`;
        const lines = await this.runShellCommandAdbKit(
            `for L in \`${find}\`; do grep -sae '^${processName}' $L 2>&1 >/dev/null && echo $L; done`,
            strict ? 6500 : undefined,
        );
        const re = /\/proc\/([0-9]+)\/cmdline/;
        const list: number[] = [];
        lines.split('\n').map((line) => {
            const trim = line.trim();
            const m = trim.match(re);
            if (m) {
                list.push(parseInt(m[1], 10));
            }
        });
        return list;
    }

    private async executedWithoutError(command: string, strict = false): Promise<boolean> {
        return this.runShellCommandAdbKit(command, strict ? 6500 : undefined)
            .then((output) => {
                const err = parseInt(output, 10);
                return err === 0;
            })
            .catch((error) => {
                if (strict) {
                    throw error;
                }
                return false;
            });
    }

    private async hasPs(strict = false): Promise<boolean> {
        return this.executedWithoutError('ps | grep init 2>&1 >/dev/null; echo $?', strict);
    }

    private async hasPs_A(strict = false): Promise<boolean> {
        return this.executedWithoutError('ps -A | grep init 2>&1 >/dev/null; echo $?', strict);
    }

    private async hasPidOf(strict = false): Promise<boolean> {
        const ok = await this.executedWithoutError('which pidof 2>&1 >/dev/null && echo $?', strict);
        if (!ok) {
            return false;
        }
        return this.runShellCommandAdbKit('echo $PPID; pidof init', strict ? 6500 : undefined)
            .then((output) => {
                const pids = output.split('\n').filter((a) => a.length);
                if (pids.length < 2) {
                    return false;
                }
                const parentPid = pids[0].replace('\r', '');
                const list = pids[1].split(' ');
                if (list.includes(parentPid)) {
                    return false;
                }
                return list.includes('1');
            })
            .catch((error) => {
                if (strict) {
                    throw error;
                }
                return false;
            });
    }

    private async findDetectionVariant(strict = false): Promise<PID_DETECTION> {
        if (await this.hasPidOf(strict)) {
            return PID_DETECTION.PIDOF;
        }
        if (await this.hasPs_A(strict)) {
            return PID_DETECTION.GREP_PS_A;
        }
        if (await this.hasPs(strict)) {
            return PID_DETECTION.GREP_PS;
        }
        return PID_DETECTION.LS_PROC;
    }

    private scheduleInfoUpdate(): void {
        if (this.released || this.updateTimeoutId) {
            return;
        }
        if (++this.updateCount > Device.MAX_UPDATES_COUNT) {
            console.error(this.TAG, 'The maximum number of attempts to fetch device info has been reached.');
            return;
        }
        this.updateTimeoutId = setTimeout(this.fetchDeviceInfo, this.updateTimeout);
        this.updateTimeout *= 2;
    }

    private fetchDeviceInfo = (): void => {
        if (this.released) {
            return;
        }
        if (this.connected) {
            const propsPromise = this.getProperties().then((props) => {
                if (!props) {
                    return false;
                }
                let changed = false;
                Properties.forEach((propName: keyof GoogDeviceDescriptor) => {
                    if (props[propName] !== this.descriptor[propName]) {
                        changed = true;
                        (this.descriptor[propName] as any) = props[propName];
                    }
                });
                if (changed) {
                    this.emitUpdate();
                }
                return true;
            });
            const netIntPromise = this.updateInterfaces().then((interfaces) => {
                return !!interfaces.length;
            });
            // Only a status read. scrcpy starts when the first viewer opens the screen, not when
            // the phone is attached: a running server takes over the phone's media audio.
            const serverPromise = this.refreshServicePid().then(() => true);
            Promise.all([propsPromise, netIntPromise, serverPromise])
                .then((results) => {
                    this.updateTimeoutId = undefined;
                    const failedCount = results.filter((result) => !result).length;
                    if (!failedCount) {
                        this.updateCount = 0;
                        this.updateTimeout = Device.INITIAL_UPDATE_TIMEOUT;
                    } else {
                        this.scheduleInfoUpdate();
                    }
                })
                .catch(() => {
                    this.updateTimeoutId = undefined;
                    this.scheduleInfoUpdate();
                });
        } else {
            this.updateCount = 0;
            this.updateTimeout = Device.INITIAL_UPDATE_TIMEOUT;
            this.updateTimeoutId = undefined;
            this.emitUpdate();
        }
        return;
    };

    /**
     * @param immediate fetch now instead of after a full interval. Without this a freshly
     *     connected device - or a list a user just opened - reports 'unknown' screen state and
     *     no battery until the first tick fires, which is up to a minute on the idle cadence.
     */
    private scheduleRuntimeStateUpdate(immediate = false): void {
        if (!this.connected || this.runtimeStateTimeoutId) {
            return;
        }
        if (immediate) {
            this.fetchRuntimeState();
            return;
        }
        const timeout = this.runtimeStatePollActive
            ? Device.RUNTIME_STATE_ACTIVE_INTERVAL
            : Device.RUNTIME_STATE_IDLE_INTERVAL;
        this.runtimeStateTimeoutId = setTimeout(this.fetchRuntimeState, timeout);
    }

    private stopRuntimeStateUpdates(): void {
        if (this.runtimeStateTimeoutId) {
            clearTimeout(this.runtimeStateTimeoutId);
            this.runtimeStateTimeoutId = undefined;
        }
    }

    private fetchRuntimeState = (): void => {
        this.runtimeStateTimeoutId = undefined;
        if (!this.connected) {
            return;
        }
        const generation = this.connectionGeneration;
        const runtimeState = this.runShellCommandAdbKit(Device.RUNTIME_STATE_COMMAND, 6500)
            .then((output) => {
                if (this.connected && generation === this.connectionGeneration) {
                    this.applyRuntimeState(output);
                }
            })
            .catch((error: Error) => {
                console.error(this.TAG, `Failed to fetch runtime state: ${error.message}`);
            });
        Promise.all([runtimeState, this.refreshServicePid()]).finally(() => {
            if (generation === this.connectionGeneration) {
                this.scheduleRuntimeStateUpdate();
            }
        });
    };

    private scheduleLockStateUpdate(immediate = false): void {
        if (!this.connected || this.lockStateTimeoutId || this.lockStatePollInFlight) {
            return;
        }
        if (immediate) {
            this.fetchLockState();
            return;
        }
        this.lockStateTimeoutId = setTimeout(
            this.fetchLockState,
            this.runtimeStatePollActive ? Device.LOCK_STATE_ACTIVE_INTERVAL : Device.LOCK_STATE_IDLE_INTERVAL,
        );
    }

    private stopLockStateUpdates(): void {
        if (this.lockStateTimeoutId) {
            clearTimeout(this.lockStateTimeoutId);
            this.lockStateTimeoutId = undefined;
        }
    }

    private fetchLockState = (): void => {
        this.lockStateTimeoutId = undefined;
        if (!this.connected || this.lockStatePollInFlight) {
            return;
        }
        const generation = this.connectionGeneration;
        this.lockStatePollInFlight = true;
        this.refreshLockState().finally(() => {
            if (generation === this.connectionGeneration) {
                this.lockStatePollInFlight = false;
                this.scheduleLockStateUpdate();
            }
        });
    };

    /** Always query now: pre-submit checks must never reuse a success from the periodic poll. */
    public async refreshLockState(): Promise<AndroidLockState> {
        if (!this.connected) {
            return unknownLockState();
        }
        const generation = this.connectionGeneration;
        const read = ++this.lockReadSequence;
        let state = unknownLockState();
        try {
            state = parseLockState(await this.runShellCommandAdbKit(LOCK_STATE_COMMAND, 6500));
        } catch {
            // A failed/unsupported diagnostic must remove stale lock claims, not authorize input.
        }
        if (!this.connected || generation !== this.connectionGeneration || read < this.lastAppliedLockRead) {
            return unknownLockState();
        }
        this.lastAppliedLockRead = read;
        let changed = false;
        for (const key of Object.keys(state) as Array<keyof AndroidLockState>) {
            if (this.descriptor[key] !== state[key]) {
                // Boolean fields and screen.power have separate unions; assign as a whole below.
                changed = true;
            }
        }
        Object.assign(this.descriptor, state);
        if (changed) {
            this.emitUpdate();
        }
        return state;
    }

    private applyRuntimeState(output: string): void {
        // `mScreenState` first (present on modern Android), then the legacy `Display Power:
        // state=` for older builds. Both use the same ON/OFF vocabulary.
        const displayPowerMatch = output.match(/mScreenState=(\w+)/) || output.match(/Display Power: state=(\w+)/);
        let screenPower: GoogDeviceDescriptor['screen.power'] = 'unknown';
        if (displayPowerMatch) {
            const state = displayPowerMatch[1].toUpperCase();
            if (state === 'ON') {
                screenPower = 'on';
            } else if (state === 'OFF') {
                screenPower = 'off';
            }
        }

        // `mWakefulness` is missing on some OEM builds. Defaulting to `false` there would pin
        // every such device to "asleep" forever, so only report not-awake on positive evidence:
        // the wakefulness field itself, or failing that the display power state.
        const wakefulnessMatch = output.match(/mWakefulness=(\w+)/);
        let awake = true;
        if (wakefulnessMatch) {
            awake = wakefulnessMatch[1] === 'Awake';
        } else if (screenPower !== 'unknown') {
            awake = screenPower === 'on';
        }

        // Anchored: `dumpsys battery` also emits `Capacity level: 5`, which an unanchored
        // `level:` would match if it ever preceded the real one.
        const levelMatch = output.match(/^\s*level:\s*(\d+)/m);
        const batteryLevel = levelMatch ? parseInt(levelMatch[1], 10) : -1;
        const batteryCharging = /powered:\s*true/i.test(output);

        let changed = false;
        if (this.descriptor['device.awake'] !== awake) {
            this.descriptor['device.awake'] = awake;
            changed = true;
        }
        if (this.descriptor['screen.power'] !== screenPower) {
            this.descriptor['screen.power'] = screenPower;
            changed = true;
        }
        if (this.descriptor['battery.level'] !== batteryLevel) {
            this.descriptor['battery.level'] = batteryLevel;
            changed = true;
        }
        if (this.descriptor['battery.charging'] !== batteryCharging) {
            this.descriptor['battery.charging'] = batteryCharging;
            changed = true;
        }
        if (changed) {
            this.emitUpdate();
        }
    }

    private emitUpdate(setUpdateTime = true): void {
        if (this.released) {
            return;
        }
        const THROTTLE = 300;
        const now = Date.now();
        const time = now - this.lastEmit;
        if (setUpdateTime) {
            this.descriptor['last.update.timestamp'] = now;
        }
        if (time > THROTTLE) {
            this.lastEmit = now;
            this.emit('update', this);
            return;
        }
        if (!this.throttleTimeoutId) {
            this.throttleTimeoutId = setTimeout(() => {
                delete this.throttleTimeoutId;
                this.emitUpdate(false);
            }, THROTTLE - time);
        }
    }

    private async getServerPid(): Promise<undefined | number> {
        const generation = this.connectionGeneration;
        const pids = await ScrcpyServer.getServerPid(this);
        if (!this.connected || generation !== this.connectionGeneration) {
            return;
        }
        const pid = pids?.find((value) => Number.isInteger(value) && value > 0) ?? -1;
        this.setServerPid(pid);
        if (pid > 0) {
            return pid;
        } else {
            return;
        }
    }

    private setServerPid(pid: number): void {
        if (this.descriptor.pid !== pid) {
            this.descriptor.pid = pid;
            this.servicePidRevision++;
            this.emitUpdate();
        }
    }

    /** Read-only periodic status of this server's own scrcpy process. Starts and stops nothing. */
    private async refreshServicePid(): Promise<void> {
        if (!this.connected) {
            return;
        }
        const generation = this.connectionGeneration;
        const revision = this.servicePidRevision;
        let pid = 0;
        try {
            const pids = await ScrcpyServer.getServerPid(this, true);
            pid = pids?.find((value) => Number.isInteger(value) && value > 0) ?? -1;
        } catch {
            // A diagnostic failure is unknown, not proof the service stopped.
        }
        if (this.connected && generation === this.connectionGeneration && revision === this.servicePidRevision) {
            this.setServerPid(pid);
        }
    }

    public async updateInterfaces(): Promise<NetInterface[]> {
        return this.getNetInterfaces().then((interfaces) => {
            let changed = false;
            const old = this.descriptor.interfaces;
            if (old.length !== interfaces.length) {
                changed = true;
            } else {
                old.forEach((value, idx) => {
                    if (value.name !== interfaces[idx].name || value.ipv4 !== interfaces[idx].ipv4) {
                        changed = true;
                    }
                });
            }
            if (changed) {
                this.descriptor.interfaces = interfaces;
                this.emitUpdate();
            }
            return this.descriptor.interfaces;
        });
    }

    /**
     * The owner's Stop. Viewers are closed first, with the code that tells them not to
     * reconnect: a reconnecting viewer would start the service again at once.
     */
    public async killServer(pid: number): Promise<void> {
        return this.queueServerOperation(async () => {
            this.viewers.forEach((viewer) => viewer.close(STREAM_SERVICE_STOPPED, 'Stream service stopped'));
            await this.killServerNow(pid);
        });
    }

    /** Stops this server's scrcpy process, if any, and its stream. */
    private async killServerNow(pid?: number): Promise<void> {
        // Closing audio is expected during an intentional restart, not a capture failure.
        // Late events from that old process must not disable the replacement's audio.
        this.audioLaunchGeneration++;
        this.clearIdleStop();
        const launch = this.launch;
        try {
            const realPid = await this.getServerPid();
            if (typeof realPid !== 'number') {
                return;
            }
            if (pid && realPid !== pid) {
                console.error(this.TAG, `Requested to kill server with PID ${pid}. Real server PID is ${realPid}.`);
            }
            const output = await this.killProcess(realPid);
            if (output) {
                console.log(this.TAG, `kill server: "${output}"`);
            }
            // Cleanup is best-effort: the device may already be gone, or the forward
            // already removed. An unhandled rejection here would kill the process.
            await AdbUtils.removeFileSocketForwards(this.udid).catch((e: Error) => {
                console.error(this.TAG, `Failed to remove file socket forwards: ${e.message}`);
            });
            this.setServerPid(-1);
        } catch (error: any) {
            console.error(this.TAG, `Error: ${error.message}`);
            throw error;
        } finally {
            // The old Broadcast tears itself down only once its sockets close. Remove it now,
            // or the next start would find it still registered and attach viewers to nothing.
            broadcastManager.stopBroadcast(this.udid);
            // The adb client of that run. It has normally exited with the process by now.
            launch?.child.kill('SIGTERM');
        }
    }

    /** The card's Start. A server nobody opens is stopped again after the idle grace period. */
    public async startServer(): Promise<number | undefined> {
        return this.queueServerOperation(() => this.startServerNow());
    }

    /**
     * Registers a browser that has the screen open. scrcpy runs while there is at least one;
     * the returned function removes it again.
     */
    public addViewer(viewer: StreamViewer): () => void {
        this.viewers.add(viewer);
        this.clearIdleStop();
        return () => {
            if (this.viewers.delete(viewer) && !this.viewers.size) {
                this.scheduleIdleStop();
            }
        };
    }

    /**
     * Starts the server for a viewer unless its stream is already up. Queued like every other
     * start and stop, so it also waits for a stop or a settings restart that is under way.
     */
    public async ensureServer(): Promise<void> {
        return this.queueServerOperation(async () => {
            if (!broadcastManager.hasBroadcast(this.udid)) {
                await this.startServerNow();
            }
        });
    }

    private scheduleIdleStop(): void {
        this.clearIdleStop();
        if (this.released) {
            return;
        }
        const timer = setTimeout(() => {
            if (this.idleStopTimeoutId !== timer) {
                return;
            }
            this.idleStopTimeoutId = undefined;
            this.queueServerOperation(async () => {
                // A viewer that arrived while this waited in the queue keeps the stream.
                if (this.released || this.viewers.size || this.idleStopTimeoutId) {
                    return;
                }
                console.log(this.TAG, 'No viewers left. Stopping the stream service');
                await this.killServerNow();
            }).catch((error: Error) => {
                console.error(this.TAG, `Failed to stop the idle stream service: ${error.message}`);
            });
        }, Device.STREAM_IDLE_GRACE_MS);
        // Never the reason the process stays up: shutdown stops the stream by itself.
        timer.unref();
        this.idleStopTimeoutId = timer;
    }

    private clearIdleStop(): void {
        if (this.idleStopTimeoutId) {
            clearTimeout(this.idleStopTimeoutId);
            this.idleStopTimeoutId = undefined;
        }
    }

    private async startServerNow(): Promise<number | undefined> {
        let pid = await this.getServerPid();
        const streaming = broadcastManager.hasBroadcast(this.udid);
        if (!streaming && (typeof pid === 'number' || this.launch)) {
            // A scrcpy server with this server's scid that this process is not attached to:
            // left behind by a previous run that was killed without cleaning up, or one whose
            // stream died while its adb child still runs. Nothing can proxy it, so every viewer
            // would be closed with "no active stream" for ever. Replace it. A scrcpy that
            // someone else started carries another scid, or none, and is never seen here.
            console.log(this.TAG, `Replacing orphaned scrcpy server (pid ${pid ?? 'not found'})`);
            await this.killServerNow(pid);
            pid = undefined;
        }
        try {
            // A stream that is up has a server behind it, even when a failed adb read did not
            // find its process. A second launch would only wait on the phone for a connection.
            if (typeof pid !== 'number' && !streaming) {
                await ScrcpyServer.run(this);
                // Fire-and-forget: WebsocketProxy reads getCachedEncoders() on the hot connect
                // path and must not block on this. `list_encoders=true` spawns a whole second
                // JVM on-device, so it runs in the background once a server just came up.
                this.listEncoders().catch((e: Error) => {
                    console.error(this.TAG, `Failed to list encoders: ${e.message}`);
                });
                pid = await this.getServerPid();
            }
            return pid;
        } catch (error: any) {
            console.error(this.TAG, `Error: ${error.message}`);
            throw error;
        } finally {
            if (!this.viewers.size) {
                // Started from the card, or the viewer left while it was starting.
                this.scheduleIdleStop();
            }
        }
    }

    /**
     * Enumerates this device's real encoders by running the scrcpy server jar in
     * `list_encoders=true` mode. Cached per-device until `force` is requested (e.g. a manual
     * refresh from the settings sheet).
     */
    public async listEncoders(force = false): Promise<EncoderInfo[]> {
        if (!force && this.encoders.length) {
            return this.encoders;
        }
        if (!this.encodersPromise) {
            this.encodersPromise = ScrcpyServer.listEncoders(this)
                .then((list) => {
                    this.encoders = list;
                    return list;
                })
                .finally(() => {
                    this.encodersPromise = undefined;
                });
        }
        return this.encodersPromise;
    }

    public getCachedEncoders(): EncoderInfo[] {
        return this.encoders;
    }

    /** Best-effort human-readable name for the initial-info packet; falls back to the udid. */
    public getDeviceName(): string {
        const manufacturer = this.descriptor['ro.product.manufacturer'];
        const model = this.descriptor['ro.product.model'];
        const name = `${manufacturer || ''} ${model || ''}`.trim();
        return name || this.udid;
    }

    /**
     * Applies a new stream config and restarts the scrcpy server to pick it up: stock scrcpy has
     * no live "change settings" control message, so "apply" always means a relaunch (see the
     * commented-out sendNewVideoSetting() call sites in StreamClientScrcpy).
     *
     * Chained onto `restartChain` so a second config change - or a second viewer clicking Apply
     * concurrently - waits for the first restart to fully finish instead of racing it. Without
     * this, two overlapping restarts could each see "no server running" and each spawn their own
     * scrcpy process, or the second could call startServer() while the first's kill is still in
     * flight and observe a stale pid and skip launching entirely.
     */
    public async updateStreamConfig(patch: Partial<StreamConfigData>): Promise<StreamConfigData> {
        return this.queueServerOperation(async () => {
            const config = streamConfig.set(this.udid, patch);
            this.audioFailure = undefined;
            await this.restartWithCurrentConfig();
            return config;
        });
    }

    /** A fatal audio source failure must not create an endless reconnect/relaunch loop. */
    public getLaunchStreamConfig(): StreamConfigData {
        let config = streamConfig.get(this.udid);
        if (config.audioSource === 'playback' && parseInt(this.descriptor['ro.build.version.sdk'], 10) < 33) {
            // Capturing playback while the phone keeps playing needs Android 13. Below that
            // the launch uses the plain output source; the saved choice is left alone.
            config = { ...config, audioSource: 'output' };
        }
        return this.audioFailure ? { ...config, audio: false } : config;
    }

    private queueServerOperation<T>(operation: () => Promise<T>): Promise<T> {
        const pending = this.restartChain.then(operation);
        // A failed operation still rejects its caller, but must not wedge later reconnects.
        this.restartChain = pending.then(
            () => undefined,
            () => undefined,
        );
        return pending;
    }

    private async restartWithCurrentConfig(): Promise<void> {
        // With nobody watching, the new settings take effect the next time the screen is opened.
        const watched = this.viewers.size > 0;
        try {
            await this.killServerNow();
        } catch (e: any) {
            console.error(this.TAG, `updateStreamConfig: kill failed, relaunching anyway: ${e.message}`);
        }
        if (watched) {
            await this.startServerNow();
        }
    }
}
