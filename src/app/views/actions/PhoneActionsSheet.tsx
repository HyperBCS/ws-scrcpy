import { Banner } from '../../ui/Banner';
import { Button } from '../../ui/Button';
import { Sheet } from '../../ui/Sheet';
import { SheetGroup, SheetRow } from '../../ui/SheetControls';
import { actionCapabilities, capabilities } from '../../state/capabilities';
import { deviceName } from '../../state/devices';
import { getDeviceStatusInfo } from '../../state/phoneStatus';
import { closeAllSheets, streamConnected, toolsSheetOpen } from '../../state/stream';
import type { ActionsAdapter, PowerCommand } from './adapter';
import { ACTIONS_TITLE, NOTE, ROW } from './actionRows';
import { ClipboardGroup, useClipboard } from './ClipboardGroup';
import { LockGroup } from './LockGroup';
import { PowerGroup, usePower } from './PowerGroup';
import { ScreenGroup, useScreen } from './ScreenGroup';
import { useStreamRequests } from './useStreamRequests';
import '../../../style/views/ActionsSheet.css';

/**
 * The Actions sheet of both kinds of phone: one-shot actions in fixed groups, Clipboard, Screen,
 * Lock and Power, then the row that opens Settings. A group is left out when the platform has
 * nothing for it, and a row when `capabilities()` says the platform cannot do it. What the rows
 * send is the platform's own, through `adapter`. Values that persist (sound, keyboard) and the
 * facts and service rows are in Settings. The header's back control leaves the page.
 *
 * The state of every group is held here, above `Sheet`, and the group components only draw it.
 * A component inside a sheet's children that renders on its own can be left with a stale parent
 * in Preact, and `useId` under it then hands out ids that are already in use: the confirm prompt
 * took the sheet title's id and lost its name. Rendered from here, a new prompt or field always
 * hangs from the current tree.
 */
export function PhoneActionsSheet({ adapter }: { adapter: ActionsAdapter }) {
    const open = toolsSheetOpen.value;
    const connected = streamConnected.value;
    const caps = capabilities(adapter.platform);
    const extra = actionCapabilities(adapter.platform);
    const track = useStreamRequests(adapter, connected);
    const clipboard = useClipboard(adapter, caps.clipboardPaste, track);
    const screen = useScreen(adapter, track);
    const power = usePower(adapter, open);
    const entry = adapter.entry();
    const name = entry ? deviceName(entry) : undefined;
    const screenAsleep = !!entry && getDeviceStatusInfo(entry).screen === 'asleep';
    const hasSideButton = caps.power.some((action) => action === 'power-key' || action === 'side-button');
    const powerCommands = caps.power.filter(
        (action): action is PowerCommand => action === 'reboot' || action === 'shutdown',
    );

    return (
        <Sheet open={open} onClose={() => (toolsSheetOpen.value = false)} title={ACTIONS_TITLE} subtitle={name} dock>
            <div class="actions-sheet">
                {!connected && <Banner>{adapter.pausedReason?.() || NOTE.paused}</Banner>}

                <ClipboardGroup
                    state={clipboard}
                    connected={connected}
                    canRead={caps.clipboardRead}
                    canPaste={caps.clipboardPaste}
                    showTypeText={caps.typeText && !caps.clipboardPaste}
                />

                {(caps.panels || caps.rotate || extra.pictureRecovery) && (
                    <ScreenGroup
                        adapter={adapter}
                        state={screen}
                        connected={connected}
                        panels={caps.panels}
                        rotate={caps.rotate}
                        pictureRecovery={extra.pictureRecovery}
                    />
                )}

                <LockGroup
                    connected={connected}
                    unlock={caps.unlock}
                    sideButton={hasSideButton ? adapter.sideButton : undefined}
                    screenAsleep={screenAsleep}
                />

                {powerCommands.length > 0 && adapter.power && (
                    <PowerGroup state={power} commands={powerCommands} name={name || NOTE.unnamedPhone} />
                )}

                <SheetGroup>
                    <SheetRow title={ROW.settings.title}>
                        <Button
                            size="compact"
                            attributes={{ 'aria-label': ROW.settings.label }}
                            onClick={() => {
                                closeAllSheets();
                                adapter.openSettings();
                            }}
                        >
                            {ROW.settings.button}
                        </Button>
                    </SheetRow>
                </SheetGroup>
            </div>
        </Sheet>
    );
}
