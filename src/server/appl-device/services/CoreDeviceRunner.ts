import * as http from 'http';
import { ChildProcess } from 'child_process';
import * as portfinder from 'portfinder';
import { TypedEmitter } from '../../../common/TypedEmitter';
import { CoreDeviceSessionState } from '../../../common/CoreDeviceProtocol';
import { Service } from '../../services/Service';
import { PyMobileDevice } from './PyMobileDevice';
import { CoreDeviceAudioRelay } from './CoreDeviceAudio';

const TAG = '[CoreDeviceRunner]';

// serve-web brings the tunnel, the DDI services and the device's encoder up in the background;
// /codec answers 503 until the first SPS has been seen. A cold iOS 27 start has been observed to
// take well over 30 s, so the bound is generous, but a dead process fails fast (see `spawn`).
const READY_TIMEOUT_MS = 120000;
const READY_POLL_MS = 500;
// Once serve-web's HTTP is answering, /codec should turn 200 within a couple of seconds. If it
// stays 503 far longer, the device-side CoreDevice display daemon is wedged (it accepts the
// session but never starts capture) -- a phone reboot is the only fix, so say so rather than
// waiting out the full mount budget below.
const DISPLAY_WEDGED_TIMEOUT_MS = 25000;
// The last viewer leaving usually means a navigation, not the end of the session: keep the
// device stream for a moment so a switch/reload does not pay the cold start again.
const RELEASE_GRACE_MS = 15000;
// How long SIGTERM gets before SIGKILL. serve-web's orderly shutdown is what returns the device's
// media-stream sessions -- it stops HID, the video stream, the audio stream and the accessibility
// channel, each bounded at 3 s of its own, so a phone that is answering slowly can legitimately
// need ~15 s. SIGKILL skips all of it and leaves the sessions allocated on the phone, streaming
// into a tunnel that no longer exists (confirmed against the bench iPhone: `display
// get-media-stream-server-status` still reported `running: true` with two live sessions after a
// SIGKILL, and only an RTCP timeout ~20 s later reclaimed them). One of those is survivable; a
// burst of them is how the display daemon ends up wedged, which only a reboot clears. A healthy
// shutdown takes well under a second and `close` cancels this, so the long bound costs nothing.
const SIGKILL_GRACE_MS = 15000;
const MOUNT_TIMEOUT_MS = 180000;
const PASTEBOARD_PROBE_SCRIPT = 'pasteboard_restart.py';
// The probe brings up its own short-lived tunnel, lists the phone's processes and sends one
// signal; measured end to end at 0.8 s on the bench iPhone over USB.
const PASTEBOARD_PROBE_TIMEOUT_MS = 30000;

export type SessionStatus = { state: CoreDeviceSessionState; message?: string; port?: number };

export interface CoreDeviceRunnerEvents {
    status: { udid: string; state: CoreDeviceSessionState; message?: string };
}

export type HttpReply = { status: number; body: string };

interface Session {
    udid: string;
    port: number;
    child?: ChildProcess;
    state: CoreDeviceSessionState;
    message?: string;
    holders: number;
    stderrTail: string;
    ready: Promise<void>;
    releaseTimer?: NodeJS.Timeout;
    generation: number;
    // Created by the first viewer that wants sound; decodes once, fans out to every viewer.
    audio?: CoreDeviceAudioRelay;
}

/**
 * One `pymobiledevice3 developer core-device display serve-web` process per iOS device.
 *
 * That process is the whole device side of the stream: it opens the no-root userspace RSD
 * tunnel, negotiates Apple's CoreDevice display stream (RTP/HEVC pushed by the phone), keeps it
 * alive (RTCP, PLI, stall watchdog, keep-awake) and drives the HID surfaces for touch, buttons
 * and the virtual keyboard. This class only manages its lifecycle and exposes its loopback HTTP
 * API to `CoreDeviceProxy`; `serve-web` binds 127.0.0.1 because its endpoints have no auth.
 *
 * Nothing here is verified against hardware yet: the bench iPhone was not reachable while this
 * was written (see docs/HANDOFF.md). `scripts/test-coredevice.js` drives it against a fake CLI.
 */
export class CoreDeviceRunner extends TypedEmitter<CoreDeviceRunnerEvents> implements Service {
    private static instance?: CoreDeviceRunner;
    private readonly sessions = new Map<string, Session>();
    private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
    // One in-flight pasteboard-daemon restart per device (see restartPasteboardDaemon).
    private readonly pasteboardRestarts = new Map<string, Promise<boolean>>();
    private released = false;

