import express, { Express, Request, Response } from 'express';
import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';
import { PushSubscription } from 'web-push';
import { getSettings } from '../Settings';
import { sameOrigin } from '../requestOrigin';
import { isDismissActionLabel } from '../../common/NotificationActions';
import { NotificationHistoryItem } from '../../common/Notification';
import { NotificationFeed } from './NotificationFeed';
import { NotificationIcons } from './NotificationIcons';
import { PushDelivery } from './PushDelivery';
import { FeedItem, NotificationStore, MUTED_APP_LIMIT, validMutedApp } from './NotificationStorage';
import * as schema from './NotificationSchema';

const gzip = promisify(zlib.gzip);

export interface NotificationRouteContext {
    store(): NotificationStore;
    disabled(): string;
    readonly notificationFeed: NotificationFeed;
    readonly feed: Map<string, FeedItem>;
    readonly icons: NotificationIcons;
    readonly push: PushDelivery;
    status(): Record<string, unknown>;
    prune(): void;
    history(source?: string): NotificationHistoryItem[];
    counts(): { unread: number; unreadBySource: Record<string, number> };
    saveHistory(immediate?: boolean): void;
    save(): void;
    invalidateSources(): void;
    restartCollector(): void;
    session(source: string): string | undefined;
    hasPendingAction(source: string): boolean;
    performAction(item: FeedItem, expectedLabel: unknown, timeout?: number): Promise<void>;
    pair(): Promise<void>;
    confirm(address: unknown, code: unknown): Promise<void>;
}

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

const readRequest = schema.object({
    keys: schema.optional(schema.array(schema.text(), 500)),
    source: schema.optional(schema.text()),
    read: schema.optional(schema.boolean),
    all: schema.optional(schema.boolean),
});
const selectionKey = schema.text(256, 1);
const dismissRequest = schema.object({ source: schema.text(), keys: schema.array(selectionKey, 500, 1) });
const restoreRequest = schema.object({
    source: schema.text(),
    items: schema.array(schema.object({ key: selectionKey, read: schema.boolean }), 500, 1),
});
const actionsRequest = schema.object({
    source: schema.text(),
    items: schema.array(schema.object({ key: selectionKey, expectedLabel: schema.text(128) }), 500, 1),
});
const sourceRequest = schema.object({
    id: schema.text(128, 1, /^[\w-]{1,128}$/),
    address: schema.text(Infinity, 0, /^(?:[A-Fa-f0-9]{2}:){5}[A-Fa-f0-9]{2}$/),
    name: schema.text(100),
    preview: schema.boolean,
    apps: schema.array(schema.text(256), 100),
    muted: schema.optional(schema.array(validMutedApp, MUTED_APP_LIMIT)),
});

/** HTTP validation and response policy, separate from collector and feed lifetimes. */
export class NotificationRoutes {
    private bulkSources = new Set<string>();
    constructor(private readonly service: NotificationRouteContext) {}

