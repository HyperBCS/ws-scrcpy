import { Express } from 'express';
import crypto from 'crypto';
import { Service } from '../services/Service';
import { NotificationIcons } from './NotificationIcons';
import { CollectorProcess } from './CollectorProcess';
import { NotificationRoutes } from './NotificationRoutes';
export { validateSubscription } from './NotificationRoutes';
import { resolveDataDir } from '../dataDir';

import { NotificationEvent, NotificationHistoryItem } from '../../common/Notification';
import { PushDelivery, PushTarget } from './PushDelivery';
import { HISTORY_MS, NotificationFeed, shouldRelay } from './NotificationFeed';
export type { NotificationEvent, NotificationSource } from '../../common/Notification';
export { shouldRelay, textFingerprint, reducedFingerprint } from './NotificationFeed';

import {
    NotificationStorage,
    NotificationStore as Store,
    NotificationStoreError,
    FeedItem,
} from './NotificationStorage';
export type { FeedItem } from './NotificationStorage';

// The collector's pairing window (`pair_until` in collector.py).
const PAIRING_WINDOW_MS = 120000;
// How long the setup page explains a pairing request that arrived with no window open.
const PAIRING_REJECTED_NOTICE_MS = 10 * 60000;
// The collector reports every two seconds and the Setup page reads the status every five. A
// collector error stays until the collector has reported for this long without a new one.
const COLLECTOR_ERROR_HOLD_MS = 30000;
const sentences = (parts: string[]): string =>
    parts
        .filter(Boolean)
        .map((part) => part.replace(/\.$/, ''))
        .join('. ');

/**
 * A push the server sends on its own behalf (a failed scheduled unlock, for example), not a
 * relayed phone notification. Same fields the service worker reads from a relayed push.
 */
export interface SystemPushPayload {
    title: string;
    body: string;
    // Collapses repeats of the same event in the browser, e.g. `ios-unlock-<udid>`.
    tag: string;
    // Location hash to open, e.g. `#!action=`.
    url: string;
}

export class NotificationService implements Service {
    private static instance?: NotificationService;
    static getInstance(): NotificationService {
        return this.instance ?? (this.instance = new NotificationService());
    }
    static hasInstance(): boolean {
        return !!this.instance;
    }
    private dataDir = resolveDataDir();
    private storage = new NotificationStorage(
        this.dataDir,
        (message) => {
            this.storageError = message;
            console.error(`[NotificationService] ${message}`);
        },
        () => {
            this.storageError = '';
        },
    );
    private icons = new NotificationIcons(this.dataDir);
    private sessions = new Map<string, string>();
    private actions = new Map<
        string,
        {
            key: string;
            source: string;
            session: string;
            uid: number;
            timer: NodeJS.Timeout;
            resolve: () => void;
            reject: (error: Error) => void;
        }
    >();
    private store!: Store;
    private routes?: NotificationRoutes;
    private closed = false;
    private loaded = false;
    // Receive, replay, pruning and counts. NotificationRoutes changes its items in place.
    private readonly notificationFeed = new NotificationFeed();
    private get feed(): Map<string, FeedItem> {
        return this.notificationFeed.items;
    }
    private get observed(): Map<string, number> {
        return this.notificationFeed.observed;
    }
    private get replayCandidates(): NotificationFeed['replayCandidates'] {
        return this.notificationFeed.replayCandidates;
    }
    private statuses: Record<string, string> = {};
    private bluetooth: unknown[] = [];
    private pairing: { address: string; code: string } | null = null;
    private pairingOpen = false;
    // When the window opened by Start Bluetooth pairing ends; outlives collector restarts.
    private pairUntil = 0;
    private pairingRejectedAt = 0;
    // Three separate causes, so that a healthy collector report cannot clear a storage or pairing
    // problem. The Setup page shows them joined as `error`.
    // Cleared once the collector has reported for COLLECTOR_ERROR_HOLD_MS without a new error.
    private collectorError = '';
    private collectorErrorAt = 0;
    // Cleared by the next history save that succeeds.
    private storageError = '';
    // Kept for PAIRING_REJECTED_NOTICE_MS, or until pairing is started again.
    private pairingError: { message: string; at: number } | null = null;
    private collector = new CollectorProcess({
        commands: () => this.startCommands(),
        started: () => {
            this.statuses = Object.fromEntries(
                this.store.sources.map((source) => [source.id, 'Waiting for Bluetooth connection']),
            );
        },
        message: (message) => this.handleCollector(message),
        fault: (message) => this.collectorFault(message),
        stderr: (started) => {
            // A self-reported error says more than a traceback from the same process.
            if (this.collectorError && this.collectorErrorAt >= started) this.collectorErrorAt = Date.now();
            else this.collectorFault('Bluetooth collector failed; check host BlueZ and D-Bus access');
        },
        stopped: (expected, started) => {
            this.invalidateSources();
            this.pairing = null;
            this.pairingOpen = false;
            if (!expected && (!this.collectorError || this.collectorErrorAt < started))
                this.collectorFault('Bluetooth collector stopped');
        },
    });
    // Set when the settings file cannot be used. The service then keeps an empty store in memory,
    // reads and writes nothing, and answers every change with this text.
    private disabled = '';
    private push = new PushDelivery(
        (id, key, testPayload) => this.preparePush(id, key, testPayload),
        (id, subscription) => {
            this.store.subscriptions = this.store.subscriptions.filter(
                (s) => s.id !== id || s.subscription !== subscription,
            );
            this.save();
        },
    );
    private get delivery() {
        return this.push.stats;
    }

