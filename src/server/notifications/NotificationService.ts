import express, { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { PushSubscription } from 'web-push';
import { Service } from '../services/Service';
import { NotificationIcons } from './NotificationIcons';
import { isDismissActionLabel } from '../../common/NotificationActions';
import { sameOrigin } from '../requestOrigin';
import { resolveDataDir } from '../dataDir';

import { MutedApp, NotificationEvent, NotificationHistoryItem } from '../../common/Notification';
import { PushDelivery, PushTarget } from './PushDelivery';
import { HISTORY_MS, NotificationFeed, shouldRelay } from './NotificationFeed';
export type { NotificationEvent, NotificationSource } from '../../common/Notification';
export { shouldRelay, textFingerprint, reducedFingerprint } from './NotificationFeed';

import {
    NotificationStorage,
    NotificationStore as Store,
    NotificationStoreError,
    FeedItem,
    MUTED_APP_LIMIT,
    validMutedApp,
} from './NotificationStorage';
export type { FeedItem } from './NotificationStorage';

// The collector's pairing window (`pair_until` in collector.py).
const PAIRING_WINDOW_MS = 120000;
// How long the setup page explains a pairing request that arrived with no window open.
const PAIRING_REJECTED_NOTICE_MS = 10 * 60000;
// The collector reports every two seconds and the Setup page reads the status every five. A
// collector error stays until the collector has reported for this long without a new one.
const COLLECTOR_ERROR_HOLD_MS = 30000;
// Collector restarts: 3 s after the first failure, doubling up to one minute. A collector that
// stays up for COLLECTOR_STABLE_MS counts as recovered.
const COLLECTOR_RESTART_MS = 3000;
const COLLECTOR_RESTART_MAX_MS = 60000;
const COLLECTOR_STABLE_MS = 60000;
// How much of one collector process's stderr goes to the server log. A traceback is a few kilobytes.
const COLLECTOR_LOG_LIMIT = 16384;

const sentences = (parts: string[]): string =>
    parts
        .filter(Boolean)
        .map((part) => part.replace(/\.$/, ''))
        .join('. ');

const gzip = promisify(zlib.gzip);

/** Names the push service of a subscription, so the page can tell receiving devices apart. */
function pushProvider(endpoint: string): string {
    const host = new URL(endpoint).hostname;
    if (host.endsWith('push.apple.com')) return 'Apple';
    if (host === 'fcm.googleapis.com') return 'Google';
    if (host.endsWith('mozilla.com')) return 'Mozilla';
    if (host.endsWith('notify.windows.com')) return 'Windows';
    return 'Other';
}

/**
 * Identifies one state of the history. It is a hash of what the page is sent, so it changes with
 * every visible change (a new item, a read mark, a lost Bluetooth session) wherever that change
 * was made, and it stays the same across a server restart.
 */
function historyRevision(serialized: string): string {
    return crypto.createHash('sha1').update(serialized).digest('hex').slice(0, 16);
}

export function validateSubscription(value: unknown): PushSubscription {
    const sub = value as PushSubscription;
    if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 2048)
        throw Error('Invalid push subscription');
    const url = new URL(sub.endpoint);
    const hosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
    const allowed =
        hosts.includes(url.hostname) ||
        url.hostname.endsWith('.push.apple.com') ||
        url.hostname.endsWith('.notify.windows.com');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowed)
        throw Error('Unsupported push provider');
    for (const [key, size] of [
        ['p256dh', 65],
        ['auth', 16],
    ] as const) {
        const val = sub.keys?.[key];
        if (typeof val !== 'string' || !/^[\w=-]+$/.test(val) || Buffer.from(val, 'base64url').length !== size)
            throw Error('Invalid push encryption key');
    }
    return { endpoint: sub.endpoint, keys: { auth: sub.keys.auth, p256dh: sub.keys.p256dh } };
}

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
    private bulkSources = new Set<string>();
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
    private child?: ChildProcessWithoutNullStreams;
    private restart?: NodeJS.Timeout;
    private closed = false;
    private loaded = false;
    // Receive, replay, pruning and counts. The routes below change its items in place.
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
    // Consecutive collector failures; zero again after COLLECTOR_STABLE_MS of uptime.
    private collectorRestarts = 0;
    private collectorStarted = 0;
    // The child this service stopped on purpose (a changed or removed phone).
    private expectedExit?: ChildProcessWithoutNullStreams;
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
        this.startCollector();
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
        if (this.restart) clearTimeout(this.restart);
        this.child?.kill();
        this.child = undefined;
        this.push.stop();
    }
    private command(command: object): void {
        if (!this.child?.stdin.writable) throw Error('Bluetooth collector is starting; try again shortly');
        this.child.stdin.write(JSON.stringify(command) + '\n');
    }
    private startCollector(): void {
        if (this.closed || process.env.WS_NOTIFICATIONS_COLLECTOR === '0') return;
        const candidates = [
            path.resolve(process.cwd(), 'python/notifications/collector.py'),
            path.resolve(process.cwd(), '../python/notifications/collector.py'),
        ];
        const script = candidates.find((p) => fs.existsSync(p));
        if (!script) {
            this.collectorFault('Bluetooth collector is not installed');
            return;
        }
        const child = spawn(process.env.WS_BLUETOOTH_PYTHON || '/usr/bin/python3', [script], { stdio: 'pipe' });
        this.child = child;
        const started = Date.now();
        this.collectorStarted = started;
        this.statuses = Object.fromEntries(this.store.sources.map((s) => [s.id, 'Waiting for Bluetooth connection']));
        let pending = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            if (this.child !== child) return;
            pending += chunk;
            if (pending.length > 131072) {
                child.kill();
                return;
            }
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                try {
                    this.handleCollector(JSON.parse(line));
                } catch {
                    this.collectorFault('Invalid Bluetooth collector event');
                }
            }
        });
        let logged = 0;
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            // A message this collector reported itself says more. The two pipes are read in no
            // fixed order, so its traceback can arrive after it.
            if (this.collectorError && this.collectorErrorAt >= started) this.collectorErrorAt = Date.now();
            else this.collectorFault('Bluetooth collector failed; check host BlueZ and D-Bus access');
            // The text (a Python traceback, usually) is the only record of what went wrong.
            if (logged >= COLLECTOR_LOG_LIMIT) return;
            const text = chunk.slice(0, COLLECTOR_LOG_LIMIT - logged);
            logged += text.length;
            console.error(`[NotificationService] collector: ${text.trimEnd()}`);
            if (logged >= COLLECTOR_LOG_LIMIT)
                console.error('[NotificationService] collector: further output from this process is not logged');
        });
        child.stdin.on('error', () => undefined);
        child.on('error', () => {
            this.collectorFault('Could not start Bluetooth collector');
        });
        child.on('close', () => {
            if (this.child === child) {
                this.child = undefined;
                this.invalidateSources();
            }
            this.pairing = null;
            this.pairingOpen = false;
            const expected = this.expectedExit === child;
            if (expected) this.expectedExit = undefined;
            if (this.closed) return;
            if (!expected && (!this.collectorError || this.collectorErrorAt < started))
                this.collectorFault('Bluetooth collector stopped');
            this.restart = setTimeout(() => this.startCollector(), this.restartDelay(expected, Date.now() - started));
        });
        for (const command of this.startCommands()) child.stdin.write(JSON.stringify(command) + '\n');
    }
    private collectorFault(message: string): void {
        this.collectorError = message;
        this.collectorErrorAt = Date.now();
    }
    /**
     * How long to wait before the next collector start. A collector that fails as soon as it
     * starts (no D-Bus, BlueZ down) must not be started again every 3 s without end.
     */
    private restartDelay(expected: boolean, uptime: number): number {
        if (expected) return COLLECTOR_RESTART_MS;
        if (uptime >= COLLECTOR_STABLE_MS) this.collectorRestarts = 0;
        return Math.min(COLLECTOR_RESTART_MAX_MS, COLLECTOR_RESTART_MS * 2 ** this.collectorRestarts++);
    }
    private restartCount(): number {
        if (this.child && Date.now() - this.collectorStarted >= COLLECTOR_STABLE_MS) this.collectorRestarts = 0;
        return this.collectorRestarts;
    }
    /** Stops the collector so that it starts again with the current phones. Not a failure. */
    private restartCollector(): void {
        this.expectedExit = this.child;
        this.child?.kill();
    }
    private recentPairingError(): { message: string; at: number } | null {
        return this.pairingError && Date.now() - this.pairingError.at < PAIRING_REJECTED_NOTICE_MS
            ? this.pairingError
            : null;
    }
    /** Everything the Setup page should show as one notice. */
    private errorText(): string {
        const restarts = this.restartCount();
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
                if (Date.now() - Math.max(this.collectorErrorAt, this.collectorStarted) >= COLLECTOR_ERROR_HOLD_MS)
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
            try {
                this.command({
                    type: 'dismiss',
                    requestId,
                    source: item.source,
                    session: item.session,
                    uid: item.uid,
                    expectedLabel,
                });
            } catch (error) {
                clearTimeout(timer);
                this.actions.delete(requestId);
                reject(error);
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
                : 'Open the device to view it.',
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
        const router = express.Router();
        router.use(sameOrigin);
        router.use(express.json({ limit: '64kb', inflate: false }));
        router.use((req, res, next) => {
            res.setHeader('Cache-Control', 'no-store');
            // No request limit here. Behind Tailscale Serve every HTTPS client arrives from
            // 127.0.0.1, so a limit per address was one budget for all of them, and running out
            // of it showed "Connection interrupted" on every notifications page.
            if (this.disabled && req.method !== 'GET') {
                res.status(503).json({ error: this.disabled });
                return;
            }
            next();
        });
        const route = (
            method: 'get' | 'post' | 'delete',
            url: string,
            action: (req: Request, res: Response) => void | Promise<void>,
        ) => {
            router[method](url, async (req, res) => {
                try {
                    await action(req, res);
                } catch (e) {
                    res.status(400).json({ error: (e as Error).message });
                }
            });
        };
        // Polled every few seconds while the page is open, so it carries no notification text.
        // The page fetches /history only when `historyRevision` changes.
        route('get', '/status', (_req, res) => {
            this.prune();
            const storedBySource = this.notificationFeed.storedBySource(this.store.sources);
            res.json({
                publicKey: this.store.vapid.publicKey,
                sources: this.store.sources,
                bluetooth: this.bluetooth,
                statuses: this.statuses,
                pairing: this.pairing,
                pairingOpen: this.pairingOpen,
                pairingRejected: Date.now() - this.pairingRejectedAt < PAIRING_REJECTED_NOTICE_MS,
                error: this.disabled || this.errorText(),
                collectorError: this.collectorError,
                collectorRestarts: this.restartCount(),
                storageError: this.storageError,
                pairingError: this.recentPairingError(),
                delivery: this.delivery,
                // One row per receiving device. The id is a hash, never the push endpoint.
                receivers: this.store.subscriptions.map((s) => ({
                    id: s.id,
                    provider: pushProvider(s.subscription.endpoint),
                    ...this.push.statsFor(s.id),
                })),
                historyRevision: historyRevision(JSON.stringify(this.history())),
                storedBySource,
                ...this.counts(),
                retentionDays: 30,
                publicUrl: process.env.WS_PUBLIC_URL || '',
            });
        });
        // The stored notifications, for one iPhone when `source` is given. `since` is the
        // revision the page already holds: 304 when nothing changed.
        route('get', '/history', async (req, res) => {
            this.prune();
            const { source, since } = req.query;
            if (source !== undefined && !this.store.sources.some((s) => s.id === source))
                throw Error('Unknown notification device');
            const notifications = JSON.stringify(this.history(source as string | undefined));
            const revision = historyRevision(notifications);
            if (since === revision) {
                res.status(304).end();
                return;
            }
            const body = Buffer.from(`{"revision":"${revision}","notifications":${notifications}}`);
            res.type('json');
            res.setHeader('Vary', 'Accept-Encoding');
            // Nothing else compresses responses and this is the one large reply: 500 items
            // are about 245 KB, and about a tenth of that compressed.
            if (body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
                res.setHeader('Content-Encoding', 'gzip');
                res.send(await gzip(body));
            } else res.send(body);
        });
        route('get', '/summary', (_req, res) => {
            this.prune();
            res.json({ ...this.counts(), sources: this.store.sources.map(({ id, name }) => ({ id, name })) });
        });
        route('get', '/icons/:source/:app', async (req, res) => {
            if (!this.store.sources.some((s) => s.id === req.params.source)) throw Error('Unknown notification device');
            const png = await this.icons.get(req.params.source, req.params.app);
            if (!png) {
                res.sendStatus(404);
                return;
            }
            // An app's icon rarely changes. Misses stay uncached so that they are asked for again.
            res.setHeader('Cache-Control', 'private, max-age=86400');
            res.type('png').send(png);
        });
        route('post', '/history/read', (req, res) => {
            const { keys, source, read = true, all = false } = req.body;
            if (
                typeof read !== 'boolean' ||
                typeof all !== 'boolean' ||
                (all && (keys !== undefined || source !== undefined)) ||
                (source !== undefined && !this.store.sources.some((s) => s.id === source)) ||
                (keys !== undefined &&
                    (!Array.isArray(keys) || keys.length > 500 || keys.some((key) => typeof key !== 'string'))) ||
                (keys === undefined && source === undefined && !all)
            )
                throw Error('Select notifications or a device to mark read');
            const selected = keys === undefined ? undefined : new Set(keys);
            for (const item of this.feed.values()) {
                if ((source === undefined || source === item.source) && (!selected || selected.has(item.key)))
                    item.read = read;
            }
            this.saveHistory(true);
            res.json({ ok: true, ...this.counts() });
        });
        route('post', '/history/dismiss', (req, res) => {
            const { source, keys } = req.body;
            if (
                !this.store.sources.some((s) => s.id === source) ||
                !Array.isArray(keys) ||
                keys.length < 1 ||
                keys.length > 500 ||
                keys.some((key) => typeof key !== 'string' || !key || key.length > 256) ||
                new Set(keys).size !== keys.length
            )
                throw Error('Select a device and the notifications to dismiss');
            // Validate the full confirmed snapshot before changing any record.
            if (keys.some((key) => this.feed.has(key) && this.feed.get(key)!.source !== source))
                throw Error('All selected notifications must belong to the same device');
            const dismissed: string[] = [];
            for (const key of keys) {
                const item = this.feed.get(key);
                if (!item || item.dismissed) continue;
                item.read = true;
                item.dismissed = true;
                dismissed.push(key);
            }
            this.saveHistory(true);
            res.json({ ok: true, dismissed, ...this.counts() });
        });
        // Undo for the local bulk actions: puts a confirmed set back in the inbox, each with the
        // read state it had. Like the single restore, it changes nothing on the iPhone.
        route('post', '/history/restore', (req, res) => {
            const { source, items } = req.body;
            if (
                !this.store.sources.some((s) => s.id === source) ||
                !Array.isArray(items) ||
                items.length < 1 ||
                items.length > 500 ||
                items.some(
                    (item) =>
                        !item ||
                        typeof item.key !== 'string' ||
                        !item.key ||
                        item.key.length > 256 ||
                        typeof item.read !== 'boolean',
                ) ||
                new Set(items.map((item) => item.key)).size !== items.length
            )
                throw Error('Select a device and the notifications to move back to the inbox');
            if (items.some((item) => this.feed.has(item.key) && this.feed.get(item.key)!.source !== source))
                throw Error('All selected notifications must belong to the same device');
            this.prune();
            const restored: string[] = [];
            for (const { key, read } of items as Array<{ key: string; read: boolean }>) {
                const item = this.feed.get(key);
                if (!item) continue;
                item.dismissed = false;
                item.read = read;
                restored.push(key);
            }
            this.saveHistory(true);
            res.json({ ok: true, restored, ...this.counts() });
        });
        route('post', '/history/actions', async (req, res) => {
            const { source, items } = req.body;
            if (
                !this.store.sources.some((s) => s.id === source) ||
                !Array.isArray(items) ||
                items.length < 1 ||
                items.length > 500 ||
                items.some(
                    (item) =>
                        !item ||
                        typeof item.key !== 'string' ||
                        !item.key ||
                        item.key.length > 256 ||
                        typeof item.expectedLabel !== 'string' ||
                        item.expectedLabel.length > 128,
                ) ||
                new Set(items.map((item) => item.key)).size !== items.length
            )
                throw Error('Select a device and the notifications to dismiss on its phone');
            if (items.some((item) => !isDismissActionLabel(item.expectedLabel)))
                throw Error('Bulk dismissal only supports actions explicitly labelled Clear or Dismiss');
            // Reject scope/label mistakes for the complete snapshot before any
            // action is written. Removed or expired history entries are skipped.
            for (const selected of items) {
                const item = this.feed.get(selected.key);
                if (item && item.source !== source)
                    throw Error('All selected notifications must belong to the same device');
                if (item && item.negativeActionLabel !== selected.expectedLabel)
                    throw Error('An iPhone action changed. Refresh notifications before trying again.');
            }
            if (this.bulkSources.has(source) || [...this.actions.values()].some((action) => action.source === source))
                throw Error('An iPhone action is already in progress for this device');
            const accepted: string[] = [],
                skipped: string[] = [],
                unprocessed: string[] = [];
            const failed: Array<{ key: string; error: string }> = [];
            const session = this.sessions.get(source);
            const snapshot = items.map(({ key, expectedLabel }) => {
                const item = this.feed.get(key);
                return {
                    key: key as string,
                    expectedLabel: expectedLabel as string,
                    uid: item?.uid,
                    session: item?.session,
                    eligible: !!item && item.active && !!item.canDismiss && item.session === session,
                };
            });
            // Allow many quick acknowledgments, but never hundreds of timeout
            // waits. A failed/uncertain write stops the batch without retrying it.
            const deadline = Date.now() + 30000;
            this.bulkSources.add(source);
            try {
                for (let index = 0; index < snapshot.length; index++) {
                    const selected = snapshot[index];
                    const remaining = deadline - Date.now();
                    if (remaining <= 0 || this.sessions.get(source) !== session) {
                        unprocessed.push(...snapshot.slice(index).map((item) => item.key));
                        break;
                    }
                    const item = this.feed.get(selected.key);
                    if (
                        !selected.eligible ||
                        !item ||
                        item.source !== source ||
                        !item.active ||
                        !item.canDismiss ||
                        item.session !== session ||
                        item.session !== selected.session ||
                        item.uid !== selected.uid ||
                        item.negativeActionLabel !== selected.expectedLabel ||
                        !isDismissActionLabel(item.negativeActionLabel)
                    ) {
                        skipped.push(selected.key);
                        continue;
                    }
                    try {
                        await this.performAction(item, selected.expectedLabel, Math.min(15000, remaining));
                        accepted.push(selected.key);
                    } catch (error) {
                        const reason = error instanceof Error ? error.message : '';
                        failed.push({
                            key: selected.key,
                            error: /disconnect|not connected|connection/i.test(reason)
                                ? 'Bluetooth disconnected before the iPhone confirmed dismissal.'
                                : /changed|no longer/i.test(reason)
                                  ? 'This notification changed. Refresh its history before trying again.'
                                  : 'The iPhone did not confirm dismissal. Check the phone before trying again.',
                        });
                        unprocessed.push(...snapshot.slice(index + 1).map((item) => item.key));
                        break;
                    }
                }
            } finally {
                this.bulkSources.delete(source);
            }
            res.json({
                ok: failed.length === 0 && unprocessed.length === 0,
                accepted,
                skipped,
                failed,
                unprocessed,
                ...this.counts(),
            });
        });
        route('post', '/history/:key/dismiss', (req, res) => {
            const item = this.feed.get(req.params.key);
            if (!item) throw Error('This notification is no longer in history');
            item.read = true;
            item.dismissed = true;
            this.saveHistory(true);
            res.json({ ok: true, ...this.counts() });
        });
        route('post', '/history/:key/restore', (req, res) => {
            if (
                !req.body ||
                typeof req.body !== 'object' ||
                Array.isArray(req.body) ||
                (req.body.read !== undefined && typeof req.body.read !== 'boolean')
            )
                throw Error('Choose a valid read state for the restored notification');
            this.prune();
            const item = this.feed.get(req.params.key);
            if (!item) throw Error('This notification is no longer in history');
            // Undo affects this app's inbox only. It cannot restore an alert that
            // iOS has already removed or revive an earlier Bluetooth session.
            item.dismissed = false;
            item.read = req.body.read ?? true;
            this.saveHistory(true);
            res.json({ ok: true, ...this.counts() });
        });
        route('post', '/history/:key/action', async (req, res) => {
            const item = this.feed.get(req.params.key);
            if (!item) throw Error('This notification is no longer in history');
            if (this.bulkSources.has(item.source)) throw Error('A bulk dismissal is already running for this iPhone');
            await this.performAction(item, req.body.expectedLabel);
            res.json({ ok: true, ...this.counts() });
        });
        route('post', '/pair', (_req, res) => {
            this.command({ type: 'pair' });
            this.pairUntil = Date.now() + PAIRING_WINDOW_MS;
            this.pairingRejectedAt = 0;
            this.pairingError = null;
            res.json({ ok: true });
        });
        route('post', '/confirm', (req, res) => {
            if (!this.pairing || req.body.address !== this.pairing.address || req.body.code !== this.pairing.code)
                throw Error('Pairing code expired');
            this.command({ type: 'confirm', ...this.pairing });
            res.json({ ok: true });
        });
        // The whole record of one iPhone. `apps` is the older allow-list. `muted` is optional: a
        // page left open since before the mute list existed sends none, and the list is kept.
        route('post', '/sources', (req, res) => {
            const { id, address, name, apps, preview, muted } = req.body;
            if (
                typeof id !== 'string' ||
                !/^[\w-]{1,128}$/.test(id) ||
                typeof address !== 'string' ||
                !/^(?:[A-Fa-f0-9]{2}:){5}[A-Fa-f0-9]{2}$/.test(address) ||
                typeof name !== 'string' ||
                name.length > 100 ||
                !name.trim() ||
                typeof preview !== 'boolean' ||
                !Array.isArray(apps) ||
                apps.length > 100 ||
                apps.some((a) => typeof a !== 'string' || a.length > 256) ||
                (muted !== undefined &&
                    (!Array.isArray(muted) || muted.length > MUTED_APP_LIMIT || !muted.every(validMutedApp)))
            )
                throw Error('Invalid notification source');
            if (this.store.sources.some((s) => s.address === address.toUpperCase() && s.id !== id))
                throw Error('Bluetooth phone is already linked');
            if (this.store.sources.length >= 32 && !this.store.sources.some((s) => s.id === id))
                throw Error('Source limit reached');
            const existing = this.store.sources.find((source) => source.id === id);
            const connectionChanged = existing?.address !== address.toUpperCase();
            // Without `muted` the record is stored as such a request always stored it, with the
            // list it already had.
            const mutedApps =
                muted === undefined
                    ? existing?.muted
                    : [...new Map((muted as MutedApp[]).map(({ app, name }) => [app, name]))].map(([app, name]) => ({
                          app,
                          name,
                      }));
            const record = {
                id,
                address: address.toUpperCase(),
                name,
                apps,
                preview,
                ...(mutedApps ? { muted: mutedApps } : {}),
            };
            // A changed iPhone keeps its place: the first one is the inbox shown without a choice,
            // and Setup lists them in this order. A new one is added at the end.
            this.store.sources = existing
                ? this.store.sources.map((s) => (s.id === id ? record : s))
                : [...this.store.sources, record];
            if (connectionChanged) this.invalidateSources();
            if (!preview) this.notificationFeed.forgetText(id);
            this.saveHistory(true);
            this.save();
            if (connectionChanged) this.restartCollector();
            res.json({ ok: true });
        });
        route('delete', '/sources/:id', (req, res) => {
            const id = req.params.id;
            this.store.sources = this.store.sources.filter((s) => s.id !== id);
            this.invalidateSources();
            this.notificationFeed.removeSource(id);
            this.icons.removeSource(id);
            this.saveHistory(true);
            this.save();
            this.restartCollector();
            res.json({ ok: true });
        });
        route('post', '/subscriptions', (req, res) => {
            const subscription = validateSubscription(req.body.subscription);
            // The browser replaced its subscription while the app was closed. The service worker
            // names the old endpoint and the record keeps its choices, which only the page knows.
            const replaced =
                typeof req.body.replaces === 'string'
                    ? this.store.subscriptions.find((s) => s.subscription.endpoint === req.body.replaces)
                    : undefined;
            const sources =
                req.body.sources ?? replaced?.sources.filter((id) => this.store.sources.some((s) => s.id === id));
            if (!Array.isArray(sources) || sources.some((id) => !this.store.sources.some((s) => s.id === id)))
                throw Error('Select valid source devices');
            const receiverSource = req.body.receiverSource ?? replaced?.receiverSource ?? '';
            if (receiverSource && !this.store.sources.some((s) => s.id === receiverSource))
                throw Error('Invalid receiver device');
            const id = crypto.createHash('sha256').update(subscription.endpoint).digest('hex');
            const kept = this.store.subscriptions.filter((s) => s.id !== id && s !== replaced);
            if (kept.length >= 100) throw Error('Subscription limit reached');
            if (replaced && replaced.id !== id) this.push.forget(replaced.id);
            this.store.subscriptions = [...kept, { id, subscription, sources, receiverSource, updated: Date.now() }];
            this.save();
            res.json({ id });
        });
        route('delete', '/subscriptions', (req, res) => {
            for (const s of this.store.subscriptions)
                if (s.subscription.endpoint === req.body.endpoint) this.push.forget(s.id);
            this.store.subscriptions = this.store.subscriptions.filter(
                (s) => s.subscription.endpoint !== req.body.endpoint,
            );
            this.save();
            res.json({ ok: true });
        });
        route('post', '/test', (req, res) => {
            const sub = this.store.subscriptions.find((s) => s.subscription.endpoint === req.body.endpoint);
            if (!sub) throw Error('Enable notifications on this device first');
            this.push.enqueue(
                sub.id,
                'test',
                JSON.stringify({
                    title: 'ws-scrcpy',
                    body: 'Notifications are ready on this device.',
                    tag: 'ws-scrcpy-test',
                    url: '#!action=notifications',
                }),
            );
            res.json({ ok: true });
        });
        app.use(`${base.replace(/\/$/, '')}/api/notifications`, router);
    }
}
