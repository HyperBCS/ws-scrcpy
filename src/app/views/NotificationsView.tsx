import { Presence } from '../ui/Presence';
import { Toast } from '../ui/Toast';
import { AnimatedDetails } from '../ui/AnimatedDetails';
import { useEffect, useRef, useState } from 'preact/hooks';
import { devices, deviceName } from '../state/devices';
import {
    notificationRequest as api,
    notificationKey,
    setNotificationKey,
    registerNotificationWorker,
    applyNotificationSummary,
} from '../state/notifications';
import { NotificationHistory, UnreadBadge, HistoryItem } from './NotificationHistory';
import { route } from '../state/router';
import type { NotificationSource } from '../../server/notifications/NotificationService';
import '../../style/views/Notifications.css';

type Status = {
    publicKey: string;
    publicUrl?: string;
    sources: NotificationSource[];
    bluetooth: Array<{ address: string; name: string; paired: boolean; connected: boolean }>;
    statuses: Record<string, string>;
    pairing: { address: string; code: string } | null;
    pairingOpen: boolean;
    error: string;
    delivery: { sent: number; failed: number; lastError: string };
    notifications: HistoryItem[];
    unread: number;
    unreadBySource: Record<string, number>;
};

function savedSources(): string[] | null {
    try {
        const saved: unknown = JSON.parse(localStorage.getItem('notification-sources') || 'null');
        return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : null;
    } catch {
        return null;
    }
}

function choicesKey(sources: string[], receiver: string): string {
    return JSON.stringify({ sources: [...sources].sort(), receiver });
}

function SourceSettings({
    source,
    busy,
    update,
    remove,
}: {
    source: NotificationSource;
    busy: boolean;
    update: (source: NotificationSource) => void;
    remove: () => void;
}) {
    const [filter, setFilter] = useState(source.apps.join(', '));
    useEffect(() => setFilter(source.apps.join(', ')), [source.apps.join(', ')]);
    return (
        <AnimatedDetails class="notification-details">
            <summary>Settings for {source.name}</summary>
            <div class="notification-details-content">
                <label class="notification-check">
                    <input
                        type="checkbox"
                        checked={source.preview}
                        disabled={busy}
                        onChange={(e) => update({ ...source, preview: e.currentTarget.checked })}
                    />
                    <span>Include notification text</span>
                </label>
                <p class="notification-help">
                    Missing message text? Check Show Previews in this iPhone’s notification settings.
                </p>
                <AnimatedDetails class="notification-details">
                    <summary>
                        Filter by app · {source.apps.length ? `${source.apps.length} selected` : 'All apps'}
                    </summary>
                    <div class="notification-details-content">
                        <label>
                            App identifiers
                            <input
                                value={filter}
                                onInput={(e) => setFilter(e.currentTarget.value)}
                                placeholder="For example: com.apple.MobileSMS"
                                disabled={busy}
                            />
                        </label>
                        <p class="notification-help">Comma-separated. Leave empty for all apps.</p>
                        <button
                            disabled={busy || filter === source.apps.join(', ')}
                            onClick={() =>
                                update({
                                    ...source,
                                    apps: filter
                                        .split(',')
                                        .map((app) => app.trim())
                                        .filter(Boolean),
                                })
                            }
                        >
                            Save app filter
                        </button>
                    </div>
                </AnimatedDetails>
                <button class="notification-danger" disabled={busy} onClick={remove}>
                    Remove iPhone
                </button>
            </div>
        </AnimatedDetails>
    );
}

