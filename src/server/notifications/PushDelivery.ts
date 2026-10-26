import webpush, { PushSubscription } from 'web-push';

interface Job {
    key: string;
    testPayload?: string;
    expires: number;
}
export interface PushTarget {
    subscription: PushSubscription;
    payload: string;
    vapid: { publicKey: string; privateKey: string };
}

function failureMessage(error: unknown): string {
    const { statusCode, body } = error as { statusCode?: number; body?: string };
    if (statusCode === 403 && typeof body === 'string' && body.length < 2048) {
        try {
            if (JSON.parse(body)?.reason === 'BadJwtToken')
                return 'Push provider rejected the server’s sender credentials (403: BadJwtToken). Check WS_PUSH_SUBJECT and the server clock.';
        } catch {
            /* Never expose raw provider responses. */
        }
    }
    return `Push provider rejected delivery (${statusCode || 'network error'})`;
}

/** Queue identities, then resolve content and eligibility immediately before each send. */
export class PushDelivery {
    readonly stats = { sent: 0, failed: 0, lastError: '' };
    private queues = new Map<string, Job[]>();
    private waiting = new Map<NodeJS.Timeout, () => void>();
    private closed = false;

    constructor(
        private readonly resolve: (id: string, key: string, testPayload?: string) => PushTarget | undefined,
        private readonly expired: (id: string, subscription: PushSubscription) => void,
    ) {}

    get pending(): number {
        return this.queues.size;
    }

    enqueue(id: string, key: string, testPayload?: string): void {
        if (this.closed) return;
        const existing = this.queues.get(id);
        const queue = existing || [];
        if (queue.length >= 50) queue.shift();
        queue.push({ key, testPayload, expires: Date.now() + 300000 });
        if (!existing) {
            this.queues.set(id, queue);
            void this.drain(id, queue);
        }
    }

    start(): void {
        this.closed = false;
    }

    stop(): void {
        this.closed = true;
        this.queues.clear();
        for (const [timer, resolve] of this.waiting) {
            clearTimeout(timer);
            resolve();
        }
        this.waiting.clear();
    }

    private wait(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.waiting.delete(timer);
                resolve();
            }, ms);
            this.waiting.set(timer, resolve);
        });
    }

    private async drain(id: string, queue: Job[]): Promise<void> {
        try {
            while (!this.closed && this.queues.get(id) === queue && queue.length) {
                const job = queue.shift()!;
                for (let attempt = 0; attempt < 3 && Date.now() < job.expires; attempt++) {
                    if (this.closed || this.queues.get(id) !== queue) break;
                    const target = this.resolve(id, job.key, job.testPayload);
                    if (!target) break;
                    const subject = process.env.WS_PUSH_SUBJECT || process.env.WS_PUBLIC_URL;
                    if (!subject) {
                        this.stats.failed++;
                        this.stats.lastError = 'Set WS_PUBLIC_URL or WS_PUSH_SUBJECT to configure the push sender.';
                        break;
                    }
                    try {
                        await webpush.sendNotification(target.subscription, target.payload, {
                            TTL: Math.max(1, Math.floor((job.expires - Date.now()) / 1000)),
                            urgency: 'normal',
                            timeout: 10000,
                            vapidDetails: { subject, ...target.vapid },
                        });
                        this.stats.sent++;
                        this.stats.lastError = '';
                        break;
                    } catch (error) {
                        if (this.closed || this.queues.get(id) !== queue) break;
                        const status = (error as { statusCode?: number }).statusCode;
                        if (status === 404 || status === 410) {
                            this.expired(id, target.subscription);
                            break;
                        }
                        if ((status === 429 || !status || status >= 500) && attempt < 2) {
                            const raw = (error as { headers?: Record<string, string> }).headers?.['retry-after'];
                            const delay = raw
                                ? Number.isFinite(Number(raw))
                                    ? Number(raw) * 1000
                                    : Date.parse(raw) - Date.now()
                                : 1000 * 2 ** attempt;
                            await this.wait(Math.min(30000, Math.max(1000, delay || 1000)));
                        } else {
                            this.stats.failed++;
                            this.stats.lastError = failureMessage(error);
                            break;
                        }
                    }
                }
            }
        } catch {
            this.stats.failed++;
            this.stats.lastError = 'Notification delivery could not be completed.';
        } finally {
            if (this.queues.get(id) === queue) this.queues.delete(id);
        }
    }
}
