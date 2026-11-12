import { Button } from '../../ui/Button';
import { SheetGroup, SheetRow } from '../../ui/SheetControls';
import type { UnlockKind } from '../../state/capabilities';
import { openSheet, toolsSheetOpen } from '../../state/stream';
import { GROUP, ROW } from './actionRows';

interface LockGroupProps {
    connected: boolean;
    unlock: UnlockKind;
    /** One short press of the side button, or `undefined` for a phone without one here. */
    sideButton?: () => void;
    /** The phone reports its screen asleep: a press of the side button would wake it. */
    screenAsleep: boolean;
}

/**
 * Unlock and Lock. Both rows are there whatever the lock state: the Unlock sheet says when the
 * phone reports itself unlocked. Lock presses the side button and closes the sheet, so the
 * screen can be seen going off.
 */
export function LockGroup({ connected, unlock, sideButton, screenAsleep }: LockGroupProps) {
    return (
        <SheetGroup title={GROUP.lock}>
            <SheetRow title={ROW.unlock.title} description={ROW.unlock.description[unlock]}>
                <Button size="compact" onClick={() => openSheet('unlock')} disabled={!connected}>
                    {ROW.unlock.button}
                </Button>
            </SheetRow>
            {sideButton && (
                <SheetRow title={ROW.lock.title} description={ROW.lock.description}>
                    <Button
                        size="compact"
                        disabled={!connected || screenAsleep}
                        onClick={() => {
                            sideButton();
                            toolsSheetOpen.value = false;
                        }}
                    >
                        {ROW.lock.button}
                    </Button>
                </SheetRow>
            )}
        </SheetGroup>
    );
}