    getName(): string {
        return 'Bluetooth notifications and Web Push';
    }
    private load(): void {
        if (this.loaded) return;
        this.loaded = true;
        try {
            this.store = this.storage.load();
        } catch (error) {
            // One optional settings file must not stop the server: HttpServer mounts this
            // service before it listens, so a throw here used to fail the whole startup.
            this.disabled =
                error instanceof NotificationStoreError
                    ? error.message
                    : 'Notifications are off: the notification settings could not be loaded or saved. Check the data directory, then restart the server.';
            this.store = { vapid: { publicKey: '', privateKey: '' }, sources: [], subscriptions: [] };
            console.error(`[NotificationService] ${this.disabled}`);
            return;
        }
        const redacted = this.notificationFeed.load(this.storage.loadHistory(this.store.sources), this.store.sources);
        this.prune();
        if (redacted) this.saveHistory();
    }
    private saveHistory(immediate = false): void {
        if (this.disabled) return;
        try {
            this.storage.saveHistory(() => [...this.feed.values()], immediate);
        } catch (error) {
            this.storageError = 'Notification history could not be saved';
            throw error;
        }
    }
    private save(): void {
        if (this.disabled) return;
        this.storage.save(this.store);
    }
    async start(): Promise<void> {
        this.load();
        if (this.disabled) return;
        this.closed = false;
        this.push.start();
        this.collector.resume();
    }
    release(): void {
        this.closed = true;
        this.invalidateSources();
        try {
            this.storage.flush();
        } catch {
            // A full or read-only disk must not keep the collector and the push queue running.
            this.storageError = 'Notification history could not be saved';
        }
        this.collector.release();
        this.pairing = null;
        this.pairingOpen = false;
        this.push.stop();
    }
    private command(command: object): Promise<void> {
        return this.collector.command(command);
    }
    private collectorFault(message: string): void {
        this.collectorError = message;
        this.collectorErrorAt = Date.now();
    }
    private recentPairingError(): { message: string; at: number } | null {
        return this.pairingError && Date.now() - this.pairingError.at < PAIRING_REJECTED_NOTICE_MS
            ? this.pairingError
            : null;
    }
    /** Everything the Setup page should show as one notice. */
    private errorText(): string {
        const restarts = this.collector.restartCount();
        return sentences([
            this.storageError,
            this.collectorError,
            this.collectorError && restarts > 1 ? `The collector has been restarted ${restarts} times` : '',
            this.recentPairingError()?.message || '',
        ]);
    }
    // Removing or relinking a source restarts the collector; reopen a pairing window it would close.
    private startCommands(): object[] {
        const commands: object[] = [{ type: 'configure', sources: this.store.sources }];
        const seconds = Math.ceil((this.pairUntil - Date.now()) / 1000);
        if (seconds > 0) commands.push({ type: 'pair', seconds });
        return commands;
    }
    private invalidateSources(source?: string): void {
        this.notificationFeed.deactivate(source);
        for (const [requestId, action] of this.actions) {
            if (!source || action.source === source) {
                clearTimeout(action.timer);
                action.reject(Error('The iPhone disconnected before its action was confirmed'));
                this.actions.delete(requestId);
            }
        }
        if (source) this.sessions.delete(source);
        else this.sessions.clear();
    }
    private handleCollector(message: Record<string, unknown>): void {
        switch (message.kind) {
            case 'session':
                // Keep historical content, but never use identifiers from an old
                // ANCS session to act on a newly connected phone.
                this.invalidateSources(String(message.source));
                this.sessions.set(String(message.source), String(message.session));
                this.notificationFeed.rememberReplays(String(message.source));
                break;
            case 'devices':
                this.bluetooth = message.devices as unknown[];
                this.pairingOpen = !!message.pairingOpen;
                // Counted from the later of the error and this collector's start: after a long
                // restart delay, the first report of the new collector proves nothing yet.
                if (Date.now() - Math.max(this.collectorErrorAt, this.collector.started) >= COLLECTOR_ERROR_HOLD_MS)
                    this.collectorError = '';
                break;
            case 'status': {
                const source = String(message.source);
                this.statuses[source] = String(message.status);
                this.notificationFeed.setActive(
                    source,
                    this.sessions.get(source),
                    message.status === 'Receiving notifications',
                );
                if (String(message.status).includes('disconnected')) this.invalidateSources(source);
                break;
            }
            case 'error': {
                const text = String(message.message).slice(0, 500);
                // One failed attempt, not a state of the collector: nothing later reports that it is over.
                if (text.startsWith('Pairing failed')) this.pairingError = { message: text, at: Date.now() };
                else this.collectorFault(text);
                break;
            }
            case 'pairing':
                this.pairing = message.code ? { address: String(message.address), code: String(message.code) } : null;
                if (message.code) {
                    this.pairingRejectedAt = 0;
                    this.pairingError = null;
                }
                break;
            case 'pairing-rejected':
                this.pairingRejectedAt = Date.now();
                break;
            case 'notification':
                this.receive(message as unknown as NotificationEvent);
                break;
            case 'action-result': {
                const requestId = String(message.requestId);
                const action = this.actions.get(requestId);
                if (
                    !action ||
                    action.source !== message.source ||
                    action.session !== message.session ||
                    action.uid !== message.uid
                )
                    break;
                clearTimeout(action.timer);
                this.actions.delete(requestId);
                if (message.ok === true) action.resolve();
                else
                    action.reject(
                        Error(
                            typeof message.error === 'string'
                                ? message.error.slice(0, 200)
                                : 'The iPhone could not perform this action',
                        ),
                    );
                break;
            }
        }
    }
    private prune(): void {
        if (this.notificationFeed.prune()) this.saveHistory();
    }
    private counts(): { unread: number; unreadBySource: Record<string, number> } {
        return this.notificationFeed.counts(this.store.sources);
    }
    /** The history as the page shows it: newest first, without the fields only the server uses. */
    private history(source?: string): NotificationHistoryItem[] {
        return this.notificationFeed.history(source);
    }
    private async performAction(item: FeedItem, expectedLabel: unknown, timeout = 15000): Promise<void> {
        if (typeof expectedLabel !== 'string' || expectedLabel !== item.negativeActionLabel)
            throw Error('The iPhone action changed. Refresh notifications before trying again.');
        if (
            !item.active ||
            item.session !== this.sessions.get(item.source) ||
            !item.canDismiss ||
            !item.negativeActionLabel
        )
            throw Error('This notification no longer has an available action on the iPhone');
        if ([...this.actions.values()].some((action) => action.key === item.key))
            throw Error('An action for this notification is already waiting for the iPhone');
        const requestId = crypto.randomUUID();
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.actions.delete(requestId);
                reject(Error('The iPhone did not confirm the action. Check the phone before trying again.'));
            }, timeout);
            this.actions.set(requestId, {
                key: item.key,
                source: item.source,
                session: item.session,
                uid: item.uid,
                timer,
                resolve,
                reject,
            });
            const failed = (error: unknown) => {
                clearTimeout(timer);
                this.actions.delete(requestId);
                reject(error);
            };
            try {
                Promise.resolve(
                    this.command({
                        type: 'dismiss',
                        requestId,
                        source: item.source,
                        session: item.session,
                        uid: item.uid,
                        expectedLabel,
                    }),
                ).catch(failed);
            } catch (error) {
                failed(error);
            }
        });
        const current = this.feed.get(item.key);
        if (current) current.read = true;
        this.saveHistory(true);
    }
    receive(event: NotificationEvent): void {
        this.load();
        const source = this.store.sources.find((s) => s.id === event.source);
        const { changed, push } = this.notificationFeed.receive(
            event,
            source,
            source ? this.sessions.get(source.id) : undefined,
        );
        if (changed) this.saveHistory();
        if (!push || !source) return;
        for (const sub of this.store.subscriptions)
            if (shouldRelay(event, source, sub)) this.push.enqueue(sub.id, push);
    }

    /**
     * Queue `payload` for every push subscription as a `system:<nonce>` job. Not stored in the
     * notification history and not subject to source filters; `preparePush` returns the given
     * payload for any `system:` key, the way it already does for `test`.
     */
    public notifySystem(payload: SystemPushPayload): void {
        this.load();
        if (this.closed) return;
        const key = `system:${crypto.randomBytes(8).toString('hex')}`;
        const body = JSON.stringify({ title: payload.title, body: payload.body, tag: payload.tag, url: payload.url });
        for (const sub of this.store.subscriptions) this.push.enqueue(sub.id, key, body, 'system');
    }

    private preparePush(id: string, key: string, testPayload?: string): PushTarget | undefined {
        const sub = this.store.subscriptions.find((candidate) => candidate.id === id);
        if (!sub || this.closed) return;
        if ((key === 'test' || key.startsWith('system:')) && testPayload)
            return { subscription: sub.subscription, payload: testPayload, vapid: this.store.vapid };
        const item = this.feed.get(key);
        if (!item || item.read || item.dismissed || !item.reconnectable || item.received < Date.now() - HISTORY_MS)
            return;
        const source = this.store.sources.find((candidate) => candidate.id === item.source);
        if (!source || !shouldRelay({ ...item, event: 'added', preExisting: false }, source, sub)) return;
        const payload = JSON.stringify({
            title: source.preview
                ? this.pushText(`${item.appName || item.app}: ${item.title || 'Notification'}`, 160)
                : `${source.name}: new notification`,
            body: source.preview
                ? this.pushText([item.subtitle, item.body].filter(Boolean).join('\n'), 700)
                : 'Open the phone to view it.',
            tag: crypto.createHash('sha256').update(item.key).digest('hex').slice(0, 32),
            url: `#!${new URLSearchParams({ action: 'notifications', source: source.id, notification: item.key })}`,
            source: source.id,
            notificationKey: item.key,
            unreadCount: this.counts().unread,
        });
        return { subscription: sub.subscription, payload, vapid: this.store.vapid };
    }
    private pushText(value: string, length: number): string {
        // Strip JSON-expanding control characters and unpaired UTF-16 surrogates.
        return Array.from(value)
            .filter((c) => {
                const point = c.codePointAt(0)!;
                return (
                    (point === 9 || point === 10 || point >= 32) && point !== 127 && (point < 0xd800 || point > 0xdfff)
                );
            })
            .join('')
            .slice(0, length)
            .replace(/[\ud800-\udbff]$/, '');
    }
    mount(app: Express, base: string): void {
        this.load();
        this.routes ??= new NotificationRoutes({
            store: () => this.store,
            disabled: () => this.disabled,
            notificationFeed: this.notificationFeed,
            feed: this.feed,
            icons: this.icons,
            push: this.push,
            status: () => ({
                bluetooth: this.bluetooth,
                statuses: this.statuses,
                pairing: this.pairing,
                pairingOpen: this.pairingOpen,
                pairingRejected: Date.now() - this.pairingRejectedAt < PAIRING_REJECTED_NOTICE_MS,
                error: this.disabled || this.errorText(),
                collectorError: this.collectorError,
                collectorRestarts: this.collector.restartCount(),
                storageError: this.storageError,
                pairingError: this.recentPairingError(),
                delivery: this.delivery,
            }),
            prune: () => this.prune(),
            history: (source) => this.history(source),
            counts: () => this.counts(),
            saveHistory: (immediate) => this.saveHistory(immediate),
            save: () => this.save(),
            invalidateSources: () => this.invalidateSources(),
            restartCollector: () => this.collector.restartCollector(),
            session: (source) => this.sessions.get(source),
            hasPendingAction: (source) => [...this.actions.values()].some((action) => action.source === source),
            performAction: (item, expectedLabel, timeout) => this.performAction(item, expectedLabel, timeout),
            pair: async () => {
                const collector = this.collector;
                const generation = collector.generation;
                await this.command({ type: 'pair' });
                if (this.closed || this.collector !== collector || collector.generation !== generation)
                    throw Error('Bluetooth collector is starting; try again shortly');
                this.pairUntil = Date.now() + PAIRING_WINDOW_MS;
                this.pairingRejectedAt = 0;
                this.pairingError = null;
            },
            confirm: async (address, code) => {
                if (!this.pairing || address !== this.pairing.address || code !== this.pairing.code)
                    throw Error('Pairing code expired');
                await this.command({ type: 'confirm', ...this.pairing });
            },
        });
        this.routes.mount(app, base);
    }
}
