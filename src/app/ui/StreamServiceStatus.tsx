import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { useEffect } from 'preact/hooks';
import { clearStarting, isDeviceStarting } from '../state/deviceStatus';
import { getStreamServiceStatus } from '../state/streamService';
import '../../style/ui/StreamServiceStatus.css';

interface StreamServiceStatusProps {
    descriptor?: Pick<GoogDeviceDescriptor, 'state' | 'pid'>;
    deviceKey?: string;
    className?: string;
    session?: 'ready' | 'starting' | 'stopped' | 'error';
}

/** Process state is separate from the browser's connection or the device's lock/power state. */
export function StreamServiceStatus({ descriptor, deviceKey, className = '', session }: StreamServiceStatusProps) {
    const info = getStreamServiceStatus(descriptor, session === 'starting' || isDeviceStarting(deviceKey));
    useEffect(() => {
        if (deviceKey && ['running', 'offline', 'unauthorized'].includes(info.state)) {
            clearStarting(deviceKey);
        }
    }, [deviceKey, info.state]);
    return (
        <span
            class={`stream-service-status ${className}`}
            data-stream-service={info.state}
            title={info.description}
            role="status"
        >
            <span class="stream-service-status-dot" aria-hidden="true" />
            <span>
                Stream service: <strong>{info.label}</strong>
            </span>
        </span>
    );
}