    mount(app: Express, base: string): void {
        const service = this.service;
        const router = express.Router();
        router.use(sameOrigin);
        router.use(express.json({ limit: '64kb', inflate: false }));
        router.use((req, res, next) => {
            res.setHeader('Cache-Control', 'no-store');
            // No request limit here. Behind Tailscale Serve every HTTPS client arrives from
            // 127.0.0.1, so a limit per address was one budget for all of them, and running out
            // of it showed "Connection interrupted" on every notifications page.
            if (service.disabled() && req.method !== 'GET') {
                res.status(503).json({ error: service.disabled() });
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
            service.prune();
            const storedBySource = service.notificationFeed.storedBySource(service.store().sources);
            res.json({
                publicKey: service.store().vapid.publicKey,
                sources: service.store().sources,
                ...service.status(),
                // One row per receiving device. The id is a hash, never the push endpoint.
                receivers: service.store().subscriptions.map((s) => ({
                    id: s.id,
                    provider: pushProvider(s.subscription.endpoint),
                    ...service.push.statsFor(s.id),
                })),
                historyRevision: historyRevision(JSON.stringify(service.history())),
                storedBySource,
                ...service.counts(),
                retentionDays: 30,
                publicUrl: getSettings().publicUrl || '',
            });
        });
        // The stored notifications, for one iPhone when `source` is given. `since` is the
        // revision the page already holds: 304 when nothing changed.
        route('get', '/history', async (req, res) => {
            service.prune();
            const { source, since } = req.query;
            if (source !== undefined && !service.store().sources.some((s) => s.id === source))
                throw Error('Unknown notification phone');
            const notifications = JSON.stringify(service.history(source as string | undefined));
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
            service.prune();
            res.json({ ...service.counts(), sources: service.store().sources.map(({ id, name }) => ({ id, name })) });
        });
        route('get', '/icons/:source/:app', async (req, res) => {
            if (!service.store().sources.some((s) => s.id === req.params.source))
                throw Error('Unknown notification phone');
            const png = await service.icons.get(req.params.source, req.params.app);
            if (!png) {
                res.sendStatus(404);
                return;
            }
            // An app's icon rarely changes. Misses stay uncached so that they are asked for again.
            res.setHeader('Cache-Control', 'private, max-age=86400');
            res.type('png').send(png);
        });
        route('post', '/history/read', (req, res) => {
            const message = 'Select notifications or a phone to mark read';
            const { keys, source, read = true, all = false } = schema.validate(readRequest, req.body, message);
            if (
                (all && (keys !== undefined || source !== undefined)) ||
                (source !== undefined && !service.store().sources.some((s) => s.id === source)) ||
                (keys === undefined && source === undefined && !all)
            )
                throw Error(message);
            const selected = keys === undefined ? undefined : new Set(keys);
            for (const item of service.feed.values()) {
                if ((source === undefined || source === item.source) && (!selected || selected.has(item.key)))
                    item.read = read;
            }
            service.saveHistory(true);
            res.json({ ok: true, ...service.counts() });
        });
        route('post', '/history/dismiss', (req, res) => {
            const message = 'Select a phone and the notifications to dismiss';
            const { source, keys } = schema.validate(dismissRequest, req.body, message);
            if (!service.store().sources.some((s) => s.id === source) || new Set(keys).size !== keys.length)
                throw Error(message);
            // Validate the full confirmed snapshot before changing any record.
            if (keys.some((key) => service.feed.has(key) && service.feed.get(key)!.source !== source))
                throw Error('All selected notifications must belong to the same phone');
            const dismissed: string[] = [];
            for (const key of keys) {
                const item = service.feed.get(key);
                if (!item || item.dismissed) continue;
                item.read = true;
                item.dismissed = true;
                dismissed.push(key);
            }
            service.saveHistory(true);
            res.json({ ok: true, dismissed, ...service.counts() });
        });
        // Undo for the local bulk actions: puts a confirmed set back in the inbox, each with the
        // read state it had. Like the single restore, it changes nothing on the iPhone.
        route('post', '/history/restore', (req, res) => {
            const message = 'Select a phone and the notifications to move back to the inbox';
            const { source, items } = schema.validate(restoreRequest, req.body, message);
            if (
                !service.store().sources.some((s) => s.id === source) ||
                new Set(items.map((item) => item.key)).size !== items.length
            )
                throw Error(message);
            if (items.some((item) => service.feed.has(item.key) && service.feed.get(item.key)!.source !== source))
                throw Error('All selected notifications must belong to the same phone');
            service.prune();
            const restored: string[] = [];
            for (const { key, read } of items) {
                const item = service.feed.get(key);
                if (!item) continue;
                item.dismissed = false;
                item.read = read;
                restored.push(key);
            }
            service.saveHistory(true);
            res.json({ ok: true, restored, ...service.counts() });
        });
        route('post', '/history/actions', async (req, res) => {
            const message = 'Select a phone and the notifications to dismiss on it';
            const { source, items } = schema.validate(actionsRequest, req.body, message);
            if (
                !service.store().sources.some((s) => s.id === source) ||
                new Set(items.map((item) => item.key)).size !== items.length
            )
                throw Error(message);
            if (items.some((item) => !isDismissActionLabel(item.expectedLabel)))
                throw Error('Bulk dismissal only supports actions explicitly labelled Clear or Dismiss');
            // Reject scope/label mistakes for the complete snapshot before any
            // action is written. Removed or expired history entries are skipped.
            for (const selected of items) {
                const item = service.feed.get(selected.key);
                if (item && item.source !== source)
                    throw Error('All selected notifications must belong to the same phone');
                if (item && item.negativeActionLabel !== selected.expectedLabel)
                    throw Error('An iPhone action changed. Refresh notifications before trying again.');
            }
            if (this.bulkSources.has(source) || service.hasPendingAction(source))
                throw Error('An iPhone action is already in progress for this phone');
            const accepted: string[] = [],
                skipped: string[] = [],
                unprocessed: string[] = [];
            const failed: Array<{ key: string; error: string }> = [];
            const session = service.session(source);
            const snapshot = items.map(({ key, expectedLabel }) => {
                const item = service.feed.get(key);
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
                    if (remaining <= 0 || service.session(source) !== session) {
                        unprocessed.push(...snapshot.slice(index).map((item) => item.key));
                        break;
                    }
                    const item = service.feed.get(selected.key);
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
                        await service.performAction(item, selected.expectedLabel, Math.min(15000, remaining));
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
                ...service.counts(),
            });
        });
        route('post', '/history/:key/dismiss', (req, res) => {
            const item = service.feed.get(req.params.key);
            if (!item) throw Error('This notification is no longer in history');
            item.read = true;
            item.dismissed = true;
            service.saveHistory(true);
            res.json({ ok: true, ...service.counts() });
        });
        route('post', '/history/:key/restore', (req, res) => {
            const { read = true } = schema.validate(
                schema.object({ read: schema.optional(schema.boolean) }),
                req.body,
                'Choose a valid read state for the restored notification',
            );
            service.prune();
            const item = service.feed.get(req.params.key);
            if (!item) throw Error('This notification is no longer in history');
            // Undo affects this app's inbox only. It cannot restore an alert that
            // iOS has already removed or revive an earlier Bluetooth session.
            item.dismissed = false;
            item.read = read;
            service.saveHistory(true);
            res.json({ ok: true, ...service.counts() });
        });
        route('post', '/history/:key/action', async (req, res) => {
            const item = service.feed.get(req.params.key);
            if (!item) throw Error('This notification is no longer in history');
            if (this.bulkSources.has(item.source)) throw Error('A bulk dismissal is already running for this iPhone');
            await service.performAction(item, req.body.expectedLabel);
            res.json({ ok: true, ...service.counts() });
        });
        route('post', '/pair', async (_req, res) => {
            await service.pair();
            res.json({ ok: true });
        });
        route('post', '/confirm', async (req, res) => {
            await service.confirm(req.body.address, req.body.code);
            res.json({ ok: true });
        });
        // The whole record of one iPhone. `apps` is the older allow-list. `muted` is optional: a
        // page left open since before the mute list existed sends none, and the list is kept.
        route('post', '/sources', (req, res) => {
            const { id, address, name, apps, preview, muted } = schema.validate(
                sourceRequest,
                req.body,
                'Invalid notification source',
            );
            if (!name.trim()) throw Error('Invalid notification source');
            if (service.store().sources.some((s) => s.address === address.toUpperCase() && s.id !== id))
                throw Error('Bluetooth phone is already linked');
            if (service.store().sources.length >= 32 && !service.store().sources.some((s) => s.id === id))
                throw Error('Source limit reached');
            const existing = service.store().sources.find((source) => source.id === id);
            const connectionChanged = existing?.address !== address.toUpperCase();
            // Without `muted` the record is stored as such a request always stored it, with the
            // list it already had.
            const mutedApps =
                muted === undefined
                    ? existing?.muted
                    : [...new Map(muted.map(({ app, name }) => [app, name]))].map(([app, name]) => ({
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
            service.store().sources = existing
                ? service.store().sources.map((s) => (s.id === id ? record : s))
                : [...service.store().sources, record];
            if (connectionChanged) service.invalidateSources();
            if (!preview) service.notificationFeed.forgetText(id);
            service.saveHistory(true);
            service.save();
            if (connectionChanged) service.restartCollector();
            res.json({ ok: true });
        });
        route('delete', '/sources/:id', (req, res) => {
            const id = req.params.id;
            service.store().sources = service.store().sources.filter((s) => s.id !== id);
            service.invalidateSources();
            service.notificationFeed.removeSource(id);
            service.icons.removeSource(id);
            service.saveHistory(true);
            service.save();
            service.restartCollector();
            res.json({ ok: true });
        });
        route('post', '/subscriptions', (req, res) => {
            const subscription = validateSubscription(req.body.subscription);
            // The browser replaced its subscription while the app was closed. The service worker
            // names the old endpoint and the record keeps its choices, which only the page knows.
            const replaced =
                typeof req.body.replaces === 'string'
                    ? service.store().subscriptions.find((s) => s.subscription.endpoint === req.body.replaces)
                    : undefined;
            const sources =
                req.body.sources ?? replaced?.sources.filter((id) => service.store().sources.some((s) => s.id === id));
            if (!Array.isArray(sources) || sources.some((id) => !service.store().sources.some((s) => s.id === id)))
                throw Error('Select valid source phones');
            const receiverSource = req.body.receiverSource ?? replaced?.receiverSource ?? '';
            if (receiverSource && !service.store().sources.some((s) => s.id === receiverSource))
                throw Error('Invalid receiver device');
            const id = crypto.createHash('sha256').update(subscription.endpoint).digest('hex');
            const kept = service.store().subscriptions.filter((s) => s.id !== id && s !== replaced);
            if (kept.length >= 100) throw Error('Subscription limit reached');
            if (replaced && replaced.id !== id) service.push.forget(replaced.id);
            service.store().subscriptions = [
                ...kept,
                { id, subscription, sources, receiverSource, updated: Date.now() },
            ];
            service.save();
            res.json({ id });
        });
        route('delete', '/subscriptions', (req, res) => {
            for (const s of service.store().subscriptions)
                if (s.subscription.endpoint === req.body.endpoint) service.push.forget(s.id);
            service.store().subscriptions = service
                .store()
                .subscriptions.filter((s) => s.subscription.endpoint !== req.body.endpoint);
            service.save();
            res.json({ ok: true });
        });
        route('post', '/test', (req, res) => {
            const sub = service.store().subscriptions.find((s) => s.subscription.endpoint === req.body.endpoint);
            if (!sub) throw Error('Enable notifications on this device first');
            service.push.enqueue(
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
