import { ComponentChildren, RefObject } from 'preact';
import { useRef } from 'preact/hooks';
import { openSheet, streamNotice } from '../state/stream';
import type { ConnectionStatus } from '../state/phoneStatus';
import { NotificationsLink } from '../ui/NotificationsLink';
import { AppBar, AppBarStatus } from '../ui/AppBar';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { Presence } from '../ui/Presence';
import { LockScreenNotice } from './LockScreenNotice';
import { ScreenProblem, StateCard } from './screen/StateCard';
import '../../style/kit/Banner.css';
import '../../style/views/StreamView.css';

/** A lock fact as the phone reports it: true, false, or 'unknown' where it does not say. */
type LockValue = boolean | 'unknown';

/** What the page of one kind of phone shows, as its adapter reports it on each render. */
export interface ScreenModel {
    /** The phone's name, also once it has left the list (`phoneName`). */
    name: string;
    /** The one connection value of the page: the header line and the state card print it. */
    connection: ConnectionStatus;
    /** A second line under the connection, only while there is something to say. */
    service?: ComponentChildren;
    /** The bell opens this iPhone's inbox. Without it, it opens Notifications. */
    inbox?: string;
    /** The stream client is mounted for this phone. Switch and the controls need it. */
    mounted: boolean;
    /** The picture is up. */
    connected: boolean;
    /** The raw lock values. The lock notice and the Unlock sheets need them. */
    locked: LockValue;
    keyguardShowing: LockValue;
    /** From the status model, as on the card: only on positive evidence. */
    screenOff: boolean;
    /** The listed phone has not trusted this computer. */
    unauthorized: boolean;
    /** The progress of a first start, in the words of the phone's service. */
    progress?: string;
    /** Why there is no picture, when the page knows. Its card wins over every other. */
    problem?: ScreenProblem;
    /** The mounted stream client. The state card's optimistic Wake resets when it changes. */
    sessionKey: unknown;
    wake: () => void;
    /** The controls of the stage, while the client is mounted. */
    controls?: ComponentChildren;
    /** The sheets of the page, while the client is mounted. */
    sheets?: ComponentChildren;
}

/**
 * The half of a phone's screen that differs by platform: it starts the stream client in `mount`,
 * follows its events and says what the page shows. It is a hook of `ScreenView`, so the effect
 * that starts the stream belongs to the one view. `screen/android.tsx`, `screen/iphone.tsx`.
 */
export type ScreenAdapter<P> = (params: P, mount: RefObject<HTMLDivElement>) => ScreenModel;

interface ScreenViewProps<P> {
    params: P;
    /** The adapter of the phone's platform. A view keeps the same one for its whole life. */
    useScreen: ScreenAdapter<P>;
    /** The tab strip of the phone's page, drawn under the header. */
    tabs?: ComponentChildren;
}

/**
 * The screen of a phone, the same for both kinds: the header, one place for banners under it,
 * the stage with the picture and its controls, and one card on the stage for each state without
 * a picture.
 */
export function ScreenView<P extends { udid: string }>({ params, useScreen, tabs }: ScreenViewProps<P>) {
    const mountRef = useRef<HTMLDivElement>(null);
    const screen = useScreen(params, mountRef);
    const { connection } = screen;

    return (
        <div class="stream-view">
            <AppBar
                title={screen.name}
                status={
                    <>
                        <AppBarStatus tone={connection.tone}>{connection.label}</AppBarStatus>
                        {screen.service}
                    </>
                }
            >
                <NotificationsLink compact udid={screen.inbox} />
                <Button size="compact" onClick={() => openSheet('devices')} disabled={!screen.mounted}>
                    Switch
                </Button>
            </AppBar>
            {tabs}
            {/* The one place for messages about the screen, in this order: the lock notice, the
                progress of a first start and the stream notice. It is part of the layout, so a
                message takes its height from the stage and never lies over the picture. While
                the screen is asleep the card on the stage says so and the lock notice waits. */}
            <div key="banners" class="stream-banners">
                <LockScreenNotice
                    key="lock-notice"
                    udid={params.udid}
                    connected={screen.connected && !screen.screenOff}
                    locked={screen.locked}
                    keyguardShowing={screen.keyguardShowing}
                    onUnlock={() => openSheet('unlock')}
                />
                <Presence
                    key="progress"
                    show={!!screen.progress}
                    kind="collapse"
                    class="kit-banner kit-banner-info stream-notice"
                    role="status"
                >
                    <Icon name="info" size={16} />
                    <span class="kit-banner-text">{screen.progress}</span>
                </Presence>
                <Presence
                    key="notice"
                    show={!!streamNotice.value}
                    kind="collapse"
                    class="kit-banner stream-notice"
                    role="status"
                >
                    <Icon name="warning" size={16} />
                    <span class="kit-banner-text">{streamNotice.value}</span>
                    <IconButton
                        icon="close"
                        label="Dismiss message"
                        variant="bare"
                        size="compact"
                        onClick={() => (streamNotice.value = '')}
                    />
                </Presence>
            </div>
            {/* The stream client owns everything inside the mount node (see the adapters). The
                node is made once, keeps its place and is never moved: the card and the controls
                are its siblings, and the sheets are outside the stage. The stage keeps its key, so
                a banner that comes or goes cannot make Preact build it again. */}
            <div key="stage" class="stream-stage">
                <div class="stream-mount" ref={mountRef} />
                <aside class="stream-controls-slot" aria-label="Phone controls">
                    {screen.controls}
                </aside>
                <StateCard
                    sessionKey={screen.sessionKey}
                    connection={connection}
                    mounted={screen.mounted}
                    connected={screen.connected}
                    problem={screen.problem}
                    unauthorized={screen.unauthorized}
                    screenOff={screen.screenOff}
                    onWake={screen.wake}
                />
            </div>
            {screen.sheets}
        </div>
    );
}
