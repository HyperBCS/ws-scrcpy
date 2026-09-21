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
    unlockSheetOpen,
} from '../state/stream';
import { findDeviceForStream } from '../state/streamDevice';
import { goToDeviceList } from '../state/router';
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
import '../../style/views/StreamView.css';

interface StreamViewProps {
    params: ParamsStreamScrcpy;
}

export function StreamView({ params }: StreamViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        closeAllSheets();
        deviceClipboard.value = undefined;
        streamNotice.value = '';
        setError('');
        // `StreamClientScrcpy` sets `document.body.className = 'stream'` itself; navigating back
        // to the device list re-sets it to 'list' from there (see `views/DeviceList.tsx`).
        let client: StreamClientScrcpy;
        try {
            client = StreamClientScrcpy.start(params, undefined, undefined, params.fitToScreen, undefined, container);
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
        };
        // Re-mount the stream when the deep link actually points at a different device/player/
        // socket; other param changes (title, ...) do not warrant tearing the player down.
    }, [params.udid, params.player, params.ws]);

    const session = activeStream.value;
    const liveText = useMemo(() => (session ? scrcpyLiveTextTarget(session.client) : undefined), [session?.client]);
    const entry = findDeviceForStream(params);
    const descriptor = entry?.params.type === 'android' ? (entry.descriptor as GoogDeviceDescriptor) : undefined;
    const locked = descriptor?.['device.locked'] ?? 'unknown';
    const keyguardShowing = descriptor?.['keyguard.showing'] ?? 'unknown';
    // Only on positive evidence: `screen.power` is 'unknown' on devices whose dumpsys does not
    // report it, and an unknown screen must never be treated as a sleeping one.
    const screenOff = descriptor ? descriptor['screen.power'] === 'off' || descriptor['device.awake'] === false : false;
    const name = (entry?.descriptor as GoogDeviceDescriptor | undefined)?.['ro.product.model'] || params.udid;
    const wake = () => {
        session?.client.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_WAKEUP, 0, 0));
        session?.client.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_WAKEUP, 0, 0));
    };

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
                    <span class={`stream-header-status ${streamConnected.value ? 'connected' : ''}`} role="status">
                        <span class="stream-header-status-dot" aria-hidden="true" />
                        {error ? 'Unable to connect' : streamConnected.value ? 'Connected' : 'Connecting…'}
                    </span>
                    <StreamServiceStatus descriptor={descriptor} deviceKey={entry?.key} />
                </div>
                <button
                    type="button"
                    class="stream-header-switch"
                    onClick={() => openSheet('devices')}
                    disabled={!session}
                >
                    Switch
                </button>
            </header>
            <LockScreenNotice
                key="lock-notice"
                udid={params.udid}
                connected={streamConnected.value}
                locked={locked}
                keyguardShowing={keyguardShowing}
                onUnlock={() => openSheet('unlock')}
            />
            {streamNotice.value && (
                <div key="notice" class="stream-notice" role="status">
                    <span>{streamNotice.value}</span>
                    <button type="button" onClick={() => (streamNotice.value = '')} aria-label="Dismiss message">
                        ✕
                    </button>
                </div>
            )}
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
                    <button type="button" class="sheet-button" onClick={goToDeviceList}>
                        Back to devices
                    </button>
                </div>
            )}
            {session && session.params.udid === params.udid && (
                <>
                    <ActionsSheet client={session.client} />
                    <DeviceSwitcherSheet />
                    <SleepOverlay sessionKey={session.client} screenOff={screenOff} onWake={wake} />
                    <UnlockSheet
                        key={params.udid}
                        open={unlockSheetOpen.value}
                        udid={params.udid}
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
                    {liveTextOpen.value && liveText && <LiveTextOverlay target={liveText} />}
                </>
            )}
        </div>
    );
}
