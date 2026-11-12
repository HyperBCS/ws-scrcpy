import crypto from 'crypto';
import { NotificationEvent, NotificationHistoryItem, NotificationSource } from '../../common/Notification';
import type { FeedItem, SubscriptionRecord } from './NotificationStorage';

/**
 * The stored notifications of every iPhone and what is needed to keep them right across
 * Bluetooth reconnects: receive, replay, pruning and counts. Pure: it reads no file, starts no
 * timer and sends nothing. `NotificationService` saves the history when `receive` or `prune`
 * reports a change, and pushes the key `receive` returns.
 */

// History is kept for 30 days, up to 500 notifications per iPhone.
export const HISTORY_MS = 30 * 86400000;
export const HISTORY_PER_SOURCE = 500;
// The hints that recognise an alert announced again after a reconnect are kept for an hour,
// 2000 of each at most.
const HINT_MS = 3600000;
const HINT_LIMIT = 2000;

type FingerprintFields = Pick<NotificationEvent, 'source' | 'app' | 'title' | 'subtitle' | 'body' | 'date'>;
const digest = (value: unknown[]): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Marks a fingerprint that holds no text, so one made from text is never kept for a phone
// whose previews are off.
export const REDUCED_FINGERPRINT = 'l:';

/** Identifies an alert that the iPhone announces again after a reconnect. Made from its text. */
export function textFingerprint(event: FingerprintFields): string | undefined {
    return event.date
        ? digest([event.source, event.app, event.title || '', event.subtitle || '', event.body || '', event.date])
        : undefined;
}

/**
 * The same for a phone with previews off. A hash of short, fixed-form text ("Your code is
 * 123456") can be reversed by trying every candidate, so this one holds only the app, the time
 * and the length of each text. The lengths are capped the way stored text is.
 */
export function reducedFingerprint(event: FingerprintFields): string | undefined {
    const length = (value: string | undefined, limit: number) => Math.min((value || '').length, limit);
    return event.date
        ? REDUCED_FINGERPRINT +
              digest([
                  event.source,
                  event.app,
                  length(event.title, 1024),
                  length(event.subtitle, 1024),
                  length(event.body, 4096),
                  event.date,
              ])
        : undefined;
}

/**
 * Whether an app is on the mute list of an iPhone. Settings saved before the list existed have
 * none and are read as they are.
 */
export function isMuted(source: NotificationSource, app: string | undefined): boolean {
    return !!app && Array.isArray(source.muted) && source.muted.some((entry) => entry?.app === app);
}

/**
 * The one filter for an iPhone's alert. Without a subscription: whether it is kept at all. An
 * app is kept when it is not the relay itself (a push received on its source phone comes back
 * through ANCS), when the older allow-list is empty or names it, and when it is not muted. The
 * mute list applies on top of an allow-list. With a subscription: whether that subscription is
 * sent a push for it.
 */
export function shouldRelay(event: NotificationEvent, source: NotificationSource, sub?: SubscriptionRecord): boolean {
    const kept =
        !!event.app &&
        !event.app.startsWith('com.apple.WebKit.WebPush') &&
        !event.app.startsWith('com.apple.WebKit.PushBundle') &&
        (!source.apps.length || source.apps.includes(event.app)) &&
        !isMuted(source, event.app);
    if (!sub) return kept;
    return (
        kept &&
        event.event === 'added' &&
        !event.preExisting &&
        sub.sources.includes(source.id) &&
        sub.receiverSource !== source.id
    );
}

interface ReplayCandidate {
    fingerprint: string;
    session: string;
    received: number;
    historyKey?: string;
}

/** What one collector event did. */
export interface Received {
    /** The history changed and must be saved. */
    changed: boolean;
    /** A new alert: its key, for the subscriptions that `shouldRelay` lets through. */
    push?: string;
}

export class NotificationFeed {
    /** The history, by key. */
    readonly items = new Map<string, FeedItem>();
    /** When each alert of a Bluetooth session was first seen, so it is pushed once. */
    readonly observed = new Map<string, number>();
    /** Alerts of earlier sessions, by their fingerprint, to recognise one announced again. */
    readonly replayCandidates = new Map<string, ReplayCandidate>();
    /** The history key of each alert of a session. */
    private readonly liveKeys = new Map<string, string>();

