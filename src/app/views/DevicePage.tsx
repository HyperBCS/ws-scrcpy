import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import { BaseClient } from '../client/BaseClient';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import { streamSocketUrl } from '../googDevice/client/deviceInterfaces';
import { DEFAULT_FILES_PATH } from '../googDevice/client/deviceTools';
import { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';
import { deviceName, findDeviceByUdid, phoneName } from '../state/devices';
import { capabilities } from '../state/capabilities';
import { goUp, switchRoute } from '../state/router';
import {
    clientParams,
    deviceRoute,
    DeviceView,
    LIST_PAGE_NAME,
    parseRoute,
    Platform,
    rememberedPhone,
    rememberPhone,
} from '../state/routes';
import { AppBar } from '../ui/AppBar';
import { Button } from '../ui/Button';
import { Tab, TabStrip } from '../ui/TabStrip';
import { ScreenView } from './ScreenView';
import { useAndroidScreen } from './screen/android';
import { useIphoneScreen } from './screen/iphone';
import { ToolRoute } from './ToolRoute';
import { deviceTools } from './ToolView';
import '../../style/views/ToolUnavailable.css';

/** How long a screen link for a phone this browser has not seen waits for the list. */
const IDENTIFY_MS = 1500;

/** The server a phone is reached through, when the address names one. Part of which page it is. */
const HOST_KEYS = ['hostname', 'port', 'pathname', 'secure', 'useProxy'];

/** What a tab link does not take over from the address: its own head, the socket and the folder. */
const TAB_DROPS = ['action', 'udid', 'view', 'ws', 'path'];

/**
 * The tabs of a phone's page: the screen, and each tool the phone can run (`capabilities`) and
 * this build has. A page with the screen only (an iPhone) shows no tabs.
 */
function phoneTabs(platform: Platform): ReadonlyArray<Tab<DeviceView>> {
    const can = capabilities(platform);
    const tools = deviceTools.filter(({ view }) => view !== 'screen' && can[view]);
    return [{ id: 'screen', title: 'Screen' }, ...tools.map(({ view, title, hint }) => ({ id: view, title, hint }))];
}

/**
 * The server a phone's link points at, as its tracker describes it. A link names another host
 * only when that host is reached through this server's proxy; otherwise it is this server.
 */
function streamHost(query: URLSearchParams): ParamsDeviceTracker {
    const base = BaseClient.parseParameters(query);
    if (base.useProxy) {
        return { ...base, type: 'android' };
    }
    const secure = location.protocol === 'https:';
    return {
        action: base.action,
        type: 'android',
        secure,
        hostname: location.hostname,
        port: location.port ? parseInt(location.port, 10) : secure ? 443 : 80,
        pathname: location.pathname,
    };
}

/**
 * What the Android stream is started with. A link names the phone only; the player and the
 * socket are found here, once, from what this browser can play and the server the link points
 * at. Both are the same on every render, so the stream is not started a second time when the
 * list arrives. `player` and `ws` in the link override them.
 */
function androidStream(params: URLSearchParams) {
    const query = clientParams(params, 'android');
    if (!query.get('player')) {
        const players = StreamClientScrcpy.getPlayers();
        const player = players.find((candidate) => candidate.playerCodeName === 'webcodecs') ?? players[0];
        query.set('player', player?.playerCodeName ?? 'webcodecs');
    }
    if (!query.get('ws')) {
        query.set('ws', streamSocketUrl(query.get('udid') || '', streamHost(query)));
    }
    return StreamClientScrcpy.parseParameters(query);
}

/** A screen link for a phone that is not in the list and that this browser has never opened. */
function PhoneNotListed({ udid }: { udid: string }) {
    useLayoutEffect(() => {
        // Clears the class the list or a stream left on the body.
        document.body.className = '';
    }, []);
    return (
        <main class="tool-unavailable">
            {/* A name the page saw earlier, else the serial. */}
            <AppBar title={phoneName(udid)} />
            <section class="tool-unavailable-body" role="status">
                <h2>This phone is not connected</h2>
                <p>It is not in the list of phones. This page shows its screen when it is connected.</p>
                <div class="tool-unavailable-actions">
                    <Button onClick={goUp}>{LIST_PAGE_NAME}</Button>
                </div>
            </section>
        </main>
    );
}

/**
 * One phone's page: its screen and, for an Android phone, Files and Shell as tabs beside it.
 *
 * The stream view is mounted only while the Screen tab is shown, so leaving it for another tab
 * stops the stream at once. Files and Shell are each mounted the first time their tab is shown
 * and then stay, hidden, until the page is left for another phone, the list or Notifications:
 * a shell session and a Files folder survive a look at another tab.
 *
 * The address names the phone, not its platform. The list says which screen to open; before the
 * list arrives, what this browser remembers of the phone does. A phone that is in neither is
 * waited for, so no stream is started for the wrong kind of phone and then started again.
 */
export function DevicePage({ params }: { params: URLSearchParams }) {
    const page = parseRoute(params);
    const udid = page.page === 'device' ? page.udid : '';
    const view = page.page === 'device' ? page.view : 'screen';
    const entry = findDeviceByUdid(udid);
    const listed = entry?.params.type;
    const name = entry ? deviceName(entry) : undefined;
    // Decided once for each phone the page shows: by the list, or before the list arrives by
    // what this browser remembers. The page then stays that kind of screen, whatever the list
    // says later, so one visit never starts a second stream. What is remembered is corrected
    // below for the next visit.
    const known = useRef<{ udid: string; platform: Platform }>();
    if (known.current?.udid !== udid) {
        known.current = undefined;
    }
    const platform = known.current?.platform ?? listed ?? rememberedPhone(udid)?.platform;
    if (platform) {
        known.current = { udid, platform };
    }
    useEffect(() => {
        if (listed) {
            rememberPhone(udid, listed, name);
        }
    }, [udid, listed, name]);

    const identified = view !== 'screen' || !!platform;
    const [waitedFor, setWaitedFor] = useState('');
    useEffect(() => {
        if (identified) {
            return;
        }
        const timer = setTimeout(() => setWaitedFor(udid), IDENTIFY_MS);
        return () => clearTimeout(timer);
    }, [udid, identified]);

    // The same objects until the address changes: the views compare the fields they start a
    // stream or a tool from, and a list update re-renders this page many times a minute.
    const android = useMemo(
        () => (view === 'screen' && platform === 'android' ? androidStream(params) : undefined),
        [params, view, platform],
    );
    const ios = useMemo(
        () =>
            view === 'screen' && platform === 'ios'
                ? StreamClientCoreDevice.parseParameters(clientParams(params, 'ios'))
                : undefined,
        [params, view, platform],
    );

    // The tools that have been shown on this page, each with the address it was last shown
    // with. Another phone, or the same serial on another server, is another page: its key
    // changes below and the tools of the page before stop.
    const pageKey = [udid, ...HOST_KEYS.map((key) => params.get(key))].join('\n');
    const tools = useRef<{ page: string; shown: Partial<Record<DeviceView, URLSearchParams>> }>();
    if (tools.current?.page !== pageKey) {
        tools.current = { page: pageKey, shown: {} };
    }
    const shown = tools.current.shown;
    if (view !== 'screen') {
        const next = clientParams(params);
        if (shown[view]?.toString() !== next.toString()) {
            shown[view] = next;
        }
    }

    // A tab change replaces the history entry, so one Back from any tab leads to the list. The
    // link names the phone and the view. What else the address says stays with the page (a
    // server it names, a player chosen for this visit), except the socket and the folder:
    // Files opens in its first folder, and once it is mounted the link names none, so Files
    // stays where it was left.
    const selectTab = (next: DeviceView) => {
        if (next === view) {
            return;
        }
        const extra: Record<string, string> = {};
        params.forEach((value, key) => {
            if (!TAB_DROPS.includes(key)) {
                extra[key] = value;
            }
        });
        if (next === 'files' && !shown.files) {
            extra.path = DEFAULT_FILES_PATH;
        }
        switchRoute(deviceRoute(udid, next, extra));
    };
    // Files and Shell run over adb, so a tool's page is an Android phone's until the list says
    // otherwise (`ToolRoute` refuses an iPhone).
    const tabList = useMemo(() => phoneTabs(platform ?? 'android'), [platform]);
    const tabs =
        tabList.length > 1 ? <TabStrip label="Phone views" tabs={tabList} current={view} onSelect={selectTab} /> : null;

    return (
        <>
            {/* One screen view, with the adapter of the phone's platform. Each platform keeps its
                own place among the children, so a view never changes its adapter (its hooks). */}
            {android && <ScreenView platform="android" params={android} useScreen={useAndroidScreen} tabs={tabs} />}
            {ios && <ScreenView platform="ios" params={ios} useScreen={useIphoneScreen} tabs={tabs} />}
            {view === 'screen' &&
                !android &&
                !ios &&
                (waitedFor === udid ? (
                    <PhoneNotListed udid={udid} />
                ) : (
                    <main class="tool-unavailable" aria-busy="true" />
                ))}
            {deviceTools.map(({ view: tool }) => {
                const toolParams = shown[tool];
                return toolParams ? (
                    <ToolRoute key={`${pageKey}\n${tool}`} params={toolParams} active={view === tool} tabs={tabs} />
                ) : null;
            })}
        </>
    );
}
