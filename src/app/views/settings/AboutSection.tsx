import { useRef } from 'preact/hooks';
import { Button } from '../../ui/Button';
import { SheetRow } from '../../ui/SheetControls';
import { DeviceEntry, isDeviceAvailable } from '../../state/devices';
import type { Platform } from '../../state/routes';
import {
    connectionStatus,
    getDeviceStatusInfo,
    getStreamServiceStatus,
    hasRunningStreamService,
    isDeviceStarting,
    lockFact,
    markStarting,
    onOffFact,
    screenFact,
    sessionFact,
    yesNoFact,
} from '../../state/phoneStatus';
import { streamConnected } from '../../state/stream';
import { closeSettingsSheet } from '../../state/settingsSheet';
import { deviceHref, followLink, isLocalLink } from '../../state/links';
import { replyText, sendServiceCommand } from '../../client/trackerCommand';
import { FACT, STREAM_SERVICE } from '../../copy';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { StreamClientScrcpy } from '../../googDevice/client/StreamClientScrcpy';
import type { StreamClientCoreDevice, DecoderKind } from '../../applDevice/client/StreamClientCoreDevice';
import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import type ApplDeviceDescriptor from '../../../types/ApplDeviceDescriptor';
import { SettingsGroup, SettingsSection } from './Section';
import { ServiceRow, ServiceRows } from './ServiceRows';
import { NOT_CONNECTED } from './streamChanges';

const DECODER: Record<DecoderKind, string> = { hevc: 'HEVC', mse: 'MSE' };

/** A fact shown as its value at the end of the row, or under its name where it may be long. */
function Fact({ name, title, value, long }: { name: string; title: string; value: string; long?: boolean }) {
    return long ? (
        <SheetRow title={title} description={value} attributes={{ 'data-fact': name }} />
    ) : (
        <SheetRow title={title} attributes={{ 'data-fact': name }}>
            <span class="kit-row-value">{value}</span>
        </SheetRow>
    );
}

/** A sentence from a state word: 'Running' becomes 'Running.', 'Starting…' stays as it is. */
function sentence(word: string, rest = ''): string {
    return `${word}${word.endsWith('…') ? '' : '.'}${rest ? ` ${rest}` : ''}`;
}

function androidServices(entry: DeviceEntry, name: string, connected: boolean): ServiceRow[] {
    const descriptor = entry.descriptor as GoogDeviceDescriptor;
    const running = hasRunningStreamService(descriptor.pid);
    const starting = !running && isDeviceStarting(entry.key);
    const service = getStreamServiceStatus(descriptor, starting);
    return [
        {
            id: 'stream-service',
            title: STREAM_SERVICE.name,
            description: sentence(
                service.label,
                running
                    ? 'Stopping it ends the stream for every viewer.'
                    : starting
                      ? ''
                      : connected
                        ? 'It starts when the screen is opened.'
                        : '',
            ),
            label: running ? 'Stop' : starting ? 'Starting…' : 'Start',
            ariaLabel: running ? 'Stop stream service' : 'Start stream service',
            variant: running ? 'danger' : 'secondary',
            disabled: !connected || starting,
            confirm: running
                ? {
                      question: `Stop the stream service on ${name}?`,
                      consequence: 'The stream ends for every viewer until the service is started again.',
                      confirmLabel: 'Stop stream service',
                  }
                : undefined,
            // The server answers these with a device update, not a reply.
            run: () => {
                if (!running) {
                    markStarting(entry.key);
                }
                entry.tracker.sendCommand(
                    running ? ControlCenterCommand.KILL_SERVER : ControlCenterCommand.START_SERVER,
                    {
                        udid: descriptor.udid,
                        pid: running ? descriptor.pid : undefined,
                    },
                );
            },
        },
    ];
}

/**
 * `screenOpen`: this browser shows the iPhone's screen. That screen connects again as soon as the
 * session stops, which starts a new session and counts as a start, so Stop is off there and is
 * used from the list. Restart services stays: a new session is what it is for.
 */
