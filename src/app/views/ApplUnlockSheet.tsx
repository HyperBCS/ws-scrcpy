import { useMemo } from 'preact/hooks';
import { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';
import { deviceName, findDeviceByUdid } from '../state/devices';
import { openSettings } from '../state/settingsSheet';
import { streamConnected, unlockSheetOpen } from '../state/stream';
import { iphoneUnlock } from '../state/unlockDevice';
import { UNLOCK_BY_HAND_MESSAGE } from '../../common/IosUnlockSchedule';
import ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import { PhoneUnlockSheet, UnlockBanner } from './UnlockSheet';

/**
 * The Unlock sheet of an iPhone: the one sheet without a field. Nothing is typed or kept in the
 * browser: the server types the passcode stored for the scheduled unlock, through the same
 * driver, which reads the lock before typing. A phone without a usable stored passcode is
 * unlocked on the remote screen, or after storing one in Settings.
 */
export function ApplUnlockSheet({ client }: { client: StreamClientCoreDevice }) {
    const udid = client.getDeviceUdid();
    const entry = findDeviceByUdid(udid);
    const descriptor = entry?.params.type === 'ios' ? (entry.descriptor as ApplDeviceDescriptor) : undefined;
    const schedule = descriptor?.unlockSchedule;
    const adapter = useMemo(() => iphoneUnlock(udid), [udid]);
    const settings = {
        label: 'Open Settings',
        run: () => {
            unlockSheetOpen.value = false;
            openSettings(udid, { deviceKey: entry?.key, section: 'unlock' });
        },
    };
    // One sentence for each state of the stored passcode that the server would refuse.
    const banners: UnlockBanner[] = [];
    if (!schedule?.hasPasscode) {
        banners.push({
            tone: 'warning',
            text: 'No passcode is stored on the server for this phone. Store one in Settings, or enter it on the remote screen.',
            blocks: true,
            action: settings,
        });
    } else if (schedule.passcodeRejected) {
        banners.push({
            tone: 'warning',
            text: 'The stored passcode was rejected by the phone. Save it again in Settings before it is used again.',
            blocks: true,
            action: settings,
        });
    } else if (schedule.needsManualUnlock) {
        banners.push({ tone: 'warning', text: UNLOCK_BY_HAND_MESSAGE });
    }
    return (
        <PhoneUnlockSheet
            open={unlockSheetOpen.value}
            udid={udid}
            subtitle={entry ? deviceName(entry) : undefined}
            sessionKey={client}
            connected={streamConnected.value}
            unlocked={descriptor?.['device.locked'] === false}
            adapter={adapter}
            intro="The server types the stored passcode. Nothing is saved in this browser."
            banners={banners}
            onClose={() => (unlockSheetOpen.value = false)}
        />
    );
}
