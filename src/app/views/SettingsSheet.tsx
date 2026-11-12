import { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Banner } from '../ui/Banner';
import { Sheet } from '../ui/Sheet';
import { closeSettingsSheet, settingsSheetTarget } from '../state/settingsSheet';
import { activeCoreDeviceStream, activeStream } from '../state/stream';
import { isDeviceAvailable, phoneName } from '../state/devices';
import { activeAudioSession } from '../state/audio';
import { capabilities } from '../state/capabilities';
import { route, switchRoute } from '../state/router';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { useRetainedTarget } from './settings/useRetainedTarget';
import { settingsPhone } from './settings/phone';
import { focusSection, sectionsFor } from './settings/sections';
import { useStreamChanges } from './settings/streamChanges';
import { StreamSection } from './settings/StreamSection';
import { SoundSection } from './settings/SoundSection';
import { KeyboardSection } from './settings/KeyboardSection';
import { UnlockSection } from './settings/UnlockSection';
import { AboutSection } from './settings/AboutSection';
import '../../style/views/SettingsSheet.css';

/**
 * The content of the sheet as a component child. `Sheet` renders itself again as it opens and
 * closes, and Preact keeps an element child it is given as it was, with links to the parents it
 * had before. An id that `useId` makes below it afterwards (a confirm prompt in a section) then
 * starts again at P0-0, the id of the sheet's title, and the prompt is named wrongly. The links of
 * a component child are renewed.
 */
function SheetContent({ children }: { children: ComponentChildren }) {
    return <>{children}</>;
}

/**
 * The one Settings sheet, for a phone of either kind and in any state. Its sections come in one
 * order: Stream, Sound, Keyboard, Unlock, About and troubleshooting, and a platform leaves out
 * only a section it has nothing for (`settings/sections.ts`). It is mounted once, in `App`, and
 * opens for a serial from the list or from the screen (`state/settingsSheet.ts`). Every control
 * applies when it is changed. Rows that need the phone or its open screen say why they are off.
 */
export function SettingsSheet() {
    const target = settingsSheetTarget.value;
    const body = useRef<HTMLDivElement>(null);
    // Kept through the closing animation, and let go once it has played. Each opening gets a
    // fresh request.
    const shown = useRetainedTarget(target, body);
    const androidStream = activeStream.value;
    const iosStream = activeCoreDeviceStream.value;
    const { entry, platform } = shown
        ? settingsPhone(shown, androidStream?.params, iosStream?.params.udid)
        : { entry: undefined, platform: undefined };
    const udid = shown?.udid ?? '';
    const name = phoneName(udid, entry);
    const can = platform ? capabilities(platform) : undefined;
    const connected = !!entry && isDeviceAvailable(entry);
    const android = platform === 'android' && androidStream?.params.udid === udid ? androidStream.client : undefined;
    const ios = platform === 'ios' && iosStream?.params.udid === udid ? iosStream.client : undefined;
    const screenOpen = !!(android || ios);
    const changes = useStreamChanges({
        opening: platform === 'android' ? target : undefined,
        tracker: target ? entry?.tracker : undefined,
        udid: shown?.udid,
        connected,
        client: android,
        name,
    });
    const applying = changes.config.applying;

    // Opened at a section: its heading is brought to the top and takes focus.
    useEffect(() => {
        const node = body.current;
        if (target?.section && node) {
            focusSection(node, target.section);
        }
    }, [target]);

    if (!shown) {
        return (
            <Sheet open={false} onClose={closeSettingsSheet} title="Settings" dock>
                {null}
            </Sheet>
        );
    }

    const descriptor = entry?.params.type === 'android' ? (entry.descriptor as GoogDeviceDescriptor) : undefined;
    const sdkInt = descriptor ? parseInt(descriptor['ro.build.version.sdk'], 10) : NaN;
    const sections = sectionsFor(can);
    const onPlayerChange = (player: string) => {
        if (!android) {
            return;
        }
        // The same page with another player: the entry is replaced, so Back does not lead to
        // the stream under the player before.
        const next = new URLSearchParams(route.value);
        next.set('player', player);
        next.set('captureKeyboard', String(android.isKeyboardCaptured()));
        closeSettingsSheet();
        switchRoute(next);
    };

    return (
        <Sheet
            open={!!target}
            // A change being applied keeps the sheet open, so its outcome is seen.
            dismissible={!applying}
            onClose={() => {
                if (!applying) {
                    closeSettingsSheet();
                }
            }}
            title="Settings"
            subtitle={name}
            // Beside the picture from 1024px when it opens from a phone's screen; from the list,
            // the centred dialog.
            dock
        >
            <SheetContent>
                <div class="settings" ref={body} data-platform={platform}>
                    {!entry ? (
                        <Banner>Waiting for the phone…</Banner>
                    ) : (
                        !connected && (
                            <Banner>
                                {platform === 'ios'
                                    ? 'The phone is not connected. Changes are kept on the server and apply when it is back.'
                                    : 'The phone is not connected. Settings that need it are off until it is back.'}
                            </Banner>
                        )
                    )}
                    {platform &&
                        sections.map((section) => {
                            switch (section) {
                                case 'stream':
                                    return (
                                        <StreamSection
                                            key={section}
                                            changes={changes}
                                            client={android}
                                            opening={target}
                                            player={androidStream?.params.player}
                                            disabled={applying}
                                            onPlayerChange={onPlayerChange}
                                        />
                                    );
                                case 'sound':
                                    return (
                                        <SoundSection
                                            key={section}
                                            changes={platform === 'android' ? changes : undefined}
                                            sdkInt={sdkInt}
                                            audioSession={screenOpen ? activeAudioSession.value : undefined}
                                            screenOpen={screenOpen}
                                        />
                                    );
                                case 'keyboard':
                                    return (
                                        <KeyboardSection
                                            key={section}
                                            platform={platform}
                                            android={android}
                                            ios={ios}
                                            opening={target}
                                        />
                                    );
                                case 'unlock':
                                    return (
                                        <UnlockSection
                                            key={section}
                                            platform={platform}
                                            udid={udid}
                                            entry={entry}
                                            opening={target}
                                            name={name}
                                        />
                                    );
                                case 'about':
                                    return null;
                            }
                        })}
                    {/* Last, and for a phone of either kind or of a kind not known yet. */}
                    <AboutSection
                        platform={platform}
                        udid={udid}
                        entry={entry}
                        name={name}
                        opening={target}
                        screenOpen={screenOpen}
                        iosClient={ios}
                    />
                </div>
            </SheetContent>
        </Sheet>
    );
}
