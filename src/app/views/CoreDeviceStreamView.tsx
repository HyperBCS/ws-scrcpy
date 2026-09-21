import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ParamsStreamCoreDevice } from '../../types/ParamsStreamCoreDevice';
import ApplDeviceDescriptor from '../../types/ApplDeviceDescriptor';
import { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';
import { CoreDeviceSessionState } from '../../common/CoreDeviceProtocol';
import {
    activeCoreDeviceStream,
    closeAllSheets,
    deviceClipboard,
    deviceClipboardError,
    liveTextOpen,
    openSheet,
    streamConnected,
    streamNotice,
} from '../state/stream';
import { findDeviceByUdid } from '../state/devices';
import { goToDeviceList } from '../state/router';
import { FloatingToolbar } from './FloatingToolbar';
import { DeviceSwitcherSheet } from './DeviceSwitcherSheet';
import { ApplActionsSheet } from './ApplActionsSheet';
import { LiveTextOverlay } from './LiveTextOverlay';
import { LockScreenNotice } from './LockScreenNotice';
import { SleepOverlay } from './SleepOverlay';
import { coreDeviceLiveTextTarget } from '../applDevice/liveTextTarget';
import '../../style/views/StreamView.css';

interface CoreDeviceStreamViewProps {
    params: ParamsStreamCoreDevice;
}

const SESSION_LABEL: Record<CoreDeviceSessionState, string> = {
    starting: 'Starting the phone stream…',
    ready: 'Connected',
    error: 'Stream unavailable',
    stopped: 'Stream stopped',
};

/** The iOS stream page: same header, stage and floating controls as the Android `StreamView`. */
export function CoreDeviceStreamView({ params }: CoreDeviceStreamViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState('');
    const [session, setSession] = useState<{ state: CoreDeviceSessionState; message?: string }>({
        state: 'starting',
    });

    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        closeAllSheets();
        deviceClipboard.value = undefined;
        deviceClipboardError.value = '';
        streamNotice.value = '';
        setError('');
        setSession({ state: 'starting' });
        let client: StreamClientCoreDevice;
        try {
            client = StreamClientCoreDevice.start(params, container);
        } catch (cause) {
            streamConnected.value = false;
            setError(cause instanceof Error ? cause.message : 'The stream could not be started.');
            return;
        }
        const onSession = (status: { state: CoreDeviceSessionState; message?: string }) => setSession(status);
        client.on('session', onSession);
        activeCoreDeviceStream.value = { params, client };
        return () => {
            client.off('session', onSession);
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
    const name = descriptor?.name || params.udid;
    useEffect(() => {
        if (descriptor?.name && active?.client) {
            active.client.setDeviceName(descriptor.name);
        }
    }, [descriptor?.name, active?.client]);
    const connected = streamConnected.value && session.state === 'ready';
    // Read by `DeviceStateMonitor` on the server (backlight + accessibility walk); 'unknown'
    // where that is disabled, which must never show as asleep or locked.
    const locked = descriptor?.['device.locked'] ?? 'unknown';
    const screenOff = descriptor?.['screen.power'] === 'off';
    const statusText = error
        ? 'Unable to connect'
        : !streamConnected.value
          ? 'Connecting…'
          : SESSION_LABEL[session.state];

    return (
        <div class="stream-view">
            <header class="stream-header">
                <button
                    type="button"
                    class="stream-header-back"
                    onClick={goToDeviceList}
                    aria-label="Back to devices"
                    title="Back to devices"
                >
                    <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path d="m15 6-6 6 6 6" />
                    </svg>
                </button>
                <div class="stream-header-device">
                    <strong title={String(name)}>{name}</strong>
                    <span class={`stream-header-status ${connected ? 'connected' : ''}`} role="status">
                        <span class="stream-header-status-dot" aria-hidden="true" />
                        {statusText}
                    </span>
                </div>
                <button
                    type="button"
                    class="stream-header-switch"
                    onClick={() => openSheet('devices')}
                    disabled={!active}
                >
                    Switch
                </button>
            </header>
            {/* Unlock opens the Actions sheet: its "Lock screen" group holds the passcode field. */}
            <LockScreenNotice
                key="lock-notice"
                udid={params.udid}
                connected={connected}
                locked={locked}
                keyguardShowing="unknown"
                onUnlock={() => openSheet('tools')}
            />
            {(session.state === 'error' || session.state === 'starting') && session.message && !error && (
                <div
                    key="session-notice"
                    class={`stream-notice ${session.state === 'error' ? 'error' : ''}`}
                    role="status"
                >
                    <span>{session.message}</span>
                    {session.state === 'error' && active && (
                        <button type="button" onClick={() => active.client.restartStream()}>
                            Retry
                        </button>
                    )}
                </div>
            )}
            {streamNotice.value && (
                <div key="notice" class="stream-notice" role="status">
                    <span>{streamNotice.value}</span>
                    <button type="button" onClick={() => (streamNotice.value = '')} aria-label="Dismiss message">
                        ✕
                    </button>
                </div>
            )}
            <div key="stage" class="stream-stage">
                <div class="stream-mount" ref={containerRef} />
                <aside class="stream-controls-slot" aria-label="Device controls">
                    {active && active.params.udid === params.udid && <FloatingToolbar client={active.client} />}
                </aside>
            </div>
            {error && (
                <div class="stream-start-error" role="alert">
                    <h2>Unable to start this stream</h2>
                    <p>{error}</p>
                    <button type="button" class="sheet-button" onClick={goToDeviceList}>
                        Back to devices
                    </button>
                </div>
            )}
            {active && active.params.udid === params.udid && (
                <>
                    <ApplActionsSheet client={active.client} descriptor={descriptor} />
                    <DeviceSwitcherSheet />
                    {/* A short Side-button tap wakes the display (the proxy sends the down/up pair). */}
                    <SleepOverlay
                        sessionKey={active.client}
                        screenOff={screenOff}
                        onWake={() => active.client.pressButton('lock')}
                    />
                    {liveTextOpen.value && liveText && <LiveTextOverlay target={liveText} />}
                </>
            )}
        </div>
    );
}
