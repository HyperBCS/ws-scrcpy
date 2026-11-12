import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { devices, DeviceEntry, isDeviceAvailable, listReceived, phoneName, reportedConnected } from '../state/devices';
import { connectionStatus, listSummary, needsAttention } from '../state/phoneStatus';
import {
    CardControl,
    listState,
    rememberListScroll,
    rememberOpenedCard,
    savedListScroll,
    takeOpenedCard,
} from '../state/deviceListView';
import { hostsError, hostsStatus } from '../state/hosts';
import { LIST_PAGE_NAME } from '../state/routes';
import { DeviceCard } from './DeviceCard';
import { DeviceIcon } from '../ui/DeviceIcon';
import { TrackerStatusNotice } from '../ui/TrackerStatusNotice';
import { NotificationsLink } from '../ui/NotificationsLink';
import { AppBar, AppBarStatus } from '../ui/AppBar';
import { Banner } from '../ui/Banner';
import { IconButton } from '../ui/IconButton';
import { InlineStatus } from '../ui/InlineStatus';
import '../../style/views/DeviceList.css';

interface HostGroup {
    key: string;
    name: string;
    entries: DeviceEntry[];
}

function groupByHost(list: DeviceEntry[]): HostGroup[] {
    const groups = new Map<string, HostGroup>();
    list.forEach((entry) => {
        const {
            hostname = location.hostname,
            port = location.port,
            pathname = location.pathname,
            secure,
        } = entry.params;
        const key = `${secure ? 'https' : 'http'}://${hostname}:${port}${pathname}`;
        let group = groups.get(key);
        if (!group) {
            group = { key, name: hostname, entries: [] };
            groups.set(key, group);
        }
        group.entries.push(entry);
    });
    return Array.from(groups.values());
}

/** What names a control of a card when the card is drawn again: its address, else its name. */
function controlName(control: Element): string {
    return control.getAttribute('href') || control.getAttribute('aria-label') || control.textContent?.trim() || '';
}

/** The card control an event came from. */
function cardControl(target: EventTarget | null): CardControl | undefined {
    const control = target instanceof Element ? target.closest('a, button') : null;
    const key = control?.closest<HTMLElement>('article.device')?.dataset.deviceKey;
    return control && key ? { key, control: controlName(control) } : undefined;
}

/**
 * Focuses that control again, or the first control of its card that can take focus. A server
 * that restarted lists its phones under a new tracker id, so the card is found by its key, else
 * by the serial at the end of it.
 */
function focusCardControl(root: HTMLElement, { key, control }: CardControl): void {
    const cards = Array.from(root.querySelectorAll<HTMLElement>('article.device'));
    // The key is `<tracker id>:<serial>`. The id has no colon; a serial can (`host:port`).
    const serialOf = (value = '') => value.slice(value.indexOf(':') + 1);
    const card =
        cards.find((item) => item.dataset.deviceKey === key) ??
        cards.find((item) => serialOf(item.dataset.deviceKey) === serialOf(key));
    const controls = Array.from(card?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? []);
    (controls.find((item) => controlName(item) === control) ?? controls[0])?.focus({ preventScroll: true });
}

/** Focus went nowhere, or stayed on a control that a stale card had turned off. */
function focusLost(): boolean {
    const active = document.activeElement;
    return !active || active === document.body || (active as HTMLButtonElement).disabled === true;
}

