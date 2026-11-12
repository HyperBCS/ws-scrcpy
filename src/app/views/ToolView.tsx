import { ComponentChildren } from 'preact';
import { Presence } from '../ui/Presence';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ACTION } from '../../common/Action';
import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { BaseClient } from '../client/BaseClient';
import { DeviceEntry, isDeviceAvailable, phoneName, supportsDeviceTools } from '../state/devices';
import { toolConnection } from '../state/phoneStatus';
import { DEFAULT_FILES_PATH } from '../googDevice/client/deviceTools';
import { findDeviceForTool } from '../state/toolDevice';
import { deviceHref, followLink } from '../state/links';
import type { DeviceView } from '../state/routes';
import { closeAllSheets, openSheet } from '../state/stream';
import { AppBar } from '../ui/AppBar';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { StreamServiceStatus } from '../ui/StreamServiceStatus';
import { DeviceSwitcherSheet } from './DeviceSwitcherSheet';
import { StateCardBody } from './screen/StateCard';
import { NotificationsLink } from '../ui/NotificationsLink';
import { ShellKeys, ShellTerminal } from './shell/ShellKeys';
import '../../style/views/StreamView.css';
import '../../style/views/ToolView.css';

/** A mounted tool. Shell also takes the keys of its row (`ShellTerminal`). */
export interface MountedTool extends Partial<ShellTerminal> {
    stop(): void;
    hasConnection(): boolean;
    navigate?(path: string): void;
    /**
     * Told when the tool's tab is hidden (false) and when it is shown again (true). The tool
     * stays mounted in between: a tab change never stops it. A new tool counts as shown.
     */
    setActive?(active: boolean): void;
    onControlChange?(listener: (active: boolean) => void): void;
    /** Opens a new connection in place. A tool without it is mounted again instead. */
    reconnect?(): void;
    /** True when the tool's own session ended, which a new attempt would not bring back. */
    sessionEnded?(): boolean;
}

/** Waits before each automatic reconnect attempt after the connection is lost. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];
/** How long the last attempt gets before the page stops trying and offers Reconnect. */
const RETRY_SETTLE_MS = 4000;
/** A first connection that has not opened by now counts as lost. */
const FIRST_CONNECT_MS = 10000;

/** '' while there is nothing to report, then one state at a time. */
type Lost = '' | 'reconnecting' | 'closed' | 'ended';

