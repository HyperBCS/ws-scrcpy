import type { ComponentChildren } from 'preact';
import type { ConnectionStatus } from '../state/phoneStatus';
import { openSheet } from '../state/stream';
import { KeyboardChip } from '../ui/KeyboardChip';
import { NotificationsLink } from '../ui/NotificationsLink';
import { AppBar, AppBarStatus } from '../ui/AppBar';
import { Button } from '../ui/Button';

interface PhoneHeaderProps {
    name: string;
    /** The connection of the view that is open: the screen's stream, or the tool's own socket. */
    connection?: ConnectionStatus;
    /** A class on the connection line, for a tool's own name of it. */
    connectionClass?: string;
    service?: ComponentChildren;
    inbox?: string;
    switchDisabled?: boolean;
    /** The screen owns keyboard capture; tool tabs keep their own keyboard target. */
    keyboard?: boolean;
}

/** The header of Screen, Files and Shell. It owns no stream, styles or phone lookup. */
export function PhoneHeader({
    name,
    connection,
    connectionClass,
    service,
    inbox,
    switchDisabled,
    keyboard,
}: PhoneHeaderProps) {
    return (
        <AppBar
            class={keyboard ? 'phone-header-keyboard' : undefined}
            title={name}
            status={
                <>
                    {connection && (
                        <AppBarStatus tone={connection.tone} class={connectionClass}>
                            {connection.label}
                        </AppBarStatus>
                    )}
                    {service}
                </>
            }
        >
            {keyboard && <KeyboardChip />}
            <NotificationsLink compact udid={inbox} />
            <Button size="compact" onClick={() => openSheet('devices')} disabled={switchDisabled}>
                Switch
            </Button>
        </AppBar>
    );
}
