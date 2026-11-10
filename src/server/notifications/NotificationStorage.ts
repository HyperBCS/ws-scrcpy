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

const STORE_FILE = 'notifications.json';

/** load() could not use the settings file. `message` is written for the Setup page. */
export class NotificationStoreError extends Error {}

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
    /**
     * Without the fsyncs a power loss shortly after the rename can leave an empty file under the
     * final name: the rename may reach the disk before the data does.
     */
    private write(name: string, value: unknown): void {
        const file = path.join(this.directory, name);
        const descriptor = fs.openSync(file + '.tmp', 'w', 0o600);
        try {
            fs.writeFileSync(descriptor, JSON.stringify(value));
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        fs.renameSync(file + '.tmp', file);
        try {
            const directory = fs.openSync(this.directory, 'r');
            try {
                fs.fsyncSync(directory);
            } finally {
                fs.closeSync(directory);
            }
        } catch {
            // Some filesystems cannot sync a directory. The file itself is already on disk.
        }
    }
    private readStore(): NotificationStore | undefined {
        const file = path.join(this.directory, STORE_FILE);
        let text: string;
        try {
            if (!fs.existsSync(file)) return undefined;
            text = fs.readFileSync(file, 'utf8');
        } catch {
            // The file may be intact (wrong owner, failing disk), so it stays where it is.
            throw new NotificationStoreError(
                `Notifications are off: ${STORE_FILE} could not be read. Check the data directory, then restart the server.`,
            );
        }
        try {
            const value = JSON.parse(text) as Partial<NotificationStore> | null;
            const { vapid, sources = [], subscriptions = [] } = value || {};
            // Startup reads every record's id outside any error handling, so check each one.
            const hasId = (record: unknown) =>
                !!record && typeof record === 'object' && typeof (record as { id?: unknown }).id === 'string';
            if (
                !value ||
                typeof value !== 'object' ||
                Array.isArray(value) ||
                !Array.isArray(sources) ||
                !Array.isArray(subscriptions) ||
                !sources.every(hasId) ||
                !subscriptions.every(hasId) ||
                (vapid !== undefined && (typeof vapid?.publicKey !== 'string' || typeof vapid.privateKey !== 'string'))
            )
                throw Error('Invalid settings');
            return value as NotificationStore;
        } catch {
            // Keep the damaged file for repair by hand. Writing a new one in its place would
            // replace the push keys and drop every paired phone and subscription.
            const kept = `${STORE_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
            try {
                fs.renameSync(file, path.join(this.directory, kept));
            } catch {
                throw new NotificationStoreError(
                    `Notifications are off: ${STORE_FILE} is damaged and could not be moved aside. Repair or remove it, then restart the server.`,
                );
            }
            throw new NotificationStoreError(
                `Notifications are off: ${STORE_FILE} is damaged and was kept as ${kept}. Restart the server to begin with new settings, or repair that file and put it back first.`,
            );
        }
    }
    /** Throws `NotificationStoreError` when the settings exist but cannot be used. */
    load(): NotificationStore {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const existing = this.readStore();
        const store: NotificationStore = {
            vapid: existing?.vapid || webpush.generateVAPIDKeys(),
            sources: existing?.sources || [],
            subscriptions: existing?.subscriptions || [],
        };
        if (!existing || 'token' in existing) this.save(store);
        try {
            // Remove obsolete app credentials while preserving push keys and device settings.
            fs.rmSync(path.join(this.directory, 'notification-setup-key'), { force: true });
        } catch {
            /* Cleanup only. */
        }
        return store;
    }
    save(store: NotificationStore): void {
        this.write(STORE_FILE, store);
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
