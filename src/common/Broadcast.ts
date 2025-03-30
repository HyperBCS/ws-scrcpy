import { Socket } from 'net';

type DataCallback = (data: Buffer) => void;

export class Broadcast {
    private socket: Socket;
    private listeners: Set<DataCallback> = new Set();

    constructor(socket: Socket) {
        this.socket = socket;

        this.socket.on('data', (chunk: Buffer) => {
            for (const cb of this.listeners) {
                try {
                    cb(chunk);
                } catch (err) {
                    console.error('Broadcast callback error:', err);
                }
            }
        });

        this.socket.on('error', (err) => {
            console.error('Broadcast socket error:', err);
        });

        this.socket.on('end', () => {
            console.log("Broadcast ended")
            this.listeners.clear();
        });
    }

    addListener(fn: DataCallback): void {
        this.listeners.add(fn);
    }

    removeListener(fn: DataCallback): void {
        this.listeners.delete(fn);
    }

    stop(): void {
        this.socket.destroy();
        this.listeners.clear();
    }
}
