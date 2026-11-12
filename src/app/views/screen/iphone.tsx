import { RefObject } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ParamsStreamCoreDevice } from '../../../types/ParamsStreamCoreDevice';
import ApplDeviceDescriptor from '../../../types/ApplDeviceDescriptor';
import { StreamClientCoreDevice } from '../../applDevice/client/StreamClientCoreDevice';
import { CoreDeviceSessionState } from '../../../common/CoreDeviceProtocol';
import { isPasscodeLockout, UNLOCK_BY_HAND_MESSAGE } from '../../../common/IosUnlockSchedule';
import {
    activeCoreDeviceStream,
    closeAllSheets,
    deviceClipboard,
    deviceClipboardError,
    liveTextOpen,
    streamConnected,
    streamNotice,
} from '../../state/stream';
import { findDeviceByUdid, isDeviceAvailable, phoneName } from '../../state/devices';
import { getDeviceStatusInfo, screenConnection } from '../../state/phoneStatus';
import { SCREEN_CONNECTION } from '../../copy';
import { FloatingToolbar } from '../FloatingToolbar';
import { DeviceSwitcherSheet } from '../DeviceSwitcherSheet';
import { ApplActionsSheet } from '../ApplActionsSheet';
import { ApplUnlockSheet } from '../ApplUnlockSheet';
import { LiveTextOverlay } from '../LiveTextOverlay';
import { coreDeviceLiveTextTarget } from '../../applDevice/liveTextTarget';
import type { ScreenModel } from '../ScreenView';
import type { ScreenProblem } from './StateCard';

type SessionStatus = { state: CoreDeviceSessionState; message?: string; retrying?: boolean };
// A session that failed or was stopped. Kept while the client tries again, so the card stays put
// between attempts and does not blink in and out with each one.
type Failure = { state: 'error' | 'stopped'; message?: string; retrying: boolean };

const FAILURE_TITLE = { error: SCREEN_CONNECTION.streamUnavailable, stopped: SCREEN_CONNECTION.streamStopped };
const FAILURE_FALLBACK = {
    error: 'The phone stream could not be started.',
    stopped: 'The screen session on the phone was stopped.',
};

/**
 * The iPhone half of `ScreenView`: the CoreDevice stream client, its session that can fail and
 * be tried again, and a Lock tap for the sleeping screen. The client closes the socket with 4009,
 * 4010 or 4011 when a start is refused; it decides whether to try again, and this page shows the
 * reason with Retry.
 */
