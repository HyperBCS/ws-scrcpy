import { useEffect, useRef, useState } from 'preact/hooks';
import { ACTION } from '../../common/Action';
import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { BaseClient } from '../client/BaseClient';
import { deviceName, DeviceEntry } from '../state/devices';
import { findDeviceForTool } from '../state/toolDevice';
import { buildLinkHref } from '../state/links';
import { goToDeviceList } from '../state/router';
import { closeAllSheets, openSheet } from '../state/stream';
import { StreamServiceStatus } from '../ui/StreamServiceStatus';
import { DeviceSwitcherSheet } from './DeviceSwitcherSheet';
import '../../style/views/StreamView.css';
import '../../style/views/ToolView.css';

interface MountedTool {
    stop(): void;
    hasConnection(): boolean;
    navigate?(path: string): void;
    focus?(): void;
    sendInput?(text: string): void;
    setControl?(active: boolean): void;
}

export const deviceTools = [
    /// #if INCLUDE_FILE_LISTING
    { action: ACTION.FILE_LISTING, title: 'Files', hint: 'Browse, download, and upload files on your device.' },
    /// #endif
    /// #if INCLUDE_ADB_SHELL
    { action: ACTION.SHELL, title: 'Shell', hint: 'Use the device terminal. Tap the terminal to type.' },
    /// #endif
];

export function isToolAction(action: string | null): boolean {
    return deviceTools.some((tool) => tool.action === action);
}

async function mountTool(
    params: URLSearchParams,
    mount: HTMLElement,
    cancelled: () => boolean,
): Promise<MountedTool | undefined> {
    switch (params.get('action')) {
        /// #if INCLUDE_FILE_LISTING
        case ACTION.FILE_LISTING: {
            const { FileListingClient } = await import('../googDevice/client/FileListingClient');
            if (!cancelled()) return FileListingClient.start(FileListingClient.parseParameters(params), mount);
            break;
        }
        /// #endif
        /// #if INCLUDE_ADB_SHELL
        case ACTION.SHELL: {
            const { ShellClient } = await import('../googDevice/client/ShellClient');
            if (!cancelled()) return ShellClient.start(ShellClient.parseParameters(params), mount);
            break;
        }
        /// #endif
    }
    return undefined;
}

function follow(href: string): void {
    const url = new URL(href);
    if (url.origin === location.origin && url.pathname === location.pathname) {
        location.hash = url.hash;
    } else {
        location.assign(url);
    }
}