    constructor(
        private readonly now: () => number = Date.now,
        private readonly newKey: () => string = () => crypto.randomUUID(),
    ) {}

    /**
     * Takes the saved history. Returns true when a record had to be changed, so the history is
     * saved again. History written before reduced fingerprints existed kept a hash of the text
     * for phones with previews off. The text is gone, so the hash cannot be replaced; it is dropped.
     */
    load(items: FeedItem[], sources: NotificationSource[]): boolean {
        let redacted = false;
        for (const item of items) {
            const preview = sources.find((source) => source.id === item.source)?.preview;
            if (!preview && item.fingerprint && !item.fingerprint.startsWith(REDUCED_FINGERPRINT)) {
                delete item.fingerprint;
                redacted = true;
            }
            this.items.set(item.key, item);
        }
        this.rememberReplays();
        return redacted;
    }

    /**
     * A phone can reconnect after the short push-dedup window. Rebuilds one-to-one history hints
     * from the retained, never-removed lifetimes: of one iPhone when it starts a session, of
     * every iPhone when the history is loaded.
     */
    rememberReplays(source?: string): void {
        for (const item of this.items.values()) {
            if ((source === undefined || item.source === source) && item.reconnectable && item.fingerprint) {
                this.replayCandidates.set(`${item.source}:${item.session}:${item.uid}`, {
                    fingerprint: item.fingerprint,
                    session: item.session,
                    received: this.now(),
                    historyKey: item.key,
                });
            }
        }
    }

    /** No stored alert of this iPhone (of any, without one) can be acted on any more. */
    deactivate(source?: string): void {
        for (const item of this.items.values()) {
            if (!source || item.source === source) item.active = false;
        }
    }

    /** The collector reported the link to an iPhone: its alerts of `session` are live while it receives. */
    setActive(source: string, session: string | undefined, receiving: boolean): void {
        for (const item of this.items.values()) {
            if (item.source === source) item.active = receiving && item.session === session && item.reconnectable;
        }
    }

