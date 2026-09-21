import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { BottomSheet } from '../ui/BottomSheet';
import { devices, DeviceEntry, deviceName, isDeviceAvailable } from '../state/devices';
import { activeStream, deviceSwitcherOpen, activeCoreDeviceStream } from '../state/stream';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import { buildInterfaceOptions, pickDefaultInterfaceName } from '../googDevice/client/deviceInterfaces';
import Util from '../Util';
import { ACTION } from '../../common/Action';
import { buildLinkHref, isLocalLink } from '../state/links';
import { getDeviceStatusInfo } from '../state/deviceStatus';
import { DeviceIcon } from '../ui/DeviceIcon';
import '../../style/views/DeviceSwitcherSheet.css';

interface DeviceSwitcherSheetProps {
    currentDeviceKey?: string;
    onSelectDevice?: (entry: DeviceEntry) => void;
}

export function DeviceSwitcherSheet({ currentDeviceKey, onSelectDevice }: DeviceSwitcherSheetProps = {}) {
    const session = activeStream.value;
    const [query, setQuery] = useState('');
    const listRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (deviceSwitcherOpen.value) {
            setQuery('');
        }
    }, [deviceSwitcherOpen.value]);
    useLayoutEffect(() => {
        if (deviceSwitcherOpen.value && listRef.current) {
            // Reset before the filtered rows paint, including short landscape viewports.
            listRef.current.scrollTop = 0;
        }
    }, [deviceSwitcherOpen.value, query]);
    const entries = Array.from(devices.value.values());
    const visible = entries
        .filter((entry) =>
            `${deviceName(entry)} ${entry.descriptor.udid} ${entry.trackerName}`
                .toLocaleLowerCase()
                .includes(query.trim().toLocaleLowerCase()),
        )
        .sort(
            (a, b) =>
                Number(isDeviceAvailable(b)) - Number(isDeviceAvailable(a)) ||
                deviceName(a).localeCompare(deviceName(b)),
        );

    const getSelection = (entry: DeviceEntry) => {
        if (entry.params.type === 'ios') {
            // iOS streams have one route (the CoreDevice proxy), no adb interfaces to pick from.
            return undefined;
        }
        const descriptor = entry.descriptor as GoogDeviceDescriptor;
        const options = buildInterfaceOptions(descriptor, entry.params);
        const selectedName = pickDefaultInterfaceName(
            descriptor,
            `${entry.trackerId}_${Util.escapeUdid(descriptor.udid)}`,
        );
        return options.find((option) => option.name === selectedName) ?? options[options.length - 1];
    };

    const onSelect = (entry: DeviceEntry) => {
        if (onSelectDevice) {
            deviceSwitcherOpen.value = false;
            onSelectDevice(entry);
            return;
        }
        if (entry.params.type === 'ios') {
            const href = buildLinkHref({ action: ACTION.STREAM_COREDEVICE, udid: entry.descriptor.udid }, entry.params);
            deviceSwitcherOpen.value = false;
            if (isLocalLink(entry.params)) {
                location.hash = new URL(href).hash;
            } else {
                location.assign(href);
            }
            return;
        }
        const selected = getSelection(entry);
        const players = StreamClientScrcpy.getPlayers();
        const player =
            players.find((candidate) => candidate.playerCodeName === session?.params.player) ??
            players.find((candidate) => candidate.playerCodeName === 'webcodecs') ??
            players[0];
        if (!selected || !player) {
            return;
        }
        const href = buildLinkHref(
            {
                action: ACTION.STREAM_SCRCPY,
                udid: entry.descriptor.udid,
                player: player.playerCodeName,
                ws: selected.url,
                fitToScreen: 'true',
            },
            entry.params,
        );
        deviceSwitcherOpen.value = false;
        if (isLocalLink(entry.params)) {
            location.hash = new URL(href).hash;
        } else {
            location.assign(href);
        }
    };

    return (
        <BottomSheet
            open={deviceSwitcherOpen.value}
            onClose={() => (deviceSwitcherOpen.value = false)}
            title="Switch device"
            bodyClassName="device-switcher-body"
        >
            <p class="device-switcher-hint">Choose a device to continue here. Its stream starts automatically.</p>
            {entries.length > 3 && (
                <label class="device-search device-switcher-search">
                    <span aria-hidden="true">⌕</span>
                    <input
                        type="search"
                        enterkeyhint="search"
                        value={query}
                        onInput={(event) => setQuery(event.currentTarget.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.isComposing) {
                                event.preventDefault();
                                event.currentTarget.blur();
                            }
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
            <div
                ref={listRef}
                class="device-switcher-list"
                role="region"
                aria-label="Devices to switch to"
                tabIndex={0}
            >
                {visible.map((entry) => {
                    const selected = getSelection(entry);
                    const isCurrent = onSelectDevice
                        ? entry.key === currentDeviceKey
                        : entry.params.type === 'ios'
                          ? entry.descriptor.udid === activeCoreDeviceStream.value?.params.udid
                          : entry.descriptor.udid === session?.params.udid && selected?.url === session.params.ws;
                    const available = isDeviceAvailable(entry);
                    const info = getDeviceStatusInfo(entry);
                    return (
                        <button
                            key={entry.key}
                            class={`bottom-sheet-list-item device-switcher-item ${isCurrent ? 'current' : ''}`}
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
                                {isCurrent
                                    ? 'Viewing'
                                    : available
                                      ? info.status === 'asleep'
                                          ? 'Asleep →'
                                          : 'Open →'
                                      : info.label}
                            </span>
                        </button>
                    );
                })}
            </div>
        </BottomSheet>
    );
}