/** The tools this build has, in the order of their tabs. `view` is the tab each one is. */
export const deviceTools: ReadonlyArray<{ view: DeviceView; action: ACTION; title: string; hint: string }> = [
    /// #if INCLUDE_FILE_LISTING
    {
        view: 'files',
        action: ACTION.FILE_LISTING,
        title: 'Files',
        hint: 'Browse, download, and upload files on this phone.',
    },
    /// #endif
    /// #if INCLUDE_ADB_SHELL
    { view: 'shell', action: ACTION.SHELL, title: 'Shell', hint: 'Use the terminal of this phone. Tap it to type.' },
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

interface ToolViewProps {
    /** The address this tool was last shown with. It does not change while the tool is hidden. */
    params: URLSearchParams;
    /** False while another tab of the phone's page is shown. The tool stays mounted, hidden. */
    active: boolean;
    /** The tab strip of the phone's page, drawn with this tool's connection state at its end. */
    tabs: (status: ComponentChildren) => ComponentChildren;
}

/**
 * One tool of a phone's page: Files or Shell. The page mounts it the first time its tab is shown
 * and keeps it until the page is left, so a shell session and a Files folder survive a look at
 * another tab. While hidden it draws no header, sets no body class, follows no keyboard height
 * and holds no focus; its connection stays open.
 */
export function ToolView({ params, active, tabs }: ToolViewProps) {
    const action = params.get('action') || '';
    const udid = params.get('udid') || '';
    const tool = deviceTools.find((candidate) => candidate.action === action);
    const entry = findDeviceForTool({ ...BaseClient.parseParameters(params), udid });
    const descriptor = entry?.descriptor as GoogDeviceDescriptor | undefined;
    const viewRef = useRef<HTMLElement>(null);
    const workspaceRef = useRef<HTMLElement>(null);
    // A hidden tool keeps its workspace where the header and the tabs left it. Grown into their
    // place, it would refit the terminal, and Shell would resize the phone's terminal twice for
    // each look at another tab. Measured as the tab is left, while the header is still drawn.
    const chromeHeight = useRef(0);
    const wasActive = useRef(active);
    if (wasActive.current && !active && viewRef.current && workspaceRef.current) {
        chromeHeight.current =
            workspaceRef.current.getBoundingClientRect().top - viewRef.current.getBoundingClientRect().top;
    }
    wasActive.current = active;
    const mountRef = useRef<HTMLDivElement>(null);
    const clientRef = useRef<MountedTool>();
    const routeRef = useRef(params);
    routeRef.current = params;
    const activeRef = useRef(active);
    activeRef.current = active;
    // What the mounted tool was last told. A new one counts as shown.
    const toldActive = useRef(true);
    const tellActive = () => {
        const client = clientRef.current;
        if (client && toldActive.current !== activeRef.current) {
            toldActive.current = activeRef.current;
            client.setActive?.(activeRef.current);
        }
    };
    const [error, setError] = useState('');
    // The tool's code could not be downloaded, usually because a deploy replaced it. Only a
    // reload of the page fetches the new names; reconnecting would ask for the old ones again.
    const [codeMissing, setCodeMissing] = useState(false);
    const [connected, setConnected] = useState(false);
    const [lost, setLost] = useState<Lost>('');
    // Outlives the mount effect: a tool that cannot reconnect in place is mounted again for each
    // automatic attempt, and the count must carry over. `nextAt` is 0 while nothing is lost.
    const retryRef = useRef({ identity: '', attempts: 0, nextAt: 0 });
    const [attempt, setAttempt] = useState(0);
    const [control, setControl] = useState(false);
    const [viewportHeight, setViewportHeight] = useState<number>();
    // Directory navigation is handled by Files without tearing down in-flight transfers.
    const identity = ['action', 'udid', 'hostname', 'port', 'pathname', 'secure', 'useProxy']
        .map((key) => params.get(key))
        .join('\n');

    useEffect(() => {
        if (!active) {
            // Measured again when the tab is shown. A height kept from an open keyboard would
            // squeeze the tool for one frame and refit it twice.
            setViewportHeight(undefined);
            return;
        }
        const update = () => setViewportHeight(window.visualViewport?.height);
        update();
        window.visualViewport?.addEventListener('resize', update);
        return () => window.visualViewport?.removeEventListener('resize', update);
    }, [active]);

    useLayoutEffect(() => {
        if (active) {
            document.body.className = action === ACTION.FILE_LISTING ? 'file-listing' : action;
        } else if (viewRef.current?.contains(document.activeElement)) {
            // Typing must not reach a terminal or a field that is no longer on screen.
            (document.activeElement as HTMLElement).blur();
        }
        tellActive();
    }, [active, action]);

    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return;
        let cancelled = false;
        let mounted: MountedTool | undefined;
        let remounting = false;
        const retry = retryRef.current;
        const retrying = retry.identity === identity && retry.nextAt !== 0;
        if (!retrying) {
            Object.assign(retry, { identity, attempts: 0, nextAt: 0 });
            closeAllSheets();
        }
        // An attempt that does not open is a failed attempt, not a slow first connection.
        let wasConnected = retrying;
        const openedAt = Date.now();
        setError('');
        setCodeMissing(false);
        setConnected(false);
        setLost(retrying ? 'reconnecting' : '');
        setControl(false);
        mountTool(routeRef.current, mount, () => cancelled)
            .then((client) => {
                if (!client) return;
                if (cancelled) {
                    client.stop();
                    return;
                }
                mounted = client;
                clientRef.current = client;
                // The tab can change while the tool's code is still loading.
                toldActive.current = true;
                tellActive();
                client.onControlChange?.(setControl);
                client.navigate?.(routeRef.current.get('path') || DEFAULT_FILES_PATH);
                wasConnected ||= client.hasConnection();
                setConnected(client.hasConnection());
            })
            .catch((failure: Error) => {
                if (cancelled) return;
                if (failure.name === 'ChunkLoadError') {
                    setCodeMissing(true);
                    return;
                }
                setError(failure.message || 'This tool could not open. Try again.');
            });
        const connectionCheck = window.setInterval(() => {
            const ready = mounted?.hasConnection() ?? false;
            setConnected(ready);
            if (ready) {
                wasConnected = true;
                Object.assign(retry, { attempts: 0, nextAt: 0 });
                setLost('');
                return;
            }
            const now = Date.now();
            // A hidden tool is not tried again behind the tab that is shown: Files is mounted
            // anew for each attempt and reads the address when it is. The attempts start when
            // its tab is shown again.
            if (!mounted || !activeRef.current || !(wasConnected || now - openedAt > FIRST_CONNECT_MS)) {
                return;
            }
            if (mounted.sessionEnded?.()) {
                Object.assign(retry, { attempts: 0, nextAt: 0 });
                setLost('ended');
                return;
            }
            if (!retry.nextAt) {
                retry.nextAt = now + RETRY_DELAYS_MS[0];
            }
            if (now >= retry.nextAt && retry.attempts < RETRY_DELAYS_MS.length) {
                retry.attempts++;
                retry.nextAt = now + (RETRY_DELAYS_MS[retry.attempts] ?? RETRY_SETTLE_MS);
                if (mounted.reconnect) {
                    mounted.reconnect();
                } else {
                    remounting = true;
                    setAttempt((value) => value + 1);
                }
            }
            setLost(now < retry.nextAt ? 'reconnecting' : 'closed');
        }, 500);
        return () => {
            cancelled = true;
            clearInterval(connectionCheck);
            mounted?.stop();
            clientRef.current = undefined;
            mount.replaceChildren();
            // An automatic attempt must not close the device switcher under the owner's finger.
            if (!remounting) {
                closeAllSheets();
            }
        };
    }, [identity, attempt]);

    // Only an address that names a folder moves Files. A tab link to Files that is already
    // mounted names none, and Files stays in the folder it was left in.
    useEffect(() => {
        const path = params.get('path');
        if (path) {
            clientRef.current?.navigate?.(path);
        }
    }, [params.get('path')]);

    const reconnect = () => {
        const retry = retryRef.current;
        const client = clientRef.current;
        retry.attempts = 0;
        if (!error && client?.reconnect) {
            // The check above sees the attempt and starts a new round if it fails.
            retry.nextAt = 0;
            client.reconnect();
            setLost('reconnecting');
        } else {
            // A tool that did open is mounted again as a reconnect attempt, so a failure shows
            // within seconds. One that never loaded starts from the beginning.
            retry.nextAt = error ? 0 : Date.now() + RETRY_DELAYS_MS[0];
            setAttempt((value) => value + 1);
        }
    };

    // The banner keeps its last wording while it collapses. A tool whose code is missing has a
    // card of its own instead (below).
    const showBanner = !codeMissing && (!!error || lost === 'closed' || lost === 'ended');
    const bannerRef = useRef({ text: '', button: 'Reconnect' });
    if (showBanner) {
        bannerRef.current = error
            ? { text: error, button: 'Reconnect' }
            : lost === 'ended'
              ? { text: 'The shell session ended.', button: 'New session' }
              : { text: 'Connection lost.', button: 'Reconnect' };
    }

    const connection = toolConnection({
        failed: !!error || codeMissing,
        connected,
        lost,
        phoneOffline: !!entry && !isDeviceAvailable(entry),
    });

    const switchPhone = (next: DeviceEntry) => {
        if (tool) {
            const extra = tool.view === 'files' ? { path: DEFAULT_FILES_PATH } : {};
            followLink(deviceHref(next.descriptor.udid, tool.view, next.params, extra), 'switch');
        }
    };

    return (
        <main
            ref={viewRef}
            class={`tool-view tool-view-${action}`}
            hidden={!active}
            style={
                !active
                    ? { top: `${chromeHeight.current}px` }
                    : viewportHeight
                      ? { height: `${viewportHeight}px` }
                      : undefined
            }
        >
            {active && (
                <AppBar
                    title={phoneName(udid, entry)}
                    status={
                        descriptor && (
                            <StreamServiceStatus descriptor={descriptor} deviceKey={entry?.key} unlessRunning />
                        )
                    }
                >
                    <NotificationsLink compact />
                    <Button size="compact" onClick={() => openSheet('devices')}>
                        Switch
                    </Button>
                </AppBar>
            )}
            {active &&
                tabs(
                    <span
                        class={`tool-connection ${connected ? 'connected' : ''}`}
                        role="status"
                        data-tone={connection.tone}
                    >
                        {connection.label}
                    </span>,
                )}
            <section ref={workspaceRef} class="tool-workspace" aria-label={tool?.title}>
                <Presence show={showBanner} kind="collapse" class="tool-error">
                    <Banner action={{ label: bannerRef.current.button, run: reconnect }}>
                        {bannerRef.current.text}
                    </Banner>
                </Presence>
                {/* The tool's code could not be downloaded, after a deploy: the page's state card
                    with the one thing that helps. Nothing is mounted under it. */}
                {codeMissing && (
                    <div class="tool-state">
                        <StateCardBody
                            content={{
                                state: connection.state,
                                problem: 'code-missing',
                                icon: 'errorCircle',
                                title: `${tool?.title || 'This tool'} could not be loaded`,
                                message: 'Reload the page to try again.',
                                action: { label: 'Reload', run: () => location.reload() },
                            }}
                        />
                    </div>
                )}
                <div key="tool-mount" ref={mountRef} class="tool-mount" hidden={codeMissing} />
                {/* The keys a phone keyboard lacks. Only a touch screen has them. */}
                {action === ACTION.SHELL && !codeMissing && (
                    <ShellKeys
                        connected={connected}
                        control={control}
                        onControl={setControl}
                        terminal={() => clientRef.current}
                    />
                )}
            </section>
            {/* One switcher for the page: a hidden tool has none, and no shortcut of its own. */}
            {active && (
                <DeviceSwitcherSheet
                    currentDeviceKey={entry?.key}
                    filter={supportsDeviceTools}
                    title={`Switch phone · ${tool?.title || 'Tools'}`}
                    onSelectDevice={switchPhone}
                />
            )}
        </main>
    );
}