    /**
     * One collector event. `session` is the Bluetooth session the service holds for the iPhone;
     * an event of another session is left out.
     */
    receive(event: NotificationEvent, source: NotificationSource | undefined, session: string | undefined): Received {
        let changed = this.prune();
        if (
            !source ||
            typeof event.session !== 'string' ||
            event.session.length > 128 ||
            !Number.isInteger(event.uid) ||
            event.uid < 0 ||
            event.uid > 0xffffffff ||
            !['added', 'modified', 'removed'].includes(event.event)
        )
            return { changed };
        if (session !== undefined && session !== event.session) return { changed };
        const eventKey = `${event.source}:${event.session}:${event.uid}`;
        const current = this.items.get(this.liveKeys.get(eventKey) || '');
        if (event.event === 'removed') {
            if (current) {
                current.active = false;
                current.reconnectable = false;
                current.canDismiss = false;
                changed = true;
            }
            this.liveKeys.delete(eventKey);
            this.observed.delete(eventKey);
            this.replayCandidates.delete(eventKey);
            return { changed };
        }
        if (!event.app || event.app.length > 512 || !shouldRelay(event, source)) return { changed };
        // Only the kind this phone's setting allows is kept. An earlier record is compared under
        // both, because it holds the kind that was allowed when it was stored.
        const known = [textFingerprint(event), reducedFingerprint(event)];
        const fingerprint = source.preview ? known[0] : known[1];
        // Match only one previous lifetime per new UID. Preserve its app read state
        // and stable history key while replacing transient Bluetooth identifiers.
        const replay =
            !current && fingerprint && event.event === 'added'
                ? [...this.replayCandidates].find(
                      ([, candidate]) => candidate.session !== event.session && known.includes(candidate.fingerprint),
                  )
                : undefined;
        const previous = current || (replay?.[1].historyKey ? this.items.get(replay[1].historyKey) : undefined);
        const key = previous?.key || this.newKey();
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
            received: previous?.received || this.now(),
            read: previous?.read || false,
            dismissed: previous?.dismissed || false,
            active: session === event.session,
            reconnectable: true,
            fingerprint,
        };
        this.items.set(key, item);
        this.liveKeys.set(eventKey, key);
        if (event.event === 'modified') {
            if (this.replayCandidates.has(eventKey)) {
                if (fingerprint)
                    this.replayCandidates.set(eventKey, {
                        fingerprint,
                        session: event.session,
                        received: this.now(),
                        historyKey: key,
                    });
                else this.replayCandidates.delete(eventKey);
            }
            this.prune();
            return { changed: true };
        }
        if (this.observed.has(eventKey)) {
            this.prune();
            return { changed: true };
        }
        this.observed.set(eventKey, this.now());
        if (replay) this.replayCandidates.delete(replay[0]);
        if (fingerprint)
            this.replayCandidates.set(eventKey, {
                fingerprint,
                session: event.session,
                received: this.now(),
                historyKey: key,
            });
        this.prune();
        return replay || event.preExisting ? { changed: true } : { changed: true, push: key };
    }

    /**
     * Drops what is too old or too many: history after 30 days or past 500 per iPhone, hints
     * after an hour or past 2000. Returns true when history was dropped, so it is saved.
     */
    prune(): boolean {
        const now = this.now();
        const cutoff = now - HINT_MS;
        const historyCutoff = now - HISTORY_MS;
        const counts = new Map<string, number>();
        let changed = false;
        for (const [key, item] of [...this.items].reverse().sort((a, b) => b[1].received - a[1].received)) {
            const count = (counts.get(item.source) || 0) + 1;
            counts.set(item.source, count);
            if (item.received < historyCutoff || count > HISTORY_PER_SOURCE) {
                this.items.delete(key);
                changed = true;
            }
        }
        for (const [key, value] of this.liveKeys) if (!this.items.has(value)) this.liveKeys.delete(key);
        for (const [key, time] of this.observed) if (time < cutoff) this.observed.delete(key);
        for (const [key, value] of this.replayCandidates)
            if (value.received < cutoff) this.replayCandidates.delete(key);
        while (this.observed.size > HINT_LIMIT) this.observed.delete(this.observed.keys().next().value!);
        while (this.replayCandidates.size > HINT_LIMIT)
            this.replayCandidates.delete(this.replayCandidates.keys().next().value!);
        return changed;
    }

    /** Unread and not archived, for each iPhone and in all. */
    counts(sources: NotificationSource[]): { unread: number; unreadBySource: Record<string, number> } {
        const unreadBySource: Record<string, number> = Object.fromEntries(sources.map((s) => [s.id, 0]));
        for (const item of this.items.values()) if (!item.read && !item.dismissed) unreadBySource[item.source]++;
        return { unread: Object.values(unreadBySource).reduce((sum, n) => sum + n, 0), unreadBySource };
    }

    /** How many notifications are held for each iPhone. */
    storedBySource(sources: NotificationSource[]): Record<string, number> {
        const stored: Record<string, number> = Object.fromEntries(sources.map((s) => [s.id, 0]));
        for (const item of this.items.values()) stored[item.source] = (stored[item.source] || 0) + 1;
        return stored;
    }

    /** The history as the page shows it: newest first, without the fields only the server uses. */
    history(source?: string): NotificationHistoryItem[] {
        return [...this.items.values()]
            .filter((item) => source === undefined || item.source === source)
            .reverse()
            .sort((a, b) => b.received - a.received)
            .map(({ fingerprint: _fingerprint, reconnectable: _reconnectable, ...item }) => item);
    }

    /** Previews were turned off: the text goes, and so does anything it could be recovered from. */
    forgetText(source: string): void {
        for (const item of this.items.values()) {
            if (item.source !== source) continue;
            if (item.fingerprint && !item.fingerprint.startsWith(REDUCED_FINGERPRINT))
                item.fingerprint = reducedFingerprint(item);
            Object.assign(item, { title: '', subtitle: '', body: '' });
        }
        for (const [key, candidate] of this.replayCandidates) {
            const item = this.items.get(candidate.historyKey || '');
            if (item?.source !== source && !key.startsWith(`${source}:`)) continue;
            if (item?.fingerprint) candidate.fingerprint = item.fingerprint;
            else this.replayCandidates.delete(key);
        }
    }

    /** An iPhone was removed: its history and the hints that point into it go. */
    removeSource(source: string): void {
        for (const [key, item] of this.items) if (item.source === source) this.items.delete(key);
        for (const [key, value] of this.replayCandidates)
            if (!this.items.has(value.historyKey || '')) this.replayCandidates.delete(key);
    }
}