export function ToolView({ params }: { params: URLSearchParams }) {
    const action = params.get('action') || '';
    const udid = params.get('udid') || '';
    const tool = deviceTools.find((candidate) => candidate.action === action);
    const entry = findDeviceForTool({ ...BaseClient.parseParameters(params), udid });
    const descriptor = entry?.descriptor as GoogDeviceDescriptor | undefined;
    const mountRef = useRef<HTMLDivElement>(null);
    const clientRef = useRef<MountedTool>();
    const routeRef = useRef(params);
    routeRef.current = params;
    const [error, setError] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [connected, setConnected] = useState(false);
    const [connectionLost, setConnectionLost] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [control, setControl] = useState(false);
    const [viewportHeight, setViewportHeight] = useState<number>();
    // Directory navigation is handled by Files without tearing down in-flight transfers.
    const identity = ['action', 'udid', 'hostname', 'port', 'pathname', 'secure', 'useProxy']
        .map((key) => params.get(key))
        .join('\n');

    useEffect(() => {
        const update = () => setViewportHeight(window.visualViewport?.height);
        update();
        window.visualViewport?.addEventListener('resize', update);
        return () => window.visualViewport?.removeEventListener('resize', update);
    }, []);

    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return;
        let cancelled = false;
        let mounted: MountedTool | undefined;
        let wasConnected = false;
        const openedAt = Date.now();
        closeAllSheets();
        setError('');
        setLoaded(false);
        setConnected(false);
        setConnectionLost(false);
        setControl(false);
        document.body.className = `tool-page ${action === ACTION.FILE_LISTING ? 'file-listing' : action}`;
        document.title = `${tool?.title || 'Tools'} · ${udid}`;
        mountTool(routeRef.current, mount, () => cancelled)
            .then((client) => {
                if (!client) return;
                if (cancelled) {
                    client.stop();
                    return;
                }
                mounted = client;
                clientRef.current = client;
                client.navigate?.(routeRef.current.get('path') || '/data/local/tmp/');
                setLoaded(true);
                wasConnected = client.hasConnection();
                setConnected(wasConnected);
            })
            .catch((failure: Error) => {
                if (!cancelled) setError(failure.message || 'This tool could not open. Try again.');
            });
        const connectionCheck = window.setInterval(() => {
            const ready = mounted?.hasConnection() ?? false;
            wasConnected ||= ready;
            setConnected(ready);
            setConnectionLost(!!mounted && !ready && (wasConnected || Date.now() - openedAt > 10000));
        }, 500);
        return () => {
            cancelled = true;
            clearInterval(connectionCheck);
            mounted?.stop();
            clientRef.current = undefined;
            mount.replaceChildren();
            closeAllSheets();
        };
    }, [identity, attempt]);

    useEffect(() => {
        clientRef.current?.navigate?.(params.get('path') || '/data/local/tmp/');
    }, [params.get('path')]);

    const switchTool = (nextAction: ACTION, nextEntry = entry) => {
        if (nextEntry) {
            follow(
                buildLinkHref(
                    {
                        action: nextAction,
                        udid: nextEntry.descriptor.udid,
                        path: nextAction === ACTION.FILE_LISTING ? '/data/local/tmp/' : undefined,
                    },
                    nextEntry.params,
                ),
            );
        } else {
            const next = new URLSearchParams(params);
            next.set('action', nextAction);
            if (nextAction === ACTION.FILE_LISTING) next.set('path', '/data/local/tmp/');
            else next.delete('path');
            location.hash = `!${next}`;
        }
    };

    return (
        <main
            class={`tool-view tool-view-${action}`}
            style={viewportHeight ? { height: `${viewportHeight}px` } : undefined}
        >
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
                        aria-hidden="true"
                    >
                        <path d="m15 6-6 6 6 6" />
                    </svg>
                </button>
                <div class="stream-header-device">
                    <strong>{entry ? deviceName(entry) : udid}</strong>
                    <StreamServiceStatus descriptor={descriptor} deviceKey={entry?.key} />
                </div>
                <button type="button" class="stream-header-switch" onClick={() => openSheet('devices')}>
                    Switch
                </button>
            </header>
            <nav class="tool-navigation" aria-label="Device views">
                <div class="tool-tabs">
                    {deviceTools.map((item) => (
                        <button
                            key={item.action}
                            type="button"
                            title={item.hint}
                            aria-current={item.action === action ? 'page' : undefined}
                            onClick={() => switchTool(item.action)}
                        >
                            {item.title}
                        </button>
                    ))}
                </div>
                <span class={`tool-connection ${connected ? 'connected' : ''}`} role="status">
                    {error
                        ? 'Unavailable'
                        : connected
                          ? 'Connected'
                          : loaded
                            ? connectionLost
                                ? 'Disconnected'
                                : 'Connecting…'
                            : 'Opening…'}
                </span>
            </nav>
            <section class="tool-workspace" aria-label={tool?.title}>
                {(error || connectionLost) && (
                    <div class="tool-error" role="status">
                        <span>{error || 'The connection is closed. Reconnect to continue.'}</span>
                        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                            Reconnect
                        </button>
                    </div>
                )}
                <div key="tool-mount" ref={mountRef} class="tool-mount" />
                {action === ACTION.SHELL && (
                    <div class="shell-shortcuts" aria-label="Terminal keys">
                        <button
                            type="button"
                            disabled={!connected}
                            onClick={() => clientRef.current?.focus?.()}
                            aria-label="Show keyboard"
                            title="Show keyboard"
                        >
                            <svg
                                width="24"
                                height="24"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.6"
                                aria-hidden="true"
                            >
                                <rect x="2" y="5" width="20" height="14" rx="2" />
                                <path d="M5 9h2m2 0h2m2 0h2m2 0h2M5 12h2m2 0h2m2 0h2m2 0h2M7 15h10" />
                            </svg>
                        </button>
                        <button
                            type="button"
                            disabled={!connected}
                            aria-pressed={control}
                            title="Hold Ctrl for the next keys"
                            onClick={() => {
                                const next = !control;
                                setControl(next);
                                clientRef.current?.setControl?.(next);
                                clientRef.current?.focus?.();
                            }}
                        >
                            Ctrl
                        </button>
                        {(
                            [
                                ['Esc', '\x1b'],
                                ['Tab', '\t'],
                                ['↑', '\x1b[A'],
                                ['↓', '\x1b[B'],
                            ] as const
                        ).map(([label, input]) => (
                            <button
                                key={label}
                                type="button"
                                disabled={!connected}
                                aria-label={label === '↑' ? 'Previous command' : label === '↓' ? 'Next command' : label}
                                onClick={() => clientRef.current?.sendInput?.(input)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                )}
            </section>
            <DeviceSwitcherSheet
                currentDeviceKey={entry?.key}
                onSelectDevice={(next: DeviceEntry) => switchTool(action as ACTION, next)}
            />
        </main>
    );
}
