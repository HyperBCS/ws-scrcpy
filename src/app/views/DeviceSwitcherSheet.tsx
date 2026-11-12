import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Sheet } from '../ui/Sheet';
import { canOpenScreen, devices, DeviceEntry, isDeviceAvailable, phoneName } from '../state/devices';
import { activeStream, deviceSwitcherOpen, activeCoreDeviceStream, openSheet } from '../state/stream';
import { deviceHref, followLink } from '../state/links';
import { getDeviceStatusInfo } from '../state/phoneStatus';
import { notificationSummary } from '../state/notifications';
import { isNotificationSource } from '../state/notificationsTarget';
import { SESSION } from '../copy';
import { isSwitcherShortcut, nextHighlight } from '../state/switcherKeys';
import { Chip } from '../ui/Chip';
import { Icon } from '../ui/Icon';
import { platformLine, PhoneRow } from '../ui/PhoneRow';
// The search field is a plain input with the kit's field class, so that it can take a ref.
import '../../style/kit/Field.css';
import '../../style/views/DeviceSwitcherSheet.css';

interface DeviceSwitcherSheetProps {
    currentDeviceKey?: string;
    onSelectDevice?: (entry: DeviceEntry) => void;
    /** Lists only the phones the destination can open. Files and Shell pass Android only. */
    filter?: (entry: DeviceEntry) => boolean;
    /** Names the destination when it is not a screen: "Switch phone · Shell". */
    title?: string;
}

// A mouse and a keyboard: the search field can take focus without raising a phone keyboard.
const KEYBOARD_QUERY = '(hover: hover) and (pointer: fine)';

/** A text field other than the switcher's search keeps Ctrl+K, for example the Live text box. */
function isOtherTextField(target: EventTarget | null, search: HTMLInputElement | null): boolean {
    return (
        target instanceof Element &&
        target !== search &&
        !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    );
}