export function useIphoneScreen(params: ParamsStreamCoreDevice, mount: RefObject<HTMLDivElement>): ScreenModel {
    const [error, setError] = useState('');
    const [session, setSession] = useState<SessionStatus>({ state: 'starting' });
    const [failure, setFailure] = useState<Failure>();
    const [decoderError, setDecoderError] = useState('');
    const [linkOpen, setLinkOpen] = useState(false);
    // The stream client that has shown the picture. A new client connects; the same one
    // reconnects.
    const [connectedClient, setConnectedClient] = useState<StreamClientCoreDevice>();

    useEffect(() => {
        const container = mount.current;
        if (!container) {
            return;
        }
        closeAllSheets();
        deviceClipboard.value = undefined;
        deviceClipboardError.value = '';
        streamNotice.value = '';
        setError('');
        setSession({ state: 'starting' });
        setFailure(undefined);
        setDecoderError('');
        setLinkOpen(false);
        let client: StreamClientCoreDevice;
        try {
            client = StreamClientCoreDevice.start(params, container);
        } catch (cause) {
            streamConnected.value = false;
            setError(cause instanceof Error ? cause.message : 'The stream could not be started.');
            return;
        }
        const onSession = (status: SessionStatus) => {
            setSession(status);
            if (status.state === 'ready') {
                setFailure(undefined);
            } else if (status.state === 'error' || status.state === 'stopped') {
                setFailure({ state: status.state, message: status.message, retrying: status.retrying !== false });
            }
        };
        const onDecoderError = ({ message }: { message: string }) => setDecoderError(message);
        const onLink = ({ open }: { open: boolean }) => setLinkOpen(open);
        client.on('session', onSession);
        client.on('decoderError', onDecoderError);
        client.on('link', onLink);
        activeCoreDeviceStream.value = { params, client };
        return () => {
            client.off('session', onSession);
            client.off('decoderError', onDecoderError);
            client.off('link', onLink);
            client.stop();
            activeCoreDeviceStream.value = undefined;
            closeAllSheets();
            deviceClipboard.value = undefined;
            deviceClipboardError.value = '';
        };
    }, [params.udid]);

    const active = activeCoreDeviceStream.value;
    const liveText = useMemo(() => (active ? coreDeviceLiveTextTarget(active.client) : undefined), [active?.client]);
    const entry = findDeviceByUdid(params.udid);
    const descriptor = entry?.params.type === 'ios' ? (entry.descriptor as ApplDeviceDescriptor) : undefined;
    // The same name as on the card and in the switcher; the serial until the device list arrives.
    const name = phoneName(params.udid, descriptor ? entry : undefined);
    useEffect(() => {
        if (descriptor?.name && active?.client) {
            active.client.setDeviceName(descriptor.name);
        }
    }, [descriptor?.name, active?.client]);
    const connected = streamConnected.value && session.state === 'ready';
    useEffect(() => {
        if (connected && active) {
            setConnectedClient(active.client);
        }
    }, [connected, active?.client]);
    // Read by `DeviceStateMonitor` on the server (backlight + accessibility walk); 'unknown'
    // where that is disabled, which must never show as asleep or locked. The lock stays raw for
    // the unlock flow; the screen comes from the status model, as on the card.
    const locked = descriptor?.['device.locked'] ?? 'unknown';
    const screenOff = !!entry && !!descriptor && getDeviceStatusInfo(entry).screen === 'asleep';
    const unauthorized = !!entry && !!descriptor && getDeviceStatusInfo(entry).status === 'unauthorized';
    // The reason there is no picture, and what can be done. A browser without a decoder cannot
    // be retried into having one, so it gets no Retry.
    const trying = !!failure && session.state === 'starting';
    // The phone refuses connections until its passcode is entered on it. The card says that in
    // the words the settings panel and the push use, without the retry count the receiver adds.
    const lockedOut = isPasscodeLockout(failure?.message);
    const retry = active && { label: 'Retry', run: () => active.client.retry() };
    const problem: ScreenProblem | undefined = error
        ? { kind: 'start', icon: 'errorCircle', title: 'Unable to start this stream', message: error }
        : decoderError
          ? {
                kind: 'decoder',
                icon: 'errorCircle',
                title: 'This browser cannot show the stream',
                message: decoderError,
            }
          : failure
            ? {
                  kind: failure.state,
                  icon: lockedOut ? 'lock' : failure.state === 'error' ? 'errorCircle' : 'square',
                  title: lockedOut ? 'Unlock the iPhone by hand' : FAILURE_TITLE[failure.state],
                  message: lockedOut ? UNLOCK_BY_HAND_MESSAGE : failure.message || FAILURE_FALLBACK[failure.state],
                  note: trying ? SCREEN_CONNECTION.tryingAgain : failure.retrying ? 'Trying again shortly.' : '',
                  action: retry || undefined,
              }
            : undefined;
    // "Connected" needs a picture. After a failed start the socket stays closed until the next
    // try, which can be a minute away or wait for Retry; "Connecting" would be wrong for that long.
    const connection = screenConnection({
        startError: !!error,
        decoderError: !!decoderError,
        failure: failure && { state: failure.state, trying },
        connected,
        phoneOffline: !!descriptor && !!entry && !isDeviceAvailable(entry),
        sessionStarting: linkOpen && session.state === 'starting',
        hasConnected: !!active && connectedClient === active.client,
    });
    const mounted = !!active && active.params.udid === params.udid;

    return {
        name,
        connection,
        inbox: params.udid,
        mounted,
        connected,
        locked,
        // The iPhone reports no lock screen apart from its lock.
        keyguardShowing: 'unknown',
        screenOff,
        unauthorized,
        // Progress of a first start ("Preparing the device"). A failure has the card instead.
        progress: session.state === 'starting' && !problem ? session.message : undefined,
        problem,
        sessionKey: active?.client,
        // A short Side-button tap wakes the display (the proxy sends the down/up pair).
        wake: () => active?.client.pressButton('lock'),
        controls: mounted && active && <FloatingToolbar client={active.client} />,
        sheets: mounted && active && (
            <>
                <ApplActionsSheet client={active.client} descriptor={descriptor} />
                <ApplUnlockSheet client={active.client} />
                <DeviceSwitcherSheet />
                {liveText && <LiveTextOverlay open={liveTextOpen.value} target={liveText} />}
            </>
        ),
    };
}
