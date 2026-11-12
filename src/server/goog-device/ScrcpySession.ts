import { Duplex } from 'stream';
import { Broadcast } from '../../common/Broadcast';
import { broadcastManager } from '../../common/BroadcastManager';
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, AudioMetadata } from '../../common/AudioProtocol';
import { STREAM_SERVICE_STOPPED } from '../../common/StreamCloseCode';
import { AdbUtils, ForwardLease } from './AdbUtils';
import { EncoderInfo, ScrcpyServer, ScrcpyTarget } from './ScrcpyServer';
import { ScrcpyInstance } from './ScrcpyInstance';
import { StreamConfigData, streamConfig } from './StreamConfig';

export interface StreamViewer {
    close(code: number, reason: string): void;
}
interface SessionTarget extends ScrcpyTarget {
    openShell(command: string, signal: AbortSignal): Promise<Duplex>;
    killProcess(pid: number): Promise<string>;
    setServerPid(pid: number): void;
    invalidatePid(): void;
    refreshServicePid(): Promise<void>;
    sdk(): string;
}
interface ServerLaunch {
    controller: AbortController;
    shell?: Duplex;
    forward?: ForwardLease;
    broadcast?: Broadcast;
    timeout?: NodeJS.Timeout;
    delay?: NodeJS.Timeout;
    cancelDelay?: () => void;
    done: boolean;
    finish(error?: Error): void;
}

/** Owns viewers, the serial operation queue, and every resource of each scrcpy launch. */
export class ScrcpySession {
    private static readonly STREAM_IDLE_GRACE_MS = 30000;
    private static readonly SERVER_START_TIMEOUT_MS = 15000;
    private static readonly STREAM_CONNECT_DELAY_MS = 1000;
    private static readonly STREAM_RETRY_DELAY_MS = 500;
    private connected = true;
    private released = false;
    private generation = 0;
    private stopRevision = 0;
    private lifetime = new AbortController();
    private viewers = new Set<StreamViewer>();
    private idleStopTimeoutId?: NodeJS.Timeout;
    private launch?: ServerLaunch;
    private restartChain: Promise<void> = Promise.resolve();
    private audioFailure?: AudioMetadata;
    private audioLaunchGeneration = 0;
    private encoders: EncoderInfo[] = [];
    private encodersPromise?: Promise<EncoderInfo[]>;

    constructor(private readonly target: SessionTarget) {}

    public setConnected(connected: boolean): void {
        if (this.connected === connected && !this.released) return;
        this.generation++;
        this.encodersPromise = undefined;
        this.connected = connected && !this.released;
        this.lifetime.abort(new Error('The phone connection ended.'));
        this.lifetime = new AbortController();
        this.audioLaunchGeneration++;
        this.clearIdleStop();
        this.stopLaunch(this.launch, new Error('The phone connection ended.'));
        // Disconnect/restart uses the normal stream-close path, never the owner's Stop code.
        broadcastManager.stopBroadcast(this.target.udid);
    }

    public release(): void {
        this.released = true;
        this.setConnected(false);
        this.viewers.clear();
    }

    private valid(generation: number): boolean {
        return !this.released && this.connected && this.target.isConnected() && generation === this.generation;
    }

    private queueServerOperation<T>(operation: () => Promise<T>): Promise<T> {
        const generation = this.generation;
        const pending = this.restartChain.then(() => {
            if (this.released || generation !== this.generation) throw Error('The phone connection ended.');
            return operation();
        });
        this.restartChain = pending.then(
            () => undefined,
            () => undefined,
        );
        return pending;
    }

    public addViewer(viewer: StreamViewer): () => void {
        if (this.released) return () => undefined;
        this.viewers.add(viewer);
        this.clearIdleStop();
        return () => {
            if (this.viewers.delete(viewer) && !this.viewers.size) this.scheduleIdleStop();
        };
    }

    public async startServer(): Promise<number | undefined> {
        return this.queueServerOperation(() => this.startServerNow());
    }

