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

/**
 * One line that says whether the stream service runs, on a card and under the name in the bar
 * of a phone's page. Process state is separate from the browser's connection and from the
 * phone's lock and power state. The words say the state; the colour of the state word only helps.
 */
export function StreamServiceStatus({ descriptor, deviceKey, className = '', session }: StreamServiceStatusProps) {
    const info = getStreamServiceStatus(descriptor, session === 'starting' || isDeviceStarting(deviceKey));
    useEffect(() => {
        if (deviceKey && ['running', 'offline', 'unauthorized'].includes(info.state)) {
            clearStarting(deviceKey);
        }
    }, [deviceKey, info.state]);
    return (
        <span
            class={`stream-service-status ${className}`.trim()}
            data-stream-service={info.state}
            title={info.description}
            role="status"
        >
            Stream service: <strong>{info.label}</strong>
        </span>
    );
}
