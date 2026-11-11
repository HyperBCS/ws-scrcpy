import { Presence } from '../ui/Presence';
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
import { ApplUnlockSheet } from './ApplUnlockSheet';
import { LiveTextOverlay } from './LiveTextOverlay';
import { LockScreenNotice } from './LockScreenNotice';
import { SleepOverlay } from './SleepOverlay';
import { coreDeviceLiveTextTarget } from '../applDevice/liveTextTarget';
import '../../style/views/StreamView.css';

interface CoreDeviceStreamViewProps {
    params: ParamsStreamCoreDevice;
}

type SessionStatus = { state: CoreDeviceSessionState; message?: string; retrying?: boolean };
// A session that failed or was stopped. Kept while the client tries again, so the card stays put
// between attempts and does not blink in and out with each one.
type Failure = { state: 'error' | 'stopped'; message?: string; retrying: boolean };

const FAILURE_TITLE = { error: 'Stream unavailable', stopped: 'Stream stopped' };
const FAILURE_FALLBACK = {
    error: 'The phone stream could not be started.',
    stopped: 'The screen session on the phone was stopped.',
};

/** The iOS stream page: same header, stage and floating controls as the Android `StreamView`. */
export function CoreDeviceStreamView({ params }: CoreDeviceStreamViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState('');
    const [session, setSession] = useState<SessionStatus>({ state: 'starting' });
    const [failure, setFailure] = useState<Failure>();
    const [decoderError, setDecoderError] = useState('');
    const [linkOpen, setLinkOpen] = useState(false);

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
    // One card on the stage for every state without a picture: the reason, and what can be done.
    // A browser without a decoder cannot be retried into having one, so it gets no Retry.
    const trying = !!failure && session.state === 'starting';
    const problem = error
        ? { kind: 'start', title: 'Unable to start this stream', message: error, note: '', retry: false }
        : decoderError
          ? {
                kind: 'decoder',
                title: 'This browser cannot show the stream',
                message: decoderError,
                note: '',
                retry: false,
            }
          : failure
            ? {
                  kind: failure.state,
                  title: FAILURE_TITLE[failure.state],
                  message: failure.message || FAILURE_FALLBACK[failure.state],
                  note: trying ? 'Trying again…' : failure.retrying ? 'Trying again shortly.' : '',
                  retry: true,
              }
            : undefined;
    // "Connected" needs a picture. After a failed start the socket stays closed until the next
    // try, which can be a minute away or wait for Retry; "Connecting" would be wrong for that long.
    const statusText = error
        ? 'Unable to connect'
        : decoderError
          ? 'No picture'
          : failure
            ? trying
                ? 'Trying again…'
                : FAILURE_TITLE[failure.state]
            : connected
              ? 'Connected'
              : linkOpen && session.state === 'starting'
                ? 'Starting the phone stream…'
                : 'Connecting…';

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
            <LockScreenNotice
                key="lock-notice"
                udid={params.udid}
                connected={connected}
                locked={locked}
                keyguardShowing="unknown"
                onUnlock={() => openSheet('unlock')}
            />
            {/* Progress of a first start ("Preparing the device"). A failure has the card below. */}
            <Presence
                show={session.state === 'starting' && !!session.message && !problem}
                kind="collapse"
                key="session-notice"
                class="stream-notice"
                role="status"
            >
                <span>{session.message}</span>
            </Presence>
            <Presence show={!!streamNotice.value} kind="collapse" key="notice" class="stream-notice" role="status">
                <span>{streamNotice.value}</span>
                <button type="button" onClick={() => (streamNotice.value = '')} aria-label="Dismiss message">
                    ✕
                </button>
            </Presence>
            <div key="stage" class="stream-stage">
                <div class="stream-mount" ref={containerRef} />
                <aside class="stream-controls-slot" aria-label="Device controls">
                    {active && active.params.udid === params.udid && <FloatingToolbar client={active.client} />}
                </aside>
            </div>
            {problem && (
                <div class="stream-start-error" role="alert" data-stream-problem={problem.kind}>
                    <h2>{problem.title}</h2>
                    <p>{problem.message}</p>
                    {/* Changes with every attempt; not read out again each time. */}
                    {problem.note && (
                        <p class="stream-start-error-note" aria-live="off">
                            {problem.note}
                        </p>
                    )}
                    <div class="stream-start-error-actions">
                        {problem.retry && active && (
                            <button type="button" class="sheet-button primary" onClick={() => active.client.retry()}>
                                Retry
                            </button>
                        )}
                        <button type="button" class="sheet-button" onClick={goToDeviceList}>
                            Back to devices
                        </button>
                    </div>
                </div>
            )}
            {active && active.params.udid === params.udid && (
                <>
                    <ApplActionsSheet client={active.client} descriptor={descriptor} />
                    <ApplUnlockSheet client={active.client} />
                    <DeviceSwitcherSheet />
                    {/* A short Side-button tap wakes the display (the proxy sends the down/up pair).
                        Left out while the stage shows a problem: its "Reconnecting" would cover
                        the card, and the card carries Retry. */}
                    {!problem && (
                        <SleepOverlay
                            sessionKey={active.client}
                            screenOff={screenOff}
                            onWake={() => active.client.pressButton('lock')}
                        />
                    )}
                    {liveText && <LiveTextOverlay open={liveTextOpen.value} target={liveText} />}
                </>
            )}
        </div>
    );
}