export function NotificationsView() {
    const [status, setStatus] = useState<Status>();
    const [connectionError, setConnectionError] = useState('');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [key, setKey] = useState(notificationKey());
    const [running, setRunning] = useState(0);
    const busy = running > 0;
    const [panel, setPanel] = useState<'history' | 'setup'>();
    const [subscription, setSubscription] = useState<PushSubscription | null>(null);
    const [workerLoaded, setWorkerLoaded] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);
    const [receiverChoice, setReceiver] = useState(localStorage.getItem('notification-receiver-source') || '');
    const [savedChoices, setSavedChoices] = useState<string | null>(null);
    const [phone, setPhone] = useState(route.value.get('source') || '');
    const [address, setAddress] = useState('');
    const [initialized, setInitialized] = useState(false);
    const statusRequest = useRef(0);
    const mounted = useRef(true);
    const ios =
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const installed =
        matchMedia('(display-mode: standalone)').matches ||
        !!(navigator as Navigator & { standalone?: boolean }).standalone;
    const supported =
        window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const phones = [...devices.value.values()].filter((d) => d.params.type !== 'android');
    const unlinkedPhones = phones.filter((p) => !status?.sources.some((s) => s.id === p.descriptor.udid));
    const chosenPhone = unlinkedPhones.some((p) => p.descriptor.udid === phone)
        ? phone
        : unlinkedPhones.length === 1
          ? unlinkedPhones[0].descriptor.udid
          : '';
    const pairings =
        status?.bluetooth.filter((b) => b.paired && !status.sources.some((s) => s.address === b.address)) || [];
    const chosenAddress = pairings.some((b) => b.address === address) ? address : '';
    // Always render an option that exists; an unmatched select value can appear blank in Preact.
    const receiver = status?.sources.some((s) => s.id === receiverChoice) ? receiverChoice : '';
    const effectiveSources = status?.sources.filter((s) => selected.includes(s.id) && s.id !== receiver) || [];
    const confirmed = savedChoices ? (JSON.parse(savedChoices) as { sources: string[]; receiver: string }) : null;
    const activeSources =
        status?.sources.filter((s) => confirmed?.sources.includes(s.id) && s.id !== confirmed.receiver) || [];
    const changed = initialized && choicesKey(selected, receiver) !== savedChoices;
    const blockedPermission = supported && Notification.permission === 'denied';
    const enabled = !!subscription && !blockedPermission;
    const canEnable = supported && (!ios || installed) && workerLoaded && initialized && effectiveSources.length > 0;
    const privateApp = new URL(status?.publicUrl || 'https://mini-nuc.tailea1801.ts.net/');
    privateApp.hash = '!action=notifications';
    const privateUrl = privateApp.href;

    const refresh = async () => {
        const request = ++statusRequest.current;
        try {
            const result = await api<Status>('status');
            // A slow poll must not overwrite a source added or removed by a newer refresh.
            if (mounted.current && request === statusRequest.current) {
                setStatus(result);
                applyNotificationSummary(result);
                setConnectionError('');
            }
            return result;
        } catch (e) {
            if (mounted.current && request === statusRequest.current) setConnectionError((e as Error).message);
            throw e;
        }
    };
    useEffect(() => {
        document.body.className = 'list';
        document.title = 'Notifications · ws-scrcpy';
        mounted.current = true;
        let alive = true;
        const poll = () => refresh().catch(() => undefined);
        void poll();
        const timer = window.setInterval(poll, 5000);
        navigator.serviceWorker?.addEventListener('message', poll);
        document.addEventListener('visibilitychange', poll);
        if (supported)
            void registerNotificationWorker()
                .then((r) => r.pushManager.getSubscription())
                .then((s) => {
                    if (alive) setSubscription(s);
                })
                .catch((e) => {
                    if (alive) setError(`Could not check notifications on this device: ${e.message}`);
                })
                .finally(() => {
                    if (alive) setWorkerLoaded(true);
                });
        else setWorkerLoaded(true);
        return () => {
            alive = false;
            mounted.current = false;
            statusRequest.current++;
            clearInterval(timer);
            navigator.serviceWorker?.removeEventListener('message', poll);
            document.removeEventListener('visibilitychange', poll);
        };
    }, []);
    useEffect(() => {
        if (!status) return;
        const valid = new Set(status.sources.map((s) => s.id));
        if (!initialized) {
            const saved = savedSources();
            setSelected(saved ? saved.filter((id) => valid.has(id)) : status.sources.map((s) => s.id));
            if (saved) setSavedChoices(choicesKey(saved, localStorage.getItem('notification-receiver-source') || ''));
            setInitialized(true);
        } else
            setSelected((current) => {
                const remaining = current.filter((id) => valid.has(id));
                return remaining.length === current.length ? current : remaining;
            });
        setReceiver((current) => (valid.has(current) ? current : ''));
    }, [status, initialized]);
    const run = async (fn: () => Promise<void>) => {
        setRunning((value) => value + 1);
        setError('');
        setMessage('');
        try {
            await fn();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setRunning((value) => Math.max(0, value - 1));
        }
    };
    const saveSubscription = async (sub: PushSubscription) => {
        await api('subscriptions', 'POST', { subscription: sub.toJSON(), sources: selected, receiverSource: receiver });
        localStorage.setItem('notification-sources', JSON.stringify(selected));
        localStorage.setItem('notification-receiver-source', receiver);
        setSavedChoices(choicesKey(selected, receiver));
    };
    const enable = () => {
        // Safari requires this call in the original button gesture, before any awaits.
        const permission = Notification.requestPermission();
        void run(async () => {
            if ((await permission) !== 'granted')
                throw Error('Allow notifications for this app in this device’s settings, then try again.');
            const registration = await registerNotificationWorker();
            await navigator.serviceWorker.ready;
            const existing = await registration.pushManager.getSubscription();
            const bytes = Uint8Array.from(atob(status!.publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
                c.charCodeAt(0),
            );
            const sub =
                existing ||
                (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes }));
            await saveSubscription(sub);
            setSubscription(sub);
            setMessage('Notifications enabled on this device.');
        });
    };
    const requestedSource = route.value.get('source') || '';
    const historySource =
        status?.sources.find((source) => source.id === requestedSource) ||
        (!requestedSource ? status?.sources[0] : undefined);
    useEffect(() => {
        if (requestedSource && status) {
            setPanel(status.sources.some((source) => source.id === requestedSource) ? 'history' : 'setup');
            setPhone(requestedSource);
        }
    }, [requestedSource, !!status]);
    const activePanel = historySource ? panel || 'history' : 'setup';
    const updateSource = async (source: NotificationSource) => {
        await api('sources', 'POST', source);
        await refresh();
    };

    return (
        <main class="notifications-page">
            <header class="notification-page-header">
                <a href="#!">← Devices</a>
                <h1>
                    Notifications{' '}
                    <UnreadBadge count={historySource ? status?.unreadBySource?.[historySource.id] || 0 : 0} />
                </h1>
                {(!status || status.sources.length <= 1 || activePanel === 'setup') && (
                    <p>{historySource?.name || 'Connect an iPhone to receive its alerts.'}</p>
                )}
            </header>
            {connectionError && status && (
                <p role="alert" class="notification-notice notification-error">
                    Connection interrupted. {connectionError}
                </p>
            )}
            <Presence
                show={!!error}
                kind="collapse"
                role="alert"
                class="notification-notice notification-error notification-feedback"
            >
                {error}
            </Presence>
            <Toast message={message} identity={message} onDismiss={() => setMessage('')} />
            {!status && !connectionError && (
                <p role="status" class="notification-empty">
                    Loading…
                </p>
            )}
            {!status && connectionError && (
                <section class="notification-card">
                    <h2>Open your private app</h2>
                    <p>Connect this device to Tailscale, then open the secure app to manage notifications.</p>
                    <a class="notification-primary notification-link-button" href={privateUrl}>
                        Open private app
                    </a>
                    <AnimatedDetails class="notification-details">
                        <summary>Connect with a setup key instead</summary>
                        <div class="notification-details-content">
                            <p class="notification-help">
                                For direct access to the NUC. The setup key is stored on the server.
                            </p>
                            <label>
                                Setup key
                                <input
                                    type="password"
                                    value={key}
                                    onInput={(e) => setKey(e.currentTarget.value)}
                                    autoComplete="off"
                                />
                            </label>
                            <button
                                disabled={busy || !key.trim()}
                                onClick={() =>
                                    void run(async () => {
                                        setNotificationKey(key);
                                        await refresh();
                                    })
                                }
                            >
                                Connect
                            </button>
                        </div>
                    </AnimatedDetails>
                    <AnimatedDetails class="notification-details">
                        <summary>Connection details</summary>
                        <p class="notification-help">{connectionError}</p>
                    </AnimatedDetails>
                </section>
            )}
            {status && (
                <>
                    <nav
                        class="notification-page-tabs"
                        style={{ '--segment-index': activePanel === 'setup' ? 1 : 0 }}
                        aria-label="Notification pages"
                    >
                        <button
                            disabled={!historySource}
                            aria-pressed={activePanel === 'history'}
                            onClick={() => setPanel('history')}
                        >
                            History
                        </button>
                        <button aria-pressed={activePanel === 'setup'} onClick={() => setPanel('setup')}>
                            Setup &amp; delivery
                        </button>
                    </nav>
                    <div class="notification-panels">
                        <Presence show={activePanel === 'history'} class="notification-panel">
                            <NotificationHistory
                                sources={status.sources}
                                items={status.notifications}
                                unreadBySource={status.unreadBySource || {}}
                                busy={busy}
                                run={run}
                                refresh={refresh}
                            />
                        </Presence>
                        <Presence show={activePanel === 'setup'} class="notification-panel" keepMounted>
                            <section class="notification-card" aria-labelledby="notification-sender-heading">
                                <div class="notification-section-heading">
                                    <h2 id="notification-sender-heading">Send from an iPhone</h2>
                                </div>
                                <p class="notification-help">Keep the iPhone within Bluetooth range of the NUC.</p>
                                {status.error && (
                                    <p role="alert" class="notification-notice notification-error">
                                        {status.error}
                                    </p>
                                )}
                                {status.sources.map((s) => {
                                    const ready = status.statuses[s.id] === 'Receiving notifications';
                                    return (
                                        <article class="notification-source" key={s.id}>
                                            <div class="notification-source-heading">
                                                <h3>{s.name}</h3>
                                                <span class={`notification-badge ${ready ? 'ready' : ''}`}>
                                                    {ready ? 'Connected' : 'Connecting…'}
                                                </span>
                                            </div>
                                            {!ready && (
                                                <p class="notification-help">
                                                    {status.statuses[s.id] ||
                                                        'Waiting for Bluetooth. Keep the iPhone near the NUC.'}
                                                </p>
                                            )}
                                            <SourceSettings
                                                source={s}
                                                busy={busy}
                                                update={(source) =>
                                                    void run(async () => {
                                                        await updateSource(source);
                                                        setMessage('iPhone settings saved.');
                                                    })
                                                }
                                                remove={() =>
                                                    void run(async () => {
                                                        await api(`sources/${encodeURIComponent(s.id)}`, 'DELETE');
                                                        await refresh();
                                                        setMessage(`${s.name} removed from notification sharing.`);
                                                    })
                                                }
                                            />
                                        </article>
                                    );
                                })}
                                <AnimatedDetails
                                    class="notification-details notification-pairing"
                                    open={!status.sources.length || status.pairingOpen || !!status.pairing}
                                >
                                    <summary>
                                        {status.sources.length ? 'Add another iPhone' : 'Connect your first iPhone'}
                                    </summary>
                                    <div class="notification-details-content">
                                        <p>Use the iPhone whose notifications you want to forward.</p>
                                        <ol class="notification-setup-steps">
                                            <li>Connect that iPhone to the NUC by USB.</li>
                                            <li>
                                                Tap <strong>Start Bluetooth pairing</strong>, then on that iPhone open{' '}
                                                <strong>Settings → Bluetooth → ws-scrcpy</strong>.
                                            </li>
                                            <li>
                                                Confirm the matching code and allow{' '}
                                                <strong>Share System Notifications</strong>.
                                            </li>
                                        </ol>
                                        <button
                                            disabled={busy || status.pairingOpen}
                                            onClick={() =>
                                                void run(async () => {
                                                    await api('pair', 'POST');
                                                    setMessage(
                                                        'On the sending iPhone, open Settings → Bluetooth and choose ws-scrcpy.',
                                                    );
                                                    await refresh();
                                                })
                                            }
                                        >
                                            {status.pairingOpen
                                                ? 'Waiting for your iPhone…'
                                                : 'Start Bluetooth pairing'}
                                        </button>
                                        {status.pairingOpen && (
                                            <p role="status" class="notification-help">
                                                The NUC is discoverable for two minutes.
                                            </p>
                                        )}
                                        {status.pairing && (
                                            <div class="notification-notice">
                                                <p>Does this code match the one on the sending iPhone?</p>
                                                <strong class="notification-pairing-code">{status.pairing.code}</strong>
                                                <button
                                                    class="notification-primary"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        void run(async () => {
                                                            await api('confirm', 'POST', status.pairing);
                                                            await refresh();
                                                        })
                                                    }
                                                >
                                                    Codes match
                                                </button>
                                            </div>
                                        )}
                                        <div class="notification-link-phones">
                                            <h3>Match the two connections</h3>
                                            <p class="notification-help">
                                                Choose the same iPhone in both lists. This connects its screen controls
                                                with its Bluetooth alerts.
                                            </p>
                                            <label>
                                                iPhone connected to the NUC by USB
                                                <select
                                                    value={chosenPhone}
                                                    disabled={busy}
                                                    onChange={(e) => setPhone(e.currentTarget.value)}
                                                >
                                                    <option value="">
                                                        {unlinkedPhones.length
                                                            ? 'Choose an iPhone'
                                                            : 'No new iPhone connected by USB'}
                                                    </option>
                                                    {unlinkedPhones.map((p) => (
                                                        <option key={p.key} value={p.descriptor.udid}>
                                                            {deviceName(p)}
                                                        </option>
                                                    ))}
                                                </select>
                                            </label>
                                            <label>
                                                The same iPhone in Bluetooth
                                                <select
                                                    value={chosenAddress}
                                                    disabled={busy}
                                                    onChange={(e) => setAddress(e.currentTarget.value)}
                                                >
                                                    <option value="">
                                                        {pairings.length
                                                            ? 'Choose its Bluetooth name'
                                                            : 'Complete Bluetooth pairing first'}
                                                    </option>
                                                    {pairings.map((b) => (
                                                        <option key={b.address} value={b.address}>
                                                            {b.name} · {b.address}
                                                        </option>
                                                    ))}
                                                </select>
                                            </label>
                                            <button
                                                class="notification-primary"
                                                disabled={busy || !chosenPhone || !chosenAddress}
                                                onClick={() =>
                                                    void run(async () => {
                                                        const entry = unlinkedPhones.find(
                                                            (p) => p.descriptor.udid === chosenPhone,
                                                        )!;
                                                        await updateSource({
                                                            id: chosenPhone,
                                                            address: chosenAddress,
                                                            name: deviceName(entry),
                                                            apps: [],
                                                            preview: true,
                                                        });
                                                        setSelected((current) => [
                                                            ...new Set([...current, chosenPhone]),
                                                        ]);
                                                        setPhone('');
                                                        setAddress('');
                                                        setMessage(
                                                            'iPhone connected. Now enable notifications on the device receiving them.',
                                                        );
                                                    })
                                                }
                                            >
                                                Use this iPhone
                                            </button>
                                        </div>
                                    </div>
                                </AnimatedDetails>
                            </section>

                            <section
                                class="notification-card notification-receiver"
                                aria-labelledby="notification-receiver-heading"
                            >
                                <div class="notification-section-heading">
                                    <h2 id="notification-receiver-heading">Receive on this device</h2>
                                </div>
                                <div class="notification-receiver-state">
                                    <span class={`notification-badge ${enabled ? 'ready' : ''}`}>
                                        {!workerLoaded
                                            ? 'Checking…'
                                            : enabled
                                              ? 'Notifications on'
                                              : 'Notifications off'}
                                    </span>
                                    {enabled && (
                                        <p>
                                            {!confirmed
                                                ? 'Review and save your choices below.'
                                                : activeSources.length
                                                  ? `From ${activeSources.map((s) => s.name).join(', ')}`
                                                  : 'No other iPhones selected'}
                                        </p>
                                    )}
                                </div>
                                {!window.isSecureContext ? (
                                    <div class="notification-notice">
                                        <p>Open the secure app with Tailscale connected to receive alerts here.</p>
                                        <a href={privateUrl}>Open private app →</a>
                                    </div>
                                ) : ios && !installed ? (
                                    <div class="notification-notice">
                                        <strong>Add this app to your Home Screen</strong>
                                        <ol class="notification-setup-steps">
                                            <li>
                                                In Safari, tap <strong>Share → Add to Home Screen</strong>.
                                            </li>
                                            <li>Open the new icon, then return to Notifications.</li>
                                            <li>
                                                Tap <strong>Enable on this device</strong>.
                                            </li>
                                        </ol>
                                    </div>
                                ) : !supported ? (
                                    <p class="notification-notice">
                                        This browser doesn’t support background notifications. Open the app in a browser
                                        that supports Web Push.
                                    </p>
                                ) : blockedPermission ? (
                                    <p class="notification-notice">
                                        Notifications are blocked in this device’s settings. Allow notifications for
                                        ws-scrcpy, then return here.
                                    </p>
                                ) : null}
                                {!status.sources.length && (
                                    <p class="notification-help">Connect an iPhone above first.</p>
                                )}
                                {receiver && selected.includes(receiver) && (
                                    <p class="notification-help">
                                        {status.sources.find((s) => s.id === receiver)?.name} won’t receive its own
                                        alerts again. Select a different sending iPhone to receive its notifications
                                        here.
                                    </p>
                                )}
                                <AnimatedDetails
                                    class="notification-details"
                                    open={!enabled && !!status.sources.length}
                                >
                                    <summary>Choose phones and delivery options</summary>
                                    <div class="notification-details-content">
                                        <fieldset disabled={busy}>
                                            <legend>Get notifications from</legend>
                                            {status.sources.length ? (
                                                status.sources.map((s) => (
                                                    <label class="notification-check" key={s.id}>
                                                        <input
                                                            type="checkbox"
                                                            checked={selected.includes(s.id)}
                                                            onChange={(e) =>
                                                                setSelected(
                                                                    e.currentTarget.checked
                                                                        ? [...selected, s.id]
                                                                        : selected.filter((id) => id !== s.id),
                                                                )
                                                            }
                                                        />
                                                        <span>{s.name}</span>
                                                    </label>
                                                ))
                                            ) : (
                                                <p class="notification-help">
                                                    Your connected iPhones will appear here.
                                                </p>
                                            )}
                                        </fieldset>
                                        <label>
                                            This app is open on
                                            <select
                                                value={receiver}
                                                disabled={busy}
                                                onChange={(e) => setReceiver(e.currentTarget.value)}
                                            >
                                                <option value="">A different phone, tablet or computer</option>
                                                {status.sources.map((s) => (
                                                    <option key={s.id} value={s.id}>
                                                        {s.name} itself
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        <p class="notification-help">
                                            Prevents this iPhone from receiving its own alerts.
                                        </p>
                                        {subscription && (
                                            <button
                                                disabled={busy}
                                                class="notification-danger"
                                                onClick={() =>
                                                    void run(async () => {
                                                        await api('subscriptions', 'DELETE', {
                                                            endpoint: subscription.endpoint,
                                                        });
                                                        await subscription.unsubscribe();
                                                        setSubscription(null);
                                                        setMessage('Notifications turned off on this device.');
                                                    })
                                                }
                                            >
                                                Turn off on this device
                                            </button>
                                        )}
                                    </div>
                                </AnimatedDetails>
                                <div class="notification-actions">
                                    {subscription && !blockedPermission ? (
                                        <>
                                            {changed && (
                                                <button
                                                    class="notification-primary"
                                                    disabled={busy || !initialized}
                                                    onClick={() =>
                                                        void run(async () => {
                                                            await saveSubscription(subscription);
                                                            setMessage('Notification choices saved.');
                                                        })
                                                    }
                                                >
                                                    Save changes
                                                </button>
                                            )}
                                            <button
                                                class={changed ? '' : 'notification-primary'}
                                                disabled={busy || changed}
                                                onClick={() =>
                                                    void run(async () => {
                                                        try {
                                                            await api('test', 'POST', {
                                                                endpoint: subscription.endpoint,
                                                            });
                                                        } catch (e) {
                                                            if (
                                                                (e as Error).message !==
                                                                'Enable notifications on this device first'
                                                            )
                                                                throw e;
                                                            // The browser can retain a subscription after the server removed it.
                                                            await saveSubscription(subscription);
                                                            await api('test', 'POST', {
                                                                endpoint: subscription.endpoint,
                                                            });
                                                        }
                                                        setMessage(
                                                            'Test notification queued. It should arrive on this device shortly.',
                                                        );
                                                    })
                                                }
                                            >
                                                Send test notification
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            class="notification-primary"
                                            disabled={busy || !canEnable || blockedPermission}
                                            onClick={enable}
                                        >
                                            Enable on this device
                                        </button>
                                    )}
                                </div>
                                {changed && subscription && (
                                    <p class="notification-help">Save your changes before sending a test.</p>
                                )}
                                {!effectiveSources.length && !!status.sources.length && !subscription && (
                                    <p class="notification-help">
                                        Select at least one other iPhone to enable notifications here.
                                    </p>
                                )}
                                {!!status.delivery.lastError && (
                                    <p role="alert" class="notification-error">
                                        Some notifications could not be sent. See delivery details below.
                                    </p>
                                )}
                                <AnimatedDetails class="notification-details">
                                    <summary>Delivery details</summary>
                                    <div class="notification-details-content">
                                        <p class="notification-help">
                                            Across all receiving devices since the server started:{' '}
                                            {status.delivery.sent} accepted by the push service
                                            {status.delivery.failed ? `, ${status.delivery.failed} failed` : ''}.
                                            Acceptance doesn’t confirm a banner appeared.
                                        </p>
                                        {status.delivery.lastError && (
                                            <p class="notification-error">{status.delivery.lastError}</p>
                                        )}
                                    </div>
                                </AnimatedDetails>
                            </section>
                        </Presence>
                    </div>
                </>
            )}
        </main>
    );
}
