import * as http from 'http';
import { ChildProcess } from 'child_process';
import * as portfinder from 'portfinder';
import { TypedEmitter } from '../../../common/TypedEmitter';
import { CoreDeviceSessionState } from '../../../common/CoreDeviceProtocol';
import { isPasscodeLockout, UNLOCK_BY_HAND_MESSAGE } from '../../../common/IosUnlockSchedule';
import { Service } from '../../services/Service';
import { PyMobileDevice } from './PyMobileDevice';
import { CoreDeviceAudioRelay } from './CoreDeviceAudio';
import { StartBudget } from './StartBudget';

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
// channel, in bounded steps of 2+2+3+3+3+6 s (11.44.0), so a phone that is answering slowly can
// legitimately need ~19 s. SIGKILL skips all of it and leaves the sessions allocated on the phone,
// streaming into a tunnel that no longer exists (confirmed against the bench iPhone: `display
// get-media-stream-server-status` still reported `running: true` with two live sessions after a
// SIGKILL, and only an RTCP timeout ~20 s later reclaimed them). One of those is survivable; a
// burst of them is how the display daemon ends up wedged, which only a reboot clears. A healthy
// shutdown takes well under a second and `close` cancels this, so the long bound costs nothing.
const SIGKILL_GRACE_MS = 30000;
// serve-web installs its SIGTERM handler only after its preflight (which starts the phone's video
// and audio, bounded at 25 s) and the HTTP bind. A SIGTERM before that kills it with no cleanup,
// exactly like SIGKILL. So a stop waits until the process is known to handle the signal, but no
// longer than this after it was spawned. python/patches/pymobiledevice3-serve-signals.py installs
// the handlers before the preflight; the wait stays for a venv that does not have that patch yet.
const SIGNAL_READY_TIMEOUT_MS = 35000;
// Logged by serve-web once it serves HTTP; its signal handlers are installed just before.
const SIGNAL_READY_PATTERN = /Open https?:\/\//;
// After a failed session the phone may still hold what serve-web started (a start that fails on
// "camera in use" exits before its cleanup), and the RTCP timeout takes ~20 s to reclaim it.
const ERROR_COOLDOWN_MS = 30000;
// `/restart` stops and starts the phone's video inside serve-web. Each one is a display session
// on the phone, and a burst of those is what wedges its display service (docs/HANDOFF.md).
const VIDEO_RESTART_INTERVAL_MS = 30000;
const MOUNT_TIMEOUT_MS = 180000;
// Each session's serve-web gets the first free loopback port from here up.
const SERVE_WEB_BASE_PORT = 18100;
const PASTEBOARD_PROBE_SCRIPT = 'pasteboard_restart.py';
// The probe brings up its own short-lived tunnel, lists the phone's processes and sends one
// signal; measured end to end at 0.8 s on the bench iPhone over USB.
const PASTEBOARD_PROBE_TIMEOUT_MS = 30000;

export type SessionStatus = { state: CoreDeviceSessionState; message?: string; port?: number };

export interface CoreDeviceRunnerEvents {
    status: { udid: string; state: CoreDeviceSessionState; message?: string };
}

export type HttpReply = { status: number; body: string };

/**
 * What `acquire()` hands out. `release()` and `stopSession()` take it back and do nothing when
 * the phone's session has been replaced since, so a slow teardown cannot act on a newer session.
 */
export interface SessionHold {
    readonly udid: string;
    readonly port: number;
    readonly token: number;
}

export type StartRefusal = 'not-connected' | 'cooldown' | 'budget';

/** `acquire()` declined to start serve-web. Nothing was spawned, so asking again is harmless. */
export class StartRefusedError extends Error {
    constructor(
        message: string,
        public readonly reason: StartRefusal,
    ) {
        super(message);
        this.name = 'StartRefusedError';
    }
}

/**
 * A start that was tried and failed. `serveWebStarted` says whether serve-web had been spawned,
 * so whether the phone may have had a display session. A failure before that (the mount, a phone
 * that went away) left nothing on the phone.
 */
