import { RefObject } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { StreamClientScrcpy } from '../../googDevice/client/StreamClientScrcpy';
import {
    activeStream,
    closeAllSheets,
    deviceClipboard,
    liveTextOpen,
    streamConnected,
    streamNotice,
    streamServiceStopped,
    unlockSheetOpen,
} from '../../state/stream';
import { findDeviceForStream } from '../../state/streamDevice';
import { isDeviceAvailable, phoneName } from '../../state/devices';
import { getDeviceStatusInfo, screenConnection } from '../../state/phoneStatus';
import { STREAM_SERVICE } from '../../copy';
import { ActionsSheet } from '../ActionsSheet';
import { FloatingToolbar } from '../FloatingToolbar';
import { DeviceSwitcherSheet } from '../DeviceSwitcherSheet';
import { LiveTextOverlay } from '../LiveTextOverlay';
import { scrcpyLiveTextTarget } from '../../googDevice/liveTextTarget';
import { UnlockSheet } from '../UnlockSheet';
import { submitDevicePasscode } from '../../state/unlockDevice';
import { StreamServiceStatus } from '../../ui/StreamServiceStatus';
import KeyEvent from '../../googDevice/android/KeyEvent';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import type { ScreenModel } from '../ScreenView';
import type { ScreenProblem } from './StateCard';

/**
 * The Android half of `ScreenView`: the scrcpy stream client, the stream service the owner can
 * stop and start again, and a WAKEUP key for the sleeping screen.
 */
export function useAndroidScreen(params: ParamsStreamScrcpy, mount: RefObject<HTMLDivElement>): ScreenModel {
    const [error, setError] = useState('');
    // Counts the owner's "Start again" after the stream service was stopped: a new connection
    // is what starts the service, so the stream is mounted again.
    const [attempt, setAttempt] = useState(0);
    // The stream client that has had a connection. A new client (another phone, Start again)
    // connects; the same one reconnects.
    const [connectedClient, setConnectedClient] = useState<StreamClientScrcpy>();

    useEffect(() => {
        const container = mount.current;
        if (!container) {
            return;
        }
        closeAllSheets();
        deviceClipboard.value = undefined;
        streamNotice.value = '';
        streamServiceStopped.value = false;
        setError('');
        // `StreamClientScrcpy` sets `document.body.className = 'stream'` itself; the list and
        // the tool tabs set their own when they are shown (`DeviceList.tsx`, `ToolView.tsx`).
        let client: StreamClientScrcpy;
        try {
            client = StreamClientScrcpy.start(params, undefined, undefined, undefined, container);
        } catch (cause) {
            streamConnected.value = false;
            setError(cause instanceof Error ? cause.message : 'The stream could not be started.');
            return;
        }
        activeStream.value = { params, client };
        return () => {
            client.stop();
            activeStream.value = undefined;
            closeAllSheets();
            deviceClipboard.value = undefined;
            streamServiceStopped.value = false;
        };
        // Re-mount the stream when the deep link actually points at a different device/player/
        // socket; other param changes (title, ...) do not warrant tearing the player down.
    }, [params.udid, params.player, params.ws, attempt]);

    const session = activeStream.value;
    const stopped = streamServiceStopped.value && !streamConnected.value;
    useEffect(() => {
        if (streamConnected.value && session) {
            setConnectedClient(session.client);
        }
    }, [streamConnected.value, session?.client]);
    const liveText = useMemo(() => (session ? scrcpyLiveTextTarget(session.client) : undefined), [session?.client]);
    const entry = findDeviceForStream(params);
    const descriptor = entry?.params.type === 'android' ? (entry.descriptor as GoogDeviceDescriptor) : undefined;
    const locked = descriptor?.['device.locked'] ?? 'unknown';
    const keyguardShowing = descriptor?.['keyguard.showing'] ?? 'unknown';
    // From the status model, as on the card: only on positive evidence, never for an unknown screen.
    const screenOff = !!entry && !!descriptor && getDeviceStatusInfo(entry).screen === 'asleep';
    const unauthorized = !!entry && getDeviceStatusInfo(entry).status === 'unauthorized';
    // The same name as on the card and in the switcher; the serial until the device list arrives.
    const name = phoneName(params.udid, entry);
    const connection = screenConnection({
        startError: !!error,
        connected: streamConnected.value,
        serviceStopped: stopped,
        phoneOffline: !!entry && !isDeviceAvailable(entry),
        hasConnected: !!session && connectedClient === session.client,
    });
    const wake = () => {
        session?.client.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_WAKEUP, 0, 0));
        session?.client.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_WAKEUP, 0, 0));
    };
    const problem: ScreenProblem | undefined = error
        ? { kind: 'start', icon: 'errorCircle', title: 'Unable to start this stream', message: error }
        : stopped
          ? {
                kind: 'service-stopped',
                className: 'stream-service-stopped',
                icon: 'square',
                title: STREAM_SERVICE.stoppedTitle,
                message: STREAM_SERVICE.stoppedMessage,
                action: { label: 'Start again', run: () => setAttempt(attempt + 1) },
            }
          : undefined;
    const mounted = !!session && session.params.udid === params.udid;

    return {
        name,
        connection,
        // Only while the service does not run; a running service needs no line of its own.
        service: descriptor && <StreamServiceStatus descriptor={descriptor} deviceKey={entry?.key} unlessRunning />,
        mounted,
        connected: streamConnected.value,
        locked,
        keyguardShowing,
        screenOff,
        unauthorized,
        problem,
        sessionKey: session?.client,
        wake,
        controls: mounted && session && <FloatingToolbar client={session.client} />,
        sheets: mounted && session && (
            <>
                <ActionsSheet client={session.client} />
                <DeviceSwitcherSheet />
                <UnlockSheet
                    key={params.udid}
                    open={unlockSheetOpen.value}
                    udid={params.udid}
                    deviceName={entry ? name : undefined}
                    sessionKey={session.client}
                    connected={streamConnected.value}
                    locked={locked}
                    keyguardShowing={keyguardShowing}
                    keyguardOccluded={descriptor?.['keyguard.occluded'] ?? 'unknown'}
                    onClose={() => (unlockSheetOpen.value = false)}
                    onSubmit={(passcode, signal) => submitDevicePasscode(session.client, params.udid, passcode, signal)}
                />
                {liveText && <LiveTextOverlay open={liveTextOpen.value} target={liveText} />}
            </>
        ),
    };
}
