import net from 'net';
import { Broadcast } from './Broadcast';

class BroadcastManager {
    private broadcasts: Map<string, Broadcast> = new Map();

    async startBroadcast(udid: string, port: number): Promise<void> {
        if (this.broadcasts.has(udid)) return;

        const socket = net.connect({ host: '127.0.0.1', port });

        return new Promise((resolve, reject) => {
            socket.once('connect', () => {
                console.log("Connected to scrcpy")
                const broadcast = new Broadcast(socket);
                this.broadcasts.set(udid, broadcast);
                resolve();
            });

            socket.once('error', (err) => {
                reject(err);
            });
        });
    }

    getBroadcast(udid: string): Broadcast | undefined {
        return this.broadcasts.get(udid);
    }

    stopBroadcast(udid: string): void {
        const b = this.broadcasts.get(udid);
        if (!b) return;

        b.stop();
        this.broadcasts.delete(udid);
    }

    hasBroadcast(udid: string): boolean {
        return this.broadcasts.has(udid);
    }
}

export const broadcastManager = new BroadcastManager();