function iosServices(entry: DeviceEntry, name: string, connected: boolean, screenOpen: boolean): ServiceRow[] {
    const descriptor = entry.descriptor as ApplDeviceDescriptor;
    const udid = descriptor.udid;
    const session = descriptor.session ?? 'stopped';
    const canStop = connected && (session === 'ready' || session === 'starting');
    const command = (type: string, done: string) => (signal: AbortSignal) =>
        sendServiceCommand(entry.tracker, type, udid, signal).then((result) => replyText(result, done));
    return [
        {
            id: 'stream-service',
            title: STREAM_SERVICE.name,
            description: sentence(
                sessionFact(session),
                canStop && screenOpen
                    ? 'This screen would start it again at once, so stop it from the list.'
                    : canStop
                      ? 'Stopping it ends the screen stream for every viewer.'
                      : connected
                        ? 'It starts when the screen is opened.'
                        : '',
            ),
            label: 'Stop',
            ariaLabel: 'Stop stream service',
            variant: 'danger',
            disabled: !canStop || screenOpen,
            confirm: {
                question: `Stop the stream service on ${name}?`,
                consequence: 'The screen stream ends for every viewer. Open the screen to start it again.',
                confirmLabel: 'Stop stream service',
            },
            // The server answers this with a device update, not a reply.
            run: () => {
                entry.tracker.sendCommand(ControlCenterCommand.KILL_SERVER, { udid, pid: 1 });
            },
        },
        {
            id: 'restart-services',
            title: 'Restart services',
            description:
                'Use if touch, keyboard or clipboard stop responding. Ends the phone session for every viewer.',
            label: 'Restart services',
            variant: 'danger',
            disabled: !connected,
            confirm: {
                question: `Restart services on ${name}?`,
                consequence: 'The phone session ends for every viewer. The next viewer gets a new one.',
                confirmLabel: 'Restart services',
            },
            running: 'Restarting services…',
            run: command(ControlCenterCommand.RESTART_SESSION, 'Services restarted. Open the screen again.'),
        },
        {
            id: 'remount',
            title: 'Remount developer image',
            description: 'Use if the screen will not start. Ends the phone session first.',
            label: 'Remount',
            ariaLabel: 'Remount developer image',
            variant: 'danger',
            disabled: !connected,
            confirm: {
                question: `Remount the developer image on ${name}?`,
                consequence: 'The phone session ends for every viewer while the image is reloaded.',
                confirmLabel: 'Remount',
            },
            running: 'Remounting the developer image…',
            run: command(ControlCenterCommand.REMOUNT_DDI, 'Developer image mounted. Open the screen again.'),
        },
        {
            id: 'refresh',
            title: 'Refresh info',
            description: 'Check pairing and Developer Mode.',
            label: 'Refresh',
            disabled: !connected,
            running: 'Refreshing…',
            run: command(ControlCenterCommand.REFRESH_DEVICE, 'Phone info refreshed.'),
        },
    ];
}

/**
 * Links that open the screen with another player, for a picture the default player cannot show.
 * They need the phone, and say so while it is not connected.
 */
function OtherPlayers({ entry, connected }: { entry: DeviceEntry; connected: boolean }) {
    const players = StreamClientScrcpy.getPlayers();
    const primary = players.find((player) => player.playerCodeName === 'webcodecs') ?? players[0];
    const others = players.filter((player) => player !== primary);
    if (!others.length) {
        return null;
    }
    const local = isLocalLink(entry.params);
    return (
        <SettingsGroup class="settings-players">
            <SheetRow
                title="Open with another player"
                description={connected ? 'For a picture this browser does not show.' : NOT_CONNECTED}
                layout="stack"
            >
                {others.map((player) => {
                    const href = deviceHref(entry.descriptor.udid, 'screen', entry.params, {
                        player: player.playerCodeName,
                    });
                    return (
                        <Button
                            key={player.playerCodeName}
                            href={href}
                            disabled={!connected}
                            class="settings-player-link"
                            attributes={{
                                target: local ? undefined : '_blank',
                                rel: local ? undefined : 'noopener noreferrer',
                            }}
                            onClick={(event) => {
                                if (
                                    !local ||
                                    event.button !== 0 ||
                                    event.ctrlKey ||
                                    event.metaKey ||
                                    event.shiftKey ||
                                    event.altKey
                                ) {
                                    return;
                                }
                                event.preventDefault();
                                closeSettingsSheet();
                                followLink(href, 'open');
                            }}
                        >
                            {`Open with ${player.playerFullName}`}
                        </Button>
                    );
                })}
            </SheetRow>
        </SettingsGroup>
    );
}

