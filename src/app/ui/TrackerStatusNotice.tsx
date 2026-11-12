import { adbUnavailable } from '../state/trackerStatus';
import { Banner } from './Banner';

/** Says why Android phones are missing while the server cannot reach adb. */
export function TrackerStatusNotice() {
    if (!adbUnavailable.value.size) {
        return null;
    }
    return (
        <Banner>
            <strong>Android phones are unavailable.</strong> The server cannot reach adb and keeps trying. They return
            when it does.
        </Banner>
    );
}