export function DeviceSwitcherSheet({
    currentDeviceKey,
    onSelectDevice,
    filter,
    title = 'Switch phone',
}: DeviceSwitcherSheetProps = {}) {
    const session = activeStream.value;
    const open = deviceSwitcherOpen.value;
    const [query, setQuery] = useState('');
    const [highlight, setHighlight] = useState<string>();
    const listRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    useLayoutEffect(() => {
        if (open) {
            setQuery('');
            setHighlight(undefined);
        }
    }, [open]);
    useLayoutEffect(() => {
        if (open && listRef.current) {
            // Reset before the filtered rows paint, including short landscape viewports.
            listRef.current.scrollTop = 0;
        }
    }, [open, query]);
    useLayoutEffect(() => {
        if (!open || !window.matchMedia(KEYBOARD_QUERY).matches) {
            return;
        }
        // The sheet takes focus itself when it opens; the search field takes over after that.
        let frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
        });
        return () => cancelAnimationFrame(frame);
    }, [open]);
    // A tool opens on any connected phone. A screen also needs Developer Mode on an iPhone.
    const canOpen = (entry: DeviceEntry) => (onSelectDevice ? isDeviceAvailable(entry) : canOpenScreen(entry));
    const isCurrentPhone = (entry: DeviceEntry) =>
        onSelectDevice
            ? entry.key === currentDeviceKey
            : entry.params.type === 'ios'
              ? entry.descriptor.udid === activeCoreDeviceStream.value?.params.udid
              : entry.descriptor.udid === session?.params.udid;
    const nameOf = (entry: DeviceEntry) => phoneName(entry.descriptor.udid, entry);
    // The phone on screen, then the phones that can be opened, then the rest; by name within each.
    const rank = (entry: DeviceEntry) => (isCurrentPhone(entry) ? 0 : canOpen(entry) ? 1 : 2);
    const entries = Array.from(devices.value.values()).filter((entry) => !filter || filter(entry));
    // The search reads what a row shows: the name and the platform line.
    const visible = entries
        .filter((entry) =>
            `${nameOf(entry)} ${platformLine(entry)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
        )
        .sort((a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b)));

    const onSelect = (entry: DeviceEntry) => {
        if (onSelectDevice) {
            deviceSwitcherOpen.value = false;
            onSelectDevice(entry);
            return;
        }
        // Another phone in the same history entry: Back from it leads to the list, not to the
        // phone before. The link names the phone only; its page picks the player and the socket.
        deviceSwitcherOpen.value = false;
        followLink(deviceHref(entry.descriptor.udid, 'screen', entry.params), 'switch');
    };

    const summary = notificationSummary.value;
    const rows = visible.map((entry) => {
        const udid = entry.descriptor.udid;
        return {
            entry,
            isCurrent: isCurrentPhone(entry),
            available: canOpen(entry),
            info: getDeviceStatusInfo(entry),
            unread: isNotificationSource(summary, udid) ? summary.unreadBySource[udid] || 0 : 0,
        };
    });
    const selectable = rows.filter((row) => row.available && !row.isCurrent).map((row) => row.entry);

    // One listener for the shortcut and for the keys of the open sheet. It reads the current rows
    // through a ref, so it is bound once per mount.
    const latest = useRef({ selectable, highlight, onSelect });
    latest.current = { selectable, highlight, onSelect };
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (isSwitcherShortcut(event) && !isOtherTextField(event.target, searchRef.current)) {
                event.preventDefault();
                if (deviceSwitcherOpen.value) {
                    searchRef.current?.focus({ preventScroll: true });
                } else {
                    openSheet('devices');
                }
                return;
            }
            if (
                !deviceSwitcherOpen.value ||
                event.defaultPrevented ||
                event.isComposing ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey
            ) {
                return;
            }
            const current = latest.current;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const next = nextHighlight(
                    current.selectable.map((entry) => entry.key),
                    current.highlight,
                    event.key === 'ArrowDown' ? 1 : -1,
                );
                setHighlight(next);
                const row = Array.from(listRef.current?.children ?? []).find(
                    (child) => (child as HTMLElement).dataset.switcherKey === next,
                );
                row?.scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'Enter') {
                // A focused button or link keeps its own Enter.
                if (event.target instanceof Element && event.target.closest('button, a[href]')) {
                    return;
                }
                event.preventDefault();
                const target =
                    current.selectable.find((entry) => entry.key === current.highlight) ??
                    (current.selectable.length === 1 ? current.selectable[0] : undefined);
                if (target) {
                    current.onSelect(target);
                } else if (event.target instanceof HTMLInputElement) {
                    // Nothing to open: the Search key still puts the phone keyboard away. Focus
                    // goes to the sheet, as when it opened. On the page behind the sheet it
                    // would be outside the dialog, where the sheet does not see Escape.
                    const sheet = event.target.closest<HTMLElement>('dialog');
                    if (sheet) {
                        sheet.focus({ preventScroll: true });
                    } else {
                        event.target.blur();
                    }
                }
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    return (
        <Sheet
            open={open}
            onClose={() => (deviceSwitcherOpen.value = false)}
            title={title}
            bodyClassName="device-switcher-body"
        >
            {entries.length > 3 && (
                <label class="device-switcher-search">
                    <Icon name="search" size={20} />
                    <input
                        ref={searchRef}
                        class="kit-field"
                        type="search"
                        enterkeyhint="search"
                        value={query}
                        onInput={(event) => {
                            setQuery(event.currentTarget.value);
                            setHighlight(undefined);
                        }}
                        placeholder="Find a phone…"
                        aria-label="Find a phone to switch to"
                    />
                </label>
            )}
            {visible.length === 0 && (
                <p class="device-switcher-empty">
                    {entries.length ? 'No phones match your search.' : 'Connect a phone to see it here.'}
                </p>
            )}
            <div ref={listRef} class="device-switcher-list" role="region" aria-label="Phones to switch to">
                {/* A row is the head of the phone's card: the same name, platform line, status
                    and unread count. The phone on screen says Viewing in place of its status. A
                    row that cannot be opened is a disabled button: no press, no focus, no hover. */}
                {rows.map(({ entry, isCurrent, available, info, unread }) => (
                    <button
                        key={entry.key}
                        type="button"
                        data-switcher-key={entry.key}
                        class={`device-switcher-item ${isCurrent ? 'current' : ''} ${
                            entry.key === highlight ? 'highlighted' : ''
                        }`}
                        onClick={() => onSelect(entry)}
                        disabled={isCurrent || !available}
                        aria-current={isCurrent ? 'true' : undefined}
                    >
                        <PhoneRow
                            entry={entry}
                            info={info}
                            unread={unread}
                            class="device-switcher-row"
                            chip={isCurrent ? <Chip tone="info">{SESSION.viewing}</Chip> : undefined}
                        />
                    </button>
                ))}
            </div>
        </Sheet>
    );
}
