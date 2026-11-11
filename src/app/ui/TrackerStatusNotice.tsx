import { adbUnavailable } from '../state/trackerStatus';
import '../../style/ui/TrackerStatusNotice.css';

/** Says why Android devices are missing while the server cannot reach adb. */
export function TrackerStatusNotice() {
    if (!adbUnavailable.value.size) {
        return null;
    }
    return (
        <p class="tracker-status-notice" role="status">
            <strong>Android devices are unavailable.</strong> The server cannot reach adb and keeps trying. They return
            when it does.
        </p>
    );
}
