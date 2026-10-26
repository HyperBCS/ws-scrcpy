import express, { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import webpush, { PushSubscription } from 'web-push';
import { Service } from '../services/Service';
import { NotificationIcons } from './NotificationIcons';
import { isDismissActionLabel } from '../../common/NotificationActions';

export interface NotificationSource {
    id: string;
    address: string;
    name: string;
    apps: string[];
    preview: boolean;
}
interface SubscriptionRecord {
    id: string;
    subscription: PushSubscription;
    sources: string[];
    receiverSource: string;
    updated: number;
}
interface Store {
    token: string;
    vapid: { publicKey: string; privateKey: string };
    sources: NotificationSource[];
    subscriptions: SubscriptionRecord[];
}
export interface NotificationEvent {
    source: string;
    session: string;
    uid: number;
    event: 'added' | 'modified' | 'removed';
    preExisting?: boolean;
    app?: string;
    appName?: string;
    title?: string;
    subtitle?: string;
    body?: string;
    date?: string;
    canDismiss?: boolean;
    negativeActionLabel?: string;
}
export interface FeedItem extends NotificationEvent {
    key: string;
    received: number;
    read: boolean;
    dismissed: boolean;
    active: boolean;
    // Fingerprints are private reconnect hints, never exposed to the browser.
    fingerprint?: string;
    reconnectable: boolean;
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

export function shouldRelay(event: NotificationEvent, source: NotificationSource, sub: SubscriptionRecord): boolean {
    return (
        event.event === 'added' &&
        !event.preExisting &&
        sub.sources.includes(source.id) &&
        sub.receiverSource !== source.id &&
        !!event.app &&
        !event.app.startsWith('com.apple.WebKit.WebPush') &&
        !event.app.startsWith('com.apple.WebKit.PushBundle') &&
        (!source.apps.length || source.apps.includes(event.app))
    );
}

function pushFailure(error: unknown): string {
    const { statusCode, body } = error as { statusCode?: number; body?: string };
    if (statusCode === 403 && typeof body === 'string' && body.length < 2048) {
        try {
            if (JSON.parse(body)?.reason === 'BadJwtToken')
                return 'Push provider rejected the server’s sender credentials (403: BadJwtToken). Check WS_PUSH_SUBJECT and the server clock.';
        } catch {
            // Provider responses are not always JSON. Never expose their raw body.
        }
    }
    return `Push provider rejected delivery (${statusCode || 'network error'})`;
}

export class NotificationService implements Service {
    private static instance?: NotificationService;
    static getInstance(): NotificationService {
        return this.instance ?? (this.instance = new NotificationService());
    }
    static hasInstance(): boolean {
        return !!this.instance;
    }
    private dataDir = path.resolve(process.env.WS_NOTIFICATION_DATA || path.join(process.cwd(), 'data'));
    private file = path.join(this.dataDir, 'notifications.json');
    private historyFile = path.join(this.dataDir, 'notification-history.json');
    private historySave?: NodeJS.Timeout;
    private icons = new NotificationIcons(this.dataDir);
    private sessions = new Map<string, string>();
    private bulkSources = new Set<string>();
    private liveKeys = new Map<string, string>();
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
    private feed = new Map<string, FeedItem>();
    private observed = new Map<string, number>();
    private replayCandidates = new Map<
        string,
        { fingerprint: string; session: string; received: number; historyKey?: string }
    >();
    private statuses: Record<string, string> = {};
    private bluetooth: unknown[] = [];
    private pairing: { address: string; code: string } | null = null;
    private pairingOpen = false;
    private error = '';
    private delivery = { sent: 0, failed: 0, lastError: '' };
    private queues = new Map<string, Array<{ payload: string; key: string; expires: number; generation: number }>>();
    private deliveryGeneration = 0;
    private draining = new Set<string>();
    private attempts = new Map<string, { count: number; reset: number }>();

    getName(): string {
        return 'Bluetooth notifications and Web Push';
    }
    private load(): void {
        if (this.loaded) return;
        fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
        if (fs.existsSync(this.file)) this.store = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        else {
            this.store = {
                token: crypto.randomBytes(24).toString('base64url'),
                vapid: webpush.generateVAPIDKeys(),
                sources: [],
                subscriptions: [],
            };
            this.save();
        }
        fs.writeFileSync(path.join(this.dataDir, 'notification-setup-key'), this.store.token + '\n', { mode: 0o600 });
        this.loaded = true;
        if (fs.existsSync(this.historyFile)) {
            try {
                const history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
                if (!Array.isArray(history.items)) throw Error('Invalid notification history');
                for (const item of history.items as FeedItem[]) {
                    const source = this.store.sources.find((s) => s.id === item.source);
                    if (
                        !source ||
                        typeof item.key !== 'string' ||
                        typeof item.session !== 'string' ||
                        !Number.isInteger(item.uid) ||
                        !Number.isFinite(item.received)
                    )
                        continue;
                    item.active = false;
                    item.read = !!item.read;
                    item.dismissed = !!item.dismissed;
                    if (!source.preview) Object.assign(item, { title: '', subtitle: '', body: '' });
                    this.feed.set(item.key, item);
                    if (item.reconnectable && item.fingerprint) {
                        this.replayCandidates.set(`${item.source}:${item.session}:${item.uid}`, {
                            fingerprint: item.fingerprint,
                            session: item.session,
                            received: Date.now(),
                            historyKey: item.key,
                        });
                    }
                }
                this.prune();
            } catch {
                this.error = 'Notification history could not be loaded';
            }
        }
    }
    private saveHistory(immediate = false): void {
        if (this.historySave) {
            clearTimeout(this.historySave);
            this.historySave = undefined;
        }
        if (!immediate) {
            this.historySave = setTimeout(() => {
                try {
                    this.saveHistory(true);
                } catch {
                    this.error = 'Notification history could not be saved';
                }
            }, 200);
            return;
        }
        fs.writeFileSync(this.historyFile + '.tmp', JSON.stringify({ version: 1, items: [...this.feed.values()] }), {
            mode: 0o600,
        });
        fs.renameSync(this.historyFile + '.tmp', this.historyFile);
    }
    private save(): void {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.store), { mode: 0o600 });
        fs.renameSync(this.file + '.tmp', this.file);
    }
    async start(): Promise<void> {
        this.load();
        this.closed = false;
        this.startCollector();
    }
    release(): void {
        this.closed = true;
        this.invalidateSources();
        if (this.historySave) this.saveHistory(true);
        if (this.restart) clearTimeout(this.restart);
        this.child?.kill();
        this.child = undefined;
        this.queues.clear();
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
            this.error = 'Bluetooth collector is not installed';
            return;
        }
        const child = spawn(process.env.WS_BLUETOOTH_PYTHON || '/usr/bin/python3', [script], { stdio: 'pipe' });
        this.child = child;
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
                    this.error = 'Invalid Bluetooth collector event';
                }
            }
        });
        child.stderr.on('data', () => {
            this.error = 'Bluetooth collector failed; check host BlueZ and D-Bus access';
        });
        child.stdin.on('error', () => undefined);
        child.on('error', () => {
            this.error = 'Could not start Bluetooth collector';
        });
        child.on('close', () => {
            if (this.child === child) {
                this.child = undefined;
                this.invalidateSources();
            }
            this.pairing = null;
            this.pairingOpen = false;
            if (!this.closed) this.restart = setTimeout(() => this.startCollector(), 3000);
        });
        child.stdin.write(JSON.stringify({ type: 'configure', sources: this.store.sources }) + '\n');
    }
    private invalidateSources(source?: string): void {
        for (const item of this.feed.values()) {
            if (!source || item.source === source) item.active = false;
        }
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
                // A phone can reconnect after the short push-dedup window. Rebuild
                // one-to-one history hints from retained, never-removed lifetimes.
                for (const item of this.feed.values()) {
                    if (item.source === message.source && item.reconnectable && item.fingerprint) {
                        this.replayCandidates.set(`${item.source}:${item.session}:${item.uid}`, {
                            fingerprint: item.fingerprint,
                            session: item.session,
                            received: Date.now(),
                            historyKey: item.key,
                        });
                    }
                }
                break;
            case 'devices':
                this.bluetooth = message.devices as unknown[];
                this.pairingOpen = !!message.pairingOpen;
                this.error = '';
                break;
            case 'status': {
                const source = String(message.source);
                this.statuses[source] = String(message.status);
                for (const item of this.feed.values()) {
                    if (item.source === source)
                        item.active =
                            message.status === 'Receiving notifications' &&
                            item.session === this.sessions.get(source) &&
                            item.reconnectable;
                }
                if (String(message.status).includes('disconnected')) this.invalidateSources(source);
                break;
            }
            case 'error':
                this.error = String(message.message);
                break;
            case 'pairing':
                this.pairing = message.code ? { address: String(message.address), code: String(message.code) } : null;
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
        const cutoff = Date.now() - 3600000;
        const historyCutoff = Date.now() - 30 * 86400000;
        const counts = new Map<string, number>();
        let changed = false;
        for (const [key, item] of [...this.feed].reverse().sort((a, b) => b[1].received - a[1].received)) {
            const count = (counts.get(item.source) || 0) + 1;
            counts.set(item.source, count);
            if (item.received < historyCutoff || count > 500) {
                this.feed.delete(key);
                changed = true;
            }
        }
        for (const [key, value] of this.liveKeys) if (!this.feed.has(value)) this.liveKeys.delete(key);
        for (const [key, time] of this.observed) if (time < cutoff) this.observed.delete(key);
        for (const [key, value] of this.replayCandidates)
            if (value.received < cutoff) this.replayCandidates.delete(key);
        while (this.observed.size > 2000) this.observed.delete(this.observed.keys().next().value!);
        while (this.replayCandidates.size > 2000)
            this.replayCandidates.delete(this.replayCandidates.keys().next().value!);
        if (changed) this.saveHistory();
    }
    private counts(): { unread: number; unreadBySource: Record<string, number> } {
        const unreadBySource: Record<string, number> = Object.fromEntries(this.store.sources.map((s) => [s.id, 0]));
        for (const item of this.feed.values()) if (!item.read && !item.dismissed) unreadBySource[item.source]++;
        return { unread: Object.values(unreadBySource).reduce((sum, n) => sum + n, 0), unreadBySource };
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
        this.prune();
        const source = this.store.sources.find((s) => s.id === event.source);
        if (
            !source ||
            typeof event.session !== 'string' ||
            event.session.length > 128 ||
            !Number.isInteger(event.uid) ||
            event.uid < 0 ||
            event.uid > 0xffffffff ||
            !['added', 'modified', 'removed'].includes(event.event)
        )
            return;
        if (this.sessions.has(source.id) && this.sessions.get(source.id) !== event.session) return;
        const eventKey = `${event.source}:${event.session}:${event.uid}`;
        const current = this.feed.get(this.liveKeys.get(eventKey) || '');
        if (event.event === 'removed') {
            if (current) {
                current.active = false;
                current.reconnectable = false;
                current.canDismiss = false;
                this.saveHistory();
            }
            this.liveKeys.delete(eventKey);
            this.observed.delete(eventKey);
            this.replayCandidates.delete(eventKey);
            return;
        }
        if (!event.app || event.app.length > 512) return;
        // Receiving this relay on its source phone can feed it back through ANCS.
        if (event.app.startsWith('com.apple.WebKit.WebPush') || event.app.startsWith('com.apple.WebKit.PushBundle'))
            return;
        if (source.apps.length && !source.apps.includes(event.app)) return;
        const fingerprint = event.date
            ? crypto
                  .createHash('sha256')
                  .update(
                      JSON.stringify([
                          event.source,
                          event.app,
                          event.title || '',
                          event.subtitle || '',
                          event.body || '',
                          event.date,
                      ]),
                  )
                  .digest('hex')
            : undefined;
        // Match only one previous lifetime per new UID. Preserve its app read state
        // and stable history key while replacing transient Bluetooth identifiers.
        const replay =
            !current && fingerprint && event.event === 'added'
                ? [...this.replayCandidates].find(
                      ([, candidate]) => candidate.session !== event.session && candidate.fingerprint === fingerprint,
                  )
                : undefined;
        const previous = current || (replay?.[1].historyKey ? this.feed.get(replay[1].historyKey) : undefined);
        const key = previous?.key || crypto.randomUUID();
        const item: FeedItem = {
            source: event.source,
            session: event.session,
            uid: event.uid,
            event: event.event,
            preExisting: !!event.preExisting,
            app: event.app,
            appName: (event.appName || event.app).slice(0, 512),
            title: source.preview ? (event.title || '').slice(0, 1024) : '',
            subtitle: source.preview ? (event.subtitle || '').slice(0, 1024) : '',
            body: source.preview ? (event.body || '').slice(0, 4096) : '',
            date: (event.date || '').slice(0, 64),
            canDismiss: !!event.canDismiss,
            negativeActionLabel: (event.negativeActionLabel || '').slice(0, 128),
            key,
            received: previous?.received || Date.now(),
            read: previous?.read || false,
            dismissed: previous?.dismissed || false,
            active: this.sessions.get(source.id) === event.session,
            reconnectable: true,
            fingerprint,
        };
        this.feed.set(key, item);
        this.liveKeys.set(eventKey, key);
        this.saveHistory();
        if (event.event === 'modified') {
            if (this.replayCandidates.has(eventKey)) {
                if (fingerprint)
                    this.replayCandidates.set(eventKey, {
                        fingerprint,
                        session: event.session,
                        received: Date.now(),
                        historyKey: key,
                    });
                else this.replayCandidates.delete(eventKey);
            }
            this.prune();
            return;
        }
        if (this.observed.has(eventKey)) {
            this.prune();
            return;
        }
        this.observed.set(eventKey, Date.now());
        if (replay) this.replayCandidates.delete(replay[0]);
        if (fingerprint)
            this.replayCandidates.set(eventKey, {
                fingerprint,
                session: event.session,
                received: Date.now(),
                historyKey: key,
            });
        this.prune();
        if (replay || event.preExisting) return;
        const payload = JSON.stringify({
            title: source.preview
                ? this.pushText(`${event.appName || event.app}: ${event.title || 'Notification'}`, 160)
                : `${source.name}: new notification`,
            body: source.preview
                ? this.pushText([event.subtitle, event.body].filter(Boolean).join('\n'), 700)
                : 'Open the device to view it.',
            tag: crypto.createHash('sha256').update(key).digest('hex').slice(0, 32),
            url: `#!${new URLSearchParams({ action: 'notifications', source: source.id, notification: key })}`,
            source: source.id,
            notificationKey: key,
            unreadCount: this.counts().unread,
        });
        for (const sub of this.store.subscriptions)
            if (shouldRelay(event, source, sub)) this.enqueue(sub, payload, key);
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
    private enqueue(sub: SubscriptionRecord, payload: string, key: string): void {
        const queue = this.queues.get(sub.id) || [];
        if (queue.length >= 50) queue.shift();
        queue.push({ payload, key, expires: Date.now() + 300000, generation: this.deliveryGeneration });
        this.queues.set(sub.id, queue);
        if (!this.draining.has(sub.id)) void this.drain(sub.id);
    }
    private async drain(id: string): Promise<void> {
        this.draining.add(id);
        try {
            const queue = this.queues.get(id)!;
            while (!this.closed && queue.length) {
                const job = queue.shift()!;
                for (let attempt = 0; attempt < 3 && Date.now() < job.expires; attempt++) {
                    const sub = this.store.subscriptions.find((s) => s.id === id);
                    if (!sub || this.closed || job.generation !== this.deliveryGeneration) break;
                    // Apple rejects placeholder local sender addresses. Use the app's
                    // configured HTTPS address unless an explicit contact URI is set.
                    const subject = process.env.WS_PUSH_SUBJECT || process.env.WS_PUBLIC_URL;
                    if (!subject) {
                        this.delivery.failed++;
                        this.delivery.lastError = 'Set WS_PUBLIC_URL or WS_PUSH_SUBJECT to configure the push sender.';
                        break;
                    }
                    try {
                        // Queued delivery may follow a read/dismiss action in the app.
                        // Send the current count, not the count captured when queued.
                        const payload = JSON.parse(job.payload);
                        if (job.key !== 'test') payload.unreadCount = this.counts().unread;
                        await webpush.sendNotification(sub.subscription, JSON.stringify(payload), {
                            TTL: Math.max(1, Math.floor((job.expires - Date.now()) / 1000)),
                            urgency: 'normal',
                            timeout: 10000,
                            vapidDetails: {
                                subject,
                                ...this.store.vapid,
                            },
                        });
                        this.delivery.sent++;
                        this.delivery.lastError = '';
                        break;
                    } catch (error) {
                        const status = (error as { statusCode?: number }).statusCode;
                        if (status === 404 || status === 410) {
                            this.store.subscriptions = this.store.subscriptions.filter((s) => s.id !== id);
                            this.save();
                            break;
                        }
                        if ((status === 429 || !status || status >= 500) && attempt < 2) {
                            const raw = (error as { headers?: Record<string, string> }).headers?.['retry-after'];
                            const delay = raw
                                ? Number.isFinite(Number(raw))
                                    ? Number(raw) * 1000
                                    : Date.parse(raw) - Date.now()
                                : 1000 * 2 ** attempt;
                            await new Promise((resolve) =>
                                setTimeout(resolve, Math.min(30000, Math.max(1000, delay || 1000))),
                            );
                        } else {
                            this.delivery.failed++;
                            this.delivery.lastError = pushFailure(error);
                            break;
                        }
                    }
                }
            }
        } finally {
            this.draining.delete(id);
            this.queues.delete(id);
        }
    }
    mount(app: Express, base: string): void {
        this.load();
        const router = express.Router();
        router.use(express.json({ limit: '64kb' }));
        router.use((req, res, next) => {
            res.setHeader('Cache-Control', 'no-store');
            const origin = req.get('origin');
            const expected = process.env.WS_PUBLIC_URL ? new URL(process.env.WS_PUBLIC_URL).origin : '';
            if (origin && origin !== expected && origin !== `${req.protocol}://${req.get('host')}`) {
                res.sendStatus(403);
                return;
            }
            const token = req.get('authorization')?.replace(/^Bearer /, '') || '';
            const actual = Buffer.from(token),
                wanted = Buffer.from(this.store.token);
            const localProxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
            // Serve strips spoofed identity headers. Accept them only from its local proxy,
            // never from requests arriving directly over the LAN listener.
            const tailscale = localProxy && !!req.get('tailscale-user-login') && !!expected;
            if (!tailscale && (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted))) {
                res.sendStatus(401);
                return;
            }
            const ip = req.socket.remoteAddress || 'unknown';
            let rate = this.attempts.get(ip);
            if (!rate || rate.reset < Date.now()) {
                rate = { count: 0, reset: Date.now() + 60000 };
                this.attempts.set(ip, rate);
            }
            if (++rate.count > 180) {
                res.sendStatus(429);
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
        route('get', '/status', (_req, res) => {
            this.prune();
            res.json({
                publicKey: this.store.vapid.publicKey,
                sources: this.store.sources,
                bluetooth: this.bluetooth,
                statuses: this.statuses,
                pairing: this.pairing,
                pairingOpen: this.pairingOpen,
                error: this.error,
                delivery: this.delivery,
                notifications: [...this.feed.values()]
                    .reverse()
                    .sort((a, b) => b.received - a.received)
                    .map(({ fingerprint: _fingerprint, reconnectable: _reconnectable, ...item }) => item),
                ...this.counts(),
                retentionDays: 30,
                publicUrl: process.env.WS_PUBLIC_URL || '',
            });
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
            res.json({ ok: true });
        });
        route('post', '/confirm', (req, res) => {
            if (!this.pairing || req.body.address !== this.pairing.address || req.body.code !== this.pairing.code)
                throw Error('Pairing code expired');
            this.command({ type: 'confirm', ...this.pairing });
            res.json({ ok: true });
        });
        route('post', '/sources', (req, res) => {
            const { id, address, name, apps, preview } = req.body;
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
                apps.some((a) => typeof a !== 'string' || a.length > 256)
            )
                throw Error('Invalid notification source');
            if (this.store.sources.some((s) => s.address === address.toUpperCase() && s.id !== id))
                throw Error('Bluetooth phone is already linked');
            if (this.store.sources.length >= 32 && !this.store.sources.some((s) => s.id === id))
                throw Error('Source limit reached');
            this.store.sources = [
                ...this.store.sources.filter((s) => s.id !== id),
                { id, address: address.toUpperCase(), name, apps, preview },
            ];
            this.invalidateSources();
            for (const item of this.feed.values())
                if (item.source === id && !preview) Object.assign(item, { title: '', subtitle: '', body: '' });
            this.saveHistory(true);
            this.deliveryGeneration++;
            this.save();
            this.child?.kill();
            res.json({ ok: true });
        });
        route('delete', '/sources/:id', (req, res) => {
            const id = req.params.id;
            this.store.sources = this.store.sources.filter((s) => s.id !== id);
            this.deliveryGeneration++;
            this.invalidateSources();
            for (const [key, item] of this.feed) if (item.source === id) this.feed.delete(key);
            for (const [key, value] of this.replayCandidates)
                if (!this.feed.has(value.historyKey || '')) this.replayCandidates.delete(key);
            this.icons.removeSource(id);
            this.saveHistory(true);
            this.save();
            this.child?.kill();
            res.json({ ok: true });
        });
        route('post', '/subscriptions', (req, res) => {
            const subscription = validateSubscription(req.body.subscription);
            const sources = req.body.sources;
            if (!Array.isArray(sources) || sources.some((id) => !this.store.sources.some((s) => s.id === id)))
                throw Error('Select valid source devices');
            const receiverSource = req.body.receiverSource || '';
            if (receiverSource && !this.store.sources.some((s) => s.id === receiverSource))
                throw Error('Invalid receiver device');
            const id = crypto.createHash('sha256').update(subscription.endpoint).digest('hex');
            if (this.store.subscriptions.length >= 100 && !this.store.subscriptions.some((s) => s.id === id))
                throw Error('Subscription limit reached');
            this.store.subscriptions = [
                ...this.store.subscriptions.filter((s) => s.id !== id),
                { id, subscription, sources, receiverSource, updated: Date.now() },
            ];
            this.deliveryGeneration++;
            this.save();
            res.json({ id });
        });
        route('delete', '/subscriptions', (req, res) => {
            this.deliveryGeneration++;
            this.store.subscriptions = this.store.subscriptions.filter(
                (s) => s.subscription.endpoint !== req.body.endpoint,
            );
            this.save();
            res.json({ ok: true });
        });
        route('post', '/test', (req, res) => {
            const sub = this.store.subscriptions.find((s) => s.subscription.endpoint === req.body.endpoint);
            if (!sub) throw Error('Enable notifications on this device first');
            this.enqueue(
                sub,
                JSON.stringify({
                    title: 'ws-scrcpy',
                    body: 'Notifications are ready on this device.',
                    tag: 'ws-scrcpy-test',
                    url: '#!action=notifications',
                }),
                'test',
            );
            res.json({ ok: true });
        });
        app.use(`${base.replace(/\/$/, '')}/api/notifications`, router);
    }
}
