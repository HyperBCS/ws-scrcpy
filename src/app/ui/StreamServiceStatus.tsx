import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { useEffect } from 'preact/hooks';
import { clearStarting, isDeviceStarting } from '../state/deviceStatus';
import { getStreamServiceStatus } from '../state/streamService';
import type { StreamServiceState } from '../state/streamService';
import { STREAM_SERVICE } from '../copy';
import '../../style/ui/StreamServiceStatus.css';

/** The states a header names: the service does not run, and the phone is there to ask. */
const NOT_RUNNING: readonly StreamServiceState[] = ['stopped', 'starting', 'unknown'];

interface StreamServiceStatusProps {
    descriptor?: Pick<GoogDeviceDescriptor, 'state' | 'pid'>;
    deviceKey?: string;
    className?: string;
    session?: 'ready' | 'starting' | 'stopped' | 'error';
    /**
     * Only while the service does not run (Stopped, Starting, Unknown), as under the name in the
     * bar of a phone's page. A running service, and a phone the header already calls offline or
     * unauthorized, need no line there.
     */
    unlessRunning?: boolean;
}

/**
 * One line that says whether the stream service runs, on a card and under the name in the bar
 * of a phone's page. Process state is separate from the browser's connection and from the
 * phone's lock and power state. The words say the state; the colour of the state word only helps.
 */
export function StreamServiceStatus({
    descriptor,
    deviceKey,
    className = '',
    session,
    unlessRunning = false,
}: StreamServiceStatusProps) {
    const info = getStreamServiceStatus(descriptor, session === 'starting' || isDeviceStarting(deviceKey));
    useEffect(() => {
        if (deviceKey && ['running', 'offline', 'unauthorized'].includes(info.state)) {
            clearStarting(deviceKey);
        }
    }, [deviceKey, info.state]);
    if (unlessRunning && !NOT_RUNNING.includes(info.state)) {
        return null;
    }
    return (
        <span
            class={`stream-service-status ${className}`.trim()}
            data-stream-service={info.state}
            title={info.description}
            role="status"
        >
            {STREAM_SERVICE.name}: <strong>{info.label}</strong>
        </span>
    );
}
