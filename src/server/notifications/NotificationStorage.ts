import fs from 'fs';
import path from 'path';
import webpush, { PushSubscription } from 'web-push';
import { NotificationSource, NotificationHistoryItem } from '../../common/Notification';

export interface SubscriptionRecord {
    id: string;
    subscription: PushSubscription;
    sources: string[];
    receiverSource: string;
    updated: number;
}
export interface NotificationStore {
    vapid: { publicKey: string; privateKey: string };
    sources: NotificationSource[];
    subscriptions: SubscriptionRecord[];
}
export interface FeedItem extends NotificationHistoryItem {
    fingerprint?: string;
    reconnectable: boolean;
}

/** Owns atomic private-file writes and the single debounced history save. */
export class NotificationStorage {
    private timer?: NodeJS.Timeout;
    private pending?: () => FeedItem[];
    constructor(
        readonly directory: string,
        private readonly onError: (message: string) => void,
    ) {}

    private read(name: string): unknown {
        const file = path.join(this.directory, name);
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
    }
    private write(name: string, value: unknown): void {
        const file = path.join(this.directory, name);
        fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
    }
    load(): NotificationStore {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const existing = this.read('notifications.json') as NotificationStore | undefined;
        const store: NotificationStore = {
            vapid: existing?.vapid || webpush.generateVAPIDKeys(),
            sources: existing?.sources || [],
            subscriptions: existing?.subscriptions || [],
        };
        if (!existing || 'token' in existing) this.save(store);
        // Remove obsolete app credentials while preserving push keys and device settings.
        fs.rmSync(path.join(this.directory, 'notification-setup-key'), { force: true });
        return store;
    }
    save(store: NotificationStore): void {
        this.write('notifications.json', store);
    }
    loadHistory(sources: NotificationSource[]): FeedItem[] {
        try {
            const history = this.read('notification-history.json') as { items?: FeedItem[] } | undefined;
            if (!history) return [];
            if (!Array.isArray(history.items)) throw Error('Invalid history');
            return history.items.flatMap((item) => {
                const source = sources.find((candidate) => candidate.id === item?.source);
                if (
                    !source ||
                    typeof item.key !== 'string' ||
                    typeof item.session !== 'string' ||
                    !Number.isInteger(item.uid) ||
                    !Number.isFinite(item.received)
                )
                    return [];
                return [
                    {
                        ...item,
                        active: false,
                        read: !!item.read,
                        dismissed: !!item.dismissed,
                        ...(!source.preview ? { title: '', subtitle: '', body: '' } : {}),
                    },
                ];
            });
        } catch {
            this.onError('Notification history could not be loaded');
            return [];
        }
    }
    saveHistory(snapshot: () => FeedItem[], immediate = false): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.pending = snapshot;
        if (immediate) this.flush();
        else
            this.timer = setTimeout(() => {
                try {
                    this.flush();
                } catch {
                    this.onError('Notification history could not be saved');
                }
            }, 200);
    }
    flush(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        if (!this.pending) return;
        this.write('notification-history.json', { version: 1, items: this.pending() });
        this.pending = undefined;
    }
}
