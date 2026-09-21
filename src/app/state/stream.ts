import { signal } from '@preact/signals';
import { ParamsStreamScrcpy } from '../../types/ParamsStreamScrcpy';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import { closeSettingsSheet } from './settingsSheet';
import type { ParamsStreamCoreDevice } from '../../types/ParamsStreamCoreDevice';
import type { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';

export interface StreamSession {
    params: ParamsStreamScrcpy;
    client: StreamClientScrcpy;
}

// The currently mounted stream, if any. `StreamView` owns the lifecycle (create on mount, stop on
// unmount) and mirrors the handle here so other views can read/act on it (a device-switcher sheet,
// a later "sleeping stream" overlay, ...) without prop-drilling through the router.
export const activeStream = signal<StreamSession | undefined>(undefined);

export interface CoreDeviceStreamSession {
    params: ParamsStreamCoreDevice;
    client: StreamClientCoreDevice;
}

// The mounted iOS stream, if any (`CoreDeviceStreamView`). Kept apart from `activeStream` so the
// Android-only views keep their precise client type.
export const activeCoreDeviceStream = signal<CoreDeviceStreamSession | undefined>(undefined);

// Timestamp (`Date.now()`) of the last frame handed to the player, fed from
// `StreamClientScrcpy.onVideo`. Reset on every new stream mount.
//
// NOT a liveness signal, and deliberately not used as one: scrcpy only encodes a frame when the
// screen content actually changes, so a healthy stream of a static screen legitimately goes many
// seconds between frames (measured: ~1 frame per 2s on an idle home screen). Treating a frame gap
// as "stalled" produced a false "no signal" overlay that swallowed touches, which then guaranteed
// the screen never changed -- a deadlock. Use `streamConnected` for liveness instead.
export const lastFrameAt = signal<number | undefined>(undefined);

// Whether the stream's WebSocket is currently up. Unlike frame timing this is an unambiguous
// liveness signal: `StreamReceiver` reconnects with backoff, so a `false` here means genuinely
// no transport, not merely a quiet screen.
export const streamConnected = signal(false);

// Last clipboard text the device sent back (in response to a GET_CLIPBOARD command). `undefined`
// means "never asked"; empty string means the device's clipboard really is empty.
export const deviceClipboard = signal<string | undefined>(undefined);

// Why the last clipboard read failed, if it did. Kept apart from `deviceClipboard` because the two
// are different answers: reporting a failure as an empty clipboard told people their phone had
// nothing on it when the phone had in fact said nothing at all.
export const deviceClipboardError = signal('');

// Recoverable session feedback (for example a file drop that needs the Files tool).
export const streamNotice = signal('');

// Bottom sheets reachable from the in-stream toolbar. Plain booleans rather than one "which sheet"
// enum: they are mutually exclusive by convention (the toolbar only opens one at a time) but
// nothing breaks if that ever stops being true.
export const toolsSheetOpen = signal(false);
export const deviceSwitcherOpen = signal(false);
export const liveTextOpen = signal(false);
export const unlockSheetOpen = signal(false);

export function closeAllSheets(): void {
    toolsSheetOpen.value = false;
    deviceSwitcherOpen.value = false;
    liveTextOpen.value = false;
    unlockSheetOpen.value = false;
    closeSettingsSheet();
}

/**
 * Opens one sheet, closing any other first.
 *
 * Every caller used to just set its own signal to `true`, so sheets stacked: with the device
 * switcher already open, its panel covered the control bar and every button under it was dead
 * (the tap landed on a list item inside the sheet, which did not even dismiss it). Going through
 * here makes them mutually exclusive.
 */
export function openSheet(which: 'tools' | 'devices' | 'liveText' | 'unlock'): void {
    closeAllSheets();
    if (which === 'tools') {
        toolsSheetOpen.value = true;
    } else if (which === 'devices') {
        deviceSwitcherOpen.value = true;
    } else if (which === 'liveText') {
        liveTextOpen.value = true;
    } else {
        unlockSheetOpen.value = true;
    }
}