    public static getInstance(): CoreDeviceRunner {
        if (!this.instance) {
            this.instance = new CoreDeviceRunner();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!this.instance;
    }

    protected constructor() {
        super();
        process.once('exit', this.onProcessExit);
    }

    public getName(): string {
        return 'iOS CoreDevice session runner';
    }

    public async start(): Promise<void> {
        // Sessions start on demand, when the first viewer connects.
    }

    public getStatus(udid: string): SessionStatus {
        const session = this.sessions.get(udid);
        if (!session) {
            return { state: 'stopped' };
        }
        return { state: session.state, message: session.message, port: session.port };
    }

    /** Starts (or joins) the device session and holds it until `release()`. Resolves when ready. */
    public async acquire(udid: string): Promise<number> {
        if (this.released) {
            throw new Error('Server is shutting down');
        }
        let session = this.sessions.get(udid);
        if (session && session.state === 'error') {
            // A failed start is not sticky: the next viewer retries with a fresh process.
            this.stopSession(udid);
            session = undefined;
        }
        if (!session) {
            session = await this.createSession(udid);
        }
        if (session.releaseTimer) {
            clearTimeout(session.releaseTimer);
            session.releaseTimer = undefined;
        }
        session.holders++;
        try {
            await session.ready;
        } catch (error) {
            session.holders--;
            throw error;
        }
        return session.port;
    }

    public release(udid?: string): void {
        if (udid === undefined) {
            // Service shutdown.
            this.released = true;
            for (const key of Array.from(this.sessions.keys())) {
                this.stopSession(key);
            }
            this.agent.destroy();
            process.off('exit', this.onProcessExit);
            CoreDeviceRunner.instance = undefined;
            return;
        }
        const session = this.sessions.get(udid);
        if (!session) {
            return;
        }
        session.holders = Math.max(0, session.holders - 1);
        if (session.holders === 0 && !session.releaseTimer) {
            session.releaseTimer = setTimeout(() => {
                session.releaseTimer = undefined;
                if (session.holders === 0 && this.sessions.get(udid) === session) {
                    this.stopSession(udid, 'No viewers');
                }
            }, RELEASE_GRACE_MS);
        }
    }

    /**
     * The session's audio relay, created on first use. `undefined` while the session is not
     * ready or when `IOS_AUDIO=0` turns device audio off on this server.
     */
    public audio(udid: string): CoreDeviceAudioRelay | undefined {
        const session = this.sessions.get(udid);
        if (!session || session.state !== 'ready' || process.env.IOS_AUDIO === '0') {
            return undefined;
        }
        if (!session.audio) {
            session.audio = new CoreDeviceAudioRelay(udid, session.port);
        }
        return session.audio;
    }

    public stopSession(udid: string, message?: string): void {
        const session = this.sessions.get(udid);
        if (!session) {
            return;
        }
        this.sessions.delete(udid);
        session.audio?.stop();
        session.audio = undefined;
        if (session.releaseTimer) {
            clearTimeout(session.releaseTimer);
        }
        this.kill(session.child);
        session.child = undefined;
        this.setState(session, 'stopped', message);
    }

    /** One loopback HTTP request against the device's serve-web (`/touch`, `/clipboard`, ...). */
    public request(udid: string, method: string, path: string, body?: string, timeoutMs = 15000): Promise<HttpReply> {
        const session = this.sessions.get(udid);
        if (!session || session.state === 'stopped' || session.state === 'error') {
            return Promise.reject(new Error('No screen session for this device'));
        }
        return CoreDeviceRunner.httpRequest(this.agent, session.port, method, path, body, timeoutMs);
    }

    /**
     * Restarts the phone's `dtpasteboardd`, the Developer-Disk-Image daemon that every clipboard
     * read and write goes through, and answers whether one was actually killed.
     *
     * That daemon wedges: it keeps accepting connections and still refuses a malformed request in
     * milliseconds, but a valid read or write gets no reply at all, for ever. Nothing on this side
     * is involved -- verified on hardware that a brand-new serve-web, a fresh session and a reboot
     * of the *system* pasteboard daemon all talk to the same stuck process, while the phone's own
     * Cmd+C / Cmd+V keep working. Killing it is the only cure short of rebooting the phone;
     * launchd starts a new one for the next connection and it answers in ~40 ms, with the
     * clipboard's contents intact (`pasted` holds those, not this daemon).
     *
     * Concurrent callers share one restart -- several viewers can hit the same wedge at once --
     * but there is deliberately no cooldown past that: the kill is cheap and harmless, and a
     * clipboard request only happens when somebody presses a button.
     */
    public restartPasteboardDaemon(udid: string): Promise<boolean> {
        const running = this.pasteboardRestarts.get(udid);
        if (running) {
            return running;
        }
        const work = PyMobileDevice.runProbeJson<{ restarted?: boolean; pids?: number[] }>(
            PASTEBOARD_PROBE_SCRIPT,
            [],
            PASTEBOARD_PROBE_TIMEOUT_MS,
            { PYMOBILEDEVICE3_UDID: udid },
        )
            .then((result) => {
                if (!result) {
                    // No probe script next to the server (a partial install).
                    console.error(`${TAG} ${PASTEBOARD_PROBE_SCRIPT} is missing; cannot restart the clipboard service`);
                    return false;
                }
                PyMobileDevice.log(`[${udid}] pasteboard daemon restart: ${JSON.stringify(result)}`);
                return result.restarted === true;
            })
            .catch((error: Error) => {
                PyMobileDevice.log(`[${udid}] pasteboard daemon restart failed: ${error.message}`);
                return false;
            })
            .finally(() => this.pasteboardRestarts.delete(udid));
        this.pasteboardRestarts.set(udid, work);
        return work;
    }

    /** Opens `/stream.bin`; the caller consumes the chunked body and destroys it when done. */
    public openStream(udid: string): Promise<http.IncomingMessage> {
        const session = this.sessions.get(udid);
        if (!session || session.state === 'stopped' || session.state === 'error') {
            return Promise.reject(new Error('No screen session for this device'));
        }
        return new Promise((resolve, reject) => {
            const request = http.request(
                { host: '127.0.0.1', port: session.port, path: '/stream.bin', method: 'GET', agent: false },
                (response) => resolve(response),
            );
            request.on('error', reject);
            request.end();
        });
    }

    private async createSession(udid: string): Promise<Session> {
        const port = await portfinder.getPortPromise({ port: 18100 });
        const session: Session = {
            udid,
            port,
            state: 'starting',
            holders: 0,
            stderrTail: '',
            ready: Promise.resolve(),
            generation: 0,
        };
        this.sessions.set(udid, session);
        this.setState(session, 'starting', 'Preparing the device');
        session.ready = this.bringUp(session).catch((error: Error) => {
            if (this.sessions.get(udid) === session) {
                this.kill(session.child);
                session.child = undefined;
                this.setState(session, 'error', error.message);
            }
            throw error;
        });
        return session;
    }

    private async bringUp(session: Session): Promise<void> {
        const { udid } = session;
        // The Developer Disk Image hosts the display and HID daemons; it never survives a reboot
        // and the CLI treats "already mounted" as success. Developer Mode being off is the one
        // failure worth naming, because the fix is a toggle on the phone.
        const mount = await PyMobileDevice.runOneShot(['mounter', 'auto-mount', '--udid', udid], MOUNT_TIMEOUT_MS);
        if (mount.code !== 0) {
            const reason = PyMobileDevice.explain(mount.stderr);
            if (/DeveloperMode/i.test(reason)) {
                throw new Error('Developer Mode is off on the phone (Settings > Privacy & Security > Developer Mode).');
            }
            throw new Error(`Could not mount the Developer Disk Image: ${reason || 'unknown error'}`);
        }
        if (this.sessions.get(udid) !== session) {
            throw new Error('Session stopped');
        }
        this.setState(session, 'starting', 'Starting the screen stream');
        // `serve-web` has no --udid option (verified against 11.12.5): the RSD dependency reads
        // the target from PYMOBILEDEVICE3_UDID when it brings the tunnel up itself.
        const child = PyMobileDevice.spawnDetached(
            [
                'developer',
                'core-device',
                'display',
                'serve-web',
                '--bind',
                '127.0.0.1',
                '--http-port',
                String(session.port),
                '--no-audio',
                ...PyMobileDevice.tunnelArgs(udid),
            ],
            { PYMOBILEDEVICE3_UDID: udid },
        );
        session.child = child;
        child.stdout?.on('data', (data) => PyMobileDevice.log(`[${udid}] ${data}`));
        child.stderr?.on('data', (data) => {
            session.stderrTail = (session.stderrTail + data).slice(-4096);
            PyMobileDevice.log(`[${udid}] ${data}`);
        });
        let exited = false;
        const exitPromise = new Promise<never>((_resolve, reject) => {
            child.on('error', (error) => {
                exited = true;
                reject(new Error(`pymobiledevice3 could not start: ${error.message}`));
            });
            child.on('close', (code, signal) => {
                exited = true;
                if (this.sessions.get(udid) === session && session.child === child) {
                    // The failed session stays registered so the device card can show why; the
                    // next `acquire()` replaces it with a fresh process.
                    session.child = undefined;
                    const reason = PyMobileDevice.explain(session.stderrTail);
                    this.setState(session, 'error', reason || `The screen stream exited (${signal || code})`);
                }
                reject(
                    new Error(
                        PyMobileDevice.explain(session.stderrTail) || `The screen stream exited (${signal || code})`,
                    ),
                );
            });
        });
        const deadline = Date.now() + READY_TIMEOUT_MS;
        // Set once serve-web's HTTP first answers (any status): from there a stalled /codec means
        // the display daemon is wedged, not that the server is still starting.
        let serverUpSince: number | undefined;
        while (Date.now() < deadline && !exited) {
            if (this.sessions.get(udid) !== session) {
                throw new Error('Session stopped');
            }
            const reply = await Promise.race([
                CoreDeviceRunner.httpRequest(this.agent, session.port, 'GET', '/codec', undefined, 8000).catch(
                    () => undefined,
                ),
                exitPromise,
            ]);
            if (reply && reply.status === 200) {
                this.setState(session, 'ready');
                return;
            }
            if (reply) {
                if (serverUpSince === undefined) {
                    serverUpSince = Date.now();
                } else if (Date.now() - serverUpSince > CoreDeviceRunner.displayWedgedTimeoutMs()) {
                    throw new Error(
                        'The phone accepted the screen session but never started sending video. ' +
                            'Its CoreDevice display service is stuck -- reboot the phone and try again.',
                    );
                }
            }
            await Promise.race([new Promise((resolve) => setTimeout(resolve, READY_POLL_MS)), exitPromise]);
        }
        await Promise.race([exitPromise, Promise.resolve()]);
        throw new Error('The screen stream did not become ready in time. Is the phone unlocked?');
    }

    // Overridable so tests do not have to wait the full 25 s for the wedged-display path.
    private static displayWedgedTimeoutMs(): number {
        const override = Number(process.env.IOS_DISPLAY_WEDGED_TIMEOUT_MS);
        return Number.isFinite(override) && override > 0 ? override : DISPLAY_WEDGED_TIMEOUT_MS;
    }

    private setState(session: Session, state: CoreDeviceSessionState, message?: string): void {
        session.state = state;
        session.message = message;
        if (state === 'error') {
            console.error(`${TAG} [${session.udid}] ${message}`);
        }
        this.emit('status', { udid: session.udid, state, message });
    }

    private kill(child?: ChildProcess): void {
        if (!child || child.exitCode !== null || child.signalCode !== null) {
            return;
        }
        const pid = child.pid;
        try {
            if (pid && process.platform !== 'win32') {
                process.kill(-pid, 'SIGTERM');
            } else {
                child.kill('SIGTERM');
            }
        } catch {
            // Already gone.
        }
        const force = setTimeout(() => {
            try {
                if (pid && process.platform !== 'win32') {
                    process.kill(-pid, 'SIGKILL');
                } else {
                    child.kill('SIGKILL');
                }
            } catch {
                // Already gone.
            }
        }, SIGKILL_GRACE_MS);
        child.once('close', () => clearTimeout(force));
    }

    private onProcessExit = (): void => {
        for (const session of this.sessions.values()) {
            const pid = session.child?.pid;
            if (pid) {
                try {
                    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
                } catch {
                    // Already gone.
                }
            }
        }
    };

    public static httpRequest(
        agent: http.Agent,
        port: number,
        method: string,
        path: string,
        body?: string,
        timeoutMs = 15000,
    ): Promise<HttpReply> {
        return new Promise((resolve, reject) => {
            const request = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path,
                    method,
                    agent,
                    timeout: timeoutMs,
                    headers: body
                        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                        : {},
                },
                (response) => {
                    let text = '';
                    response.setEncoding('utf8');
                    response.on('data', (chunk) => (text += chunk));
                    response.on('end', () => resolve({ status: response.statusCode || 0, body: text }));
                    response.on('error', reject);
                },
            );
            request.on('timeout', () => request.destroy(new Error('Request timed out')));
            request.on('error', reject);
            if (body) {
                request.write(body);
            }
            request.end();
        });
    }
}