export class SessionStartError extends Error {
    constructor(
        message: string,
        public readonly serveWebStarted: boolean,
    ) {
        super(message);
        this.name = 'SessionStartError';
    }
}

interface Session {
    udid: string;
    // Unique per session; see `SessionHold`.
    token: number;
    port: number;
    child?: ChildProcess;
    // Set once serve-web has been spawned: from here the phone may hold a display session.
    spawned: boolean;
    state: CoreDeviceSessionState;
    message?: string;
    holders: number;
    stderrTail: string;
    ready: Promise<void>;
    releaseTimer?: NodeJS.Timeout;
    // Created by the first viewer that wants sound; decodes once, fans out to every viewer.
    audio?: CoreDeviceAudioRelay;
}

/** One spawned serve-web, tracked from spawn until its `close`, whether or not a session still owns it. */
interface ChildInfo {
    spawnedAt: number;
    // Set, and the promise resolved, once the process handles SIGTERM in an orderly way (or has gone).
    handlesSignals: boolean;
    signalReady: Promise<void>;
    markSignalReady: () => void;
    closed: Promise<void>;
    stopRequested: boolean;
    signalled: boolean;
}

function formatWait(ms: number): string {
    const seconds = Math.max(1, Math.ceil(ms / 1000));
    return seconds < 90 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
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
 * Hardware observations and platform constraints are recorded in docs/HANDOFF.md.
 */
export class CoreDeviceRunner extends TypedEmitter<CoreDeviceRunnerEvents> implements Service {
    private static instance?: CoreDeviceRunner;
    // The static state below describes processes and ports, which outlive a released instance.
    private static readonly children = new Map<ChildProcess, ChildInfo>();
    // Per phone: resolves when every serve-web that was told to stop has closed.
    private static readonly stopping = new Map<string, Promise<void>>();
    // Ports given to sessions whose serve-web has not closed yet. serve-web binds late (after its
    // preflight), so a free-port probe alone would hand the same port to two phones.
    private static readonly ports = new Map<number, Session>();
    private static lastToken = 0;
    private static exitHooked = false;
    private static deviceCheck?: (udid: string) => boolean;
    private readonly sessions = new Map<string, Session>();
    private readonly budget = new StartBudget();
    // Per phone: no new start before `until`, after a session that failed once serve-web ran.
    private readonly cooldowns = new Map<string, { until: number; message: string }>();
    // Per phone, shared by every viewer and the unlock driver: when `/restart` last reached serve-web.
    private readonly videoRestarts = new Map<string, number>();
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

    /**
     * Lets the device tracker say which phones are attached. `acquire()` then refuses any other
     * udid before it runs a command for it. Without a check (unit tests) every udid is accepted.
     */
    public static setDeviceCheck(check?: (udid: string) => boolean): void {
        CoreDeviceRunner.deviceCheck = check;
    }

    /** Whether any serve-web process is still running, including ones that are shutting down. */
    public static hasChildren(): boolean {
        return CoreDeviceRunner.children.size > 0;
    }

    /** Resolves when every serve-web process running now has closed. */
    public static childrenClosed(): Promise<void> {
        return Promise.all(Array.from(CoreDeviceRunner.children.values(), (info) => info.closed)).then(() => undefined);
    }

    /**
     * Resolves when every serve-web that was told to stop for this phone has closed, or after the
     * longest a stop can take. For work on the phone that must not overlap an orderly shutdown.
     */
    public static whenStopped(udid: string): Promise<void> {
        const previous = CoreDeviceRunner.stopping.get(udid);
        if (!previous) {
            return Promise.resolve();
        }
        let timer: NodeJS.Timeout | undefined;
        return Promise.race([
            previous,
            new Promise<void>((resolve) => (timer = setTimeout(resolve, CoreDeviceRunner.shutdownBudgetMs()))),
        ]).finally(() => clearTimeout(timer));
    }

    /**
     * The longest a stop can take: the wait for the signal handler, the grace, and a margin.
     * 70 s with the defaults. `stop_grace_period` in docker-compose.yml has to stay above it, or
     * Docker sends SIGKILL while serve-web is still returning the phone's sessions; a test in
     * scripts/test-web-security.js fails when it does not.
     */
    public static shutdownBudgetMs(): number {
        return CoreDeviceRunner.signalReadyTimeoutMs() + SIGKILL_GRACE_MS + 5000;
    }

    protected constructor() {
        super();
        if (!CoreDeviceRunner.exitHooked) {
            CoreDeviceRunner.exitHooked = true;
            process.on('exit', CoreDeviceRunner.onProcessExit);
        }
    }

    public getName(): string {
        return 'iOS CoreDevice session runner';
    }

    public async start(): Promise<void> {
        // Sessions start on demand, when the first viewer connects. A helper that is behind the
        // repository's patches is logged now, not when the first session is refused.
        void PyMobileDevice.helperProblem();
    }

    public getStatus(udid: string): SessionStatus {
        const session = this.sessions.get(udid);
        if (!session) {
            return { state: 'stopped' };
        }
        return { state: session.state, message: session.message, port: session.port };
    }

    /**
     * Starts (or joins) the device session and holds it until `release()`. Resolves when ready.
     * Throws `StartRefusedError` when a new serve-web may not be started for this phone now.
     */
    public async acquire(udid: string): Promise<SessionHold> {
        if (this.released) {
            throw new Error('Server is shutting down');
        }
        let session = this.sessions.get(udid);
        if (!session || session.state === 'error') {
            this.checkStart(udid);
            // A failed start is not sticky: the next viewer retries with a fresh process.
            this.stopSession(udid);
            session = this.createSession(udid);
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
        return { udid, port: session.port, token: session.token };
    }

    /**
     * Refuses a start that would add to a burst of display sessions, which is what wedges the
     * phone's display service until a reboot (docs/HANDOFF.md). Throws before anything is spawned.
     */
    private checkStart(udid: string): void {
        if (CoreDeviceRunner.deviceCheck && !CoreDeviceRunner.deviceCheck(udid)) {
            throw new StartRefusedError('This iPhone is not connected.', 'not-connected');
        }
        const now = Date.now();
        const cooldown = this.cooldowns.get(udid);
        if (cooldown && cooldown.until > now) {
            const reason = cooldown.message.replace(/\.?$/, '.');
            throw new StartRefusedError(
                `${reason} The next start is allowed in ${formatWait(cooldown.until - now)}.`,
                'cooldown',
            );
        }
        const wait = this.budget.waitMs(udid, now);
        if (wait > 0) {
            throw new StartRefusedError(
                `This phone's screen session was started ${StartBudget.limit()} times in the last ` +
                    `${formatWait(StartBudget.windowMs())}. The next start is allowed in ${formatWait(wait)}.`,
                'budget',
            );
        }
    }

    /**
     * With a udid: gives back one hold. With a `hold` it only counts against the session that hold
     * came from. Without arguments: service shutdown, which stops every session.
     */
    public release(udid?: string, hold?: SessionHold): void {
        if (udid === undefined) {
            // Service shutdown. The exit hook stays: it covers a serve-web that is still waiting
            // for its signal handler when Node exits.
            this.released = true;
            for (const key of Array.from(this.sessions.keys())) {
                this.stopSession(key);
            }
            this.agent.destroy();
            CoreDeviceRunner.instance = undefined;
            return;
        }
        const session = this.sessions.get(udid);
        if (!session || (hold && hold.token !== session.token)) {
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

    /** Stops the phone's session. With a `hold`, only if it is still the session that hold came from. */
    public stopSession(udid: string, message?: string, hold?: SessionHold): void {
        const session = this.sessions.get(udid);
        if (!session || (hold && hold.token !== session.token)) {
            return;
        }
        this.sessions.delete(udid);
        session.audio?.stop();
        session.audio = undefined;
        if (session.releaseTimer) {
            clearTimeout(session.releaseTimer);
        }
        this.stopChild(session);
        if (!session.spawned) {
            CoreDeviceRunner.freePort(session);
        }
        this.setState(session, 'stopped', message);
    }

    /** Milliseconds until a `/restart` may reach this phone's serve-web again; 0 when it may now. */
    public videoRestartWaitMs(udid: string, now = Date.now()): number {
        const last = this.videoRestarts.get(udid);
        return last === undefined ? 0 : Math.max(0, last + VIDEO_RESTART_INTERVAL_MS - now);
    }

    /** Call right before sending `/restart`, so the next one keeps its distance. */
    public noteVideoRestart(udid: string, now = Date.now()): void {
        this.videoRestarts.set(udid, now);
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

    private createSession(udid: string): Session {
        const session: Session = {
            udid,
            token: ++CoreDeviceRunner.lastToken,
            port: 0,
            spawned: false,
            state: 'starting',
            holders: 0,
            stderrTail: '',
            ready: Promise.resolve(),
        };
        this.sessions.set(udid, session);
        const previous = CoreDeviceRunner.stopping.get(udid);
        this.setState(
            session,
            'starting',
            previous ? 'Waiting for the previous session to stop' : 'Preparing the device',
        );
        // Publish ownership before any asynchronous work, including port allocation.
        session.ready = this.prepare(session, previous)
            .then(() => this.bringUp(session))
            .catch((error: Error) => {
                if (!session.spawned) {
                    CoreDeviceRunner.freePort(session);
                }
                if (this.sessions.get(udid) === session) {
                    this.stopChild(session);
                    this.fail(session, error.message);
                }
                throw new SessionStartError(error.message, session.spawned);
            });
        return session;
    }

    /**
     * Waits for the phone's previous serve-web to close, then reserves a port. Two serve-web
     * processes on one phone at once are part of the measured wedge recipe (docs/HANDOFF.md), and
     * an orderly shutdown can take many seconds on a slow phone.
     */
    private async prepare(session: Session, previous?: Promise<void>): Promise<void> {
        const { udid } = session;
        if (previous) {
            // `kill()` bounds the old process itself; the timer only covers a close that never comes.
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([
                previous,
                new Promise((resolve) => (timer = setTimeout(resolve, CoreDeviceRunner.shutdownBudgetMs()))),
            ]);
            clearTimeout(timer);
            if (this.sessions.get(udid) !== session) throw new Error('Session stopped');
            this.setState(session, 'starting', 'Preparing the device');
        }
        const port = await CoreDeviceRunner.reservePort(session);
        session.port = port;
        if (this.sessions.get(udid) !== session) throw new Error('Session stopped');
    }

    /** The first port from the base up that is free now and not promised to another session. */
    private static async reservePort(session: Session): Promise<number> {
        let from = CoreDeviceRunner.serveWebBasePort();
        for (;;) {
            const port = await portfinder.getPortPromise({ port: from });
            if (!CoreDeviceRunner.ports.has(port)) {
                CoreDeviceRunner.ports.set(port, session);
                return port;
            }
            from = port + 1;
        }
    }

    private static freePort(session: Session): void {
        if (CoreDeviceRunner.ports.get(session.port) === session) {
            CoreDeviceRunner.ports.delete(session.port);
        }
    }

    /** Marks the session failed and holds off the next start if the phone may need to recover. */
    private fail(session: Session, message: string): void {
        if (session.spawned) {
            this.cooldowns.set(session.udid, { until: Date.now() + CoreDeviceRunner.errorCooldownMs(), message });
        }
        this.setState(session, 'error', message);
    }

    private async bringUp(session: Session): Promise<void> {
        const { udid } = session;
        // Before anything reaches the phone: a helper without the current patches is not started.
        const stale = await PyMobileDevice.helperProblem();
        if (stale) {
            throw new Error(stale);
        }
        if (this.sessions.get(udid) !== session) {
            throw new Error('Session stopped');
        }
        // The Developer Disk Image hosts the display and HID daemons; it never survives a reboot
        // and the CLI treats "already mounted" as success. Developer Mode being off is the one
        // failure worth naming, because the fix is a toggle on the phone.
        const mount = await PyMobileDevice.runOneShot(['mounter', 'auto-mount', '--udid', udid], MOUNT_TIMEOUT_MS);
        if (mount.code !== 0) {
            if (isPasscodeLockout(mount.stderr)) {
                throw new Error(UNLOCK_BY_HAND_MESSAGE);
            }
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
        // `serve-web` has no --udid option (11.44.0, as in 11.12.5): the RSD dependency reads
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
        const info = CoreDeviceRunner.track(child, session);
        if (child.pid !== undefined) {
            // The process exists, so the phone is about to get a display session: count it.
            session.spawned = true;
            this.budget.record(udid);
        }
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
                // serve-web brings the tunnel up itself, so a phone that refuses it shows here.
                const reason = isPasscodeLockout(session.stderrTail)
                    ? UNLOCK_BY_HAND_MESSAGE
                    : PyMobileDevice.explain(session.stderrTail) || `The screen stream exited (${signal || code})`;
                if (this.sessions.get(udid) === session && session.child === child) {
                    // The failed session stays registered so the device card can show why; the
                    // next `acquire()` replaces it with a fresh process.
                    session.child = undefined;
                    this.fail(session, reason);
                }
                reject(new Error(reason));
            });
        });
        // A session stopped between two polls is nobody's to await; its exit is not an error.
        exitPromise.catch(() => undefined);
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
            if (reply) {
                // serve-web installs its handlers straight after the bind, before it serves a request.
                info.markSignalReady();
            }
            if (this.sessions.get(udid) !== session) {
                // Stopped while the request was out; a stop can now wait a while for serve-web.
                throw new Error('Session stopped');
            }
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

    // Overridable so test files that run in parallel, each with its own fake serve-web, do not
    // find the same port free at once and answer each other's requests.
    private static serveWebBasePort(): number {
        const override = Number(process.env.IOS_SERVE_WEB_BASE_PORT);
        return Number.isInteger(override) && override > 1024 && override < 65536 ? override : SERVE_WEB_BASE_PORT;
    }

    // Overridable so tests do not have to wait the full 25 s for the wedged-display path.
    private static displayWedgedTimeoutMs(): number {
        const override = Number(process.env.IOS_DISPLAY_WEDGED_TIMEOUT_MS);
        return Number.isFinite(override) && override > 0 ? override : DISPLAY_WEDGED_TIMEOUT_MS;
    }

    // Overridable so a test can see the bound without a 35 s preflight.
    private static signalReadyTimeoutMs(): number {
        const override = Number(process.env.IOS_SIGNAL_READY_TIMEOUT_MS);
        return Number.isFinite(override) && override > 0 ? override : SIGNAL_READY_TIMEOUT_MS;
    }

    // `IOS_SESSION_COOLDOWN_MS`: 0 turns the wait after a failed session off.
    private static errorCooldownMs(): number {
        const override = Number(process.env.IOS_SESSION_COOLDOWN_MS);
        return process.env.IOS_SESSION_COOLDOWN_MS && Number.isFinite(override) && override >= 0
            ? override
            : ERROR_COOLDOWN_MS;
    }

    private setState(session: Session, state: CoreDeviceSessionState, message?: string): void {
        session.state = state;
        session.message = message;
        if (state === 'error') {
            console.error(`${TAG} [${session.udid}] ${message}`);
        }
        this.emit('status', { udid: session.udid, state, message });
    }

    /** Follows one serve-web from spawn to `close`. */
    private static track(child: ChildProcess, session: Session): ChildInfo {
        let resolveSignalReady: () => void = () => undefined;
        const signalReady = new Promise<void>((resolve) => (resolveSignalReady = resolve));
        let markClosed: () => void = () => undefined;
        const closed = new Promise<void>((resolve) => (markClosed = resolve));
        const markSignalReady = () => {
            info.handlesSignals = true;
            resolveSignalReady();
        };
        const info: ChildInfo = {
            spawnedAt: Date.now(),
            handlesSignals: false,
            signalReady,
            markSignalReady,
            closed,
            stopRequested: false,
            signalled: false,
        };
        CoreDeviceRunner.children.set(child, info);
        let logTail = '';
        const watch = (data: Buffer | string) => {
            logTail = (logTail + data).slice(-256);
            if (SIGNAL_READY_PATTERN.test(logTail)) {
                markSignalReady();
            }
        };
        child.stdout?.on('data', watch);
        child.stderr?.on('data', watch);
        const gone = () => {
            CoreDeviceRunner.children.delete(child);
            // The port stays reserved until here: a serve-web that is shutting down still holds it.
            CoreDeviceRunner.freePort(session);
            markSignalReady();
            markClosed();
        };
        child.once('close', gone);
        child.once('error', () => {
            // A process that never started has no `close` to wait for.
            if (child.pid === undefined) {
                gone();
            }
        });
        return info;
    }

    /** Stops the session's serve-web and makes the phone's next start wait for it to close. */
    private stopChild(session: Session): void {
        const child = session.child;
        session.child = undefined;
        if (!child || !CoreDeviceRunner.children.has(child)) {
            return;
        }
        const { udid } = session;
        const closed = Promise.all([CoreDeviceRunner.stopping.get(udid), CoreDeviceRunner.kill(child)]).then(
            () => undefined,
        );
        CoreDeviceRunner.stopping.set(udid, closed);
        void closed.then(() => {
            if (CoreDeviceRunner.stopping.get(udid) === closed) {
                CoreDeviceRunner.stopping.delete(udid);
            }
        });
    }

    private static signal(child: ChildProcess, name: 'SIGTERM' | 'SIGKILL'): void {
        if (child.exitCode !== null || child.signalCode !== null) {
            return;
        }
        const pid = child.pid;
        try {
            if (pid && process.platform !== 'win32') {
                process.kill(-pid, name);
            } else {
                child.kill(name);
            }
        } catch {
            // Already gone.
        }
    }

    /**
     * Asks serve-web to shut down and resolves when it has closed. SIGTERM is held back until the
     * process handles it (see SIGNAL_READY_TIMEOUT_MS); SIGKILL follows only after the grace.
     */
    private static kill(child: ChildProcess): Promise<void> {
        const info = CoreDeviceRunner.children.get(child);
        if (!info) {
            return Promise.resolve();
        }
        if (info.stopRequested) {
            return info.closed;
        }
        info.stopRequested = true;
        let wait: NodeJS.Timeout | undefined;
        let force: NodeJS.Timeout | undefined;
        const terminate = () => {
            clearTimeout(wait);
            if (info.signalled || !CoreDeviceRunner.children.has(child)) {
                return;
            }
            info.signalled = true;
            CoreDeviceRunner.signal(child, 'SIGTERM');
            force = setTimeout(() => CoreDeviceRunner.signal(child, 'SIGKILL'), SIGKILL_GRACE_MS);
        };
        if (info.handlesSignals) {
            terminate();
        } else {
            wait = setTimeout(
                terminate,
                Math.max(0, info.spawnedAt + CoreDeviceRunner.signalReadyTimeoutMs() - Date.now()),
            );
            void info.signalReady.then(terminate);
        }
        void info.closed.then(() => {
            clearTimeout(wait);
            clearTimeout(force);
        });
        return info.closed;
    }

    /**
     * Node is exiting with serve-web still running: a crash, or the shutdown deadline. SIGTERM
     * lets each one return the phone's sessions on its own; SIGKILL here would leak them all.
     */
    private static onProcessExit = (): void => {
        for (const [child, info] of CoreDeviceRunner.children) {
            if (!info.signalled) {
                info.signalled = true;
                CoreDeviceRunner.signal(child, 'SIGTERM');
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
