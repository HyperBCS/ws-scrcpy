import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { DeviceTracker } from './DeviceTracker';

/**
 * The socket for an Android screen. There is one route: the server that tracks the device forwards
 * the connection to the scrcpy server over adb. Stock scrcpy does not listen on the network, so
 * the phone's own addresses are never offered.
 */
export function streamSocketUrl(udid: string, params: ParamsDeviceTracker): string {
    return DeviceTracker.createUrl(params, udid).toString();
}
