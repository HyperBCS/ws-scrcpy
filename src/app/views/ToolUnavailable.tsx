import { useLayoutEffect } from 'preact/hooks';
import { ACTION } from '../../common/Action';
import { canOpenScreen, DeviceEntry, deviceName } from '../state/devices';
import { buildLinkHref } from '../state/links';
import { goUp } from '../state/router';
import { LIST_PAGE_NAME } from '../state/routes';
import { AppBar } from '../ui/AppBar';
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
            <AppBar title={name} />
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
                    <button type="button" class="ui-button" onClick={goUp}>
                        {LIST_PAGE_NAME}
                    </button>
                </div>
            </section>
        </main>
    );
}
