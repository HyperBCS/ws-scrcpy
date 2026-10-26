import { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { requestJson } from '../client/request';
import { notificationKey } from '../state/notifications';
import '../../style/views/Access.css';

const endpoint = new URL('api/access', new URL('.', location.href)).href;
const signIn = (key: string, signal?: AbortSignal) =>
    requestJson<{ authenticated: boolean }>(
        endpoint,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
        },
        signal,
    );

export function AccessGate({ children }: { children: ComponentChildren }) {
    const [allowed, setAllowed] = useState(false);
    const [checking, setChecking] = useState(true);
    const [key, setKey] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        let pending = false;
        const check = async () => {
            if (pending || document.hidden) return;
            pending = true;
            try {
                let result = await requestJson<{ authenticated: boolean }>(endpoint, {}, controller.signal);
                const saved = notificationKey();
                if (!result.authenticated && saved) result = await signIn(saved, controller.signal);
                if (!controller.signal.aborted) {
                    setAllowed(result.authenticated === true);
                    setError('');
                }
            } catch (error) {
                if (!controller.signal.aborted) setError((error as Error).message);
            } finally {
                pending = false;
                if (!controller.signal.aborted) setChecking(false);
            }
        };
        void check();
        document.addEventListener('visibilitychange', check);
        return () => {
            controller.abort();
            document.removeEventListener('visibilitychange', check);
        };
    }, [attempt]);

    if (allowed) return <>{children}</>;
    return (
        <main class="access-page">
            <section class="access-card" aria-labelledby="access-heading">
                <div class="access-mark" aria-hidden="true">
                    ↗
                </div>
                <h1 id="access-heading">Your devices</h1>
                {checking ? (
                    <p role="status">Connecting…</p>
                ) : (
                    <>
                        <p>Enter your setup key to connect. This browser will remember you.</p>
                        <form
                            onSubmit={async (event) => {
                                event.preventDefault();
                                if (busy) return;
                                setBusy(true);
                                setError('');
                                try {
                                    const result = await signIn(key);
                                    setAllowed(result.authenticated === true);
                                    setKey('');
                                } catch (error) {
                                    setError((error as Error).message);
                                } finally {
                                    setBusy(false);
                                }
                            }}
                        >
                            <label for="access-key">Setup key</label>
                            <input
                                id="access-key"
                                type="password"
                                autoComplete="current-password"
                                value={key}
                                onInput={(event) => setKey(event.currentTarget.value)}
                                required
                                disabled={busy}
                            />
                            <button class="ui-button ui-button-primary" disabled={busy || !key.trim()}>
                                {busy ? 'Connecting…' : 'Connect'}
                            </button>
                        </form>
                        <details>
                            <summary>Where is my key?</summary>
                            <p>On the server, run:</p>
                            <code>docker exec ws-scrcpy cat /app/data/notification-setup-key</code>
                            <p>You can also open your private Tailscale address to connect automatically.</p>
                        </details>
                    </>
                )}
                {error && (
                    <div class="access-error" role="alert">
                        <p>{error}</p>
                        <button
                            class="ui-button"
                            onClick={() => {
                                setChecking(true);
                                setAttempt(attempt + 1);
                            }}
                        >
                            Retry connection
                        </button>
                    </div>
                )}
            </section>
        </main>
    );
}