    public async ensureServer(): Promise<void> {
        const stopRevision = this.stopRevision;
        return this.queueServerOperation(async () => {
            if (stopRevision !== this.stopRevision) return;
            if (!broadcastManager.hasBroadcast(this.target.udid)) await this.startServerNow();
        });
    }

    public async killServer(pid: number): Promise<void> {
        return this.queueServerOperation(async () => {
            this.stopRevision++;
            this.viewers.forEach((viewer) => viewer.close(STREAM_SERVICE_STOPPED, 'Stream service stopped'));
            await this.killServerNow(pid);
        });
    }

    private async getServerPid(signal = this.lifetime.signal): Promise<number | undefined> {
        const generation = this.generation;
        const pids = await ScrcpyServer.getServerPid(this.target, false, signal);
        if (!this.valid(generation) || signal.aborted) return;
        const pid = pids?.find((value) => Number.isInteger(value) && value > 0) ?? -1;
        this.target.setServerPid(pid);
        return pid > 0 ? pid : undefined;
    }

    private async killServerNow(pid?: number): Promise<void> {
        this.audioLaunchGeneration++;
        this.target.invalidatePid();
        this.clearIdleStop();
        const launch = this.launch;
        const generation = this.generation;
        try {
            const realPid = await this.getServerPid();
            if (typeof realPid !== 'number' || !this.valid(generation)) return;
            if (pid && realPid !== pid) {
                console.error(
                    this.target.TAG,
                    `Requested to kill server with PID ${pid}. Real server PID is ${realPid}.`,
                );
            }
            const output = await this.target.killProcess(realPid);
            if (!this.valid(generation)) return;
            if (output) console.log(this.target.TAG, `kill server: "${output}"`);
            await AdbUtils.removeFileSocketForwards(this.target.udid).catch((error: Error) => {
                console.error(this.target.TAG, `Failed to remove file socket forwards: ${error.message}`);
            });
            if (this.valid(generation)) this.target.setServerPid(-1);
        } finally {
            this.stopLaunch(launch, new Error('The stream service stopped.'));
            // A status-only orphan has no launch object, but may still have a dead broadcast.
            if (this.valid(generation)) broadcastManager.stopBroadcast(this.target.udid);
        }
    }

    private async startServerNow(): Promise<number | undefined> {
        const generation = this.generation;
        if (!this.valid(generation)) return;
        let pid = await this.getServerPid();
        if (!this.valid(generation)) return;
        const streaming = broadcastManager.hasBroadcast(this.target.udid);
        if (!streaming && (typeof pid === 'number' || this.launch)) {
            console.log(this.target.TAG, `Replacing orphaned scrcpy server (pid ${pid ?? 'not found'})`);
            await this.killServerNow(pid);
            pid = undefined;
        }
        try {
            if (!this.valid(generation)) return;
            if (typeof pid !== 'number' && !streaming) {
                await ScrcpyServer.run(this.target, this.lifetime.signal);
                if (!this.valid(generation)) return;
                // Encoder enumeration is cached; cancellation follows the connection lifetime.
                this.listEncoders().catch((error: Error) => {
                    if (this.valid(generation))
                        console.error(this.target.TAG, `Failed to list encoders: ${error.message}`);
                });
                pid = await this.getServerPid();
            }
            return pid;
        } finally {
            if (this.valid(generation) && !this.viewers.size) this.scheduleIdleStop();
        }
    }

    private scheduleIdleStop(): void {
        this.clearIdleStop();
        if (this.released || !this.connected) return;
        const timer = setTimeout(() => {
            if (this.idleStopTimeoutId !== timer) return;
            this.idleStopTimeoutId = undefined;
            this.queueServerOperation(async () => {
                if (this.viewers.size || this.idleStopTimeoutId) return;
                console.log(this.target.TAG, 'No viewers left. Stopping the stream service');
                await this.killServerNow();
            }).catch((error: Error) => {
                if (!this.released)
                    console.error(this.target.TAG, `Failed to stop the idle stream service: ${error.message}`);
            });
        }, ScrcpySession.STREAM_IDLE_GRACE_MS);
        timer.unref();
        this.idleStopTimeoutId = timer;
    }

