import { useLayoutEffect } from 'preact/hooks';
import { ACTION } from '../../common/Action';
import { canOpenScreen, DeviceEntry, deviceName } from '../state/devices';
import { buildLinkHref } from '../state/links';
import { goToDeviceList } from '../state/router';
import '../../style/views/StreamView.css';
import '../../style/views/ToolUnavailable.css';

/**
 * Shown for a Files or Shell link that names an iPhone. Both tools run over adb, so opening one
 * for an iPhone could only fail; the page says so and offers the screen.
 */
export function ToolUnavailable({ entry, tool }: { entry: DeviceEntry; tool: string }) {
    useLayoutEffect(() => {
        // Clears the class the list or a stream left on the body.
        document.body.className = '';
    }, []);
    const name = deviceName(entry);
    return (
        <main class="tool-unavailable">
            <header class="stream-header">
                <button
                    type="button"
                    class="stream-header-back"
                    onClick={goToDeviceList}
                    aria-label="Back to devices"
                    title="Back to devices"
                >
                    <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path d="m15 6-6 6 6 6" />
                    </svg>
                </button>
                <div class="stream-header-device">
                    <strong title={name}>{name}</strong>
                </div>
            </header>
            <section class="tool-unavailable-body" role="alert">
                <h2>{tool} is not available for this device</h2>
                <p>Files and Shell work on Android devices only. {name} is an iPhone or iPad.</p>
                <div class="tool-unavailable-actions">
                    {canOpenScreen(entry) && (
                        <a
                            class="ui-button ui-button-primary"
                            href={buildLinkHref(
                                { action: ACTION.STREAM_COREDEVICE, udid: entry.descriptor.udid },
                                entry.params,
                            )}
                        >
                            Open screen
                        </a>
                    )}
                    <button type="button" class="ui-button" onClick={goToDeviceList}>
                        Back to devices
                    </button>
                </div>
            </section>
        </main>
    );
}
