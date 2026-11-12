import { getSettings } from '../Settings';
import webpush, { PushSubscription } from 'web-push';

/**
 * A relayed phone alert is also kept in the history, so its push may expire quickly. A system
 * alert (a failed scheduled unlock, for example) is shown nowhere else unless the owner goes
 * looking, so the push service holds it for a day and wakes a dozing phone for it.
 */
export type PushKind = 'relay' | 'system';
const DELIVERY: Record<PushKind, { lifetimeMs: number; urgency: 'normal' | 'high' }> = {
    relay: { lifetimeMs: 5 * 60000, urgency: 'normal' },
    system: { lifetimeMs: 24 * 3600000, urgency: 'high' },
};
// Per subscription and per kind, so a burst of relayed alerts cannot push a system alert out.
const MAX_QUEUED = 50;

interface Job {
    key: string;
    kind: PushKind;
    testPayload?: string;
    expires: number;
}
export interface PushTarget {
    subscription: PushSubscription;
    payload: string;
    vapid: { publicKey: string; privateKey: string };
}

/** The provider refused the server's own credentials: no subscription is at fault. */
function senderRejected(error: unknown): boolean {
    const { statusCode, body } = error as { statusCode?: number; body?: string };
    if (statusCode === 403 && typeof body === 'string' && body.length < 2048) {
        try {
            return JSON.parse(body)?.reason === 'BadJwtToken';
        } catch {
            /* Never expose raw provider responses. */
        }
    }
    return false;
}

function failureMessage(error: unknown): string {
    if (senderRejected(error))
        return 'Push provider rejected the server’s sender credentials (403: BadJwtToken). Check WS_PUSH_SUBJECT and the server clock.';
    return `Push provider rejected delivery (${(error as { statusCode?: number }).statusCode || 'network error'})`;
}

/**
 * A provider answers 400 or 403 for a subscription it will never accept from this server, for
 * example one created for VAPID keys that were since replaced. After this many such replies in
 * a row the subscription is removed, as it is at once for 404 and 410.
 */
export const MAX_REJECTIONS = 3;

/** What happened to the pushes for one subscription since the server started. */
export interface SubscriptionDelivery {
    sent: number;
    failed: number;
    lastError: string;
}

/** Queue identities, then resolve content and eligibility immediately before each send. */
export class PushDelivery {
    private queues = new Map<string, Job[]>();
    private waiting = new Map<NodeJS.Timeout, () => void>();
    private closed = false;
    // Kept per subscription, so a success on one device cannot hide the failures of another.
    private deliveries = new Map<string, SubscriptionDelivery & { rejections: number }>();
    private removed = { sent: 0, failed: 0 };
    // A fault of the server's own configuration; it applies to every subscription.
    private senderError = '';

    constructor(
        private readonly resolve: (id: string, key: string, testPayload?: string) => PushTarget | undefined,
        private readonly expired: (id: string, subscription: PushSubscription) => void,
    ) {}

    get pending(): number {
        return this.queues.size;
    }

    /** Totals for all subscriptions, and the first error that still stands. */
    get stats(): SubscriptionDelivery {
        const totals = { ...this.removed, lastError: this.senderError };
        for (const delivery of this.deliveries.values()) {
            totals.sent += delivery.sent;
            totals.failed += delivery.failed;
            totals.lastError ||= delivery.lastError;
        }
        return totals;
    }

    statsFor(id: string): SubscriptionDelivery {
        const { sent = 0, failed = 0, lastError = '' } = this.deliveries.get(id) || {};
        return { sent, failed, lastError };
    }

    /** Call when a subscription is removed. Its counts stay in the totals. */
    forget(id: string): void {
        const delivery = this.deliveries.get(id);
        if (!delivery) return;
        this.removed.sent += delivery.sent;
        this.removed.failed += delivery.failed;
        this.deliveries.delete(id);
    }

    private delivery(id: string): SubscriptionDelivery & { rejections: number } {
        let delivery = this.deliveries.get(id);
        if (!delivery) {
            delivery = { sent: 0, failed: 0, lastError: '', rejections: 0 };
            this.deliveries.set(id, delivery);
        }
        return delivery;
    }

    enqueue(id: string, key: string, testPayload?: string, kind: PushKind = 'relay'): void {
        if (this.closed) return;
        const existing = this.queues.get(id);
        const queue = existing || [];
        const sameKind = queue.filter((job) => job.kind === kind);
        if (sameKind.length >= MAX_QUEUED) queue.splice(queue.indexOf(sameKind[0]), 1);
        queue.push({ key, kind, testPayload, expires: Date.now() + DELIVERY[kind].lifetimeMs });
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
                    const subject = getSettings().pushSubject;
                    if (!subject) {
                        this.delivery(id).failed++;
                        this.senderError = 'Set WS_PUBLIC_URL or WS_PUSH_SUBJECT to configure the push sender.';
                        break;
                    }
                    this.senderError = '';
                    try {
                        await webpush.sendNotification(target.subscription, target.payload, {
                            TTL: Math.max(1, Math.floor((job.expires - Date.now()) / 1000)),
                            urgency: DELIVERY[job.kind].urgency,
                            timeout: 10000,
                            vapidDetails: { subject, ...target.vapid },
                        });
                        Object.assign(this.delivery(id), { lastError: '', rejections: 0 }).sent++;
                        break;
                    } catch (error) {
                        if (this.closed || this.queues.get(id) !== queue) break;
                        const status = (error as { statusCode?: number }).statusCode;
                        if (status === 404 || status === 410) {
                            this.expired(id, target.subscription);
                            this.forget(id);
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
                            const delivery = this.delivery(id);
                            delivery.failed++;
                            delivery.lastError = failureMessage(error);
                            if ((status === 400 || status === 403) && !senderRejected(error)) {
                                if (++delivery.rejections >= MAX_REJECTIONS) {
                                    this.expired(id, target.subscription);
                                    this.forget(id);
                                }
                            } else delivery.rejections = 0;
                            break;
                        }
                    }
                }
            }
        } catch {
            const delivery = this.delivery(id);
            delivery.failed++;
            delivery.lastError = 'Notification delivery could not be completed.';
        } finally {
            if (this.queues.get(id) === queue) this.queues.delete(id);
        }
    }
}
