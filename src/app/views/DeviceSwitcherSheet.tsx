import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Sheet } from '../ui/Sheet';
import { canOpenScreen, devices, DeviceEntry, deviceName, isDeviceAvailable } from '../state/devices';
import { activeStream, deviceSwitcherOpen, activeCoreDeviceStream, openSheet } from '../state/stream';
import { deviceHref, followLink } from '../state/links';
import { getDeviceStatusInfo } from '../state/deviceStatus';
import { isSwitcherShortcut, nextHighlight } from '../state/switcherKeys';
import { DeviceIcon } from '../ui/DeviceIcon';
import { Chip } from '../ui/Chip';
import { Icon } from '../ui/Icon';
// The search field is a plain input with the kit's field class, so that it can take a ref.
import '../../style/kit/Field.css';
import '../../style/views/DeviceSwitcherSheet.css';

interface DeviceSwitcherSheetProps {
    currentDeviceKey?: string;
    onSelectDevice?: (entry: DeviceEntry) => void;
    /** Lists only the devices the destination can open. Files and Shell pass Android only. */
    filter?: (entry: DeviceEntry) => boolean;
    /** Names the destination when it is not a screen: "Switch device · Shell". */
    title?: string;
    /** What a row opens, shown on the row: "Screen", "Files", "Shell". */
    openLabel?: string;
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
    title = 'Switch device',
    openLabel = 'Screen',
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
    // A tool opens on any connected device. A screen also needs Developer Mode on an iPhone.
    const canOpen = (entry: DeviceEntry) => (onSelectDevice ? isDeviceAvailable(entry) : canOpenScreen(entry));
    const entries = Array.from(devices.value.values()).filter((entry) => !filter || filter(entry));
    const visible = entries
        .filter((entry) =>
            `${deviceName(entry)} ${entry.descriptor.udid} ${entry.trackerName}`
                .toLocaleLowerCase()
                .includes(query.trim().toLocaleLowerCase()),
        )
        .sort((a, b) => Number(canOpen(b)) - Number(canOpen(a)) || deviceName(a).localeCompare(deviceName(b)));

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

    const rows = visible.map((entry) => {
        const isCurrent = onSelectDevice
            ? entry.key === currentDeviceKey
            : entry.params.type === 'ios'
              ? entry.descriptor.udid === activeCoreDeviceStream.value?.params.udid
              : entry.descriptor.udid === session?.params.udid;
        return { entry, isCurrent, available: canOpen(entry), info: getDeviceStatusInfo(entry) };
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
                        placeholder="Find a device…"
                        aria-label="Find a device to switch to"
                    />
                </label>
            )}
            {visible.length === 0 && (
                <p class="device-switcher-empty">
                    {entries.length ? 'No devices match your search.' : 'Connect a device to see it here.'}
                </p>
            )}
            <div ref={listRef} class="device-switcher-list" role="region" aria-label="Devices to switch to">
                {rows.map(({ entry, isCurrent, available, info }) => (
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
                        <DeviceIcon className="device-switcher-avatar" />
                        <span class="device-switcher-copy">
                            <strong>{deviceName(entry)}</strong>
                            <small>
                                {entry.trackerName} · {entry.descriptor.udid}
                            </small>
                        </span>
                        <span class="device-switcher-status">
                            {isCurrent ? (
                                <Chip tone="info">Viewing</Chip>
                            ) : !available ? (
                                <Chip tone={info.tone}>{info.label}</Chip>
                            ) : (
                                <>
                                    {/* What the row opens. A sleeping screen matters to a stream, not
                                        to Files or Shell. */}
                                    {info.status === 'asleep' && !onSelectDevice ? (
                                        <Chip tone={info.tone}>{info.label}</Chip>
                                    ) : (
                                        openLabel
                                    )}
                                    <Icon name="arrowRight" size={16} />
                                </>
                            )}
                        </span>
                    </button>
                ))}
            </div>
        </Sheet>
    );
}