export function DeviceList() {
    const scroller = useRef<HTMLElement>(null);
    useLayoutEffect(() => {
        document.body.className = 'list';
        // Back from a screen, a tool or Notifications: the list is where it was left, and the
        // card a page was opened from has the focus.
        if (scroller.current) {
            scroller.current.scrollTop = savedListScroll();
            const opened = takeOpenedCard();
            if (opened) {
                focusCardControl(scroller.current, opened);
            }
        }
    }, []);

    const entries = Array.from(devices.value.values());
    const state = listState(entries, listReceived.value, hostsStatus.value);
    const stale = state === 'stale';
    const available = entries.filter(isDeviceAvailable).length;
    const attention = entries.filter(needsAttention).length;
    // By what the server last said, so the cards keep their order while the list reconnects.
    entries.sort(
        (a, b) =>
            Number(reportedConnected(b)) - Number(reportedConnected(a)) ||
            phoneName(a.descriptor.udid, a).localeCompare(phoneName(b.descriptor.udid, b)),
    );
    const groups = groupByHost(entries);
    const reconnecting = connectionStatus('reconnecting').label;

    // A stale card turns its links off, and a link that is off cannot keep the focus. When the
    // next list turns them on, the control that had the focus gets it back. It is read when the
    // list turns stale, before the cards are drawn stale, while it still has the focus. A control
    // focused while the list is stale takes its place. Focus that had left the cards before the
    // drop stays where it is.
    const staleFocus = useRef<CardControl>();
    const wasStale = useRef(false);
    if (stale && !wasStale.current) {
        staleFocus.current = cardControl(document.activeElement);
    }
    wasStale.current = stale;
    useEffect(() => {
        if (stale) {
            return;
        }
        if (staleFocus.current && scroller.current && focusLost()) {
            focusCardControl(scroller.current, staleFocus.current);
        }
        staleFocus.current = undefined;
    }, [stale]);

    // A plain press on a link of a card leaves the list for that page.
    const onClickCapture = (event: MouseEvent) => {
        const modified = event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
        const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (link && !modified) {
            rememberOpenedCard(cardControl(link));
        }
    };

    return (
        <div class="devices-page">
            <AppBar
                root
                title={LIST_PAGE_NAME}
                status={
                    <AppBarStatus>
                        {stale || state === 'disconnected'
                            ? reconnecting
                            : listSummary(entries.length, available, attention)}
                    </AppBarStatus>
                }
            >
                <NotificationsLink />
                {/* An installed app has no browser reload button, and pull-to-refresh is off. */}
                <IconButton icon="refresh" label="Reload" onClick={() => location.reload()} />
            </AppBar>
            {/* Outside the scrolling list, so it does not move the cards and stays in view. */}
            {stale && (
                <div class="devices-reconnecting">
                    <Banner>
                        <strong>{reconnecting}</strong> The phones are shown as last reported.
                    </Banner>
                </div>
            )}
            <main
                id="devices"
                ref={scroller}
                onScroll={(event) => rememberListScroll(event.currentTarget.scrollTop)}
                onFocusIn={(event) => {
                    if (wasStale.current) {
                        staleFocus.current = cardControl(event.target);
                    }
                }}
                onClickCapture={onClickCapture}
            >
                <div class="devices-content">
                    <TrackerStatusNotice />

                    {state === 'loading' && (
                        <section class="device-list-empty device-list-loading" role="status" aria-busy="true">
                            <span class="device-list-spinner" aria-hidden="true" />
                            <p>Loading phones…</p>
                        </section>
                    )}
                    {(state === 'empty' || state === 'disconnected') && (
                        <section class="device-list-empty" role="status">
                            <DeviceIcon />
                            <h2>{state === 'disconnected' ? 'Connection lost' : 'No phones connected'}</h2>
                            <p>
                                {state === 'disconnected'
                                    ? reconnecting
                                    : 'Connect a phone by USB or wireless debugging, then unlock it.'}
                            </p>
                            {hostsError.value && state === 'disconnected' && (
                                <InlineStatus tone="error">{hostsError.value}</InlineStatus>
                            )}
                        </section>
                    )}
                    {groups.map((group) => (
                        <section
                            key={group.key}
                            class="tracker-block"
                            aria-label={groups.length > 1 ? group.name : 'Connected phones'}
                        >
                            {groups.length > 1 && (
                                <div class="tracker-name">
                                    <span>{group.name}</span>
                                    <span>
                                        {group.entries.length} phone{group.entries.length === 1 ? '' : 's'}
                                    </span>
                                </div>
                            )}
                            <div class="device-list">
                                {group.entries.map((entry) => (
                                    <DeviceCard key={entry.key} entry={entry} />
                                ))}
                            </div>
                        </section>
                    ))}
                </div>
            </main>
        </div>
    );
}
