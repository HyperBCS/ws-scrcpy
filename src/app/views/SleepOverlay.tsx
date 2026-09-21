import { useEffect, useState } from 'preact/hooks';
import { streamConnected } from '../state/stream';
import { goToDeviceList } from '../state/router';
import '../../style/views/SleepOverlay.css';

// How long to stay optimistically hidden after the user taps Wake. The Android device-state poll
// runs every 10s while a tracker client is connected (the iOS one every 4s while streaming), so
// this has to outlast one full cycle or the overlay flaps back in on stale data before the
// refreshed descriptor arrives.
const WAKE_GRACE_MS = 12000;

interface SleepOverlayProps {
    // Identity of the mounted stream; the overlay's optimistic state resets when it changes.
    sessionKey: unknown;
    // Only on positive evidence from the device (see the callers): an unknown screen must never
    // be treated as a sleeping one.
    screenOff: boolean;
    // Sends whatever wakes this platform's screen (a WAKEUP key on Android, a Lock tap on iOS).
    onWake: () => void;
}

/**
 * Shown when the device reports its screen off, or when the stream's transport is down.
 *
 * Deliberately NOT driven by "no frame for N seconds". scrcpy only encodes on screen change, so a
 * healthy stream of a static screen goes seconds between frames; using that as a stall signal made
 * this overlay appear over a working stream, and because it covered the viewport it ate the very
 * touches that would have produced a new frame. Screen state comes from the device itself
 * (`screen.power` / `device.awake`, polled server-side) and liveness from the socket.
 */
export function SleepOverlay({ sessionKey, screenOff, onWake }: SleepOverlayProps) {
    const [wakeRequestedAt, setWakeRequestedAt] = useState(0);
    const [hasConnected, setHasConnected] = useState(false);
    const [waiting, setWaiting] = useState(false);

    const disconnected = !streamConnected.value;

    useEffect(() => {
        setHasConnected(false);
        setWaiting(false);
        setWakeRequestedAt(0);
    }, [sessionKey]);

    useEffect(() => {
        if (!disconnected) {
            setHasConnected(true);
            setWaiting(false);
            return;
        }
        const timeout = setTimeout(() => setWaiting(true), 12000);
        return () => clearTimeout(timeout);
    }, [disconnected, sessionKey]);

    // Clear the optimistic hide once the device confirms it is awake again, so a device that goes
    // back to sleep inside the grace window still re-shows the overlay promptly.
    useEffect(() => {
        if (!screenOff && wakeRequestedAt) {
            setWakeRequestedAt(0);
        }
    }, [screenOff, wakeRequestedAt]);

    const suppressed = wakeRequestedAt !== 0 && Date.now() - wakeRequestedAt < WAKE_GRACE_MS;
    const visible = (screenOff && !suppressed) || disconnected;

    // Re-evaluate when the grace window lapses; nothing else would trigger a render if the device
    // never reports back (wake keycode ignored, device unplugged mid-wake).
    useEffect(() => {
        if (!suppressed) {
            return;
        }
        const id = setTimeout(() => setWakeRequestedAt((v) => (v === wakeRequestedAt ? 0 : v)), WAKE_GRACE_MS);
        return () => clearTimeout(id);
    }, [suppressed, wakeRequestedAt]);

    if (!visible) {
        return null;
    }

    const wake = () => {
        onWake();
        // Hide immediately rather than waiting up to a poll interval for the descriptor to catch
        // up; the effect above reverts this if the device turns out to still be asleep.
        setWakeRequestedAt(Date.now());
    };

    return (
        // `pointer-events: none` on the backdrop (see the stylesheet) so only the card below can
        // ever receive input. Even if the visibility logic above is wrong, this overlay cannot
        // block the video surface or the control bar.
        <div class="sleep-overlay" aria-live="polite" role="status">
            {disconnected ? (
                <div class="sleep-overlay-card">
                    <div class="sleep-overlay-spinner" aria-hidden="true" />
                    <div class="sleep-overlay-label">{hasConnected ? 'Reconnecting…' : 'Connecting to device…'}</div>
                    <div class="sleep-overlay-hint">
                        {waiting
                            ? 'Taking longer than expected. Check that the device is online and unlocked.'
                            : hasConnected
                              ? 'Your stream will resume automatically.'
                              : 'Starting the screen stream. This may take a moment.'}
                    </div>
                    {waiting && (
                        <button type="button" class="sleep-overlay-return" onClick={goToDeviceList}>
                            Back to devices
                        </button>
                    )}
                </div>
            ) : (
                <button type="button" class="sleep-overlay-card sleep-overlay-button" onClick={wake}>
                    <div class="sleep-overlay-icon" aria-hidden="true">
                        ☾
                    </div>
                    <div class="sleep-overlay-label">Screen is off</div>
                    <div class="sleep-overlay-hint">Tap to wake the device</div>
                </button>
            )}
        </div>
    );
}
