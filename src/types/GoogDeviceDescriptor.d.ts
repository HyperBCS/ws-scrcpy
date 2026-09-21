import { NetInterface } from './NetInterface';
import { BaseDeviceDescriptor } from './BaseDeviceDescriptor';
import { AndroidLockState } from './AndroidLockState';

export default interface GoogDeviceDescriptor extends BaseDeviceDescriptor, AndroidLockState {
    'ro.build.version.release': string;
    'ro.build.version.sdk': string;
    'ro.product.cpu.abi': string;
    'ro.product.manufacturer': string;
    'ro.product.model': string;
    'wifi.interface': string;
    interfaces: NetInterface[];
    // Positive integer: observed running service; -1: confirmed absent; 0: not known.
    pid: number;
    'last.update.timestamp': number;
    'device.awake': boolean;
    'battery.level': number;
    'battery.charging': boolean;
}
