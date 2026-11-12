import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Button } from '../../ui/Button';
import { SheetGroup, SheetRow, SheetStatus } from '../../ui/SheetControls';
import { toolsSheetOpen } from '../../state/stream';
import { MOUSE_CONTRACT } from '../../input/mouseContract';
import type { ActionsAdapter, PanelAction, Started } from './adapter';
import { GROUP, mouseHelp, ROW } from './actionRows';
import { runAction, TrackRequest } from './useStreamRequests';

export interface ScreenState {
    note: string;
    /** Starts an action and reports it under the group. */
    run: (start: () => Started, notes: { sending?: string; sent: string }) => void;
    /** The Mouse and keyboard row shows its lines. */
    mouseHelpShown: boolean;
    toggleMouseHelp: () => void;
}

/** The outcome line of the Screen group, which a new stream client clears. */
export function useScreen(adapter: ActionsAdapter, track: TrackRequest): ScreenState {
    const [note, setNote] = useState('');
    const [mouseHelpShown, setMouseHelpShown] = useState(false);
    useEffect(() => setNote(''), [adapter.sessionKey]);
    return {
        note,
        run: (start, notes) => runAction(start(), notes, setNote, track),
        mouseHelpShown,
        toggleMouseHelp: () => setMouseHelpShown(!mouseHelpShown),
    };
}

interface ScreenGroupProps {
    adapter: ActionsAdapter;
    state: ScreenState;
    connected: boolean;
    /** Notifications, Quick settings and Collapse. */
    panels: boolean;
    rotate: boolean;
    /** Refresh picture, Restart video and Reconnect. */
    pictureRecovery: boolean;
}

const PANELS: { action: PanelAction; row: { title: string; button: string } }[] = [
    { action: 'notifications', row: ROW.notifications },
    { action: 'quickSettings', row: ROW.quickSettings },
    { action: 'collapse', row: ROW.collapsePanels },
];

/**
 * What the phone's screen shows: its panels, its orientation, and the picture and session when
 * they go wrong. A panel opens on the phone, so the sheet closes to show it. The last row says
 * what the mouse does on the picture of this phone.
 */
export function ScreenGroup({ adapter, state, connected, panels, rotate, pictureRecovery }: ScreenGroupProps) {
    const { note, run } = state;
    const { panel, rotate: rotateTo, refreshPicture, restartVideo, reconnect } = adapter.screen;

    return (
        <SheetGroup title={GROUP.screen} status={note && <SheetStatus>{note}</SheetStatus>}>
            {panels &&
                panel &&
                PANELS.map(({ action, row }) => (
                    <SheetRow key={action} title={row.title}>
                        <Button
                            size="compact"
                            disabled={!connected}
                            onClick={() => {
                                panel(action);
                                toolsSheetOpen.value = false;
                            }}
                        >
                            {row.button}
                        </Button>
                    </SheetRow>
                ))}
            {rotate && rotateTo && (
                <SheetRow title={ROW.rotate.title} description={ROW.rotate.description} layout="pair">
                    <Button
                        size="compact"
                        onClick={() => run(() => rotateTo('left'), ROW.rotate)}
                        disabled={!connected}
                    >
                        {ROW.rotate.left}
                    </Button>
                    <Button
                        size="compact"
                        onClick={() => run(() => rotateTo('right'), ROW.rotate)}
                        disabled={!connected}
                    >
                        {ROW.rotate.right}
                    </Button>
                </SheetRow>
            )}
            {pictureRecovery && refreshPicture && (
                <SheetRow title={ROW.refreshPicture.title} description={ROW.refreshPicture.description}>
                    <Button
                        size="compact"
                        onClick={() => run(refreshPicture, ROW.refreshPicture)}
                        disabled={!connected}
                    >
                        {ROW.refreshPicture.button}
                    </Button>
                </SheetRow>
            )}
            {/* As before, Restart video and Reconnect can be pressed while the stream is down. */}
            {pictureRecovery && restartVideo && (
                <SheetRow title={ROW.restartVideo.title} description={ROW.restartVideo.description}>
                    <Button size="compact" onClick={() => run(restartVideo, ROW.restartVideo)}>
                        {ROW.restartVideo.button}
                    </Button>
                </SheetRow>
            )}
            {pictureRecovery && reconnect && (
                <SheetRow title={ROW.reconnect.title} description={ROW.reconnect.description}>
                    <Button size="compact" onClick={() => run(reconnect, ROW.reconnect)}>
                        {ROW.reconnect.button}
                    </Button>
                </SheetRow>
            )}
            <SheetRow
                title={ROW.mouse.title}
                description={
                    state.mouseHelpShown
                        ? mouseHelp(MOUSE_CONTRACT[adapter.platform]).map((line, index) => (
                              <Fragment key={line}>
                                  {index > 0 && <br />}
                                  {line}
                              </Fragment>
                          ))
                        : ROW.mouse.description
                }
                attributes={{ 'data-mouse-help': '' }}
            >
                <Button
                    size="compact"
                    attributes={{ 'aria-expanded': String(state.mouseHelpShown) }}
                    onClick={state.toggleMouseHelp}
                >
                    {state.mouseHelpShown ? ROW.mouse.hide : ROW.mouse.show}
                </Button>
            </SheetRow>
        </SheetGroup>
    );
}
