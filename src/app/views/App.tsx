import { useEffect } from 'preact/hooks';
import '../ui/viewport';
import { route } from '../state/router';
import { DeviceList } from './DeviceList';
import { StreamView } from './StreamView';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import { SettingsSheet } from './SettingsSheet';
import { startHostTracker } from '../state/hosts';
import { isToolAction, ToolView } from './ToolView';
import { CoreDeviceStreamView } from './CoreDeviceStreamView';
import { StreamClientCoreDevice } from '../applDevice/client/StreamClientCoreDevice';
import { ACTION } from '../../common/Action';

export function App() {
    // Started here, not in `DeviceList`: opening a stream deep link directly (or just reloading
    // one) never mounts the device list, so nothing connected the tracker and the device store
    // stayed empty. Everything that looks a device up by udid then silently did nothing --
    // the stream-settings button, the device switcher, and the sleep overlay's screen state.
    useEffect(() => {
        startHostTracker();
    }, []);

    const params = route.value;
    let view;

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
        view = <ToolView params={params} />;
    }

    if (!view) {
        view = <DeviceList />;
    }

    return (
        <>
            {view}
            {/* Mounted here rather than inside `StreamView` -- it is also reachable from a
                device-list card (`DeviceCard`) with no stream open at all, see
                `state/settingsSheet.ts`. */}
            <SettingsSheet />
        </>
    );
}
