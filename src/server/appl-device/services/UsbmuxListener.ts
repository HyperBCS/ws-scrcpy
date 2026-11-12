import { getSettings } from '../../Settings';
import * as net from 'net';
import { TypedEmitter } from '../../../common/TypedEmitter';

const TAG = '[UsbmuxListener]';
const HEADER_BYTES = 16;
const PLIST_MESSAGE = 8;
// Far above any real message; a length beyond it means the stream is not usbmuxd's.
const MAX_MESSAGE_BYTES = 1024 * 1024;
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 60000;

const LISTEN_REQUEST =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>' +
    '<key>MessageType</key><string>Listen</string>' +
    '<key>ClientVersionString</key><string>ws-scrcpy</string>' +
    '<key>ProgName</key><string>ws-scrcpy</string>' +
    '<key>kLibUSBMuxVersion</key><integer>3</integer>' +
    '</dict></plist>';

export interface UsbmuxListenerEvents {
    // A device was attached, detached or paired. Which one is not reported: the tracker reads the list again.
    change: undefined;
    // The feed started or stopped; `isReady()` has the new value.
    ready: boolean;
}

/**
 * usbmuxd's own feed of device changes, in place of asking for the device list every 3 s.
 *
 * One connection to usbmuxd's socket and one `Listen` request; from then on usbmuxd sends a
 * message whenever a device is attached, detached or paired. The messages are used only as a
 * signal that something changed. What is attached is still read with `usbmux list`, so nothing
 * here decides whether a phone is shown, and a feed that goes quiet costs a slower update, not a
 * wrong list. While the feed is up the tracker polls rarely; without it (no socket, a refused
 * request, `IOS_USBMUX_LISTEN=0`) it polls as before.
 *
 * `IOS_USBMUXD_SOCKET` names another socket path. Windows reaches usbmuxd over TCP and is left
 * on polling.
 */
export class UsbmuxListener extends TypedEmitter<UsbmuxListenerEvents> {
    private socket?: net.Socket;
    private buffer: Buffer = Buffer.alloc(0);
    private ready = false;
    private stopped = true;
    private retryMs = RETRY_MIN_MS;
    private retryTimer?: NodeJS.Timeout;
    private failureLogged = false;

    public static isEnabled(): boolean {
        return getSettings().iosUsbmuxListen && process.platform !== 'win32';
    }

    public static socketPath(): string {
        return getSettings().iosUsbmuxSocket;
    }

    /** Whether usbmuxd accepted the `Listen` request and the connection is still open. */
    public isReady(): boolean {
        return this.ready;
    }

    public start(): void {
        if (!this.stopped || !UsbmuxListener.isEnabled()) {
            return;
        }
        this.stopped = false;
        this.connect();
    }

    public stop(): void {
        this.stopped = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        this.socket?.destroy();
        this.socket = undefined;
        this.ready = false;
    }

    private connect(): void {
        if (this.stopped) {
            return;
        }
        const socket = net.createConnection(UsbmuxListener.socketPath());
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        socket.on('connect', () => {
            const payload = Buffer.from(LISTEN_REQUEST, 'utf8');
            const header = Buffer.alloc(HEADER_BYTES);
            header.writeUInt32LE(HEADER_BYTES + payload.length, 0);
            header.writeUInt32LE(1, 4);
            header.writeUInt32LE(PLIST_MESSAGE, 8);
            header.writeUInt32LE(1, 12);
            socket.write(Buffer.concat([header, payload]));
        });
        socket.on('data', (chunk: Buffer) => {
            if (this.socket === socket) {
                this.onData(socket, chunk);
            }
        });
        // 'close' follows 'error'; the retry is arranged there.
        socket.on('error', (error: Error) => this.logFailure(error.message));
        socket.on('close', () => {
            if (this.socket !== socket) {
                return;
            }
            this.socket = undefined;
            this.setReady(false);
            if (this.stopped) {
                return;
            }
            const delay = this.retryMs;
            this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
            this.retryTimer = setTimeout(() => {
                this.retryTimer = undefined;
                this.connect();
            }, delay);
        });
    }

    private onData(socket: net.Socket, chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= HEADER_BYTES) {
            const length = this.buffer.readUInt32LE(0);
            if (length < HEADER_BYTES || length > MAX_MESSAGE_BYTES) {
                this.logFailure('unexpected data from usbmuxd');
                socket.destroy();
                return;
            }
            if (this.buffer.length < length) {
                return;
            }
            const body = this.buffer.subarray(HEADER_BYTES, length).toString('utf8');
            this.buffer = this.buffer.subarray(length);
            this.onMessage(socket, body);
        }
    }

    private onMessage(socket: net.Socket, body: string): void {
        const type = /<key>MessageType<\/key>\s*<string>([^<]*)<\/string>/.exec(body)?.[1];
        if (type === 'Result') {
            const code = /<key>Number<\/key>\s*<integer>(\d+)<\/integer>/.exec(body)?.[1];
            if (code !== '0') {
                this.logFailure(`usbmuxd refused the Listen request (${code ?? 'no result code'})`);
                socket.destroy();
                return;
            }
            this.retryMs = RETRY_MIN_MS;
            this.failureLogged = false;
            this.setReady(true);
            return;
        }
        if (this.ready && type) {
            this.emit('change', undefined);
        }
    }

    private setReady(ready: boolean): void {
        if (this.ready !== ready) {
            this.ready = ready;
            this.emit('ready', ready);
        }
    }

    /** Once per outage: a host without usbmuxd would otherwise log on every retry. */
    private logFailure(message: string): void {
        if (!this.failureLogged) {
            this.failureLogged = true;
            console.error(`${TAG} ${message}; polling for iPhones instead`);
        }
    }
}