interface AboutSectionProps {
    platform?: Platform;
    udid: string;
    entry?: DeviceEntry;
    name: string;
    opening?: object;
    /** This phone's screen is open in this browser. */
    screenOpen: boolean;
    /** The open screen of an iPhone, for its decoder. */
    iosClient?: StreamClientCoreDevice;
}

/**
 * About and troubleshooting: what is known of the phone, in the status words of `copy.ts`, and
 * its service actions. It replaces the Details of a list card and the Troubleshooting of the
 * iPhone Actions sheet, so it is there for a phone in any state.
 */
export function AboutSection({ platform, udid, entry, name, opening, screenOpen, iosClient }: AboutSectionProps) {
    const connected = !!entry && isDeviceAvailable(entry);
    const status = entry && getDeviceStatusInfo(entry);
    const connection = connectionStatus(
        !connected ? 'offline' : screenOpen ? (streamConnected.value ? 'connected' : 'reconnecting') : 'connected',
    );
    const android = entry?.params.type === 'android' ? (entry.descriptor as GoogDeviceDescriptor) : undefined;
    const ios = entry?.params.type === 'ios' ? (entry.descriptor as ApplDeviceDescriptor) : undefined;
    const model = android
        ? [android['ro.product.manufacturer'], android['ro.product.model']].filter(Boolean).join(' ')
        : ios?.model;
    const version = android ? android['ro.build.version.release'] : ios?.version;
    // The phone as last listed in this opening of the sheet. The list is empty for a moment when
    // its socket drops: the service rows stay, off until the phone is listed again, so the outcome
    // of a command that was out when the socket dropped is still shown under them.
    const last = useRef<{ opening?: object; entry?: DeviceEntry }>({});
    if (last.current.opening !== opening) {
        last.current = { opening };
    }
    if (entry) {
        last.current.entry = entry;
    }
    const known = entry ?? last.current.entry;
    const rows = !known
        ? []
        : known.params.type === 'android'
          ? androidServices(known, name, connected)
          : iosServices(known, name, connected, screenOpen);
    return (
        <SettingsSection name="about">
            <SettingsGroup title="Phone" class="settings-facts">
                {status && <Fact name="status" title="Status" value={status.label} />}
                {entry && <Fact name="model" title="Model" value={model || FACT.unknown} long />}
                {entry && (
                    <Fact
                        name="system"
                        title={platform === 'ios' ? 'iOS' : 'Android'}
                        value={version || FACT.unknown}
                    />
                )}
                <Fact name="serial" title="Serial" value={udid} long />
                {entry && <Fact name="connection" title="Connection" value={connection.label} />}
                {status && <Fact name="screen" title="Screen" value={screenFact(status.screen)} />}
                {status && <Fact name="lock" title="Lock" value={lockFact(status.lock)} />}
                {ios && <Fact name="session" title="Session" value={sessionFact(ios.session)} />}
                {ios && <Fact name="paired" title="Paired" value={yesNoFact(ios.paired !== false)} />}
                {ios && <Fact name="developer-mode" title="Developer Mode" value={onOffFact(ios.developerMode)} />}
                {iosClient && (
                    <Fact
                        name="decoder"
                        title="Decoder"
                        value={
                            (iosClient.getDecoderKind() && DECODER[iosClient.getDecoderKind() as DecoderKind]) ||
                            FACT.unknown
                        }
                    />
                )}
            </SettingsGroup>
            {rows.length > 0 && (
                <ServiceRows rows={rows} opening={opening} unavailable={connected ? undefined : NOT_CONNECTED} />
            )}
            {/* With the screen open, Playback under Stream changes the player. */}
            {entry && android && !screenOpen && <OtherPlayers entry={entry} connected={connected} />}
        </SettingsSection>
    );
}
