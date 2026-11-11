import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import { BaseClient } from '../client/BaseClient';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import { streamSocketUrl } from '../googDevice/client/deviceInterfaces';
import { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';
import { deviceName, findDeviceByUdid } from '../state/devices';
import { goUp } from '../state/router';
import { clientParams, LIST_PAGE_NAME, parseRoute, Platform, rememberedPhone, rememberPhone } from '../state/routes';
import { AppBar } from '../ui/AppBar';
import { StreamView } from './StreamView';
import { CoreDeviceStreamView } from './CoreDeviceStreamView';
import { ToolRoute } from './ToolRoute';
import '../../style/views/ToolUnavailable.css';

/** How long a screen link for a phone this browser has not seen waits for the list. */
const IDENTIFY_MS = 1500;

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
        document.body.className = 'tool-page';
    }, []);
    return (
        <main class="tool-unavailable">
            <AppBar title={udid} />
            <section class="tool-unavailable-body" role="status">
                <h2>This phone is not connected</h2>
                <p>It is not in the list of phones. This page shows its screen when it is connected.</p>
                <div class="tool-unavailable-actions">
                    <button type="button" class="ui-button" onClick={goUp}>
                        {LIST_PAGE_NAME}
                    </button>
                </div>
            </section>
        </main>
    );
}

/**
 * One phone's page: its screen, its files or its shell. Exactly one of the three is mounted, so
 * leaving the screen for another view stops the stream at once.
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
    // The list decides. Once a screen is open it stays that kind of screen when the phone
    // drops out of the list.
    const known = useRef<{ udid: string; platform: Platform }>();
    if (known.current?.udid !== udid) {
        known.current = undefined;
    }
    const platform = listed ?? known.current?.platform ?? rememberedPhone(udid)?.platform;
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
    const tool = useMemo(() => (view === 'screen' ? undefined : clientParams(params)), [params, view]);

    if (tool) {
        return <ToolRoute params={tool} />;
    }
    if (android) {
        return <StreamView params={android} />;
    }
    if (ios) {
        return <CoreDeviceStreamView params={ios} />;
    }
    if (waitedFor === udid) {
        return <PhoneNotListed udid={udid} />;
    }
    return <main class="tool-unavailable" aria-busy="true" />;
}
