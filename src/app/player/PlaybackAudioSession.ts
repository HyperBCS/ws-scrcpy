interface BrowserAudioSession {
    type: string;
}

interface PlaybackLease {
    previousType: string;
    owners: number;
}

const playbackLeases = new WeakMap<BrowserAudioSession, PlaybackLease>();

/**
 * Safari's Web Audio defaults can obey the iPhone Silent switch. An explicit Listen action
 * should use the media playback category instead (WebKit: https://bugs.webkit.org/show_bug.cgi?id=237322#c6).
 * This optional API is not available in every browser, and even reading it may throw in a host
 * app. Category failure must never prevent ordinary PCM or Opus playback.
 */
export function acquirePlaybackAudioSession(): (() => void) | undefined {
    try {
        if (typeof navigator === 'undefined') {
            return;
        }
        const session = (navigator as Navigator & { audioSession?: BrowserAudioSession }).audioSession;
        if (!session || typeof session.type !== 'string') {
            return;
        }
        let lease = playbackLeases.get(session);
        if (!lease || session.type !== 'playback') {
            const previousType = session.type;
            session.type = 'playback';
            if (session.type !== 'playback') {
                return;
            }
            lease = { previousType, owners: 0 };
            playbackLeases.set(session, lease);
        }
        lease.owners++;
        const ownedLease = lease;
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            ownedLease.owners--;
            if (ownedLease.owners || playbackLeases.get(session) !== ownedLease) {
                return;
            }
            playbackLeases.delete(session);
            try {
                // Device switching may briefly overlap players. Only the final owner restores
                // the category, and it must not overwrite a later choice made by another user
                // of the browser API (for example, microphone capture in an embedding app).
                if (session.type === 'playback' && ownedLease.previousType !== 'playback') {
                    session.type = ownedLease.previousType;
                }
            } catch {
                // Unsupported/locked-down hosts can reject category changes during teardown.
            }
        };
    } catch {
        return;
    }
}
