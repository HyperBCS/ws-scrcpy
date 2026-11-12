import { ComponentChildren } from 'preact';
import { DeviceEntry, isDeviceAvailable, phoneName } from '../state/devices';
import { getDeviceStatusInfo, PhoneStatus } from '../state/phoneStatus';
import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import type ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import { ROW } from '../copy';
import { badgeText } from './Badge';
import { Chip } from './Chip';
import { DeviceIcon } from './DeviceIcon';
import { Icon } from './Icon';
import '../../style/kit/Badge.css';
import '../../style/ui/PhoneRow.css';

/**
 * The line under the name, read by the adapter of the platform: the system and its version,
 * then the battery where a connected phone reports it ("Android 16 · 80%"). The level a phone
 * reported before it went away is not shown.
 */
export function platformLine(entry: DeviceEntry): string {
    if (entry.params.type === 'android') {
        const descriptor = entry.descriptor as GoogDeviceDescriptor;
        const level = descriptor['battery.level'];
        const battery =
            isDeviceAvailable(entry) && typeof level === 'number' && level >= 0
                ? `${level}%${descriptor['battery.charging'] ? ' · Charging' : ''}`
                : '';
        return [`Android ${descriptor['ro.build.version.release'] || ''}`.trim(), battery].filter(Boolean).join(' · ');
    }
    const descriptor = entry.descriptor as ApplDeviceDescriptor;
    return `iOS ${descriptor.version || ''}`.trim();
}

interface PhoneRowProps {
    entry: DeviceEntry;
    /** The status of the phone, when the caller has read it already. */
    info?: PhoneStatus;
    /** A chip in place of the status chip: Viewing, on the switcher's row of the phone on screen. */
    chip?: ComponentChildren;
    /** A control after the status, such as Wake. Never inside a row that is itself a button. */
    action?: ComponentChildren;
    /** Unread notifications of a phone whose notifications come to this server. */
    unread?: number;
    class?: string;
}

/**
 * One phone in one line: the head of its card on the list and its row in the switcher. The tile,
 * the name over the platform line, the unread count, and one status chip. A running session is a
 * mark on the platform line, never a second status. No serial and no tracker name: the serial is
 * in the phone's Settings.
 */
export function PhoneRow({ entry, info, chip, action, unread = 0, class: className = '' }: PhoneRowProps) {
    const status = info ?? getDeviceStatusInfo(entry);
    const count = badgeText(unread);
    return (
        <span class={`phone-row ${className}`.trim()}>
            {/* `device-avatar` and `device-status` take no text selection on a long press (app.css). */}
            <DeviceIcon className="phone-row-icon device-avatar" />
            <span class="phone-row-text">
                <span class="phone-row-name">{phoneName(entry.descriptor.udid, entry)}</span>
                <span class="phone-row-meta">
                    <span class="phone-row-platform">{platformLine(entry)}</span>
                    {status.sessionRunning && (
                        <span class="phone-row-in-use">
                            <span class="phone-row-dot" aria-hidden="true" />
                            {ROW.inUse}
                        </span>
                    )}
                </span>
            </span>
            {count && (
                <span class="phone-row-unread">
                    <Icon name="bell" size={16} />
                    <span class="kit-badge kit-badge-inline" aria-hidden="true">
                        {count}
                    </span>
                    <span class="visually-hidden">{`${unread} unread`}</span>
                </span>
            )}
            <span class="phone-row-status">
                {chip ?? (
                    <Chip
                        tone={status.tone}
                        class="phone-row-chip device-status"
                        attributes={{ 'data-status': status.status, title: `Status: ${status.label}` }}
                    >
                        {status.label}
                    </Chip>
                )}
                {action}
            </span>
        </span>
    );
}