    private clearIdleStop(): void {
        if (this.idleStopTimeoutId) clearTimeout(this.idleStopTimeoutId);
        this.idleStopTimeoutId = undefined;
    }

    private stopOwnBroadcast(launch: ServerLaunch): void {
        const broadcast = launch.broadcast;
        launch.broadcast = undefined;
        if (broadcast) broadcastManager.stopBroadcast(this.target.udid, broadcast);
    }

    private stopLaunch(launch: ServerLaunch | undefined, error: Error): void {
        if (!launch) return;
        launch.finish(error);
        launch.controller.abort(error);
        launch.shell?.destroy();
        if (launch.timeout) clearTimeout(launch.timeout);
        if (launch.delay) clearTimeout(launch.delay);
        launch.cancelDelay?.();
        this.stopOwnBroadcast(launch);
        const forward = launch.forward;
        launch.forward = undefined;
        if (forward)
            void forward.release().catch((failure: Error) => {
                console.error(this.target.TAG, `Failed to remove stream forward: ${failure.message}`);
            });
        if (this.launch === launch) this.launch = undefined;
    }

    public launchServer(command: string, audioEnabled: boolean): Promise<void> {
        const generation = this.generation;
        if (!this.valid(generation)) return Promise.reject(Error('The phone is not connected.'));
        const audioGeneration = ++this.audioLaunchGeneration;
        this.target.invalidatePid();
        this.target.setServerPid(0);
        const signal = this.lifetime.signal;
        return new Promise<void>((resolve, reject) => {
            const launch: ServerLaunch = {
                controller: new AbortController(),
                done: false,
                finish: (error?: Error) => {
                    if (launch.done) return;
                    launch.done = true;
                    if (launch.timeout) clearTimeout(launch.timeout);
                    launch.timeout = undefined;
                    if (error) reject(error);
                    else resolve();
                },
            };
            this.launch = launch;
            const abort = () => this.stopLaunch(launch, signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            launch.controller.signal.addEventListener('abort', () => signal.removeEventListener('abort', abort), {
                once: true,
            });
            launch.timeout = setTimeout(() => {
                this.stopLaunch(launch, new Error('The stream service did not start in time.'));
            }, ScrcpySession.SERVER_START_TIMEOUT_MS);
            let lastOutput = '';
            let audioLogTail = '';
            const onAudioFailure = (metadata: AudioMetadata) => {
                if (audioGeneration === this.audioLaunchGeneration && this.valid(generation))
                    this.audioFailure = metadata;
            };
            this.target.openShell(command, launch.controller.signal).then(
                (shell) => {
                    if (launch.controller.signal.aborted || !this.valid(generation)) {
                        shell.destroy();
                        return;
                    }
                    launch.shell = shell;
                    let connecting = false;
                    shell.on('data', (data: Buffer) => {
                        if (launch.controller.signal.aborted) return;
                        if (audioEnabled) {
                            audioLogTail = (audioLogTail + data.toString()).slice(-4096);
                            if (
                                /Audio (?:recording|encoding|capture) error|Audio disabled|Failed to (?:initialize audio|start audio capture)|Could not create (?:default )?audio encoder/i.test(
                                    audioLogTail,
                                )
                            ) {
                                onAudioFailure({
                                    status: 'error',
                                    sampleRate: AUDIO_SAMPLE_RATE,
                                    channels: AUDIO_CHANNELS,
                                    message:
                                        'The phone rejected audio capture. Video remains available. Choose another audio source or format and apply to retry.',
                                });
                            }
                        }
                        lastOutput = data.toString().trim() || lastOutput;
                        console.log(this.target.TAG, data.toString().replace(/\n$/, ''));
                        if (!connecting) {
                            connecting = true;
                            this.connectStream(launch, audioEnabled, onAudioFailure).then(
                                () => {
                                    if (!launch.controller.signal.aborted) launch.finish();
                                },
                                (error: Error) => this.stopLaunch(launch, error),
                            );
                        }
                    });
                    shell.once('error', (error: Error) => this.stopLaunch(launch, error));
                    let ended = false;
                    const closed = () => {
                        if (ended) return;
                        ended = true;
                        const detail = lastOutput.split('\n').pop();
                        this.stopLaunch(
                            launch,
                            new Error(`The stream service exited before it was ready${detail ? `: ${detail}` : '.'}`),
                        );
                        if (this.valid(generation) && audioGeneration === this.audioLaunchGeneration) {
                            this.target.setServerPid(0);
                            void this.target.refreshServicePid();
                        }
                    };
                    shell.once('close', closed);
                    shell.once('end', closed);
                },
                (error: Error) => this.stopLaunch(launch, error),
            );
        });
    }

    private wait(launch: ServerLaunch, ms: number): Promise<void> {
        return new Promise((resolve) => {
            launch.cancelDelay = resolve;
            launch.delay = setTimeout(() => {
                launch.delay = undefined;
                launch.cancelDelay = undefined;
                resolve();
            }, ms);
        });
    }

    private async connectStream(
        launch: ServerLaunch,
        audioEnabled: boolean,
        onAudioFailure: (metadata: AudioMetadata) => void,
    ): Promise<void> {
        const signal = launch.controller.signal;
        const forward = await AdbUtils.acquireForward(this.target.udid, ScrcpyInstance.socketName(), signal);
        if (signal.aborted) {
            await forward.release();
            return;
        }
        launch.forward = forward;
        let delay = ScrcpySession.STREAM_CONNECT_DELAY_MS;
        while (!signal.aborted && !launch.done) {
            await this.wait(launch, delay);
            if (signal.aborted) return;
            const broadcast = await broadcastManager.startBroadcast(
                this.target.udid,
                forward.port,
                audioEnabled,
                {
                    onFailure: onAudioFailure,
                    failure: audioEnabled ? undefined : this.audioFailure,
                },
                signal,
            );
            if (signal.aborted) {
                if (broadcast) broadcastManager.stopBroadcast(this.target.udid, broadcast);
                return;
            }
            launch.broadcast = broadcast;
            if (broadcast && (await broadcast.whenReady())) return;
            this.stopOwnBroadcast(launch);
            delay = ScrcpySession.STREAM_RETRY_DELAY_MS;
        }
    }

    public async updateStreamConfig(patch: Partial<StreamConfigData>): Promise<StreamConfigData> {
        return this.queueServerOperation(async () => {
            const config = streamConfig.set(this.target.udid, patch);
            this.audioFailure = undefined;
            await this.restartWithCurrentConfig();
            return config;
        });
    }

    private async restartWithCurrentConfig(): Promise<void> {
        const generation = this.generation;
        const watched = this.viewers.size > 0;
        try {
            await this.killServerNow();
        } catch (error: any) {
            console.error(this.target.TAG, `updateStreamConfig: kill failed, relaunching anyway: ${error.message}`);
        }
        if (watched && this.valid(generation)) await this.startServerNow();
    }

    public getLaunchStreamConfig(): StreamConfigData {
        let config = streamConfig.get(this.target.udid);
        if (config.audioSource === 'playback' && parseInt(this.target.sdk(), 10) < 33)
            config = { ...config, audioSource: 'output' };
        return this.audioFailure ? { ...config, audio: false } : config;
    }

    public async listEncoders(force = false): Promise<EncoderInfo[]> {
        if (!force && this.encoders.length) return this.encoders;
        if (!this.encodersPromise) {
            const generation = this.generation;
            const pending = ScrcpyServer.listEncoders(this.target, this.lifetime.signal)
                .then((list) => {
                    if (!this.valid(generation)) return [];
                    this.encoders = list;
                    return list;
                })
                .finally(() => {
                    if (this.encodersPromise === pending) this.encodersPromise = undefined;
                });
            this.encodersPromise = pending;
        }
        return this.encodersPromise;
    }

    public getCachedEncoders(): EncoderInfo[] {
        return this.encoders;
    }
}
