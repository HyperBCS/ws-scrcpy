import { NotificationsView } from './NotificationsView';
import { useEffect, useLayoutEffect } from 'preact/hooks';
import '../ui/viewport';
import { route } from '../state/router';
import { devices } from '../state/devices';
import { pageTitle } from '../state/pageTitle';
import { ToolRoute } from './ToolRoute';
import { DeviceList } from './DeviceList';
import { StreamView } from './StreamView';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import { SettingsSheet } from './SettingsSheet';
import { ApplSettingsSheet } from './ApplSettingsSheet';
import { startHostTracker } from '../state/hosts';
import { isToolAction } from './ToolView';
import { CoreDeviceStreamView } from './CoreDeviceStreamView';
import { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';
import { ACTION } from '../../common/Action';
import { startNotificationSummary } from '../state/notifications';
import { ErrorBoundary, ScreenFailed } from '../ui/ErrorBoundary';
import { goToDeviceList } from '../state/router';
import { closeAllSheets } from '../state/stream';

/**
 * The one place a tab title is set; see `state/pageTitle.ts`. Its own component, so a device
 * update re-renders this and not the whole app.
 */
function PageTitle() {
    const title = pageTitle(route.value, devices.value.values());
    useLayoutEffect(() => {
        document.title = title;
    }, [title]);
    return null;
}

export function App() {
    // Started here, not in `DeviceList`: opening a stream deep link directly (or just reloading
    // one) never mounts the device list, so nothing connected the tracker and the device store
    // stayed empty. Everything that looks a device up by udid then silently did nothing --
    // the stream-settings button, the device switcher, and the sleep overlay's screen state.
    useEffect(() => {
        startHostTracker();
        return startNotificationSummary();
    }, []);

    const params = route.value;
    let view;
    if (params.get('action') === 'notifications') view = <NotificationsView />;

    if (params.get('action') === StreamClientScrcpy.ACTION && params.get('udid')) {
        try {
            view = <StreamView params={StreamClientScrcpy.parseParameters(params)} />;
        } catch (error) {
            console.error('[App]', error);
        }
    }

    if (!view && params.get('action') === ACTION.STREAM_COREDEVICE && params.get('udid')) {
        try {
            view = <CoreDeviceStreamView params={StreamClientCoreDevice.parseParameters(params)} />;
        } catch (error) {
            console.error('[App]', error);
        }
    }

    if (!view && isToolAction(params.get('action')) && params.get('udid')) {
        view = <ToolRoute params={params} />;
    }

    if (!view) {
        view = <DeviceList />;
    }

    // One failing view must not blank the app. The view and the sheets fail apart, so a broken
    // sheet leaves the screen behind it in use. Navigating away clears a failed view.
    const onDevices = !params.get('action');
    return (
        <>
            <PageTitle />
            <ErrorBoundary
                resetKey={params.toString()}
                fallback={(reset) => (
                    <ScreenFailed
                        onBack={() => {
                            goToDeviceList();
                            reset();
                        }}
                        backLabel={onDevices ? 'Try again' : 'Back to devices'}
                    />
                )}
            >
                {view}
            </ErrorBoundary>
            {/* Mounted here rather than inside `StreamView` -- it is also reachable from a
                device-list card (`DeviceCard`) with no stream open at all, see
                `state/settingsSheet.ts`. */}
            <ErrorBoundary
                fallback={(reset) => (
                    <div class="screen-failed notice" role="alert">
                        <h1>This panel failed</h1>
                        <div class="screen-failed-actions">
                            <button
                                type="button"
                                class="screen-failed-button primary"
                                onClick={() => location.reload()}
                            >
                                Reload
                            </button>
                            <button
                                type="button"
                                class="screen-failed-button"
                                onClick={() => {
                                    closeAllSheets();
                                    reset();
                                }}
                            >
                                Dismiss
                            </button>
                        </div>
                    </div>
                )}
            >
                <SettingsSheet />
                <ApplSettingsSheet />
            </ErrorBoundary>
        </>
    );
}
