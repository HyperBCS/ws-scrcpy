import { ComponentChildren } from 'preact';
import { Presence } from '../ui/Presence';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ParamsStreamScrcpy } from '../../types/ParamsStreamScrcpy';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import {
    activeStream,
    closeAllSheets,
    deviceClipboard,
    liveTextOpen,
    openSheet,
    streamConnected,
    streamNotice,
    streamServiceStopped,
    unlockSheetOpen,
} from '../state/stream';
import { findDeviceForStream } from '../state/streamDevice';
import { isDeviceAvailable, phoneName } from '../state/devices';
import { getDeviceStatusInfo, screenConnection } from '../state/phoneStatus';
import { STREAM_SERVICE } from '../copy';
import { NotificationsLink } from '../ui/NotificationsLink';
import { goUp } from '../state/router';
import { LIST_PAGE_NAME } from '../state/routes';
import { AppBar, AppBarStatus } from '../ui/AppBar';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { ActionsSheet } from './ActionsSheet';
import { FloatingToolbar } from './FloatingToolbar';
import { DeviceSwitcherSheet } from './DeviceSwitcherSheet';
import { SleepOverlay } from './SleepOverlay';
import { LiveTextOverlay } from './LiveTextOverlay';
import { scrcpyLiveTextTarget } from '../googDevice/liveTextTarget';
import { LockScreenNotice } from './LockScreenNotice';
import { UnlockSheet } from './UnlockSheet';
import { submitDevicePasscode } from '../state/unlockDevice';
import { StreamServiceStatus } from '../ui/StreamServiceStatus';
import KeyEvent from '../googDevice/android/KeyEvent';
import { KeyCodeControlMessage } from '../controlMessage/KeyCodeControlMessage';
import '../../style/kit/Banner.css';
import '../../style/views/StreamView.css';

interface StreamViewProps {
    params: ParamsStreamScrcpy;
    /** The tab strip of the phone's page, drawn under the header. */
    tabs?: ComponentChildren;
}

export function StreamView({ params, tabs }: StreamViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState('');
    // Counts the owner's "Start again" after the stream service was stopped: a new connection
    // is what starts the service, so the stream is mounted again.
    const [attempt, setAttempt] = useState(0);
    // The stream client that has had a connection. A new client (another phone, Start again)
    // connects; the same one reconnects.
    const [connectedClient, setConnectedClient] = useState<StreamClientScrcpy>();

    useEffect(() => {
        const container = containerRef.current;
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

    return (
        <div class="stream-view">
            <AppBar
                title={String(name)}
                status={
                    <>
                        <AppBarStatus tone={connection.tone}>{connection.label}</AppBarStatus>
                        {/* Only while the service does not run. */}
                        {descriptor && (
                            <StreamServiceStatus descriptor={descriptor} deviceKey={entry?.key} unlessRunning />
                        )}
                    </>
                }
            >
                <NotificationsLink compact />
                <Button size="compact" onClick={() => openSheet('devices')} disabled={!session}>
                    Switch
                </Button>
            </AppBar>
            {tabs}
            <LockScreenNotice
                key="lock-notice"
                udid={params.udid}
                connected={streamConnected.value}
                locked={locked}
                keyguardShowing={keyguardShowing}
                onUnlock={() => openSheet('unlock')}
            />
            <Presence show={!!streamNotice.value} key="notice" class="stream-notice-anchor">
                <div class="kit-banner stream-notice" role="status">
                    <Icon name="warning" size={16} />
                    <span class="kit-banner-text">{streamNotice.value}</span>
                    <IconButton
                        icon="close"
                        label="Dismiss message"
                        variant="bare"
                        size="compact"
                        onClick={() => (streamNotice.value = '')}
                    />
                </div>
            </Presence>
            {/* `StreamClientScrcpy` owns everything inside this node imperatively (see the effect
                above); the sheets/overlays below are rendered by Preact as siblings, not children,
                of that subtree so the two never fight over the same DOM nodes. Keep the stage
                keyed so inserting/removing a notice cannot reuse its imperative player DOM. */}
            <div key="stage" class="stream-stage">
                <div class="stream-mount" ref={containerRef} />
                <aside class="stream-controls-slot" aria-label="Device controls">
                    {session && session.params.udid === params.udid && <FloatingToolbar client={session.client} />}
                </aside>
            </div>
            {error && (
                <div class="stream-start-error" role="alert">
                    <h2>Unable to start this stream</h2>
                    <p>{error}</p>
                    <div class="stream-start-error-actions">
                        <Button onClick={goUp}>{LIST_PAGE_NAME}</Button>
                    </div>
                </div>
            )}
            {stopped && !error && (
                <div class="stream-start-error stream-service-stopped" role="alert">
                    <h2>{STREAM_SERVICE.stoppedTitle}</h2>
                    <p>{STREAM_SERVICE.stoppedMessage}</p>
                    <div class="stream-start-error-actions">
                        <Button variant="primary" onClick={() => setAttempt(attempt + 1)}>
                            Start again
                        </Button>
                        <Button onClick={goUp}>{LIST_PAGE_NAME}</Button>
                    </div>
                </div>
            )}
            {session && session.params.udid === params.udid && (
                <>
                    <ActionsSheet client={session.client} />
                    <DeviceSwitcherSheet />
                    <SleepOverlay
                        sessionKey={session.client}
                        connection={connection}
                        screenOff={screenOff}
                        onWake={wake}
                    />
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
                        onSubmit={(passcode, signal) =>
                            submitDevicePasscode(session.client, params.udid, passcode, signal)
                        }
                    />
                    {liveText && <LiveTextOverlay open={liveTextOpen.value} target={liveText} />}
                </>
            )}
        </div>
    );
}
