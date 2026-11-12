import net from 'net';
import { Broadcast, BroadcastAudioOptions } from './Broadcast';

class BroadcastManager {
    private broadcasts: Map<string, Broadcast> = new Map();

    /**
     * @param audioEnabled Must match the `audio=` value the scrcpy server was launched with for
     *     this `udid` (see StreamConfig / buildScrcpyArgs). scrcpy opens its sockets in a fixed
     *     order - video, then audio **only when enabled**, then control (confirmed against the
     *     scrcpy developer docs: "Up to three sockets are opened for video, audio, and control,
     *     depending on the enabled features. If a feature is disabled, the corresponding socket
     *     is omitted." - https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md). Get
     *     this wrong and the socket this code thinks is `control` is actually `audio` (or vice
     *     versa): input silently goes nowhere, or a client's control writes land on the audio
     *     stream. With `audioEnabled: false` this opens exactly the same two sockets, in the
     *     same order, as before audio support existed.
     */
    async startBroadcast(
        udid: string,
        port: number,
        audioEnabled: boolean,
        audioOptions?: BroadcastAudioOptions,
        signal?: AbortSignal,
    ): Promise<Broadcast | undefined> {
        signal?.throwIfAborted();
        if (this.broadcasts.has(udid)) return this.broadcasts.get(udid);

        const endpoint = { host: '127.0.0.1', port };
        const socket = net.connect(endpoint);
        const audio = audioEnabled ? net.connect(endpoint) : undefined;
        const control = net.connect(endpoint);
        const sockets = audio ? [socket, audio, control] : [socket, control];

        return new Promise((resolve, reject) => {
            let settled = false;

            // Until the Broadcast takes ownership of every socket, a failure of any one of them
            // has to destroy the rest: an unattended net.Socket re-throws its 'error' as an
            // uncaught exception, and the surviving sockets would otherwise leak their fds.
            const cleanup = (failed = true) => {
                signal?.removeEventListener('abort', onAbort);
                socket.off('connect', onConnect);
                if (failed) {
                    control.off('connect', onControlConnect);
                    audio?.off('connect', onAudioConnect);
                }
                sockets.forEach((s) => s.off('error', onStartupError));
            };
            const onStartupError = (err: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                // Destroyed sockets may still report an already queued error. Keep it handled.
                sockets.forEach((s) => {
                    s.on('error', () => undefined);
                    s.destroy();
                });
                reject(err);
            };

            const onAbort = () => onStartupError(signal?.reason ?? Error('The stream start was cancelled.'));
            sockets.forEach((s) => s.once('error', onStartupError));

            const onControlConnect = () => {
                console.log(`Connected to control server at 127.0.0.1:${port}`);
            };
            const onAudioConnect = () => {
                console.log(`Connected to audio server at 127.0.0.1:${port}`);
            };

            const onConnect = () => {
                if (settled) return;
                settled = true;
                cleanup(false);

                console.log('Connected to scrcpy');
                // Pass the instance, not just the udid: a Broadcast that is already orphaned
                // (replaced by a reconnect) must not tear down whichever one currently owns
                // the key. See the identity check in stopBroadcast.
                const broadcast: Broadcast = new Broadcast(
                    socket,
                    control,
                    audio,
                    () => this.stopBroadcast(udid, broadcast),
                    audioOptions,
                );
                this.broadcasts.set(udid, broadcast);
                resolve(broadcast);
            };
            control.once('connect', onControlConnect);
            audio?.once('connect', onAudioConnect);
            socket.once('connect', onConnect);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
        });
    }

    getBroadcast(udid: string): Broadcast | undefined {
        return this.broadcasts.get(udid);
    }

    /**
     * @param only when given, stop the broadcast only if it is still the one registered for
     *             `udid`. A self-initiated teardown passes itself so a stale instance cannot
     *             destroy the live stream that replaced it.
     */
    stopBroadcast(udid: string, only?: Broadcast): void {
        const b = this.broadcasts.get(udid);
        if (!b) {
            // Still stop an orphan so its sockets are released even though it owns no key.
            only?.stop();
            return;
        }
        if (only && b !== only) {
            only.stop();
            return;
        }

        this.broadcasts.delete(udid);
        b.stop();
    }

    hasBroadcast(udid: string): boolean {
        return this.broadcasts.has(udid);
    }
}

export const broadcastManager = new BroadcastManager();
