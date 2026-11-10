import { NotificationService } from './notifications/NotificationService';
import '../../LICENSE';
import * as readline from 'readline';
import { Config } from './Config';
import { HttpServer } from './services/HttpServer';
import { WebSocketServer } from './services/WebSocketServer';
import { Service, ServiceClass } from './services/Service';
import { MwFactory } from './mw/Mw';
import { RemoteWebsocketProxy } from './mw/RemoteWebsocketProxy';
import { HostTracker } from './mw/HostTracker';
import { WebsocketMultiplexer } from './mw/WebsocketMultiplexer';
import { startServices } from './services/startServices';
import { Shutdown } from './Shutdown';

const servicesToStart: ServiceClass[] = [HttpServer, WebSocketServer, NotificationService];

// MWs that accept WebSocket
const mwList: MwFactory[] = [RemoteWebsocketProxy, WebsocketMultiplexer];

// MWs that accept Multiplexer
const mw2List: MwFactory[] = [HostTracker];

const runningServices: Service[] = [];
const shutdown = new Shutdown(runningServices);
const loadPlatformModulesPromises: Promise<void>[] = [];

const config = Config.getInstance();

/// #if INCLUDE_GOOG
async function loadGoogModules() {
    const { ControlCenter } = await import('./goog-device/services/ControlCenter');
    const { DeviceTracker } = await import('./goog-device/mw/DeviceTracker');
    const { WebsocketProxyOverAdb } = await import('./goog-device/mw/WebsocketProxyOverAdb');

    if (config.runLocalGoogTracker) {
        mw2List.push(DeviceTracker);
        // Also expose the tracker as a plain-JSON WebSocket
        // (?action=goog-device-list) on the top-level server, in addition to the
        // binary multiplexer channel. This lets lightweight external clients read
        // the device list without implementing the multiplexer (GTRC) protocol.
        // DeviceTracker.processRequest only claims ACTION.GOOG_DEVICE_LIST, so
        // this is inert for any other action.
        mwList.push(DeviceTracker);
    }

    if (config.announceLocalGoogTracker) {
        HostTracker.registerLocalTracker(DeviceTracker);
    }

    servicesToStart.push(ControlCenter);

    /// #if INCLUDE_ADB_SHELL
    const { RemoteShell } = await import('./goog-device/mw/RemoteShell');
    mw2List.push(RemoteShell);
    /// #endif

    /// #if INCLUDE_FILE_LISTING
    const { FileListing } = await import('./goog-device/mw/FileListing');
    mw2List.push(FileListing);
    /// #endif

    mwList.push(WebsocketProxyOverAdb);
}
loadPlatformModulesPromises.push(loadGoogModules());
/// #endif

/// #if INCLUDE_APPL
async function loadApplModules() {
    const { ControlCenter } = await import('./appl-device/services/ControlCenter');
    const { DeviceTracker } = await import('./appl-device/mw/DeviceTracker');
    const { CoreDeviceProxy } = await import('./appl-device/mw/CoreDeviceProxy');
    const { CoreDeviceRunner } = await import('./appl-device/services/CoreDeviceRunner');
    const { DeviceState } = await import('../common/DeviceState');

    if (config.runLocalApplTracker) {
        mw2List.push(DeviceTracker);
        // Also expose the tracker as a plain-JSON WebSocket
        // (?action=appl-device-list) on the top-level server, in addition to the
        // binary multiplexer channel. This lets lightweight external clients read
        // the device list without implementing the multiplexer (GTRC) protocol.
        // DeviceTracker.processRequest only claims ACTION.APPL_DEVICE_LIST, so
        // this is inert for any other action.
        mwList.push(DeviceTracker);
    }

    if (config.announceLocalApplTracker) {
        HostTracker.registerLocalTracker(DeviceTracker);
    }

    servicesToStart.push(ControlCenter);
    // Owns every per-device `pymobiledevice3 ... display serve-web` child (the screen stream +
    // HID session) so they are all killed from the central exit() cleanup.
    servicesToStart.push(CoreDeviceRunner);
    // serve-web returns the phone's display sessions in its own shutdown; Node waits for it.
    shutdown.addWaiter({
        pending: () => CoreDeviceRunner.hasChildren(),
        closed: () => CoreDeviceRunner.childrenClosed(),
        budgetMs: () => CoreDeviceRunner.shutdownBudgetMs(),
    });
    // A screen session is only started for a phone the tracker reports as attached.
    CoreDeviceRunner.setDeviceCheck((udid) => {
        const tracker = ControlCenter.getInstance();
        if (!tracker.getDevices().length) {
            // Nothing seen yet: an unknown udid cannot be told from a phone not polled so far.
            return true;
        }
        const descriptor = tracker.getDescriptor(udid);
        return !!descriptor && descriptor.state !== DeviceState.DISCONNECTED;
    });

    mwList.push(CoreDeviceProxy);
}
loadPlatformModulesPromises.push(loadApplModules());
/// #endif

Promise.all(loadPlatformModulesPromises)
    .then(() => {
        const wsService = WebSocketServer.getInstance();
        mwList.forEach((mwFactory: MwFactory) => {
            wsService.registerMw(mwFactory);
        });

        mw2List.forEach((mwFactory: MwFactory) => {
            WebsocketMultiplexer.registerMw(mwFactory);
        });
        return startServices(servicesToStart, runningServices, () => shutdown.isStopping());
    })
    .catch((error) => shutdown.onStartupFailure(error));

if (process.platform === 'win32') {
    readline
        .createInterface({
            input: process.stdin,
            output: process.stdout,
        })
        .on('SIGINT', () => shutdown.onSignal('SIGINT'));
}

shutdown.install();
